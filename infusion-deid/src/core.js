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
    if (m) { add(`${f} ${m} ${l}`); add(`${l}, ${f} ${m}`); add(`${f} ${m[0]}. ${l}`); add(`${f} ${m[0]} ${l}`); }
    if (f) { add(`${f[0]}. ${l}`); add(`${f[0]} ${l}`); }
    // hyphenated surnames: each half
    if (l.includes('-')) l.split('-').forEach((h) => { if (h.length >= 3) add(h); });
    return [...v].filter((x) => x.length >= 2);
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
      [...allVariants].forEach((v) => {
        // single ambiguous/common-word tokens must match with a capital letter, and
        // tokens that are also months/clinical words only match inside that patient's own rows
        const single = !/\s|,/.test(v);
        const exact = single && (LEX.isAmbiguous(v) || LEX.isClinical(v) || v.length <= 3);
        const rowScoped = single && (LEX.isClinical(v) || LEX.isAmbiguous(v) || v.length <= 3);
        addVariant(v, 'NAME_PATIENT', p.key, exact, rowScoped);
      });
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
    { kind: 'dMy', re: new RegExp(`(?<![\\w])(\\d{1,2})(?:st|nd|rd|th)?(?:-|[ \\t]{1,2})(?:of[ \\t]+)?${MONTH_RE}\\.?(?:(?:-|,?[ \\t]+)(\\d{4}|\\d{2}(?![\\/\\-.]\\d)(?![ \\t]*(?:-|[ \\t]|of[ \\t]+)?${MONTH_NC}\\b))(?![\\d:]))?(?![\\w])`, 'gi') },
    { kind: 'md', re: new RegExp('(?<![\\d\\w/.-])(\\d{1,2})([\\/\\-])(\\d{1,2})(?![\\d/-])(?!\\.\\d)(?!\\s*(?:mg|mcg|g|ml|tab|tabs|dose|x|units?|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5))', 'g') },
  ];
  const UNIT_AFTER = /^\s*(mg|mcg|g|ml|mL|tab|tabs|dose|x|unit|units|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5W?|AM|PM)\b/;

  function parseDateMatch(kind, m) {
    let y, mo, d, hasYear = true, yearDigits = 4, monthStyle = null, sep = '/', monthTok = null, ordinal = '';
    if (kind === 'iso') { y = +m[1]; mo = +m[2]; d = +m[3]; sep = '-'; }
    else if (kind === 'mdy') { mo = +m[1]; sep = m[2]; d = +m[3]; yearDigits = m[4].length; y = expandYear(m[4]); }
    else if (kind === 'Mdy') { monthTok = m[1]; mo = monthIndex(m[1]); d = +m[2]; if (m[3]) { yearDigits = m[3].length; y = expandYear(m[3]); } else { hasYear = false; y = new Date().getFullYear(); } }
    else if (kind === 'dMy') { d = +m[1]; monthTok = m[2]; mo = monthIndex(m[2]); if (m[3]) { yearDigits = m[3].length; y = expandYear(m[3]); } else { hasYear = false; y = new Date().getFullYear(); } }
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
    PHONE: /(?<![\d\w])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?(?![\d\w])|(?<![\d\w-])\d{3}-\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?(?![\d\w-])/gi,
    PHONE_PLAIN: /(?<![\d\w.-])\d{10}(?![\d\w.-])(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?/gi,
    AGE: /\b(?:age[d]?\s*:?\s*(9\d|1[0-2]\d)\b|(9\d|1[0-2]\d)\s*(?:-|\s)?\s*(?:y\/o|yo|y\.o\.|yrs?\.?(?:\s*old)?|years?(?:[-\s]old)?|year[-\s]old|yr[-\s]old)\b|\b(?:his|her|their)\s+(?:(?:early|mid|late)[-\s])?(9|10)0s\b|\b(?:nonagenarian|centenarian)\b)/gi,
    ADDRESS: /\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\.?\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail)\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/g,
    ZIP: /\b(?:[A-Z]{2}\s{1,2}\d{5}(?:-\d{4})?)\b|\bzip\s*(?:code)?\s*:?\s*\d{5}(?:-\d{4})?\b/g,
  };

  function ruleSpans(text, cfg) {
    const spans = [];
    const push = (m, type, extra) => spans.push(Object.assign({ start: m.index, end: m.index + m[0].length, type, source: 'rule', text: m[0] }, extra || {}));
    const run = (re, type, filter) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) { if (!filter || filter(m)) push(m, type); if (m[0].length === 0) re.lastIndex++; } };

    run(RULES.EMAIL, 'EMAIL'); run(RULES.URL, 'URL'); run(RULES.IP, 'IP'); run(RULES.SSN, 'SSN');
    run(RULES.PHONE, 'PHONE'); run(RULES.ADDRESS, 'ADDRESS'); run(RULES.ZIP, 'ZIP');
    run(RULES.AGE, 'AGE');
    const notPhoneExt = (m) => {
      const after = text.slice(m.index + m[0].length), before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/^\s*(?:x|ext\.?|extension)\s*\.?\s*\d/i.test(after)) return false; // phone extension follows
      if (/[-.(]\s*$/.test(before)) return false; // part of a formatted phone
      if (/^\d{5}(-\d{4})?$/.test(m[0]) && (/\b[A-Z]{2}\s+$/.test(before) || /zip\s*(code)?\s*:?\s*$/i.test(before))) return false; // ZIP code
      return true;
    };
    if (cfg.mrnRegex) run(cfg.mrnRegex, 'MRN', notPhoneExt);
    if (cfg.accountRegex) run(cfg.accountRegex, 'ACCOUNT', notPhoneExt);
    (cfg.extraRegexes || []).forEach((r) => run(r, 'ID_OTHER'));
    run(RULES.PHONE_PLAIN, 'PHONE');
    // dates
    for (const p of DATE_PATTERNS) {
      p.re.lastIndex = 0; let m;
      while ((m = p.re.exec(text))) {
        const pd = parseDateMatch(p.kind, m);
        if (!pd) continue;
        const after = text.slice(m.index + m[0].length);
        if (!pd.hasYear && UNIT_AFTER.test(after)) continue;
        // "C1D1"-style or "cycle 1/2" is not a date
        const before = text.slice(Math.max(0, m.index - 8), m.index);
        if (p.kind === 'md' && /(cycle|day|c\d*d?|dose|#|ratio|grade)\s*$/i.test(before) && !/next\s+cycle\s*$/i.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
        spans.push({ start: m.index, end: m.index + m[0].length, type: 'DATE', source: 'rule', text: m[0], date: pd });
      }
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
      let k = i;
      while (k > 0 && i - k < 5) {
        const p = toks[k - 1];
        if (used[k - 1] || endsSentence(p)) break;
        if (p.word && (p.cap || p.allcaps) && !isRel(p) && !isHon(p) && !isCred(p)) { if (!LEX.ORG_SUFFIX_SET.has(p.core.toLowerCase()) || LEX.ORG_NAMEWORD_SET.has(p.core.toLowerCase())) nonSuffix++; k--; continue; }
        if (p.word && /^(of|and|for|the|&)$/i.test(p.core) && k - 2 >= 0 && !used[k - 2] && toks[k - 2].word && (toks[k - 2].cap || toks[k - 2].allcaps) && i - k < 4) { k--; continue; }
        if (p.raw === '&') { k--; continue; }
        break;
      }
      // trim leading connectors and generic leading words
      while (k < i && /^(of|and|for|the|&|referred|referral|from|per|at|see|call|called|sent|to)$/i.test(toks[k].core)) k++;
      if (nonSuffix >= 1 && (k < i || j > i + 1)) {
        for (let q = k; q < j; q++) used[q] = true;
        spans.push({ start: toks[k].start, end: toks[j - 1].end, type: 'ORG', source: 'cue:org', conf: 0.75, text: text.slice(toks[k].start, toks[j - 1].end) });
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
      for (let q = i + 1; q < j; q++) used[q] = true;
      spans.push({ start: toks[i + 1].start, end: toks[j - 1].end, type: 'ORG', source: 'cue:facility', conf: 0.55, text: text.slice(toks[i + 1].start, toks[j - 1].end) });
      i = j - 1;
    }
    // Pass G1: City, ST (+ optional ZIP)
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t.word || used[i] || !(t.cap || t.allcaps)) continue;
      if (!(i + 2 < toks.length && toks[i + 1].raw === ',' && toks[i + 2].word && LEX.STATE_ABBR_SET.has(toks[i + 2].core) && toks[i + 2].core === toks[i + 2].core.toUpperCase())) continue;
      const st = toks[i + 2].core;
      if ((st === 'PA' || st === 'MD') && (inLex(t) || LEX.isClinical(t.core))) continue; // "Smith, PA" is a credential
      if (LEX.isClinical(t.core) && !LEX.CITY_SET.has(t.core.toLowerCase())) continue;
      let k = i;
      while (k > 0 && (toks[k - 1].cap || toks[k - 1].allcaps) && !used[k - 1] && i - k < 2 && (LEX.CITY_SET.has(toks[k - 1].core.toLowerCase()) || /^(new|san|los|las|saint|st|fort|ft|north|south|east|west|grand|lake|mount|mt|port)$/i.test(toks[k - 1].core))) k--;
      let e = i + 3;
      if (e < toks.length && toks[e].num && /^\d{5}$/.test(toks[e].raw)) e++;
      for (let q = k; q < e; q++) used[q] = true;
      spans.push({ start: toks[k].start, end: toks[e - 1].end, type: 'LOCATION', source: 'cue:city-state', conf: 0.8, text: text.slice(toks[k].start, toks[e - 1].end) });
      i = e - 1;
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
      while (j < toks.length && hops < 3 && !endsSentence(toks[j]) && (/^(named|is|was|,|:|\(|and|or|the|her|his|their|pt's|patient's|'s|'s)$/i.test(toks[j].raw) || /^(’s|'s)$/.test(toks[j].raw))) { j++; hops++; }
      const relaxedFirst = (toks[j].cap || toks[j].allcaps) && inLex(toks[j]) && !(allow && allow.has(toks[j].core.toLowerCase()));
      if (j < toks.length && (isNameish(toks[j], allow) || relaxedFirst) && !isCred(toks[j]) && !isRel(toks[j]) && !isHon(toks[j])) {
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
        // walk back to include preceding name-ish tokens (First Last) or "Last, First"
        const nameishRelaxed = (t) => isNameish(t, allow) || ((t.cap || t.allcaps) && inLex(t) && !(allow && allow.has(t.core.toLowerCase())));
        let k = i; while (k > 0 && nameishRelaxed(toks[k - 1]) && !used[k - 1] && !endsSentence(toks[k - 1]) && i - k < 2) k--;
        if (k === i && k >= 2 && toks[k - 1].raw === ',' && nameishRelaxed(toks[k - 2]) && !used[k - 2] && !toks[k - 2].initial) k -= 2;
        addRun(k, i + 1, 'NAME_OTHER', 'cue:relation', 0.8);
      }
    }
    // Pass E: lexicon names without cue
    for (let i = 0; i < toks.length; i++) {
      if (used[i]) continue;
      const t = toks[i];
      if (!(t.cap || t.allcaps) || t.initial) continue;
      if (!isNameish(t, allow)) continue;
      if (!inLex(t)) continue;
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
      if (used[i] || !(t.cap || t.allcaps) || LEX.isClinical(t.core) || (allow && allow.has(t.core.toLowerCase())) || isRel(t) || isHon(t) || isCred(t)) continue;
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
      spans.push({ start: m.index, end: m.index + m[0].length, type: hit.type, source: 'census', entity: own ? rowPatientKey : hit.entities[0], text: m[0], conf: 1 });
    }
    if (census.mrnNorm && census.mrnNorm.size) {
      // tokens that are MRNs with OCR confusions (O for 0, l for 1, S for 5 ...)
      const idRe = /(?<![\w\/\-.:])[A-Z]{0,2}[0-9OIlSB]{6,10}(?![\w\/\-.:])/g; let k;
      while ((k = idRe.exec(text))) {
        if (/^\d+$/.test(k[0]) && census.lookup.has(k[0].toLowerCase())) continue; // exact match already handled
        const ent = census.mrnNorm.get(mrnKeyOf(k[0]));
        if (ent && (k[0].match(/\d/g) || []).length >= 4) spans.push({ start: k.index, end: k.index + k[0].length, type: 'MRN', source: 'census', entity: ent, text: k[0], conf: 0.9 });
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
      // An organization/address/location that wholly contains name spans replaces them (St. Mary's Hospital).
      if (/^(ORG|ADDRESS|LOCATION)$/.test(s.type) && hits.every((k) => COARSE(k.type) === 'NAME' && k.start >= s.start && k.end <= s.end)) {
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
      if (COARSE(s.type) !== 'NAME' || s.source === 'census' || s.source === 'propagate') continue;
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
    const rng = mulberry32(cfg.seed);
    // Words present in the document: a surrogate must never be a real token from the report.
    const docWords = new Set(((documentText || '').toLowerCase().match(/[a-z][a-z'’\-]+/g) || []));
    const taken = new Set();
    const pick = (pool) => {
      const usable = pool.filter((x) => !docWords.has(x.toLowerCase()));
      const fresh = usable.filter((x) => !taken.has(x.toLowerCase()));
      const from = fresh.length ? fresh : usable.length ? usable : pool; // reuse components once the pool is exhausted
      const x = from[Math.floor(rng() * from.length)];
      taken.add(x.toLowerCase());
      return x;
    };
    const randDigits = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rng() * 10); return s; };
    const range = cfg.surrogate.shiftRange || [30, 365];
    const randOffset = () => { const mag = range[0] + Math.floor(rng() * (range[1] - range[0] + 1)); return rng() < 0.5 ? -mag : mag; };

    const patientInfo = new Map(); // key -> {code, fakeFirst, fakeLast, offset}
    const providerInfo = new Map();
    const tokenMap = new Map(); // lowercased name token -> fake
    const stringMap = new Map(); // type|lower -> fake
    const docOffset = randOffset();
    const mapping = { patients: [], providers: [], others: [] };

    const ensurePatient = (key) => {
      let info = patientInfo.get(key);
      if (!info) {
        const p = census.patients.get(key);
        const e = p && p.entity ? p.entity : (census.registry && census.registry.get(key)) || null;
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
        info = { key, code: `Dr. ${String.fromCharCode(65 + (idx % 26))}${idx >= 26 ? Math.floor(idx / 26) : ''}`, fakeFirst: pick(LEX.FAKE_FIRST), fakeLast: pick(LEX.FAKE_LAST) };
        providerInfo.set(key, info);
        if (pr && pr.parsed) { tokenMap.set(pr.parsed.last.toLowerCase(), info.fakeLast); if (pr.parsed.first) tokenMap.set(pr.parsed.first.toLowerCase(), info.fakeFirst); }
        mapping.providers.push({ Code: info.code, SurrogateName: `${info.fakeLast}, ${info.fakeFirst}`, RealName: pr ? pr.raw : key });
      }
      return info;
    };
    const stringSurrogate = (type, original, make) => {
      const k = `${type}|${original.toLowerCase()}`;
      if (!stringMap.has(k)) { const fake = make(); stringMap.set(k, fake); mapping.others.push({ Type: type, Original: original, Surrogate: fake }); }
      return stringMap.get(k);
    };
    const matchCase = (orig, fake) => (orig === orig.toUpperCase() && /[A-Z]/.test(orig) ? fake.toUpperCase() : fake);

    // Render a name surrogate in the same shape as the original text.
    const renderName = (origText, parsedEntity, info, mode) => {
      if (mode === 'code') return info.code;
      const parsed = parseName(origText);
      if (!parsed) return `${info.fakeLast}, ${info.fakeFirst}`;
      const cred = parsed.credentials ? ' ' + parsed.credentials : '';
      let out;
      if (parsed.format === 'last_first') out = `${info.fakeLast}, ${info.fakeFirst}${parsed.middle ? ' ' + parsed.middle[0] + '.' : ''}`;
      else if (parsed.format === 'single') {
        const lower = parsed.last.toLowerCase();
        if (parsedEntity && parsedEntity.first && lower === parsedEntity.first.toLowerCase()) out = info.fakeFirst;
        else if (parsedEntity && lower === parsedEntity.last.toLowerCase()) out = info.fakeLast;
        else out = LEX.isFirstName(parsed.last) && !LEX.isSurname(parsed.last) ? info.fakeFirst : info.fakeLast;
      } else out = `${/^[A-Z]\.?$/.test(parsed.first) ? info.fakeFirst[0] + '.' : info.fakeFirst} ${info.fakeLast}`;
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
        if (!tokenMap.has(k)) {
          const fake = asFirst ? pick(LEX.FAKE_FIRST) : pick(LEX.FAKE_LAST);
          tokenMap.set(k, fake);
          mapping.others.push({ Type: 'NAME', Original: t, Surrogate: fake });
        }
        return matchCase(t, tokenMap.get(k));
      };
      let out;
      if (parsed.format === 'last_first') out = `${tok(parsed.last, false)}, ${tok(parsed.first, true)}${parsed.middle ? ' ' + parsed.middle : ''}`;
      else if (parsed.format === 'single') out = tok(parsed.last, LEX.isFirstName(parsed.last) && !LEX.isSurname(parsed.last));
      else out = [tok(parsed.first, true), ...(parsed.middle ? parsed.middle.split(' ').map((m) => tok(m, true)) : []), tok(parsed.last, false)].join(' ');
      return out + cred;
    };

    const fakePhone = (orig) => stringSurrogate('PHONE', orig, () => {
      const digits = ('555010' + randDigits(4)).split(''); let di = 0;
      // keep separators, swap digits; if more than 10 digits (ext), randomize the rest
      let out = '', count = (orig.match(/\d/g) || []).length;
      for (const ch of orig) { if (/\d/.test(ch)) { out += count === 7 ? (di < 3 ? '555'[di] : digits[di + 3] || randDigits(1)) : (digits[di] || randDigits(1)); di++; } else out += ch; }
      return out;
    });
    const fakeDigits = (type, orig) => stringSurrogate(type, orig, () => orig.replace(/\d/g, () => randDigits(1)).replace(/^(\D*)\d/, '$19'));

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
          case 'NAME_OTHER': return renderOtherName(orig);
          case 'MRN': { if (span.entity) return ensurePatient(span.entity).code; return fakeDigits('MRN', orig); }
          case 'ACCOUNT': { if (span.entity) return `A-${ensurePatient(span.entity).code}`; return fakeDigits('ACCOUNT', orig); }
          case 'PHONE': return fakePhone(orig);
          case 'EMAIL': return stringSurrogate('EMAIL', orig, () => `${pick(LEX.FAKE_FIRST).toLowerCase()}.${pick(LEX.FAKE_LAST).toLowerCase()}@example.com`);
          case 'SSN': return stringSurrogate('SSN', orig, () => `9${randDigits(2)}-${randDigits(2)}-${randDigits(4)}`);
          case 'URL': return '[url]';
          case 'IP': return '[ip]';
          case 'ID_OTHER': return fakeDigits('ID', orig);
          case 'DOB':
          case 'DATE': {
            const pd = span.date || (() => { for (const p of DATE_PATTERNS) { p.re.lastIndex = 0; const m = p.re.exec(orig); if (m && m[0] === orig) return parseDateMatch(p.kind, m); } return null; })();
            if (!cfg.surrogate.dateShift) return span.type === 'DOB' ? '[dob]' : '[date]';
            if (!pd) return '[date]';
            const key = span.entity || rowPatientKey;
            const off = key ? ensurePatient(key).offset : docOffset;
            return renderDate(pd, shiftDate(new Date(pd.y, pd.m - 1, pd.d), off));
          }
          case 'AGE': return orig.replace(/\b(9\d|1[0-2]\d)\b/, '90+').replace(/\b(9|10)0s\b/, '90s+').replace(/nonagenarian|centenarian/i, '90+ y/o');
          case 'ADDRESS': return stringSurrogate('ADDRESS', orig, () => `${Math.floor(rng() * 900 + 100)} ${pick(LEX.FAKE_LAST)} St`);
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

  function createRegistry(seedRows) {
    const entities = [];
    const byMrn = new Map();
    let next = 1;
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
      for (const q of e.parsed) {
        const ql = alpha(q.last), qf = alpha(q.first);
        const lastOk = ql === last || (last.length >= 5 && ql.length >= 5 && levenshtein(last, ql) <= 1);
        if (!lastOk) continue;
        const firstOk = !first || !qf || first === qf || (first.length === 1 && qf.startsWith(first)) || (qf.length === 1 && first.startsWith(qf)) || (first.length >= 4 && qf.length >= 4 && levenshtein(first, qf) <= 1);
        if (firstOk) return true;
      }
      return false;
    };
    const reg = {
      entities,
      get size() { return entities.length; },
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
      if (r.SurrogateName) { const [l, f] = String(r.SurrogateName).split(/,\s*/); e.fakeLast = l || null; e.fakeFirst = f || null; }
      if (r.DateOffsetDays !== '' && r.DateOffsetDays != null && !isNaN(+r.DateOffsetDays)) e.offset = +r.DateOffsetDays;
    });
    return reg;
  }

  // ---------------------------------------------------------------------
  // 5c. Text documents (pasted text or OCR output) -> table with a line census
  // ---------------------------------------------------------------------
  const LINE_NAME_RE = /(?<![\w,])([A-Z][A-Za-z'’\-]+(?:[ -][A-Z][A-Za-z'’\-]+)?),\s*([A-Z][A-Za-z'’\-]+)(?:\s+([A-Z])\b\.?)?(?![\w,])/g;
  const LINE_ID_RE = /(?<![\w\/\-.:])(?:MRN\s*[:#]?\s*)?([A-Z]{0,2}[0-9OIlSB]{6,10})(?![\w\/\-.:])/g;
  function parseTextDocument(text, opts) {
    const o = Object.assign({ carryForward: true, mrnPattern: null, sectionMarker: /^===/ }, opts || {});
    const lines = cellToString(text).split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    const mrnRe = o.mrnPattern ? new RegExp(o.mrnPattern.replace(/^\\b|\\b$/g, ''), 'g') : null;
    const thisYear = new Date().getFullYear();
    const rows = []; let current = null; let found = 0, inherited = 0;
    for (const line of lines) {
      if (o.sectionMarker && o.sectionMarker.test(line)) { current = null; rows.push(['', '', '', line]); continue; }
      let name = '', mrn = '', dob = '';
      LINE_NAME_RE.lastIndex = 0; let m;
      while ((m = LINE_NAME_RE.exec(line))) {
        const last = m[1], first = m[2];
        if (LEX.isClinical(last) || LEX.isClinical(first) || LEX.STATE_ABBR_SET.has(first) || LEX.CREDENTIAL_SET.has(first.toLowerCase()) || LEX.CITY_SET.has(last.toLowerCase()) || LEX.HONORIFIC_SET.has(last.toLowerCase())) continue;
        if (first.length < 2 && !m[3]) continue;
        name = m[0].trim(); break;
      }
      // identifiers: explicit MRN label wins; else the first id-looking token that is not a phone/date/time
      const ids = [];
      const scan = (re, groupIdx) => { re.lastIndex = 0; let k; while ((k = re.exec(line))) { const raw = k[groupIdx] || k[0]; const norm = normalizeId(raw); const dcount = (norm.match(/\d/g) || []).length; if (dcount < 6) continue; const before = line.slice(Math.max(0, k.index - 6), k.index); ids.push({ raw, norm, labeled: /mrn/i.test(k[0]) || /mrn\s*[:#]?\s*$/i.test(before), index: k.index }); } };
      if (mrnRe) scan(mrnRe, 0);
      scan(LINE_ID_RE, 1);
      ids.sort((a, b) => (b.labeled - a.labeled) || (a.index - b.index));
      const phoneLike = (t) => /^\d{10}$/.test(t.norm) && /\d{3}[-.\s]\d{3}[-.\s]\d{4}|\(\d{3}\)/.test(line);
      const pick = ids.find((t) => !phoneLike(t) && !/^\d{4}-\d{2}-\d{2}$/.test(t.raw));
      if (pick && (name || pick.labeled || !o.requireNameForMrn)) mrn = pick.norm;
      // DOB: labeled, else a full date whose year makes an adult-ish age
      const dateSpans = ruleSpans(line, { mrnRegex: null, accountRegex: null, extraRegexes: [] }).filter((sp) => sp.type === 'DATE' && sp.date && sp.date.hasYear);
      const labeled = dateSpans.find((sp) => /dob|birth|born/i.test(line.slice(Math.max(0, sp.start - 12), sp.start)));
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
        const parts = [detail.patientCode || '-', Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ') || 'no text PHI', Object.entries(srcs).map(([k, v]) => `${k}:${v}`).join(' '), cfg.surrogate.dateShift ? `shift:${offset > 0 ? '+' : ''}${offset}d` : 'dates removed'];
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
    // the registry is the session-wide key: every patient linked so far, with codes, surrogates and offsets
    mapping.patients = registry.toMappingRows();
    mapping.meta = { seed: cfg.seed, processedAt: new Date().toISOString(), documentOffsetDays: sur.docOffset, mrnPattern: cfg.inferredMrnPattern || cfg.mrnPattern || '', columns: columns.map((c) => ({ header: c.header, role: c.role })) };
    return { headers: outHeaders, rows: outRows, columns, census, details, stats, mapping, cfg, registry };
  }

  // Re-identify: reverse the mapping on a de-identified table.
  function reidentify(table, mapping) {
    const headers = table.headers.map(cellToString);
    const roles = new Map((mapping.meta && mapping.meta.columns || []).map((c) => [c.header, c.role]));
    const byCode = new Map(mapping.patients.map((p) => [p.Code, p]));
    const reverse = [];
    const firstOf = (v) => String(v || '').split(/;\s*/)[0];
    mapping.patients.forEach((p) => { const real = firstOf(p.RealName), mrn = firstOf(p.MRN); if (p.SurrogateName) reverse.push([p.SurrogateName, real]); const [l, f] = String(p.SurrogateName || '').split(', '); if (f) reverse.push([`${f} ${l}`, real]); if (f) { reverse.push([f, firstOf(real.includes(',') ? real.split(',')[1].trim() : real.split(' ')[0])]); reverse.push([l, real.includes(',') ? real.split(',')[0] : real.split(' ').slice(-1)[0]]); } reverse.push([p.Code, mrn || real]); });
    mapping.providers.forEach((p) => { reverse.push([p.SurrogateName, p.RealName]); const [l, f] = p.SurrogateName.split(', '); if (f) reverse.push([`${f} ${l}`, p.RealName]); });
    mapping.others.forEach((o) => reverse.push([o.Surrogate, o.Original]));
    reverse.sort((a, b) => b[0].length - a[0].length);
    const re = reverse.length ? new RegExp(`(?<![\\w])(?:${reverse.map((r) => escapeRe(r[0])).join('|')})(?![\\w])`, 'g') : null;
    const lookup = new Map(reverse.map((r) => [r[0], r[1]]));
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
        let s = cellToString(v);
        if (re) s = s.replace(re, (m) => lookup.get(m) || m);
        if (off && (role === 'date' || role === 'text')) {
          for (const pat of DATE_PATTERNS) { pat.re.lastIndex = 0; s = s.replace(pat.re, (m, ...g) => { const mm = [m, ...g.slice(0, -2)]; mm.index = 0; const pd = parseDateMatch(pat.kind, mm); return pd ? renderDate(pd, shiftDate(new Date(pd.y, pd.m - 1, pd.d), off)) : m; }); }
        }
        out[ci] = s;
      });
      return out;
    });
    return { headers, rows };
  }

  const VERSION = '0.1.0';
  return {
    VERSION, TYPES, COARSE, ROLES, ROLE_LABELS, classifyColumns, inferIdPattern, parseName, nameVariants, buildCensus,
    detectText, ruleSpans, lexiconSpans, censusSpans, resolveSpans, mergeAdjacentNames, collectPropagation,
    parseDateString, renderDate, shiftDate, dateRenderings, bandAge,
    Surrogator, applySpans, defaultConfig, compileConfig, processTable, reidentify,
    createRegistry, normalizeId, mrnKeyOf, dobKeyOf, levenshtein, parseTextDocument,
    cellToString, mulberry32, hashString, tokenize,
  };
});
