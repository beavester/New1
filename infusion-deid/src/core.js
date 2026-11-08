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
    { role: 'dob', re: /\b(dob|d\.o\.b|date of birth|birth\s*date|birthdate|born)\b/i },
    { role: 'mrn', re: /\b(mrn|mr\s*#|med(ical)?\s*rec(ord)?\s*(no|num|number|#)?|chart\s*(no|#))\b/i },
    { role: 'account', re: /\b(acct|account|har|csn|encounter|contact serial|visit\s*(id|#|no)|fin\b|financial)\b/i },
    { role: 'phone', re: /\b(phone|tel|telephone|mobile|cell|fax|contact\s*(no|number|#))\b/i },
    { role: 'provider', re: /\b(provider|attending|physician|ordering|prescrib|doctor|\bdr\b|oncologist|referring|pcp|nurse|\brn\b|pharmacist|md\b|signed by|entered by|authoriz)/i },
    { role: 'age', re: /^\s*age\b/i },
    { role: 'zip', re: /\b(zip|postal)\b/i },
    { role: 'drop', re: /\b(address|street|city|state|email|e-mail|ssn|social security|guarantor|emergency contact|insurance id|member id|policy|subscriber|license|device serial|photo|employer)\b/i },
    { role: 'patient_name', re: /\b(pt|patient)?\s*(name|full name|pt name|patient name|last,? first|legal name)\b/i, not: /provider|physician|attending|md|\bdr\b|nurse|pharmacist|chair|regimen|drug|protocol|order|user|entered|signed|location|dept|department|clinic|facility|insurance|plan|study|trial/i },
    { role: 'text', re: /\b(comment|note|notes|instruction|remark|reason|indication|message|description|free\s*text|narrative|sched(uling)?\s*note|appt\s*note|special|alert|question|answer|response|reply|detail)/i },
    { role: 'date', re: /\b(date|appt|appointment|scheduled|sched|dos|visit|start|end|due|due date|next|last|time stamp|timestamp|created|updated|entered on|ordered on)\b/i, not: /time\s*$/i },
  ];

  function looksLikeDate(s) {
    return /^\s*(\d{1,2}[\/\-.]\d{1,2}([\/\-.]\d{2,4})?|\d{4}-\d{1,2}-\d{1,2}|[A-Za-z]{3,9}\.? \d{1,2}(,? \d{2,4})?|\d{1,2}[-\s][A-Za-z]{3,9}([-\s,]+\d{2,4})?)(\s+\d{1,2}:\d{2}(:\d{2})?\s*([AaPp][Mm])?)?\s*$/.test(s);
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
      const phoneLike = strs.filter((s) => /^\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}$/.test(s.trim())).length / n;
      const idLike = strs.filter((s) => /^[A-Z]{0,2}\d{6,12}$/.test(s.trim())).length / n;

      if (!role) {
        if (vals.length === 0) { role = 'keep'; reason = 'empty'; }
        else if (dateLike > 0.8) { role = 'date'; reason = 'values look like dates'; }
        else if (phoneLike > 0.8) { role = 'phone'; reason = 'values look like phone numbers'; }
        else if (nameLike > 0.8) { role = 'patient_name'; reason = 'values look like "Last, First"'; }
        else if (idLike > 0.8) { role = 'mrn'; reason = 'values look like record numbers'; }
        else if (avgLen > 25 && spacey > 0.5) { role = 'text'; reason = 'long free text'; }
        else { role = 'keep'; reason = 'short categorical values'; }
      } else if (role === 'date' && dateLike < 0.3 && vals.length > 3) {
        // header said date but the values are not dates: treat as text if long, else keep
        role = avgLen > 25 ? 'text' : 'keep';
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
      // diminutives: Benjamin → Ben, Katarzyna → Kasia, Salvatore → Sal
      // a diminutive that is also an ordinary word or a month (Will, Bill, Pat, Jan, May) is only taken with the surname
      LEX.nicknamesOf(f).forEach((nick) => { if (nick.length < 3) return; if (!LEX.isAmbiguous(nick) && !LEX.isClinical(nick)) add(nick); add(`${nick} ${l}`); add(`${l}, ${nick}`); add(`${nick} ${l[0]}.`); });
    }
    // hyphenated surnames: each half
    if (l.includes('-')) l.split('-').forEach((h) => { if (h.length >= 3) add(h); });
    return [...v].filter((x) => x.length >= 2);
  }
  // every letter token a patient may be referred to by (lower-case), used to tell the patient from a relative who
  // shares the surname ("daughter Siobhan Fitzgerald-Nowak" is not "Fitzgerald, Mary")
  function ownTokensOf(parsedList) {
    const set = new Set();
    for (const pn of parsedList) {
      if (!pn) continue;
      [pn.first, pn.last, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((t) => { if (!t) return; const c = t.toLowerCase().replace(/\.$/, ''); if (c) set.add(c); c.split('-').forEach((h) => { if (h) set.add(h); }); });
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
      const mrn = mrnCols.map((c) => cellToString(row[c]).trim()).find(Boolean) || '';
      const nameRaw = nameCols.map((c) => cellToString(row[c]).trim()).find(Boolean) || '';
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
    for (const p of patients.values()) {
      p.mrns.forEach((m) => addVariant(m, 'MRN', p.key));
      p.accounts.forEach((a) => addVariant(a, 'ACCOUNT', p.key));
      p.phones.forEach((ph) => { addVariant(ph, 'PHONE', p.key); const d = ph.replace(/\D/g, ''); if (d.length >= 7) addVariant(d, 'PHONE', p.key); });
      const allVariants = new Set();
      p.names.forEach((nm) => { const pn = parseName(nm); if (pn) nameVariants(pn).forEach((v) => allVariants.add(v)); });
      if (p.parsed) nameVariants(p.parsed).forEach((v) => allVariants.add(v));
      const literal = new Set(); p.names.forEach((nm) => { const pn = parseName(nm); if (pn) [pn.last, ...pn.last.split('-')].forEach((t) => t && literal.add(t.toLowerCase())); });
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
    for (const p of patients.values()) p.mrns.forEach((m) => { const k = mrnKeyOf(m); if (k) mrnNorm.set(k, p.key); });
    return { patients, providers, rowPatient, lookup, regex, registry, mrnNorm, nameCols, mrnCols, dobCols, acctCols, phoneCols, provCols };
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
    { kind: 'iso', re: new RegExp('(?<![\\d\\w])(\\d{4})-(\\d{1,2})-(\\d{1,2})(?![\\d])', 'g') },
    { kind: 'mdy', re: new RegExp('(?<![\\d\\w/.-])(\\d{1,2})([\\/\\-.])(\\d{1,2})\\2(\\d{4}|\\d{2})(?![\\d])', 'g') },
    { kind: 'Mdy', re: new RegExp(`(?<![\\w])${MONTH_RE}\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\t]+(\\d{4}|\\d{2}(?![ \\t]*(?:-|[ \\t]|of[ \\t]+)?${MONTH_NC}\\b))(?![\\d:]))?(?![\\w])`, 'gi') },
    { kind: 'dMy', re: new RegExp(`(?<![\\w])(\\d{1,2})(?:st|nd|rd|th)?(?:(-)|[ \\t]{1,2}(?:of[ \\t]+)?)${MONTH_RE}\\.?(?:(?:-|,[ \\t]*|(?<!-${MONTH_NC}\\.?)[ \\t]+)(\\d{4}|\\d{2}(?![\\/\\-.]\\d)(?![ \\t]*(?:-|[ \\t]|of[ \\t]+)?${MONTH_NC}\\b))(?![\\d:]))?(?![\\w])`, 'gi') },
    { kind: 'md', re: new RegExp('(?<![\\d\\w/.-])(\\d{1,2})([\\/\\-])(\\d{1,2})(?![\\d/-])(?!\\.\\d)(?![ \\t]*(?:mg|mcg|g|ml|tab|tabs|dose|x|units?|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5)\\b)', 'g') },
  ];
  const UNIT_AFTER = /^[ \t]*(mg|mcg|g|ml|mL|tab|tabs|dose|x|unit|units|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5W?|AM|PM)\b/;

  function parseDateMatch(kind, m) {
    let y, mo, d, hasYear = true, yearDigits = 4, monthStyle = null, sep = '/', monthTok = null, ordinal = '';
    if (kind === 'iso') { y = +m[1]; mo = +m[2]; d = +m[3]; sep = '-'; }
    else if (kind === 'mdy') { mo = +m[1]; sep = m[2]; d = +m[3]; yearDigits = m[4].length; y = expandYear(m[4]); }
    else if (kind === 'Mdy') { monthTok = m[1]; mo = monthIndex(m[1]); d = +m[2]; if (m[3]) { yearDigits = m[3].length; y = expandYear(m[3]); } else { hasYear = false; y = new Date().getFullYear(); } }
    else if (kind === 'dMy') { d = +m[1]; monthTok = m[3]; mo = monthIndex(m[3]); if (m[4]) { yearDigits = m[4].length; y = expandYear(m[4]); } else { hasYear = false; y = new Date().getFullYear(); } }
    else if (kind === 'md') { mo = +m[1]; sep = m[2]; d = +m[3]; hasYear = false; y = new Date().getFullYear(); }
    if (!validDMY(y, mo, d)) return null;
    if (y < 1880 || y > 2100) return null;
    if (monthTok) {
      const raw = m[0].match(new RegExp(MONTH_RE + '\\.?', 'i'))[0];
      monthStyle = { abbrev: raw.replace('.', '').length <= 4, period: raw.endsWith('.'), upper: raw === raw.toUpperCase(), lower: raw === raw.toLowerCase() };
    }
    return { y, m: mo, d, hasYear, yearDigits, sep, kind, monthStyle, text: m[0] };
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
      case 'iso': return `${y}-${pad2(mo)}-${pad2(d)}`;
      case 'mdy': { const padded = /(^|[\/\-.])0\d([\/\-.]|$)/.test(pd.text); return padded ? `${pad2(mo)}${pd.sep}${pad2(d)}${pd.sep}${yy}` : `${mo}${pd.sep}${d}${pd.sep}${yy}`; }
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
    PHONE: /(?<![\d\w])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}(?:\s*[-.]\s*|\s))\d{3}(?:\s*[-.]\s*|\s)\d{4}(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?(?![\d\w])|(?<![\d\w-])\d{3}-\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?(?![\d\w-])/gi,
    PHONE_PLAIN: /(?<![\d\w.-])\d{10}(?![\d\w.-])(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?/gi,
    // OCR-noisy phone: digits with O/I/l confusions, at least 7 real digits, 3-3-4 shape
    PHONE_OCR: /(?<![\w])\(?[\dOIl]{3}\)?(?:\s*[-.]\s*|\s)[\dOIl]{3}(?:\s*[-.]\s*|\s)[\dOIl]{4}(?![\w])/g,
    AGE: /\b(?:age[d]?\s*:?\s*(9\d|1[0-2]\d)(?![\d\/%-])(?!\.\d)(?!,\d)|(9\d|1[0-2]\d)\s*(?:-|\s)?\s*(?:y\/o|yo|y\.o\.?|yrs?\.?(?:\s*old)?|years?(?:[-\s]old)?|year[-\s]old|yr[-\s]old)(?![A-Za-z])|\b(?:his|her|their)\s+(?:(?:early|mid|late)[-\s])?(9|10)0s\b|\b(?:nonagenarian|centenarian)\b)/gi,
    // written-out ages: ninety-two year old, one hundred and one years old
    AGE_WORDS: /\b(?:ninety|one[-\s]hundred)(?:(?:[-\s]|\s+and\s+)(?:one|two|three|four|five|six|seven|eight|nine))?(?:[-\s]+(?:years?|yrs?)[-\s]+old|[-\s]+(?:y\/o|yo))(?![A-Za-z])/gi,
    // bare number after a person-subject: "husband is 95", "pt turned 91"; vitals (HR is 95, BP 95/60, SpO2 95%) excluded
    AGE_SUBJECT: /\b(?:pt|patient|he|she|husband|wife|spouse|mother|father|mom|dad|sister|brother|son|daughter|partner|grandmother|grandfather|aunt|uncle|who)\s+(?:is|was|turned|turning|now|just turned|will be)\s+(9\d|1[01]\d)(?![\d\/%,:-])(?!\.\d)(?!\s*(?:mg|kg|lb|lbs|%|mmhg|bpm|k\b|ml|mL|cc|units?|yo|y\/o|year|yr|\/))/gi,
    // "Turned 90 last week", "Turning 91 in May", "is now 95" at the start of a sentence or note (no subject written)
    AGE_TURNED: /(?:^|[.;!?\n]\s*|^\s*-\s*)((?:just\s+)?(?:turned|turning|turns|is now|now)\s+(9\d|1[01]\d))(?![\d\/%,:-])(?!\.\d)(?!\s*(?:mg|kg|lb|lbs|%|mmhg|bpm|k\b|ml|mL|cc|units?|\/))/gi,
    // a bare age in apposition after a name or before a sex marker: "Zofia, 95, hard of hearing", "97 F", "95 M"
    AGE_APPOS: /(?<=\b[A-Z][A-Za-z'’\-]+,\s)(9\d|1[01]\d)(?=\s*,)|(?<![\d\/.\-$#])(9\d|1[01]\d)\s*(?:F|M)\b(?![\/\d]|\.\d)/g,
    ADDRESS: /\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\.?\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail)\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/g,
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
    LABELED_ID: /\b(?:member|subscriber|policy|beneficiary|medicare|medicaid|mbi|hic|hicn|insurance|ins|conf|confirmation|ref|reference|claim|auth|authorization|prior auth|case|ticket|serial|sn|s\/n|lot|lic|license|licence|dl|driver'?s? license|plate|badge|subject|study|participant|enrollment|screening|health card|ohip|card|passport|visa|id|identifier|acct|account|invoice|order|rx|prescription|tracking|voucher|pin|employee|emp|payer)\s*(?:#|no\.?|num\.?|number|id|code)?(?:\s+(?:on\s+file|is|was|of|verified|provided|given|recorded))*\s*[:#]?\s*((?:[A-Z]{1,4}[-\s]?)?\d[A-Z0-9\-]*(?:[ ](?=[A-Z0-9]*\d)[A-Z0-9\-]+){0,3}|[A-Z]{1,3}[ -]?\d{3,4}(?![\w-]))/gi,
    // Medicare Beneficiary Identifier: 1EG4-TE5-MK72 (11 chars, fixed letter/digit positions, hyphens optional)
    MBI: /(?<![\w])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y]{2}\d{2}(?![\w])/g,
    // @handle / user name tokens (MyChart user names, chat mentions)
    HANDLE: /(?<![\w.])@[A-Za-z][\w.]{2,}(?![\w.])(?![A-Za-z0-9.-]*\.[A-Za-z]{2,})|\b(?:username|user name|user id|userid|login|log-in|handle|screen name)\s*[:#]?\s*((?=[\w.-]*[A-Za-z])[A-Za-z][\w.-]{3,})/gi,
    // patient initials when labelled: "initials P.R." / "init: JS"
    INITIALS: /\binitials?\s*[:#]?\s*([A-Z]\.?\s?[A-Z]\.?(?:\s?[A-Z]\.?)?)(?![A-Za-z])/g,
    // OCR-noisy m/d/y or y-m-d with O/I/l confusions (must contain at least one letter)
    DATE_OCR: /(?<![\w\/])(?=[\dOIl\/\-.]*[OIl])(?:[\dOIl]{1,2}([\/\-.])[\dOIl]{1,2}\1[\dOIl]{2,4}|[\dOIl]{4}-[\dOIl]{1,2}-[\dOIl]{1,2})(?![\w\/])/g,
  };
  // When an m-d or small-fraction token is a date only if the surroundings say so.
  const DATE_CTX_BEFORE = /(?:\bdob|\bborn|\bbirth(?:day|date)?|\bon|\bappt|\bappointment|\bseen|\bdue|\bnext|\blabs?|\bscan|\bvisit|\brtc|f\/u|\bfu|\bstart(?:s|ed|ing)?|\bthrough|\bthru|\bfrom|\buntil|\bby|\bdate|\bdos|\btx|\btreatment|\binfusion|\breturn(?:s|ed|ing)?|\brecheck|\bsched(?:uled)?|\bresched(?:uled)?|r\/s|\bmoved|\bcancel(?:l?ed)?|\bbooked|\bconfirmed|\bsigned|\bdated|\bsince|\bcall(?:ed)?\s+back|\bbegin(?:s|ning)?|\bending|\bends?|\bto|\band|\bor)\s*$/i;
  const DATE_CTX_AFTER = /^\s*(?:@|at\s+)?\d{1,2}:\d{2}|^\s*(?:@|at)\s*\d{3,4}\b|^\s*(?:appt|appointment|visit|labs?|scan|infusion|tx|c\d+d\d+|cycle|for|with|w\/|and|or|-|–|thru|through|to)\b/i;
  const RANGE_BEFORE = /(?:\b(?:cycles?|days?|doses?|weeks?|wks?|months?|mos?|yrs?|years?|c\d*d?|dose|ratio|grade|range|levels?|pages?|items?|q|x|times|courses?|fractions?|fx|sessions?|pain|fatigue|nausea|distress|anxiety|depression|dyspnea|score|scores?|rated?|rating|scale|severity|intensity|vas|nrs|esas)|#)\s*$/i;

  function ruleSpans(text, cfg) {
    const spans = [];
    const push = (m, type, extra) => spans.push(Object.assign({ start: m.index, end: m.index + m[0].length, type, source: 'rule', text: m[0] }, extra || {}));
    const run = (re, type, filter) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) { if (!filter || filter(m)) push(m, type); if (m[0].length === 0) re.lastIndex++; } };

    run(RULES.EMAIL, 'EMAIL'); run(RULES.URL, 'URL'); run(RULES.IP, 'IP'); run(RULES.SSN, 'SSN');
    run(RULES.PHONE, 'PHONE'); run(RULES.ADDRESS, 'ADDRESS'); run(RULES.ZIP, 'ZIP'); run(RULES.ZIP_LABEL, 'ZIP');
    // After a street address, the town and ZIP that follow are location too, with or without a state
    // ("48 Abbott Rd Buffalo 14220", "12 Oak St, Eggertsville NY 14226", "9 Elm Ave 14221").
    RULES.ADDRESS.lastIndex = 0; let adm;
    while ((adm = RULES.ADDRESS.exec(text))) {
      const from = adm.index + adm[0].length;
      const tail = text.slice(from).match(/^,?[ \t]+((?:[A-Z][A-Za-z'’\-]+[ \t]+){0,3}?)(?:([A-Z]{2}),?[ \t]+)?(\d{5}(?:-\d{4})?)\b/);
      if (tail) { const lead = tail[0].match(/^,?[ \t]+/)[0].length; spans.push({ start: from + lead, end: from + tail[0].length, type: 'LOCATION', source: 'rule', text: tail[0].slice(lead) }); continue; }
      const town = text.slice(from).match(/^,?[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)(?=[ \t]*(?:[.,;:\n]|$))/);
      if (town && !LEX.isClinical(town[1])) { const lead = town[0].length - town[1].length; spans.push({ start: from + lead, end: from + town[0].length, type: 'LOCATION', source: 'rule', text: town[1] }); }
    }
    run(RULES.AGE, 'AGE'); run(RULES.AGE_WORDS, 'AGE');
    run(RULES.AGE_SUBJECT, 'AGE', (m) => {
      // "HR is 95" / "K is 95" / "O2 sat is 95": a vital or lab name right before the subject word is not a person
      const before = text.slice(Math.max(0, m.index - 16), m.index);
      return !/\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc)\s*$/i.test(before);
    });
    // ages with no written subject, and in apposition: the span is the age phrase only
    RULES.AGE_TURNED.lastIndex = 0; let am;
    while ((am = RULES.AGE_TURNED.exec(text))) { const val = am[1]; const start = am.index + am[0].length - val.length; spans.push({ start, end: start + val.length, type: 'AGE', source: 'rule', text: val }); }
    run(RULES.AGE_APPOS, 'AGE', (m) => !/\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc|room|chair|bay|ext|x)\s*$/i.test(text.slice(Math.max(0, m.index - 10), m.index)));
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
      const inner = val.match(/^(MBI|ID|HIC|HICN|MRN|SSN|NO|NUM|REF)\s+/i); if (inner) val = val.slice(inner[0].length); if (!val) continue;
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
    run(/(?<![\w\/\-])(?:(?:19|20)\d{2}-\d{1,2}-|\d{1,2}\/\d{1,2}\/)(?=[ \t]*(?:$|\n))/gm, 'DATE');
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
  const TOKEN_RE = /[A-Za-z][A-Za-z'’\-]*\.?|\d+(?:[.,]\d+)*|[^\sA-Za-z\d]/g;
  function tokenize(text) {
    const toks = []; let m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      const raw = m[0];
      const core = raw.replace(/['’]s$/i, '').replace(/\.$/, '');
      toks.push({
        raw, core, start: m.index, end: m.index + core.length, fullEnd: m.index + raw.length,
        cap: /^[A-Z][a-z'’\-]*$/.test(core) || /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(core) || (/^[A-Z][A-Za-z'’\-]*[a-z]$/.test(core) && (core.match(/[A-Z]/g) || []).length <= 3 && /^(Mc|Mac|De|Di|Da|La|Le|Van|Von|O'|O’|D'|D’|St|Fitz|Del|Des|Du)[A-Z'’]/.test(core)),
        allcaps: /^[A-Z][A-Z'’\-]{2,}$/.test(core),
        initial: /^[A-Z]\.?$/.test(raw) && raw.length <= 2,
        word: /^[A-Za-z]/.test(raw), num: /^\d/.test(raw), punct: !/^[A-Za-z\d]/.test(raw),
      });
    }
    for (let i = 0; i < toks.length - 1; i++) toks[i].nlAfter = text.slice(toks[i].fullEnd, toks[i + 1].start).includes('\n');
    return toks;
  }
  const isHon = (t) => t && t.word && LEX.HONORIFIC_SET.has(t.core.toLowerCase());
  const isCred = (t) => t && t.word && LEX.CREDENTIAL_SET.has(t.core.replace(/\./g, '').toLowerCase()) && t.core === t.core.toUpperCase() || (t && t.word && /^(PharmD|PsyD|PhD)$/.test(t.core));
  // A token that ends a sentence: trailing period that is not an honorific/initial/credential
  const endsSentence = (t) => !!t && (t.nlAfter || (t.raw.endsWith('.') && !isHon(t) && !t.initial && !isCred(t) && !/^(vs|etc|approx|re|appt|pt|pts|hx|dx|tx|w|c|s|p|q|b|d|e|g|i|mg|mcg|ml|no|dr|mr|mrs|ms|st|jr|sr|inc|ltd)$/i.test(t.core)));
  const isRel = (t) => t && t.word && LEX.RELATION_SET.has(t.core.toLowerCase());
  const isNameish = (t, allow) => t && (t.cap || t.allcaps || t.initial) && !LEX.isClinical(t.core) && !(allow && allow.has(t.core.toLowerCase()));
  const inLex = (t) => t && (LEX.isFirstName(t.core) || LEX.isSurname(t.core));

  function lexiconSpans(text, cfg) {
    const toks = tokenize(text);
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
        if (j < toks.length && /^(de|van|von|la|le|del|da|di|du|st|mc|mac|o)$/i.test(toks[j].core) && j + 1 < toks.length && isNameish(toks[j + 1], allow)) j++;
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
        const acronym = /^[A-Z]{3,6}$/.test(toks[j].core) && !LEX.isClinical(toks[j].core) && !LEX.STATE_ABBR_SET.has(toks[j].core) && !LEX.CREDENTIAL_SET.has(lc) && !LEX.RELATION_SET.has(lc);
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
      while (k > 0 && (toks[k - 1].cap || toks[k - 1].allcaps) && !used[k - 1] && i - k < 2 && (LEX.CITY_SET.has(toks[k - 1].core.toLowerCase()) || LEX.PLACE_PREFIX_SET.has(toks[k - 1].core.toLowerCase()))) k--;
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
    // Pass A: honorific + name  (Dr. Lee, Mrs. Thaddeus Abernathy)
    for (let i = 0; i < toks.length - 1; i++) {
      if (!isHon(toks[i])) continue;
      const j = nameRun(i + 1, 3, true);
      if (j > i + 1) addRun(i + 1, j, /^(dr|doctor|prof|nurse)$/i.test(toks[i].core) ? 'NAME_PROVIDER' : 'NAME_OTHER', 'cue:honorific', 0.95);
    }
    // Pass B: name + credential (John Smith MD; J. Smith, NP; Smith RN)
    for (let i = 1; i < toks.length; i++) {
      if (!isCred(toks[i]) || used[i]) continue;
      let j = i; const comma = toks[j - 1] && toks[j - 1].raw === ','; if (comma) j--;
      let k = j;
      const nameishB = (t) => isNameish(t, allow) || ((t.cap || t.allcaps) && inLex(t) && !(allow && allow.has(t.core.toLowerCase())));
      while (k > 0 && k > j - 3 && nameishB(toks[k - 1]) && !used[k - 1] && !isRel(toks[k - 1]) && !(k - 1 < j - 1 && endsSentence(toks[k - 1]))) k--;
      if (k >= j) continue;
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
      else if (t.word && /^(name)$/i.test(t.core) && i > 0 && /^(preferred|nick|pet)$/i.test(toks[i - 1].core)) j = i + 1;
      if (j < 0 || j >= toks.length) continue;
      if (toks[j].raw === ':' || toks[j].raw === '"' || toks[j].raw === "'" || toks[j].raw === '“') j++;
      if (j >= toks.length || used[j] || !toks[j].word || !(toks[j].cap || toks[j].allcaps) || LEX.isClinical(toks[j].core) || isRel(toks[j]) || isHon(toks[j]) || (allow && allow.has(toks[j].core.toLowerCase()))) continue;
      addRun(j, j + 1, 'NAME_OTHER', 'cue:alias', 0.7);
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
  function censusSpans(text, census, rowPatientKey) {
    const spans = [];
    if (!census || !census.regex) return spans;
    const re = census.regex; re.lastIndex = 0; let m;
    while ((m = re.exec(text))) {
      const hit = census.lookup.get(m[0].toLowerCase());
      if (!hit) continue;
      if (hit.exactCase && !/^[A-Z]/.test(m[0])) continue;
      const own = rowPatientKey && hit.entities.includes(rowPatientKey);
      if (hit.rowScoped && !own) continue;
      const entity = own ? rowPatientKey : hit.entities[0];
      let start = m.index, end = m.index + m[0].length, type = hit.type;
      if (type === 'NAME_PATIENT') {
        const p = census.patients.get(entity);
        // a clinical eponym that is also the patient's surname stays clinical when the next word says so (Grey Turner sign)
        const after = text.slice(end).match(/^(?:['’]s?)?\s+([A-Za-z]+)/); // also "Bell's palsy", "Graves' disease"
        if ((LEX.isClinical(m[0]) || LEX.isAmbiguous(m[0])) && after && LEX.EPONYM_FOLLOW.has(after[1].toLowerCase())) continue;
        // a surname that is one half of a hyphenated compound (Haddad-Khalil, Wisniewski-Kaminski): take the whole compound
        while (end < text.length && text[end] === '-' && /[A-Za-z]/.test(text[end + 1] || '')) { const mm = text.slice(end + 1).match(/^[A-Za-z'’]+/); end += 1 + mm[0].length; }
        while (start > 0 && text[start - 1] === '-' && /[A-Za-z]/.test(text[start - 2] || '')) { const mm = text.slice(0, start - 1).match(/[A-Za-z'’]+$/); start -= 1 + mm[0].length; }
        let relative = false;
        if (p && p.ownTokens) {
          const toks = text.slice(start, end).toLowerCase().split(/[^a-z'’]+/).filter(Boolean);
          relative = toks.some((t) => !p.ownTokens.has(t));
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
          if (toks.some((t) => !k.ownTokens.has(t) && !/^(?:md|do|np|pa|rn|jr|sr|ii|iii|iv|mr|mrs|ms|dr|pt)$/.test(t))) { k.type = 'NAME_OTHER'; k.relative = k.entity; delete k.entity; }
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
    if (cfg.layers.census) spans = spans.concat(tag(censusSpans(text, ctx.census, ctx.rowPatientKey)));
    if (cfg.layers.rules) spans = spans.concat(tag(ruleSpans(text, cfg)));
    if (cfg.layers.model) spans = spans.concat(tag(lexiconSpans(text, cfg)));
    if (cfg.layers.propagate && ctx.propagateRegex) {
      ctx.propagateRegex.lastIndex = 0; let m;
      while ((m = ctx.propagateRegex.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'propagate', conf: 0.65, text: m[0], fullText: text });
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
    const terms = new Set();
    for (const s of allSpans) {
      if (COARSE(s.type) !== 'NAME' || s.source === 'census' || s.source === 'propagate' || s.initials) continue;
      const full = s.text.trim();
      if (full.length >= 4 && /\s/.test(full)) terms.add(full);
      for (const tok of full.split(/[\s,]+/)) {
        const core = tok.replace(/['’]s$/, '').replace(/\.$/, '');
        if (core.length < 3 || !/^[A-Z]/.test(core)) continue;
        if (LEX.isAmbiguous(core) || LEX.isClinical(core) || (cfg.allowSet && cfg.allowSet.has(core.toLowerCase()))) continue;
        if (LEX.HONORIFIC_SET.has(core.toLowerCase()) || LEX.CREDENTIAL_SET.has(core.toLowerCase())) continue;
        terms.add(core);
      }
    }
    if (!terms.size) return null;
    const list = [...terms].sort((a, b) => b.length - a.length).map(escapeRe);
    return new RegExp(`(?<![\\w])(?:${list.join('|')})(?![\\w])`, 'g'); // case-sensitive on purpose
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
        if (x.length >= 4 && x.length <= 12 && !taken.has(k) && !docWords.has(k) && !realWords.has(k) && !LEX.isFirstName(x) && !LEX.isSurname(x) && !LEX.isAmbiguous(x) && !LEX.isClinical(x)) return x;
      }
      return pool[Math.floor(rng() * pool.length)] + String(Math.floor(rng() * 90) + 10);
    };
    const pick = (pool) => {
      const fresh = pool.filter((x) => { const k = x.toLowerCase(); return !docWords.has(k) && !taken.has(k) && !realWords.has(k); });
      const x = fresh.length ? fresh[Math.floor(rng() * fresh.length)] : invent(pool);
      taken.add(x.toLowerCase());
      return x;
    };
    const randDigits = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rng() * 10); return s; };
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
        const p = census.patients.get(key);
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
        else if (parsedEntity && lowFirst === parsedEntity.last.toLowerCase()) out = `${info.fakeLast} ${info.fakeFirst}`; // "TRAN THI HONG": surname first, no comma
        else out = `${first} ${last}`;
      }
      return matchCase(origText, out) + cred;
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
      const fake = (n === 7 ? '555' : n === 11 && /^\+?1/.test(main.trim()) ? '1555010' : '555010') + randDigits(4);
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
            if (span.entity) { const info = ensurePatient(span.entity); const p = census.patients.get(span.entity); return renderName(orig, p && p.parsed, info, mode); }
            return renderOtherName(orig);
          }
          case 'NAME_PROVIDER': {
            if (span.entity) { const info = ensureProvider(span.entity); const pr = census.providers.get(span.entity); return renderName(orig, pr && pr.parsed, info, cfg.surrogate.providers); }
            if (cfg.surrogate.providers === 'code') return stringSurrogate('PROVIDER', orig, () => `Dr. ${String.fromCharCode(65 + (providerInfo.size + stringMap.size) % 26)}`);
            return renderOtherName(orig);
          }
          case 'NAME_OTHER': {
            if (/^[A-Z]\.?\s?[A-Z]\.?(?:\s?[A-Z]\.?)?$/.test(orig) && (orig.includes('.') || span.initials)) {
              // labelled initials: same punctuation, different letters, reversible through the mapping key
              return stringSurrogate('NAME', orig, () => { let i = 0; return orig.replace(/[A-Z]/g, () => { const f = i++ === 0 ? pick(LEX.FAKE_FIRST) : pick(LEX.FAKE_LAST); return f[0].toUpperCase(); }); });
            }
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
          case 'AGE': return orig.replace(/(?<!\d)(9\d|1[0-2]\d)(?!\d)/, '90+').replace(/\b(9|10)0s\b/, '90s+').replace(/nonagenarian|centenarian/i, '90+ y/o')
            .replace(/\b(?:ninety|one[-\s]hundred)(?:(?:[-\s]|\s+and\s+)(?:one|two|three|four|five|six|seven|eight|nine))?/i, '90+');
          case 'ADDRESS': return stringSurrogate('ADDRESS', orig, () => { const suf = (orig.match(/\b(Rd|Dr|St|Ave|Blvd|Pkwy|Ln|Ct|Hwy|Rte|Route|Way|Pl|Cir|Ter|Trl|Street|Avenue|Road|Drive|Lane|Court|Place|Boulevard|Parkway)\.?(?=\W*$|\s)/) || [])[1] || (/^\d/.test(orig) ? 'St' : 'Rd'); return `${/^\d/.test(orig) ? Math.floor(rng() * 900 + 100) + ' ' : ''}${pick(LEX.FAKE_LAST)} ${suf}${/\.$/.test(orig) && !/\.$/.test(suf) ? '.' : ''}`; });
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
      const halves = (l) => l.split(/[-\s]+/).map(alpha).filter((h) => h.length >= 3);
      for (const q of e.parsed) {
        const ql = alpha(q.last), qf = alpha(q.first);
        let lastOk = ql === last || (last.length >= 5 && ql.length >= 5 && levenshtein(last, ql) <= 1);
        // hyphenated / married surname: "Garcia-Lopez" vs "Garcia" or "Lopez", only with a matching DOB
        if (!lastOk && dobTie) { const a = halves(pn.last), b = halves(q.last); if ((a.length > 1 || b.length > 1) && a.some((h) => b.includes(h))) lastOk = true; }
        if (!lastOk) continue;
        // two different, complete, known first names (Maria vs Mario) are two people, even if one letter apart
        const distinctKnown = first && qf && first !== qf && first.length >= 3 && qf.length >= 3 && LEX.isFirstName(first) && LEX.isFirstName(qf);
        const firstOk = !first || !qf || first === qf || (first.length === 1 && qf.startsWith(first)) || (qf.length === 1 && first.startsWith(qf))
          || (!distinctKnown && first.length >= 4 && qf.length >= 4 && levenshtein(first, qf) <= 1);
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
  const LINE_NAME_RE = /(?<![\w,])([A-Z][A-Za-z'’\-]+(?:[ -][A-Z][A-Za-z'’\-]+)?),\s*([A-Z][A-Za-z'’\-]+)(?:\s+([A-Z])\b\.?)?(?![\w,])/g;
  const LINE_ID_RE = /(?<![\w\/\-.:])(?:MRN\s*[:#]?\s*)?([A-Z]{0,2}[0-9OIlSB]{6,10})(?![\w\/\-.:])/g;
  // a labelled MRN may be written with internal spaces or hyphens ("MRN#0041 2345", "MRN: 0041-2345")
  const LINE_MRN_LABEL_RE = /\b(?:MRN|MR#|Med\s*Rec(?:ord)?\s*(?:No|Num|#)?)\s*[:#]?\s*([A-Z]{0,2}[0-9OIlSB](?:[ \-]?[0-9OIlSB]){5,9})(?![\w\/\-.:])/gi;
  const LINE_CRED_AFTER = /^\s*,?\s*(?:MD|DO|NP|PA-C|PA|RN|LPN|BSN|MSN|DNP|APRN|CRNP|CNP|ARNP|PharmD|RPh|MSW|LCSW|FNP|ANP|PhD|DDS|DPM)\b/;
  const LINE_PROVIDER_BEFORE = /\b(?:per|dr\.?|doctor|called|call|with|w\/|by|see|seen|spoke|attending|pcp|provider|md|np|rn|onc|oncologist|referred|referral|signed|cc)\s*[:\-]?\s*$/i;
  const LINE_LABEL_BEFORE = /(?:^|\b(?:pt|patient|name|re|regarding|for|contact))\s*[:#\-]?\s*$/i;
  function parseTextDocument(text, opts) {
    const o = Object.assign({ carryForward: true, mrnPattern: null, sectionMarker: /^===/ }, opts || {});
    const lines = cellToString(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    const mrnRe = o.mrnPattern ? new RegExp(o.mrnPattern.replace(/^\\b|\\b$/g, ''), 'g') : null;
    const thisYear = new Date().getFullYear();
    const rows = []; let current = null; let found = 0, inherited = 0;
    for (const line of lines) {
      if (o.sectionMarker && o.sectionMarker.test(line)) { current = null; rows.push(['', '', '', line]); continue; }
      let name = '', mrn = '', dob = '';
      const hasIdOnLine = /\b(?:mrn|dob|acct|csn)\b/i.test(line) || /(?<![\w\/\-.:])[A-Z]{0,2}[0-9OIlSB]{6,10}(?![\w\/\-.:])/.test(line) || /\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/.test(line);
      LINE_NAME_RE.lastIndex = 0; let m;
      while ((m = LINE_NAME_RE.exec(line))) {
        const last = m[1], first = m[2];
        const after = line.slice(m.index + m[0].length), before = line.slice(0, m.index);
        // a clinician ("per Bruno, Georgiana MD", "Dr. Lee, Karen") is not a new patient
        if (LINE_CRED_AFTER.test(after) || LINE_PROVIDER_BEFORE.test(before)) continue;
        if (LEX.STATE_ABBR_SET.has(first) || LEX.CREDENTIAL_SET.has(first.toLowerCase()) || LEX.HONORIFIC_SET.has(last.toLowerCase())) continue;
        if (first.length < 2 && !m[3]) continue;
        // structural evidence: a column gap, pipe, identifier, DOB or label right beside the pair. It overrides the
        // word lists, so "Bell, Kevin  MRN 032767781" and "Hill, Rose  84445786" are captured.
        const structural = m.index === 0 || /^\s{2,}|^\s*[|\t]|^\s*\(?\s*(?:MRN|DOB|Acct|CSN|ID|MR#)\b|^\s*#?\s*[A-Z]{0,2}[0-9OIlSB]{6,10}(?![\w])|^\s*\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/i.test(after) || LINE_LABEL_BEFORE.test(before) || /(?:\s{2,}|[|\t]\s*)$/.test(before);
        if (!structural && (LEX.isClinical(last) || LEX.isClinical(first) || LEX.CITY_SET.has(last.toLowerCase()))) continue;
        // a mid-line pair with no identifier anywhere on the line, while a patient is being carried forward, is a
        // mention (a relative, a visitor), not a new census entry
        if (!structural && !hasIdOnLine && current && o.carryForward) continue;
        name = m[0].trim(); break;
      }
      // identifiers: explicit MRN label wins; else the first id-looking token that is not a phone/date/time
      const ids = [];
      const scan = (re, groupIdx) => { re.lastIndex = 0; let k; while ((k = re.exec(line))) { const raw = k[groupIdx] || k[0]; const norm = normalizeId(raw); const dcount = (norm.match(/\d/g) || []).length; if (dcount < 6) continue; const before = line.slice(Math.max(0, k.index - 6), k.index); ids.push({ raw, norm, labeled: /mrn/i.test(k[0]) || /mrn\s*[:#]?\s*$/i.test(before), index: k.index }); } };
      scan(LINE_MRN_LABEL_RE, 1);
      if (mrnRe) scan(mrnRe, 0);
      scan(LINE_ID_RE, 1);
      ids.sort((a, b) => (b.labeled - a.labeled) || (a.index - b.index));
      const phoneLike = (t) => /^\d{10}$/.test(t.norm) && /\d{3}[-.\s]\d{3}[-.\s]\d{4}|\(\d{3}\)/.test(line);
      const pick = ids.find((t) => !phoneLike(t) && !/^\d{4}-\d{2}-\d{2}$/.test(t.raw));
      if (pick && (name || pick.labeled || !o.requireNameForMrn)) mrn = pick.norm;
      // DOB: labeled, else a full date whose year makes an adult-ish age
      const dateSpans = ruleSpans(line, { mrnRegex: null, accountRegex: null, extraRegexes: [] }).filter((sp) => (sp.type === 'DATE' || sp.type === 'DOB') && sp.date && sp.date.hasYear);
      const labeled = dateSpans.find((sp) => sp.type === 'DOB' || /dob|birth|born/i.test(line.slice(Math.max(0, sp.start - 12), sp.start)));
      const cand = labeled || dateSpans.find((sp) => sp.date.y <= thisYear - 10 && sp.date.y >= 1900);
      if (cand && (name || mrn || labeled)) dob = cand.text;
      if (name || mrn) { current = { name, mrn, dob }; found++; }
      else if (current && o.carryForward) { inherited++; }
      const use = (name || mrn) ? { name, mrn, dob } : (current && o.carryForward ? current : { name: '', mrn: '', dob: '' });
      rows.push([use.name, use.mrn, use.dob, line]);
    }
    const headers = ['Patient Name', 'MRN', 'DOB', 'Line'];
    const columns = [{ header: 'Patient Name', index: 0, role: 'patient_name', reason: 'extracted from line', sample: [] }, { header: 'MRN', index: 1, role: 'mrn', reason: 'extracted from line', sample: [] }, { header: 'DOB', index: 2, role: 'dob', reason: 'extracted from line', sample: [] }, { header: 'Line', index: 3, role: 'text', reason: 'the text itself', sample: [] }];
    return { headers, rows, columns, stats: { lines: lines.length, linesWithPatient: found, linesInherited: inherited } };
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
    const firstPass = rows.map((row, ri) => { ctx.rowPatientKey = census.rowPatient[ri]; return textCols.map((ci) => { ctx.cellKey = `${ri}:${ci}`; return detectText(cellToString(row[ci]), ctx); }); });
    if (cfg.layers.propagate) {
      const all = []; firstPass.forEach((cells) => cells.forEach((sp) => all.push(...sp)));
      ctx.propagateRegex = collectPropagation(all, cfg);
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
      ctx.rowPatientKey = pk;
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
    for (const p of census.patients.values()) {
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
        [pn.first, pn.last, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((t) => { if (!t) return; const c = t.replace(/\.$/, ''); if (c.length >= 3) toks.add(c); c.split('-').forEach((h) => { if (h.length >= 3) toks.add(h); }); });
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
      if (!p.names.size && !(p.parsed && p.parsed.last)) unnamed.push({ entity: p.key, code: p.entity ? p.entity.code : '', row: p.rows[0] });
    }
    const outRows = result.rows, headers = result.headers;
    const ageAfterName = /(?:\b[A-Z][a-z]+,?\s|\b(?:turned|turning|is|now|age|aged)\s)(9\d|1[01]\d)(?![\d+\/%:]|\.\d|\s*(?:mg|mcg|kg|lb|lbs|ml|mL|cc|units?|%|mmhg|bpm|min|hrs?|yo|y\/o|yrs?|years?|day|days|x))/g;
    const vitalBefore = /\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc|room|chair|bay|ext|x|cycle|day|grade|stage|pain)\s*$/i;
    outRows.forEach((row, ri) => row.forEach((v, ci) => {
      const s = cellToString(v); if (!s) return;
      const header = headers[ci]; if (header === 'DeID Audit') return;
      const rowKey = census.rowPatient[ri];
      const seen = new Set();
      const push = (text, type, entity, kind) => { const k = `${text}|${type}`; if (seen.has(k)) return; seen.add(k); hits.push({ row: ri, col: ci, header, text, type, entity, kind }); };
      // 1. the census detector itself (names, MRNs, accounts, phones, DOBs in every rendering)
      censusSpans(s, census, rowKey).forEach((sp) => {
        if (sp.type === 'NAME_PROVIDER') { providerHits.push({ row: ri, col: ci, header, text: sp.text, type: sp.type }); return; }
        if (!/^(NAME_PATIENT|MRN|ACCOUNT|PHONE|DOB)$/.test(sp.type)) return;
        const p = census.patients.get(sp.entity);
        if (sp.type === 'DOB' && p && !dobHasYear(p.dob)) return;
        if (sp.type === 'DOB' && rowKey && rowKey !== sp.entity) { coincidences.push({ row: ri, col: ci, header, text: sp.text }); return; }
        if (sp.type === 'NAME_PATIENT' && (isCredentialToken(sp.text) || isMonthOfDate(s, sp.start, sp.end, sp.text))) return;
        push(sp.text, sp.type, sp.entity, 'census');
      });
      // 2. digits only: MRNs, accounts, phones and birthdates however they are spaced or punctuated
      const numRe = /\d(?:[ \-.\/()]{0,2}\d)+/g; let nm;
      while ((nm = numRe.exec(s))) {
        const d = nm[0].replace(/\D/g, ''); const k = d.replace(/^0+/, '');
        const hit = digitKeys.get(k) || digitKeys.get(d);
        if (!hit) continue;
        if (hit.type === 'DOB' && rowKey && rowKey !== hit.entity) { coincidences.push({ row: ri, col: ci, header, text: nm[0] }); continue; }
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
          if (nt.common && rowKey && rowKey !== nt.entity) { if (!nt.re.global) break; continue; }
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
    createRegistry, normalizeId, mrnKeyOf, dobKeyOf, levenshtein, parseTextDocument,
    cellToString, mulberry32, hashString, tokenize,
  };
});
