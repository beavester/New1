/* Infusion De-ID — core pipeline
 * Pure JavaScript, no DOM, no network. Runs in the browser and in Node.
 *
 * Pipeline for one table (headers + rows):
 *   1. classifyColumns  — schema pass: which columns are identifiers, dates, free text
 *   2. buildCensus      — dictionary of every patient/provider identifier in the table
 *   3. detectText       — census → Tier 0 rules → Tier 1-lite lexicon/cue detector
 *   4. post-process     — merge, resolve overlaps, propagate detected names document-wide
 *   5. surrogate        — hide-in-plain-sight replacement with per-patient date shifting
 *   6. audit            — per-row record of what was found and replaced
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lexicon.js'));
  else root.DeID = factory(root.DeIDLexicon);
})(typeof self !== 'undefined' ? self : this, function (LEX) {
  'use strict';

  // ---------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isDate = (v) => v instanceof Date && !isNaN(v.getTime());
  const pad2 = (n) => String(n).padStart(2, '0');
  const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  function cellToString(v) {
    if (v == null) return '';
    if (isDate(v)) return `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}`;
    return String(v);
  }

  // ---------------------------------------------------------------------
  // Span types and priorities (higher wins on overlap)
  // ---------------------------------------------------------------------
  const TYPES = {
    NAME_PATIENT: { pri: 100, coarse: 'NAME' },
    MRN:          { pri: 95,  coarse: 'MRN' },
    ACCOUNT:      { pri: 94,  coarse: 'ACCOUNT' },
    SSN:          { pri: 93,  coarse: 'ID' },
    EMAIL:        { pri: 92,  coarse: 'EMAIL' },
    URL:          { pri: 91,  coarse: 'ID' },
    IP:           { pri: 90,  coarse: 'ID' },
    PHONE:        { pri: 88,  coarse: 'PHONE' },
    NAME_PROVIDER:{ pri: 85,  coarse: 'NAME' },
    DOB:          { pri: 84,  coarse: 'DATE' },
    DATE:         { pri: 80,  coarse: 'DATE' },
    ADDRESS:      { pri: 78,  coarse: 'LOCATION' },
    ORG:          { pri: 75,  coarse: 'ORG' },
    NAME_OTHER:   { pri: 70,  coarse: 'NAME' },
    LOCATION:     { pri: 65,  coarse: 'LOCATION' },
    ZIP:          { pri: 64,  coarse: 'LOCATION' },
    AGE:          { pri: 60,  coarse: 'AGE' },
    ID_OTHER:     { pri: 55,  coarse: 'ID' },
  };
  const COARSE = (t) => (TYPES[t] ? TYPES[t].coarse : 'OTHER');

  // ---------------------------------------------------------------------
  // 1. Column classification
  // ---------------------------------------------------------------------
  const ROLES = ['patient_name', 'mrn', 'dob', 'account', 'phone', 'provider', 'date', 'age', 'zip', 'text', 'keep', 'drop'];
  const ROLE_LABELS = {
    patient_name: 'Patient name → surrogate',
    mrn: 'MRN → study code',
    dob: 'Date of birth → per config',
    account: 'Account / CSN → surrogate',
    phone: 'Phone / fax → surrogate',
    provider: 'Provider name → surrogate',
    date: 'Date → shifted',
    age: 'Age → banded',
    zip: 'ZIP → 3 digits',
    text: 'Free text → full pipeline',
    keep: 'Keep as is',
    drop: 'Drop (blank the column)',
  };

  const HEADER_RULES = [
    // a merged cell "Patient / MRN" holding "KRISTOFFERSEN,ELSA (MRN:2210984)": the name column, the record number is read from it
    { role: 'patient_name', re: /\b(?:pt|patient|name)\b.*\b(?:mrn|mr\s*#|med\s*rec)|\b(?:mrn|mr\s*#)\b.*\b(?:pt|patient|name)\b/i },
    { role: 'dob', re: /\b(dob|d\.o\.b|date of birth|birth\s*date|birthdate|born)\b/i },
    { role: 'mrn', re: /\b(mrn|mr\s*#|med(ical)?\s*rec(ord)?\s*(no|num|number|#)?|chart\s*(no|#))(?:\b|(?<=#))/i },
    { role: 'account', re: /\b(acct|account|har|csn|encounter|contact serial|visit\s*(id|#|no)|fin\b|financial)\b/i },
    { role: 'phone', re: /\b(phone|tel|telephone|mobile|cell|fax|contact\s*(no|number|#))\b/i },
    { role: 'provider', re: /\b(provider|attending|physician|ordering|prescrib|doctor|\bdr\b|oncologist|referring|pcp|nurse|\brn\b|pharmacist|md\b|signed by|entered by|authoriz)/i, not: /\b(note|notes|comment|comments|instruction|instructions|remark|remarks|message|narrative|fax|phone|tel)\b/i },
    { role: 'age', re: /^\s*age\b/i },
    { role: 'zip', re: /\b(zip|postal)\b/i },
    { role: 'drop', re: /\b(address|street|city|state|email|e-mail|ssn|social security|guarantor|emergency contact|insurance id|member id|policy|subscriber|license|device serial|photo|employer)\b/i },
    // identifier columns that are not record numbers: authorizations, device serials, vehicle plates, placards, claims
    { role: 'drop', re: /\b(?:auth(?:orization)?\s*(?:#|no|num|number|id|code)?|prior\s*auth|serial|s\/n|sn\s*#|plate|vehicle|placard|permit|claim\s*(?:#|no|id)|implant\s*(?:id|#)|device\s*(?:id|#)|udi)\b|^\s*(?:sn|auth)\s*#?\s*$/i, not: /\b(?:note|notes|comment|comments|status|date|type|reason|instruction|instructions|remarks?)\b/i },
    { role: 'patient_name', re: /^\s*(pt|patient|client|resident)\s*\.?\s*$/i },
    { role: 'patient_name', re: /\b(pt|patient)?\s*(name|full name|pt name|patient name|last,? first|legal name)\b/i, not: /provider|physician|attending|md|\bdr\b|nurse|pharmacist|chair|regimen|drug|protocol|order|user|entered|signed|location|dept|department|clinic|facility|insurance|plan|study|trial/i },
    { role: 'text', re: /\b(comment|note|notes|instruction|remark|reason|indication|message|description|free\s*text|narrative|sched(uling)?\s*note|appt\s*note|special|alert|question|answer|response|reply|detail)/i },
    { role: 'date', re: /\b(date|appt|appointment|scheduled|sched|dos|visit|start|end|due|due date|next|last|time stamp|timestamp|created|updated|entered on|ordered on)\b/i, not: /time\s*$/i },
  ];

  // a value that is a date in any Epic rendering: weekday prefix (Tue 11/03), dotted ISO (2026.11.03), compact (20261103),
  // ordinals (November 3rd, 2026), with or without a time after it
  let LOOKS_DATE = null;
  function looksLikeDate(s) {
    // the month must be a month word ("Chair 4" and "Bay 12" are not dates); 13NOV2026 and day-first forms count
    if (!LOOKS_DATE) LOOKS_DATE = new RegExp(`^\\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\.?,?\\s+)?(\\d{1,2}[\\/\\-.]\\d{1,2}([\\/\\-.]\\d{2,4})?|\\d{4}[\\-.\\/]\\d{1,2}[\\-.\\/]\\d{1,2}|(?:19|20)\\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])|\\d{1,2}${MONTH_NC}\\d{2,4}|${MONTH_NC}[a-z]*\\.? \\d{1,2}(?:st|nd|rd|th)?(,? \\d{2,4})?|\\d{1,2}(?:st|nd|rd|th)?[-\\s](?:of\\s+)?${MONTH_NC}[a-z]*\\.?([-\\s,]+\\d{2,4})?)(\\s+(?:@\\s*)?\\d{1,2}:?\\d{2}(:\\d{2})?\\s*([AaPp][Mm])?)?\\s*$`, 'i');
    return LOOKS_DATE.test(s);
  }
  // values that carry identifiers whatever the header says: phones (7 or 10 digits, any punctuation, a c/h/w label),
  // e-mails, web links, street addresses and PO boxes, a relation word beside a capitalized name
  const PHONE_VALUE = /^\s*(?:[A-Za-z]{1,6}(?:[:.]\s*|\s+))?(?:(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s]?)\d{3}[-.\s]?\d{4}|\d{3}[-.\s]\d{4})(?:\s*(?:x|ext\.?)\s*\d{1,6})?\s*$/i;
  const IDENT_VALUE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:https?:\/\/|www\.)\S+|\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\.?\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Pike|Pkwy|Hwy|Cir|Ter|Trl)\b|\b(?:P\.?\s?O\.?\s?Box|(?:RR|Rural\s+Route)\s*\d+\s*,?\s*Box)\s*#?\s*\d+|\b\d{3}-\d{2}-\d{4}\b/i;

  // "KRISTOFFERSEN,ELSA (MRN:2210984)" -> { name: 'KRISTOFFERSEN,ELSA', mrn: '2210984' }
  function splitNameId(raw) {
    const s = cellToString(raw).trim();
    const m = s.match(/[(\[]?\s*(?:(?:MRN|MR#|MR|Med\s*Rec(?:ord)?\s*(?:No|#)?)\s*[:#]?\s*)?\b([A-Z]{0,2}\d{6,10})\b\s*[)\]]?/i);
    if (!m || !/[A-Za-z]{2,}/.test(s.slice(0, m.index))) return { name: s, mrn: '' };
    const name = (s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\s*[|\-–\/]\s*$/, '').replace(/\s+/g, ' ').trim();
    return { name, mrn: m[1] };
  }
  function isCodeValue(s) {
    const v = cellToString(s).trim();
    if (!v || v.length > 32 || v.split(/\s+/).length > 4) return false;
    if (/\b(?:mg|mcg|g|kg|ml|mL|units?|%|mmol|meq|hr|hrs|min|x|q\d+\w*|tabs?|caps?|vials?)\b|\/(?:kg|m2|day|hr|min)/i.test(v) || looksLikeDate(v) || /^\d{1,2}:\d{2}/.test(v)) return false;
    const toks = v.split(/\s+/);
    const digits = (v.match(/\d/g) || []).length;
    return toks.some((t) => /\d/.test(t) && /^[A-Za-z0-9][A-Za-z0-9\-]{3,}$/.test(t) && ((/[A-Za-z\-]/.test(t) && (t.match(/\d/g) || []).length >= 3) || (t.match(/\d/g) || []).length >= 5)) && digits >= 4;
  }

  function classifyColumns(headers, rows) {
    const sample = rows.slice(0, 200);
    return headers.map((h, ci) => {
      const header = String(h == null ? '' : h).trim();
      let role = null, reason = '';
      for (const r of HEADER_RULES) {
        if (r.re.test(header) && !(r.not && r.not.test(header))) { role = r.role; reason = 'header'; break; }
      }
      const vals = sample.map((r) => r[ci]).filter((v) => v != null && v !== '');
      const n = vals.length || 1;
      const dateLike = vals.filter((v) => isDate(v) || looksLikeDate(cellToString(v))).length / n;
      const strs = vals.map(cellToString);
      const avgLen = strs.reduce((a, s) => a + s.length, 0) / n;
      const spacey = strs.filter((s) => /\s/.test(s.trim())).length / n;
      const nameLike = strs.filter((s) => /^[A-Za-z'\-]+,\s*[A-Za-z'\-]+(\s+[A-Za-z.'\-]+)*$/.test(s.trim())).length / n;
      const phoneLike = strs.filter((s) => PHONE_VALUE.test(s)).length / n;
      const identLike = strs.filter((s) => IDENT_VALUE.test(s) || (PHONE_VALUE.test(s) && /\d{3}[-.\s]?\d{4}/.test(s))).length / n;
      // a relation word next to a capitalized word ("Son-in-law Beauregard Nimmons", "Neighbor Rosalind Tuckerby may pick up")
      const relLike = strs.filter((s) => (s.match(/[A-Za-z][A-Za-z'’\-]*/g) || []).some((w, i, ws) => LEX.RELATION_SET.has(w.toLowerCase()) && ws.slice(i + 1, i + 3).some((x) => /^[A-Z][a-z]/.test(x) && !LEX.isClinical(x)))).length;
      const idLike = strs.filter((s) => /^[A-Z]{0,2}\d{6,12}$/.test(s.trim())).length / n;
      // a name cell that carries the record number ("KRISTOFFERSEN,ELSA (MRN:2210984)", "Moreau-Banda, Luc 2211037")
      const nameIdLike = strs.filter((s) => splitNameId(s).mrn && /^[A-Za-z'’\- ]+,\s*[A-Za-z'’\-]+/.test(splitNameId(s).name)).length / n;
      // short codes that are identifiers of some kind: serials, plates, authorizations ("SN 2026-CS-448190", "plate 7KXM218",
      // "PA-2026-0091827", "AMB-0099412"); doses, dates, times and room/chair numbers are not
      const codeLike = strs.filter((s) => isCodeValue(s)).length / n;

      if (!role) {
        if (vals.length === 0) { role = 'keep'; reason = 'empty'; }
        else if (dateLike > 0.8) { role = 'date'; reason = 'values look like dates'; }
        else if (phoneLike > 0.8) { role = 'phone'; reason = 'values look like phone numbers'; }
        else if (nameLike > 0.8) { role = 'patient_name'; reason = 'values look like "Last, First"'; }
        else if (idLike > 0.8) { role = 'mrn'; reason = 'values look like record numbers'; }
        else if (nameIdLike > 0.8) { role = 'patient_name'; reason = 'values look like a name with its record number'; }
        else if (codeLike > 0.6 && !/\b(?:lot|ndc|batch|exp|expiry|kit|cpt|hcpcs|icd|code|regimen|protocol|drug|med|dose)\b/i.test(header)) { role = 'drop'; reason = 'values look like identifiers (serial, plate or authorization numbers)'; }
        else if (avgLen > 25 && spacey > 0.5) { role = 'text'; reason = 'long free text'; }
        else if (identLike > 0 || relLike > 0) { role = 'text'; reason = 'values hold contact details or names'; }
        else { role = 'keep'; reason = 'short categorical values'; }
      } else if (role === 'date' && dateLike < 0.3 && vals.length > 3) {
        // header said date but the values are not dates: run them through the full pipeline rather than keep them
        role = 'text';
        reason = 'header says date but values are not dates';
      }
      return { header, index: ci, role, reason, sample: strs.slice(0, 3) };
    });
  }

  // Infer an MRN regex from the values actually present in the MRN column.
  function inferIdPattern(values) {
    const cleaned = values.map((v) => cellToString(v).trim()).filter(Boolean);
    if (!cleaned.length) return null;
    const prefixes = new Set(), lens = new Set();
    let allNumeric = true;
    for (const v of cleaned) {
      const m = v.match(/^([A-Za-z]{0,3})(\d+)$/);
      if (!m) { allNumeric = false; continue; }
      prefixes.add(m[1]); lens.add(m[2].length);
      const stripped = m[2].replace(/^0+/, '');
      if (stripped.length >= 5) lens.add(stripped.length);
    }
    if (!allNumeric || !lens.size) return null;
    const minL = Math.max(6, Math.min(...lens)), maxL = Math.max(6, Math.max(...lens));
    const pre = [...prefixes].filter(Boolean);
    const prePart = pre.length ? `(?:${pre.map(escapeRe).join('|')})${prefixes.has('') ? '?' : ''}` : '';
    return `\\b${prePart}\\d{${minL},${maxL}}\\b`;
  }

  // ---------------------------------------------------------------------
  // Name parsing helpers
  // ---------------------------------------------------------------------
  function parseName(raw) {
    const s = cellToString(raw).trim().replace(/\s+/g, ' ');
    if (!s) return null;
    let credentials = [];
    let body = s.replace(/\b(MD|DO|NP|PA-C|PA|RN|LPN|BSN|MSN|DNP|APRN|CRNP|CNP|ARNP|PharmD|RPh|PhD|MSW|LCSW|RD|DDS|DMD|DPM|FNP|ANP|AGNP|ACNP|PMHNP|CNM|CNS|Jr\.?|Sr\.?|II|III|IV)\b\.?/g, (m) => { credentials.push(m); return ''; })
      .replace(/[,\s]+$/, '').replace(/\s+,/g, ',').trim();
    let last, first, middle = '', format;
    if (body.includes(',')) {
      const idx = body.indexOf(',');
      const l = body.slice(0, idx).trim(), rest = body.slice(idx + 1).trim();
      last = l; const parts = rest.split(/\s+/).filter(Boolean); first = parts[0] || ''; middle = parts.slice(1).join(' ');
      format = first ? 'last_first' : 'single';
      if (!last) { last = first; first = ''; format = 'single'; }
    } else {
      const parts = body.split(/\s+/).filter(Boolean);
      if (parts.length === 1) { first = ''; last = parts[0]; format = 'single'; }
      else { first = parts[0]; last = parts[parts.length - 1]; middle = parts.slice(1, -1).join(' '); format = 'first_last'; }
    }
    const upper = body === body.toUpperCase() && /[A-Z]/.test(body);
    return { raw: s, first, last, middle, format, upper, credentials: credentials.join(' ').trim() };
  }

  function nameVariants(p) {
    const v = new Set();
    const add = (x) => { if (x && x.trim().length >= 2) v.add(x.trim()); };
    const f = p.first, l = p.last, m = p.middle;
    add(p.raw.replace(/\s+(MD|DO|NP|RN|PA-C|PA)\b\.?/g, ''));
    add(l); if (f.length >= 3 || /^[A-Z]/.test(f)) add(f);
    add(`${f} ${l}`); add(`${l}, ${f}`); add(`${l},${f}`); add(`${l} ${f}`);
    if (m) {
      add(`${f} ${m} ${l}`); add(`${l}, ${f} ${m}`); add(`${l} ${f} ${m}`); add(`${f} ${m[0]}. ${l}`); add(`${f} ${m[0]} ${l}`);
      // a two-word given name (Mary Catherine, Thi Hong) and each of its parts: the second part is often the name used
      const mids = m.split(/\s+/).filter((x) => x.length >= 3 && !/^[A-Z]\.?$/.test(x));
      if (mids.length) { add(`${f} ${m}`); mids.forEach((x) => add(x)); add(`${mids[mids.length - 1]} ${l}`); }
    }
    if (f) {
      add(`${f[0]}. ${l}`); add(`${f[0]} ${l}`);
      // first name + surname initial (Sal P., Erik J) and dotted initials (K.Y., K. Y.)
      add(`${f} ${l[0]}.`); add(`${f} ${l[0]}`); add(`${f[0]}.${l[0]}.`); add(`${f[0]}. ${l[0]}.`);
      // surname + first initial, as a pharmacy queue writes another patient: "Castellane W.", "Vionnet, R."
      add(`${l} ${f[0]}.`); add(`${l}, ${f[0]}.`); add(`${l}, ${f[0]}`);
      // diminutives: Benjamin → Ben, Katarzyna → Kasia, Salvatore → Sal
      // a diminutive that is also an ordinary word or a month (Will, Bill, Pat, Jan, May) is only taken with the surname
      LEX.nicknamesOf(f).forEach((nick) => { if (nick.length < 3) return; if (!LEX.isAmbiguous(nick) && !LEX.isClinical(nick)) add(nick); add(`${nick} ${l}`); add(`${l}, ${nick}`); add(`${nick} ${l[0]}.`); });
    }
    // hyphenated and two-word surnames (Delacroix-Ames, Ibarrondo Etxeberria, Ruiz Cabrera): each part on its own
    if (/[-\s]/.test(l)) l.split(/[-\s]+/).forEach((h) => { if (h.length >= 3 && !NAME_PARTICLE.test(h)) add(h); });
    if (/\s/.test(l)) { const hy = l.replace(/\s+/g, '-'); add(hy); if (f) { add(`${hy}, ${f}`); add(`${f} ${hy}`); } }
    return [...v].filter((x) => x.length >= 2);
  }
  // every letter token a patient may be referred to by (lower-case), used to tell the patient from a relative who
  // shares the surname ("daughter Siobhan Fitzgerald-Nowak" is not "Fitzgerald, Mary")
  function ownTokensOf(parsedList) {
    const set = new Set();
    for (const pn of parsedList) {
      if (!pn) continue;
      [pn.first, pn.last, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((t) => { if (!t) return; const c = t.toLowerCase().replace(/\.$/, ''); if (c) set.add(c); c.split(/[-\s]+/).forEach((h) => { if (h) set.add(h); }); });
      if (pn.first) LEX.nicknamesOf(pn.first).forEach((n) => { if (!LEX.isAmbiguous(n) && !LEX.isClinical(n)) set.add(n.toLowerCase()); });
    }
    return set;
  }

  // ---------------------------------------------------------------------
  // 2. Census
  // ---------------------------------------------------------------------
  function buildCensus(headers, rows, columns, opts) {
    const colByRole = (role) => columns.filter((c) => c.role === role).map((c) => c.index);
    const nameCols = colByRole('patient_name'), mrnCols = colByRole('mrn'), dobCols = colByRole('dob');
    const acctCols = colByRole('account'), phoneCols = colByRole('phone'), provCols = colByRole('provider');
    const patients = new Map(); // entity id -> patient (census view of a registry entity)
    const providers = new Map(); // normalized surname+first -> provider
    const rowPatient = new Array(rows.length).fill(null);
    const registry = (opts && opts.registry) || createRegistry();
    let order = 0;

    rows.forEach((row, ri) => {
      let mrn = mrnCols.map((c) => cellToString(row[c]).trim()).find(Boolean) || '';
      let nameRaw = nameCols.map((c) => cellToString(row[c]).trim()).find(Boolean) || '';
      // a merged "Patient / MRN" cell: the record number inside the name cell is the patient's
      const split = splitNameId(nameRaw);
      if (split.mrn) { nameRaw = split.name; if (!mrn) mrn = split.mrn; }
      const dob = dobCols.map((c) => row[c]).find((v) => v != null && v !== '');
      const accounts = acctCols.map((c) => cellToString(row[c]).trim()).filter(Boolean);
      const phones = phoneCols.map((c) => cellToString(row[c]).trim()).filter(Boolean);
      const entity = (mrn || nameRaw) ? registry.resolve({ name: nameRaw, mrn, dob, accounts, phones }) : null;
      if (entity) {
        const key = entity.id;
        let p = patients.get(key);
        if (!p) {
          p = { key, entity, order: order++, mrns: new Set(), names: new Set(), parsed: null, dob: null, accounts: new Set(), phones: new Set(), rows: [] };
          patients.set(key, p);
        }
        // every MRN/name/DOB the registry knows for this person counts, including ones seen in earlier inputs
        entity.mrns.forEach((m) => { p.mrns.add(m); const st = m.replace(/^0+/, ''); if (st.length >= 5) p.mrns.add(st); const nm = normalizeId(m); if (nm !== m) p.mrns.add(nm); });
        entity.names.forEach((nm) => p.names.add(nm));
        if (!p.parsed) { const firstName = nameRaw || [...entity.names][0]; if (firstName) p.parsed = parseName(firstName); }
        if (!p.dob) { if (dob != null && dob !== '') p.dob = dob; else if (entity.dobs.size) p.dob = [...entity.dobs][0]; }
        entity.accounts.forEach((a) => p.accounts.add(a));
        entity.phones.forEach((ph) => p.phones.add(ph));
        p.rows.push(ri);
        rowPatient[ri] = key;
      }
      provCols.forEach((c) => {
        const raw = cellToString(row[c]).trim();
        if (!raw) return;
        // a provider cell may hold several names separated by ; or /
        raw.split(/\s*[;\/]\s*|\s+and\s+/).forEach((one) => {
          const parsed = parseName(one);
          if (!parsed || !parsed.last) return;
          const k = `${parsed.last}|${parsed.first}`.toLowerCase();
          if (!providers.has(k)) providers.set(k, { key: k, order: providers.size, raw: one, parsed, variants: new Set() });
          providers.get(k).variants.add(one);
        });
      });
    });

    // more patients on a line than the line's own (tiles of a grid, two columns read as one line): each is a census entry
    // of its own, and its first name alone is matched on the lines it sits on
    const rowExtra = new Array(rows.length).fill(null);
    (rows.extras || (opts && opts.extras) || []).forEach((rec) => {
      if (!rec || !(rec.name || rec.mrn)) return;
      const entity = registry.resolve({ name: rec.name, mrn: rec.mrn, dob: rec.dob });
      if (!entity) return;
      let p = patients.get(entity.id);
      if (!p) { p = { key: entity.id, entity, order: order++, mrns: new Set(), names: new Set(), parsed: null, dob: null, accounts: new Set(), phones: new Set(), rows: [] }; patients.set(entity.id, p); }
      entity.mrns.forEach((m) => { p.mrns.add(m); const st = m.replace(/^0+/, ''); if (st.length >= 5) p.mrns.add(st); const nm = normalizeId(m); if (nm !== m) p.mrns.add(nm); });
      entity.names.forEach((nm) => p.names.add(nm));
      if (!p.parsed && rec.name) p.parsed = parseName(rec.name);
      if (!p.dob) { if (rec.dob) p.dob = rec.dob; else if (entity.dobs.size) p.dob = [...entity.dobs][0]; }
      (rec.rows || []).forEach((ri) => { if (ri >= 0 && ri < rows.length && rowPatient[ri] !== entity.id) { (rowExtra[ri] = rowExtra[ri] || []).push(entity.id); if (!p.rows.includes(ri)) p.rows.push(ri); } });
    });
    // every patient the session already knows (an earlier spreadsheet, note or screenshot) is looked for here too, so a
    // name or record number read in one input is caught in the next; their first names alone stay scoped to their own rows
    const known = new Map();
    registry.entities.forEach((e) => {
      if (patients.has(e.id) || !(e.names.size || e.mrns.size)) return;
      const pn = e.names.size ? parseName([...e.names][0]) : null;
      known.set(e.id, { key: e.id, entity: e, order: 1e6 + known.size, mrns: new Set([...e.mrns].flatMap((m) => { const st = m.replace(/^0+/, ''); const nm = normalizeId(m); return [m, ...(st.length >= 5 ? [st] : []), nm]; })), names: new Set(e.names), parsed: pn, dob: e.dobs.size ? [...e.dobs][0] : null, accounts: new Set(e.accounts), phones: new Set(e.phones), rows: [], known: true });
    });
    // Build the lookup: variant (lowercase) -> { type, entityKey }
    const lookup = new Map();
    const addVariant = (text, type, entityKey, exactCase, rowScoped) => {
      const k = text.toLowerCase();
      if (k.length < 2) return;
      if (/^\d+$/.test(k) && k.length < 5) return; // avoid tagging tiny numbers
      const prev = lookup.get(k);
      if (prev) {
        if (TYPES[prev.type].pri > TYPES[type].pri) return;
        if (TYPES[prev.type].pri === TYPES[type].pri) { if (!prev.entities.includes(entityKey)) prev.entities.push(entityKey); prev.rowScoped = prev.rowScoped || !!rowScoped; prev.exactCase = prev.exactCase || !!exactCase; return; }
      }
      lookup.set(k, { type, entities: [entityKey], exactCase: !!exactCase, rowScoped: !!rowScoped, text });
    };
    for (const p of [...patients.values(), ...known.values()]) {
      p.mrns.forEach((m) => addVariant(m, 'MRN', p.key));
      p.accounts.forEach((a) => addVariant(a, 'ACCOUNT', p.key));
      p.phones.forEach((ph) => { addVariant(ph, 'PHONE', p.key); const d = ph.replace(/\D/g, ''); if (d.length >= 7) addVariant(d, 'PHONE', p.key); });
      const allVariants = new Set();
      p.names.forEach((nm) => { const pn = parseName(nm); if (pn) nameVariants(pn).forEach((v) => allVariants.add(v)); });
      if (p.parsed) nameVariants(p.parsed).forEach((v) => allVariants.add(v));
      const literal = new Set(); p.names.forEach((nm) => { const pn = parseName(nm); if (pn) [pn.last, ...pn.last.split(/[-\s]+/)].forEach((t) => t && literal.add(t.toLowerCase())); });
      [...allVariants].forEach((v) => {
        // single ambiguous/common-word tokens must match with a capital letter, and tokens that are also
        // months/clinical words only match inside that patient's own rows. A given name, a diminutive or an initial
        // alone is also row-scoped: another patient's first name in this row is almost always a different person.
        const single = !/\s|,/.test(v);
        const surnameToken = single && literal.has(v.toLowerCase());
        const exact = single && (LEX.isAmbiguous(v) || LEX.isClinical(v) || v.length <= 3 || !surnameToken);
        const rowScoped = single && (LEX.isClinical(v) || LEX.isAmbiguous(v) || v.length <= 3 || !surnameToken);
        addVariant(v, 'NAME_PATIENT', p.key, exact, rowScoped);
      });
      p.ownTokens = ownTokensOf([...[...p.names].map(parseName), p.parsed]);
      if (p.dob) {
        const d = isDate(p.dob) ? p.dob : parseDateString(cellToString(p.dob));
        if (d) dateRenderings(d).forEach((s) => addVariant(s, 'DOB', p.key));
      }
    }
    for (const pr of providers.values()) {
      nameVariants(pr.parsed).forEach((v) => {
        const single = !/\s|,/.test(v);
        if (single && pr.parsed.first && v.toLowerCase() === pr.parsed.first.toLowerCase() && (LEX.isAmbiguous(v) || LEX.isClinical(v))) return;
        const exact = single && (LEX.isAmbiguous(v) || LEX.isClinical(v) || v.length <= 3);
        addVariant(v, 'NAME_PROVIDER', pr.key, exact);
      });
    }
    // One alternation regex, longest first, word-boundary aware
    const keys = [...lookup.keys()].sort((a, b) => b.length - a.length);
    const regex = keys.length ? new RegExp(`(?<![\\w])(?:${keys.map(escapeRe).join('|')})(?![\\w])`, 'gi') : null;
    const mrnNorm = new Map();
    for (const p of [...patients.values(), ...known.values()]) p.mrns.forEach((m) => { const k = mrnKeyOf(m); if (k) mrnNorm.set(k, p.key); });
    const patient = (key) => patients.get(key) || known.get(key) || null;
    return { patients, known, patient, providers, rowPatient, rowExtra, lookup, regex, registry, mrnNorm, nameCols, mrnCols, dobCols, acctCols, phoneCols, provCols };
  }

  // ---------------------------------------------------------------------
  // Dates: parse, render in the same style, shift
  // ---------------------------------------------------------------------
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const MONTH_NC = MONTH_RE.replace('(', '(?:');
  function monthIndex(tok) {
    const t = tok.toLowerCase().replace(/\.$/, '');
    for (let i = 0; i < 12; i++) if (MONTHS[i].startsWith(t) && t.length >= 3) return i + 1;
    return 0;
  }
  function validDMY(y, m, d) {
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dim = [31, (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= dim[m - 1];
  }
  function expandYear(ystr) {
    if (ystr == null) return null;
    const y = parseInt(ystr, 10);
    if (ystr.length === 4) return y;
    const nowYY = new Date().getFullYear() % 100;
    return y <= nowYY + 5 ? 2000 + y : 1900 + y;
  }
  // Date regexes, each with a 'kind' to drive re-rendering.
  const DATE_PATTERNS = [
    { kind: 'iso', re: new RegExp('(?<![\\d\\w.])(\\d{4})([-.\\/])(\\d{1,2})\\2(\\d{1,2})(?![\\d]|\\.\\d)', 'g') },
    { kind: 'mdy', re: new RegExp('(?<![\\d\\w/.-])(\\d{1,2})([\\/\\-.])(\\d{1,2})\\2(\\d{4}|\\d{2})(?![\\d])', 'g') },
    { kind: 'Mdy', re: new RegExp(`(?<![\\w])${MONTH_RE}\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\t]+(\\d{4}|\\d{2}(?![ \\t]*(?:-|[ \\t]|of[ \\t]+)?${MONTH_NC}\\b))(?![\\d:]))?(?![\\w])`, 'gi') },
    { kind: 'dMy', re: new RegExp(`(?<![\\w])(\\d{1,2})(?:st|nd|rd|th)?(?:(-)|[ \\t]{1,2}(?:of[ \\t]+)?)${MONTH_RE}\\.?(?:(?:-|,[ \\t]*|(?<!-${MONTH_NC}\\.?)[ \\t]+)(\\d{4}|\\d{2}(?![\\/\\-.]\\d)(?![ \\t]*(?:-|[ \\t]|of[ \\t]+)?${MONTH_NC}\\b))(?![\\d:]))?(?![\\w])`, 'gi') },
    // military / pharmacy compact form: 13NOV2026, 04Jan27
    { kind: 'dMyc', re: new RegExp(`(?<![\\w])(\\d{1,2})${MONTH_RE}(\\d{4}|\\d{2})(?![\\w])`, 'gi') },
    { kind: 'md', re: new RegExp('(?<![\\d\\w/.-])(\\d{1,2})([\\/\\-])(\\d{1,2})(?![\\d/-])(?!\\.\\d)(?![ \\t]*(?:mg|mcg|g|ml|tab|tabs|dose|x|units?|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5)\\b)', 'g') },
  ];
  const UNIT_AFTER = /^[ \t]*(mg|mcg|g|ml|mL|tab|tabs|dose|x|unit|units|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5W?|AM|PM)\b/;

  function parseDateMatch(kind, m) {
    let dayFirst = false, y, mo, d, hasYear = true, yearDigits = 4, monthStyle = null, sep = '/', monthTok = null, ordinal = '';
    if (kind === 'iso') { y = +m[1]; sep = m[2]; mo = +m[3]; d = +m[4]; }
    else if (kind === 'mdy') { mo = +m[1]; sep = m[2]; d = +m[3]; yearDigits = m[4].length; y = expandYear(m[4]); if (mo > 12 && d >= 1 && d <= 12) { const t = mo; mo = d; d = t; dayFirst = true; } } // 16/10/2026 is day-first
    else if (kind === 'dMyc') { d = +m[1]; monthTok = m[2]; mo = monthIndex(m[2]); yearDigits = m[3].length; y = expandYear(m[3]); }
    else if (kind === 'Mdy') { monthTok = m[1]; mo = monthIndex(m[1]); d = +m[2]; if (m[3]) { yearDigits = m[3].length; y = expandYear(m[3]); } else { hasYear = false; y = new Date().getFullYear(); } }
    else if (kind === 'dMy') { d = +m[1]; monthTok = m[3]; mo = monthIndex(m[3]); if (m[4]) { yearDigits = m[4].length; y = expandYear(m[4]); } else { hasYear = false; y = new Date().getFullYear(); } }
    else if (kind === 'md') { mo = +m[1]; sep = m[2]; d = +m[3]; hasYear = false; y = new Date().getFullYear(); }
    if (!validDMY(y, mo, d)) return null;
    if (y < 1880 || y > 2100) return null;
    if (monthTok) {
      const raw = m[0].match(new RegExp(MONTH_RE + '\\.?', 'i'))[0];
      monthStyle = { abbrev: raw.replace('.', '').length <= 4, period: raw.endsWith('.'), upper: raw === raw.toUpperCase(), lower: raw === raw.toLowerCase() };
    }
    return { y, m: mo, d, hasYear, yearDigits, sep, kind, monthStyle, text: m[0], dayFirst };
  }

  function parseDateString(s) {
    for (const p of DATE_PATTERNS) {
      p.re.lastIndex = 0;
      const m = p.re.exec(s.trim());
      if (m && m[0].length === s.trim().length) { const pd = parseDateMatch(p.kind, m); if (pd) return new Date(pd.y, pd.m - 1, pd.d); }
    }
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }

  function renderDate(pd, date) {
    const y = date.getFullYear(), mo = date.getMonth() + 1, d = date.getDate();
    const yy = pd.yearDigits === 2 ? pad2(y % 100) : String(y);
    const hadOrdinal = /\d(st|nd|rd|th)\b/i.test(pd.text);
    const ordinal = (n) => !hadOrdinal ? '' : (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th';
    const monthName = () => {
      let name = capFirst(MONTHS[mo - 1]);
      if (pd.monthStyle.abbrev) name = name.slice(0, mo === 9 && pd.text.toLowerCase().includes('sept') ? 4 : 3);
      if (pd.monthStyle.upper) name = name.toUpperCase(); else if (pd.monthStyle.lower) name = name.toLowerCase();
      return name + (pd.monthStyle.period ? '.' : '');
    };
    switch (pd.kind) {
      case 'compact': return `${pad2(mo)}${pad2(d)}${y}`;
      case 'iso': return `${y}${pd.sep || '-'}${pad2(mo)}${pd.sep || '-'}${pad2(d)}`;
      case 'mdy': { const padded = /(^|[\/\-.])0\d([\/\-.]|$)/.test(pd.text); const [a, b] = pd.dayFirst ? [d, mo] : [mo, d]; return padded ? `${pad2(a)}${pd.sep}${pad2(b)}${pd.sep}${yy}` : `${a}${pd.sep}${b}${pd.sep}${yy}`; }
      case 'dMyc': return `${/^\d{2}/.test(pd.text) ? pad2(d) : d}${monthName()}${yy}`;
      case 'md': { const padded = /(^|[\/\-])0\d([\/\-]|$)/.test(pd.text); return padded ? `${pad2(mo)}${pd.sep}${pad2(d)}` : `${mo}${pd.sep}${d}`; }
      case 'Mdy': { const hasComma = /,\s*\d/.test(pd.text); return `${monthName()} ${d}${ordinal(d)}${pd.hasYear ? (hasComma ? ', ' : ' ') + yy : ''}`; }
      case 'dMy': { const sepM = pd.text.match(/^\d{1,2}(?:st|nd|rd|th)?([-\s]+(?:of\s+)?)/i); const s1 = sepM ? sepM[1] : ' '; return `${d}${ordinal(d)}${s1}${monthName()}${pd.hasYear ? (s1.trim() === '-' ? '-' : ' ') + yy : ''}`; }
    }
    return `${mo}/${d}/${y}`;
  }

  function dateRenderings(date) {
    const y = date.getFullYear(), m = date.getMonth() + 1, d = date.getDate();
    return [`${m}/${d}/${y}`, `${pad2(m)}/${pad2(d)}/${y}`, `${m}/${d}/${pad2(y % 100)}`, `${pad2(m)}/${pad2(d)}/${pad2(y % 100)}`,
      `${y}-${pad2(m)}-${pad2(d)}`, `${m}-${d}-${y}`, `${pad2(m)}-${pad2(d)}-${y}`, `${m}-${d}-${pad2(y % 100)}`, `${m}.${d}.${y}`];
  }

  function shiftDate(date, days) { const d = new Date(date.getTime()); d.setDate(d.getDate() + days); return d; }

  // ---------------------------------------------------------------------
  // 3a. Tier 0 rule detectors
  // ---------------------------------------------------------------------
  const RULES = {
    EMAIL: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    URL: /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi,
    IP: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    SSN: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)/g,
    // separators tolerate OCR/keyboard spacing: "716 -555- 0177", "716 . 555 . 0177"
    PHONE: /(?<![\d\w\/])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}(?:\s*[-.]\s*|\s))\d{3}(?:\s*[-.]\s*|\s)\d{4}(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?(?![\d\w])|(?<![\d\w-])\d{3}-\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?(?![\d\w-])/gi,
    PHONE_PLAIN: /(?<![\d\w.-])\d{10}(?![\d\w-])(?!\.\d)(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?/gi,
    // OCR-noisy phone: digits with O/I/l confusions, at least 7 real digits, 3-3-4 shape
    PHONE_OCR: /(?<![\w])\(?[\dOIl]{3}\)?(?:\s*[-.]\s*|\s)[\dOIl]{3}(?:\s*[-.]\s*|\s)[\dOIl]{4}(?![\w])/g,
    AGE: /\b(?:age[d]?\s*:?\s*(9\d|1[0-2]\d)(?![\d\/%-])(?!\.\d)(?!,\d)|(9\d|1[0-2]\d)\s*(?:-|\s)?\s*(?:y\/o|yo|y\.o\.?|yrs?\.?(?:\s*old)?|years?(?:[-\s]old)?|year[-\s]old|yr[-\s]old)(?![A-Za-z])|\b(?:his|her|their)\s+(?:(?:early|mid|late)[-\s])?(9|10)0s\b|\b(?:nonagenarian|centenarian)\b)/gi,
    // "just turned 91", "turning 95 next month", "turns 100": the verb alone says age (degrees, doses and units excluded)
    AGE_TURNS: /\b(?:turned|turning|turns)\s+(9\d|1[01]\d)(?![\d\/%,:.-]|\.\d)(?!\s*(?:degrees?|deg\b|°|mg|mcg|kg|lb|lbs|%|ml|mL|cc|units?|min|minutes|times|x\b))/gi,
    // a table age with a bare y: "91 y", "93y M", "| 95 y |"
    AGE_Y: /(?<![\d\/.\-$#])(9\d|1[0-2]\d)\s?y(?=\s*(?:[MF]\b|[|,;)]|\s{2,}|$))/gm,
    // an ordinal birthday or year of life: "celebrated 101st bday", "her 95th birthday", "in his 92nd year"
    AGE_ORDINAL: /\b(9\d|1[0-2]\d)(?:st|nd|rd|th)\s+(?:bday|b-day|b'day|birthday|bdays|birthdays|year\s+of\s+life|year)\b/gi,
    // written-out ages: ninety-two year old, one hundred and one years old
    AGE_WORDS: /\b(?:ninety|one[-\s]hundred)(?:(?:[-\s]|\s+and\s+)(?:one|two|three|four|five|six|seven|eight|nine))?(?:[-\s]+(?:years?|yrs?)[-\s]+old|[-\s]+(?:y\/o|yo))(?![A-Za-z])/gi,
    // bare number after a person-subject: "husband is 95", "pt turned 91"; vitals (HR is 95, BP 95/60, SpO2 95%) excluded
    AGE_SUBJECT: /\b(?:pt|patient|he|she|husband|wife|spouse|mother|father|mom|mum|dad|sister|brother|son|daughter|partner|grandmother|grandfather|grandma|grandpa|gma|gpa|granny|nana|nan|papa|mama|aunt|uncle|who)\s+(?:is|was|turned|turning|now|just turned|will be)\s+(9\d|1[01]\d)(?![\d\/%,:-])(?!\.\d)(?!\s*(?:mg|kg|lb|lbs|%|mmhg|bpm|k\b|ml|mL|cc|units?|yo|y\/o|year|yr|\/))/gi,
    // "Turned 90 last week", "Turning 91 in May", "is now 95" at the start of a sentence or note (no subject written)
    AGE_TURNED: /(?:^|[.;!?\n]\s*|^\s*-\s*)((?:just\s+)?(?:turned|turning|turns|is now|now)\s+(9\d|1[01]\d))(?![\d\/%,:-])(?!\.\d)(?!\s*(?:mg|kg|lb|lbs|%|mmhg|bpm|k\b|ml|mL|cc|units?|\/))/gi,
    // a bare age in apposition after a name or before a sex marker: "Zofia, 95, hard of hearing", "97 F", "95 M"
    AGE_APPOS: /(?<=\b[A-Z][A-Za-z'’\-]+,\s)(9\d|1[01]\d)(?=\s*,)|(?<![\d\/.\-$#])(9\d|1[01]\d)\s*(?:F|M)\b(?![\/\d]|\.\d)/g,
    ADDRESS: /\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\.?\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail|Pike|Bend|Loop|Row|Path|Crossing|Ridge|Sq|Square|Trace|Cove|Alley|Commons)\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/g,
    // a house number and a street name with no suffix, closed by a unit marker: "4418 Willow Bend apt 3C", "1187 Old Mill #12B"
    ADDRESS_UNIT: /\b(\d{1,6}\s+((?:[A-Z][A-Za-z]+\.?\s+){0,2}[A-Z][A-Za-z]+),?\s*(?:[Aa]pt|APT|[Aa]partment|[Uu]nit|UNIT|[Ss]uite|[Ss]te|#)\.?\s*#?[A-Za-z]?\d+[A-Za-z]?)(?![\w-])/g,
    // post-office boxes and rural routes: "PO Box 2291", "P.O. Box 44", "RR 2 Box 71"
    PO_BOX: /\b(?:P\.?\s?O\.?\s?Box|Post\s+Office\s+Box|(?:RR|R\.R\.|Rural\s+Route|HC)\s*\d+\s*,?\s*Box)\s*#?\s*\d{1,6}\b/gi,
    // a 7-digit phone written with a dot or a space after a contact word: "c 555 0131", "cell 555.0162", "call back at 555 0181"
    PHONE7_CUE: /\b(?:c|h|w|m|cell|home|work|mobile|mob|ph|phone|tel|fax|call|text|pager|at)\s*[:.#]?\s*(\d{3}[.\s]\d{4})(?![\d\w]|[.\-]\d)/gi,
    // a licence or plate number, the state abbreviation may sit between the label and the value: "Driver lic OH TQ448812", "plate K47-RLM"
    PLATE_LIC: /\b(?:plate|tag|placard|permit|lic|license|licence|dl|driver'?s?\s+lic(?:ense|ence)?)\s*(?:#|no\.?|num\.?|number)?\s*[:#]?\s*(?:([A-Z]{2})\s+)?((?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{3,11}|[A-Z]{2,4} \d{3,5}|\d{1,3} [A-Z]{2,4}\d{0,4})(?![\w-])/g,
    ZIP: /\b(?:[A-Z]{2}\s{1,2}\d{5}(?:-\d{4})?)\b/g,
    ID_BARE: /(?<![\d\w\/\-.:$#,])\d{6,9}(?![\d\w\/\-:,]|\.\d)/g,
    // a labelled record number may be broken by spaces, hyphens or OCR confusables: "MRN#0041 2345", "MR# 0041-2345"
    MRN_LABEL: /\b(mrn|mr#|mr\s*#|med(?:ical)?\s*rec(?:ord)?\s*(?:no\.?|num\.?|number|#)?|chart\s*(?:no\.?|#)?|acct|account|csn|har|fin|encounter)\s*(?:#|no\.?|num\.?|number)?\s*[:#]?\s*([A-Z]{0,2}\d(?:[ \-]?[0-9OIlSB]){5,11})(?![\w\/\-:]|\.\d)/gi,
    // "DOB:03041951" written without separators
    DOB_COMPACT: /\b(?:dob|d\.o\.b\.?|birth\s*date|born)\s*[:#]?\s*((?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])(?:19|20)\d{2})(?!\d)/gi,
    // last four of a social security number: "SSN ending 4471", "SS# last 4: 4471", "social ends in 4471"
    SSN_LAST4: /\b(?:ssn|ss#|ss\s*#|social(?:\s+security)?(?:\s+(?:number|no\.?|#))?)\s*(?:on\s+file\s*)?(?:ending(?:\s+in)?|ends(?:\s+(?:in|with))?|last\s*(?:4|four)(?:\s+digits)?|xxx-xx-)?\s*[:#]?\s*(\d{4})(?![\d-])/gi,
    // a street without a house number, named by its suffix: "near Brighton Rd", "on Sheridan Dr in"; "Dr." followed by a
    // capitalized word is an honorific and is excluded by the lookahead
    STREET: /\b((?:[A-Z][A-Za-z]+\s){1,2}(?:Rd|Dr|St|Ave|Blvd|Pkwy|Ln|Ct|Hwy|Rte|Route|Way|Pl|Cir|Ter|Trl)\.?)(?![A-Za-z])(?!\.?\s*[A-Z][a-z])/g,
    // a house number with a street name but no suffix, after a residence cue: "lives alone at 412 Delaware", "Lives 88 Hertel"
    ADDRESS_CUE: /\b(?:[Ll]ives?|[Ll]iving|[Rr]esides?|[Rr]esiding|[Aa]ddress|[Aa]ddr|[Hh]ome|[Mm]oved|[Ss]taying|[Ss]tays|[Rr]elocated)(?:\s+(?:alone|at|in|on|with|w\/|to|near|@|is|now))*\s*[:#]?\s*(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2})(?!\s*(?:mg|mcg|ml|kg|lb|%|units?|hrs?|min|days?|weeks?|months?|yrs?|years?|x|tabs?|caps?|chairs?|rooms?|bays?|floors?)\b)/g,
    // a town with its ZIP but no state: "lives Williamsville 14221"; also "<Town>, 14221"
    TOWN_ZIP: /\b([A-Z][A-Za-z]+(?:\s[A-Z][A-Za-z]+)?),?\s(\d{5})(?![\d\-\/:]|\.\d)(?!\s*(?:mg|mcg|ml|units?|cells|copies|iu|mEq|cc|k)\b)/g,
    ZIP_LABEL: /\bzip\s*(?:code)?\s*:?\s*\d{5}(?:-\d{4})?\b/gi,
    // Labelled identifiers (Safe Harbor classes 9-13, 18): member/subscriber/policy IDs, confirmation and
    // reference numbers, device serials, licence and plate numbers, study subject IDs, health cards, user names.
    LABELED_ID: /\b(?:member|subscriber|policy|beneficiary|medicare|medicaid|mbi|hic|hicn|insurance|ins|conf|confirmation|ref|reference|claim|auth|authorization|prior auth|case|ticket|serial|sn|s\/n|lot|lic|license|licence|dl|driver'?s? license|plate|badge|subject|study|participant|enrollment|screening|health card|ohip|card|passport|visa|id|identifier|acct|account|invoice|order|rx|prescription|tracking|voucher|pin|employee|emp|payer|placard|permit|serial\s+number|implant|device|pump|tag)\s*(?:#|no\.?|num\.?|number|id|code)?(?:\s+(?:on\s+file|is|was|of|verified|provided|given|recorded))*\s*[:#]?\s*((?:[A-Z]{1,4}[-\s]?)?\d[A-Z0-9\-]*(?:[ ](?=[A-Z0-9]*\d)[A-Z0-9\-]+){0,3}|[A-Z]{1,3}[ -]?\d{3,4}(?![\w-]))/gi,
    // Medicare Beneficiary Identifier: 1EG4-TE5-MK72 (11 chars, fixed letter/digit positions, hyphens optional)
    MBI: /(?<![\w])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y]{2}\d{2}(?![\w])/g,
    // @handle / user name tokens (MyChart user names, chat mentions)
    HANDLE: /(?<![\w.])@[A-Za-z][\w.]{2,}(?![\w.])(?![A-Za-z0-9.-]*\.[A-Za-z]{2,})|\b(?:username|user name|user id|userid|login|log-in|handle|screen name)\s*[:#]?\s*((?=[\w.-]*[A-Za-z])[A-Za-z][\w.-]{3,})/gi,
    // an unlabelled user name: lower-case letters joined to digits by a dot or underscore ("jhpark_1951", "rosie.delgado62"),
    // or written after a portal cue ("From MyChart (rosie62)"). Versions (v2.1), files (scan_01.pdf) and e-mails are excluded.
    HANDLE_SHAPE: /(?<![\w.@\/-])(?=[a-z0-9._]*[a-z]{3})[a-z][a-z0-9]*(?:[._][a-z0-9]+)+(?![\w@-]|\.[a-z])/g,
    HANDLE_CUE: /\b(?:mychart|portal|message|msg|from|sender|user)\s*[:(]\s*([a-z][a-z0-9._]{3,})(?=\s*[):])/gi,
    // patient initials when labelled: "initials P.R." / "init: JS"
    INITIALS: /\binitials?\s*[:#]?\s*([A-Z]\.?\s?[A-Z]\.?(?:\s?[A-Z]\.?)?)(?![A-Za-z])/g,
    // OCR-noisy m/d/y or y-m-d with O/I/l confusions (must contain at least one letter)
    DATE_OCR: /(?<![\w\/])(?=[\dOIl\/\-.]*[OIl])(?:[\dOIl]{1,2}([\/\-.])[\dOIl]{1,2}\1[\dOIl]{2,4}|[\dOIl]{4}-[\dOIl]{1,2}-[\dOIl]{1,2})(?![\w\/])/g,
  };
  // When an m-d or small-fraction token is a date only if the surroundings say so.
  const DATE_CTX_BEFORE = /(?:\bdob|\bborn|\bbirth(?:day|date)?|\bon|\bappt|\bappointment|\bseen|\bdue|\bnext|\blabs?|\bscan|\bvisit|\brtc|f\/u|\bfu|\bstart(?:s|ed|ing)?|\bthrough|\bthru|\bfrom|\buntil|\bby|\bdate|\bdos|\btx|\btreatment|\binfusion|\breturn(?:s|ed|ing)?|\brecheck|\bsched(?:uled)?|\bresched(?:uled)?|r\/s|\bmoved|\bcancel(?:l?ed)?|\bbooked|\bconfirmed|\bsigned|\bdated|\bsince|\bcall(?:ed)?\s+back|\bbegin(?:s|ning)?|\bending|\bends?|\bto|\band|\bor)\s*$/i;
  const DATE_CTX_AFTER = /^\s*(?:@|at\s+)?\d{1,2}:\d{2}|^\s*(?:@|at)\s*\d{3,4}\b|^\s*(?:appt|appointment|visit|labs?|scan|infusion|tx|c\d+d\d+|cycle|for|with|w\/|and|or|-|–|thru|through|to)\b/i;
  const RANGE_BEFORE = /(?:\b(?:cycles?|days?|doses?|weeks?|wks?|months?|mos?|yrs?|years?|(?<!\/)c\d*d?|dose|ratio|grade|range|levels?|pages?|items?|q|x|times|courses?|fractions?|fx|sessions?|pain|fatigue|nausea|distress|anxiety|depression|dyspnea|score|scores?|rated?|rating|scale|severity|intensity|vas|nrs|esas)|#)\s*$/i;

  // ordinary words that are also common in street names ("Old Mill", "Main", "Park"): not a reason to reject an address
  const PLACE_WORD = /^(?:Old|New|North|South|East|West|Upper|Lower|Mill|Park|Lake|Hill|Oak|Pine|Elm|Maple|Cedar|Spring|Main|High|Church|Union|River|Valley|Forest|Grove|Green|Bay|Rose|King|Queen|Market|Center|Centre|Bridge|Water|Meadow|Field|Wood|Glen|Brook|Stone|Rock|Willow|Birch|Ash|Cherry|Sunset|Hillside|Lakeview|Ridge)$/;
  function ruleSpans(text, cfg) {
    const spans = [];
    const push = (m, type, extra) => spans.push(Object.assign({ start: m.index, end: m.index + m[0].length, type, source: 'rule', text: m[0] }, extra || {}));
    const run = (re, type, filter) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) { if (!filter || filter(m)) push(m, type); if (m[0].length === 0) re.lastIndex++; } };

    run(RULES.EMAIL, 'EMAIL'); run(RULES.URL, 'URL'); run(RULES.IP, 'IP'); run(RULES.SSN, 'SSN');
    run(RULES.PHONE, 'PHONE'); run(RULES.ADDRESS, 'ADDRESS'); run(RULES.ZIP, 'ZIP'); run(RULES.ZIP_LABEL, 'ZIP');
    run(RULES.PO_BOX, 'ADDRESS');
    RULES.ADDRESS_UNIT.lastIndex = 0; let au;
    while ((au = RULES.ADDRESS_UNIT.exec(text))) {
      const words = au[2].split(/\s+/).map((w) => w.replace(/\.$/, ''));
      if (!words.every((w) => (!LEX.isClinical(w) || PLACE_WORD.test(w)) && !/^(?:Room|Rm|Bed|Bay|Chair|Pod|Floor|Fl|Suite|Unit|Cycle|Day|Dose|Tab|Tabs|Cap|Caps|Vial|Vials|Bag|Bags|Lot|Box|Order|Rx|Ward|Wing|Tower|Building|Bldg|Clinic)$/i.test(w))) continue;
      spans.push({ start: au.index, end: au.index + au[1].length, type: 'ADDRESS', source: 'rule', text: au[1], conf: 0.85 });
    }
    RULES.PHONE7_CUE.lastIndex = 0; let p7;
    while ((p7 = RULES.PHONE7_CUE.exec(text))) { const val = p7[1]; const start = p7.index + p7[0].length - val.length; spans.push({ start, end: start + val.length, type: 'PHONE', source: 'rule', text: val }); }
    RULES.PLATE_LIC.lastIndex = 0; let pl;
    while ((pl = RULES.PLATE_LIC.exec(text))) {
      if (pl[1] && !LEX.STATE_ABBR_SET.has(pl[1])) continue;
      const val = pl[2]; const start = pl.index + pl[0].length - val.length;
      const digits = (val.match(/\d/g) || []).length, letters = (val.match(/[A-Z]/g) || []).length;
      if (digits < 2 || (letters === 0 && digits < 5) || val.replace(/-/g, '').length < 5) continue;
      spans.push({ start, end: start + val.length, type: 'ID_OTHER', source: 'rule', text: val, labeled: true });
    }
    // After a street address or PO box, the town and ZIP that follow are location too, with or without a state
    // ("48 Abbott Rd Buffalo 14220", "12 Oak St, Eggertsville NY 14226", "9 Elm Ave 14221", "apt 3C, Fairhaven 02719").
    for (const ad of spans.filter((x) => x.type === 'ADDRESS')) {
      const from = ad.end;
      const tail = text.slice(from).match(/^,?[ \t]+((?:[A-Z][A-Za-z'’\-]+,?[ \t]+){0,3}?)(?:([A-Z]{2}),?[ \t]+)?(\d{5}(?:-\d{4})?)\b/);
      if (tail) { const lead = tail[0].match(/^,?[ \t]+/)[0].length; spans.push({ start: from + lead, end: from + tail[0].length, type: 'LOCATION', source: 'rule', text: tail[0].slice(lead) }); continue; }
      const town = text.slice(from).match(/^,?[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)(?=[ \t]*(?:[.,;:\n]|$))/);
      if (town && !LEX.isClinical(town[1])) { const lead = town[0].length - town[1].length; spans.push({ start: from + lead, end: from + town[0].length, type: 'LOCATION', source: 'rule', text: town[1] }); }
    }
    run(RULES.AGE, 'AGE'); run(RULES.AGE_ORDINAL, 'AGE'); run(RULES.AGE_WORDS, 'AGE'); run(RULES.AGE_Y, 'AGE');
    run(RULES.AGE_SUBJECT, 'AGE', (m) => {
      // "HR is 95" / "K is 95" / "O2 sat is 95": a vital or lab name right before the subject word is not a person
      const before = text.slice(Math.max(0, m.index - 16), m.index);
      return !/\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc)\s*$/i.test(before);
    });
    // ages with no written subject, and in apposition: the span is the age phrase only
    RULES.AGE_TURNED.lastIndex = 0; let am;
    while ((am = RULES.AGE_TURNED.exec(text))) { const val = am[1]; const start = am.index + am[0].length - val.length; spans.push({ start, end: start + val.length, type: 'AGE', source: 'rule', text: val }); }
    run(RULES.AGE_APPOS, 'AGE', (m) => !/\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc|room|chair|bay|ext|x)\s*$/i.test(text.slice(Math.max(0, m.index - 10), m.index)));
    RULES.AGE_TURNS.lastIndex = 0; let at;
    while ((at = RULES.AGE_TURNS.exec(text))) { const val = at[1]; const start = at.index + at[0].length - val.length; if (!spans.some((x) => x.type === 'AGE' && x.start <= start && x.end >= start + val.length)) spans.push({ start, end: start + val.length, type: 'AGE', source: 'rule', text: val }); }
    run(RULES.MBI, 'ID_OTHER');
    // labelled record numbers, including ones broken by spaces/hyphens/OCR confusables; the span is the value only
    RULES.MRN_LABEL.lastIndex = 0; let mm;
    while ((mm = RULES.MRN_LABEL.exec(text))) {
      const val = mm[2]; const start = mm.index + mm[0].length - val.length;
      if ((val.match(/\d/g) || []).length < 5) continue;
      const type = /^(acct|account|csn|har|fin|encounter)/i.test(mm[1]) ? 'ACCOUNT' : 'MRN';
      spans.push({ start, end: start + val.length, type, source: 'rule', text: val, labeled: true });
    }
    RULES.DOB_COMPACT.lastIndex = 0; let dc;
    while ((dc = RULES.DOB_COMPACT.exec(text))) {
      const val = dc[1]; const start = dc.index + dc[0].length - val.length;
      const pd = { y: +val.slice(4), m: +val.slice(0, 2), d: +val.slice(2, 4), hasYear: true, yearDigits: 4, sep: '', kind: 'compact', monthStyle: null, text: val };
      if (validDMY(pd.y, pd.m, pd.d)) spans.push({ start, end: start + val.length, type: 'DOB', source: 'rule', text: val, date: pd });
    }
    RULES.SSN_LAST4.lastIndex = 0; let sl;
    while ((sl = RULES.SSN_LAST4.exec(text))) { const val = sl[1]; const start = sl.index + sl[0].length - val.length; spans.push({ start, end: start + val.length, type: 'ID_OTHER', source: 'rule', text: val, labeled: true }); }
    // streets and house addresses without a standard suffix; towns with a ZIP but no state
    const addrWordOk = (w) => !LEX.isClinical(w) && !LEX.HONORIFIC_SET.has(w.toLowerCase()) && !LEX.RELATION_SET.has(w.toLowerCase()) && !LEX.CREDENTIAL_SET.has(w.toLowerCase()) && !/^(per|call|called|see|seen|the|and|with|for|from|new|old|to|at|in|on|by|re|pt|patient|no|yes|ok|room|chair|bay|cycle|day|dose|grade|stage|appt|visit|next|last|first|due|labs?|scan|start|end|unit|apt|suite|floor|lot)$/i.test(w);
    RULES.STREET.lastIndex = 0; let st;
    while ((st = RULES.STREET.exec(text))) {
      const val = st[1]; const words = val.replace(/\.$/, '').split(/\s+/); const nameWords = words.slice(0, -1);
      if (!nameWords.every(addrWordOk)) continue;
      // "Per Dr", "Call Dr", "Nurse St" style false starts: the word before the suffix must not be the start of a sentence verb
      const before = text.slice(Math.max(0, st.index - 2), st.index);
      if (/[A-Za-z]$/.test(before)) continue;
      spans.push({ start: st.index, end: st.index + val.length, type: 'ADDRESS', source: 'rule', text: val, conf: 0.8 });
    }
    RULES.ADDRESS_CUE.lastIndex = 0; let ac;
    while ((ac = RULES.ADDRESS_CUE.exec(text))) {
      const val = ac[1]; const start = ac.index + ac[0].length - val.length;
      if (!val.split(/\s+/).slice(1).every(addrWordOk)) continue;
      spans.push({ start, end: start + val.length, type: 'ADDRESS', source: 'rule', text: val, conf: 0.8 });
    }
    RULES.TOWN_ZIP.lastIndex = 0; let tz;
    while ((tz = RULES.TOWN_ZIP.exec(text))) {
      const town = tz[1]; const words = town.split(/\s+/);
      if (!words.every(addrWordOk) || words.some((w) => /^(ext|extension|ref|conf|auth|lot|serial|sn|id|code|group|member|policy|claim|acct|account|mrn|invoice|order|ticket|case|pin|box|po|zip|phone|fax|tel|pager|plan|rx|ndc|dx|icd|cpt|hcpcs|employee|badge)$/i.test(w) || /^[A-Z]{2,}$/.test(w))) continue;
      const cue = /\b(?:lives?|living|resides?|residing|address|home|moved|from|in|near|to|at|staying)\s*(?:alone\s+|in\s+|at\s+)?$/i.test(text.slice(Math.max(0, tz.index - 16), tz.index));
      if (!LEX.CITY_SET.has(words[words.length - 1].toLowerCase()) && !cue && !(words.length === 2 && LEX.PLACE_PREFIX_SET.has(words[0].toLowerCase()))) continue;
      spans.push({ start: tz.index, end: tz.index + tz[0].length, type: 'LOCATION', source: 'rule', text: tz[0], conf: 0.8 });
    }
    // labelled identifiers: the span is the value only, not the label
    RULES.LABELED_ID.lastIndex = 0; let lm;
    while ((lm = RULES.LABELED_ID.exec(text))) {
      let val = lm[1]; if (!val) continue;
      // "Medicare MBI 1EG4-TE5-MK73": a second label word in front of the value stays in the text
      const inner = val.match(/^(MBI|ID|HIC|HICN|MRN|SSN|NO|NUM|REF|SN|SERIAL)\s+/i); if (inner) val = val.slice(inner[0].length); if (!val) continue;
      if (/^[A-Za-z]+/.test(val) && val.match(/^[A-Za-z]+/)[0] !== val.match(/^[A-Za-z]+/)[0].toUpperCase()) continue; // "year 2026", "exp 2027": a word, not a code prefix
      const digits = (val.match(/\d/g) || []).length, letters = (val.match(/[A-Za-z]/g) || []).length;
      if (digits < 4 && !(digits >= 3 && letters >= 1)) continue;
      const label = lm[0].slice(0, lm[0].length - val.length).trim().toLowerCase();
      // "group 1/2", "case 3", "id 2", "order 2 units": weak labels need a long or lettered value
      if (/^(case|order|card|visa|pin|id|lot)\b/.test(label) && digits < 5 && letters === 0) continue;
      if (/^\d{1,2}[\/\-.]\d{1,2}([\/\-.]\d{2,4})?$/.test(val)) continue; // a date, not an id
      const start = lm.index + lm[0].length - val.length;
      const dup = spans.find((x) => x.type === 'ID_OTHER' && x.start === start && x.end === start + val.length);
      if (dup) { dup.labeled = true; continue; }
      spans.push({ start, end: start + val.length, type: 'ID_OTHER', source: 'rule', text: val, labeled: true });
    }
    RULES.HANDLE.lastIndex = 0; let hm;
    while ((hm = RULES.HANDLE.exec(text))) {
      const val = hm[1] || hm[0]; const start = hm.index + hm[0].length - val.length;
      if (hm[1] && /^(?:password|pw|pwd|none|n\/a|same|locked|reset)$/i.test(val)) continue;
      spans.push({ start, end: start + val.length, type: 'ID_OTHER', source: 'rule', text: val, handle: true });
    }
    RULES.HANDLE_SHAPE.lastIndex = 0; let hs;
    while ((hs = RULES.HANDLE_SHAPE.exec(text))) {
      const v = hs[0];
      if ((v.match(/\d/g) || []).length < 2) continue; // snake_case words (pre_chemo, lab_results) are not user names
      if (/\.(?:pdf|docx?|xlsx?|csv|txt|png|jpe?g|gif|html?|js|zip)$/i.test(v) || /^v\d/i.test(v)) continue;
      spans.push({ start: hs.index, end: hs.index + v.length, type: 'ID_OTHER', source: 'rule', text: v, handle: true });
    }
    RULES.HANDLE_CUE.lastIndex = 0; let hc;
    while ((hc = RULES.HANDLE_CUE.exec(text))) {
      const v = hc[1]; const start = hc.index + hc[0].length - v.length;
      if (!/\d|[._]/.test(v) || spans.some((x) => x.handle && x.start <= start && x.end >= start + v.length)) continue;
      spans.push({ start, end: start + v.length, type: 'ID_OTHER', source: 'rule', text: v, handle: true });
    }
    RULES.INITIALS.lastIndex = 0; let im;
    while ((im = RULES.INITIALS.exec(text))) { const val = im[1]; const start = im.index + im[0].length - val.length; spans.push({ start, end: start + val.length, type: 'NAME_OTHER', source: 'rule', text: val, conf: 0.8, initials: true }); }
    // OCR-noisy phones
    RULES.PHONE_OCR.lastIndex = 0; let pm;
    while ((pm = RULES.PHONE_OCR.exec(text))) {
      const digits = (pm[0].match(/\d/g) || []).length, letters = (pm[0].match(/[OIl]/g) || []).length;
      if (letters === 0 || digits < 7 || letters > 4) continue;
      spans.push({ start: pm.index, end: pm.index + pm[0].length, type: 'PHONE', source: 'rule', text: pm[0], conf: 0.8 });
    }
    const notPhoneExt = (m) => {
      const after = text.slice(m.index + m[0].length), before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/^\s*(?:x|ext\.?|extension)\s*\.?\s*\d/i.test(after)) return false; // phone extension follows
      if (/[-.(]\s*$/.test(before)) return false; // part of a formatted phone
      if (/^\d{5}(-\d{4})?$/.test(m[0]) && (/\b[A-Z]{2}\s+$/.test(before) || /zip\s*(code)?\s*:?\s*$/i.test(before))) return false; // ZIP code
      return true;
    };
    if (cfg.mrnRegex) run(cfg.mrnRegex, 'MRN', notPhoneExt);
    if (cfg.accountRegex) run(cfg.accountRegex, 'ACCOUNT', notPhoneExt);
    // Fallback for pasted/OCR text with no learned MRN pattern: a standalone 6-9 digit integer in clinical free text is
    // an identifier (MRN, account, order, claim) far more often than anything else. Money, units and formatted numbers are excluded.
    run(RULES.ID_BARE, 'ID_OTHER', (m) => notPhoneExt(m) && !/^[ \t]*(?:mg|mcg|g|ml|mL|units?|cells|copies|iu|mEq|cc|pts?|steps|k)\b/i.test(text.slice(m.index + m[0].length)) && !/[$€£]\s*$/.test(text.slice(Math.max(0, m.index - 3), m.index)));
    (cfg.extraRegexes || []).forEach((r) => run(r, 'ID_OTHER'));
    run(RULES.PHONE_PLAIN, 'PHONE');
    // a date cut off by a line wrap ("1970-02-" then "09" on the next line, "3/26/" then "1976"): still a date
    run(/(?<![\w\/\-])(?:(?:19|20)\d{2}-\d{1,2}-(?!\d)|\d{1,2}\/\d{1,2}\/(?!\d))/gm, 'DATE');
    // dates
    for (const p of DATE_PATTERNS) {
      p.re.lastIndex = 0; let m;
      while ((m = p.re.exec(text))) {
        const pd = parseDateMatch(p.kind, m);
        if (!pd) continue;
        const after = text.slice(m.index + m[0].length);
        if (!pd.hasYear && UNIT_AFTER.test(after)) continue;
        if (p.kind === 'md') {
          // "C1D1"-style, "cycle 1/2", "days 1-3" are not dates
          const before = text.slice(Math.max(0, m.index - 10), m.index);
          const nextCycle = /next\s+cycle\s*$/i.test(text.slice(Math.max(0, m.index - 14), m.index));
          if (RANGE_BEFORE.test(before) && !nextCycle) continue;
          if (/^\s*(?:today|tomorrow|tmrw|tonight|each|every|strength|rate|dose|tabs?|caps?)\b/i.test(after)) continue;
          // hyphen form (1-3) and small fractions (1/2, 3/4) are ranges/doses unless the context says date
          const fractionLike = pd.m <= 3 && pd.d <= 4;
          if ((pd.sep === '-' || fractionLike) && !nextCycle) {
            const ctxBefore = text.slice(Math.max(0, m.index - 20), m.index);
            if (!DATE_CTX_BEFORE.test(ctxBefore) && !DATE_CTX_AFTER.test(after)) continue;
          }
        }
        const dobLabel = pd.hasYear && /\b(?:dob|d\.o\.b\.?|birth\s*date|birthdate|born|b\.)\s*[:#]?\s*$/i.test(text.slice(Math.max(0, m.index - 14), m.index));
        spans.push({ start: m.index, end: m.index + m[0].length, type: dobLabel ? 'DOB' : 'DATE', source: 'rule', text: m[0], date: pd });
      }
    }
    // OCR-noisy dates: normalize the confusable letters, parse, and cover the whole noisy token
    RULES.DATE_OCR.lastIndex = 0; let dm;
    while ((dm = RULES.DATE_OCR.exec(text))) {
      const raw = dm[0];
      if (spans.some((s) => s.type === 'DATE' && s.start <= dm.index && s.end >= dm.index + raw.length)) continue;
      const norm = raw.replace(/O/g, '0').replace(/[Il]/g, '1');
      let pd = null;
      for (const p of DATE_PATTERNS) { if (p.kind !== 'mdy' && p.kind !== 'iso') continue; p.re.lastIndex = 0; const mm = p.re.exec(norm); if (mm && mm[0] === norm) { pd = parseDateMatch(p.kind, mm); break; } }
      if (!pd) continue;
      // drop partial rule dates that fell inside this token (e.g. "11/2" out of "11/2O/2026")
      for (let i = spans.length - 1; i >= 0; i--) if (spans[i].type === 'DATE' && spans[i].start >= dm.index && spans[i].end <= dm.index + raw.length) spans.splice(i, 1);
      spans.push({ start: dm.index, end: dm.index + raw.length, type: 'DATE', source: 'rule', text: raw, date: pd, conf: 0.8 });
    }
    return spans;
  }

  // ---------------------------------------------------------------------
  // 3b. Tier 1-lite: lexicon + cue detector for names, orgs, locations
  // ---------------------------------------------------------------------
  // letters include accented and non-Latin ones (Nguyễn, Bríd, Ångström), so a diacritic never splits a name in two
  const TOKEN_RE = /\p{L}[\p{L}\p{M}'’\-]*\.?|\d+(?:[.,]\d+)*|[^\s\p{L}\p{M}\d]/gu;
  function tokenize(text) {
    const toks = []; let m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      const raw = m[0];
      const core = raw.replace(/['’]s$/i, '').replace(/\.$/, '');
      toks.push({
        raw, core, start: m.index, end: m.index + core.length, fullEnd: m.index + raw.length,
        cap: /^\p{Lu}[\p{Ll}\p{M}'’\-]*$/u.test(core) || /^(?:al|el|ad|ar|as|ash|at|az|an|bin|ibn|ben|bint|abu|ould)-[A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?$/.test(core) || /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(core) || (/^[A-Z][A-Za-z'’\-]*[a-z]$/.test(core) && (core.match(/[A-Z]/g) || []).length <= 3 && /^(Mc|Mac|De|Di|Da|La|Le|Van|Von|O'|O’|D'|D’|St|Fitz|Del|Des|Du)[A-Z'’]/.test(core)),
        allcaps: /^\p{Lu}[\p{Lu}\p{M}'’\-]{2,}$/u.test(core),
        initial: /^\p{Lu}\.?$/u.test(raw) && raw.length <= 2,
        word: /^\p{L}/u.test(raw), num: /^\d/.test(raw), punct: !/^[\p{L}\d]/u.test(raw),
      });
    }
    for (let i = 0; i < toks.length - 1; i++) toks[i].nlAfter = text.slice(toks[i].fullEnd, toks[i + 1].start).includes('\n');
    return toks;
  }
  // the second word of many town names: Harlowe Springs, Cedar Falls, Pickett Hollow, Glen Ridge
  const PLACE_SUFFIX = /^(?:Springs|Falls|Hollow|Heights|Hts|Creek|Ridge|Hills|Valley|Junction|Village|Harbor|Harbour|Beach|Mills|Landing|Bluffs?|Crossing|Grove|Glen|Lakes|Shores?|Meadows|Woods|Corners|Township|Gap|Ford|Haven|Vale|Dale|Brook)$/;
  // a word that names a disease or procedure by its ending: what follows an eponym, not a person (de Quervain thyroiditis)
  const MED_SUFFIX = /(?:itis|osis|oses|oma|omas|emia|aemia|pathy|plasia|trophy|algia|ectomy|otomy|ostomy|plasty|scopy|graphy|ism|syndrome|disease|sign|reflex|test|anomaly|malformation|contracture|fracture|tumou?r|sarcoma|lymphoma|leukemia|palsy|phenomenon)$/i;
  // lower-case particles inside a personal name: van der Berg, de la Cruz, bin Khalid, dos Santos
  const NAME_PARTICLE = /^(?:de|van|von|der|den|la|le|del|della|da|di|du|dos|das|do|st|mc|mac|o|bin|ibn|bint|binti|ben|al|el|ter|ten|zu|af|y)$/i;
  // Title-Case words that start sentences or label UI regions and are not names (Front Desk called, Next MD visit)
  const COMMON_CAP = new Set(('front desk office team staff unit charge triage social case advocate next plan member address update new old please thanks thank ' +
    'call called message note notes reply sent from today tomorrow yesterday tonight morning afternoon evening good great ok okay hi hello dear per spoke left ' +
    'transport transportation request security billing pharm verify verification insurance coverage scheduling schedule front back main lobby waiting ' +
    'infusion chemo nurse nursing desk clinic team center floor pod bay chair room home health hospice service services visit visitor visiting family ' +
    'any all some no not none other both each every this that these those his her their our your my the a an and or but if when while after before ' +
    'still also only just even then than once again first last next prior post pre patient pt mom dad son daughter wife husband sister brother ' +
    'rapid response pump alarm disconnect connect kit port line lines access flush flushed alert alerts code team teams rounds round huddle ' +
    'case manager management coordinator navigator tech technician assistant aide practitioner provider resident fellow intern student ' +
    'blood bank lab labs imaging radiology pathology pharmacy oncology hematology infusion treatment therapy dose doses cycle cycles day days ' +
    'week weeks month months year years hour hours minute minutes order orders plan plans result results report reports form forms consent ' +
    'review reviewed approved denied pending complete completed done ready hold held stop stopped start started cancel cancelled confirm confirmed ' +
    'reminder reminders appointment appointments arrival discharge admission admit transfer referral referrals records record chart charts ' +
    'portal message messages inbox queue list board screen view tab tile tiles status update updates change changes request requests ' +
    'right left upper lower central peripheral chest arm hand leg foot back neck head morning noon night daily weekly monthly ' +
    'high normal abnormal critical stable urgent routine standing standard special general total partial full half double single').split(/\s+/));
  // word endings that mark an ordinary English noun or adjective rather than a name (Response, Management, Disconnect-ion ...)
  // (only endings that essentially never close a given name or surname: Constance, Felicity, Clement, Mallory stay names)
  const NONNAME_END = /(?:tion|sion|ness|ology|ics|able|ible|ful|less|ous|ated|ized|ised|ectomy|itis)$/i;
  const isHon = (t) => t && t.word && LEX.HONORIFIC_SET.has(t.core.toLowerCase());
  const isCred = (t) => t && t.word && LEX.CREDENTIAL_SET.has(t.core.replace(/\./g, '').toLowerCase()) && t.core === t.core.toUpperCase() || (t && t.word && /^(PharmD|PsyD|PhD)$/.test(t.core));
  // A token that ends a sentence: trailing period that is not an honorific/initial/credential
  const endsSentence = (t) => !!t && (t.nlAfter || (t.raw.endsWith('.') && !isHon(t) && !t.initial && !isCred(t) && !/^(vs|etc|approx|re|appt|pt|pts|hx|dx|tx|w|c|s|p|q|b|d|e|g|i|mg|mcg|ml|no|dr|mr|mrs|ms|st|jr|sr|inc|ltd)$/i.test(t.core)));
  const relWord = (w) => { const l = w.toLowerCase(); if (LEX.RELATION_SET.has(l)) return true; const b = l.replace(/^(?:(?:great|grand|step|half|ex)-?)+(?=[a-z])/, '').replace(/-in-law$/, ''); return b !== l && b.length >= 2 && LEX.RELATION_SET.has(b); };
  const isRel = (t) => t && t.word && relWord(t.core);
  const isNameish = (t, allow) => t && (t.cap || t.allcaps || t.initial) && !LEX.isClinical(t.core) && !(allow && allow.has(t.core.toLowerCase()));
  const inLex = (t) => t && (LEX.isFirstName(t.core) || LEX.isSurname(t.core));

  function lexiconSpans(text, cfg) {
    const toks = tokenize(text);
    const pNameOkLate = (t) => t && t.word && (t.cap || t.allcaps) && t.core.length >= 2 && !LEX.isClinical(t.core) && !isRel(t) && !isHon(t) && !isCred(t) && !LEX.ORG_SUFFIX_SET.has(t.core.toLowerCase()) && (!LEX.ORG_NAMEWORD_SET.has(t.core.toLowerCase()) || LEX.isFirstName(t.core)) && !COMMON_CAP.has(t.core.toLowerCase()) && !LEX.STATE_ABBR_SET.has(t.core) && !(cfg.allowSet && cfg.allowSet.has(t.core.toLowerCase()));
    const spans = [];
    const used = new Array(toks.length).fill(false);
    const allow = cfg.allowSet;
    const deny = cfg.denySet;

    const addRun = (i, j, type, source, conf) => {
      if (j <= i) return;
      for (let k = i; k < j; k++) used[k] = true;
      spans.push({ start: toks[i].start, end: toks[j - 1].end, type, source, conf, text: text.slice(toks[i].start, toks[j - 1].end) });
    };
    // Capture up to `max` name-ish tokens starting at i; connectors: initials, hyphen.
    const nameRun = (i, max, relaxed) => {
      let j = i;
      while (j < toks.length && j - i < max) {
        const t = toks[j];
        const relaxedOk = relaxed && (t.cap || t.allcaps) && inLex(t) && !/['’]s$/i.test(t.raw) && !(allow && allow.has(t.core.toLowerCase())) && !isCred(t) && !isRel(t);
        if (!isNameish(t, allow) && !relaxedOk) break;
        if (j > i && endsSentence(toks[j - 1])) break;
        if (t.cap && t.core.length === 1) break;
        j++;
        // allow "de", "van", "la" lowercase particles inside a run if followed by cap
        if (j < toks.length && NAME_PARTICLE.test(toks[j].core) && j + 1 < toks.length && isNameish(toks[j + 1], allow)) j++;
        else if (j + 1 < toks.length && NAME_PARTICLE.test(toks[j].core) && NAME_PARTICLE.test(toks[j + 1].core) && j + 2 < toks.length && isNameish(toks[j + 2], allow)) j += 2;
      }
      return j;
    };

    // Epic field labels that precede a value (Appt Date 11/07/2026, Start Date, Last Seen): never a name token
    const FIELD_WORD = /^(appt|appointment|date|start|end|next|last|first|due|visit|seen|scan|time|signed|number|num|sched|schedule|scheduled|ordered|entered|created|updated|name|phone|fax|cell|home|work|room|chair|bay|unit|floor|dept|department|status|type|note|notes|comment|comments|reason|result|results|dose|cycle|day|arrival|arrive|check|checked|dob|mrn|acct|sex|age|wt|ht|provider|attending|location|dx|tx|plan|order|orders)$/i;
    // Custom deny terms (always redact)
    if (deny && deny.size) {
      for (let i = 0; i < toks.length; i++) {
        if (toks[i].word && deny.has(toks[i].core.toLowerCase())) addRun(i, i + 1, 'NAME_OTHER', 'custom', 1);
      }
    }

    // Pass F: organizations  (Roswell Park Cancer Center, St. Mary's Hospital, Buffalo General)
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t.word || !(t.cap || t.allcaps) || !LEX.ORG_SUFFIX_SET.has(t.core.toLowerCase())) continue;
      if (used[i]) continue;
      let j = i + 1;
      // extend forward over further suffix words (Medical Center, Cancer Center) and one trailing
      // capitalized place/name token (Hospice Buffalo, Mercy Hospital of Buffalo)
      while (j < toks.length && !used[j] && toks[j].word && (toks[j].cap || toks[j].allcaps) && LEX.ORG_SUFFIX_SET.has(toks[j].core.toLowerCase()) && !endsSentence(toks[j - 1])) j++;
      let nonSuffix = 0;
      if (j < toks.length && !used[j] && toks[j].word && toks[j].cap && !endsSentence(toks[j - 1]) && (LEX.CITY_SET.has(toks[j].core.toLowerCase()) || LEX.isSurname(toks[j].core) || LEX.ORG_NAMEWORD_SET.has(toks[j].core.toLowerCase())) && !LEX.isClinical(toks[j].core) && !isRel(toks[j])) { j++; nonSuffix++; }
      else if (LEX.ORG_PREFIX_SET.has(t.core.toLowerCase()) && j < toks.length && !used[j] && toks[j].word && (toks[j].cap || toks[j].allcaps) && !endsSentence(toks[j - 1]) && !LEX.isClinical(toks[j].core) && !isRel(toks[j]) && !isHon(toks[j]) && !FIELD_WORD.test(toks[j].core)) {
        j++; nonSuffix++;
        while (j < toks.length && !used[j] && toks[j].word && toks[j].cap && !endsSentence(toks[j - 1]) && !LEX.isClinical(toks[j].core) && j - i < 4 && (LEX.ORG_SUFFIX_SET.has(toks[j].core.toLowerCase()) || LEX.ORG_NAMEWORD_SET.has(toks[j].core.toLowerCase()) || /^(of|and|&)$/i.test(toks[j].core))) j++;
      }
      // "Hospice of the Valley", "Visiting Nurses of Cape Ann": "of (the)" and the capitalized words after it
      else if (j < toks.length && toks[j].word && /^of$/.test(toks[j].core) && !endsSentence(toks[j - 1])) {
        let q = j + 1;
        if (q < toks.length && toks[q].word && /^the$/i.test(toks[q].core)) q++;
        let e = q;
        while (e < toks.length && e - q < 3 && !used[e] && toks[e].word && (toks[e].cap || toks[e].allcaps) && !LEX.isClinical(toks[e].core) && !isRel(toks[e]) && !isHon(toks[e]) && !isCred(toks[e]) && !FIELD_WORD.test(toks[e].core) && !(e > q && endsSentence(toks[e - 1]))) { e++; if (endsSentence(toks[e - 1])) break; }
        if (e > q) { j = e; nonSuffix++; }
      }
      let k = i;
      while (k > 0 && i - k < 5) {
        const p = toks[k - 1];
        if (used[k - 1] || endsSentence(p)) break;
        if (p.word && (p.cap || p.allcaps) && !isRel(p) && !isHon(p) && !isCred(p)) { if (!LEX.ORG_SUFFIX_SET.has(p.core.toLowerCase()) || LEX.ORG_NAMEWORD_SET.has(p.core.toLowerCase())) nonSuffix++; k--; continue; }
        if (p.word && /^(of|and|for|the|&)$/i.test(p.core) && k - 2 >= 0 && !used[k - 2] && toks[k - 2].word && (toks[k - 2].cap || toks[k - 2].allcaps) && i - k < 4) { k--; continue; }
        // "Elderwood at Williamsville SNF": "at" joins a facility name only when the word before it is a
        // capitalized token that is not a person name (not in the name lexicon, no honorific before it)
        if (p.word && /^at$/i.test(p.core) && k - 2 >= 0 && !used[k - 2] && toks[k - 2].word && (toks[k - 2].cap || toks[k - 2].allcaps) && !inLex(toks[k - 2]) && !LEX.isClinical(toks[k - 2].core) && !isRel(toks[k - 2]) && !(k - 3 >= 0 && (isHon(toks[k - 3]) || isCred(toks[k - 3]))) && i - k < 4) { k--; continue; }
        if (p.raw === '&') { k--; continue; }
        break;
      }
      // trim leading connectors and generic leading words
      while (k < i && /^(of|and|for|the|&|referred|referral|from|per|at|see|call|called|sent|to)$/i.test(toks[k].core)) k++;
      if (nonSuffix >= 1 && (k < i || j > i + 1)) {
        for (let q = k; q < j; q++) used[q] = true;
        // "Erie County" is a geographic unit, not an organization
        const geo = LEX.GEO_SUFFIX_SET.has(toks[j - 1].core.toLowerCase());
        spans.push({ start: toks[k].start, end: toks[j - 1].end, type: geo ? 'LOCATION' : 'ORG', source: 'cue:org', conf: 0.75, text: text.slice(toks[k].start, toks[j - 1].end) });
        i = j - 1;
      }
    }
    // Pass F2: facility names after an anchor (from Kenmore Mercy; at UPMC Hamot; (ECMC); from ECMC)
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      const anchor = (t.word && /^(from|at|to|via|by|into|outside)$/i.test(t.core)) || t.raw === '(' || t.raw === '@';
      if (!anchor) continue;
      let j = i + 1, hasFacilityWord = false;
      while (j < toks.length && j - i <= 4 && !used[j] && toks[j].word && (toks[j].cap || toks[j].allcaps || /^(of|&|and)$/i.test(toks[j].core)) && !isRel(toks[j]) && !isHon(toks[j]) && !isCred(toks[j])) {
        const lc = toks[j].core.toLowerCase();
        const capsNeighbour = (q) => q >= 0 && q < toks.length && toks[q].word && toks[q].allcaps && toks[q].core.length >= 3 && !LEX.ORG_NAMEWORD_SET.has(toks[q].core.toLowerCase()) && !LEX.ORG_SUFFIX_SET.has(toks[q].core.toLowerCase());
        const acronym = /^[A-Z]{3,6}$/.test(toks[j].core) && !LEX.isClinical(toks[j].core) && !LEX.STATE_ABBR_SET.has(toks[j].core) && !LEX.CREDENTIAL_SET.has(lc) && !LEX.RELATION_SET.has(lc) && !(capsNeighbour(j - 1) && j - 1 > i) && !capsNeighbour(j + 1);
        if (LEX.isClinical(toks[j].core) && !LEX.ORG_NAMEWORD_SET.has(lc) && !LEX.ORG_SUFFIX_SET.has(lc)) break;
        if (allow && allow.has(lc)) break;
        if (LEX.ORG_NAMEWORD_SET.has(lc) || LEX.ORG_SUFFIX_SET.has(lc) || acronym) hasFacilityWord = true;
        j++;
        if (j < toks.length && endsSentence(toks[j - 1])) break;
      }
      while (j > i + 1 && /^(of|&|and)$/i.test(toks[j - 1].core)) j--;
      if (!hasFacilityWord || j <= i + 1) continue;
      // a run that is only a person name (Karen Lee) is not an org: require a facility word to be present (checked) and not all tokens in the name lexicon
      const allNames = toks.slice(i + 1, j).every((x) => inLex(x) && !LEX.ORG_NAMEWORD_SET.has(x.core.toLowerCase()) && !LEX.ORG_SUFFIX_SET.has(x.core.toLowerCase()));
      if (allNames) continue;
      // a run of only generic words ("to Pharmacy", "from Radiology", "to Hospice") names a department, not a facility
      const allGeneric = toks.slice(i + 1, j).every((x) => LEX.ORG_SUFFIX_SET.has(x.core.toLowerCase()) || /^(of|&|and)$/i.test(x.core));
      if (allGeneric) continue;
      for (let q = i + 1; q < j; q++) used[q] = true;
      spans.push({ start: toks[i + 1].start, end: toks[j - 1].end, type: 'ORG', source: 'cue:facility', conf: 0.55, text: text.slice(toks[i + 1].start, toks[j - 1].end) });
      i = j - 1;
    }
    // Pass F3: well-known regional employers and facilities (Moog, GEICO, Elderwood), and an organization named after an
    // employment cue ("works at Sumitomo", "retired from Moog", "Employer: Rich Products", "his boss at Praxair")
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (used[i] || !t.word || !(t.cap || t.allcaps)) continue;
      const two = i + 1 < toks.length && toks[i + 1].word ? `${t.core} ${toks[i + 1].core}`.toLowerCase() : '';
      if (two && LEX.LOCAL_ORG_SET.has(two) && !used[i + 1]) { addRun(i, i + 2, 'ORG', 'lexicon:org', 0.8); i++; continue; }
      if (LEX.LOCAL_ORG_SET.has(t.core.toLowerCase()) && !(allow && allow.has(t.core.toLowerCase()))) { addRun(i, i + 1, 'ORG', 'lexicon:org', 0.8); continue; }
    }
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (!t.word || !/^(at|for|from|with|by)$/i.test(t.core)) continue;
      const cueBefore = toks.slice(Math.max(0, i - 4), i).some((x) => x.word && /^(works?|working|worked|employed|employee|employer|retired|retiring|job|boss|supervisor|manager|company|contractor|shift|hired)$/i.test(x.core)) || (toks[i - 1].word && /^(employer|work|job|company)$/i.test(toks[i - 1].core));
      if (!cueBefore) continue;
      let j = i + 1;
      while (j < toks.length && j - i <= 3 && !used[j] && toks[j].word && (toks[j].cap || toks[j].allcaps) && !LEX.isClinical(toks[j].core) && !isRel(toks[j]) && !isHon(toks[j]) && !isCred(toks[j]) && !FIELD_WORD.test(toks[j].core) && !(allow && allow.has(toks[j].core.toLowerCase())) && !(j > i + 1 && endsSentence(toks[j - 1]))) j++;
      if (j === i + 1) continue;
      if (toks.slice(i + 1, j).every((x) => inLex(x) && !LEX.ORG_SUFFIX_SET.has(x.core.toLowerCase()))) continue; // "works with Karen Lee" is a person
      addRun(i + 1, j, 'ORG', 'cue:employer', 0.6); i = j - 1;
    }
    // "Employer: Rich Products" / "Employer - GEICO"
    for (let i = 0; i < toks.length - 2; i++) {
      if (!toks[i].word || !/^(employer|employed|works|workplace|job)$/i.test(toks[i].core) || !/^[:\-–]$/.test(toks[i + 1].raw)) continue;
      let j = i + 2;
      while (j < toks.length && j - i <= 4 && !used[j] && toks[j].word && (toks[j].cap || toks[j].allcaps) && !LEX.isClinical(toks[j].core) && !isRel(toks[j]) && !(j > i + 2 && endsSentence(toks[j - 1]))) j++;
      if (j > i + 2) { addRun(i + 2, j, 'ORG', 'cue:employer', 0.6); i = j - 1; }
    }
    // Pass G1: City, ST (+ optional ZIP); the comma may be missing ("Kenmore NY 14217") when a ZIP follows or the city is known
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t.word || used[i] || !(t.cap || t.allcaps)) continue;
      let si; // index of the state token
      if (i + 2 < toks.length && toks[i + 1].raw === ',' && toks[i + 2].word && LEX.STATE_ABBR_SET.has(toks[i + 2].core) && toks[i + 2].core === toks[i + 2].core.toUpperCase()) si = i + 2;
      else if (i + 1 < toks.length && toks[i + 1].word && LEX.STATE_ABBR_SET.has(toks[i + 1].core) && toks[i + 1].core === toks[i + 1].core.toUpperCase() && !used[i + 1]
        && ((i + 2 < toks.length && toks[i + 2].num && /^\d{5}$/.test(toks[i + 2].raw)) || (LEX.CITY_SET.has(t.core.toLowerCase()) && !/^(OK|IN|OR|ME|HI|DE|PA|MD|ID|MA|MO|OH|AL|AR|GA|LA|MS|MT|NE|VA|WA|CO|CT)$/.test(toks[i + 1].core)))) si = i + 1;
      else continue;
      const st = toks[si].core;
      if ((st === 'PA' || st === 'MD') && (inLex(t) || LEX.isClinical(t.core))) continue; // "Smith, PA" is a credential
      if (LEX.isClinical(t.core) && !LEX.CITY_SET.has(t.core.toLowerCase())) continue;
      if (si === i + 2 && /^[A-Z]{2,4}$/.test(t.core) && !LEX.CITY_SET.has(t.core.toLowerCase()) && (i === 0 || !toks[i - 1].word || !/^(in|from|to|at|near|of|via|into|outside)$/i.test(toks[i - 1].core))) continue; // "Honda CRV, NY" is not a place
      let k = i;
      while (k > 0 && (toks[k - 1].cap || toks[k - 1].allcaps) && !used[k - 1] && i - k < 2 && (LEX.CITY_SET.has(toks[k - 1].core.toLowerCase()) || LEX.PLACE_PREFIX_SET.has(toks[k - 1].core.toLowerCase()) || (k === i && PLACE_SUFFIX.test(t.core) && !LEX.isClinical(toks[k - 1].core) && !isRel(toks[k - 1]) && !toks[k - 1].nlAfter && !endsSentence(toks[k - 1])))) k--;
      let e = si + 1;
      if (e < toks.length && toks[e].num && /^\d{5}$/.test(toks[e].raw)) e++;
      for (let q = k; q < e; q++) used[q] = true;
      spans.push({ start: toks[k].start, end: toks[e - 1].end, type: 'LOCATION', source: 'cue:city-state', conf: 0.8, text: text.slice(toks[k].start, toks[e - 1].end) });
      i = e - 1;
    }
    // Pass G1b: directional/compound place after a movement preposition (in East Aurora; from North Collins; to Fort Erie)
    for (let i = 0; i + 2 < toks.length; i++) {
      const t = toks[i], n = toks[i + 1], m2 = toks[i + 2];
      if (!t.word || !/^(in|from|to|near|into|outside)$/i.test(t.core) || used[i + 1] || used[i + 2]) continue;
      if (!n.word || !(n.cap || n.allcaps) || !LEX.PLACE_PREFIX_SET.has(n.core.toLowerCase())) continue;
      if (!m2.word || !m2.cap || LEX.isClinical(m2.core) || isRel(m2) || isCred(m2) || isHon(m2) || LEX.ORG_SUFFIX_SET.has(m2.core.toLowerCase()) || LEX.STATE_NAME_SET.has(m2.core.toLowerCase())) continue;
      if (/^(wing|side|entrance|lot|campus|building|bldg|tower|pavilion|parking|garage|elevator|end|hall|coast|america)$/i.test(m2.core)) continue;
      if (n.nlAfter || t.nlAfter) continue;
      used[i + 1] = used[i + 2] = true;
      spans.push({ start: n.start, end: m2.end, type: 'LOCATION', source: 'cue:place', conf: 0.55, text: text.slice(n.start, m2.end) });
    }
    // Pass G3: a town named by a place word after a locative preposition ("at the ER in Harlowe Springs", "from Cedar Falls",
    // "lives near Pickett Hollow")
    for (let i = 0; i + 2 < toks.length; i++) {
      const t = toks[i];
      if (!t.word || !/^(in|from|to|near|into|outside|of|at)$/i.test(t.core)) continue;
      let j = i + 1;
      while (j < toks.length && j - i <= 2 && !used[j] && toks[j].word && toks[j].cap && !LEX.isClinical(toks[j].core) && !isRel(toks[j]) && !isHon(toks[j]) && !isCred(toks[j]) && !PLACE_SUFFIX.test(toks[j].core) && !toks[j].nlAfter) j++;
      if (j === i + 1 || j >= toks.length || used[j] || !toks[j].word || !toks[j].cap || !PLACE_SUFFIX.test(toks[j].core)) continue;
      if (toks[j + 1] && toks[j + 1].word && (LEX.ORG_SUFFIX_SET.has(toks[j + 1].core.toLowerCase()) || toks[j + 1].cap && !endsSentence(toks[j]) && !toks[j].nlAfter)) continue; // Willow Creek Hospital: an organization
      for (let q = i + 1; q <= j; q++) used[q] = true;
      spans.push({ start: toks[i + 1].start, end: toks[j].end, type: 'LOCATION', source: 'cue:place', conf: 0.6, text: text.slice(toks[i + 1].start, toks[j].end) });
      i = j;
    }
    // Pass A: honorific + name  (Dr. Lee, Mrs. Thaddeus Abernathy)
    for (let i = 0; i < toks.length - 1; i++) {
      if (!isHon(toks[i])) continue;
      const j = nameRun(i + 1, 3, true);
      if (j > i + 1) addRun(i + 1, j, /^(dr|doctor|prof|nurse)$/i.test(toks[i].core) ? 'NAME_PROVIDER' : 'NAME_OTHER', 'cue:honorific', 0.95);
    }
    // Pass A2: dotted initials as a given name, after a label, honorific or relation word ("Pt J.R. Whitcombe-Faraday",
    // "Mr. J. R. Okafor", "husband T.J. Brennan"), with the surname when one follows
    for (let i = 0; i + 1 < toks.length; i++) {
      const p = toks[i];
      const label = isHon(p) || isRel(p) || (p.word && /^(pt|patient|name|re|caller|contact)$/i.test(p.core) && !/['’]s$/.test(p.raw)) || p.raw === ':';
      if (!label) continue;
      let j = i + 1;
      while (j < toks.length && j - i <= 3 && toks[j].initial && toks[j].raw.endsWith('.') && !used[j] && !(j > i + 1 && toks[j - 1].nlAfter)) j++;
      if (j - (i + 1) < 2 && !(j - (i + 1) === 1 && j < toks.length && toks[j].cap && pNameOkLate(toks[j]))) continue;
      // dotted clinical abbreviations are not initials: I.V., P.O., N.P.O., R.N., B.I.D., P.R.N.
      const letters = toks.slice(i + 1, j).map((t) => t.core).join('');
      if (/^(?:IV|PO|NPO|RN|MD|DO|NP|PA|QD|BID|TID|QID|PRN|SQ|SC|IM|OD|OS|OU|AM|PM|US|DC|ER|ED|ICU|CT|PT|OT|ST|SOB|NKDA|HS|AC|PC|GI|GU|UA|UK|EU)$/.test(letters) || LEX.isClinical(letters) || LEX.CREDENTIAL_SET.has(letters.toLowerCase())) continue;
      const withSurname = j < toks.length && !used[j] && toks[j].word && (toks[j].cap || toks[j].allcaps) && pNameOkLate(toks[j]) && !toks[j - 1].nlAfter;
      if (withSurname) j++;
      if (j === i + 2 && toks[i + 1].initial) continue; // one initial alone is not enough
      // initials with no surname count only when they close the phrase or a person verb follows ("husband T.J. called")
      if (!withSurname) { const nx = toks[j]; if (nx && !/^[,;:()]$/.test(nx.raw) && !(nx.word && /^(called|calls|states|stated|says|said|is|was|will|here|at|aware|present|drives|driving|visiting|notified|reports|reported|agrees|declined|signed|wants|prefers)$/i.test(nx.core))) continue; }
      addRun(i + 1, j, isHon(p) && /^(dr|doctor)$/i.test(p.core) ? 'NAME_PROVIDER' : 'NAME_OTHER', 'cue:initials', 0.8);
      i = j - 1;
    }
    // Pass B0: credential then name ("RN Joanne Pruett", "NP Delia Marsh, 555-0101", "SW Ines Ortega called")
    for (let i = 0; i + 1 < toks.length; i++) {
      const c = toks[i];
      if (!c.word || !/^(RN|NP|LPN|APRN|CRNP|FNP|PA-C|PharmD|RPh|MSW|LCSW|SW|CM|RD|RDN|CNA|LVN|PT|OT|ST|MD|DO|PA)$/.test(c.core) || used[i + 1] || c.raw.endsWith('.') || c.nlAfter) continue;
      if (/^(PT|OT|ST|MD|DO|PA)$/.test(c.core) && !(i > 0 && (toks[i - 1].word && (LEX.ORG_SUFFIX_SET.has(toks[i - 1].core.toLowerCase()) || /^(the|from|with|by|outside|hospice|home)$/i.test(toks[i - 1].core))))) continue;
      let j = i + 1;
      while (j < toks.length && j - i <= 3 && !used[j] && toks[j].cap && pNameOkLate(toks[j]) && !(j > i + 1 && (endsSentence(toks[j - 1]) || toks[j - 1].nlAfter))) j++;
      if (j - i < 3) continue; // two name words: "RN Joanne" alone could be a unit label
      const nx = toks[j];
      if (nx && nx.word && (LEX.ORG_SUFFIX_SET.has(nx.core.toLowerCase()) || (nx.cap && !endsSentence(toks[j - 1])))) continue;
      // the name closes the phrase: punctuation, the end, or a person verb ("RN Joanne Pruett, 555-0181", "SW Ines Ortega called")
      if (nx && !/^[,()\-–:;.]$/.test(nx.raw) && !(nx.word && /^(called|calls|states|stated|reports|reported|says|said|notified|aware|confirmed|will|is|was|at|from|with|re)$/i.test(nx.core))) continue;
      addRun(i + 1, j, 'NAME_PROVIDER', 'cue:credential', 0.8);
      i = j - 1;
    }
    // Pass B: name + credential (John Smith MD; J. Smith, NP; Smith RN)
    for (let i = 1; i < toks.length; i++) {
      if (!isCred(toks[i]) || used[i]) continue;
      let j = i; const comma = toks[j - 1] && toks[j - 1].raw === ','; if (comma) j--;
      let k = j;
      const nameishB = (t) => isNameish(t, allow) || ((t.cap || t.allcaps) && inLex(t) && !(allow && allow.has(t.core.toLowerCase())));
      while (k > 0 && k > j - 3 && nameishB(toks[k - 1]) && !used[k - 1] && !isRel(toks[k - 1]) && !(k - 1 < j - 1 && endsSentence(toks[k - 1]))) k--;
      if (k >= j) continue;
      // "Next MD visit", "Infusion Triage RN": a field label or a common word alone before a credential is not a name
      if (k === j - 1 && (FIELD_WORD.test(toks[k].core) || COMMON_CAP.has(toks[k].core.toLowerCase()))) continue;
      if (k >= 2 && toks[k - 1].raw === ',' && nameishB(toks[k - 2]) && !used[k - 2] && !toks[k - 2].initial && !isRel(toks[k - 2]) && !endsSentence(toks[k - 2])) k -= 2; // "Gallagher, Bertha NP"
      if (comma && /^(PA|MD)$/.test(toks[i].core)) {
        const before = toks[k - 1];
        const isPlace = LEX.CITY_SET.has(toks[j - 1].core.toLowerCase()) || (before && before.word && /^(in|from|to|near|at|of|into|outside|via)$/i.test(before.core) && !inLex(toks[j - 1]));
        if (isPlace) continue; // "Erie, PA" is a state, handled by the location pass
      }
      addRun(k, j, 'NAME_PROVIDER', 'cue:credential', 0.9);
    }
    // Pass C: relation word then name  (pt's son Mark; daughter, Grace Bell; wife (Mary))
    for (let i = 0; i < toks.length - 1; i++) {
      if (!isRel(toks[i]) || endsSentence(toks[i])) continue;
      let j = i + 1, hops = 0;
      while (j < toks.length && hops < 5 && !endsSentence(toks[j]) && (/^(named|is|was|,|:|\(|and|or|the|her|his|their|pt's|patient's|'s|'s|id|#|no|number|ext|x)$/i.test(toks[j].raw) || /^(’s|'s)$/.test(toks[j].raw) || (toks[j].num && /^\d{1,6}$/.test(toks[j].raw) && hops > 0) || (toks[j].raw === ')' && hops > 0))) { j++; hops++; }
      if (j >= toks.length) continue;
      const relaxedFirst = (toks[j].cap || toks[j].allcaps) && inLex(toks[j]) && !(allow && allow.has(toks[j].core.toLowerCase()));
      if ((isNameish(toks[j], allow) || relaxedFirst) && !isCred(toks[j]) && !isRel(toks[j]) && !isHon(toks[j])) {
        const e = nameRun(j, 3, true);
        if (e > j) addRun(j, e, 'NAME_OTHER', 'cue:relation', 0.85);
      }
    }
    // Pass D: name then relation  (Mark (son); Mark, her son; Grace - daughter)
    for (let i = 0; i < toks.length - 2; i++) {
      if (used[i] || toks[i].initial || endsSentence(toks[i]) || isCred(toks[i])) continue;
      if (!(isNameish(toks[i], allow) || ((toks[i].cap || toks[i].allcaps) && inLex(toks[i]) && !(allow && allow.has(toks[i].core.toLowerCase()))))) continue;
      let j = i + 1, hops = 0;
      while (j < toks.length && hops < 4 && !endsSentence(toks[j]) && /^(,|\(|-|–|—|is|the|her|his|their|pt's|patient's|a|an)$/i.test(toks[j].raw)) { j++; hops++; }
      if (hops > 0 && j < toks.length && isRel(toks[j])) {
        // "Social Work, Dietitian, Chaplain consulted": a Title-Case relation word after a comma, with a name candidate that is
        // not in the name lexicon, is a department list rather than "Mark, her son"
        if (toks[j].cap && toks[j - 1].raw === ',' && !inLex(toks[i])) continue;
        // walk back to include preceding name-ish tokens (First Last) or "Last, First"
        const nameishRelaxed = (t) => isNameish(t, allow) || ((t.cap || t.allcaps) && inLex(t) && !(allow && allow.has(t.core.toLowerCase())));
        let k = i; while (k > 0 && nameishRelaxed(toks[k - 1]) && !used[k - 1] && !endsSentence(toks[k - 1]) && i - k < 2) k--;
        if (k === i && k >= 2 && toks[k - 1].raw === ',' && nameishRelaxed(toks[k - 2]) && !used[k - 2] && !toks[k - 2].initial) k -= 2;
        addRun(k, i + 1, 'NAME_OTHER', 'cue:relation', 0.8);
      }
    }
    // Pass H: "Last, First" with structural evidence. Epic renders every person this way, so a comma pair of
    // capitalized non-clinical words counts as a name when the lexicon or the layout backs it up:
    // a label before (Pt/Patient/Name/RE/Contact), line start, a column gap or pipe beside it, an identifier or
    // date within a few tokens after, or a person verb after. ALL-CAPS pairs need a structural signal, because
    // all-caps notes also hold comma lists ("VOMITING, DIARRHEA").
    const nameWordOk = (t) => t && t.word && (t.cap || t.allcaps) && t.core.length >= 2 && !LEX.isClinical(t.core) && !isRel(t) && !isHon(t) && !isCred(t) && !LEX.STATE_ABBR_SET.has(t.core) && !LEX.ORG_SUFFIX_SET.has(t.core.toLowerCase()) && !LEX.ORG_NAMEWORD_SET.has(t.core.toLowerCase()) && !(allow && allow.has(t.core.toLowerCase())) && !/^(of|and|the|for|from|to|at|in|on|per|with|re|see|no|yes|ok|pt|pts)$/i.test(t.core) && !FIELD_WORD.test(t.core);
    // layout evidence: line or sentence start, a column gap (2+ spaces, tab) or a pipe/bracket column separator
    const gapBefore = (idx) => idx === 0 || toks[idx - 1].nlAfter || endsSentence(toks[idx - 1]) || /^[|\[\]:]$/.test(toks[idx - 1].raw) || /\s{2,}|\t/.test(text.slice(toks[idx - 1].fullEnd, toks[idx].start));
    const gapAfter = (idx) => idx >= toks.length - 1 || toks[idx].nlAfter || /^[|\[\]]$/.test(toks[idx + 1].raw) || /\s{2,}|\t/.test(text.slice(toks[idx].fullEnd, toks[idx + 1].start));
    const PERSON_VERB = /^(called|calling|calls|phoned|states|stated|says|said|reports|reported|requests|requested|prefers|wants|wanted|asked|asks|agreed|agrees|declined|declines|confirmed|confirms|aware|arrived|arriving|verbalized|verbalizes|denies|denied|endorses|notified|refused|refuses|cancelled|canceled|rescheduled|here|present|seen|came|left|wishes|would|texted|emailed|will|is|was|has|needs|tolerated|received|rec'd|presents|presented|c\/o|complains|reporting|checked|checking|signed|consented|voiced|understands|unable|able|ambulated|ambulating|transferred|discharged|admitted|returned|returning|scheduled|rescheduled|cancelled|no-showed|noshowed|dnka|lvm|contacted|reached|spoke|spoken|re)$/i;
    const idOrDateAfter = (idx, max) => {
      for (let q = idx; q < toks.length && q - idx < max; q++) {
        const t = toks[q];
        if (t.num && (t.raw.replace(/\D/g, '').length >= 6 || /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(text.slice(t.start, t.start + 10)) || /^\d{4}-\d{2}-\d{2}/.test(text.slice(t.start, t.start + 10)))) return true;
        if (t.raw === '|') return true;
        if (t.word && /^(mrn|dob|acct|csn|mr|id)$/i.test(t.core)) return true;
      }
      return false;
    };
    const labelBefore = (idx) => {
      for (let q = idx - 1; q >= 0 && idx - q <= 3; q--) {
        const t = toks[q];
        if (t.raw === ':' || t.raw === '#') continue;
        if (t.word && /^(pt|pts|patient|patients|name|re|regarding|contact|caller|for|from|to|attn|cc|w|with|w\/|per|by|and|or)$/i.test(t.core)) return true;
        if (t.raw === '(' || t.raw === '|' || t.raw === '-' || t.raw === '–' || t.raw === ',') return q > 0 && labelBefore(q);
        return false;
      }
      return idx === 0;
    };
    for (let i = 0; i + 2 < toks.length; i++) {
      const last = toks[i], comma = toks[i + 1], first = toks[i + 2];
      if (used[i] || used[i + 2] || comma.raw !== ',' || !nameWordOk(last) || !nameWordOk(first) || last.initial) continue;
      if (last.nlAfter) continue; // "Last,\nFirst" across lines is a list, not a name
      let j = i + 3;
      // optional middle initial / middle name
      if (j < toks.length && !used[j] && (toks[j].initial || (toks[j].cap && toks[j].core.length === 1)) && !toks[j - 1].nlAfter) j++;
      else if (j < toks.length && !used[j] && toks[j].cap && nameWordOk(toks[j]) && !toks[j - 1].nlAfter && (inLex(toks[j]) && !LEX.isAmbiguous(toks[j].core)) && !(j + 1 < toks.length && toks[j + 1].raw === ',')) j++;
      const bothLex = (LEX.isSurname(last.core) && !LEX.isAmbiguous(last.core) && LEX.isFirstName(first.core)) || (LEX.isFirstName(first.core) && !LEX.isAmbiguous(first.core) && LEX.isSurname(last.core));
      const allCaps = last.allcaps && first.allcaps;
      let signals = 0, structural = 0;
      if (LEX.isSurname(last.core) && !LEX.isAmbiguous(last.core)) signals++;
      if (LEX.isFirstName(first.core) && !LEX.isAmbiguous(first.core)) signals++;
      if (labelBefore(i)) { signals++; structural++; }
      if (gapBefore(i) && gapAfter(j - 1)) { signals++; structural++; }
      else if (gapBefore(i) || gapAfter(j - 1)) { signals += 0.5; structural += 0.5; }
      if (idOrDateAfter(j, 4)) { signals++; structural++; }
      if (j < toks.length && toks[j].word && PERSON_VERB.test(toks[j].core) && !toks[j].cap) { signals++; structural++; }
      // another list item right after ("Keytruda, Opdivo, Yervoy", "Ambulation, Toileting and Feeding") is a list, not a name
      if (j + 1 < toks.length && (toks[j].raw === ',' || toks[j].raw === '&' || (toks[j].word && /^(and|or)$/i.test(toks[j].core))) && toks[j + 1].word && (toks[j + 1].cap || toks[j + 1].allcaps) && !isCred(toks[j + 1]) && !isRel(toks[j + 1])) continue;
      const ok = bothLex || (allCaps ? structural >= 1.5 && signals >= 2 : signals >= 2);
      if (!ok) continue;
      addRun(i, j, 'NAME_OTHER', 'cue:last-first', 0.7);
      i = j - 1;
    }
    // Pass H2: "First Last" (or "Last, First" already used) immediately before an identifier or a dated DOB
    // ("Mireille Papadakis 00234567 05/09/1955"): the layout of a pasted census line.
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i], b = toks[i + 1];
      if (used[i] || used[i + 1] || !nameWordOk(a) || !nameWordOk(b) || a.initial || a.nlAfter) continue;
      if (!(a.cap || a.allcaps) || !(b.cap || b.allcaps)) continue;
      let j = i + 2;
      if (j < toks.length && !used[j] && nameWordOk(toks[j]) && toks[j].cap && !toks[j - 1].nlAfter && inLex(toks[j]) && !isCred(toks[j])) j++;
      const nxt = toks[j];
      if (!nxt || toks[j - 1].nlAfter) continue;
      const idNext = nxt.num && nxt.raw.replace(/\D/g, '').length >= 6 && !/^\d{10}$/.test(nxt.raw) && !/[-.]\d{3}/.test(text.slice(nxt.start, nxt.start + 12));
      const dobNext = nxt.num && /^\d{1,2}[\/\-.]\d{1,2}[\/\-.](\d{4}|\d{2})\b/.test(text.slice(nxt.start, nxt.start + 10)) && (i === 0 || gapBefore(i) || (toks[i - 1].word && /^(pt|patient|name|re)$/i.test(toks[i - 1].core)) || idOrDateAfter(j + 1, 3));
      const mrnLabelNext = nxt.word && /^(mrn|dob|acct|csn)$/i.test(nxt.core);
      if (!(idNext || dobNext || mrnLabelNext)) continue;
      // at least one token should look like a name (lexicon) or the pair must be at a line start / after a label
      const lexHit = inLex(a) || inLex(b) || (j > i + 2 && inLex(toks[j - 1]));
      const labelled = (i > 0 && toks[i - 1].word && /^(pt|patient|name|re)$/i.test(toks[i - 1].core)) || (i > 0 && toks[i - 1].raw === ':');
      if (!lexHit && !labelled && !(idNext && gapBefore(i))) continue;
      addRun(i, j, 'NAME_OTHER', 'cue:census-line', 0.65);
      i = j - 1;
    }
    // Pass C2: an alias the patient goes by ("goes by Majo", "aka Beto", "prefers to be called Kasia", "nickname Sal")
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      let j = -1;
      if (t.word && /^(aka|nickname|nick)$/i.test(t.core)) j = i + 1;
      else if (t.word && /^(goes|known)$/i.test(t.core) && toks[i + 1].word && /^(by|as)$/i.test(toks[i + 1].core)) j = i + 2;
      else if (t.word && /^(prefers?|likes?|wants?)$/i.test(t.core) && i + 4 < toks.length && /^(to)$/i.test(toks[i + 1].core) && /^(be)$/i.test(toks[i + 2].core) && /^(called|addressed)$/i.test(toks[i + 3].core)) j = i + 4;
      // "call her Winnie", "calls him Big Al", "we call them Sam", "prefers Kasia", "please call me Bea"
      else if (t.word && /^(call|calls|called|calling|address|addresses|addressed)$/i.test(t.core) && toks[i + 1].word && /^(her|him|them|me|pt|patient)$/i.test(toks[i + 1].core)) j = i + 2;
      else if (t.word && /^(prefers|preferred)$/i.test(t.core) && toks[i + 1].word && toks[i + 1].cap) j = i + 1;
      else if (t.word && /^(preferred|prefers|nickname|alias|aka)$/i.test(t.core) && toks[i + 1].raw === ':' && i + 2 < toks.length && toks[i + 2].word && toks[i + 2].cap) j = i + 2;
      else if (t.word && /^(name)$/i.test(t.core) && i > 0 && /^(preferred|nick|pet)$/i.test(toks[i - 1].core)) j = i + 1;
      if (j < 0 || j >= toks.length) continue;
      if (toks[j].raw === ':' || toks[j].raw === '"' || toks[j].raw === "'" || toks[j].raw === '“') j++;
      if (j >= toks.length || used[j] || !toks[j].word || !(toks[j].cap || toks[j].allcaps) || LEX.isClinical(toks[j].core) || isRel(toks[j]) || isHon(toks[j]) || (allow && allow.has(toks[j].core.toLowerCase()))) continue;
      addRun(j, j + 1, 'NAME_OTHER', 'cue:alias', 0.7);
    }
    // Pass P: a name joined by lower-case particles (Pieter van der Berg, Maria de la Cruz Villanueva, Abdulrahman bin Khalid
    // al-Harbi). "Capitalized particle Capitalized" is a personal name in clinical text; the run extends over the capitalized
    // name-ish words on either side.
    const pNameOk = (t) => t && t.word && (t.cap || t.allcaps) && t.core.length >= 2 && !LEX.isClinical(t.core) && !isRel(t) && !isHon(t) && !isCred(t) && !FIELD_WORD.test(t.core) && !LEX.ORG_SUFFIX_SET.has(t.core.toLowerCase()) && (!LEX.ORG_NAMEWORD_SET.has(t.core.toLowerCase()) || LEX.isFirstName(t.core)) && !COMMON_CAP.has(t.core.toLowerCase()) && !LEX.STATE_ABBR_SET.has(t.core) && !(allow && allow.has(t.core.toLowerCase()));
    for (let i = 0; i + 2 < toks.length; i++) {
      if (!pNameOk(toks[i]) || endsSentence(toks[i])) continue;
      let j = i + 1, parts = 0;
      while (j < toks.length && parts < 3 && toks[j].word && !toks[j].cap && !toks[j].allcaps && NAME_PARTICLE.test(toks[j].core) && !/^(y|o|st|do|la|le|de)$/i.test(toks[j].core) || (j < toks.length && parts < 3 && toks[j].word && /^(de|la|le|do)$/.test(toks[j].core) && j + 1 < toks.length && (pNameOk(toks[j + 1]) || NAME_PARTICLE.test(toks[j + 1].core)))) { if (toks[j].nlAfter) break; j++; parts++; }
      if (!parts || j >= toks.length || !pNameOk(toks[j]) || toks[j - 1].nlAfter) continue;
      const after = toks[j + 1];
      if (after && after.word && (LEX.EPONYM_FOLLOW.has(after.core.toLowerCase()) || MED_SUFFIX.test(after.core))) continue; // de Quervain thyroiditis
      let k = i; while (k > 0 && i - k < 2 && pNameOk(toks[k - 1]) && !endsSentence(toks[k - 1]) && !toks[k - 1].nlAfter) k--;
      let e = j + 1;
      while (e < toks.length && e - j <= 3 && !endsSentence(toks[e - 1]) && !toks[e - 1].nlAfter) {
        if (pNameOk(toks[e])) { e++; continue; }
        if (toks[e].word && NAME_PARTICLE.test(toks[e].core) && !toks[e].cap && e + 1 < toks.length && pNameOk(toks[e + 1])) { e += 2; continue; }
        break;
      }
      spans.push({ start: toks[k].start, end: toks[e - 1].end, type: 'NAME_OTHER', source: 'cue:particle', conf: 0.8, text: text.slice(toks[k].start, toks[e - 1].end) });
      for (let q = k; q < e; q++) used[q] = true;
      i = e - 1;
    }
    // Pass V: a Vietnamese name, surname first with a middle name (Nguyễn Thị Hồng Nhung, TRAN VAN MINH, Le Huu Phuoc):
    // the family name and the middle name together mark it, with one or two given names after them
    const VN_MIDDLE = /^(?:thi|thị|van|văn|huu|hữu|duc|đức|dinh|đình|ngoc|ngọc|xuan|xuân|quang|kim|bao|bảo)$/i;
    for (let i = 0; i + 2 < toks.length; i++) {
      const a = toks[i], mid = toks[i + 1];
      if (used[i] || used[i + 1] || !a.word || !(a.cap || a.allcaps) || !mid.word || !(mid.cap || mid.allcaps) || !VN_MIDDLE.test(mid.core) || a.nlAfter || mid.nlAfter || endsSentence(a)) continue;
      if (!(LEX.isSurname(a.core) || /^(?:thi|thị|văn)$/i.test(mid.core)) || LEX.isClinical(a.core) || COMMON_CAP.has(a.core.toLowerCase()) || isHon(a) || isRel(a) || isCred(a)) continue;
      let e = i + 2;
      // given-name syllables may collide with short clinical abbreviations (Thu, Ha, Mai): the family + middle name pair is cue enough
      const vnGiven = (t) => pNameOkLate(t) || (t.word && (t.cap || t.allcaps) && t.core.length <= 4 && LEX.isClinical(t.core) && !COMMON_CAP.has(t.core.toLowerCase()) && !isCred(t) && !LEX.STATE_ABBR_SET.has(t.core));
      while (e < toks.length && e - i < 4 && !used[e] && toks[e].word && (toks[e].cap || toks[e].allcaps) && vnGiven(toks[e]) && !endsSentence(toks[e - 1]) && !toks[e - 1].nlAfter) e++;
      if (e === i + 2) continue;
      addRun(i, e, 'NAME_OTHER', 'cue:vn-name', 0.8); i = e - 1;
    }
    // Pass I: "First Last" at a sentence start, a line start or after a label, followed by a person verb
    // ("Grace Bishop called", "Pt Bernadette Kowalczyk passed away", "Address update: Theodora Lindqvist moved to"),
    // or after a label and before a comma/bracket ("Pharm verify: Simone Addison, hx ..."), or at a line start before a
    // colon and contact details ("Ifeoma Nwankwo-Bello: home 555 012 4471"). A clinical eponym counts as a surname here when
    // nothing clinical follows it (Addison, not Addison's disease).
    const PERSON_VERB_I = /^(called|calling|calls|phoned|states|stated|says|said|reports|reported|requests|requested|prefers|wants|wanted|asked|asks|agreed|agrees|declined|declines|confirmed|confirms|arrived|arriving|verbalized|denies|denied|endorses|refused|refuses|cancelled|canceled|rescheduled|came|left|wishes|would|texted|emailed|will|is|was|has|had|needs|tolerated|received|presents|presented|complains|signed|consented|voiced|understands|ambulated|transferred|discharged|admitted|returned|passed|died|expired|moved|lives|lived|resides|relocated|gets|got|takes|took|went|goes|feels|felt|reported|missed|declined|requires|required|completed|started|finished|brought|drove|walked|sees|saw|did|does|can|cannot|could|should|may|might|must|aware|informed|notified|agreeable|educated|instructed|updated|tolerating|doing|feeling|here|present|arrived)$/i;
    const iNameOk = (t, second) => pNameOk(t) || (second && t && t.word && t.cap && LEX.isClinical(t.core) && (LEX.isSurname(t.core) || LEX.isFirstName(t.core)) && !LEX.isAmbiguous(t.core) && !/['’]s$/i.test(t.raw));
    for (let i = 0; i + 2 < toks.length; i++) {
      if (used[i] || used[i + 1]) continue;
      const a = toks[i], b = toks[i + 1];
      // a clinical eponym that is also a given name (Addison, Graves, Wilson) starts a name only after a patient label or
      // an honorific, and never when the next word is clinical ("Pt Addison Graves, 34F" but not "Addison's disease")
      const labelPrev = i > 0 && ((toks[i - 1].word && /^(pt|patient)$/i.test(toks[i - 1].core) && !/['’]s$/.test(toks[i - 1].raw)) || isHon(toks[i - 1]));
      const eponymFirst = labelPrev && a.cap && LEX.isClinical(a.core) && (LEX.isFirstName(a.core) || LEX.isSurname(a.core)) && !LEX.isAmbiguous(a.core) && !/['’]s?$/.test(a.raw) && !(b.word && LEX.EPONYM_FOLLOW.has(b.core.toLowerCase()));
      if (!a.cap || !(pNameOk(a) || eponymFirst) || !b.cap || a.nlAfter || endsSentence(a)) continue;
      let j = i + 1;
      if (!iNameOk(b, true)) continue;
      j = i + 2;
      if (j < toks.length && !used[j] && toks[j].cap && pNameOk(toks[j]) && !endsSentence(toks[j - 1]) && !toks[j - 1].nlAfter && !iNameOk(b, false)) continue; // eponym in the middle of a longer run
      if (j < toks.length && !used[j] && toks[j].cap && pNameOk(toks[j]) && !endsSentence(toks[j - 1]) && !toks[j - 1].nlAfter) j++; // middle name
      const prev = i > 0 ? toks[i - 1] : null;
      const lineStart = i === 0 || prev.nlAfter;
      const sentStart = lineStart || endsSentence(prev);
      const ptLabel = prev && prev.word && /^(pt|patient|pt\.)$/i.test(prev.core) && !/['’]s$/.test(prev.raw);
      const colonLabel = prev && (prev.raw === ':' || prev.raw === '-' || prev.raw === '–');
      const nxt = toks[j], nxt2 = toks[j + 1];
      if (!nxt) continue;
      const verbAfter = nxt.word && !nxt.cap && !nxt.allcaps && PERSON_VERB_I.test(nxt.core) && !toks[j - 1].nlAfter;
      const punctAfter = (nxt.raw === ',' || nxt.raw === '(' || (ptLabel && nxt.raw === ':')) && !toks[j - 1].nlAfter;
      const contactAfter = nxt.raw === ':' && lineStart && toks.slice(j + 1, j + 5).some((t) => (t.word && /^(home|cell|work|mobile|phone|ph|tel|fax|email|text|c|h|w)$/i.test(t.core)) || (t.num && /^\(?\d{3}/.test(text.slice(t.start, t.start + 4))));
      const lexHit = inLex(a) || inLex(b) || (j > i + 2 && inLex(toks[j - 1]));
      let ok = false;
      const plainWords = toks.slice(i, j).some((t) => NONNAME_END.test(t.core) && !inLex(t));
      if ((ptLabel || colonLabel || sentStart) && verbAfter && (lexHit || ptLabel || ((colonLabel || (a.core.length >= 3 && b.core.length >= 3)) && !plainWords))) ok = true;
      else if ((ptLabel || colonLabel) && punctAfter && (ptLabel || !plainWords)) ok = true;
      else if (contactAfter) ok = true;
      if (!ok) continue;
      addRun(i, j, 'NAME_OTHER', 'cue:sentence-name', 0.7);
      i = j - 1;
    }
    // Pass S: a sign-off ("Thank you, Margarita", "Thanks, Bea", "Sincerely, Tom") and a dash signature at the end of a
    // message ("- Bobby", "— Marisol (marisol@...)")
    for (let i = 0; i + 1 < toks.length; i++) {
      let j = -1;
      if (toks[i].word && /^(thanks|thx|sincerely|regards|cheers|love|best|respectfully|cordially|warmly)$/i.test(toks[i].core) && toks[i + 1].raw === ',') j = i + 2;
      else if (toks[i].word && /^thank$/i.test(toks[i].core) && i + 2 < toks.length && /^you$/i.test(toks[i + 1].core) && toks[i + 2].raw === ',') j = i + 3;
      else if (/^[-–—~]$/.test(toks[i].raw) && i > 0 && (endsSentence(toks[i - 1]) || toks[i - 1].nlAfter || /^[.!?)]$/.test(toks[i - 1].raw))) j = i + 1;
      if (j < 0 || j >= toks.length || used[j] || !toks[j].cap || !pNameOk(toks[j])) continue;
      let e = j + 1;
      while (e < toks.length && e - j < 3 && !used[e] && toks[e].cap && pNameOk(toks[e]) && !toks[e - 1].nlAfter) e++;
      const end = toks[e];
      const closes = !end || toks[e - 1].nlAfter || end.raw === '(' || /^[.!]$/.test(end.raw) && (e + 1 >= toks.length || toks[e].nlAfter);
      if (!closes) continue;
      if (/^[-–—~]$/.test(toks[i].raw) && !(inLex(toks[j]) || !end || end.raw === '(' || toks[e - 1].nlAfter)) continue;
      addRun(j, e, 'NAME_OTHER', 'cue:signoff', 0.7);
    }
    // Pass M: the sender of a message or call ("MyChart message from MARGARITA ELENA RUIZ CABRERA", "voicemail from Teodoro Ruiz")
    for (let i = 0; i + 2 < toks.length; i++) {
      if (!toks[i].word || !/^(message|msg|mychart|email|e-mail|call|voicemail|vm|text|letter|note|fax|request|reply|response)$/i.test(toks[i].core) || !toks[i + 1].word || !/^from$/i.test(toks[i + 1].core)) continue;
      let j = i + 2, e = j;
      while (e < toks.length && e - j < 4 && !used[e] && (toks[e].cap || toks[e].allcaps) && pNameOk(toks[e]) && !(e > j && (endsSentence(toks[e - 1]) || toks[e - 1].nlAfter))) {
        e++;
        if (e < toks.length && toks[e].word && NAME_PARTICLE.test(toks[e].core) && !toks[e].cap && e + 1 < toks.length && pNameOk(toks[e + 1])) e++;
      }
      if (e === j) continue;
      if (e - j === 1 && !inLex(toks[j])) continue;
      addRun(j, e, 'NAME_OTHER', 'cue:sender', 0.75);
      i = e - 1;
    }
    // Pass K: a companion or carrier ("sent home with Lucia Marsh", "accompanied by Ines Ortega", "picked up by Tavi Rourke")
    for (let i = 0; i + 2 < toks.length; i++) {
      const t = toks[i], n = toks[i + 1];
      let j = -1;
      if (t.word && /^(accompanied|escorted|driven|brought|transported|picked|dropped|sent|discharged|went|released|left|stays|staying)$/i.test(t.core)) {
        let q = i + 1;
        if (toks[q] && toks[q].word && /^(up|off|in|home|out)$/i.test(toks[q].core)) q++;
        if (toks[q] && toks[q].word && /^(home)$/i.test(toks[q].core)) q++;
        if (toks[q] && toks[q].word && /^(by|with)$/i.test(toks[q].core)) j = q + 1;
      }
      if (j < 0 || j >= toks.length || used[j] || !toks[j].cap || !pNameOk(toks[j])) continue;
      let e = j + 1;
      while (e < toks.length && e - j < 3 && !used[e] && toks[e].cap && pNameOk(toks[e]) && !endsSentence(toks[e - 1]) && !toks[e - 1].nlAfter) e++;
      if (e - j === 1 && !inLex(toks[j])) continue;
      if (toks[e] && toks[e].word && (LEX.ORG_SUFFIX_SET.has(toks[e].core.toLowerCase()) || (!toks[e].cap && !toks[e].allcaps && !/^(for|to|at|on|in|and|from|after|before|today|tonight|tomorrow|until|via)$/i.test(toks[e].core) && !/^[.,;:()]$/.test(toks[e].raw)))) continue; // "with Pump Disconnect kit"
      if (toks.slice(j, e).some((t) => NONNAME_END.test(t.core) && !inLex(t))) continue;
      addRun(j, e, 'NAME_OTHER', 'cue:companion', 0.7);
      i = e - 1;
    }
    // Pass E: lexicon names without cue
    for (let i = 0; i < toks.length; i++) {
      if (used[i]) continue;
      const t = toks[i];
      if (!(t.cap || t.allcaps) || t.initial) continue;
      if (!isNameish(t, allow)) continue;
      if (!inLex(t)) continue;
      if (LEX.CITY_SET.has(t.core.toLowerCase()) && i > 0 && (toks[i - 1].raw === ',' || (toks[i - 1].word && /^(in|from|to|at|near|of|via|into|outside)$/i.test(toks[i - 1].core))) && !(i + 1 < toks.length && toks[i + 1].word && (inLex(toks[i + 1]) || isCred(toks[i + 1])) && !LEX.CITY_SET.has(toks[i + 1].core.toLowerCase()))) { addRun(i, i + 1, 'LOCATION', 'cue:city', 0.6); continue; }
      const amb = LEX.isAmbiguous(t.core) || (t.allcaps && t.core.length <= 4);
      // find run of adjacent lexicon/name-ish tokens
      let j = i + 1;
      while (j < toks.length && j - i < 3 && !used[j] && isNameish(toks[j], allow) && !LEX.ORG_SUFFIX_SET.has(toks[j].core.toLowerCase()) && !endsSentence(toks[j - 1]) && (inLex(toks[j]) || toks[j].initial || (toks[j].cap && !LEX.isAmbiguous(toks[j].core) && j === i + 1 && !t.allcaps))) j++;
      // a first name followed by a surname that is also a clinical eponym ("Rosalind Graves (MRN ...)", "Simone Addison, hx"),
      // when nothing clinical follows the eponym (Graves disease, Addison's)
      if (j === i + 1 && LEX.isFirstName(t.core) && !LEX.isAmbiguous(t.core) && !endsSentence(t) && !t.nlAfter && j < toks.length && !used[j] && toks[j].cap && LEX.isClinical(toks[j].core) && (LEX.isSurname(toks[j].core) || LEX.isFirstName(toks[j].core)) && !LEX.isAmbiguous(toks[j].core) && !/['’]s?$/.test(toks[j].raw) && !(j + 1 < toks.length && toks[j + 1].word && (LEX.EPONYM_FOLLOW.has(toks[j + 1].core.toLowerCase()) || LEX.isClinical(toks[j + 1].core)))) j++;
      const run = toks.slice(i, j);
      const unambiguousCount = run.filter((x) => inLex(x) && !LEX.isAmbiguous(x.core)).length;
      if (!amb) { addRun(i, j, 'NAME_OTHER', 'lexicon', 0.7); i = j - 1; continue; }
      // ambiguous: need a second token in the run that is in the lexicon and unambiguous
      if (run.length >= 2 && unambiguousCount >= 1) { addRun(i, j, 'NAME_OTHER', 'lexicon', 0.6); i = j - 1; }
    }
    // Pass E2: ambiguous lexicon names with a contact-verb cue before and a contact context after
    for (let i = 1; i < toks.length - 1; i++) {
      const t = toks[i];
      if (used[i] || !t.cap || !inLex(t) || !LEX.isAmbiguous(t.core) || LEX.isClinical(t.core) || (allow && allow.has(t.core.toLowerCase()))) continue;
      const prev = toks[i - 1], next = toks[i + 1];
      const verbBefore = prev.word && /^(called|call|spoke|contact|contacted|reached|notified|notify|w|with|reach|text|texted|emailed|paged|per)$/i.test(prev.core) || (prev.raw === '/' && i >= 2 && /^w$/i.test(toks[i - 2].core));
      const contextAfter = next && (/^(at|@|re|about|who|phone|cell|mobile|home|work|states|stated|says|said|reports|reported|confirmed|aware|agrees|declined|requests|requested)$/i.test(next.core) || next.raw === '(' || next.raw === ',' || /^\(?\d{3}/.test(text.slice(next.start, next.start + 4)));
      if (verbBefore && contextAfter) addRun(i, i + 1, 'NAME_OTHER', 'cue:verb', 0.6);
    }
    // Pass E3: "Called <Anyname> at <phone>" — strong enough to accept an out-of-lexicon name
    for (let i = 1; i < toks.length - 2; i++) {
      const t = toks[i];
      // a month that is also a first name (June, May, April) is a person when someone called her at a phone number
      const monthName = LEX.isClinical(t.core) && t.cap && LEX.isFirstName(t.core);
      if (used[i] || !(t.cap || t.allcaps) || (LEX.isClinical(t.core) && !monthName) || (allow && allow.has(t.core.toLowerCase())) || isRel(t) || isHon(t) || isCred(t)) continue;
      const prev = toks[i - 1];
      if (!(prev.word && /^(called|call|spoke|contacted|reached|notified|paged|texted|emailed)$/i.test(prev.core))) continue;
      const rest = text.slice(toks[i + 1].start, toks[i + 1].start + 24);
      if (/^(?:at|@|on|cell|home|ph|phone|#|:)?\s*\(?\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}/i.test(rest)) addRun(i, i + 1, 'NAME_OTHER', 'cue:verb', 0.6);
    }
    // Pass L: a town named next to a person or a residence ("PCP is Dr. Tran Van Minh in Pocasset.", "Lives at Bayview Manor
    // rm 214, Wareham."): the capitalized word(s) closing the phrase are a place, unless they are a department, a system or
    // clinical vocabulary
    const placeOk = (t) => t && t.word && t.cap && !used[toks.indexOf(t)] && !LEX.isClinical(t.core) && !COMMON_CAP.has(t.core.toLowerCase()) && !LEX.ORG_SUFFIX_SET.has(t.core.toLowerCase()) && !FIELD_WORD.test(t.core) && !isRel(t) && !isHon(t) && !isCred(t) && !monthIndex(t.core) && !/^(?:epic|mychart|cerner|meditech|athena|teams|zoom|person|writing|spanish|english|french|chinese|arabic|russian|portuguese|vietnamese|korean|general|private|public|network|system|area|town|county)$/i.test(t.core) && !(allow && allow.has(t.core.toLowerCase()));
    const closes = (e) => e >= toks.length || endsSentence(toks[e - 1]) || /^[.;,)]$/.test(toks[e].raw);
    const nameEnds = new Set(spans.filter((x) => COARSE(x.type) === 'NAME').map((x) => x.end));
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i];
      if (!t.word || !/^(in|from|of)$/.test(t.core) || i === 0 || !nameEnds.has(toks[i - 1].end) || endsSentence(toks[i - 1])) continue;
      let e = i + 1; while (e < toks.length && e - i <= 2 && placeOk(toks[e]) && !(e > i + 1 && endsSentence(toks[e - 1]))) e++;
      if (e === i + 1 || !closes(e)) continue;
      addRun(i + 1, e, 'LOCATION', 'cue:place', 0.6); i = e - 1;
    }
    for (let i = 0; i < toks.length; i++) {
      const sentStart = i === 0 || endsSentence(toks[i - 1]);
      if (!sentStart || !toks[i].word || !/^(lives|living|resides|residing|moved|staying|stays|address|addr)$/i.test(toks[i].core)) continue;
      let e = i + 1; while (e < toks.length && !endsSentence(toks[e - 1]) && e - i < 20) e++; // sentence end (exclusive)
      // the sentence ends ", Town." / ", Town Name."
      let q = e; while (q > i + 1 && placeOk(toks[q - 1]) && e - q < 2) q--;
      if (q === e || q < 2 || toks[q - 1].raw !== ',') continue;
      // the residence is named before the town ("at Bayview Manor rm 214, Wareham"), not a description ("alone, Independent")
      if (!toks.slice(i + 1, q - 1).some((t) => t.word && /^(at|in|on|near)$/i.test(t.core)) || !toks.slice(i + 1, q - 1).some((t) => t.num || (t.word && t.cap))) continue;
      addRun(q, e, 'LOCATION', 'cue:place', 0.6); i = e - 1;
    }
    // Pass G2: preposition + known city or state name  (lives in Rochester; moved to Florida)
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i];
      if (!t.word || !/^(in|from|to|at|near|of|via|into|outside)$/i.test(t.core)) continue;
      const n = toks[i + 1];
      if (!(n.cap || n.allcaps) || used[i + 1]) continue;
      const two = i + 2 < toks.length ? `${n.core} ${toks[i + 2].core}`.toLowerCase() : '';
      if (LEX.STATE_NAME_SET.has(two)) { used[i + 1] = used[i + 2] = true; spans.push({ start: n.start, end: toks[i + 2].end, type: 'LOCATION', source: 'cue:state', conf: 0.7, text: text.slice(n.start, toks[i + 2].end) }); continue; }
      if (LEX.STATE_NAME_SET.has(n.core.toLowerCase()) && !LEX.isClinical(n.core)) { used[i + 1] = true; spans.push({ start: n.start, end: n.end, type: 'LOCATION', source: 'cue:state', conf: 0.65, text: n.core }); continue; }
      if (LEX.CITY_SET.has(n.core.toLowerCase()) && !LEX.isClinical(n.core)) {
        let e = i + 2; while (e < toks.length && toks[e].cap && !used[e] && LEX.CITY_SET.has(toks[e].core.toLowerCase())) e++;
        for (let q = i + 1; q < e; q++) used[q] = true;
        spans.push({ start: n.start, end: toks[e - 1].end, type: 'LOCATION', source: 'cue:city', conf: 0.6, text: text.slice(n.start, toks[e - 1].end) });
        continue;
      }
    }
    return spans;
  }

  // ---------------------------------------------------------------------
  // 3c. Census spans
  // ---------------------------------------------------------------------
  function censusSpans(text, census, rowPatientKey, rowExtraKeys) {
    const spans = [];
    if (!census || !census.regex) return spans;
    const re = census.regex; re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      const hit = census.lookup.get(m[0].toLowerCase());
      if (!hit) continue;
      if (hit.exactCase && !/^[A-Z]/.test(m[0])) continue;
      const own = rowPatientKey && hit.entities.includes(rowPatientKey);
      const ownExtra = !own && rowExtraKeys ? rowExtraKeys.find((k) => hit.entities.includes(k)) : null;
      if (hit.rowScoped && !own && !ownExtra) {
        // another patient's given name in this row ("same day as Tobias", "Barnaby asked for ..."): it is still a person's
        // name, so it is hidden as a third party; only a word-name or clinical word (May, Will, Grey) stays row-scoped
        if (hit.type === 'NAME_PATIENT' && /^[A-Z][a-z'’\-]{2,}$/.test(m[0]) && !LEX.isAmbiguous(m[0]) && !LEX.isClinical(m[0]) && !monthIndex(m[0]) && !COMMON_CAP.has(m[0].toLowerCase())) {
          const after = text.slice(m.index + m[0].length).match(/^(?:['’]s?)?\s+([A-Za-z]+)/);
          if (!(after && LEX.EPONYM_FOLLOW.has(after[1].toLowerCase()))) spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'census', text: m[0], conf: 0.8 });
        }
        continue;
      }
      const entity = own ? rowPatientKey : ownExtra || hit.entities[0];
      let start = m.index, end = m.index + m[0].length, type = hit.type;
      if (type === 'NAME_PATIENT') {
        const p = census.patient ? census.patient(entity) : census.patients.get(entity);
        // a clinical eponym that is also the patient's surname stays clinical when the next word says so (Grey Turner sign)
        const after = text.slice(end).match(/^(?:['’]s?)?\s+([A-Za-z]+)/); // also "Bell's palsy", "Graves' disease"
        if ((LEX.isClinical(m[0]) || LEX.isAmbiguous(m[0])) && after && LEX.EPONYM_FOLLOW.has(after[1].toLowerCase())) continue;
        // a surname that is one half of a hyphenated compound (Haddad-Khalil, Wisniewski-Kaminski): take the whole compound
        while (end < text.length && text[end] === '-' && /[A-Za-z]/.test(text[end + 1] || '')) { const mm = text.slice(end + 1).match(/^[A-Za-z'’]+/); end += 1 + mm[0].length; }
        while (start > 0 && text[start - 1] === '-' && /[A-Za-z]/.test(text[start - 2] || '')) { const mm = text.slice(0, start - 1).match(/[A-Za-z'’]+$/); start -= 1 + mm[0].length; }
        let relative = false;
        if (p && p.ownTokens) {
          const toks = text.slice(start, end).toLowerCase().split(/[^a-z'’]+/).filter(Boolean);
          relative = toks.some((t) => !p.ownTokens.has(t) && !(t.length === 1 && [...p.ownTokens].some((o) => o[0] === t)));
        }
        if (relative) { spans.push({ start, end, type: 'NAME_OTHER', source: 'census', relative: entity, text: text.slice(start, end), conf: 0.9, ownTokens: p.ownTokens }); continue; }
        spans.push({ start, end, type, source: 'census', entity, text: text.slice(start, end), conf: 1, ownTokens: p && p.ownTokens });
        continue;
      }
      spans.push({ start, end, type, source: 'census', entity, text: m[0], conf: 1 });
    }
    if (census.mrnNorm && census.mrnNorm.size) {
      // tokens that are MRNs with OCR confusions (O for 0, l for 1, S for 5 ...)
      const idRe = /(?<![\w\/\-.:])[A-Z]{0,2}[0-9OIlSB]{6,10}(?![\w\/\-.:])/g; let k;
      while ((k = idRe.exec(text))) {
        if (/^\d+$/.test(k[0]) && census.lookup.has(k[0].toLowerCase())) continue; // exact match already handled
        const ent = census.mrnNorm.get(mrnKeyOf(k[0]));
        if (ent && (k[0].match(/\d/g) || []).length >= 4) spans.push({ start: k.index, end: k.index + k[0].length, type: 'MRN', source: 'census', entity: ent, text: k[0], conf: 0.9 });
      }
      // a census MRN written with internal spaces or hyphens ("0041 2345", "0041-2345"): compare digits only
      const splitRe = /(?<![\w\/\-.:])\d{2,7}(?:[ \-]\d{2,7}){1,3}(?![\w\/\-:]|\.\d)/g; let sk;
      while ((sk = splitRe.exec(text))) {
        const ent = census.mrnNorm.get(mrnKeyOf(sk[0].replace(/[ \-]/g, '')));
        if (ent) spans.push({ start: sk.index, end: sk.index + sk[0].length, type: 'MRN', source: 'census', entity: ent, text: sk[0], conf: 0.9 });
      }
    }
    return spans;
  }

  // ---------------------------------------------------------------------
  // 4. Overlap resolution and merging
  // ---------------------------------------------------------------------
  function resolveSpans(spans) {
    const sorted = spans.slice().sort((a, b) => (TYPES[b.type].pri - TYPES[a.type].pri) || ((b.end - b.start) - (a.end - a.start)) || (a.start - b.start));
    const kept = [];
    for (const s of sorted) {
      if (s.end <= s.start) continue;
      const hits = kept.filter((k) => s.start < k.end && k.start < s.end);
      if (!hits.length) { kept.push(s); continue; }
      // An organization/address/location/email/url/id that wholly contains name spans replaces them
      // (St. Mary's Hospital; rosalba.m@gmail.com must not become Idris.m@gmail.com).
      if (/^(ORG|ADDRESS|LOCATION|EMAIL|URL|ID_OTHER|PHONE)$/.test(s.type) && hits.every((k) => COARSE(k.type) === 'NAME' && k.start >= s.start && k.end <= s.end)) {
        for (const h of hits) kept.splice(kept.indexOf(h), 1);
        kept.push(s); continue;
      }
      // A date that wholly contains a name span made of a month word (patient "May" / "Jan" inside "Jan 12, 2027") is a date
      if (/^(DATE|DOB)$/.test(s.type) && hits.every((k) => COARSE(k.type) === 'NAME' && k.start >= s.start && k.end <= s.end && /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i.test(k.text))) {
        for (const h of hits) kept.splice(kept.indexOf(h), 1);
        kept.push(s); continue;
      }
      // A labelled identifier (serial # BRD-77120931, SN 2201994-B) absorbs a rule-matched MRN/ACCOUNT/PHONE inside it;
      // a census MRN (a real patient's number) keeps its own span so it maps to the study code.
      if (s.type === 'ID_OTHER' && s.labeled && hits.every((k) => /^(MRN|ACCOUNT|PHONE|ZIP|DATE)$/.test(k.type) && k.source === 'rule' && k.start >= s.start && k.end <= s.end)) {
        for (const h of hits) kept.splice(kept.indexOf(h), 1);
        kept.push(s); continue;
      }
      // A name overlapping only names: widen the kept span(s) to the union so no token is lost.
      if (COARSE(s.type) === 'NAME' && hits.every((k) => COARSE(k.type) === 'NAME')) {
        const k = hits[0];
        k.start = Math.min(k.start, s.start, ...hits.map((h) => h.start));
        k.end = Math.max(k.end, s.end, ...hits.map((h) => h.end));
        k.text = (s.fullText || '').slice(k.start, k.end) || k.text;
        k.source = k.source.includes(s.source) ? k.source : `${k.source}+${s.source}`;
        for (const h of hits.slice(1)) kept.splice(kept.indexOf(h), 1);
        for (const h of [s, ...hits.slice(1)]) { if (h.relative && !k.relative && !k.entity) k.relative = h.relative; if (h.ownTokens && !k.ownTokens) k.ownTokens = h.ownTokens; if (h.entity && !k.entity && k.type === h.type) k.entity = h.entity; }
        // "daughter Siobhan Fitzgerald-Nowak": the union added a token that is not one of the patient's own names, so
        // this is a relative who shares the surname, not the patient
        if (k.type === 'NAME_PATIENT' && k.entity && k.ownTokens) {
          const toks = k.text.toLowerCase().split(/[^a-z'’]+/).filter(Boolean);
          if (toks.some((t) => !k.ownTokens.has(t) && !(t.length === 1 && [...k.ownTokens].some((o) => o[0] === t)) && !/^(?:md|do|np|pa|rn|jr|sr|ii|iii|iv|mr|mrs|ms|dr|pt)$/.test(t))) { k.type = 'NAME_OTHER'; k.relative = k.entity; delete k.entity; }
        }
      }
    }
    kept.sort((a, b) => a.start - b.start);
    // merge adjacent same-coarse NAME spans separated by whitespace/comma
    const merged = [];
    for (const s of kept) {
      const prev = merged[merged.length - 1];
      if (prev && COARSE(prev.type) === 'NAME' && COARSE(s.type) === 'NAME' && !prev.entity && !s.entity && /^[\s,]{1,2}$/.test(prev._text_between || '')) { /* placeholder, handled below */ }
      merged.push(s);
    }
    return merged;
  }
  function mergeAdjacentNames(spans, text) {
    const out = [];
    for (const s of spans) {
      const prev = out[out.length - 1];
      if (prev && COARSE(prev.type) === 'NAME' && COARSE(s.type) === 'NAME' && (prev.entity || null) === (s.entity || null) && /^\s$/.test(text.slice(prev.end, s.start))) {
        prev.end = s.end; prev.text = text.slice(prev.start, prev.end);
        if (TYPES[s.type].pri > TYPES[prev.type].pri) prev.type = s.type;
        if (s.relative && !prev.relative) prev.relative = s.relative;
        prev.source = prev.source === s.source ? prev.source : `${prev.source}+${s.source}`;
        continue;
      }
      out.push(Object.assign({}, s));
    }
    return out;
  }

  function detectText(text, ctx) {
    if (!text) return [];
    const cfg = ctx.cfg;
    let spans = [];
    const tag = (arr) => { arr.forEach((s) => { s.fullText = text; }); return arr; };
    if (cfg.layers.census) spans = spans.concat(tag(censusSpans(text, ctx.census, ctx.rowPatientKey, ctx.rowExtraKeys)));
    if (cfg.layers.rules) spans = spans.concat(tag(ruleSpans(text, cfg)));
    if (cfg.layers.model) spans = spans.concat(tag(lexiconSpans(text, cfg)));
    if (cfg.layers.propagate && ctx.propagateRegex) {
      ctx.propagateRegex.lastIndex = 0; let m;
      while ((m = ctx.propagateRegex.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'propagate', conf: 0.65, text: m[0], fullText: text });
      if (ctx.propagateRegex.handleParts) {
        const hp = ctx.propagateRegex.handleParts; hp.lastIndex = 0;
        while ((m = hp.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'propagate', conf: 0.6, text: m[0], fullText: text });
      }
      const amb = ctx.rowAmbiguous || null;
      if (amb) {
        amb.lastIndex = 0;
        while ((m = amb.exec(text))) {
          const before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
          if (/(?:^|[.!?:;\n]\s*|^\s*[-•*]\s*|\s[-–—|]\s*)$/.test(before)) continue; // sentence-initial: "Will call", "- Grace noted"
          const nextWord = (after.match(/^(?:['’]s?)?\s+([A-Za-z]+)/) || [])[1];
          if (nextWord && (LEX.EPONYM_FOLLOW.has(nextWord.toLowerCase()) || /^(to|be|need|needs|call|chart|insurance|for|from|and)$/i.test(nextWord) && /^(will|hope|mark|bill|may|grant|chase|rose|faith|joy|sue|pat|art|guy|bob)$/i.test(m[0]))) continue;
          spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'propagate', conf: 0.6, text: m[0], fullText: text });
        }
      }
    }
    const manual = ctx.manual && ctx.cellKey ? ctx.manual[ctx.cellKey] : null;
    if (manual) {
      if (manual.remove) spans = spans.filter((s) => !manual.remove.some((r) => r[0] === s.start && r[1] === s.end));
      if (manual.add) manual.add.forEach((a) => spans.push({ start: a.start, end: a.end, type: a.type || 'NAME_OTHER', source: 'manual', conf: 1, text: text.slice(a.start, a.end), fullText: text, manual: true }));
    }
    const out = mergeAdjacentNames(resolveSpans(spans), text);
    if (manual && manual.remove) {
      // a removed span must stay removed even if a merged/propagated span re-covers exactly it
      for (const r of manual.remove) { const i = out.findIndex((s) => s.start === r[0] && s.end === r[1] && !s.manual); if (i >= 0) out.splice(i, 1); }
    }
    out.forEach((s) => { s.text = text.slice(s.start, s.end); delete s.fullText; });
    return out;
  }

  // Collect tokens worth propagating from a set of spans (document-level).
  function collectPropagation(allSpans, cfg) {
    const terms = new Set(), ambTerms = new Set(), handleParts = new Set();
    const titleCase = (w) => w.toLowerCase().replace(/(^|[-'’])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    for (const s of allSpans) {
      // the words of a user name or e-mail address ("rosie.delgado62", "lally.marchbanks@...") are the person's names, and
      // are written in lower case elsewhere in the same message ("hi its rosie")
      if ((s.type === 'EMAIL' || (s.type === 'ID_OTHER' && s.handle)) && s.text) {
        const local = s.text.split('@')[0].replace(/^@/, '');
        local.split(/[^A-Za-z]+/).forEach((w) => { if (w.length >= 4 && !COMMON_CAP.has(w.toLowerCase()) && !LEX.isClinical(w) && !LEX.isAmbiguous(w) && !LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) && !LEX.ORG_NAMEWORD_SET.has(w.toLowerCase()) && !/^(?:user|admin|info|mail|noreply|reply|office|dept|nurse|clinic|health|care|team|help|support|contact|example|test|mychart|portal)$/i.test(w)) handleParts.add(w.toLowerCase()); });
        continue;
      }
      if (COARSE(s.type) !== 'NAME' || s.source === 'census' || s.source === 'propagate' || s.initials) continue;
      const full = s.text.trim();
      if (full.length >= 4 && /\s/.test(full)) terms.add(full);
      const parts = full.split(/[\s,]+/).filter(Boolean);
      for (const tok of parts) {
        const core = tok.replace(/['’]s$/, '').replace(/\.$/, '');
        if (core.length < 3 || !/^[A-Z]/.test(core)) continue;
        if (LEX.HONORIFIC_SET.has(core.toLowerCase()) || LEX.CREDENTIAL_SET.has(core.toLowerCase())) continue;
        if (LEX.isClinical(core) || (cfg.allowSet && cfg.allowSet.has(core.toLowerCase()))) continue;
        // a word-name (Grace, Will, Hope) of a full name found by a cue is re-found elsewhere, but only mid-sentence
        // (see detectText), so "Told Grace that is fine" is caught while "Will call back" stays
        if (LEX.isAmbiguous(core)) { if (parts.length >= 2) ambTerms.add(core.length > 1 && core === core.toUpperCase() ? titleCase(core) : core); continue; }
        terms.add(core);
        // an ALL-CAPS name (MARGARITA ELENA RUIZ) is written in Title Case elsewhere in the note (Thank you, Margarita)
        if (core === core.toUpperCase() && /[A-Z]{3}/.test(core)) terms.add(titleCase(core));
      }
    }
    if (!terms.size && !ambTerms.size && !handleParts.size) return null;
    const mk = (set) => new RegExp(`(?<![\\w])(?:${[...set].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\w])`, 'g'); // case-sensitive on purpose
    const re = terms.size ? mk(terms) : /(?!)/g;
    re.ambiguous = ambTerms.size ? mk(ambTerms) : null;
    re.handleParts = handleParts.size ? new RegExp(`(?<![\\w])(?:${[...handleParts].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![\\w])`, 'gi') : null;
    return re;
  }
  // names held in identifier columns that are removed (Emergency Contact, Guarantor, Subscriber): a relative listed there
  // is usually mentioned by name in the comments ("Henrik waits in lobby")
  const PERSON_COLUMN = /\b(?:emergency|contact|guarantor|subscriber|kin|nok|caregiver|spouse|relative|family|proxy|poa|visitor|driver|escort|responsible|parent|guardian|insured)\b/i;
  function columnNameSpans(headers, rows, columns) {
    const out = [];
    columns.forEach((col) => {
      if (col.role !== 'drop' || !PERSON_COLUMN.test(col.header || '')) return;
      rows.forEach((row) => {
        const v = cellToString(row[col.index]).trim(); if (!v) return;
        const m = v.match(/^([A-Z][A-Za-z'’\-]+(?:\s[A-Z][A-Za-z'’\-]+)?),\s*([A-Z][A-Za-z'’\-]+)/) || v.match(/^([A-Z][a-z][A-Za-z'’\-]+)\s+([A-Z][A-Za-z'’\-]+)(?=\s|$|\()/);
        if (!m) return;
        if ([m[1], m[2]].some((w) => LEX.isClinical(w) || /^(self|same|none|n\/a|patient|pt)$/i.test(w))) return;
        out.push({ type: 'NAME_OTHER', source: 'column', text: m[0], start: 0, end: m[0].length });
      });
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // 5. Surrogation (hide in plain sight)
  // ---------------------------------------------------------------------
  function Surrogator(cfg, census, documentText) {
    // The registry is the session-wide allocator: every made-up token handed out so far (to a patient, a provider, a
    // relative, a street or an organization) is recorded there, so one fake name never stands for two real people,
    // and the same real provider or organization keeps one fake across every input of the session.
    const registry = (census && census.registry) || createRegistry();
    const rng = mulberry32((cfg.seed + 7919 * registry.allocations) >>> 0);
    registry.allocations++;
    // Words present in the document: a surrogate must never be a real token from the report.
    const docWords = new Set(((documentText || '').toLowerCase().match(/[a-z][a-z'’\-]+/g) || []));
    const taken = registry.taken;
    registry.entities.forEach((e) => { if (e.fakeFirst) taken.add(e.fakeFirst.toLowerCase()); if (e.fakeLast) taken.add(e.fakeLast.toLowerCase()); });
    const realWords = registry.realWords;
    // once a pool is exhausted, invent a plain capitalized word from two pool entries (Ash+well → Ashwell)
    const invent = (pool) => {
      for (let tries = 0; tries < 200; tries++) {
        const a = pool[Math.floor(rng() * pool.length)], b = pool[Math.floor(rng() * pool.length)];
        const w = a.slice(0, Math.max(2, Math.ceil(a.length / 2))) + b.slice(Math.floor(b.length / 2)).toLowerCase();
        const x = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        const k = x.toLowerCase();
        if (x.length >= 4 && x.length <= 12 && !taken.has(k) && !docWords.has(k) && !realWords.has(k) && !nearReal(k) && !LEX.isFirstName(x) && !LEX.isSurname(x) && !LEX.isAmbiguous(x) && !LEX.isClinical(x)) return x;
      }
      return pool[Math.floor(rng() * pool.length)] + String(Math.floor(rng() * 90) + 10);
    };
    // a made-up name one letter away from a real word of the session (Gwendolen for a real Gwendolyn) reads as a misspelled
    // real name, so it is avoided too: every real word of 5+ letters and its one-letter deletions, compared with the candidate's
    let near = null;
    const nearReal = (k) => {
      if (k.length < 5) return false;
      if (!near) { near = new Set(); for (const w of realWords) { if (w.length < 4) continue; near.add(w); for (let i = 0; i < w.length; i++) near.add(w.slice(0, i) + w.slice(i + 1)); } }
      if (near.has(k)) return true;
      for (let i = 0; i < k.length; i++) if (near.has(k.slice(0, i) + k.slice(i + 1))) return true;
      return false;
    };
    const pick = (pool) => {
      const fresh = pool.filter((x) => { const k = x.toLowerCase(); return !docWords.has(k) && !taken.has(k) && !realWords.has(k) && !nearReal(k); });
      const x = fresh.length ? fresh[Math.floor(rng() * fresh.length)] : invent(pool);
      taken.add(x.toLowerCase());
      return x;
    };
    const randDigits = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rng() * 10); return s; };
    // digit strings of 7+ digits written in the document (phones, record numbers), separators removed
    let digitRuns = null;
    const realDigitRuns = () => digitRuns || (digitRuns = [...new Set([/\d[\d \t().\-]{5,}\d/g, /\(?\d{3}\)?[ .\-]?\d{3}[ .\-]?\d{4}/g, /\d{3}[ .\-]?\d{4}/g].flatMap((re) => (documentText || '').match(re) || []).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 7 && x.length <= 12))]);
    const range = cfg.surrogate.shiftRange || [30, 365];
    const randOffset = () => { const mag = range[0] + Math.floor(rng() * (range[1] - range[0] + 1)); return rng() < 0.5 ? -mag : mag; };

    const patientInfo = new Map(); // key -> {code, fakeFirst, fakeLast, offset}
    const providerInfo = registry.providers; // provider key -> {code, fakeFirst, fakeLast, last, first, credentials}
    const tokenMap = registry.tokenMap; // lowercased real name token -> fake token (third parties and providers)
    const stringMap = registry.strings; // type|lower -> fake (phones, emails, orgs, places, ids)
    // rows with no patient shift by one document offset, drawn once per session so a re-run of the same input is identical
    if (registry.docOffset == null || (cfg.surrogate.dateShift && registry.docOffset === 0)) registry.docOffset = cfg.surrogate.dateShift ? randOffset() : 0;
    const docOffset = cfg.surrogate.dateShift ? registry.docOffset : 0;
    const mapping = { patients: [], providers: [], others: [] };
    // real words of this document are never handed out as surrogates, now or in a later input of the session
    for (const w of docWords) if (w.length >= 3) realWords.add(w);

    const ensurePatient = (key) => {
      let info = patientInfo.get(key);
      if (!info) {
        const p = census.patient ? census.patient(key) : census.patients.get(key);
        const e = p && p.entity ? p.entity : registry.get(key) || null;
        if (e) {
          // identity persists across inputs: reuse what the registry already assigned
          if (!e.fakeFirst) e.fakeFirst = pick(LEX.FAKE_FIRST); else taken.add(e.fakeFirst.toLowerCase());
          if (!e.fakeLast) e.fakeLast = pick(LEX.FAKE_LAST); else taken.add(e.fakeLast.toLowerCase());
          if (e.offset == null) e.offset = cfg.surrogate.dateShift ? randOffset() : 0;
          info = { key, code: e.code, fakeFirst: e.fakeFirst, fakeLast: e.fakeLast, offset: e.offset };
        } else {
          const idx = p ? p.order : patientInfo.size;
          info = { key, code: `P${String(idx + 1).padStart(3, '0')}`, fakeFirst: pick(LEX.FAKE_FIRST), fakeLast: pick(LEX.FAKE_LAST), offset: cfg.surrogate.dateShift ? randOffset() : 0 };
        }
        patientInfo.set(key, info);
        // a relative who shares the surname gets the patient's fake surname with a fresh first name
        if (p) p.names.forEach((nm) => { const pn = parseName(nm); if (pn) { if (pn.first) tokenMap.set(pn.first.toLowerCase(), info.fakeFirst); if (pn.last) tokenMap.set(pn.last.toLowerCase(), info.fakeLast); } });
        if (!e) mapping.patients.push({ Code: info.code, SurrogateName: `${info.fakeLast}, ${info.fakeFirst}`, RealName: p ? [...p.names][0] || '' : '', MRN: p ? [...p.mrns][0] || '' : '', DOB: p && p.dob ? cellToString(p.dob) : '', Account: p ? [...p.accounts].join('; ') : '', Phone: p ? [...p.phones].join('; ') : '', DateOffsetDays: info.offset });
      }
      return info;
    };
    const ensureProvider = (key) => {
      let info = providerInfo.get(key);
      if (!info) {
        const pr = census.providers.get(key);
        const idx = providerInfo.size;
        const parsed = pr && pr.parsed ? pr.parsed : parseName(key.replace('|', ', '));
        // the surname may already have a fake from free text (a relative or a bare "Dr. Lee"): keep one fake per real token
        const fakeLast = (parsed && parsed.last && tokenMap.get(parsed.last.toLowerCase())) || pick(LEX.FAKE_LAST);
        const fakeFirst = (parsed && parsed.first && tokenMap.get(parsed.first.toLowerCase())) || pick(LEX.FAKE_FIRST);
        info = { key, code: `Dr. ${String.fromCharCode(65 + (idx % 26))}${idx >= 26 ? Math.floor(idx / 26) : ''}`, fakeFirst, fakeLast, last: parsed ? parsed.last : key, first: parsed ? parsed.first : '', credentials: parsed ? parsed.credentials : '' };
        providerInfo.set(key, info);
        if (parsed) { if (parsed.last) tokenMap.set(parsed.last.toLowerCase(), info.fakeLast); if (parsed.first) tokenMap.set(parsed.first.toLowerCase(), info.fakeFirst); }
      }
      return info;
    };
    const stringSurrogate = (type, original, make) => {
      const k = `${type}|${original.toLowerCase()}`;
      if (!stringMap.has(k)) stringMap.set(k, { Type: type, Original: original, Surrogate: make() });
      return stringMap.get(k).Surrogate;
    };
    const matchCase = (orig, fake) => (orig === orig.toUpperCase() && /[A-Z]/.test(orig) ? fake.toUpperCase() : fake);

    // Render a name surrogate in the same shape as the original text.
    const renderName = (origText, parsedEntity, info, mode) => {
      if (mode === 'code') return info.code;
      const parsed = parseName(origText);
      if (!parsed) return `${info.fakeLast}, ${info.fakeFirst}`;
      const cred = parsed.credentials ? ' ' + parsed.credentials : '';
      let out;
      if (/^[A-Z]\.\s?[A-Z]\.$/.test(origText.trim())) out = `${info.fakeFirst[0]}.${origText.includes(' ') ? ' ' : ''}${info.fakeLast[0]}.`; // K.Y.
      else if (parsed.format === 'last_first' && /^[A-Z]\.?$/.test(parsed.first)) out = `${info.fakeLast}, ${info.fakeFirst[0]}${parsed.first.endsWith('.') ? '.' : ''}`; // "Brightman, O."
      else if (parsed.format === 'last_first') out = `${info.fakeLast}, ${info.fakeFirst}`; // the real middle initial is dropped
      else if (parsed.format === 'single') {
        const lower = parsed.last.toLowerCase();
        const isOwnLast = parsedEntity && (lower === parsedEntity.last.toLowerCase() || parsedEntity.last.toLowerCase().split('-').includes(lower));
        if (parsedEntity && parsedEntity.first && lower === parsedEntity.first.toLowerCase()) out = info.fakeFirst;
        else if (isOwnLast) out = info.fakeLast;
        else if (parsedEntity && parsedEntity.middle && parsedEntity.middle.toLowerCase().split(/\s+/).includes(lower)) out = info.fakeFirst; // the second given name (Thi Hong → Hong)
        else if (parsedEntity && parsedEntity.first && LEX.nicknamesOf(parsedEntity.first).some((n) => n.toLowerCase() === lower)) out = info.fakeFirst;
        else out = LEX.isFirstName(parsed.last) && !LEX.isSurname(parsed.last) ? info.fakeFirst : info.fakeLast;
      } else {
        const lowFirst = parsed.first.toLowerCase(), lowLast = parsed.last.toLowerCase();
        const mids = parsedEntity && parsedEntity.middle ? parsedEntity.middle.toLowerCase().split(/\s+/) : [];
        const first = /^[A-Z]\.?$/.test(parsed.first) ? info.fakeFirst[0] + '.' : info.fakeFirst;
        const last = /^[A-Z]\.?$/.test(parsed.last) ? info.fakeLast[0] + (parsed.last.endsWith('.') ? '.' : '') : info.fakeLast; // Svetlana P. → Zane D.
        if (parsedEntity && parsedEntity.first && lowFirst === parsedEntity.first.toLowerCase() && mids.includes(lowLast)) out = info.fakeFirst; // "Mary Catherine": a two-word given name
        else if (parsedEntity && lowFirst === parsedEntity.last.toLowerCase() && /^[A-Z]\.?$/.test(parsed.last)) out = `${info.fakeLast} ${info.fakeFirst[0]}${parsed.last.endsWith('.') ? '.' : ''}`; // "Castellane W."
        else if (parsedEntity && lowFirst === parsedEntity.last.toLowerCase()) out = `${info.fakeLast} ${info.fakeFirst}`; // "TRAN THI HONG": surname first, no comma
        else out = `${first} ${last}`;
      }
      return matchCase(origText, out) + cred;
    };

    // labelled or dotted initials (P.R., J.R.): same punctuation, different letters, one fake per real set of initials
    const fakeInitials = (orig) => {
      const key = orig.replace(/\.$/, '');
      const fake = stringSurrogate('NAME', key, () => { let i = 0; return key.replace(/[A-Z]/g, () => { const f = i++ === 0 ? pick(LEX.FAKE_FIRST) : pick(LEX.FAKE_LAST); return f[0].toUpperCase(); }); });
      return orig.endsWith('.') && !fake.endsWith('.') ? fake + '.' : fake;
    };
    // Third-party names: consistent per token.
    const renderOtherName = (origText) => {
      const parsed = parseName(origText);
      if (!parsed) return pick(LEX.FAKE_FIRST);
      const cred = parsed.credentials ? ' ' + parsed.credentials : '';
      const tok = (t, asFirst) => {
        if (!t) return '';
        const k = t.toLowerCase().replace(/[.,]/g, '');
        if (!k) return '';
        if (/^[a-z]$/.test(k)) return t; // initial
        if (/^(?:[A-Z]\.){2,3}$|^(?:[A-Z]\.){1,2}[A-Z]$/.test(t)) return fakeInitials(t); // J.R.
        if (t === t.toLowerCase() && NAME_PARTICLE.test(k)) return t; // van der, de la, bin: particles stay as written
        const pm = t.match(/^((?:al|el|ad|ar|as|ash|at|az|an|bin|ibn|ben|bint|abu|ould)-)(.+)$/); if (pm && !tokenMap.has(k)) return pm[1] + tok(pm[2], asFirst); // al-Harbi
        // Haddad-Khalil: each half on its own, so the half shared with a patient keeps that patient's fake surname
        if (k.includes('-') && !tokenMap.has(k)) return k.split('-').map((h, i) => tok(t.split('-')[i] || h, false)).join('-');
        if (!tokenMap.has(k)) tokenMap.set(k, asFirst ? pick(LEX.FAKE_FIRST) : pick(LEX.FAKE_LAST));
        return matchCase(t, tokenMap.get(k));
      };
      let out;
      if (parsed.format === 'last_first') out = `${tok(parsed.last, false)}, ${tok(parsed.first, true)}${parsed.middle ? ' ' + parsed.middle : ''}`;
      else if (parsed.format === 'single') out = tok(parsed.last, LEX.isFirstName(parsed.last) && !LEX.isSurname(parsed.last));
      else out = [tok(parsed.first, true), ...(parsed.middle ? parsed.middle.split(' ').map((m) => tok(m, true)) : []), tok(parsed.last, false)].join(' ');
      return out + cred;
    };

    // every fake phone is a 555-010-xxxx number (or 555-xxxx without an area code); separators and extensions keep their shape
    const fakePhone = (orig) => stringSurrogate('PHONE', orig, () => {
      const extM = orig.match(/\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6}$/i);
      const main = extM ? orig.slice(0, orig.length - extM[0].length) : orig, ext = extM ? extM[0] : '';
      const n = (main.match(/\d/g) || []).length;
      // the fake's digits must never contain a real number of the document ("555-010-2437" spells out a real "555-0102")
      let fake;
      for (let tries = 0; tries < 40; tries++) { fake = (n === 7 ? '555' : n === 11 && /^\+?1/.test(main.trim()) ? '1555010' : '555010') + randDigits(4); if (!realDigitRuns().some((r) => fake.includes(r))) break; }
      let di = 0;
      const out = main.replace(/\d/g, () => fake[di++] != null ? fake[di - 1] : randDigits(1));
      return out + ext.replace(/\d/g, () => randDigits(1));
    });
    // a bare 10-digit number has the shape of a phone number: give it the 555-010 shape rather than digits that could be dialled
    const fakeDigits = (type, orig) => stringSurrogate(type, orig, () => (orig.replace(/\D/g, '').length === 10 && !/[A-Za-z]/.test(orig)) ? (() => { const d = ('555010' + randDigits(4)).split(''); let i = 0; return orig.replace(/\d/g, () => d[i++]); })() : orig.replace(/\d/g, () => randDigits(1)).replace(/^(\D*)\d/, '$19'));
    // Other identifiers: numeric/alphanumeric codes keep their shape with new digits; user names and handles
    // (letters that may spell a name) are replaced wholesale so no name fragment survives.
    const fakeId = (orig) => stringSurrogate('ID', orig, () => {
      if (/[a-z]{3,}/.test(orig) || /^@/.test(orig)) return orig.replace(/^(@?)[A-Za-z][\w.\-]*/, (m, at) => `${at}user${randDigits(4)}`);
      if (orig.replace(/\D/g, '').length === 10 && !/[A-Za-z]/.test(orig)) { const d = ('555010' + randDigits(4)).split(''); let i = 0; return orig.replace(/\d/g, () => d[i++]); }
      return orig.replace(/\d/g, () => randDigits(1)).replace(/^(\D*)\d/, '$19').replace(/[A-Z]/g, () => String.fromCharCode(65 + Math.floor(rng() * 26)));
    });

    return {
      mapping, patientInfo, providerInfo, docOffset,
      offsetFor(patientKey) { return patientKey ? ensurePatient(patientKey).offset : docOffset; },
      patient(key) { return ensurePatient(key); },
      provider(key) { return ensureProvider(key); },
      replace(span, text, rowPatientKey) {
        const orig = text.slice(span.start, span.end);
        const mode = cfg.surrogate.patients;
        switch (span.type) {
          case 'NAME_PATIENT': {
            if (span.entity) { const info = ensurePatient(span.entity); const p = census.patient ? census.patient(span.entity) : census.patients.get(span.entity); return renderName(orig, p && p.parsed, info, mode); }
            return renderOtherName(orig);
          }
          case 'NAME_PROVIDER': {
            if (span.entity) { const info = ensureProvider(span.entity); const pr = census.providers.get(span.entity); return renderName(orig, pr && pr.parsed, info, cfg.surrogate.providers); }
            if (cfg.surrogate.providers === 'code') return stringSurrogate('PROVIDER', orig, () => `Dr. ${String.fromCharCode(65 + (providerInfo.size + stringMap.size) % 26)}`);
            return renderOtherName(orig);
          }
          case 'NAME_OTHER': {
            if (/^[A-Z]\.?\s?[A-Z]\.?(?:\s?[A-Z]\.?)?$/.test(orig) && (orig.includes('.') || span.initials)) return fakeInitials(orig);
            return renderOtherName(orig);
          }
          case 'MRN': { if (span.entity) return ensurePatient(span.entity).code; return fakeDigits('MRN', orig); }
          case 'ACCOUNT': { if (span.entity) return `A-${ensurePatient(span.entity).code}`; return fakeDigits('ACCOUNT', orig); }
          case 'PHONE': return fakePhone(orig);
          case 'EMAIL': return stringSurrogate('EMAIL', orig, () => `${pick(LEX.FAKE_FIRST).toLowerCase()}.${pick(LEX.FAKE_LAST).toLowerCase()}@example.com`);
          case 'SSN': return stringSurrogate('SSN', orig, () => `9${randDigits(2)}-${randDigits(2)}-${randDigits(4)}`);
          case 'URL': return '[url]';
          case 'IP': return '[ip]';
          case 'ID_OTHER': return fakeId(orig);
          case 'DOB':
          case 'DATE': {
            const pd = span.date || (() => { for (const p of DATE_PATTERNS) { p.re.lastIndex = 0; const m = p.re.exec(orig); if (m && m[0] === orig) return parseDateMatch(p.kind, m); } return null; })();
            // a birthdate in free text follows the DOB setting, like the DOB column: removed (default), year only, or shifted
            if (span.type === 'DOB' && cfg.surrogate.dob !== 'shift') return cfg.surrogate.dob === 'year' && pd && pd.hasYear ? String(pd.y) : '[dob]';
            if (!cfg.surrogate.dateShift) return span.type === 'DOB' ? '[dob]' : '[date]';
            if (!pd) return '[date]';
            const key = span.entity || rowPatientKey;
            const off = key ? ensurePatient(key).offset : docOffset;
            return renderDate(pd, shiftDate(new Date(pd.y, pd.m - 1, pd.d), off));
          }
          case 'AGE': return orig.replace(/(?<!\d)(9\d|1[0-2]\d)(?:st|nd|rd|th)?(?!\d)/, '90+').replace(/\b(9|10)0s\b/, '90s+').replace(/nonagenarian|centenarian/i, '90+ y/o')
            .replace(/\b(?:ninety|one[-\s]hundred)(?:(?:[-\s]|\s+and\s+)(?:one|two|three|four|five|six|seven|eight|nine))?/i, '90+');
          case 'ADDRESS': return stringSurrogate('ADDRESS', orig, () => {
            if (/\bbox\b/i.test(orig)) return orig.replace(/\d+(?!.*\d)/, () => String(Math.floor(rng() * 9000) + 1000)).replace(/^(?:RR|R\.R\.|Rural\s+Route|HC)\s*\d+/i, (m) => m.replace(/\d+/, () => String(Math.floor(rng() * 9) + 1)));
            if (RULES.ADDRESS_UNIT.source && /(?:apt|apartment|unit|suite|ste|#)\.?\s*#?[A-Za-z]?\d+[A-Za-z]?$/i.test(orig) && !/\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl)\b/.test(orig)) return `${Math.floor(rng() * 900 + 100)} ${pick(LEX.FAKE_LAST)} Rd`; const suf = (orig.match(/\b(Rd|Dr|St|Ave|Blvd|Pkwy|Ln|Ct|Hwy|Rte|Route|Way|Pl|Cir|Ter|Trl|Street|Avenue|Road|Drive|Lane|Court|Place|Boulevard|Parkway)\.?(?=\W*$|\s)/) || [])[1] || (/^\d/.test(orig) ? 'St' : 'Rd'); return `${/^\d/.test(orig) ? Math.floor(rng() * 900 + 100) + ' ' : ''}${pick(LEX.FAKE_LAST)} ${suf}${/\.$/.test(orig) && !/\.$/.test(suf) ? '.' : ''}`; });
          case 'ZIP': return orig.replace(/\d{5}(-\d{4})?/, (z) => z.slice(0, 3) + '00');
          case 'ORG': return stringSurrogate('ORG', orig, () => pick(LEX.FAKE_ORGS));
          case 'LOCATION': return stringSurrogate('LOCATION', orig, () => pick(LEX.FAKE_CITIES));
        }
        return '[redacted]';
      },
    };
  }

  function applySpans(text, spans, replacer) {
    let out = text, replacements = [];
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      const rep = replacer(s);
      replacements.unshift({ start: s.start, end: s.end, original: text.slice(s.start, s.end), replacement: rep, type: s.type, source: s.source });
      out = out.slice(0, s.start) + rep + out.slice(s.end);
    }
    return { text: out, replacements };
  }


  // ---------------------------------------------------------------------
  // 5b. Patient registry: one identity per real patient across inputs
  // ---------------------------------------------------------------------
  // OCR confusions for identifier tokens: letters that are really digits.
  function normalizeId(s) {
    const t = cellToString(s).trim().replace(/[\s\-\.]/g, '');
    if (!t) return '';
    const digits = (t.match(/\d/g) || []).length;
    if (digits / t.length < 0.6) return t;
    return t.replace(/[OoQ]/g, '0').replace(/[Il|!]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/[Zz]/g, '2').replace(/G/g, '6');
  }
  const mrnKeyOf = (mrn) => { const n = normalizeId(mrn); const d = n.replace(/^[A-Za-z]+/, '').replace(/^0+/, ''); return d.length >= 5 ? d : (n ? n.toLowerCase() : ''); };
  const dobKeyOf = (dob) => { if (dob == null || dob === '') return ''; const d = isDate(dob) ? dob : parseDateString(cellToString(dob)); return d ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` : ''; };
  // letters only, with the common OCR letter-pair confusions collapsed (rn→m, vv→w, cl→d)
  const alpha = (x) => (x || '').toLowerCase().replace(/[^a-z]/g, '').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
  function levenshtein(a, b) {
    if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[b.length];
  }

  // seedRows: Patients sheet rows of a saved key; seedExtra: { providers: Providers rows, others: Others rows } of the same key
  function createRegistry(seedRows, seedExtra) {
    const entities = [];
    const byMrn = new Map();
    let next = 1;
    // session-wide surrogate allocation (see Surrogator): fakes handed out, real words seen, providers, name tokens, strings
    const taken = new Set(), realWords = new Set(), providers = new Map(), tokenMap = new Map(), strings = new Map();
    const newEntity = () => { const e = { id: `e${entities.length + 1}`, code: `P${String(next++).padStart(3, '0')}`, mrns: new Set(), names: new Set(), parsed: [], dobs: new Set(), accounts: new Set(), phones: new Set(), fakeFirst: null, fakeLast: null, offset: null }; entities.push(e); return e; };
    const absorb = (e, rec) => {
      const mk = rec.mrn ? mrnKeyOf(rec.mrn) : '';
      if (mk) { e.mrns.add(cellToString(rec.mrn).trim()); byMrn.set(mk, e); }
      if (rec.name) { const raw = cellToString(rec.name).trim(); if (raw && !e.names.has(raw)) { e.names.add(raw); const pn = parseName(raw); if (pn) e.parsed.push(pn); } }
      const dk = dobKeyOf(rec.dob); if (dk) e.dobs.add(dk);
      (rec.accounts || []).forEach((a) => a && e.accounts.add(a));
      (rec.phones || []).forEach((p) => p && e.phones.add(p));
      return e;
    };
    const nameMatch = (e, pn, dk, mk) => {
      if (mk && e.mrns.size && !byMrn.has(mk)) return false; // both have MRNs and they differ
      if (dk && e.dobs.size && !e.dobs.has(dk)) return false;  // both have DOBs and they differ
      const last = alpha(pn.last), first = alpha(pn.first);
      if (!last) return false;
      const dobTie = !!dk && e.dobs.has(dk); // both carry the same DOB: a strong tie that permits looser name matching
      // Merging two different people is worse than a duplicate: one person's clinical data would be filed under
      // another's code. A spelling-tolerant match (OCR typo, initial for a first name) therefore needs the DOB to agree.
      const strongTie = dobTie;
      const halves = (l) => l.split(/[-\s]+/).map(alpha).filter((h) => h.length >= 3);
      for (const q of e.parsed) {
        const ql = alpha(q.last), qf = alpha(q.first);
        const lastExact = ql === last;
        let lastOk = lastExact || (strongTie && last.length >= 5 && ql.length >= 5 && levenshtein(last, ql) <= 1);
        // hyphenated / married surname: "Garcia-Lopez" vs "Garcia" or "Lopez", only with a matching DOB
        if (!lastOk && dobTie) { const a = halves(pn.last), b = halves(q.last); if ((a.length > 1 || b.length > 1) && a.some((h) => b.includes(h))) lastOk = true; }
        if (!lastOk) continue;
        // two different, complete, known first names (Maria vs Mario) are two people, even if one letter apart
        const distinctKnown = first && qf && first !== qf && first.length >= 3 && qf.length >= 3 && LEX.isFirstName(first) && LEX.isFirstName(qf);
        const firstExact = !!first && first === qf;
        // exact surname + exact first name links on its own; a missing first name, an initial or a one-letter
        // difference links only with a matching DOB
        const firstOk = firstExact || (strongTie && (!first || !qf || (first.length === 1 && qf.startsWith(first)) || (qf.length === 1 && first.startsWith(qf))
          || (!distinctKnown && first.length >= 4 && qf.length >= 4 && levenshtein(first, qf) <= 1)));
        if (firstOk) return true;
      }
      return false;
    };
    const reg = {
      entities, taken, realWords, providers, tokenMap, strings, allocations: 0, docOffset: null,
      get size() { return entities.length; },
      toProviderRows() {
        return [...providers.values()].map((pr) => ({ Code: pr.code, SurrogateName: `${pr.fakeLast}, ${pr.fakeFirst}`, RealName: pr.first ? `${pr.last}, ${pr.first}` : pr.last, Credential: pr.credentials || '' }));
      },
      toOtherRows() {
        const rows = [...strings.values()].map((o) => ({ Type: o.Type, Original: o.Original, Surrogate: o.Surrogate }));
        // providers and patients have their own sheets; only third-party tokens go here
        const skip = new Set(); providers.forEach((pr) => { skip.add(pr.last.toLowerCase()); if (pr.first) skip.add(pr.first.toLowerCase()); });
        entities.forEach((e) => e.parsed.forEach((pn) => { if (pn.first) skip.add(pn.first.toLowerCase()); if (pn.last) skip.add(pn.last.toLowerCase()); }));
        tokenMap.forEach((fake, real) => { if (!skip.has(real)) rows.push({ Type: 'NAME', Original: real.charAt(0).toUpperCase() + real.slice(1), Surrogate: fake }); });
        return rows;
      },
      get(id) { return entities.find((e) => e.id === id) || null; },
      // rec: { name, mrn, dob, accounts?, phones? } — any subset. Returns the entity (created if new).
      resolve(rec) {
        const mk = rec.mrn ? mrnKeyOf(rec.mrn) : '';
        if (mk && byMrn.has(mk)) return absorb(byMrn.get(mk), rec);
        const pn = rec.name ? parseName(cellToString(rec.name)) : null;
        const dk = dobKeyOf(rec.dob);
        if (pn && pn.last) {
          const hit = entities.find((e) => nameMatch(e, pn, dk, mk));
          if (hit) return absorb(hit, rec);
        }
        if (!mk && !(pn && pn.last)) return null;
        return absorb(newEntity(), rec);
      },
      toMappingRows() {
        return entities.map((e) => ({ Code: e.code, SurrogateName: e.fakeLast ? `${e.fakeLast}, ${e.fakeFirst}` : '', RealName: [...e.names].join('; '), MRN: [...e.mrns].join('; '), DOB: [...e.dobs].join('; '), Account: [...e.accounts].join('; '), Phone: [...e.phones].join('; '), DateOffsetDays: e.offset == null ? '' : e.offset }));
      },
    };
    (seedRows || []).forEach((r) => {
      if (!r || !r.Code) return;
      const e = newEntity(); e.code = String(r.Code).trim();
      const num = parseInt(e.code.replace(/\D/g, ''), 10); if (!isNaN(num) && num >= next) next = num + 1;
      String(r.MRN || '').split(/;\s*/).filter(Boolean).forEach((m) => absorb(e, { mrn: m }));
      String(r.RealName || '').split(/;\s*/).filter(Boolean).forEach((nm) => absorb(e, { name: nm }));
      String(r.DOB || '').split(/;\s*/).filter(Boolean).forEach((d) => absorb(e, { dob: d }));
      String(r.Account || '').split(/;\s*/).filter(Boolean).forEach((a) => e.accounts.add(a));
      String(r.Phone || '').split(/;\s*/).filter(Boolean).forEach((p) => e.phones.add(p));
      if (r.SurrogateName) { const [l, f] = String(r.SurrogateName).split(/,\s*/); e.fakeLast = l || null; e.fakeFirst = f || null; if (l) taken.add(l.toLowerCase()); if (f) taken.add(f.toLowerCase()); }
      if (r.DateOffsetDays !== '' && r.DateOffsetDays != null && !isNaN(+r.DateOffsetDays)) e.offset = +r.DateOffsetDays;
      e.names.forEach((nm) => { const pn = parseName(nm); if (pn) [pn.first, pn.last].forEach((t) => t && realWords.add(t.toLowerCase())); });
    });
    ((seedExtra && seedExtra.providers) || []).forEach((r) => {
      if (!r || !r.SurrogateName || !r.RealName) return;
      const pn = parseName(String(r.RealName)); if (!pn || !pn.last) return;
      const [fl, ff] = String(r.SurrogateName).split(/,\s*/);
      const key = `${pn.last}|${pn.first}`.toLowerCase();
      providers.set(key, { key, code: String(r.Code || `Dr. ${String.fromCharCode(65 + (providers.size % 26))}`), fakeFirst: ff || '', fakeLast: fl || '', last: pn.last, first: pn.first, credentials: String(r.Credential || pn.credentials || '') });
      if (fl) { taken.add(fl.toLowerCase()); tokenMap.set(pn.last.toLowerCase(), fl); }
      if (ff && pn.first) { taken.add(ff.toLowerCase()); tokenMap.set(pn.first.toLowerCase(), ff); }
    });
    ((seedExtra && seedExtra.others) || []).forEach((r) => {
      if (!r || !r.Surrogate || !r.Original) return;
      const type = String(r.Type || ''), orig = String(r.Original), fake = String(r.Surrogate);
      if (type === 'NAME') { if (!tokenMap.has(orig.toLowerCase())) tokenMap.set(orig.toLowerCase(), fake); }
      else strings.set(`${type}|${orig.toLowerCase()}`, { Type: type, Original: orig, Surrogate: fake });
      fake.toLowerCase().split(/[^a-z]+/).forEach((w) => { if (w.length >= 3) taken.add(w); });
    });
    return reg;
  }

  // ---------------------------------------------------------------------
  // 5c. Text documents (pasted text or OCR output) -> table with a line census
  // ---------------------------------------------------------------------
  const LINE_NAME_RE = /(?<![\w,])([A-Z][A-Za-z'’\-]+(?:[ -][A-Z][A-Za-z'’\-]+)?),\s*([A-Z][A-Za-z'’\-]+)(?:\s+([A-Z])\b\.?|\s([A-Z][A-Z'’\-]+)(?=\s|$))?(?![\w,])/g;
  const STREET_SUFFIX_WORD = /^(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail|Pike|Row|Sq|Square|Box)\.?$/i;
  const LINE_ID_RE = /(?<![\w\/\-.:])(?:MRN\s*[:#]?\s*)?([A-Z]{0,2}[0-9OIlSB]{6,10})(?![\w\/\-:])(?!\.[\w])/g;
  // a labelled MRN may be written with internal spaces or hyphens ("MRN#0041 2345", "MRN: 0041-2345")
  const LINE_MRN_LABEL_RE = /\b(?:MRN|MR#|Med\s*Rec(?:ord)?\s*(?:No\.?|Num\.?|#)?)\s*[:#]?\s*([A-Z]{0,2}[0-9OIlSB](?:[ \-]?[0-9OIlSB]){5,9})(?![\w\/\-:])(?!\.[\w])/gi;
  const LINE_CRED_AFTER = /^\s*,?\s*(?:MD|DO|NP|PA-C|PA|RN|LPN|BSN|MSN|DNP|APRN|CRNP|CNP|ARNP|PharmD|RPh|MSW|LCSW|FNP|ANP|PhD|DDS|DPM)\b/;
  const LINE_PROVIDER_BEFORE = /\b(?:per|dr\.?|doctor|called|call|with|w\/|by|see|seen|spoke|attending|pcp|provider|md|np|rn|onc|oncologist|referred|referral|signed|cc)\s*[:\-]?\s*$/i;
  const LINE_LABEL_BEFORE = /(?:^|\b(?:pt|patient|name|re|regarding|for|contact))\s*[:#\-]?\s*$/i;
  const LINE_LABEL_WORD = /^(?:dob|mrn|mr|med|rec|record|records|acct|account|csn|har|fin|id|member|subscriber|policy|group|plan|payer|payor|coverage|insurance|ins|ssn|phone|fax|cell|home|work|email|address|addr|age|sex|dx|diagnosis|allergies|allergy|regimen|cycle|day|date|time|appt|visit|status|room|chair|bay|pod|unit|bed|order|orders|ordered|referring|referral|attending|provider|pcp|note|notes|comment|comments|name|patient|pt|male|female)$/i;
  function parseTextDocument(text, opts) {
    const o = Object.assign({ carryForward: true, mrnPattern: null, sectionMarker: /^===/ }, opts || {});
    const lines = cellToString(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    const mrnRe = o.mrnPattern ? new RegExp(o.mrnPattern.replace(/^\\b|\\b$/g, ''), 'g') : null;
    const thisYear = new Date().getFullYear();
    const rows = []; let current = null; let found = 0, inherited = 0;
    // A name cell that wrapped in a narrow table column: "08:00   Teresa   12710386 ..." then "Stewart   09" on the
    // next line (or "Reynolds,   5749277 ..." then "Deepa"). Rebuild the name from the two fragments.
    const WRAP_HEAD = /([A-Z][A-Za-z'’\-]+,?)(?:[ \t]([A-Z][A-Za-z'’\-]+,?))?[ \t]{2,}$/;
    const WRAP_TAIL = /^[ \t]*([A-Z][A-Za-z'’\-]+(?:[ \t][A-Z][A-Za-z'’\-]+)?)(?=[ \t]{2,}|[ \t]*$|[ \t]+\d{1,4}[ \t]*$)/;
    const NOT_NAME = /^(name|patient|pt|mrn|dob|date|time|appt|regimen|order|comments?|chair|cycle|day|dept|attending|provider)$/i;
    const wrappedName = (line, idIndex, next) => {
      const head = line.slice(0, idIndex).match(WRAP_HEAD);
      if (!head || next == null) return '';
      const frag1 = head[0].trim().replace(/\s{2,}.*$/, '');
      if (frag1.split(/[ ,]+/).some((w) => w && (NOT_NAME.test(w) || monthIndex(w) || LEX.CREDENTIAL_SET.has(w.toLowerCase())))) return '';
      if (/(?<![\w\/\-.:])[A-Z]{0,2}[0-9OIlSB]{6,10}(?![\w\/\-.:])/.test(next) || /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/.test(next)) return '';
      const tail = next.match(WRAP_TAIL);
      if (!tail || tail[1].split(/\s+/).some((w) => NOT_NAME.test(w) || LEX.isClinical(w) || monthIndex(w))) return '';
      return `${frag1} ${tail[1]}`.replace(/\s+/g, ' ').trim();
    };
    const isMarker = (line) => !!(o.sectionMarker && o.sectionMarker.test(line));
    const firstLastBeforeId = (line) => {
      const m = line.match(/((?:\p{Lu}[\p{L}'’\-]*[ \t]+){1,4}\p{Lu}[\p{L}'’\-]+)[ \t]*[,(]?[ \t]*(?:MRN|MR#|DOB|D\.O\.B)\b/u);
      if (!m) return '';
      const bad = (w) => !w || LINE_LABEL_WORD.test(w) || NOT_NAME.test(w) || !!monthIndex(w) || COMMON_CAP.has(w.toLowerCase()) || LEX.CREDENTIAL_SET.has(w.toLowerCase()) || LEX.HONORIFIC_SET.has(w.toLowerCase().replace(/\.$/, '')) || LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) || LEX.STATE_ABBR_SET.has(w) || LEX.RELATION_SET.has(w.toLowerCase()) || (LEX.isClinical(w) && !LEX.isSurname(w) && !LEX.isFirstName(w));
      const words = m[1].trim().split(/[ \t]+/);
      while (words.length && bad(words[0])) words.shift();
      if (words.length < 2 || words.length > 4 || words.some(bad) || words.some((w) => w.length < 2)) return '';
      const before = line.slice(0, m.index + m[1].indexOf(words[0]));
      if (LINE_PROVIDER_BEFORE.test(before)) return '';
      return words.join(' ');
    };
    const nameWordBad = (w) => !w || LINE_LABEL_WORD.test(w) || NOT_NAME.test(w) || LEX.isClinical(w) || !!monthIndex(w) || COMMON_CAP.has(w.toLowerCase()) || LEX.CREDENTIAL_SET.has(w.toLowerCase()) || LEX.HONORIFIC_SET.has(w.toLowerCase()) || LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) || LEX.STATE_ABBR_SET.has(w);
    // every "Last, First" on a line that has the structure of a census entry (first is the line's patient)
    const lineNames = (line) => {
      const out = [];
      const hasIdOnLine = /\b(?:mrn|dob|acct|csn)\b/i.test(line) || /(?<![\w\/\-.:])[A-Z]{0,2}[0-9OIlSB]{6,10}(?![\w\/\-.:])/.test(line) || /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/.test(line);
      LINE_NAME_RE.lastIndex = 0; let m;
      while ((m = LINE_NAME_RE.exec(line))) {
        let last = m[1], first = m[2], mText = m[0], mIndex = m.index;
        // "PT HUYNH,THANH LOAN": a label word in front of the surname is not part of it
        const lab = last.match(/^(?:PT|Pt|Patient|PATIENT|Name|NAME|RE|Re)[ ]+/);
        if (lab) { last = last.slice(lab[0].length); mText = mText.slice(lab[0].length); mIndex += lab[0].length; }
        // a second all-caps given name ("THANH LOAN") belongs to an all-caps name only, and never a label word ("SMITH, JOHN MRN")
        if (m[4] && !(last === last.toUpperCase() && first === first.toUpperCase() && !LINE_LABEL_WORD.test(m[4]) && !LEX.isClinical(m[4]) && !LEX.CREDENTIAL_SET.has(m[4].toLowerCase()) && !LEX.STATE_ABBR_SET.has(m[4]) && m[4].length >= 3)) mText = mText.slice(0, mText.length - m[4].length).trimEnd();
        // "52 Birchwood Ln, Tisbury": a street and its town, not "Last, First"
        if (last.split(/[ -]/).some((w) => STREET_SUFFIX_WORD.test(w))) continue;
        const after = line.slice(m.index + m[0].length), before = line.slice(0, mIndex);
        // a clinician ("per Bruno, Georgiana MD", "Dr. Lee, Karen") is not a new patient
        if (LINE_CRED_AFTER.test(after) || LINE_PROVIDER_BEFORE.test(before)) continue;
        if (LEX.STATE_ABBR_SET.has(first) || LEX.CREDENTIAL_SET.has(first.toLowerCase()) || LEX.HONORIFIC_SET.has(last.toLowerCase())) continue;
        // a label or form word is not half of a name ("Health Plan, Member ID ...", "Van Minh, DOB 03041951")
        if ([last, first].some((w) => LINE_LABEL_WORD.test(w) || LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) || /^(?:thanks|thank|thx|regards|sincerely|cheers|hi|hello|hey|dear|yes|no|ok|okay|please|sorry|also|then|today|tomorrow|yesterday|tonight)$/i.test(w))) continue;
        // "this is Bobby, Roberta Szymanski's grandson": the pair runs on into another name, so it is not "Last, First"
        if (/^\s+[A-Z][a-z][A-Za-z'’\-]*(?:['’]s\b|\s+[a-z])/.test(after) && !m[3]) continue;
        if (first.length < 2 && !m[3]) continue;
        // structural evidence: a column gap, pipe, identifier, DOB or label right beside the pair. It overrides the
        // word lists, so "Bell, Kevin  MRN 032767781" and "Hill, Rose  84445786" are captured.
        const structural = mIndex === 0 || /\b(?:from|message|msg|re|for|regarding)\b[^.]{0,40}\(\s*$/i.test(before) && /^\s*\)/.test(after) || /^\s{2,}|^\s*[|\t]|^\s*\(?\s*(?:MRN|DOB|Acct|CSN|ID|MR#)\b|^\s*#?\s*[A-Z]{0,2}[0-9OIlSB]{6,10}(?![\w])|^\s*\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/i.test(after) || LINE_LABEL_BEFORE.test(before) || /(?:\s{2,}|[|\t]\s*)$/.test(before);
        if (!structural && (LEX.isClinical(last) || LEX.isClinical(first) || LEX.CITY_SET.has(last.toLowerCase()))) continue;
        out.push({ text: mText.trim(), index: mIndex, structural, hasIdOnLine });
      }
      return out;
    };
    // "First Last" tiles side by side, separated by wide gaps ("Seraphina Hollenbeck      Tobiah Oyelaran      Eulalia Castellanos-Ruiz")
    const segmentNames = (line) => {
      const segs = []; const re = /(?:^|\s{3,})([A-Z][a-z'’]+(?:[ \-][A-Z][A-Za-z'’]+){1,2})(?=\s{3,}|\s*$)/g; let m;
      while ((m = re.exec(line))) { if (!m[1].split(/[ \-]/).some(nameWordBad)) segs.push({ text: m[1], index: m.index + m[0].length - m[1].length }); re.lastIndex = m.index + m[0].length; }
      return segs;
    };
    const lineIds = (line) => {
      const ids = [];
      const scan = (re, groupIdx) => { re.lastIndex = 0; let k; while ((k = re.exec(line))) { const raw = k[groupIdx] || k[0]; const norm = normalizeId(raw); const dcount = (norm.match(/\d/g) || []).length; if (dcount < 6) continue; const before = line.slice(Math.max(0, k.index - 6), k.index); const index = k.index + k[0].length - raw.length; if (ids.some((x) => x.norm === norm && Math.abs(x.index - index) < 12)) continue; ids.push({ raw, norm, labeled: /mrn/i.test(k[0]) || /mrn\s*[:#]?\s*$/i.test(before), index }); } };
      scan(LINE_MRN_LABEL_RE, 1);
      if (mrnRe) scan(mrnRe, 0);
      scan(LINE_ID_RE, 1);
      const phoneLike = (t) => /^\d{10}$/.test(t.norm) && (/\d{3}[-.\s]\d{3}[-.\s]\d{4}|\(\d{3}\)/.test(line) || /\b(?:fax|phone|ph|tel|cell|mobile|home|work|call|text|pager)\s*[:#.]?\s*$/i.test(line.slice(Math.max(0, t.index - 12), t.index)));
      // a number labelled as some other identifier (ref, SN, member/insurance ID, DL, auth, claim, CSN, account) is not the
      // patient's record number, so it does not make a patient whose name was "not read"
      const otherLabel = (t) => !t.labeled && /\b(?:ref|reference|sn|s\/n|serial|member|subscriber|policy|insurance|aetna|bcbs|medicaid|medicare|mbi|id|dl|lic|license|licence|plate|placard|auth|authorization|claim|conf|confirmation|order|lot|ndc|csn|har|acct|account|fin|encounter|group|grp|npi|dea|badge|tracking|invoice|rx)\s*(?:#|no\.?|num\.?|number)?\s*[:#]?\s*$/i.test(line.slice(Math.max(0, t.index - 24), t.index));
      return ids.filter((t) => !phoneLike(t) && !otherLabel(t) && !/^\d{4}-\d{2}-\d{2}$/.test(t.raw));
    };
    const lineDates = (line) => ruleSpans(line, { mrnRegex: null, accountRegex: null, extraRegexes: [] }).filter((sp) => (sp.type === 'DATE' || sp.type === 'DOB') && sp.date && sp.date.hasYear && sp.date.y <= thisYear - 1 && sp.date.y >= 1900);
    const info = lines.map((line) => isMarker(line) ? null : { names: lineNames(line), segs: segmentNames(line), ids: lineIds(line), dates: lineDates(line) });

    // A name that wrapped over two or three lines of a narrow first column: "0800 Kowalczyk-" / "Hartley, Rosalind |MRN" /
    // "Esperanza   40071823", or "1000 | Ibarrondo   01/05/1962" / "Etxeberria,   MRN" / "Teodoro   40115569".
    const FRAG_TOK = "[A-Z][A-Za-z'’]*(?:-[A-Z][A-Za-z'’]*)*-?,?";
    const LEAD_RE = new RegExp(`^\\s*(?:(?:\\d{3,4}|\\d{1,2}:\\d{2})\\s*)?[|\\[\\]'!]*\\s*(${FRAG_TOK}(?:\\s${FRAG_TOK}){0,3})(?=\\s{2,}|\\s*[|\\[\\]'!]|\\s+\\d|\\s*$)`);
    const lead = (li) => {
      if (li >= lines.length || !info[li]) return null;
      const m = lines[li].match(LEAD_RE); if (!m) return null;
      const words = m[1].split(/\s+/).map((w) => w.replace(/[-,]+$/, '')).flatMap((w) => w.split('-'));
      if (words.some((w) => nameWordBad(w) || w.length < 2)) return null;
      return { text: m[1], rest: lines[li].slice(m.index + m[0].length) };
    };
    const override = new Map();
    for (let li = 0; li < lines.length; li++) {
      if (override.has(li)) continue;
      const L = lead(li); if (!L) continue;
      const N1 = lead(li + 1); if (!N1) continue;
      if (!(/[-,]$/.test(L.text) || (!L.text.includes(',') && /,$/.test(N1.text)))) continue;
      let acc = L.text; const chain = [li];
      for (let n = li + 1; n < lines.length && chain.length < 4; n++) {
        const N = lead(n); if (!N) break;
        if (/-$/.test(acc)) acc += N.text;
        else if (/,$/.test(acc)) acc += ' ' + N.text;
        else if (!acc.includes(',') && /,$/.test(N.text)) acc += ' ' + N.text;
        else if (/,\s*\S/.test(acc) && /^[A-Z][a-z'’]+$/.test(N.text) && !/[A-Za-z]{2,}/.test(N.rest.replace(/\b(?:MRN|MR|DOB|ID)\b/gi, ''))) acc += ' ' + N.text;
        else break;
        chain.push(n);
      }
      acc = acc.replace(/,$/, '').trim();
      if (chain.length < 2 || !/^[^,]+,\s*[A-Z]/.test(acc) || /-$/.test(acc)) continue;
      const ovRec = { name: acc, chain }; chain.forEach((n) => override.set(n, ovRec));
      li = chain[chain.length - 1];
    }
    // Tiles in a grid: k names on one line and exactly k record numbers (or birthdates) on one of the next two lines are
    // k patients, paired in reading order. Without an exact count match nothing is paired: a wrong pair is a merge.
    const grid = new Map(); // line index -> [{ name, mrn, dob }] in reading order
    for (let li = 0; li < lines.length; li++) {
      if (!info[li]) continue;
      const names = info[li].names.filter((x) => x.structural).length >= 2 ? info[li].names.filter((x) => x.structural) : info[li].segs;
      const k = names.length; if (k < 2) continue;
      const recs = names.map((x) => ({ name: x.text, mrn: '', dob: '', lines: [li] }));
      let paired = false;
      for (let n = li + 1; n <= li + 3 && n < lines.length && info[n]; n++) {
        if (info[n].names.length || info[n].segs.length >= 2) break;
        if (info[n].ids.length === k && recs.every((r) => !r.mrn)) { info[n].ids.forEach((t, q) => { recs[q].mrn = t.norm; recs[q].lines.push(n); }); paired = true; continue; }
        if (info[n].dates.length === k && recs.every((r) => !r.dob)) { info[n].dates.forEach((d, q) => { recs[q].dob = d.text; recs[q].lines.push(n); }); continue; }
      }
      // the same record numbers may sit on the name line itself ("Lindqvist, Saoirse  MRN 5520147    Thibodeaux, Augustin  MRN 5520391")
      if (!paired && info[li].ids.length === k) { info[li].ids.forEach((t, q) => { recs[q].mrn = t.norm; }); paired = true; }
      if (!paired) continue;
      recs[0].lines.forEach((n) => { if (!grid.has(n)) grid.set(n, recs); });
      recs.slice(1).forEach((r) => r.lines.forEach((n) => { if (!grid.has(n)) grid.set(n, recs); }));
    }
    const extras = [];
    const gridDone = new Set(), wrapExtras = new Map(); let pendingWrap = null;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!info[li]) { current = null; rows.push(['', '', '', line]); continue; }
      let name = '', mrn = '', dob = '';
      const g = grid.get(li);
      if (g) {
        // the line belongs to the first tile's patient; the other tiles are census entries of their own, tied to these lines
        if (!gridDone.has(g)) { gridDone.add(g); g.slice(1).forEach((r) => extras.push({ name: r.name, mrn: r.mrn, dob: r.dob, rows: r.lines.slice() })); }
        // a tile whose name wrapped onto the next line ("Abernathy-Sloane," / "Gwendolyn") beside the paired tiles is one more
        // patient; its record number is the first one on the line just under the wrapped name
        const gov = override.get(li);
        if (gov && !g.some((r) => r.name === gov.name) && !wrapExtras.has(gov)) {
          const rec = { name: gov.name, mrn: '', dob: '', rows: gov.chain.slice() };
          extras.push(rec); wrapExtras.set(gov, rec); pendingWrap = { rec, end: gov.chain[gov.chain.length - 1] };
        }
        name = g[0].name; mrn = g[0].mrn; dob = g[0].dob;
        current = { name, mrn, dob, li, rows: [li], grid: true }; found++;
        rows.push([name, mrn, dob, line]);
        continue;
      }
      const ov = override.get(li);
      const cand0 = info[li].names.find((x) => x.structural || x.hasIdOnLine || !current || !o.carryForward);
      // a mid-line pair with no identifier anywhere on the line, while a patient is being carried forward, is a
      // mention (a relative, a visitor), not a new census entry
      if (ov) name = ov.name;
      else if (cand0) name = cand0.text;
      // identifiers: explicit MRN label wins; else the first id-looking token that is not a phone/date/time
      const ids = info[li].ids.slice().sort((a, b) => (b.labeled - a.labeled) || (a.index - b.index));
      const pick = ids[0];
      if (pick && (name || pick.labeled || !o.requireNameForMrn)) mrn = pick.norm;
      if (pick && !name) name = wrappedName(line, pick.index, lines[li + 1]);
      // "First Last" right before its record number or birthdate ("for Rosalind Graves (MRN 66120934)", "PARK MI-SOOK (MRN
      // 8830217)", "Patient Dang Van Minh, DOB 03041951"): that is the line's patient, so the name is not "not read"
      if (!name && (pick || /\b(?:dob|d\.o\.b)\b/i.test(line))) name = firstLastBeforeId(line);
      // DOB: labeled, else a full date whose year makes an adult-ish age
      const dateSpans = ruleSpans(line, { mrnRegex: null, accountRegex: null, extraRegexes: [] }).filter((sp) => (sp.type === 'DATE' || sp.type === 'DOB') && sp.date && sp.date.hasYear);
      const labeled = dateSpans.find((sp) => sp.type === 'DOB' || /dob|birth|born/i.test(line.slice(Math.max(0, sp.start - 12), sp.start)));
      const cand = labeled || dateSpans.find((sp) => sp.date.y <= thisYear - 10 && sp.date.y >= 1900);
      if (cand && (name || mrn || labeled)) dob = cand.text;
      if (!name && mrn && pendingWrap && !pendingWrap.rec.mrn && li > pendingWrap.end && li - pendingWrap.end <= 2) {
        const rec = pendingWrap.rec; rec.mrn = mrn; rec.dob = dob; pendingWrap = null;
        current = { name: rec.name, mrn, dob, li, rows: [li] }; found++;
        rows.push([rec.name, mrn, dob, line]);
        continue;
      }
      // a wrapped name's lines share one record number and birthdate
      if (ov && current && current.ov === ov) { current.mrn = current.mrn || mrn; current.dob = current.dob || dob; current.rows.forEach((r) => { rows[r][1] = current.mrn; rows[r][2] = current.dob; }); current.rows.push(li); found++; rows.push([current.name, current.mrn, current.dob, line]); continue; }
      // a record number or labelled birthdate on its own line just under a patient whose number was not on the name line
      // ("Name: Strand-Okonjo, Evangeline M" / "DOB: 04/18/1966" / "MRN: 92210874"): it is that patient's
      if (!name && (mrn || labeled) && current && current.name && !current.grid && li - current.li <= 3 && ((mrn && !current.mrn) || (!mrn && labeled && !current.dob))) {
        if (mrn) current.mrn = mrn;
        if (dob && !current.dob) current.dob = dob;
        current.rows.forEach((r) => { rows[r][1] = current.mrn; rows[r][2] = current.dob; });
        current.rows.push(li); inherited++;
        rows.push([current.name, current.mrn, current.dob, line]);
        continue;
      }
      if (name || mrn) { current = { name, mrn, dob, li, rows: [li], ov }; found++; }
      else if (current && o.carryForward) { inherited++; current.rows.push(li); }
      const use = (name || mrn) ? { name, mrn, dob } : (current && o.carryForward ? current : { name: '', mrn: '', dob: '' });
      rows.push([use.name, use.mrn, use.dob, line]);
    }
    rows.extras = extras;
    const headers = ['Patient Name', 'MRN', 'DOB', 'Line'];
    const columns = [{ header: 'Patient Name', index: 0, role: 'patient_name', reason: 'extracted from line', sample: [] }, { header: 'MRN', index: 1, role: 'mrn', reason: 'extracted from line', sample: [] }, { header: 'DOB', index: 2, role: 'dob', reason: 'extracted from line', sample: [] }, { header: 'Line', index: 3, role: 'text', reason: 'the text itself', sample: [] }];
    return { headers, rows, columns, extras, stats: { lines: lines.length, linesWithPatient: found, linesInherited: inherited, gridPatients: extras.length } };
  }

  // Screen-reader misreads that turn clinical shorthand into nonsense: "g21 days" for q21 days, "stage Ill" for stage III.
  // Applied to OCR output only, before detection, so the protected text keeps the clinical meaning.
  function normalizeOcrText(text) {
    return cellToString(text)
      .replace(/(?<![A-Za-z\d])g(\d{1,2})(\s*)(h|hr|hrs|hours?|d|days?|wk|wks|weeks?|mo|months?)\b/g, 'q$1$2$3')
      .replace(/\b(stage|grade|class|type|phase|cycle)(\s+)(?:Ill|IIl|lIl|lll)\b/gi, '$1$2III')
      .replace(/\b(stage|grade|class|type|phase)(\s+)(?:Il|lI|ll)\b/gi, '$1$2II')
      // a given name that starts with a capital I read as a lower-case l after "Surname, " ("Ferreira, lolanthe", "Lowe, lngrid")
      .replace(/(\b\p{Lu}[\p{L}'’\-]+,[ \t]*)l(?=([a-z])[a-z]{2,}\b)/gu, (m, pre, c2, off, str) => {
        const w = str.slice(off + m.length - 1).match(/^l[a-z]+/)[0];
        if (/[aeiouy]/.test(c2) && (w.length < 5 || /^(?:left|later|latest|labs|lower|lives|living|lunch|leave|level|liver|local|light|legal|lasix|loading|lovenox|lorazepam|lidocaine|losartan|lisinopril|lupron|lymph)/.test(w))) return m;
        return pre + 'I';
      });
  }

  // ---------------------------------------------------------------------
  // 6. Whole-table processing
  // ---------------------------------------------------------------------
  function defaultConfig(overrides) {
    const base = {
      columns: [],
      mrnPattern: null,
      accountPattern: null,
      extraPatterns: [],
      allowlist: [],
      denylist: [],
      seed: 12345,
      layers: { census: true, rules: true, model: true, propagate: true },
      surrogate: { patients: 'fake', providers: 'fake', dob: 'drop', ages: '90plus', dateShift: true, shiftRange: [30, 365] },
      deriveAge: true,
      auditColumn: true,
      auditDetail: false,
    };
    const cfg = Object.assign({}, base, overrides || {});
    cfg.layers = Object.assign({}, base.layers, (overrides && overrides.layers) || {});
    cfg.surrogate = Object.assign({}, base.surrogate, (overrides && overrides.surrogate) || {});
    return cfg;
  }

  function compileConfig(cfg) {
    const c = Object.assign({}, cfg);
    const mk = (src) => { if (!src) return null; try { return new RegExp(src, 'g'); } catch (e) { return null; } };
    c.mrnRegex = mk(cfg.mrnPattern);
    c.accountRegex = mk(cfg.accountPattern);
    c.extraRegexes = (cfg.extraPatterns || []).map((p) => mk(typeof p === 'string' ? p : p.regex)).filter(Boolean);
    c.allowSet = new Set((cfg.allowlist || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
    c.denySet = new Set((cfg.denylist || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
    return c;
  }

  function bandAge(v, mode) {
    const s = cellToString(v).trim();
    const n = parseInt(s, 10);
    if (isNaN(n)) return s;
    if (n >= 90) return '90+';
    if (mode === 'bands5') return `${Math.floor(n / 5) * 5}-${Math.floor(n / 5) * 5 + 4}`;
    if (mode === 'bands10') return `${Math.floor(n / 10) * 10}-${Math.floor(n / 10) * 10 + 9}`;
    return s;
  }
  function ageFrom(dob, ref) {
    let a = ref.getFullYear() - dob.getFullYear();
    const m = ref.getMonth() - dob.getMonth();
    if (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) a--;
    return a;
  }

  function processTable(table, userCfg) {
    const cfg = compileConfig(defaultConfig(userCfg));
    const headers = table.headers.map((h) => cellToString(h));
    const rows = table.rows;
    let columns = cfg.columns && cfg.columns.length === headers.length ? cfg.columns.map((c, i) => ({ header: headers[i], index: i, role: c.role || c })) : classifyColumns(headers, rows);
    const registry = cfg.registry || createRegistry();
    const census = buildCensus(headers, rows, columns, { registry });
    if (!cfg.mrnPattern && census.mrnCols.length) {
      const inferred = inferIdPattern(rows.map((r) => r[census.mrnCols[0]]));
      cfg.mrnRegex = inferred ? new RegExp(inferred, 'g') : null;
      cfg.inferredMrnPattern = inferred;
    }
    if (!cfg.accountPattern && census.acctCols.length) {
      const inferred = inferIdPattern(rows.map((r) => r[census.acctCols[0]]));
      cfg.accountRegex = inferred ? new RegExp(inferred, 'g') : null;
    }

    const textCols = columns.filter((c) => c.role === 'text').map((c) => c.index);
    const dateCols = columns.filter((c) => c.role === 'date').map((c) => c.index);
    const ageCols = columns.filter((c) => c.role === 'age').map((c) => c.index);
    const zipCols = columns.filter((c) => c.role === 'zip').map((c) => c.index);
    const dropCols = columns.filter((c) => c.role === 'drop').map((c) => c.index);

    // Pass 1: detect in all free-text cells (no propagation yet)
    const ctx = { cfg, census, propagateRegex: null, rowPatientKey: null, manual: cfg.manual || null, cellKey: null };
    const firstPass = rows.map((row, ri) => { ctx.rowPatientKey = census.rowPatient[ri]; ctx.rowExtraKeys = census.rowExtra[ri]; return textCols.map((ci) => { ctx.cellKey = `${ri}:${ci}`; return detectText(cellToString(row[ci]), ctx); }); });
    if (cfg.layers.propagate) {
      const all = columnNameSpans(headers, rows, columns); firstPass.forEach((cells) => cells.forEach((sp) => all.push(...sp)));
      ctx.propagateRegex = collectPropagation(all, cfg);
      // word-names (Grace, Hope) are re-found only in the row where their full name was found
      ctx.rowAmbiguousList = firstPass.map((cells) => { const r = collectPropagation(cells.flat(), cfg); return r ? r.ambiguous : null; });
    }
    // Document text for surrogate collision avoidance
    const docText = rows.map((r) => r.map(cellToString).join(' ')).join('\n');
    const sur = Surrogator(cfg, census, docText);
    // Register patients in census order so codes are stable
    [...census.patients.values()].sort((a, b) => a.order - b.order).forEach((p) => sur.patient(p.key));
    [...census.providers.values()].sort((a, b) => a.order - b.order).forEach((p) => sur.provider(p.key));

    const outRows = [], details = [];
    const stats = { rows: rows.length, cells: 0, spans: 0, byType: {}, bySource: {}, structured: {} };
    const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

    rows.forEach((row, ri) => {
      const pk = census.rowPatient[ri];
      ctx.rowPatientKey = pk; ctx.rowExtraKeys = census.rowExtra[ri];
      const pInfo = pk ? sur.patient(pk) : null;
      const offset = sur.offsetFor(pk);
      const out = row.slice();
      const detail = { row: ri, patientCode: pInfo ? pInfo.code : '', offset, cells: [], structured: [] };
      // Structured columns
      columns.forEach((col) => {
        const ci = col.index, v = row[ci];
        if (v == null || v === '') return;
        const sv = cellToString(v);
        switch (col.role) {
          case 'patient_name': { out[ci] = pk ? (cfg.surrogate.patients === 'code' ? pInfo.code : (() => { const p = census.patients.get(pk); const parsed = parseName(sv); const info = pInfo; if (!parsed) return `${info.fakeLast}, ${info.fakeFirst}`; return parsed.format === 'last_first' ? (parsed.upper ? `${info.fakeLast}, ${info.fakeFirst}`.toUpperCase() : `${info.fakeLast}, ${info.fakeFirst}`) : parsed.format === 'single' ? info.fakeLast : (parsed.upper ? `${info.fakeFirst} ${info.fakeLast}`.toUpperCase() : `${info.fakeFirst} ${info.fakeLast}`); })()) : '[name]'; detail.structured.push([col.header, 'NAME']); bump(stats.structured, 'NAME'); break; }
          case 'mrn': out[ci] = pInfo ? pInfo.code : '[mrn]'; detail.structured.push([col.header, 'MRN']); bump(stats.structured, 'MRN'); break;
          case 'account': out[ci] = pInfo ? `A-${pInfo.code}` : '[acct]'; bump(stats.structured, 'ACCOUNT'); break;
          case 'phone': out[ci] = sur.replace({ type: 'PHONE', start: 0, end: sv.length }, sv, pk); bump(stats.structured, 'PHONE'); break;
          case 'provider': {
            out[ci] = sv.split(/(\s*[;\/]\s*|\s+and\s+)/).map((part, idx) => { if (idx % 2 === 1) return part; const parsed = parseName(part); if (!parsed || !parsed.last) return part; const k = `${parsed.last}|${parsed.first}`.toLowerCase(); return census.providers.has(k) ? sur.replace({ type: 'NAME_PROVIDER', entity: k, start: 0, end: part.length }, part, pk) : sur.replace({ type: 'NAME_PROVIDER', start: 0, end: part.length }, part, pk); }).join('');
            bump(stats.structured, 'PROVIDER'); break;
          }
          case 'dob': {
            const d = isDate(v) ? v : parseDateString(sv);
            if (cfg.surrogate.dob === 'drop' || !d) out[ci] = '';
            else if (cfg.surrogate.dob === 'year') out[ci] = String(d.getFullYear());
            else if (cfg.surrogate.dob === 'shift') out[ci] = isDate(v) ? shiftDate(d, offset) : sur.replace({ type: 'DOB', start: 0, end: sv.length }, sv, pk);
            else out[ci] = '';
            bump(stats.structured, 'DOB'); break;
          }
          case 'date': {
            if (isDate(v)) out[ci] = cfg.surrogate.dateShift ? shiftDate(v, offset) : '';
            else { const r = applySpans(sv, detectText(sv, ctx).filter((s) => COARSE(s.type) === 'DATE'), (s) => sur.replace(s, sv, pk)); out[ci] = r.text; }
            bump(stats.structured, 'DATE'); break;
          }
          case 'age': out[ci] = bandAge(v, cfg.surrogate.ages); bump(stats.structured, 'AGE'); break;
          case 'zip': out[ci] = sv.replace(/\d{5}(-\d{4})?/, (z) => z.slice(0, 3) + '00'); bump(stats.structured, 'ZIP'); break;
          case 'drop': out[ci] = ''; bump(stats.structured, 'DROP'); break;
          default: break;
        }
      });
      // Free text
      textCols.forEach((ci, ti) => {
        const text = cellToString(row[ci]);
        if (!text) return;
        stats.cells++;
        ctx.cellKey = `${ri}:${ci}`;
        ctx.rowAmbiguous = ctx.rowAmbiguousList ? ctx.rowAmbiguousList[ri] : null;
        const spans = cfg.layers.propagate ? detectText(text, ctx) : firstPass[ri][ti];
        const r = applySpans(text, spans, (s) => sur.replace(s, text, pk));
        out[ci] = r.text;
        spans.forEach((s) => { stats.spans++; bump(stats.byType, s.type); bump(stats.bySource, s.source.split('+')[0]); });
        detail.cells.push({ col: ci, header: headers[ci], original: text, output: r.text, spans, replacements: r.replacements });
      });
      // Derived age column if requested and no age column present
      if (cfg.deriveAge && !ageCols.length && census.dobCols.length && pk) {
        const p = census.patients.get(pk);
        const dob = p && p.dob ? (isDate(p.dob) ? p.dob : parseDateString(cellToString(p.dob))) : null;
        const refCell = dateCols.length ? row[dateCols[0]] : null;
        const ref = refCell ? (isDate(refCell) ? refCell : parseDateString(cellToString(refCell))) : new Date();
        detail.derivedAge = dob && ref ? bandAge(ageFrom(dob, ref), cfg.surrogate.ages) : '';
      }
      // Audit
      if (cfg.auditColumn) {
        const counts = {}; detail.cells.forEach((c) => c.spans.forEach((s) => bump(counts, COARSE(s.type))));
        const srcs = {}; detail.cells.forEach((c) => c.spans.forEach((s) => bump(srcs, s.source.split(':')[0].split('+')[0])));
        const parts = [detail.patientCode || '-', Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ') || 'no text PHI', Object.entries(srcs).map(([k, v]) => `${k}:${v}`).join(' '), cfg.surrogate.dateShift ? 'dates shifted' : 'dates removed']; // never the offset itself: with it, anyone could undo the shift
        detail.audit = parts.filter(Boolean).join(' | ');
        if (cfg.auditDetail) detail.audit += ' | ' + detail.cells.flatMap((c) => c.replacements.map((r) => `${r.type}:"${r.original}"→"${r.replacement}"`)).join('; ');
      }
      outRows.push(out); details.push(detail);
    });

    // Assemble output headers/rows: drop columns stay but blank; add derived age + audit
    const outHeaders = headers.slice();
    const addDerived = cfg.deriveAge && !ageCols.length && census.dobCols.length;
    if (addDerived) { outHeaders.push('Age (derived)'); outRows.forEach((r, i) => { r.push(details[i].derivedAge || ''); }); }
    if (cfg.auditColumn) { outHeaders.push('DeID Audit'); outRows.forEach((r, i) => { r.push(details[i].audit || ''); }); }

    const mapping = sur.mapping;
    // the registry is the session-wide key: every patient linked so far, with codes, surrogates and offsets, and every
    // provider, third-party name, organization, place and identifier replaced in any input of the session
    mapping.patients = registry.toMappingRows();
    mapping.providers = registry.toProviderRows();
    mapping.others = registry.toOtherRows();
    mapping.meta = { seed: cfg.seed, processedAt: new Date().toISOString(), documentOffsetDays: sur.docOffset, mrnPattern: cfg.inferredMrnPattern || cfg.mrnPattern || '', columns: columns.map((c) => ({ header: c.header, role: c.role })) };
    return { headers: outHeaders, rows: outRows, columns, census, details, stats, mapping, cfg, registry };
  }

  // Re-identify: reverse the mapping on a de-identified table.
  function reidentify(table, mapping) {
    const headers = table.headers.map(cellToString);
    const roles = new Map((mapping.meta && mapping.meta.columns || []).map((c) => [c.header, c.role]));
    const byCode = new Map(mapping.patients.map((p) => [String(p.Code).trim(), p]));
    const reverse = [];
    const firstOf = (v) => String(v || '').split(/;\s*/)[0];
    const add = (fake, real, isName) => { if (fake && real) reverse.push([String(fake), String(real), isName !== false]); };
    const realParts = (real) => { const pn = parseName(real); return pn ? { first: pn.first, last: pn.last, mid: pn.middle } : { first: '', last: real, mid: '' }; };
    mapping.patients.forEach((p) => {
      const real = firstOf(p.RealName), mrn = firstOf(p.MRN); const rp = realParts(real);
      const [l, f] = String(p.SurrogateName || '').split(/,\s*/);
      add(p.SurrogateName, real);
      if (f) { add(`${f} ${l}`, rp.first ? `${rp.first} ${rp.last}` : real); add(`${l}, ${f}`, real); add(f, rp.first || ''); add(l, rp.last || real); add(`${f[0]}. ${l}`, rp.first ? `${rp.first[0]}. ${rp.last}` : ''); add(`${f} ${l[0]}.`, rp.first ? `${rp.first} ${rp.last[0]}.` : ''); add(`${f[0]}.${l[0]}.`, rp.first ? `${rp.first[0]}.${rp.last[0]}.` : ''); }
      add(p.Code, mrn || real, false); add(`A-${p.Code}`, firstOf(p.Account) || '', false);
    });
    (mapping.providers || []).forEach((p) => {
      const rp = realParts(p.RealName); const realBare = rp.first ? `${rp.last}, ${rp.first}` : rp.last; // credentials stay in the cell
      const [l, f] = String(p.SurrogateName || '').split(/,\s*/);
      add(p.SurrogateName, realBare); if (f) { add(`${f} ${l}`, rp.first ? `${rp.first} ${rp.last}` : rp.last); add(l, rp.last); add(f, rp.first); add(`${f[0]}. ${l}`, rp.first ? `${rp.first[0]}. ${rp.last}` : ''); }
      if (p.Code) add(p.Code, realBare);
    });
    (mapping.others || []).forEach((o) => add(o.Surrogate, o.Original, o.Type === 'NAME'));
    reverse.sort((a, b) => b[0].length - a[0].length);
    const re = reverse.length ? new RegExp(`(?<![\\w])(?:${reverse.map((r) => escapeRe(r[0])).join('|')})(?![\\w])`, 'gi') : null;
    const lookup = new Map(); for (const r of reverse) if (!lookup.has(r[0])) lookup.set(r[0], r);
    const lookupLower = new Map(); for (const r of reverse) if (!lookupLower.has(r[0].toLowerCase())) lookupLower.set(r[0].toLowerCase(), r);
    // case-insensitive only for a token that starts with a capital letter (IREDALE, HARRIET), so "port kit" stays;
    // the case of the note is carried over to person names only (ECMC stays ECMC, codes stay codes)
    const restore = (m) => {
      let entry = lookup.get(m);
      if (!entry) { if (!/^[A-Z]/.test(m)) return m; entry = lookupLower.get(m.toLowerCase()); if (!entry) return m; }
      const real = entry[1], isName = entry[2];
      if (!isName) return real;
      if (m.length > 1 && m === m.toUpperCase() && /[A-Z]/.test(m) && /[A-Za-z]/.test(real)) return real.toUpperCase();
      // "Nowak" written in Title Case in a note while the census had "NOWAK, OPAL": give the real name the note's case
      if (/[a-z]/.test(m) && real.length > 1 && real === real.toUpperCase() && /[A-Z]/.test(real)) return real.toLowerCase().replace(/(^|[^a-z'’])([a-z])/g, (x, a, b) => a + b.toUpperCase()).replace(/\b(Mc|Mac|O')([a-z])/g, (x, a, b) => a + b.toUpperCase());
      return real;
    };
    const codeCol = headers.findIndex((h) => roles.get(h) === 'mrn');
    const rows = table.rows.map((row) => {
      const out = row.slice();
      const code = codeCol >= 0 ? cellToString(row[codeCol]) : (row.map(cellToString).join(' ').match(/\bP\d{3}\b/) || [''])[0];
      const p = byCode.get(code);
      const off = p ? -(p.DateOffsetDays || 0) : 0;
      headers.forEach((h, ci) => {
        const v = row[ci]; if (v == null || v === '') return;
        const role = roles.get(h);
        if (role === 'date' && isDate(v)) { out[ci] = shiftDate(v, off); return; }
        if (role === 'mrn' && p) { out[ci] = firstOf(p.MRN) || firstOf(p.RealName); return; }
        if (role === 'dob' && p) { out[ci] = firstOf(p.DOB); return; }
        if (role === 'account' && p && firstOf(p.Account)) { out[ci] = firstOf(p.Account); return; }
        if (role === 'patient_name' && p && firstOf(p.RealName)) { out[ci] = firstOf(p.RealName); return; }
        let s = cellToString(v);
        if (re) s = s.replace(re, restore);
        if (off && (role === 'date' || role === 'text')) {
          for (const pat of DATE_PATTERNS) { pat.re.lastIndex = 0; s = s.replace(pat.re, (m, ...g) => { const mm = [m, ...g.slice(0, -2)]; mm.index = 0; const pd = parseDateMatch(pat.kind, mm); return pd ? renderDate(pd, shiftDate(new Date(pd.y, pd.m - 1, pd.d), off)) : m; }); }
        }
        out[ci] = s;
      });
      return out;
    });
    return { headers, rows };
  }

  // ---------------------------------------------------------------------
  // 7. Self-check: a deliberately over-sensitive scan of the OUTPUT for anything that still points at a real patient.
  // It is not the detector run again: it compares digits only (so "0041 2345" is found when the MRN is 00412345),
  // looks for every name token, diminutive and initial of every census patient, for ages 90+ written as bare numbers,
  // and for identifier shapes the surrogates never produce. A false alarm costs a look; a miss costs a leak.
  // ---------------------------------------------------------------------
  const FAKE_PHONE = /^\D*(?:1\D*)?5\D*5\D*5\D*(?:0\D*1\D*0\D*(?:\d\D*){4}|(?:\d\D*){4})(?:(?:x|ext\.?|extension)\D*\d+)?\D*$/i;
  function selfCheck(result, opts) {
    const o = Object.assign({ kind: 'table' }, opts || {});
    const census = result.census, cfg = result.cfg;
    const hits = [], providerHits = [], coincidences = [], unnamed = [];
    const digitsOf = (v) => cellToString(v).replace(/\D/g, '');
    const dobHasYear = (v) => isDate(v) || /\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\b\d{1,2}-[A-Za-z]{3,}-\d{2}\b/.test(cellToString(v));
    const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;
    const isMonthOfDate = (text, start, end, tok) => MONTH_WORD.test(tok) && (/^\.?\s+\d{1,2}(st|nd|rd|th)?\b/.test(text.slice(end)) || /\d{1,2}(st|nd|rd|th)?(\s+of)?[\s\-]$/i.test(text.slice(0, start)));
    const isCredentialToken = (t) => t.length <= 4 && t === t.toUpperCase() && LEX.CREDENTIAL_SET.has(t.toLowerCase());
    // per patient: digit keys and name tokens
    const digitKeys = new Map(); // digits (leading zeros stripped) -> { entity, type }
    const nameTokens = []; // { re, entity, exactCase, ownRowOnly, text }
    const addDigits = (d, entity, type) => { const k = d.replace(/^0+/, ''); if (k.length >= 5) digitKeys.set(k, { entity, type }); };
    for (const p of [...census.patients.values(), ...(census.known ? census.known.values() : [])]) {
      p.mrns.forEach((m) => addDigits(digitsOf(m), p.key, 'MRN'));
      p.accounts.forEach((a) => addDigits(digitsOf(a), p.key, 'ACCOUNT'));
      p.phones.forEach((ph) => { const d = digitsOf(ph); if (d.length >= 7) { addDigits(d, p.key, 'PHONE'); if (d.length === 11 && d[0] === '1') addDigits(d.slice(1), p.key, 'PHONE'); } });
      if (p.dob && dobHasYear(p.dob)) {
        const d = isDate(p.dob) ? p.dob : parseDateString(cellToString(p.dob));
        if (d) { const y = d.getFullYear(), mo = d.getMonth() + 1, da = d.getDate(); [`${mo}${da}${y}`, `${pad2(mo)}${pad2(da)}${y}`, `${y}${pad2(mo)}${pad2(da)}`, `${pad2(mo)}${pad2(da)}${pad2(y % 100)}`, `${mo}${da}${pad2(y % 100)}`].forEach((k) => digitKeys.set(k, { entity: p.key, type: 'DOB' })); }
      }
      const toks = new Set();
      const parsedAll = [...[...p.names].map(parseName), p.parsed].filter(Boolean);
      for (const pn of parsedAll) {
        [pn.first, pn.last, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((t) => { if (!t) return; const c = t.replace(/\.$/, ''); if (c.length >= 3 && !/\s/.test(c)) toks.add(c); c.split(/[-\s]+/).forEach((h) => { if (h.length >= 3) toks.add(h); }); });
        if (pn.first) LEX.nicknamesOf(pn.first).forEach((n) => { if (n.length >= 3 && !LEX.isAmbiguous(n) && !LEX.isClinical(n)) toks.add(n); });
        if (pn.first && pn.last) {
          nameTokens.push({ re: new RegExp(`(?<![\\w])${escapeRe(pn.first[0])}\\.\\s?${escapeRe(pn.last[0])}\\.(?![\\w])`), entity: p.key, exactCase: true, text: `${pn.first[0]}.${pn.last[0]}.` });
          const stem = pn.first.length >= 4 ? pn.first.slice(0, 3) : pn.first;
          nameTokens.push({ re: new RegExp(`(?<![\\w])${escapeRe(stem)}[a-z]*\\s${escapeRe(pn.last[0])}\\.`), entity: p.key, exactCase: true, text: `${stem}… ${pn.last[0]}.` });
        }
      }
      for (const t of toks) {
        const common = LEX.isAmbiguous(t) || LEX.isClinical(t) || LEX.RELATION_SET.has(t.toLowerCase()) || /^(the|and|for|not|with|from|pt|pts|per|see|ok|yes|all|one|two|new|old|van|von|der|den|del|los|las|san|dos|da|de|la|le|di|du|bin|ibn|abu|al|el)$/i.test(t);
        nameTokens.push({ re: new RegExp(`(?<![\\w])${escapeRe(t)}(?![\\w])`, common ? 'g' : 'gi'), entity: p.key, exactCase: common, text: t, common });
      }
      if (!p.known && !p.names.size && !(p.parsed && p.parsed.last)) unnamed.push({ entity: p.key, code: p.entity ? p.entity.code : '', row: p.rows[0] });
    }
    const outRows = result.rows, headers = result.headers;
    const ageAfterName = /(?:\b[A-Z][a-z]+,?\s|\b(?:turned|turning|is|now|age|aged)\s)(9\d|1[01]\d)(?![\d+\/%:]|\.\d|\s*(?:mg|mcg|kg|lb|lbs|ml|mL|cc|units?|%|mmhg|bpm|min|hrs?|yo|y\/o|yrs?|years?|day|days|x))/g;
    const vitalBefore = /\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc|room|chair|bay|ext|x|cycle|day|grade|stage|pain)\s*$/i;
    outRows.forEach((row, ri) => row.forEach((v, ci) => {
      const s = cellToString(v); if (!s) return;
      const header = headers[ci]; if (header === 'DeID Audit') return;
      const rowKey = census.rowPatient[ri];
      const rowExtra = census.rowExtra ? census.rowExtra[ri] : null;
      const ownRow = (ent) => ent === rowKey || !!(rowExtra && rowExtra.includes(ent));
      const seen = new Set();
      const push = (text, type, entity, kind) => { const k = `${text}|${type}`; if (seen.has(k)) return; seen.add(k); hits.push({ row: ri, col: ci, header, text, type, entity, kind }); };
      // 1. the census detector itself (names, MRNs, accounts, phones, DOBs in every rendering)
      censusSpans(s, census, rowKey, rowExtra).forEach((sp) => {
        if (sp.type === 'NAME_PROVIDER') { providerHits.push({ row: ri, col: ci, header, text: sp.text, type: sp.type }); return; }
        if (!/^(NAME_PATIENT|MRN|ACCOUNT|PHONE|DOB)$/.test(sp.type)) return;
        const p = census.patient ? census.patient(sp.entity) : census.patients.get(sp.entity);
        if (sp.type === 'DOB' && p && !dobHasYear(p.dob)) return;
        if (sp.type === 'DOB' && rowKey && !ownRow(sp.entity)) { coincidences.push({ row: ri, col: ci, header, text: sp.text }); return; }
        if (sp.type === 'NAME_PATIENT' && (isCredentialToken(sp.text) || isMonthOfDate(s, sp.start, sp.end, sp.text))) return;
        push(sp.text, sp.type, sp.entity, 'census');
      });
      // 2. digits only: MRNs, accounts, phones and birthdates however they are spaced or punctuated
      const numRe = /\d(?:[ \-.\/()]{0,2}\d)+/g; let nm;
      while ((nm = numRe.exec(s))) {
        const d = nm[0].replace(/\D/g, ''); const k = d.replace(/^0+/, '');
        const hit = digitKeys.get(k) || digitKeys.get(d);
        if (!hit) continue;
        if (hit.type === 'DOB' && rowKey && !ownRow(hit.entity)) { coincidences.push({ row: ri, col: ci, header, text: nm[0] }); continue; }
        push(nm[0], hit.type, hit.entity, 'digits');
      }
      // 3. every name token, diminutive and initial of every census patient
      for (const nt of nameTokens) {
        nt.re.lastIndex = 0; let m;
        while ((m = nt.re.exec(s))) {
          if (nt.exactCase && !/^[A-Z]/.test(m[0])) { if (!nt.re.global) break; continue; }
          if (nt.common && isMonthOfDate(s, m.index, m.index + m[0].length, m[0])) { if (!nt.re.global) break; continue; }
          if (isCredentialToken(m[0])) { if (!nt.re.global) break; continue; }
          // a common word (May, Will, Rose, Grey) counts only inside the patient's own row, where it was row-scoped for the detector too
          if (nt.common && rowKey && !ownRow(nt.entity)) { if (!nt.re.global) break; continue; }
          if (nt.common && /^\s+(?:sign|signs|syndrome|disease|test|reflex|period|garden|geranium|arbor|lodge|turner|curve|call|need|be|hold|chart|insurance|for|to)\b/i.test(s.slice(m.index + m[0].length))) { if (!nt.re.global) break; continue; }
          push(m[0], 'NAME_PATIENT', nt.entity, 'token');
          if (!nt.re.global) break;
        }
      }
      // 4. ages 90 and over written as a bare number after a name or "turned"/"is"/"age"
      ageAfterName.lastIndex = 0; let am;
      while ((am = ageAfterName.exec(s))) { const lead = am[0].slice(0, am[0].length - am[1].length); if (vitalBefore.test(lead) || vitalBefore.test(s.slice(Math.max(0, am.index - 12), am.index))) continue; push(am[1], 'AGE', rowKey, 'age'); }
      // 5. identifier shapes the surrogates never produce: a phone that is not 555-010-xxxx, an e-mail outside example.com, an SSN, a URL/IP
      ruleSpans(s, Object.assign({}, cfg, { mrnRegex: null, accountRegex: null, extraRegexes: [] })).forEach((sp) => {
        if (sp.type === 'PHONE' && !FAKE_PHONE.test(sp.text)) push(sp.text, 'PHONE', rowKey, 'shape');
        else if (sp.type === 'EMAIL' && !/@example\.com$/i.test(sp.text)) push(sp.text, 'EMAIL', rowKey, 'shape');
        else if (sp.type === 'SSN' && !/^9/.test(sp.text)) push(sp.text, 'SSN', rowKey, 'shape');
        else if (sp.type === 'URL' || sp.type === 'IP') push(sp.text, sp.type, rowKey, 'shape');
      });
    }));
    if (cfg.surrogate.dateShift) result.details.forEach((d) => { if (d.patientCode && d.offset === 0) hits.push({ row: d.row, col: -1, header: 'Dates', text: 'not shifted', type: 'DATE', kind: 'offset' }); });
    // a patient created from an MRN or a birthdate whose name was never read: the check above cannot vouch for a name it never saw
    const unnamedHits = o.kind === 'table' ? [] : unnamed;
    return { hits, providerHits, coincidences, unnamed: unnamedHits, patients: census.patients.size };
  }

  const VERSION = '0.1.0';
  return {
    VERSION, TYPES, COARSE, ROLES, ROLE_LABELS, classifyColumns, inferIdPattern, parseName, nameVariants, buildCensus,
    detectText, ruleSpans, lexiconSpans, censusSpans, resolveSpans, mergeAdjacentNames, collectPropagation,
    parseDateString, renderDate, shiftDate, dateRenderings, bandAge,
    Surrogator, applySpans, defaultConfig, compileConfig, processTable, reidentify, selfCheck,
    createRegistry, normalizeId, mrnKeyOf, dobKeyOf, levenshtein, parseTextDocument, normalizeOcrText,
    cellToString, mulberry32, hashString, tokenize,
  };
});
