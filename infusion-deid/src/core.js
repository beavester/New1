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
  // Optimal string alignment distance: insertions, deletions, substitutions and swaps of two neighbouring letters each count
  // one ("Okonkow" is one from "Okonkwo"). Bounded words only (callers pass names).
  function osaDistance(a, b) {
    if (a === b) return 0;
    const n = a.length, m = b.length; if (!n) return m; if (!m) return n;
    if (Math.abs(n - m) > 2) return 3;
    let p2 = null, p1 = Array.from({ length: m + 1 }, (_, j) => j);
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      for (let j = 1; j <= m; j++) {
        let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
        cur[j] = v;
      }
      p2 = p1; p1 = cur;
    }
    return p1[m];
  }
  // a word and each of its one-letter deletions: two words one edit (or one swap) apart share one of these keys
  const deletionKeys = (w) => { const out = [w]; for (let i = 0; i < w.length; i++) out.push(w.slice(0, i) + w.slice(i + 1)); return out; };
  const isDate = (v) => v instanceof Date && !isNaN(v.getTime());
  const pad2 = (n) => String(n).padStart(2, '0');
  const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  function cellToString(v) {
    if (v == null) return '';
    if (isDate(v)) return `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}`;
    if (typeof v === 'string') return v;
    try { return String(v); } catch (e) { return ''; } // an object whose toString throws, a Symbol
  }
  // Text as the detectors expect it: NFC (a name typed with combining accents matches its composed form), no zero-width or
  // soft-hyphen characters hiding inside a word ("Har\u200Briet"), every Unicode space a plain space, Unicode line separators
  // as newlines, curly quotes and apostrophes straight. Idempotent, so offsets computed on normalised text stay valid.
  const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD\u180E]/g;
  const UNI_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
  function normalizeText(s) {
    if (typeof s !== 'string' || !s) return s;
    let t = s;
    if (/[^\x00-\x7F]/.test(t)) {
      try { t = t.normalize('NFC'); } catch (e) { /* lone surrogates: leave as is */ }
      t = t.replace(ZERO_WIDTH, '').replace(UNI_SPACE, ' ').replace(/[\u2028\u2029]/g, '\n')
        .replace(/[\u2018\u2019\u201A\u201B\u2032\u02BC\uFF07]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033\uFF02]/g, '"');
    }
    return t;
  }
  // strings are normalised; numbers, booleans, dates and empty cells pass as they are; any other object (a rich-text run, an
  // array, a value whose toString throws) becomes its text, so nothing unread reaches the output
  // a BigInt becomes its digits; a value that cannot be read at all (a revoked proxy) throws, and the whole run fails closed
  function normalizeCell(v) { return typeof v === 'string' ? normalizeText(v) : (v == null || typeof v === 'number' || typeof v === 'boolean' || isDate(v)) ? v : normalizeText(cellToString(v)); }
  // A cell written to a spreadsheet that starts with = + - @ (or a tab or carriage return) is read as a formula by Excel and
  // LibreOffice: prefix a single quote so it stays text. Other values are returned untouched.
  function safeCell(value) {
    return typeof value === 'string' && /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/.test(value) ? "'" + value : value; // also the full-width forms
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
    // where a transferred or referred patient came from: free text (a facility name with its town)
    { role: 'text', re: /\b(?:outside|referring|referral|transfer(?:ring)?|sending|prior|previous|home)\s+(?:facility|hospital|site|location|center|centre|clinic|institution)\b|^\s*(?:facility|from\s+facility|transferred\s+from)\s*$/i },
    { role: 'dob', re: /\b(dob|d\.o\.b|date of birth|birth\s*date|birthdate|born)\b/i },
    { role: 'mrn', re: /\b(mrn|mr\s*#|med(ical)?\s*rec(ord)?\s*(no|num|number|#)?|chart\s*(no|#))(?:\b|(?<=#))/i },
    { role: 'account', re: /\b(acct|account|har|csn|encounter|contact serial|visit\s*(id|#|no)|fin\b|financial)\b/i },
    { role: 'phone', re: /\b(phone|tel|telephone|mobile|cell|fax|contact\s*(no|number|#))\b/i },
    { role: 'provider', re: /\b(provider|attending|physician|ordering|prescrib|doctor|\bdr\b|oncologist|referring|pcp|nurse|\brn\b|pharmacist|md\b|signed by|entered by|authoriz)/i, not: /\b(note|notes|comment|comments|instruction|instructions|remark|remarks|message|narrative|fax|phone|tel)\b/i },
    { role: 'age', re: /^\s*age\b|\b(?:pt|pat|patient)\s*age\b|\bage\s*\(?(?:y|yr|yrs|years)?\)?\s*$/i },
    { role: 'dob', re: /\bbirth\s*(?:dt|date)?\b|\bb\.?day\b/i },
    { role: 'provider', re: /^\s*(?:(?:ref|refer|referring|ord|ordering|outside|consult|sched|admitting|treating|primary)\.?\s*)?(?:prov|prov\.|provider|attending|attend|md|phys|physician|doc|dr|onc|oncologist|pcp)\s*(?:last|first|name|ln|fn|last\s*name|first\s*name)?\s*$|^\s*referring\s*$/i },
    { role: 'drop', re: /\b(?:emerg(?:ency)?\s*contact|emerg\s*cont|e\.?c\.?\s*name|contact\s*name|next\s*of\s*kin|\bnok\b|kin\b|guar(?:antor)?\b|caregiver\s*name|poa\s*name|proxy\s*name|spouse\s*name)/i },
    // a patient name split over two columns ("Pt Last" / "Pt First", "Last Name" / "First Name", "Surname" / "Given")
    { role: 'patient_name', re: /^\s*(?:pt|pat|patient)?\s*\.?\s*(?:last|first|sur|given|family|middle)\s*(?:name|nm)?\s*$/i },
    { role: 'zip', re: /\b(zip|postal)\b/i },
    { role: 'drop', re: /^\s*(?:apt|apt\.?\s*(?:#|no\.?)|apartment|suite|ste\.?|unit\s*(?:#|no\.?)|address\s*(?:line\s*)?2|addr\s*2)\s*$/i },
    { role: 'drop', re: /\b(address|street|city|state|email|e-mail|ssn|social security|guarantor|emergency contact|insurance id|member id|policy|subscriber|license|device serial|photo|employer)\b/i },
    // identifier columns that are not record numbers: authorizations, device serials, vehicle plates, placards, claims
    { role: 'drop', re: /\b(?:auth(?:orization)?\s*(?:#|no|num|number|id|code)?|prior\s*auth|serial|s\/n|sn\s*#|plate|vehicle|placard|permit|claim\s*(?:#|no|id)|implant\s*(?:id|#)|device\s*(?:id|#)|udi)\b|^\s*(?:sn|auth)\s*#?\s*$/i, not: /\b(?:note|notes|comment|comments|status|date|type|reason|instruction|instructions|remarks?)\b/i },
    { role: 'patient_name', re: /^\s*(pt|patient|client|resident)\s*\.?\s*$/i },
    { role: 'patient_name', re: /\b(?:nick\s*name|nickname|preferred\s*(?:name|nm)|goes\s*by|alias|aka|known\s*as|pref\s*name)\b/i },
    { role: 'patient_name', re: /\b(pt|patient)?\s*(name|full name|pt name|patient name|last,? first|legal name)\b/i, not: /provider|physician|attending|md|\bdr\b|nurse|pharmacist|chair|regimen|drug|protocol|order|user|entered|signed|location|dept|department|clinic|facility|insurance|plan|study|trial/i },
    { role: 'text', re: /\b(comment|note|notes|instruction|remark|reason|indication|message|description|free\s*text|narrative|sched(uling)?\s*note|appt\s*note|special|alert|question|answer|response|reply|detail)|\b(?:cmnts?|cmts?|rmks?|instr|msg)\b/i },
    { role: 'date', re: /\b(date|dt|appt|appointment|scheduled|sched|dos|visit|start|end|due|due date|next|last|time stamp|timestamp|created|updated|entered on|ordered on|hookup|hook-up|connect|disconnect|admit|admitted|discharge|discharged|infused on|given on)\b/i, not: /time\s*$/i },
  ];

  const NICK_HEADER = /\b(?:nick\s*name|nickname|preferred\s*(?:name|nm)|goes\s*by|alias|aka|known\s*as|pref\.?\s*(?:name|nm))\b/i;
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
  const IDENT_VALUE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|\b(?:https?:\/\/|www\.)\S+|\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\.?\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Pike|Pkwy|Hwy|Cir|Ter|Trl)\b|\b(?:P\.?\s?O\.?\s?Box|(?:RR|Rural\s+Route)\s*\d+\s*,?\s*Box)\s*#?\s*\d+|\b\d{3}-\d{2}-\d{4}\b|\b(?:user(?:name)?|login|handle|proxy)\b\s*[:#]?\s*(?:[a-z]+\s+)?[a-z][a-z0-9]*(?:[._][a-z0-9]+)+|\buser(?:name)?\s*[:#]?\s*[a-z][a-z0-9]*\d/i;

  // "KRISTOFFERSEN,ELSA (MRN:2210984)" -> { name: 'KRISTOFFERSEN,ELSA', mrn: '2210984' }
  // "Holloway-Pryce, Ambrose / 05.19.1949", "Igwe, Chidinma (DOB 12/12/1970)": the birthdate inside a name cell
  // Matched against the end of the cell only (the cell is trimmed and its whitespace runs collapsed first, and every quantifier
  // is bounded), so a name cell padded with thousands of spaces or blank lines costs linear time.
  const NAME_DOB_RE = /(?:[\/|\-–,] ?)?[(\[]? ?(?:(?:DOB|D\.O\.B\.?|born|b\.) ?[:#]? ?)?(\d{1,2}[\/\-.]\d{1,2}[\/\-.](?:\d{4}|\d{2})|(?:19|20)\d{2}-\d{2}-\d{2}) ?[)\]]?$/i;
  // a trailing separator (and the spaces around it) removed without a backtracking regex
  function stripTrailingSep(s, seps) {
    let t = s.trimEnd();
    if (t && seps.includes(t[t.length - 1])) t = t.slice(0, -1).trimEnd();
    return t;
  }
  function splitNameId(raw) {
    let s = cellToString(raw).replace(/\s+/g, ' ').trim();
    let dob = '';
    const tailAt = Math.max(0, s.length - 64); // a date with its label and brackets is far shorter than this
    const dm = s.slice(tailAt).match(NAME_DOB_RE);
    const dmIndex = dm ? tailAt + dm.index : -1;
    if (dm && /[A-Za-z]{2,}/.test(s.slice(0, dmIndex))) { dob = dm[1]; s = stripTrailingSep(s.slice(0, dmIndex), '|-–/,').trim(); }
    const r = splitNameIdCore(s); r.dob = dob; return r;
  }
  function splitNameIdCore(s) {
    // "Echevarria, Teodoro [3310772]", "Smith, Ann (MRN 4471)", "Moreau-Banda, Luc 2211037": a labelled record number of any
    // length, a bracketed number of 5+ digits, or a bare one of 6-10 digits is the record number, never part of the name
    // (whitespace runs are collapsed by the caller; the quantifiers are bounded all the same)
    const m = s.match(/[(\[] {0,3}(?:MRN|MR#|MR|Med {0,3}Rec(?:ord)? {0,3}(?:No\.?|#)?|Chart {0,3}(?:No\.?|#)?) {0,3}[:#]? {0,3}([A-Z]{0,2}\d{3,12}) {0,3}[)\]]/i)
      || s.match(/[(\[] {0,3}#? {0,3}([A-Z]{0,2}\d{5,12}) {0,3}[)\]]/)
      || s.match(/(?:[(\[] {0,3})?(?:(?:MRN|MR#|MR|Med {0,3}Rec(?:ord)? {0,3}(?:No|#)?) {0,3}[:#]? {0,3})?\b([A-Z]{0,2}\d{6,10})\b(?: {0,3}[)\]])?/i);
    if (!m || !/[A-Za-z]{2,}/.test(s.slice(0, m.index))) return { name: s, mrn: '' };
    const name = stripTrailingSep((s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)), '|-–/').replace(/\s+/g, ' ').trim();
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
    const sample = (Array.isArray(rows) ? rows : []).slice(0, 200).map((r) => (Array.isArray(r) ? r : []));
    const cols = (Array.isArray(headers) ? headers : []).map((h, ci) => {
      const header = String(h == null ? '' : h).trim();
      let role = null, reason = '';
      for (const r of HEADER_RULES) {
        if (r.re.test(header) && !(r.not && r.not.test(header))) { role = r.role; reason = 'header'; break; }
      }
      const vals = sample.map((r) => r[ci]).filter((v) => v != null && v !== '');
      const n = vals.length || 1;
      const PLACEHOLDER = /^\s*(?:-+|—|–|n\/?a|na|none|tbd|tba|pending|\?+|x|\.)\s*$/i;
      const realVals = vals.filter((v) => !PLACEHOLDER.test(cellToString(v)));
      const dateLike = realVals.length ? realVals.filter((v) => isDate(v) || looksLikeDate(cellToString(v))).length / realVals.length : 0;
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
      const nameIdLike = strs.filter((s) => { const sp = splitNameId(s); return sp.mrn && /^[A-Za-z'’\- ]+,\s*[A-Za-z'’\-]+/.test(sp.name); }).length / n;
      // short codes that are identifiers of some kind: serials, plates, authorizations ("SN 2026-CS-448190", "plate 7KXM218",
      // "PA-2026-0091827", "AMB-0099412"); doses, dates, times and room/chair numbers are not
      const codeLike = strs.filter((s) => isCodeValue(s)).length / n;
      // the second line of an address in its own column ("Unit 2B", "Apt 4", "#12", "Lot 19")
      const unitLike = strs.filter((s) => /^\s*(?:apt|apartment|unit|suite|ste|lot|#)\.?\s*#?\s*[A-Za-z]?\d+[A-Za-z]?\s*$/i.test(s)).length / n;

      if (!role) {
        if (vals.length === 0) { role = 'keep'; reason = 'empty'; }
        else if (dateLike > 0.8) { role = 'date'; reason = 'values look like dates'; }
        else if (phoneLike > 0.8) { role = 'phone'; reason = 'values look like phone numbers'; }
        else if (nameLike > 0.8) { role = 'patient_name'; reason = 'values look like "Last, First"'; }
        else if (idLike > 0.8) { role = 'mrn'; reason = 'values look like record numbers'; }
        else if (nameIdLike > 0.8) { role = 'patient_name'; reason = 'values look like a name with its record number'; }
        else if (unitLike > 0.6 && !/\b(?:lot|ndc|batch|exp|kit|drug|med|dose|chair|bay|room|bed)\b/i.test(header)) { role = 'drop'; reason = 'values look like apartment or unit numbers of an address'; }
        else if (codeLike > 0.6 && !/\b(?:lot|ndc|batch|exp|expiry|kit|cpt|hcpcs|icd|code|regimen|protocol|drug|med|dose)\b/i.test(header)) { role = 'drop'; reason = 'values look like identifiers (serial, plate or authorization numbers)'; }
        else if (avgLen > 25 && spacey > 0.5) { role = 'text'; reason = 'long free text'; }
        else if (identLike > 0 || relLike > 0) { role = 'text'; reason = 'values hold contact details or names'; }
        else { role = 'keep'; reason = 'short categorical values'; }
      } else if (role === 'dob' && /\b(?:pt|patient|name)\b/i.test(header) && strs.filter((s) => /^[A-Za-z'’\-]+,\s*[A-Za-z]/.test(s.trim())).length / n > 0.5) {
        // a merged "Patient / DOB" cell holds the name with its birthdate: the name column, the birthdate is read from it
        role = 'patient_name'; reason = 'values hold a name with its birthdate';
      } else if (role === 'date' && dateLike < 0.3 && vals.length >= 1 && (vals.length > 3 || identLike > 0 || avgLen > 12)) {
        // header said date but the values are not dates: run them through the full pipeline rather than keep them
        role = 'text';
        reason = 'header says date but values are not dates';
      }
      return { header, index: ci, role, reason, sample: strs.slice(0, 3), firstLast: role === 'keep' && vals.length >= 2 ? firstLastShare(strs) : 0 };
    });
    // No column was read as patient names, but one kept column holds "First Last" names under a header the rules do not
    // know ("Booked For", "Recipient", a blank header): that column is the patient-name column. Never a header that names
    // staff, and only when most of its values are names.
    if (!cols.some((c) => c.role === 'patient_name')) {
      const best = cols.filter((c) => c.role === 'keep' && c.firstLast >= 0.6 && !STAFF_HEADER.test(c.header)).sort((a, b) => b.firstLast - a.firstLast)[0];
      if (best) { best.role = 'patient_name'; best.reason = 'values look like "First Last" names'; }
    }
    cols.forEach((c) => { delete c.firstLast; });
    return cols;
  }
  const STAFF_HEADER = /\b(?:by|staff|nurse|nurses|rn|lpn|md|np|pa|provider|providers|doctor|dr|physician|attending|scheduler|user|entered|created|author|signed|signer|clerk|tech|technician|pharmacist|pharm|resident|fellow|prescriber|ordering|referring|employee|agent|owner|assigned|team|coordinator|navigator|sw|social)\b/i;
  // share of values that read as a person's "First Last": two or three capitalised words, none an ordinary English word or a
  // clinical word ("Short Stay", "Med Onc", "Roswell Park" are not names), the given name or the surname in the name lists
  function firstLastShare(strs) {
    if (!strs.length) return 0;
    let k = 0;
    for (const raw of strs) {
      const t = String(raw).trim();
      if (!t || t.length > 60) continue;
      const ws = t.split(/\s+/);
      if (ws.length < 2 || ws.length > 3 || !ws.every((w) => /^[A-Z][A-Za-z'’\-]+\.?$/.test(w) || /^[A-Z]\.?$/.test(w))) continue;
      const f = ws[0].replace(/\.$/, ''), l = ws[ws.length - 1].replace(/\.$/, '');
      if (f.length < 2 || l.length < 2 || [f, l].some((w) => LEX.isClinical(w) || LEX.isEnglishWord(w))) continue;
      if (LEX.isFirstName(f) || LEX.isSurname(l)) k++;
    }
    return k / strs.length;
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
      .replace(/ {2,}/g, ' ').replace(/ ,/g, ',');
    // trailing commas and spaces stripped by a scan, not a backtracking regex (a cell of 100,000 ", " stays linear)
    let cut = body.length; while (cut > 0 && /[,\s]/.test(body[cut - 1])) cut--;
    body = body.slice(0, cut).trim();
    let last, first, middle = '', format;
    if (body.includes(',')) {
      const idx = body.indexOf(',');
      const l = body.slice(0, idx).trim(), rest = body.slice(idx + 1).trim();
      last = l; const parts = rest.split(/\s+/).filter(Boolean); first = parts[0] || ''; middle = parts.slice(1).join(' ');
      format = first ? 'last_first' : 'single';
      if (!last) { last = first; first = ''; format = 'single'; }
    } else {
      const parts = body.split(/\s+/).filter(Boolean);
      if (parts.length <= 1) { first = ''; last = parts[0] || ''; format = 'single'; }
      else { first = parts[0]; last = parts[parts.length - 1]; middle = parts.slice(1, -1).join(' '); format = 'first_last'; }
    }
    // every part is a string, even for a cell that is only punctuation (",,,") or only a credential ("DO"): callers read
    // first/last without checking
    first = first || ''; last = last || ''; middle = middle || '';
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
    // a hyphenated or two-part given name is written hyphenated, spaced or run together ("Mi-Kyung", "Mi Kyung", "Mikyung",
    // "Bich-Ngoc"), and its longer half is often used alone
    const givenParts = /[-\s]/.test(f) ? f.split(/[-\s]+/).filter(Boolean) : (m && !/\s/.test(m) && m.length >= 2 && !/^[A-Z]\.?$/.test(m) ? [f, m] : null);
    if (givenParts && givenParts.length >= 2 && givenParts.length <= 3) {
      const glued = givenParts[0] + givenParts.slice(1).join('').toLowerCase(), spaced = givenParts.join(' '), hy = givenParts.join('-');
      [glued, spaced, hy].forEach((g) => { add(g); if (l) { add(`${g} ${l}`); add(`${l}, ${g}`); } });
      if (/[-\s]/.test(f)) givenParts.forEach((h) => { if (h.length >= 3 && !NAME_PARTICLE.test(h)) add(h); });
    }
    if (f && l) {
      add(`${f[0]}. ${l}`); add(`${f[0]} ${l}`);
      // first name + surname initial (Sal P., Erik J) and dotted initials (K.Y., K. Y.)
      add(`${f} ${l[0]}.`); add(`${f} ${l[0]}`); add(`${f[0]}.${l[0]}.`); add(`${f[0]}. ${l[0]}.`);
      // surname + first initial, as a pharmacy queue writes another patient: "Castellane W.", "Vionnet, R."
      add(`${l} ${f[0]}.`); add(`${l}, ${f[0]}.`); add(`${l}, ${f[0]}`);
      // diminutives: Benjamin → Ben, Katarzyna → Kasia, Salvatore → Sal
      // a diminutive that is also an ordinary word or a month (Will, Bill, Pat, Jan, May) is only taken with the surname
      LEX.nicknamesOf(f).forEach((nick) => { if (nick.length < 3) return; if (!LEX.isCuratedAmbiguous(nick) && !LEX.isClinical(nick)) add(nick); add(`${nick} ${l}`); add(`${l}, ${nick}`); add(`${nick} ${l[0]}.`); });
    }
    // hyphenated and two-word surnames (Delacroix-Ames, Ibarrondo Etxeberria, Ruiz Cabrera): each part on its own
    if (/[-\s]/.test(l)) l.split(/[-\s]+/).forEach((h) => { if (h.length >= 3 && !NAME_PARTICLE.test(h)) add(h); });
    if (/\s/.test(l)) { const hy = l.replace(/\s+/g, '-'); add(hy); if (f) { add(`${hy}, ${f}`); add(`${f} ${hy}`); } }
    // a two-part surname run together, as in a file name or a CamelCase word ("MbekiLarsson", "OrtizDelgado", "delacruz")
    if (/[-\s]/.test(l)) { const glued = l.replace(/[-\s]+/g, ''); if (glued.length >= 5) { add(glued); if (f) { add(`${f} ${glued}`); add(`${glued}, ${f}`); add(`${glued} ${f[0]}`); } } }
    return [...v].filter((x) => x.length >= 2);
  }
  // every letter token a patient may be referred to by (lower-case), used to tell the patient from a relative who
  // shares the surname ("daughter Siobhan Fitzgerald-Nowak" is not "Fitzgerald, Mary")
  function ownTokensOf(parsedList) {
    const set = new Set();
    for (const pn of parsedList) {
      if (!pn) continue;
      [pn.first, pn.last, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((t) => { if (!t) return; const c = t.toLowerCase().replace(/\.$/, ''); if (c) set.add(c); c.split(/[-\s]+/).forEach((h) => { if (h) set.add(h); }); if (/[-\s]/.test(c)) set.add(c.replace(/[-\s]+/g, '')); });
      if (pn.first && pn.middle && !/\s/.test(pn.middle)) set.add((pn.first + pn.middle).toLowerCase());
      if (pn.first) LEX.nicknamesOf(pn.first).forEach((n) => { if (!LEX.isCuratedAmbiguous(n) && !LEX.isClinical(n)) set.add(n.toLowerCase()); });
      (pn.nicks || []).forEach((n) => String(n).toLowerCase().split(/[-\s,]+/).forEach((h) => { if (h) set.add(h); }));
    }
    return set;
  }

  // ---------------------------------------------------------------------
  // 2. Census
  // ---------------------------------------------------------------------
  function buildCensus(headers, rows, columns, opts) {
    if (!Array.isArray(rows)) rows = [];
    if (!Array.isArray(columns)) columns = [];
    const colByRole = (role) => columns.filter((c) => c.role === role).map((c) => c.index);
    const nameCols = colByRole('patient_name'), mrnCols = colByRole('mrn'), dobCols = colByRole('dob');
    const acctCols = colByRole('account'), phoneCols = colByRole('phone'), provCols = colByRole('provider');
    const patients = new Map(); // entity id -> patient (census view of a registry entity)
    const providers = new Map(); // normalized surname+first -> provider
    const rowPatient = new Array(rows.length).fill(null);
    const registry = (opts && opts.registry) || createRegistry();
    let order = 0;

    // a "Pref Name" / nickname / alias column names the same patient: its value is a variant of that row's patient, never the
    // patient's legal name
    const hdrOf = (c) => (columns.find((x) => x.index === c) || {}).header || '';
    const nickCols = nameCols.filter((c) => NICK_HEADER.test(hdrOf(c)));
    const mainNameCols = nameCols.length > nickCols.length ? nameCols.filter((c) => !nickCols.includes(c)) : nameCols;
    rows.forEach((row, ri) => {
      if (!Array.isArray(row)) return;
      let mrn = mrnCols.map((c) => cellToString(row[c]).trim()).find(Boolean) || '';
      let nameRaw = mainNameCols.map((c) => cellToString(row[c]).trim()).find(Boolean) || '';
      if (mainNameCols.length >= 2) {
        const hdr = hdrOf;
        const lastC = mainNameCols.find((c) => /\b(last|sur|family)\b/i.test(hdr(c))), firstC = mainNameCols.find((c) => /\b(first|given)\b/i.test(hdr(c)));
        if (lastC != null && firstC != null) { const l = cellToString(row[lastC]).trim(), f = cellToString(row[firstC]).trim(); if (l || f) nameRaw = l && f ? `${l}, ${f}` : (l || f); }
      }
      // a merged "Patient / MRN" cell: the record number inside the name cell is the patient's
      const split = splitNameId(nameRaw);
      if (split.mrn || split.dob) { nameRaw = split.name; if (!mrn) mrn = split.mrn; }
      let dob = dobCols.map((c) => row[c]).find((v) => v != null && v !== '');
      if ((dob == null || dob === '') && split.dob) dob = split.dob;
      const accounts = acctCols.map((c) => cellToString(row[c]).trim()).filter(Boolean);
      const phones = phoneCols.map((c) => cellToString(row[c]).trim()).filter(Boolean);
      const entity = (mrn || nameRaw) ? registry.resolve({ name: nameRaw, mrn, dob, accounts, phones }) : null;
      if (entity && mainNameCols !== nameCols) nickCols.forEach((c) => { const v = cellToString(row[c]).trim().replace(/^["'“‘]+|["'”’]+$/g, ''); if (v && v.length >= 2 && v.toLowerCase() !== nameRaw.toLowerCase() && /\p{L}/u.test(v)) (entity.nicks = entity.nicks || new Set()).add(v); });
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
        raw.replace(/\s+/g, ' ').split(/ ?[;\/] ?| and /).forEach((one) => { // whitespace runs collapsed first: the split stays linear
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
    const lookup = new Map(); const prefixKeys = new Set();
    const addVariant = (text, type, entityKey, exactCase, rowScoped) => {
      const k = text.toLowerCase();
      if (k.length < 2 || k.length > 200) return; // an overlong value (a 40,000-digit "record number") would make the census regex too large to compile
      if (/^\d+$/.test(k) && k.length < 5) return; // avoid tagging tiny numbers
      const prev = lookup.get(k);
      if (prev) {
        if (TYPES[prev.type].pri > TYPES[type].pri) return;
        // a common first name is shared by thousands of patients: membership through a set, not a scan of the list
        if (TYPES[prev.type].pri === TYPES[type].pri) { if (!prev.entSet.has(entityKey)) { prev.entSet.add(entityKey); prev.entities.push(entityKey); } prev.rowScoped = prev.rowScoped || !!rowScoped; prev.exactCase = prev.exactCase || !!exactCase; return; }
      }
      lookup.set(k, { type, entities: [entityKey], entSet: new Set([entityKey]), exactCase: !!exactCase, rowScoped: !!rowScoped, text });
    };
    for (const p of [...patients.values(), ...known.values()]) {
      p.mrns.forEach((m) => addVariant(m, 'MRN', p.key));
      p.accounts.forEach((a) => addVariant(a, 'ACCOUNT', p.key));
      p.phones.forEach((ph) => { addVariant(ph, 'PHONE', p.key); const d = ph.replace(/\D/g, ''); if (d.length >= 7) addVariant(d, 'PHONE', p.key); });
      const allVariants = new Set();
      p.names.forEach((nm) => { const pn = parseName(nm); if (pn) nameVariants(pn).forEach((v) => allVariants.add(v)); });
      if (p.parsed) nameVariants(p.parsed).forEach((v) => allVariants.add(v));
      // the patient's preferred name or nickname from its own column ("Jack" for Joaquín, "Chi" for Chiamaka)
      const nicks = p.entity && p.entity.nicks ? [...p.entity.nicks] : [];
      if (p.parsed && nicks.length) p.parsed.nicks = nicks;
      nicks.forEach((nk) => {
        const pn = parseName(nk); if (!pn) return;
        if (pn.format === 'single') { const w = pn.last; allVariants.add(w); const l = p.parsed && p.parsed.last; if (l && l.toLowerCase() !== w.toLowerCase()) { allVariants.add(`${w} ${l}`); allVariants.add(`${l}, ${w}`); allVariants.add(`${w} ${l[0]}.`); } }
        else nameVariants(pn).forEach((v) => allVariants.add(v));
      });
      // given names (first, middle, the halves of a hyphenated one, run together) of 4+ letters that are not ordinary words:
      // in the patient's own rows they match in lower case too ("teodoro c/o bone pain", "mikyung tolerated well")
      const givenLc = new Set();
      [p.parsed, ...[...p.names].map(parseName)].forEach((pn) => {
        if (!pn) return;
        [pn.first, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((g) => { if (!g) return; const k = g.toLowerCase().replace(/\.$/, ''); givenLc.add(k); k.split(/[-\s]+/).forEach((h) => givenLc.add(h)); givenLc.add(k.replace(/[-\s]+/g, '')); });
        if (pn.first && pn.middle && !/\s/.test(pn.middle)) givenLc.add((pn.first + pn.middle).toLowerCase());
      });
      const literal = new Set(); p.names.forEach((nm) => { const pn = parseName(nm); if (pn) [pn.last, ...pn.last.split(/[-\s]+/), pn.last.replace(/[-\s]+/g, '')].forEach((t) => t && literal.add(t.toLowerCase())); });
      // a short form cut from a long given name ("Finn" of Finnegan, "Bart" of Bartholomew, "Theo" of Theodora): the
      // patient's own rows only, written with a capital, and never an ordinary word
      const prefixForms = new Set(), prefixNeedsCue = new Set();
      [p.parsed, ...[...p.names].map(parseName)].forEach((pn) => {
        const f = pn && pn.first; if (!f || f.length < 7 || !/^[A-Za-z]+$/.test(f)) return;
        for (const cutLen of [4, 3]) {
        const cut = f.slice(0, cutLen); const lc = cut.toLowerCase();
        if (cutLen === 3 && f.length < 8) continue;
        const needsCue = cutLen === 3 && LEX.isEnglishWord(cut); // "Dom" of Dominador: only beside a person cue
        if (COMMON_LOWER.has(lc) || COMMON_CAP.has(lc) || LEX.isCuratedAmbiguous(cut) || (!needsCue && LEX.isEnglishWord(cut) && !LEX.isFirstName(cut)) || LEX.isClinical(cut) || monthIndex(cut) || LEX.RELATION_SET.has(lc)) continue;
        const form = cut[0].toUpperCase() + cut.slice(1).toLowerCase();
        prefixForms.add(form); if (needsCue) prefixNeedsCue.add(form);
        }
      });
      prefixForms.forEach((v) => { if (!allVariants.has(v) && !lookup.has(v.toLowerCase())) { addVariant(v, 'NAME_PATIENT', p.key, true, true); prefixKeys.add(v.toLowerCase()); if (prefixNeedsCue.has(v)) lookup.get(v.toLowerCase()).needsCue = true; } });
      // an export written all in lower case ("pemberton-yau, odalys"): the given name is matched in lower case in its own rows
      const lowerSource = [...p.names].some((nm) => /[a-z]/.test(nm) && nm === nm.toLowerCase());
      [...allVariants].forEach((v) => {
        // single ambiguous/common-word tokens must match with a capital letter, and tokens that are also
        // months/clinical words only match inside that patient's own rows. A given name, a diminutive or an initial
        // alone is also row-scoped: another patient's first name in this row is almost always a different person.
        const single = !/\s|,/.test(v);
        const surnameToken = single && literal.has(v.toLowerCase());
        let exact = single && (LEX.isAmbiguous(v) || LEX.isClinical(v) || v.length <= 3 || !surnameToken);
        if (exact && lowerSource && v.length >= 4 && !LEX.isAmbiguous(v) && !LEX.isClinical(v) && !COMMON_LOWER.has(v.toLowerCase()) && !COMMON_CAP.has(v.toLowerCase()) && !monthIndex(v)) exact = false;
        if (exact && single && v.length >= 4 && givenLc.has(v.toLowerCase()) && !LEX.isEnglishWord(v) && !LEX.isAmbiguous(v) && !LEX.isClinical(v) && !COMMON_LOWER.has(v.toLowerCase()) && !COMMON_CAP.has(v.toLowerCase()) && !monthIndex(v) && !relWord(v) && !LEX.LANGUAGE_SET.has(v.toLowerCase())) exact = false;
        const rowScoped = single && (LEX.isClinical(v) || LEX.isAmbiguous(v) || v.length <= 3 || !surnameToken);
        addVariant(v, 'NAME_PATIENT', p.key, exact, rowScoped);
      });
      // the patient's given names and diminutives, alone: censusSpans matches one in any case when it is not an ordinary
      // word ("called rosario re parking"), in a person slot when it is ("pt rose called"), and outside the patient's rows
      // too (a note that names no other patient is about this one)
      const givenSet = new Set(givenLc);
      [p.parsed, ...[...p.names].map(parseName)].forEach((pn) => { if (pn && pn.first) LEX.nicknamesOf(pn.first).forEach((n) => givenSet.add(n.toLowerCase())); });
      nicks.forEach((nk) => String(nk).toLowerCase().split(/[\s,]+/).forEach((w) => { if (w) givenSet.add(w.replace(/^[^a-z]+|[^a-z]+$/g, '')); }));
      givenSet.forEach((g) => { if (!g || g.length < 3 || literal.has(g)) return; const h = lookup.get(g); if (h && h.type === 'NAME_PATIENT' && h.entSet && h.entSet.has(p.key)) h.given = true; });
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
    // Matching is a scan over the lookup (see scanLookup): the longest variant that starts after a letter/digit boundary and
    // ends before one, as one alternation regex would find it, but at a cost that does not grow with the number of patients
    // (a regex of 150,000 alternatives is slow to compile and tries every alternative at every position).
    // letters and digits bound a match, so an underscore is a separator ("whitcombe_harriet_path.pdf", "MRN_00412345")
    const scan = lookup.size ? makeScan(lookup.keys()) : null;
    const regex = scan ? SCAN_MARK : null;
    const mrnNorm = new Map();
    for (const p of [...patients.values(), ...known.values()]) p.mrns.forEach((m) => { const k = mrnKeyOf(m); if (k) mrnNorm.set(k, p.key); });
    const patient = (key) => patients.get(key) || known.get(key) || null;
    prefixKeys.forEach((k) => { const h = lookup.get(k); if (h) h.prefix = true; });
    const fuzzy = surnameIndex([...patients.values(), ...known.values()]);
    return { patients, known, patient, providers, rowPatient, rowExtra, lookup, regex, scan, fuzzy, registry, mrnNorm, nameCols, nickCols, mrnCols, dobCols, acctCols, phoneCols, provCols };
  }
  // A dictionary matcher over lower-case keys: at every position that follows a non-letter/digit (or the start), the longest
  // key that ends before a non-letter/digit (or the end), compared case-insensitively; the scan resumes after a match. This is
  // what /(?<![A-Za-z0-9])(?:k1|k2|...)(?![A-Za-z0-9])/gi with keys sorted longest first finds, in time proportional to the
  // text times the number of distinct key lengths.
  const SCAN_MARK = Object.freeze({ scan: true });
  // a file name: letters, digits, dots, hyphens and underscores before a document or image extension
  const FILE_EXT_RE = /\.(?:pdf|jpe?g|png|gif|tiff?|bmp|heic|docx?|xlsx?|csv|txt|rtf|dcm|zip|msg|eml|html?|mp4|mov)(?![A-Za-z0-9])/i;
  const FILE_TOKEN_RE = /(?<![A-Za-z0-9_\-.])[A-Za-z0-9][A-Za-z0-9_\-.]{0,120}?\.(?:pdf|jpe?g|png|gif|tiff?|bmp|heic|docx?|xlsx?|csv|txt|rtf|dcm|zip|msg|eml|html?|mp4|mov)(?![A-Za-z0-9])/gi;
  // Surnames of 6+ letters (each half of a two-part one and the parts run together too), indexed by their one-letter
  // deletions, for the misspelling match ("Okonkow" for Okonkwo, "Szczepanksi" for Szczepański): entity -> surnames
  function surnameIndex(people) {
    const idx = new Map(), names = new Map();
    for (const p of people) {
      if (!p) continue;
      const parsed = [p.parsed, ...[...(p.names || [])].map(parseName)].filter(Boolean);
      const own = new Set();
      parsed.forEach((pn) => { const l = LEX.fold(pn.last || ''); if (!l) return; [l, ...l.split(/[-\s]+/), l.replace(/[-\s]+/g, '')].forEach((x) => { const c = x.replace(/[^a-z]/g, ''); if (c.length >= 6 && c.length <= 40) own.add(c); }); });
      if (!own.size) continue;
      names.set(p.key, [...own]);
      own.forEach((w) => deletionKeys(w).forEach((k) => { let st = idx.get(k); if (!st) idx.set(k, (st = new Set())); st.add(p.key); }));
    }
    return { idx, names };
  }
  // the listed patients whose surname a word misspells by one edit (none when the word is itself a name, a word, clinical)
  function fuzzySurnameHits(fuzzy, word) {
    if (!fuzzy || !fuzzy.idx.size) return [];
    const w = LEX.fold(word).replace(/[^a-z]/g, '');
    if (w.length < 6 || w.length > 40) return [];
    const cand = new Set();
    deletionKeys(w).forEach((k) => { const st = fuzzy.idx.get(k); if (st) st.forEach((e) => cand.add(e)); });
    return [...cand].filter((e) => (fuzzy.names.get(e) || []).some((n) => n !== w && osaDistance(n, w) <= 1));
  }
  const looksMisspelledName = (t) => t.length >= 6 && !LEX.isEnglishWord(t) && !LEX.isClinical(t) && !LEX.isFirstName(t) && !LEX.isSurname(t) && !COMMON_CAP.has(t.toLowerCase()) && !LEX.CITY_SET.has(t.toLowerCase()) && !monthIndex(t);
  const isAlnumCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  function makeScan(keyIter) {
    const keys = new Set(), lens = new Set(), firsts = new Set();
    for (const k of keyIter) { if (!k) continue; keys.add(k); lens.add(k.length); firsts.add(k[0]); }
    const lensDesc = [...lens].sort((a, b) => b - a);
    return { keys, lensDesc, firsts };
  }
  function scanLookup(text, scan) {
    const out = [];
    if (!scan || !text || !scan.keys.size) return out;
    const n = text.length;
    let lower = text.toLowerCase();
    const sameLen = lower.length === n; // a character whose lower case is longer ("İ") would shift every offset
    if (!sameLen) lower = null;
    const lc = (a, b) => (sameLen ? lower.slice(a, b) : text.slice(a, b).toLowerCase());
    for (let i = 0; i < n;) {
      if ((i > 0 && isAlnumCode(text.charCodeAt(i - 1))) || !scan.firsts.has(sameLen ? lower[i] : text[i].toLowerCase())) { i++; continue; }
      let hit = 0;
      for (const L of scan.lensDesc) {
        const e = i + L;
        if (e > n || (e < n && isAlnumCode(text.charCodeAt(e)))) continue;
        if (scan.keys.has(lc(i, e))) { hit = L; break; }
      }
      if (hit) { out.push({ index: i, 0: text.slice(i, i + hit) }); i += hit; } else i++;
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Dates: parse, render in the same style, shift
  // ---------------------------------------------------------------------
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
  const MONTH_NC = MONTH_RE.replace('(', '(?:');
  // the same alternation matching a capitalized or lower-case month without the i flag ("Jun", "jun")
  const MONTH_NC_CAP = MONTH_NC.replace(/(?<=[(|:])([a-z])/g, (m, c) => `[${c.toUpperCase()}${c}]`);
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
  const ORD_WORDS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth',
    'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];
  const ORD_WORD_RE = '(?:' + ORD_WORDS.slice().sort((a, b) => b.length - a.length).map((w) => w.replace('-', '[- ]?')).join('|') + ')';
  const ordWordIndex = (w) => ORD_WORDS.indexOf(w.toLowerCase().replace(/[ ]+/, '-').replace(/^(twenty|thirty)(?=[a-z])(?!ieth)(?!th)/, '$1-')) + 1;
  // Date regexes, each with a 'kind' to drive re-rendering.
  const DATE_PATTERNS = [
    // letters and digits bound a date, never an underscore: "scan_2026-11-04.pdf", "consent_11-04-2026.pdf" are dates
    { kind: 'iso', re: new RegExp('(?<![A-Za-z0-9.])(\\d{4})([-.\\/])(\\d{1,2})\\2(\\d{1,2})(?![\\d]|\\.\\d)', 'g') },
    { kind: 'mdy', re: new RegExp('(?<![A-Za-z0-9/.-])(\\d{1,2})([\\/\\-.])(\\d{1,2})\\2(\\d{4}|\\d{2})(?![\\d])', 'g') },
    { kind: 'Mdy', re: new RegExp(`(?<![A-Za-z0-9])${MONTH_RE}\\.?[ \\t]+(\\d{1,2})(?:st|nd|rd|th)?(?:,?[ \\t]+(\\d{4}|\\d{2}(?![ \\t]*(?:-|[ \\t]|of[ \\t]+)?${MONTH_NC}\\b))(?![\\d:]))?(?![A-Za-z0-9])`, 'gi') },
    { kind: 'dMy', re: new RegExp(`(?<![A-Za-z0-9])(\\d{1,2})(?:st|nd|rd|th)?(?:(-)|[ \\t]{1,2}(?:of[ \\t]+)?)${MONTH_RE}\\.?(?:(?:-|,[ \\t]*|(?<!-${MONTH_NC}\\.?)[ \\t]+)(\\d{4}|\\d{2}(?![\\/\\-.]\\d)(?![ \\t]*(?:-|[ \\t]|of[ \\t]+)?${MONTH_NC}\\b))(?![\\d:]))?(?![A-Za-z0-9])`, 'gi') },
    // military / pharmacy compact form: 13NOV2026, 04Jan27
    { kind: 'dMyc', re: new RegExp(`(?<![A-Za-z0-9])(\\d{1,2})${MONTH_RE}(\\d{4}|\\d{2})(?![A-Za-z0-9])`, 'gi') },
    // "Nov-30-2026": month word, day and year joined by hyphens
    { kind: 'Mdyh', re: new RegExp(`(?<![A-Za-z0-9])${MONTH_RE}\\.?-(\\d{1,2})-(\\d{4}|\\d{2})(?![A-Za-z0-9-])`, 'gi') },
    // month and year with no day ("Feb 2027", "March, 2026", "09/2026"): still a date element under Safe Harbor
    { kind: 'My', re: new RegExp(`(?<![A-Za-z0-9]|\\d[ \\t]|-)${MONTH_RE}\\.?,?[ \\t]+((?:19|20)\\d{2})(?![A-Za-z0-9]|[\\/\\-.]\\d)`, 'gi') },
    { kind: 'my', re: new RegExp('(?<![A-Za-z0-9/.-])(0?[1-9]|1[0-2])(\\/)((?:19|20)\\d{2})(?![A-Za-z0-9/-]|\\.\\d)', 'g') },
    // a bare ordinal day after a time preposition ("out of town until the 23rd", "back on the 5th")
    // ... after a visit word or a verb that books, misses or moves one ("missed the 3rd", "appt is the 19th", "scheduled for the
    // 9th"), or after a weekday ("Tue the 10th", "Fri 21st"). A day of the month tied to a visit is a Safe Harbor date element;
    // it is replaced by "[date]" (a shifted day with no month would be meaningless). Counts stay: "the 3rd cycle", "is the
    // 2nd time", "the 4th child", "the 99th percentile".
    // (the digits are matched first and the context is checked behind them, with bounded spacing: a long run of spaces
    // cannot make the scan quadratic)
    { kind: 'ord', re: new RegExp('(?<![\\w])(\\d{1,2})(st|nd|rd|th)\\b(?<=(?:\\b(?:until|till|til|by|on|before|after|since|from|through|thru|starting|around|back|returns?|returning|due|except|not|missed|miss|misses|missing|is|was|for|appt|appointment|visit|rtc|scheduled|sched|booked|moved|changed|rescheduled|resched|cancel(?:l?ed)?|confirmed|instead[ \\t]of|of)[ \\t]{1,8}the[ \\t]{1,8}|\\b(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\\.?,?[ \\t]{1,8}(?:the[ \\t]{1,8})?)\\d{1,2}(?:st|nd|rd|th))(?![ \\t]+(?:of[ \\t]+(?:the[ \\t]+)?)?(?:cycle|cycles|dose|doses|day|days|week|weeks|line|lines|infusion|infusions|treatment|treatments|round|rounds|time|times|visit|visits|floor|attempt|attempts|course|courses|session|sessions|fraction|fractions|month|months|year|years|percentile|grade|place|one|ones|of|patient|patients|person|people|child|children|kid|kids|son|daughter|grandchild|sibling|opinion|option|choice|degree|step|steps|level|stage|phase|generation|item|items|page|pages|chair|bay|room|bed|most|least|best|worst|largest|highest|lowest|biggest|smallest|oldest|youngest|birthday|bday|anniversary|call|message|msg|vial|vials|bag|bags|unit|units|injection|injections|appointment|appointments|appt|appts|week|wk|wks))', 'gi') },
    // a day written as an ordinal word: "born March fourth 1931", "the twenty-first of June"
    { kind: 'Mwy', re: new RegExp(`(?<![\\w])${MONTH_RE}\\.?[ \\t]+(${ORD_WORD_RE})(?:,?[ \\t]+((?:18|19|20)\\d{2}))?(?![\\w-])`, 'gi') },
    { kind: 'wMy', re: new RegExp(`(?<![\\w-])(${ORD_WORD_RE})[ \\t]+of[ \\t]+${MONTH_RE}(?:,?[ \\t]+((?:18|19|20)\\d{2}))?(?![\\w])`, 'gi') },
    { kind: 'md', re: new RegExp('(?<![\\d\\w/.-])(\\d{1,2})([\\/\\-])(\\d{1,2})(?![\\d/])(?!-(?!\\d{1,2}\\/))(?!\\.\\d)(?![ \\t]*(?:mg|mcg|g|ml|tab|tabs|dose|x|units?|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5)\\b)', 'g') },
  ];
  const UNIT_AFTER = /^[ \t]*(mg|mcg|g|ml|mL|tab|tabs|dose|x|unit|units|%|of|tablet|cap|caps|hr|hrs|h|min|cc|L|strength|NS|D5W?|AM|PM)\b/;
  // a count after a number ("Dec 3 to 5 cycles", "5 to 7 doses"): the number is not a day of the month
  // (nouns that also follow a date, "11/24-26 slots", "Dec 3 to 5 visits", are not counted: a date left unshifted would leak)
  const COUNT_AFTER = /^[ \t]*(?:days?|weeks?|wks?|months?|mos?|years?|yrs?|cycles?|doses?|infusions?|treatments?|rounds?|courses?|patients?|pts|people|times|hours?|minutes?|mins?|lbs?|kgs?|pounds?|vials?|bags?|units?|tabs?|pills?|refills?)\b/i;

  function parseDateMatch(kind, m) {
    let dayFirst = false, y, mo, d, hasYear = true, yearDigits = 4, monthStyle = null, sep = '/', monthTok = null, ordinal = '';
    if (kind === 'iso') { y = +m[1]; sep = m[2]; mo = +m[3]; d = +m[4]; }
    else if (kind === 'mdy') { mo = +m[1]; sep = m[2]; d = +m[3]; yearDigits = m[4].length; y = expandYear(m[4]); if (mo > 12 && d >= 1 && d <= 12) { const t = mo; mo = d; d = t; dayFirst = true; } } // 16/10/2026 is day-first
    else if (kind === 'dMyc') { d = +m[1]; monthTok = m[2]; mo = monthIndex(m[2]); yearDigits = m[3].length; y = expandYear(m[3]); }
    else if (kind === 'Mdy') { monthTok = m[1]; mo = monthIndex(m[1]); d = +m[2]; if (m[3]) { yearDigits = m[3].length; y = expandYear(m[3]); } else { hasYear = false; y = new Date().getFullYear(); } }
    else if (kind === 'dMy') { d = +m[1]; monthTok = m[3]; mo = monthIndex(m[3]); if (m[4]) { yearDigits = m[4].length; y = expandYear(m[4]); } else { hasYear = false; y = new Date().getFullYear(); } }
    else if (kind === 'md') { mo = +m[1]; sep = m[2]; d = +m[3]; hasYear = false; y = new Date().getFullYear(); }
    else if (kind === 'Mdyh') { monthTok = m[1]; mo = monthIndex(m[1]); d = +m[2]; yearDigits = m[3].length; y = expandYear(m[3]); sep = '-'; }
    else if (kind === 'Mwy') { monthTok = m[1]; mo = monthIndex(m[1]); d = ordWordIndex(m[2]); ordinal = m[2]; if (m[3]) y = +m[3]; else { hasYear = false; y = new Date().getFullYear(); } if (!/^[A-Z]/.test(m[1])) return null; }
    else if (kind === 'wMy') { monthTok = m[2]; mo = monthIndex(m[2]); d = ordWordIndex(m[1]); ordinal = m[1]; if (m[3]) y = +m[3]; else { hasYear = false; y = new Date().getFullYear(); } if (!/^[A-Z]/.test(m[2])) return null; }
    else if (kind === 'My') { monthTok = m[1]; mo = monthIndex(m[1]); d = 15; y = +m[2]; }
    else if (kind === 'my') { mo = +m[1]; sep = m[2]; y = +m[3]; d = 15; }
    else if (kind === 'ord') { const now = new Date(); d = +m[1]; hasYear = false; y = now.getFullYear(); mo = now.getMonth() + 1; if (!validDMY(y, mo, d)) { mo = mo === 1 ? 12 : mo - 1; if (mo === 12) y--; } if (!validDMY(y, mo, d)) mo = 1; }
    if (!validDMY(y, mo, d)) return null;
    if (y < 1880 || y > 2100) return null;
    if (monthTok) {
      const raw = m[0].match(new RegExp(MONTH_RE + '\\.?', 'i'))[0];
      monthStyle = { abbrev: raw.replace('.', '').length <= 4, period: raw.endsWith('.'), upper: raw === raw.toUpperCase(), lower: raw === raw.toLowerCase() };
    }
    return { y, m: mo, d, hasYear, yearDigits, sep, kind, monthStyle, text: m[0], dayFirst, ordinalWord: ordinal };
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
      // the end of a range written as a bare day ("Nov 24–26"): the day alone while the shifted range stays in one month,
      // otherwise with its month written the way the start wrote it ("Nov 30–Dec 2", "11/30-12/2")
      case 'dayr': {
        const st = pd.range;
        const off = Math.round((new Date(y, mo - 1, d) - new Date(pd.y, pd.m - 1, pd.d)) / 864e5);
        const sd = shiftDate(new Date(st.y, st.m - 1, st.d), off);
        if (sd.getMonth() + 1 === mo) return `${d}${ordinal(d)}`;
        return st.monthStyle ? `${monthName()} ${d}${ordinal(d)}` : `${mo}${st.sep || '/'}${d}`;
      }
      case 'ymdc': return `${y}${pad2(mo)}${pad2(d)}`;
      case 'Mwy': case 'wMy': { const w = ORD_WORDS[d - 1]; const ow = pd.ordinalWord && pd.ordinalWord[0] === pd.ordinalWord[0].toUpperCase() ? capFirst(w) : w; return pd.kind === 'Mwy' ? `${monthName()} ${ow}${pd.hasYear ? ' ' + y : ''}` : `${ow} of ${monthName()}${pd.hasYear ? ' ' + y : ''}`; }
      case 'iso': return `${y}${pd.sep || '-'}${pad2(mo)}${pd.sep || '-'}${pad2(d)}`;
      case 'mdy': { const padded = /(^|[\/\-.])0\d([\/\-.]|$)/.test(pd.text); const [a, b] = pd.dayFirst ? [d, mo] : [mo, d]; return padded ? `${pad2(a)}${pd.sep}${pad2(b)}${pd.sep}${yy}` : `${a}${pd.sep}${b}${pd.sep}${yy}`; }
      case 'dMyc': return `${/^\d{2}/.test(pd.text) ? pad2(d) : d}${monthName()}${yy}`;
      case 'Mdyh': return `${monthName()}-${/-0\d-/.test(pd.text) ? pad2(d) : d}-${yy}`;
      case 'My': return `${monthName()}${/,/.test(pd.text) ? ',' : ''} ${y}`;
      case 'my': return `${/^0/.test(pd.text) ? pad2(mo) : mo}/${y}`;
      case 'ord': { const sfx = (d % 100 >= 11 && d % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][d % 10] || 'th'; return `${d}${/[A-Z]{2}$/.test(pd.text) ? sfx.toUpperCase() : sfx}`; }
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
    // (a match starts only where the run of address characters starts, so a long run with no @ is scanned once, not once per
    // character)
    EMAIL: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    EMAIL_OBF: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}\s*[\[(\{]\s*at\s*[\])\}]\s*[A-Za-z0-9-]{1,63}(?:\s*[\[(\{]\s*dot\s*[\])\}]\s*[A-Za-z]{2,24}){1,4}/gi,
    URL: /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9][a-z0-9\-]*(?:\.[a-z0-9\-]+)*\.(?:com|org|net|edu|gov|us|io|me|info|co|ly|page|site|health|care)\/[^\s<>"',;)]+/gi,
    // a serial named a few words after its label: "Pump serial CADD-S 4419-88213", "serial no. for the pump 7731-0042"
    SERIAL_NEAR: /\b(?:serial|s\/n|sn)\b(?:\s*(?:#|no\.?|num(?:ber)?))?[\s:]+(?:[A-Za-z][\w\-]*\s+){0,3}?([A-Z0-9]*\d[A-Z0-9]*(?:-[A-Z0-9]+|\s[A-Z0-9]*\d[A-Z0-9]*)*)/gi,
    IP: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    SSN: /(?<!\d)\d{3}-\d{2}-\d{4}(?!\d)|\b[xX*]{3}-[xX*]{2}-\d{4}\b/g,
    // insurer or plan name, then a member/policy identifier: "UHC / 009227418-02", "Aetna: W220893115", "Medicaid ID 44120099871", "BCBS member # XYZ123456789"
    INSURANCE_ID: /\b(?:uhc|united\s*healthcare|aetna|cigna|humana|anthem|bcbs|blue\s*cross|blue\s*shield|highmark|excellus|fidelis|univera|independent\s*health|mvp|medicaid|medicare|tricare|wellcare|molina|centene|oscar|kaiser|emblem|healthfirst|metroplus|caresource|member|subscriber|policy|plan|payer|insurance|ins)\b[^\n\d]{0,24}?[\/:#]?\s*((?=[A-Za-z0-9-]*\d)[A-Za-z]{0,4}\d[A-Za-z0-9]{4,}(?:-\d{1,3})?)\b/gi,
    // a phone number written in words or mixed ("five five five 0171", "five-five-five-zero-one-seven-one")
    PHONE_WORDS: /\b(?:(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|\d)[\s\-.,]*){7,}\b/gi,
    // separators tolerate OCR/keyboard spacing: "716 -555- 0177", "716 . 555 . 0177"
    PHONE: /(?<![\d\w\/])(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}(?:\s*[-.]\s*|\s))\d{3}(?:\s*[-.]\s*|\s)\d{4}(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?(?![\d\w])|(?<![\d\w-])\d{3}[-.]\d{4}(?:\s*(?:x|ext\.?)\s*\d{1,6})?(?![\d\w-])/gi,
    PHONE_PLAIN: /(?<![\d\w.-])\d{10}(?![\d\w-])(?!\.\d)(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?|(?<=\b(?:called|call|ph|phone|cell|tel|fax|#)\s{0,3})\d{7}(?![\d\w-])(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})?|(?<![\d\w.-])\d{7}(?=\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})(?:\s*(?:x|ext\.?|extension)\s*\.?\s*\d{1,6})/gi,
    // OCR-noisy phone: digits with O/I/l confusions, at least 7 real digits, 3-3-4 shape
    PHONE_OCR: /(?<![\w])\(?[\dOIl]{3}\)?(?:\s*[-.]\s*|\s)[\dOIl]{3}(?:\s*[-.]\s*|\s)[\dOIl]{4}(?![\w])/g,
    AGE: /\b(?:age[d]?\s*:?\s*(9\d|1[0-2]\d)(?![\d\/%-])(?!\.\d)(?!,\d)|(9\d|1[0-2]\d)\s*(?:-|\s)?\s*(?:y\/o|yo|y\.[o0]{1,2}\.?|y\s?[o0]\b|yrs?\.?(?:\s*old)?|years?(?:[-\s]old)?|year[-\s]old|yr[-\s]old)(?![A-Za-z])|\b(?:his|her|their)\s+(?:(?:early|mid|late)[-\s])?(9|10)0s\b|\b(?:nonagenarian|centenarian)\b)/gi,
    // "just turned 91", "turning 95 next month", "turns 100": the verb alone says age (degrees, doses and units excluded)
    AGE_TURNS: /\b(?:turned|turning|turns)\s+(9\d|1[01]\d)(?![\d\/%,:.-]|\.\d)(?!\s*(?:degrees?|deg\b|°|mg|mcg|kg|lb|lbs|%|ml|mL|cc|units?|min|minutes|times|x\b))/gi,
    // a table age with a bare y: "91 y", "93y M", "| 95 y |"
    AGE_Y: /(?<![\d\/.\-$#])(9\d|1[0-2]\d)\s?y(?=\s*(?:[MF]\b|[|,;)]|\s{2,}|$))/gm,
    // an ordinal birthday or year of life: "celebrated 101st bday", "her 95th birthday", "in his 92nd year"
    AGE_ORDINAL: /\b(9\d|1[0-2]\d)(?:st|nd|rd|th)\s+(?:bday|b-day|b'day|birthday|bdays|birthdays|year\s+of\s+life|year)\b/gi,
    // written-out ages: ninety-two year old, one hundred and one years old
    AGE_WORDS: /\b(?:ninety|one[-\s]hundred)(?:(?:[-\s]|\s+and\s+)(?:one|two|three|four|five|six|seven|eight|nine))?(?:[-\s]+(?:years?|yrs?)[-\s]+old|[-\s]+(?:y\/o|yo))(?![A-Za-z])/gi,
    // a written-out age after an age label or a turning verb: "age ninety-five", "aged ninety two", "turned one hundred"
    AGE_WORDS_LABEL: /\b(?:age[d]?\s*:?|turned|turning|turns|is now|will be)\s+(?:ninety|one[-\s]hundred)(?:(?:[-\s]|\s+and\s+)(?:one|two|three|four|five|six|seven|eight|nine))?(?![A-Za-z-])/gi,
    // bare number after a person-subject: "husband is 95", "pt turned 91"; vitals (HR is 95, BP 95/60, SpO2 95%) excluded
    AGE_SUBJECT: /\b(?:pt|patient|he|she|husband|wife|spouse|mother|father|mom|mum|dad|sister|brother|son|daughter|partner|grandmother|grandfather|grandma|grandpa|gma|gpa|granny|nana|nan|papa|mama|aunt|uncle|who)\s+(?:is|was|turned|turning|now|just turned|will be)\s+(9\d|1[01]\d)(?![\d\/%:-]|,\d)(?!\.\d)(?!\s*(?:mg|kg|lb|lbs|%|mmhg|bpm|k\b|ml|mL|cc|units?|yo|y\/o|year|yr|\/))/gi,
    // "Turned 90 last week", "Turning 91 in May", "is now 95" at the start of a sentence or note (no subject written)
    AGE_TURNED: /(?:^|[.;!?\n][ \t]*|^\s*-\s*)((?:just\s+)?(?:turned|turning|turns|is now|now|will be|to be)\s+(9\d|1[01]\d))(?![\d\/%:-]|,\d)(?!\.\d)(?!\s*(?:mg|kg|lb|lbs|%|mmhg|bpm|k\b|ml|mL|cc|units?|\/))/gi,
    // a bare age in apposition after a name or before a sex marker: "Zofia, 95, hard of hearing", "97 F", "95 M"
    AGE_APPOS: /(?<=\b[A-Z][A-Za-z'’\-]+,\s)(9\d|1[01]\d)(?=\s*,)|(?<![\d\/.\-$#])(9\d|1[01]\d)\s*(?:F|M)\b(?![\/\d]|\.\d)/g,
    ADDRESS: /\b\d{1,6}\s+(?:[A-Z][A-Za-z]+\.?\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail|Pike|Bend|Loop|Row|Path|Crossing|Ridge|Sq|Square|Trace|Cove|Alley|Commons)\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Suite|Ste|#)\.?\s*[\w-]+)?/g,
    // a house number and a street name with no suffix, closed by a unit marker: "4418 Willow Bend apt 3C", "1187 Old Mill #12B"
    ADDRESS_UNIT: /\b(\d{1,6}\s+((?:[A-Z][A-Za-z]+\.?\s+){0,2}[A-Z][A-Za-z]+),?\s*(?:[Aa]pt|APT|[Aa]partment|[Uu]nit|UNIT|[Ss]uite|[Ss]te|#)\.?\s*#?[A-Za-z]?\d+[A-Za-z]?)(?![\w-])/g,
    // a numbered route or highway as the street: "400 Route 9", "12 State Rte 31", "88 County Rd 4"
    ADDRESS_ROUTE: /\b\d{1,6}\s+(?:(?:State|US|U\.S\.|County|Old|Co\.?)\s+)?(?:Route|Rte\.?|Rt\.?|Highway|Hwy\.?|Road|Rd\.?)\s+\d{1,4}[A-Z]?\b/g,
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
    SSN_LAST4: /\b(?:(?:last\s+)?ssn[\s-]*4|ssn|ss#|ss\s*#|social(?:\s+security)?(?:\s+(?:number|no\.?|#))?)\s*(?:on\s+file\s*)?(?:ending(?:\s+in)?|ends(?:\s+(?:in|with))?|last\s*(?:4|four)(?:\s+digits)?|xxx-xx-)?(?:[^\n\d]{0,20}?)[:#]?\s*(\d{4})(?![\d-])/gi,
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
    // (A drug lot number, "Lot 4G221A exp 03/2028", names a batch of medication, not a person, so "lot" is not a label here.)
    LABELED_ID: /\b(?:member|subscriber|policy|beneficiary|medicare|medicaid|mbi|hic|hicn|insurance|ins|conf|confirmation|ref|reference|claim|auth|authorization|prior auth|case|ticket|serial|sn|s\/n|lic|license|licence|dl|driver'?s? license|plate|badge|subject|study|participant|enrollment|screening|health card|ohip|card|passport|visa|id|identifier|acct|account|invoice|order|rx|prescription|tracking|voucher|pin|employee|emp|payer|placard|permit|serial\s+number|implant|device|pump|tag)\s*(?:#|no\.?|num\.?|number|id|code)?(?:\s+(?:on\s+file|is|was|of|verified|provided|given|recorded))*\s*[:#]?\s*((?:[A-Z]{1,4}[-\s]?)?\d[A-Z0-9\-]*(?:[ ](?=[A-Z0-9]*\d)[A-Z0-9\-]+){0,3}|[A-Z]{1,3}[ -]?\d{3,4}(?![\w-]))/gi,
    // Medicare Beneficiary Identifier: 1EG4-TE5-MK72 (11 chars, fixed letter/digit positions, hyphens optional)
    MBI: /(?<![\w])[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9]\d-?[AC-HJKMNP-RT-Y]{2}\d{2}(?![\w])/g,
    // @handle / user name tokens (MyChart user names, chat mentions)
    HANDLE: /(?<![\w.])@[A-Za-z][\w.]{2,}(?![\w.])(?![A-Za-z0-9.-]*\.[A-Za-z]{2,})|\b(?:username|user name|user id|userid|login|log-in|handle|screen name)\s*[:#]?\s*((?=[\w.-]*[A-Za-z])[A-Za-z][\w.-]{3,})|\buser\s*[:#]?\s*((?=[a-z0-9._]*\d)[a-z][a-z0-9._]{3,})(?![\w])/gi,
    // an unlabelled user name: lower-case letters joined to digits by a dot or underscore ("jhpark_1951", "rosie.delgado62"),
    // or written after a portal cue ("From MyChart (rosie62)"). Versions (v2.1), files (scan_01.pdf) and e-mails are excluded.
    HANDLE_SHAPE: /(?<![\w.@\/-])(?=[a-z0-9._]*[a-z]{3})[a-z][a-z0-9]*(?:[._][a-z0-9]+)+(?![\w@-]|\.[a-z])/g,
    HANDLE_CUE: /\b(?:mychart|portal|message|msg|from|sender|user)\s*[:(]\s*([a-z][a-z0-9._]{3,})(?=\s*[):])/gi,
    // patient initials when labelled: "initials P.R." / "init: JS"
    INITIALS: /\binitials?\s*[:#]?\s*([A-Z]\.?\s?[A-Z]\.?(?:\s?[A-Z]\.?)?)(?![A-Za-z])/g,
    // OCR-noisy m/d/y or y-m-d with O/I/l confusions (must contain at least one letter)
    DATE_OCR: /(?<![\w\/])(?=[\dOIl\/\-.]{0,12}[OIl])(?:[\dOIl]{1,2}([\/\-.])[\dOIl]{1,2}\1[\dOIl]{2,4}|[\dOIl]{4}-[\dOIl]{1,2}-[\dOIl]{1,2})(?![\w\/])/g,
  };
  // When an m-d or small-fraction token is a date only if the surroundings say so.
  const DATE_CTX_BEFORE = /(?:\bdob|\bborn|\bbirth(?:day|date)?|\bon|\bappt|\bappointment|\bseen|\bdue|\bnext|\blabs?|\bscan|\bvisit|\brtc|f\/u|\bfu|\bstart(?:s|ed|ing)?|\bthrough|\bthru|\bfrom|\buntil|\bby|\bdate|\bdos|\btx|\btreatment|\binfusion|\breturn(?:s|ed|ing)?|\brecheck|\bsched(?:uled)?|\bresched(?:uled)?|r\/s|\bmoved|\bcancel(?:l?ed)?|\bbooked|\bconfirmed|\bsigned|\bdated|\brec'?d|\breceived|\brcvd|\bsent|\bfaxed|\bgiven|\bdrawn|\bdone|\bcompleted|\blast|\bsince|\bcall(?:ed)?\s+back|\bbegin(?:s|ning)?|\bending|\bends?|\bto|\band|\bor)\s*$/i;
  const DATE_CTX_AFTER = /^\s*(?:@|at\s+)?\d{1,2}:\d{2}|^\s*(?:@|at)\s*\d{3,4}\b|^\s*(?:appt|appointment|visit|labs?|scan|infusion|tx|c\d+d\d+|cycle|for|with|w\/|and|or|-|–|thru|through|to)\b/i;
  const RANGE_BEFORE = /(?:\b(?:cycles?|days?|doses?|weeks?|wks?|months?|mos?|yrs?|years?|(?<!\/)c\d*d?|dose|ratio|grade|range|levels?|pages?|items?|q|x|times|courses?|fractions?|fx|sessions?|pain|fatigue|nausea|distress|anxiety|depression|dyspnea|score|scores?|rated?|rating|scale|severity|intensity|vas|nrs|esas)|#)\s*$/i;

  // ordinary words that are also common in street names ("Old Mill", "Main", "Park"): not a reason to reject an address
  const PLACE_WORD = /^(?:Old|New|North|South|East|West|Upper|Lower|Mill|Park|Lake|Hill|Oak|Pine|Elm|Maple|Cedar|Spring|Main|High|Church|Union|River|Valley|Forest|Grove|Green|Bay|Rose|King|Queen|Market|Center|Centre|Bridge|Water|Meadow|Field|Wood|Glen|Brook|Stone|Rock|Willow|Birch|Ash|Cherry|Sunset|Hillside|Lakeview|Ridge)$/;
  function ruleSpans(text, cfg) {
    const spans = [];
    const push = (m, type, extra) => spans.push(Object.assign({ start: m.index, end: m.index + m[0].length, type, source: 'rule', text: m[0] }, extra || {}));
    const run = (re, type, filter) => { re.lastIndex = 0; let m; while ((m = re.exec(text))) { if (!filter || filter(m)) push(m, type); if (m[0].length === 0) re.lastIndex++; } };

    // Spanish / French / Portuguese / Italian day-month dates ("3 de noviembre", "12 novembre 2026", "le 4 mars")
    run(/\b\d{1,2}(?:\s+de)?\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|sept?iembre|octubre|noviembre|diciembre|janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|janeiro|fevereiro|mar[cç]o|maio|junho|julho|setembro|outubro|novembro|dezembro|gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre)(?:\s+(?:de\s+)?\d{4})?\b/gi, 'DATE');
    run(RULES.EMAIL, 'EMAIL'); if (/[\[(\{]\s*at\s*[\])\}]/i.test(text)) run(RULES.EMAIL_OBF, 'EMAIL'); run(RULES.URL, 'URL');
    const lateIds = [];
    { // vehicle plates ("plate IL KX4 7721"), a list of record numbers after "MRNs", and letter-led member numbers (HP00917735)
      const pushId = (a, b, type) => { lateIds.push({ start: a, end: b, type, source: 'rule', conf: 0.9, text: text.slice(a, b) }); };
      let pm; const PLATE = /\b(?:licen[cs]e\s+)?(?:plate|tag)s?\b\s*(?:#|no\.?|number)?\s*:?\s*(?:(?:[A-Z]{2})\s+)?([A-Z0-9]{1,4}(?:[\s-][A-Z0-9]{2,5})?)\b/g;
      while ((pm = PLATE.exec(text))) { const v = pm[1]; if (!/\d/.test(v) || !/[A-Z]/.test(v) && v.replace(/\D/g, '').length < 5) continue; const a = pm.index + pm[0].length - v.length; pushId(a, a + v.length, 'ID_OTHER'); }
      const MRNS = /\b(?:MRNs|MRN's|record\s+numbers)\b/gi;
      while ((pm = MRNS.exec(text))) { const win = text.slice(pm.index, pm.index + 90); const re = /\d[\d\-]{4,}\d/g; let d; while ((d = re.exec(win))) { if (d[0].replace(/\D/g, '').length >= 6) pushId(pm.index + d.index, pm.index + d.index + d[0].length, 'MRN'); } }
      const DL = /\b(?:DL|D\.L\.|driver'?s?\s+licen[cs]e|licen[cs]e)\b\s*(?:#|no\.?|number)?\s*[:(]?\s*([A-Z]{0,2}\d[\dA-Z\-]{5,}\d)/g;
      while ((pm = DL.exec(text))) { const v = pm[1]; const a = pm.index + pm[0].length - v.length; pushId(a, a + v.length, 'ID_OTHER'); }
      // a street address with a direction letter and a unit ("1220 W Alvarado St Apt 3")
      const ADDR2 = /\b\d{1,6}\s+(?:[NSEW]|NE|NW|SE|SW|North|South|East|West)\.?\s+(?:\p{Lu}[\p{L}'’\-]*\s+){1,3}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Ter|Terrace|Cir|Hwy)\b\.?(?:,?\s*(?:Apt|Apartment|Unit|Ste|Suite|#)\.?\s*#?[A-Za-z]?\d+[A-Za-z]?)?/gu;
      while ((pm = ADDR2.exec(text))) pushId(pm.index, pm.index + pm[0].length, 'ADDRESS');
      // a phone written "(555)-012-9944"
      const PH2 = /\(\d{3}\)\s*[-.]\s*\d{3}[-.\s]\d{4}\b/g;
      while ((pm = PH2.exec(text))) pushId(pm.index, pm.index + pm[0].length, 'PHONE');
      // a day and month after a visit word ("Appt 11/11", "RTC 3/4")
      const VISIT_DM = /\b(?:appt|appointment|visit|seen|due|scheduled|sched|return|rtc|f\/u|follow[- ]?up)\b\.?:?\s+(\d{1,2}\/\d{1,2})(?![\/\d])/gi;
      while ((pm = VISIT_DM.exec(text))) { const v = pm[1], a = pm.index + pm[0].length - v.length; const [mo, da] = v.split('/').map(Number); if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) pushId(a, a + v.length, 'DATE'); }
      // a run-together day and month: "4Nov", "18Nov26"
      const DMON = /\b(\d{1,2})(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)(\d{2}|\d{4})?\b/g;
      while ((pm = DMON.exec(text))) { if (+pm[1] >= 1 && +pm[1] <= 31) pushId(pm.index, pm.index + pm[0].length, 'DATE'); }
      // an address written in lower case after an address cue: "new addr 1207 w magnolia st, apt 3, fresno ca 93705"
      const ADDR_LC = /\b(?:addr|address|lives\s+at|living\s+at|staying\s+at|moved\s+to|new\s+home|home\s+at|located\s+at)\b[\s:.,]*(\d{1,6}\s+(?:[nsew]\.?\s+)?(?:[a-z][a-z'’\-]*\s+){1,3}(?:st|street|ave|avenue|rd|road|blvd|dr|drive|ln|lane|ct|court|way|pl|place|pkwy|ter|cir|hwy)\b\.?(?:,?\s*(?:apt|apartment|unit|ste|suite|#)\.?\s*#?[a-z]?\d+[a-z]?)?(?:,?\s+[a-z][a-z'’\-]*(?:\s[a-z][a-z'’\-]*)?,?\s+[a-z]{2}\s+\d{5}(?:-\d{4})?)?)/gi;
      while ((pm = ADDR_LC.exec(text))) { const v = pm[1], a = pm.index + pm[0].length - v.length; pushId(a, a + v.length, 'ADDRESS'); }
      const ALNUM = /\b[A-Z]{1,4}\d{7,12}\b(?!\s*(?:mg|mcg|ml|units?|iu)\b)/g;
      while ((pm = ALNUM.exec(text))) pushId(pm.index, pm.index + pm[0].length, 'ID_OTHER');
    }
    { RULES.SERIAL_NEAR.lastIndex = 0; let sm; while ((sm = RULES.SERIAL_NEAR.exec(text))) { const v = sm[1]; if (v.replace(/\D/g, '').length < 5) continue; const a = sm.index + sm[0].length - v.length; if (spans.some((x) => x.start < a + v.length && a < x.end)) continue; spans.push({ start: a, end: a + v.length, type: 'ID_OTHER', source: 'rule', conf: 0.9, text: v }); } } run(RULES.IP, 'IP'); run(RULES.SSN, 'SSN');
    { RULES.SSN_LAST4.lastIndex = 0; let sm; while ((sm = RULES.SSN_LAST4.exec(text))) { const st = sm.index + sm[0].length - 4; spans.push({ start: st, end: st + 4, type: 'ID_OTHER', source: 'rule', text: sm[1] }); } }
    { RULES.INSURANCE_ID.lastIndex = 0; let im; while ((im = RULES.INSURANCE_ID.exec(text))) { const st = im.index + im[0].lastIndexOf(im[1]); spans.push({ start: st, end: st + im[1].length, type: 'ID_OTHER', source: 'rule', text: im[1] }); } }
    { RULES.PHONE_WORDS.lastIndex = 0; let pm; while ((pm = RULES.PHONE_WORDS.exec(text))) { const words = pm[0].trim().replace(/[,\s.]+$/, '').split(/[\s\-.,]+/); const digits = words.reduce((n, w) => n + (/^\d+$/.test(w) ? w.length : 1), 0); if (digits >= 7 && words.filter((w) => !/^\d+$/.test(w)).length >= 3) spans.push({ start: pm.index, end: pm.index + pm[0].trim().length, type: 'PHONE', source: 'rule', text: pm[0].trim() }); } }
    run(RULES.PHONE, 'PHONE'); run(RULES.ADDRESS, 'ADDRESS'); run(RULES.ZIP, 'ZIP'); run(RULES.ZIP_LABEL, 'ZIP');
    run(RULES.PO_BOX, 'ADDRESS'); run(RULES.ADDRESS_ROUTE, 'ADDRESS');
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
    const townAfter = (ad) => {
      if (spans.some((x) => x.type === 'LOCATION' && x.start >= ad.end && x.start <= ad.end + 3)) return;
      const from = ad.end;
      const tail = text.slice(from).match(/^,?[ \t]+((?:[A-Z][A-Za-z'’\-]+,?[ \t]+){0,3}?)(?:([A-Z]{2}),?[ \t]+)?(\d{5}(?:-\d{4})?)\b/);
      if (tail) { const lead = tail[0].match(/^,?[ \t]+/)[0].length; spans.push({ start: from + lead, end: from + tail[0].length, type: 'LOCATION', source: 'rule', text: tail[0].slice(lead) }); return; }
      let town = text.slice(from).match(/^,?[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)(?=[ \t]*(?:[.,;:\n(]|[\-–—](?![\w])|$))/); // also "Harrowgate Ln, Milbrook - update"
      // a named complex between the street and the town: "14 Pine Ridge Mobile Home Park, Gorham Falls", "2 Elm Ct Apartments, Tisbury"
      if (!town) town = text.slice(from).match(/^(?:[ \t]+(?:Mobile|Home|Trailer|RV|Park|Estates?|Manor|Village|Villas?|Towers?|Apartments?|Apts|Condos?|Condominiums?|Court|Commons|Gardens|Place|Plaza|Terrace|Senior|Living|Community|Residences?)\b){1,4},[ \t]+([A-Z][a-z]+(?:[ \t]+[A-Z][a-z]+)?)(?=[ \t]*(?:[.,;:\n]|$))/);
      if (town && !LEX.isClinical(town[1])) { const lead = town[0].length - town[1].length; spans.push({ start: from + lead, end: from + town[0].length, type: 'LOCATION', source: 'rule', text: town[1] }); }
    };
    spans.filter((x) => x.type === 'ADDRESS').forEach(townAfter);
    run(RULES.AGE, 'AGE'); run(RULES.AGE_ORDINAL, 'AGE'); run(RULES.AGE_WORDS, 'AGE'); run(RULES.AGE_Y, 'AGE');
    RULES.AGE_WORDS_LABEL.lastIndex = 0; let aw;
    while ((aw = RULES.AGE_WORDS_LABEL.exec(text))) { const v = aw[0].match(/(?:ninety|one[-\s]hundred).*$/i)[0]; const start = aw.index + aw[0].length - v.length; if (!spans.some((x) => x.type === 'AGE' && x.start <= start && x.end >= start + v.length)) spans.push({ start, end: start + v.length, type: 'AGE', source: 'rule', text: v }); }
    run(RULES.AGE_SUBJECT, 'AGE', (m) => {
      // "HR is 95" / "K is 95" / "O2 sat is 95": a vital or lab name right before the subject word is not a person
      const before = text.slice(Math.max(0, m.index - 16), m.index);
      return !/\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc)\s*$/i.test(before);
    });
    // ages with no written subject, and in apposition: the span is the age phrase only
    RULES.AGE_TURNED.lastIndex = 0; let am;
    while ((am = RULES.AGE_TURNED.exec(text))) { const val = am[1]; const start = am.index + am[0].length - val.length; spans.push({ start, end: start + val.length, type: 'AGE', source: 'rule', text: val }); }
    // "<person> is 95": a person as the subject (honorific + name, pronoun, pt, or a capitalised name that is not a
    // lab/vital label) and a bare 90-119 with no unit after it. "Plt is 95", "HR is 95", "BP is 95/60" are left alone.
    { const LABS = /^(plt|plts|platelets?|hgb|hb|hct|wbc|anc|alc|rbc|mcv|glu|glucose|na|k|cl|co2|bun|cr|creat|egfr|ca|mg|phos|alb|ast|alt|bili|ldh|inr|ptt|tsh|cea|psa|hr|bp|rr|sat|sats|spo2|o2|temp|t|weight|wt|ht|height|pulse|rate|score|count|level|ef|lvef|gfr|bmi|map|pain|ecog|kps|karnofsky|fev1|dose|volume|vol|oxygen|systolic|diastolic|sodium|potassium|calcium|albumin|protein|ferritin|saturation|creatinine|hemoglobin|magnesium|chloride|bicarb|ldl|hdl|a1c|reading|result|value|number)$/i;
      const re = /\b((?:(?:mr|mrs|ms|mx|dr)\.?\s+[A-Z][A-Za-z'’\-]+)|he|she|they|pt|patient|[A-Z][a-z'’\-]{2,})(?:\s+[A-Z][a-z'’\-]+)?\s+(?:is|was|'s|’s|now)\s+(9\d|1[01]\d)\b(?![\d\/%:.-]|,\d)(?!\s*(?:mg|kg|lb|lbs|%|mmhg|bpm|k\b|ml|cc|units?|percent|years?\s+(?:ago|since)|min|minutes|hours?))/g;
      let pm;
      while ((pm = re.exec(text))) {
        const subj = pm[1].replace(/^(?:mr|mrs|ms|mx|dr)\.?\s+/i, '');
        if (LABS.test(subj) || LEX.isClinical(subj) && !/^(he|she|they|pt|patient)$/i.test(subj)) continue;
        const val = pm[2]; const start = pm.index + pm[0].length - val.length;
        if (spans.some((sp) => sp.type === 'AGE' && sp.start <= start && sp.end >= start + val.length)) continue; // already caught
        spans.push({ start, end: start + val.length, type: 'AGE', source: 'rule', text: val });
      }
    }
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
    // a street typed in lower case after a locative word: "pharmacy on alvarado st", "lives off cedar crest rd"
    { const re = /\b(?:on|at|near|off|onto|by)[ \t]+((?:[a-z][a-z'’\-]{2,}[ \t]){1,2}(?:st|street|ave|avenue|rd|road|blvd|ln|lane|ct|pkwy|hwy|ter|trl|cir|way)\b\.?)/g; let lm;
      while ((lm = re.exec(text))) {
        const words = lm[1].split(/[ \t]+/).slice(0, -1);
        // an eponym that is also a surname names the street here (Alvarado St); other clinical words do not
        if (!words.every((w) => !COMMON_LOWER.has(w) && !COMMON_CAP.has(w) && (!LEX.isClinical(w) || LEX.isSurname(w)) && !relWord(w) && (!LEX.isEnglishWord(w) || PLACE_WORD.test(capFirst(w)) || inLexWord(w)))) continue;
        const start = lm.index + lm[0].length - lm[1].length;
        spans.push({ start, end: start + lm[1].length, type: 'ADDRESS', source: 'rule', text: lm[1], conf: 0.7 });
      }
    }
    RULES.ADDRESS_CUE.lastIndex = 0; let ac;
    while ((ac = RULES.ADDRESS_CUE.exec(text))) {
      const val = ac[1]; const start = ac.index + ac[0].length - val.length;
      if (!val.split(/\s+/).slice(1).every(addrWordOk)) continue;
      spans.push({ start, end: start + val.length, type: 'ADDRESS', source: 'rule', text: val, conf: 0.8 });
    }
    spans.filter((x) => x.type === 'ADDRESS').forEach(townAfter); // streets found after the first pass ("Harrowgate Ln, Milbrook")
    // the town after an apartment or suite number: "Apt 14, Rosemead", "Suite 200, Ashgrove 04120"
    { const re = /\b(?:Apt|APT|Apartment|Suite|Ste)\.?[ \t]*#?[A-Za-z]?\d{1,5}[A-Za-z]?,[ \t]+([A-Z][a-z]+(?:[ \t][A-Z][a-z]+)?)(?=[ \t]*(?:[.,;:\n(]|[\-–—](?![\w])|\d{5}|$))/g; let am2;
      while ((am2 = re.exec(text))) {
        const w = am2[1]; const st = am2.index + am2[0].length - w.length;
        if (w.split(/[ \t]/).some((x) => LEX.isClinical(x) || COMMON_CAP.has(x.toLowerCase()) || FIELD_WORD_ALL.test(x))) continue;
        if (spans.some((x) => x.start < st + w.length && st < x.end)) continue;
        spans.push({ start: st, end: st + w.length, type: 'LOCATION', source: 'rule', text: w, conf: 0.7 });
      }
    }
    // an age column after a record number on a census line: "Whitfield, 1964283 91 2u PRBC", "6013875 92   grandson ..."
    { const re = /(?<![\w\/.\-])[A-Z]{0,2}\d{6,10}[ \t]+(9\d|1[01]\d)(?=[ \t|,;]|$)(?![ \t]*(?:mg|mcg|g|kg|ml|mL|units?|%|x|lbs?|min|mins|hrs?|minutes|hours|days?|mmhg|bpm)\b)/gm; let ag;
      while ((ag = re.exec(text))) { const st = ag.index + ag[0].length - ag[1].length; if (!spans.some((x) => x.type === 'AGE' && x.start <= st && x.end >= st + 2)) spans.push({ start: st, end: st + ag[1].length, type: 'AGE', source: 'rule', text: ag[1], conf: 0.7 }); }
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
      const val = hm[1] || hm[2] || hm[0]; const start = hm.index + hm[0].length - val.length;
      if (hm[1] && /^(?:password|pw|pwd|none|n\/a|same|locked|reset)$/i.test(val)) continue;
      spans.push({ start, end: start + val.length, type: 'ID_OTHER', source: 'rule', text: val, handle: true });
    }
    RULES.HANDLE_SHAPE.lastIndex = 0; let hs;
    while ((hs = RULES.HANDLE_SHAPE.exec(text))) {
      const v = hs[0];
      // snake_case words (pre_chemo, lab_results) are not user names; a dotted name after a portal/proxy label or a relation word is
      // ("Proxy: grandson ezra.kaminski")
      if ((v.match(/\d/g) || []).length < 2) {
        const before = text.slice(Math.max(0, hs.index - 30), hs.index);
        const prevWord = (before.match(/([A-Za-z\-]+)\W*$/) || [])[1] || '';
        if (!(/\./.test(v) && (/\b(?:proxy|user(?:name)?|login|mychart|portal|handle|account|acct)\b[^.\n]{0,25}$/i.test(before) || relWord(prevWord)))) continue;
      }
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
    run(/(?<=(?:#|\bno\.?|\bid|\bnum(?:ber)?)\s?)[A-Z]{0,2}\d{6,10}\b/gi, 'ID_OTHER', notPhoneExt);
    run(/(?<![\w\/.-])[A-Z]{1,2}\d{6,10}-\d{1,2}(?![\w\/.-])/g, 'ID_OTHER', notPhoneExt); // "E0049182-7": a record number with a check digit
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
        if (p.kind === 'My' && !/^[A-Z]/.test(m[0])) continue; // "may 2026" in lower case is a verb more often than a month
        const after = text.slice(m.index + m[0].length);
        if (!pd.hasYear && UNIT_AFTER.test(after)) continue;
        // "May second line", "March first dose": a spelled-out day with no year is a date only after a date word ("on March fourth")
        if ((p.kind === 'Mwy' || p.kind === 'wMy') && !pd.hasYear && (!DATE_CTX_BEFORE.test(text.slice(Math.max(0, m.index - 20), m.index)) || /^\s*(?:line|lines|cycle|cycles|dose|doses|round|rounds|course|courses|time|times|visit|infusion|treatment|week|day)\b/i.test(after))) continue;
        if (p.kind === 'md') {
          // "C1D1"-style, "cycle 1/2", "days 1-3" are not dates
          const before = text.slice(Math.max(0, m.index - 10), m.index);
          const nextCycle = /next\s+cycle\s*$/i.test(text.slice(Math.max(0, m.index - 14), m.index));
          if (RANGE_BEFORE.test(before) && !nextCycle) {
            // a score, grade or ratio ("fatigue 6/10", "grade 1/4", "ratio 1/2") is never a date; after dose/day/cycle an
            // m/d is a date unless it looks like a small fraction ("dose 1/2", "cycle 3/6") -- "Second dose 11/12." is a date
            const scoreCtx = /(?:pain|fatigue|nausea|distress|anxiety|depression|dyspnea|scores?|rated?|rating|scale|severity|intensity|vas|nrs|esas|ratio|grade|levels?|pages?|items?|fractions?|fx|sessions?|times|courses?|x|q)\s*$/i.test(before);
            const smallFraction = pd.m < pd.d && pd.d <= (/cycle|cycles|c\d/i.test(before) ? 8 : 4) && pd.m <= 3;
            if (scoreCtx || smallFraction || pd.sep === '-' || !/^[.,;)\s]|^\s*(?:timing|appt|visit|at|@|\d{1,2}:\d{2})/i.test(after)) continue;
          }
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
    // the second date of a range written with a dash ("11/16-12/07", "11/16 - 12/07", "3/2/26-3/30/26"): a date because the
    // first one is (the m/d pattern alone refuses a number glued to a dash, so "days 1-3" stays)
    for (const ds of spans.filter((x) => x.type === 'DATE' && x.date && /^(?:md|mdy)$/.test(x.date.kind))) {
      const rm = text.slice(ds.end).match(/^[ \t]*[-–][ \t]*(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d\/]|\.\d)/);
      if (!rm) continue;
      const txt = `${rm[1]}/${rm[2]}${rm[3] ? '/' + rm[3] : ''}`;
      const st = ds.end + rm[0].length - txt.length;
      if (spans.some((x) => x.type === 'DATE' && x.start <= st && x.end > st)) continue;
      const pd = rm[3] ? parseDateMatch('mdy', Object.assign([txt, rm[1], '/', rm[2], rm[3]], { index: st })) : parseDateMatch('md', Object.assign([txt, rm[1], '/', rm[2]], { index: st }));
      if (pd) spans.push({ start: st, end: st + txt.length, type: 'DATE', source: 'rule', text: txt, date: pd });
    }
    // "11/24-26": a month and day with the end of a range written as a bare day (the m/d pattern refuses a number glued to a
    // dash, so "days 1-3" stays); not a score, a cycle or a small fraction, and the end after the start (or past a month end)
    {
      const re = /(?<![A-Za-z0-9\/.\-])(\d{1,2})\/(\d{1,2})([ \t]*[-–—][ \t]*)(\d{1,2})(?![\d\/:]|\.\d)/g; let rm;
      while ((rm = re.exec(text))) {
        const mo = +rm[1], d1 = +rm[2], d2 = +rm[4];
        const before = text.slice(Math.max(0, rm.index - 12), rm.index), after = text.slice(rm.index + rm[0].length);
        if (mo < 1 || mo > 12 || RANGE_BEFORE.test(before) || UNIT_AFTER.test(after) || COUNT_AFTER.test(after)) continue;
        if (!(d2 > d1 || (d1 >= 20 && d2 <= 10)) || (mo <= 3 && d1 <= 4 && !DATE_CTX_BEFORE.test(text.slice(Math.max(0, rm.index - 20), rm.index)))) continue;
        const txt = `${rm[1]}/${rm[2]}`;
        const pd = parseDateMatch('md', Object.assign([txt, rm[1], '/', rm[2]], { index: rm.index }));
        if (!pd || spans.some((x) => x.start < rm.index + rm[0].length && x.end > rm.index && COARSE(x.type) === 'DATE')) continue;
        spans.push({ start: rm.index, end: rm.index + txt.length, type: 'DATE', source: 'rule', text: txt, date: pd });
      }
    }
    // the end of a range written as a bare day after a month and day ("Nov 24–26", "Dec 3 to 5", "11/24-26"): a date of the
    // start's month (the next month when the day is smaller), shifted with the start
    for (const ds of spans.filter((x) => x.type === 'DATE' && x.date && /^(?:md|Mdy|dMy)$/.test(x.date.kind) && !x.date.hasYear)) {
      const rm = text.slice(ds.end, ds.end + 24).match(/^([ \t]*(?:[-–—]|to|thru|through|until|till)[ \t]*)(\d{1,2})(?:st|nd|rd|th)?(?![\d\/:.]|[ \t]*(?:am|pm|a|p)\b|[A-Za-z])/i);
      if (!rm || UNIT_AFTER.test(text.slice(ds.end + rm[0].length)) || COUNT_AFTER.test(text.slice(ds.end + rm[0].length))) continue;
      const d2 = +rm[2], st = ds.date;
      if (!(d2 > st.d || (st.d >= 20 && d2 <= 10))) continue;
      const pos = ds.end + rm[1].length, len = rm[0].length - rm[1].length;
      if (spans.some((x) => x.start < pos + len && x.end > pos)) continue;
      let y = st.y, m2 = st.m;
      if (d2 < st.d) { m2++; if (m2 > 12) { m2 = 1; y++; } }
      if (!validDMY(y, m2, d2)) continue;
      const etxt = text.slice(pos, pos + len);
      spans.push({ start: pos, end: pos + len, type: 'DATE', source: 'rule', text: etxt, date: { y, m: m2, d: d2, hasYear: false, yearDigits: st.yearDigits, sep: st.sep, kind: 'dayr', monthStyle: st.monthStyle, text: etxt, range: st, dayFirst: false, ordinalWord: '' } });
    }
    // a date inside a file name written without separators: "IMG_20261104_0932.jpg", "consent-11042026.pdf". Only an 8-digit
    // run inside a file name, read as YYYYMMDD or MMDDYYYY with the month and day checked (a record number elsewhere stays one)
    if (/\.(?:pdf|jpe?g|png|gif|tiff?|bmp|heic|docx?|xlsx?|csv|txt|rtf|dcm|zip|msg|eml|html?|mp4|mov)(?![A-Za-z0-9])/i.test(text)) {
      const FILE_TOKEN = /(?<![A-Za-z0-9_\-.])[A-Za-z0-9][A-Za-z0-9_\-.]{0,120}?\.(?:pdf|jpe?g|png|gif|tiff?|bmp|heic|docx?|xlsx?|csv|txt|rtf|dcm|zip|msg|eml|html?|mp4|mov)(?![A-Za-z0-9])/gi; let fm;
      while ((fm = FILE_TOKEN.exec(text))) {
        const d8re = /(?<![0-9])(\d{8})(?![0-9])/g; let d8;
        while ((d8 = d8re.exec(fm[0]))) {
          const s8 = d8[1], st = fm.index + d8.index;
          if (spans.some((x) => x.start < st + 8 && x.end > st && COARSE(x.type) === 'DATE')) continue;
          let pd = null;
          const ya = +s8.slice(0, 4), ma = +s8.slice(4, 6), da = +s8.slice(6, 8), mb = +s8.slice(0, 2), db = +s8.slice(2, 4), yb = +s8.slice(4, 8);
          if (/^(?:19|20)/.test(s8) && validDMY(ya, ma, da)) pd = { y: ya, m: ma, d: da, hasYear: true, yearDigits: 4, sep: '', kind: 'ymdc', monthStyle: null, text: s8 };
          else if (/^(?:19|20)/.test(s8.slice(4)) && validDMY(yb, mb, db)) pd = { y: yb, m: mb, d: db, hasYear: true, yearDigits: 4, sep: '', kind: 'compact', monthStyle: null, text: s8 };
          if (pd) spans.push({ start: st, end: st + 8, type: 'DATE', source: 'rule', text: s8, date: pd });
        }
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
    // added last, only where no other rule already matched, so a labelled identifier keeps its own span
    lateIds.forEach((x) => { if (!spans.some((y) => y.start < x.end && x.start < y.end)) spans.push(x); });
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
        cap: /^\p{Lu}[\p{Ll}\p{M}'’\-]*$/u.test(core) || /^\p{Lu}[\p{Ll}\p{M}]+-\p{Lu}[\p{Ll}\p{M}]+$/u.test(core) || /^\p{Lu}[\p{Ll}\p{M}]+-[\p{Ll}\p{M}]{2,}$/u.test(core) || /^(?:al|el|ad|ar|as|ash|at|az|an|bin|ibn|ben|bint|abu|ould)-[A-Z][a-z'’]+(?:-[A-Z][a-z'’]+)?$/.test(core) || /^[A-Z][a-z]+-[A-Z][a-z]+$/.test(core) || (/^[A-Z][A-Za-z'’\-]*[a-z]$/.test(core) && (core.match(/[A-Z]/g) || []).length <= 3 && /^(Mc|Mac|De|Di|Da|La|Le|Van|Von|O'|O’|D'|D’|St|Fitz|Del|Des|Du)[A-Z'’]/.test(core)),
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
  const NAME_PARTICLE = /^(?:de|van|von|der|den|vd|la|le|del|della|da|di|du|dos|das|do|st|mc|mac|o|bin|ibn|bint|binti|ben|al|el|ter|ten|zu|af|y)$/i; // (vd: the Dutch "van de(r)" written short)
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
  // ordinary lower-case English words that follow a relation word or a greeting in notes and messages ("husband at bedside",
  // "son will drive", "hi its me"): never read as a lower-case name
  const COMMON_LOWER = new Set(('a an the and or but nor so yet for of to in on at by with from into onto over under about after before since until till ' +
    'is are was were be been being am has have had do does did will would shall should can could may might must not no yes ' +
    'he she they we you i me him her them us my his its it this that these those there here where when why how what who whom whose which ' +
    'also just only still even again then now today tonight tomorrow yesterday soon later already always never often sometimes ' +
    'called calls calling call says said say states stated reports reported report asked asks ask wants want wanted needs need needed ' +
    'drives drive drove driving brought brings bring picks picked pick drops dropped drop takes took take came come comes coming went go goes going ' +
    'left leaves leaving stays stayed staying lives lived living visits visited visiting helps helped help works worked working ' +
    'present home bedside waiting room lobby phone aware informed notified updated agrees agreed declined refused prefers prefer ' +
    'is was here there too well fine ok okay good great sick ill unwell tired worried upset concerned happy nervous anxious ' +
    'very really quite much more most less least all any some each every both either neither one two three four five ' +
    'again back away out up down off around through across along together alone ' +
    'hi hey hello dear thanks thank thx please sorry sure yeah yep nope lol ' +
    'got get gets getting made make makes making saw see sees seen know knows knew think thinks thought feel feels felt ' +
    'can cannot cant wont dont didnt doesnt isnt wasnt im ive id youre theyre were ' +
    'port line pump labs lab chemo infusion appt appointment visit nurse doctor dr md rn np pharmacy clinic ' +
    'mom dad son daughter wife husband sister brother friend neighbor neighbour aunt uncle niece nephew cousin grandson granddaughter ' +
    'mother father partner spouse caregiver proxy family kids kid children child baby ' +
    'rich bill will mark grace hope faith joy rose pat art sue may june april ' +
    'again since last next first second third new old same other another such own ' +
    'unable asleep awake due sore swollen red busy late early free nearby local willing scared afraid angry unsure supportive ' +
    'attentive involved available interested reluctant hesitant ready sick fine ok himself herself themselves myself yourself everyone ' +
    'someone anyone nobody everybody somebody doc docs team guys folks all much lot love xo xoxo regards cheers ' +
    "hasn't haven't isn't wasn't doesn't don't didn't can't won't couldn't wouldn't shouldn't aren't weren't " +
    "i'm it's she's he's they're we're you're that's there's what's let's i'll i'd i've you'll we'll she'll he'll " +
    'hasnt havent arent werent couldnt wouldnt shouldnt thats theres whats lets ill youll well hes shes ' +
    'feeling doing going getting having coming trying hoping wondering asking calling writing texting checking ' +
    'question questions concern concerns issue issues problem problems pain fever chills nausea rash cough ' +
    'tomorrow tonight weekend week month morning afternoon evening night monday tuesday wednesday thursday friday saturday sunday ' +
    'mon tue tues wed thu thur thurs fri sat sun asap please pls thx ty np idk btw fyi re ' +
    // descriptions of a relative written straight after the relation word ("husband deaf", "wife pregnant", "son overseas")
    'deaf blind bedbound homebound pregnant elderly disabled frail weak strong healthy calm overseas abroad deployed away absent ' +
    'primary sole only current former remote legal main backup alternate secondary wheelchair dialysis vegan smoker nonsmoker ' +
    'physician teacher veteran minor adult infant toddler teen teenager twins twin step half adopted retired unemployed student ' +
    'emotional tearful overwhelmed stressed exhausted demented forgetful confused alert agitated hearing nonverbal verbal ' +
    'hispanic latino latina asian black white jewish muslim catholic christian deceased widowed divorced separated married single ' +
    'diabetic epileptic hypertensive spanish english french arabic russian polish italian chinese korean vietnamese somali ' +
    'interpreting translating driving visiting staying helping caring sleeping resting eating working waiting').split(/\s+/));
  // word endings that mark an ordinary English noun or adjective rather than a name (Response, Management, Disconnect-ion ...)
  // (only endings that essentially never close a given name or surname: Constance, Felicity, Clement, Mallory stay names)
  const NONNAME_END = /(?:tion|sion|ness|ology|ics|able|ible|ful|less|ous|ated|ized|ised|ectomy|itis)$/i;
  const isHon = (t) => t && t.word && LEX.HONORIFIC_SET.has(t.core.toLowerCase());
  const isCred = (t) => t && t.word && LEX.CREDENTIAL_SET.has(t.core.replace(/\./g, '').toLowerCase()) && t.core === t.core.toUpperCase() || (t && t.word && /^(PharmD|PsyD|PhD)$/.test(t.core));
  // A token that ends a sentence: trailing period that is not an honorific/initial/credential
  const endsSentence = (t) => !!t && (t.nlAfter || (t.raw.endsWith('.') && !isHon(t) && !t.initial && !isCred(t) && !/^(vs|etc|approx|re|appt|pt|pts|hx|dx|tx|w|c|s|p|q|b|d|e|g|i|mg|mcg|ml|no|dr|mr|mrs|ms|st|jr|sr|inc|ltd)$/i.test(t.core)));
  const relWord = (w) => { const l = w.toLowerCase(); if (LEX.RELATION_SET.has(l) || /^[a-z]{1,8}-in-laws?$/.test(l)) return true; const b = l.replace(/^(?:(?:great|grand|step|half|ex)-?)+(?=[a-z])/, '').replace(/-in-law$/, ''); return b !== l && b.length >= 2 && LEX.RELATION_SET.has(b); };
  const isRel = (t) => t && t.word && relWord(t.core);
  // an ordinary English word that is not a name of any tier (Doing, Needs, Wheelchair); Grace, Bishop and Rose are names
  // (rare Census surnames such as "Doing" or "Fine" do not rescue an ordinary word; curated and strong-tier names do)
  const wordNotName = (t) => !!t && LEX.isEnglishWord(t.core) && !LEX.isStrongName(t.core) && !LEX.isCuratedName(t.core);
  const SERVICE_VERB = /^(consulted|consult|notified|paged|contacted|involved|aware|following|ordered|placed|referral|referred|team|dept|department|service|services|called|to|on|at|for|and|or)$/i;
  const inLexWord = (w) => LEX.isFirstName(w) || LEX.isSurname(w);
  const isNameish = (t, allow) => t && (t.cap || t.allcaps || t.initial) && !LEX.isClinical(t.core) && !(allow && allow.has(t.core.toLowerCase()));
  const inLex = (t) => t && (LEX.isFirstName(t.core) || LEX.isSurname(t.core));

  // Epic field labels (Appt Date, Start Date, Last Seen) as a module-level test for passes outside lexiconSpans
  const FIELD_WORD_ALL = /^(appt|appointment|date|start|end|next|last|first|due|visit|seen|scan|time|signed|number|num|sched|schedule|scheduled|ordered|entered|created|updated|name|phone|fax|cell|home|work|room|chair|bay|unit|floor|dept|department|status|type|note|notes|comment|comments|reason|result|results|dose|cycle|day|arrival|arrive|check|checked|dob|mrn|acct|sex|age|wt|ht|provider|attending|location|dx|tx|plan|order|orders)$/i;
  const DEVICE_BRAND = /^(?:CADD|Alaris|Sapphire|Medfusion|Curlin|Sigma|Plum|Hospira|BodyGuard|Ambit|Accufuser|Homepump|Infusor|Easypump|Freedom60|Neulasta|Onpro|Omnipod|PowerPort|Port-a-Cath|Groshong|Mediport)$/;
  function lexiconSpans(text, cfg) {
    const toks = tokenize(text);
    const tokAt = new Map(); toks.forEach((t, i) => { t.idx = i; tokAt.set(t.start, i); });
    const tokStarting = (pos) => (tokAt.has(pos) ? tokAt.get(pos) : -1);
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
    // the model name after an infusion-pump or device brand is equipment, not a person: "CADD Solis", "Alaris Medley",
    // "Sapphire Epidural", "Curlin 6000"
    for (let i = 0; i + 1 < toks.length; i++) {
      if (!toks[i].word || !DEVICE_BRAND.test(toks[i].core) || toks[i].nlAfter) continue;
      for (let q = i + 1; q < toks.length && q - i <= 2 && toks[q].word && (toks[q].cap || toks[q].allcaps || /\d/.test(toks[q].raw)) && !isHon(toks[q]) && !isRel(toks[q]); q++) { used[q] = true; if (endsSentence(toks[q])) break; }
    }
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
    // Pass F1b: an organisation followed by ", Town" ("Riverbend Oncology, Tulsa")
    for (const sp of spans.filter((x) => x.type === 'ORG')) {
      const after = text.slice(sp.end).match(/^,\s+(\p{Lu}[\p{Ll}\p{M}'’\-]+)(?=[\s.;,)]|$)/u);
      if (!after) continue;
      const w = after[1]; const ti = tokStarting(sp.end + after[0].length - w.length);
      if (ti < 0 || used[ti] || LEX.isClinical(w) || LEX.isFirstName(w) || LEX.isAnchorName(w) || (LEX.isEnglishWord(w) && !LEX.CITY_SET.has(w.toLowerCase())) || LEX.STATE_ABBR_SET.has(w)) continue;
      used[ti] = true; spans.push({ start: toks[ti].start, end: toks[ti].end, type: 'LOCATION', source: 'cue:org-town', conf: 0.6, text: w });
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
        const acronym = /^[A-Z]{3,6}$/.test(toks[j].core) && !LEX.isClinical(toks[j].core) && !LEX.STATE_ABBR_SET.has(toks[j].core) && !LEX.CREDENTIAL_SET.has(lc) && !LEX.RELATION_SET.has(lc) && !(capsNeighbour(j - 1) && j - 1 > i) && !capsNeighbour(j + 1) && !(toks[j + 1] && toks[j + 1].word && !toks[j + 1].cap && /^(screen|screening|test|tests|panel|scan|scans|level|levels|labs?|culture|titer|results?|protocol|study|score|positive|negative|pending|due|drawn|ordered|resulted|elevated|low|high|normal|wnl|stable|workup|w\/u|clinic|infusion|therapy|tx|dose|rate|count|counts)$/i.test(toks[j + 1].core));
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
      if ((st === 'PA' || st === 'MD') && ((inLex(t) && !LEX.CITY_SET.has(t.core.toLowerCase())) || (LEX.isClinical(t.core) && !LEX.CITY_SET.has(t.core.toLowerCase())))) continue; // "Smith, PA" is a credential
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
    // Pass F7b: a nickname in single quotes ('Bibi', ‘Peggy’) next to a name or a relation word
    for (let i = 1; i + 1 < toks.length; i++) {
      const q1 = toks[i - 1], nick = toks[i], q2 = toks[i + 1];
      const glued = /['’]$/.test(nick.raw) && !/['’]s$/.test(nick.raw);
      if (used[i] || !/^['‘]$/.test(q1.raw) || !(/^['’]$/.test(q2.raw) || glued) || !nick.word || !/^\p{Lu}[\p{Ll}\p{M}\-]+['’]?$/u.test(nick.core) || LEX.isClinical(nick.core.replace(/['’]$/, '')) || wordNotName({ core: nick.core.replace(/['’]$/, '') })) continue;
      const near = (k) => toks[k] && ((toks[k].word && (toks[k].cap || isRel(toks[k]))) || toks[k].raw === '(');
      if (!(near(i - 2) || near(i + 2)) && !LEX.isFirstName(nick.core)) continue;
      addRun(i, i + 1, 'NAME_OTHER', 'cue:nickname', 0.65);
    }
    // Pass F7: a quoted nickname inside a name (Adebayo "Bayo" Ogunwale)
    for (let i = 0; i + 4 < toks.length; i++) {
      const a = toks[i], q1 = toks[i + 1], nick = toks[i + 2], q2 = toks[i + 3], b = toks[i + 4];
      if (used[i] || used[i + 4] || !a.cap || !b.cap || !/^["“]$/.test(q1.raw) || !/^["”]$/.test(q2.raw) || !nick.word || !nick.cap) continue;
      if (LEX.isClinical(a.core) || LEX.isClinical(b.core) || wordNotName(a) || wordNotName(b)) continue;
      if (!(LEX.isFirstName(a.core) || LEX.isSurname(a.core) || LEX.isSurname(b.core) || LEX.isFirstName(b.core)) && (LEX.isEnglishWord(a.core) || LEX.isEnglishWord(b.core))) continue;
      addRun(i, i + 5, 'NAME_OTHER', 'cue:nickname', 0.7);
      i += 4;
    }
    // Pass A: honorific + name  (Dr. Lee, Mrs. Thaddeus Abernathy)
    for (let i = 0; i < toks.length - 1; i++) {
      if (!isHon(toks[i])) continue;
      if (toks[i + 1] && ((LEX.isEnglishWord(toks[i + 1].core) && !LEX.isFirstName(toks[i + 1].core) && !LEX.isSurname(toks[i + 1].core)) || (/^MS$/.test(toks[i].core) && !inLex(toks[i + 1])))) continue; // "MS. Premed solumedrol", "Dr. Notes"
      let j = nameRun(i + 1, 3, true);
      // a surname that is also a clinical eponym or device ("Mr. Hickman's Hickman catheter", "Mrs. Graves called"): after an
      // honorific it is the person, unless the next word makes it the disease or sign ("Bell's palsy")
      if (j === i + 1 && i + 1 < toks.length && toks[i + 1].word && toks[i + 1].cap && toks[i + 1].core.length >= 3 && LEX.isClinical(toks[i + 1].core) && !used[i + 1] && !toks[i].nlAfter) {
        const nx = toks[i + 2];
        if (!(nx && nx.word && (LEX.EPONYM_FOLLOW.has(nx.core.toLowerCase()) || MED_SUFFIX.test(nx.core)))) j = i + 2;
      }
      if (j > i + 1) addRun(i + 1, j, /^(dr|doctor|prof|nurse)$/i.test(toks[i].core) ? 'NAME_PROVIDER' : 'NAME_OTHER', 'cue:honorific', 0.95);
    }
    // Pass A2: dotted initials as a given name, after a label, honorific or relation word ("Pt J.R. Whitcombe-Faraday",
    // "Mr. J. R. Okafor", "husband T.J. Brennan"), with the surname when one follows
    for (let i = 0; i + 1 < toks.length; i++) {
      const p = toks[i];
      const label = isHon(p) || isRel(p) || (p.word && /^(pt|patient|name|re|caller|contact)$/i.test(p.core) && !/['’]s$/.test(p.raw)) || p.raw === ':'
        || (p.word && /^(?:is|was)$/i.test(p.core) && i > 0 && toks[i - 1].word && /^(?:pt|patient|name|caller)$/i.test(toks[i - 1].core)); // "Pt is A.K. VANDERMOLEN"
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
      // ... or a phone number right after it ("hospice RN Dorrie Pratt 555-010-4403")
      const phoneNext = nx && nx.num && /^(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b|^\d{3}[-.\s]\d{4}\b/.test(text.slice(nx.start, nx.start + 16));
      if (nx && !phoneNext && !/^[,()\-–:;.]$/.test(nx.raw) && !(nx.word && /^(called|calls|states|stated|reports|reported|says|said|notified|aware|confirmed|will|is|was|at|from|with|re)$/i.test(nx.core))) continue;
      addRun(i + 1, j, 'NAME_PROVIDER', 'cue:credential', 0.8);
      i = j - 1;
    }
    // Pass B: name + credential (John Smith MD; J. Smith, NP; Smith RN)
    for (let i = 1; i < toks.length; i++) {
      if (!isCred(toks[i]) || used[i]) continue;
      let j = i; const comma = toks[j - 1] && toks[j - 1].raw === ','; if (comma) j--;
      let k = j;
      const nameishB = (t) => isNameish(t, allow) || ((t.cap || t.allcaps) && inLex(t) && !(allow && allow.has(t.core.toLowerCase())));
      while (k > 0 && k > j - 3 && nameishB(toks[k - 1]) && !wordNotName(toks[k - 1]) && !used[k - 1] && !isRel(toks[k - 1]) && !(k - 1 < j - 1 && endsSentence(toks[k - 1]))) k--;
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
      if (toks[i].cap && i + 1 < toks.length && toks[i + 1].word && SERVICE_VERB.test(toks[i + 1].core)) continue; // "Chaplain consulted"
      let j = i + 1, hops = 0;
      while (j < toks.length && hops < 5 && !endsSentence(toks[j]) && (/^(named|is|was|,|:|\(|and|or|the|her|his|their|pt's|patient's|'s|'s|id|#|no|number|ext|x|also)$/i.test(toks[j].raw) || (hops === 0 && /^(for|of)$/i.test(toks[j].raw) && /^(proxy|poa|hcp|dpoa|mpoa|guardian|caregiver|caretaker|agent|surrogate|representative|rep)$/i.test(toks[i].core)) || /^(’s|'s)$/.test(toks[j].raw) || (toks[j].num && /^\d{1,6}$/.test(toks[j].raw) && hops > 0) || (toks[j].raw === ')' && hops > 0))) { j++; hops++; }
      if (j >= toks.length) continue;
      const relaxedFirst = (toks[j].cap || toks[j].allcaps) && inLex(toks[j]) && !(allow && allow.has(toks[j].core.toLowerCase()));
      const wordNotName = LEX.isEnglishWord(toks[j].core) && !inLex(toks[j]); // "WIFE AWARE", "and Nutrition"
      if ((isNameish(toks[j], allow) || relaxedFirst) && !wordNotName && !isCred(toks[j]) && !isRel(toks[j]) && !isHon(toks[j])) {
        const e = nameRun(j, 3, true);
        if (e > j) addRun(j, e, 'NAME_OTHER', 'cue:relation', 0.85);
        continue;
      }
      // a name typed in lower case straight after the relation word, as in messages and OCR'd text:
      // a word of 3+ letters that is a known first name or is not an ordinary English word at all
      const lc = toks[j];
      const nx = toks[j + 1];
      const personCtx = nx && ((nx.word && /^(called|calls|calling|phoned|states|stated|says|said|reports|requests|asked|asks|will|is|was|at|aware|here|arrived|drives|driving|picks|picking|brings|brought|lives|stays|manages|helps|visiting|visited)$/i.test(nx.core)) || /^[,(@]$/.test(nx.raw) || /^\(?\d{3}/.test(text.slice(nx.start, nx.start + 4)));
      // ... and a second lower-case word that is a surname of any tier, not an ordinary word ("spoke w pts son bao nguyen re")
      const lcSecond = nx && nx.word && !used[j + 1] && !lc.nlAfter && /^[a-z][a-z'’\-]{2,}$/.test(nx.core) && (inLex(nx) ? (LEX.isStrongName(nx.core) || !LEX.isEnglishWord(nx.core)) : (LEX.isFirstName(lc.core) && nx.core.length >= 4 && !LEX.isEnglishWord(nx.core) && /[aeiouy]/.test(nx.core) && !FIN_DRUG.test(nx.core) && !NONNAME_END.test(nx.core))) && !COMMON_LOWER.has(nx.core) && !LEX.isClinical(nx.core) && !isRel(nx) && !isCred(nx) && !LEX.LANGUAGE_SET.has(nx.core) && !monthIndex(nx.core) && !(allow && allow.has(nx.core));
      const lcHopOk = hops === 0 || (hops === 1 && toks[i + 1].word && /^(?:is|was|named)$/i.test(toks[i + 1].core) && (lcSecond || LEX.isFirstName(lc.core))); // "wife is ingrid lundqvist"
      if (lcHopOk && lc.word && (/^[a-z][a-z'’\-]{2,}$/.test(lc.core) || (/^\p{Ll}[\p{Ll}\p{M}'’\-]{1,}$/u.test(lc.core) && /[^\x00-\x7F]/.test(lc.core) && personCtx)) && !used[j] && !LEX.isClinical(lc.core) && !isRel(lc) && !isCred(lc) && !(allow && allow.has(lc.core.toLowerCase())) && (LEX.isFirstName(lc.core) || (!LEX.isEnglishWord(lc.core) && (personCtx || lcSecond))) && (!COMMON_LOWER.has(lc.core) || (LEX.isFirstName(lc.core) && personCtx && hops === 0)) && !/^(says|said|states|called|calls|will|would|can|cannot|also|here|there|was|were|has|had|who|that|this|with|from|and|but|not|per|via|aka|dob|mrn|pt|pts|vomited|vomiting|fell|falls|coughing|complains|denies|reports|requests)$/i.test(lc.core)) {
        addRun(j, lcSecond ? j + 2 : j + 1, 'NAME_OTHER', 'cue:relation', 0.6);
      }
    }
    // Pass D: name then relation  (Mark (son); Mark, her son; Grace - daughter)
    for (let i = 0; i < toks.length - 2; i++) {
      if (used[i] || toks[i].initial || endsSentence(toks[i]) || isCred(toks[i])) continue;
      if (!(isNameish(toks[i], allow) || ((toks[i].cap || toks[i].allcaps) && inLex(toks[i]) && !(allow && allow.has(toks[i].core.toLowerCase()))))) continue;
      let j = i + 1, hops = 0;
      while (j < toks.length && hops < 4 && !endsSentence(toks[j]) && /^(,|\(|-|–|—|is|the|her|his|their|pt's|patient's|a|an)$/i.test(toks[j].raw)) { j++; hops++; }
      // "Cordelia's daughter Imogen": a possessive name right before a relation word is the person the relative belongs to
      const possessive = hops === 0 && /['’]s$/.test(toks[i].raw) && !isRel(toks[i]) && !COMMON_CAP.has(toks[i].core.toLowerCase()) && !COMMON_LOWER.has(toks[i].core.toLowerCase()) && !FIELD_WORD.test(toks[i].core) && toks[i].cap;
      if ((hops > 0 || possessive) && j < toks.length && isRel(toks[j])) {
        // "Social Work, Dietitian, Chaplain consulted": a Title-Case relation word after a comma, with a name candidate that is
        // not in the name lexicon, is a department list rather than "Mark, her son"
        if (toks[j].cap && toks[j - 1].raw === ',' && !LEX.isAnchorName(toks[i].core)) continue;
        if (toks[j].cap && j + 1 < toks.length && toks[j + 1].word && SERVICE_VERB.test(toks[j + 1].core) && !LEX.isAnchorName(toks[i].core)) continue; // "Social Work, Chaplain consulted"
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
    const nameWordOk = (t) => t && t.word && (t.cap || t.allcaps) && t.core.length >= 2 && !LEX.isClinical(t.core) && !isRel(t) && !isHon(t) && !isCred(t) && !LEX.GREETING_SET.has(t.core.toLowerCase()) && !LEX.STATE_ABBR_SET.has(t.core) && !LEX.ORG_SUFFIX_SET.has(t.core.toLowerCase()) && !LEX.ORG_NAMEWORD_SET.has(t.core.toLowerCase()) && !(allow && allow.has(t.core.toLowerCase())) && !/^(of|and|the|for|from|to|at|in|on|per|with|re|see|no|yes|ok|pt|pts)$/i.test(t.core) && !FIELD_WORD.test(t.core);
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
      if (COMMON_CAP.has(last.core.toLowerCase()) && !inLex(last)) continue; // "Yesterday, Bertram called": a sentence opener
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
      // "prefers 'AK'", "goes by \"Peggy\"": a quoted alias
      else if (t.word && /^(prefers|preferred|nickname|aka)$/i.test(t.core) && /^['"“‘]$/.test(toks[i + 1].raw)) j = i + 1;
      else if (t.word && /^(preferred|prefers|nickname|alias|aka)$/i.test(t.core) && toks[i + 1].raw === ':' && i + 2 < toks.length && toks[i + 2].word && toks[i + 2].cap) j = i + 2;
      else if (t.word && /^(name)$/i.test(t.core) && i > 0 && /^(preferred|nick|pet)$/i.test(toks[i - 1].core)) j = i + 1;
      if (j < 0 || j >= toks.length) continue;
      let quoted = false;
      if (toks[j].raw === ':' || toks[j].raw === '"' || toks[j].raw === "'" || toks[j].raw === '“' || toks[j].raw === '‘') { quoted = toks[j].raw !== ':'; j++; }
      // a quoted initials-alias ("prefers 'AK'"): two or three capitals inside the quotes
      if (quoted && j < toks.length && !used[j] && toks[j].word && /^[A-Z]{2,3}['’"”]?$/.test(toks[j].raw.replace(/\.$/, '')) && !LEX.CREDENTIAL_SET.has(toks[j].core.replace(/['’]$/, '').toLowerCase())) {
        const v = toks[j].core.replace(/['’]$/, ''); used[j] = true;
        spans.push({ start: toks[j].start, end: toks[j].start + v.length, type: 'NAME_OTHER', source: 'cue:alias', conf: 0.7, text: v, initials: true });
        continue;
      }
      if (j >= toks.length || used[j] || !toks[j].word || !(toks[j].cap || toks[j].allcaps) || LEX.isClinical(toks[j].core) || isRel(toks[j]) || isHon(toks[j]) || (allow && allow.has(toks[j].core.toLowerCase()))) continue;
      // "goes by T.J.": dotted initials are one alias
      let ej = j + 1;
      if (toks[j].initial && toks[j].raw.endsWith('.')) while (ej < toks.length && ej - j < 3 && toks[ej].initial && toks[ej].raw.endsWith('.') && !used[ej] && text.slice(toks[ej - 1].fullEnd, toks[ej].start) === '') ej++;
      if (ej === j + 1 && toks[j].initial) continue;
      addRun(j, ej, 'NAME_OTHER', 'cue:alias', 0.7);
      for (let q = ej; q < Math.min(toks.length - 1, ej + 4); q++) { if (/^["“]$/.test(toks[q].raw) && toks[q + 1].word && toks[q + 1].cap && !used[q + 1] && !LEX.isClinical(toks[q + 1].core) && !wordNotName(toks[q + 1])) { addRun(q + 1, q + 2, 'NAME_OTHER', 'cue:alias', 0.65); break; } }
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
    // a capitalized eponym or device name as the surname after a given name ("Lionel Hickman here for"): a person when a
    // person verb follows it, never when a clinical word does ("Hickman catheter", "Graves disease")
    const eponymSurname = (t, nx) => t && t.word && t.cap && t.core.length >= 4 && LEX.isClinical(t.core) && !LEX.isAmbiguous(t.core) && !COMMON_CAP.has(t.core.toLowerCase()) && !/['’]s$/i.test(t.raw) && !(nx && nx.word && (LEX.EPONYM_FOLLOW.has(nx.core.toLowerCase()) || LEX.isClinical(nx.core) || MED_SUFFIX.test(nx.core)));
    for (let i = 0; i + 1 < toks.length; i++) {
      if (used[i] || used[i + 1]) continue;
      const a = toks[i], b = toks[i + 1];
      // a clinical eponym that is also a given name (Addison, Graves, Wilson) starts a name only after a patient label or
      // an honorific, and never when the next word is clinical ("Pt Addison Graves, 34F" but not "Addison's disease")
      const labelPrev = i > 0 && ((toks[i - 1].word && /^(pt|patient)$/i.test(toks[i - 1].core) && !/['’]s$/.test(toks[i - 1].raw)) || isHon(toks[i - 1]));
      const eponymFirst = labelPrev && a.cap && LEX.isClinical(a.core) && (LEX.isFirstName(a.core) || LEX.isSurname(a.core)) && !LEX.isAmbiguous(a.core) && !/['’]s?$/.test(a.raw) && !(b.word && LEX.EPONYM_FOLLOW.has(b.core.toLowerCase()));
      if (!a.cap || !(pNameOk(a) || eponymFirst) || !b.cap || a.nlAfter || endsSentence(a)) continue;
      let j = i + 1;
      // "Gideon R. Ashcombe-Lyle arrived": a middle initial between the given name and the surname
      if (b.initial && b.raw.endsWith('.') && pNameOk(a) && toks[i + 2] && !used[i + 2] && toks[i + 2].cap && pNameOk(toks[i + 2]) && !a.nlAfter && !b.nlAfter) {
        const nx = toks[i + 3]; const prev0 = i > 0 ? toks[i - 1] : null;
        const lead0 = i === 0 || prev0.nlAfter || endsSentence(prev0) || prev0.raw === ':' || (prev0.word && /^(pt|patient)$/i.test(prev0.core));
        if (lead0 && nx && ((nx.word && !nx.cap && PERSON_VERB_I.test(nx.core)) || /^[,(]$/.test(nx.raw))) { addRun(i, i + 3, 'NAME_OTHER', 'cue:sentence-name', 0.7); i += 2; continue; }
      }
      const epoB = !iNameOk(b, true) && pNameOk(a) && eponymSurname(b, toks[i + 2]) && toks[i + 2] && toks[i + 2].word && !toks[i + 2].cap && PERSON_VERB_I.test(toks[i + 2].core);
      if (!iNameOk(b, true) && !epoB) continue;
      if (wordNotName(a) || wordNotName(b)) continue; // "Pt Doing Fine", "Patient: Feeling Better"; "Grace Bishop" stays a name
      j = i + 2;
      if (j < toks.length && !used[j] && toks[j].cap && pNameOk(toks[j]) && !endsSentence(toks[j - 1]) && !toks[j - 1].nlAfter && !iNameOk(b, false)) continue; // eponym in the middle of a longer run
      if (j < toks.length && !used[j] && toks[j].cap && pNameOk(toks[j]) && !endsSentence(toks[j - 1]) && !toks[j - 1].nlAfter) j++; // middle name
      const prev = i > 0 ? toks[i - 1] : null;
      const lineStart = i === 0 || prev.nlAfter;
      const sentStart = lineStart || endsSentence(prev);
      const ptLabel = prev && prev.word && /^(pt|patient|pt\.)$/i.test(prev.core) && !/['’]s$/.test(prev.raw);
      const colonLabel = prev && (prev.raw === ':' || prev.raw === '-' || prev.raw === '–');
      const nxt = toks[j], nxt2 = toks[j + 1];
      if (!nxt || toks[j - 1].nlAfter) {
        // "Patient: Cordelia Vantongeren" closing its line: a name after a person label with nothing else on the line
        const labelWord = (ptLabel || (colonLabel && i >= 2 && toks[i - 2].word && /^(?:patient|pt|name|proxy|caller|contact|visitor|sender|from|recipient|guardian|re|regarding|subject|member|subscriber|insured|guarantor|caregiver|companion|driver|escort)$/i.test(toks[i - 2].core)));
        // ("Pt Doing Fine", "Patient: Feeling Better" are a status, not a name)
        const plainEnd = toks.slice(i, j).some((t) => !inLex(t) && (NONNAME_END.test(t.core) || /(?:ed|ing|ly|ment)$/i.test(t.core) || COMMON_LOWER.has(t.core.toLowerCase())));
        if (labelWord && pNameOk(a) && iNameOk(b, false) && !plainEnd) { addRun(i, j, 'NAME_OTHER', 'cue:sentence-name', 0.7); i = j - 1; }
        continue;
      }
      const verbAfter = nxt.word && !nxt.cap && !nxt.allcaps && PERSON_VERB_I.test(nxt.core) && !toks[j - 1].nlAfter;
      const punctAfter = (nxt.raw === ',' || nxt.raw === '(' || (ptLabel && nxt.raw === ':') || ((lineStart || sentStart || ptLabel) && /^[-–—|:]$/.test(nxt.raw))) && !toks[j - 1].nlAfter;
      const contactAfter = nxt.raw === ':' && lineStart && toks.slice(j + 1, j + 5).some((t) => (t.word && /^(home|cell|work|mobile|phone|ph|tel|fax|email|text|c|h|w)$/i.test(t.core)) || (t.num && /^\(?\d{3}/.test(text.slice(t.start, t.start + 4))));
      const lexHit = inLex(a) || inLex(b) || (j > i + 2 && inLex(toks[j - 1]));
      let ok = false;
      const plainWords = toks.slice(i, j).some((t) => NONNAME_END.test(t.core) && !inLex(t));
      if ((ptLabel || colonLabel || sentStart) && verbAfter && (lexHit || ptLabel || ((colonLabel || (a.core.length >= 3 && b.core.length >= 3)) && !plainWords))) ok = true;
      else if ((ptLabel || colonLabel) && punctAfter && (ptLabel || !plainWords)) ok = true;
      else if (lineStart && punctAfter && !plainWords && (lexHit || (!LEX.isEnglishWord(a.core) && !LEX.isEnglishWord(b.core))) && !wordNotName(a) && !wordNotName(b)) ok = true; // "Ananya Krishnamurthy - Benlysta monthly"
      else if (lineStart && (/^\s*C\d{1,2}D\d{1,2}\b/i.test(text.slice(toks[j - 1].end)) || (nxt.word && nxt.cap && LEX.isClinical(nxt.core) && !LEX.isSurname(nxt.core))) && !plainWords && (lexHit || (!LEX.isEnglishWord(a.core) && !LEX.isEnglishWord(b.core))) && !wordNotName(a) && !wordNotName(b)) ok = true; // "Ifeoma Nwachukwu C6D1 FOLFOX"
      // "Pt Rasmus Lindqvist uploaded ...": after a patient label two capitalized non-clinical words followed by a lower-case
      // word are the patient's name whatever the verb ("Pt Arrived Ambulatory" excepted by the word endings)
      else if (ptLabel && nxt.word && !nxt.cap && !nxt.allcaps && (PERSON_VERB_I.test(nxt.core) || /(?:ed|ing|es|s)$/.test(nxt.core)) && !COMMON_LOWER.has(nxt.core.toLowerCase()) && !toks[j - 1].nlAfter && !plainWords && pNameOk(a) && pNameOk(b) && !toks.slice(i, j).some((t) => /(?:ed|ing|ly|ment)$/i.test(t.core) && !inLex(t))) ok = true;
      else if (contactAfter) ok = true;
      if (!ok) continue;
      addRun(i, j, 'NAME_OTHER', 'cue:sentence-name', 0.7);
      i = j - 1;
    }
    // Pass I2: a given name and a double-barrelled surname ("Met with Oluwaseun Adebayo-Okonkwo", "Pt Rasmus Eklund-Moreau weight",
    // a tile line "Solveig Lindgren-Mbeki"). Two capitalized halves joined by a hyphen, neither clinical nor an ordinary word, after
    // a given name are a person; eponym pairs (Reed-Sternberg, Stevens-Johnson) have a clinical half or a disease word after them.
    const HYPH_NAME = /^\p{Lu}[\p{Ll}\p{M}'’]+(?:-\p{Lu}[\p{Ll}\p{M}'’]+)+$/u;
    const hyphHalfOk = (h) => h.length >= 2 && !LEX.isClinical(h) && !COMMON_CAP.has(h.toLowerCase()) && !COMMON_LOWER.has(h.toLowerCase()) && !FIELD_WORD.test(h) && !LEX.ORG_SUFFIX_SET.has(h.toLowerCase()) && !LEX.ORG_NAMEWORD_SET.has(h.toLowerCase()) && !/^(?:pre|post|non|anti|self|mid|semi|multi|sub|over|under|follow|check|walk|drop|pick|sign|log|set|up|ex|re|co|on|off|in|out|day|night|well|half|full|part|step|cross|in-law)$/i.test(h);
    for (let i = 0; i + 1 < toks.length; i++) {
      if (used[i] || used[i + 1]) continue;
      const a = toks[i], b = toks[i + 1];
      if (!a.cap || !pNameOk(a) || a.nlAfter || endsSentence(a) || !b.word || !HYPH_NAME.test(b.core)) continue;
      if (!b.core.split('-').every(hyphHalfOk) || NONNAME_END.test(a.core) && !inLex(a)) continue;
      const nx = toks[i + 2];
      if (nx && nx.word && (LEX.EPONYM_FOLLOW.has(nx.core.toLowerCase()) || MED_SUFFIX.test(nx.core) || LEX.ORG_SUFFIX_SET.has(nx.core.toLowerCase()))) continue;
      if (nx && nx.word && nx.cap && !b.nlAfter && !endsSentence(b)) continue; // part of a longer capitalized run (a title or a facility)
      addRun(i, i + 2, 'NAME_OTHER', 'cue:double-surname', 0.7);
      i++;
    }
    // Pass GR: a greeting opens a message and the capitalised name after it is the writer introducing themself or the person
    // addressed ("Hello, Youssef Haddad here.", "Bonjour, Ghislaine Lefebvre.", "Hi, this is Fritznel Desrosiers", "Hi Wanjiru,").
    // A greeting is never a surname, so "Hello, X" is not read as "Last, First".
    for (let i = 0; i + 1 < toks.length; i++) {
      const g = toks[i];
      if (!g.word || !/^(?:hi|hello|hey|hiya|howdy|greetings|dear|bonjour|bonsoir|salut|hola|ciao|hallo|namaste|salaam|shalom|aloha)$/i.test(g.core)) continue;
      if (!(i === 0 || toks[i - 1].nlAfter || endsSentence(toks[i - 1]) || /^[.!?:;(\-–—]$/.test(toks[i - 1].raw))) continue;
      let j = i + 1;
      if (j < toks.length && /^[,!:\-–—]$/.test(toks[j].raw) && !g.nlAfter) j++;
      // "Hi, this is ...", "Hello, it's ...", "Hi, my name is ...", "Hello, I am ..."
      const intro = (q) => {
        if (q >= toks.length || !toks[q].word) return q;
        const w0 = toks[q].core.toLowerCase(), w1 = toks[q + 1] && toks[q + 1].word ? toks[q + 1].core.toLowerCase() : '', w2 = toks[q + 2] && toks[q + 2].word ? toks[q + 2].core.toLowerCase() : '';
        if (/^(?:it's|it’s|its|i'm|i’m|im)$/.test(w0)) return q + 1;
        if ((w0 === 'this' || w0 === 'it' || w0 === 'i') && /^(?:is|am)$/.test(w1)) return q + 2;
        if (w0 === 'my' && w1 === 'name' && w2 === 'is') return q + 3;
        return q;
      };
      const j0 = j; j = intro(j);
      if (j >= toks.length || used[j] || (j0 !== j && toks[j - 1].nlAfter)) continue;
      const okTok = (t) => t && t.word && (t.cap || t.allcaps) && !t.initial && pNameOkLate(t) && !FIELD_WORD.test(t.core) && !LEX.LANGUAGE_SET.has(t.core.toLowerCase()) && !monthIndex(t.core) && !LEX.CITY_SET.has(t.core.toLowerCase()) && !LEX.STATE_NAME_SET.has(t.core.toLowerCase());
      if (!okTok(toks[j])) continue;
      let e = j + 1;
      while (e < toks.length && e - j < 3 && !used[e] && okTok(toks[e]) && !endsSentence(toks[e - 1]) && !toks[e - 1].nlAfter) e++;
      const run = toks.slice(j, e);
      if (run.some((t) => wordNotName(t) && !inLex(t))) continue; // "Hi, Everyone", "Hello, Team Members"
      if (run.length === 1 && LEX.isEnglishWord(run[0].core) && !inLex(run[0])) continue;
      const nx = toks[e];
      const closes = !nx || toks[e - 1].nlAfter || endsSentence(toks[e - 1]) || /^[.,!?;:()\-–—]$/.test(nx.raw) || (nx.word && /^(?:here|calling|writing|again|from|checking|following|reaching|returning|regarding|re|about|with|and)$/i.test(nx.core));
      if (!closes) continue;
      addRun(j, e, 'NAME_OTHER', 'cue:greeting', 0.7);
      i = e - 1;
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
      while (j < toks.length && j - i < 3 && !used[j] && isNameish(toks[j], allow) && !LEX.ORG_SUFFIX_SET.has(toks[j].core.toLowerCase()) && !endsSentence(toks[j - 1]) && !(toks[j].allcaps && toks[j].core.length <= 4 && !LEX.isStrongName(toks[j].core)) && (inLex(toks[j]) || toks[j].initial || (toks[j].cap && !LEX.isAmbiguous(toks[j].core) && (j === i + 1 || (j === i + 2 && toks[j - 1].initial)) && !t.allcaps))) j++;
      // a first name followed by a surname that is also a clinical eponym ("Rosalind Graves (MRN ...)", "Simone Addison, hx"),
      // when nothing clinical follows the eponym (Graves disease, Addison's)
      if (j === i + 1 && (LEX.isFirstName(t.core) || LEX.isAnchorName(t.core)) && !LEX.isAmbiguous(t.core) && !endsSentence(t) && !t.nlAfter && j < toks.length && !used[j] && toks[j].cap && LEX.isClinical(toks[j].core) && (LEX.isSurname(toks[j].core) || LEX.isFirstName(toks[j].core)) && !LEX.isAmbiguous(toks[j].core) && !/['’]s?$/.test(toks[j].raw) && !(j + 1 < toks.length && toks[j + 1].word && (LEX.EPONYM_FOLLOW.has(toks[j + 1].core.toLowerCase()) || LEX.isClinical(toks[j + 1].core)))) j++;
      const run = toks.slice(i, j);
      const unambiguousCount = run.filter((x) => inLex(x) && !LEX.isAmbiguous(x.core)).length;
      const anchorCount = run.filter((x) => LEX.isAnchorName(x.core)).length;
      const lexNonWord = run.filter((x) => inLex(x) && !LEX.isEnglishWord(x.core) && !LEX.isAmbiguous(x.core)).length;
      // "Lee Silverman voice treatment", "Glasgow Coma scale": a name-like run followed by a program/eponym word is clinical
      if (j < toks.length && toks[j].word && LEX.EPONYM_FOLLOW.has(toks[j].core.toLowerCase())) continue;
      // a single token stands alone only if it is an anchor (curated clear, or Census/SSA-strong and not an English word);
      // a rare surname or list-only first name needs company: another name token, or a cue (passes C, E2-E4)
      if (run.length === 1) { if (!amb && LEX.isAnchorName(t.core)) { addRun(i, j, 'NAME_OTHER', 'lexicon', 0.7); } continue; }
      // a run of two or more: needs an anchor, or two lexicon tokens that are not ordinary words ("Sabine Oduya" is handled by cues)
      if (!amb && (anchorCount >= 1 || lexNonWord >= 2)) { addRun(i, j, 'NAME_OTHER', 'lexicon', 0.7); i = j - 1; continue; }
      // ambiguous first token ("Rose", "Will"): the second token must be an anchor ("Rose Nakamura", not "Rose Garden")
      if (amb && run.slice(1).some((x) => LEX.isAnchorName(x.core))) { addRun(i, j, 'NAME_OTHER', 'lexicon', 0.6); i = j - 1; }
    }
    // Pass E4: a capitalised pair right after a person cue ("Pt Sabine Oduya", "order for Barnaby Quist",
    // "met w/ Fergus Mallory", "teach completed with Lucian Draper"). At least one token must be a known name
    // of any tier, or neither may be an ordinary English word.
    for (let i = 0; i < toks.length - 2; i++) {
      const t = toks[i];
      const cueWord = t.word && /^(pt|pts|patient|for|with|w|re|regarding|to|by|from|see|saw|seen|met|teach|call|called|notify|notified|order|orders|auth|about|contact|visit|visited|admit|admitted|discharge|discharged|transport|escort)$/i.test(t.core);
      const cueSlash = t.raw === '/' && i >= 1 && /^w$/i.test(toks[i - 1].core);
      if (!cueWord && !cueSlash) continue;
      let j = i + 1;
      if (j < toks.length && toks[j].raw === ':') j++;
      if (j >= toks.length - 1 || used[j] || used[j + 1]) continue;
      const a = toks[j], b = toks[j + 1];
      const nameTok = (x) => x.word && x.cap && !x.initial && x.core.length >= 2 && !LEX.isClinical(x.core) && !LEX.ORG_SUFFIX_SET.has(x.core.toLowerCase()) && !LEX.ORG_NAMEWORD_SET.has(x.core.toLowerCase()) && !isRel(x) && !isHon(x) && !isCred(x) && !LEX.STATE_NAME_SET.has(x.core.toLowerCase()) && !LEX.CITY_SET.has(x.core.toLowerCase()) && !(allow && allow.has(x.core.toLowerCase())) && !/^(Dr|Mr|Mrs|Ms|Pt|Patient|Appt|Appointment|Order|Orders|Infusion|Chemo|Lab|Labs|Rx|Dx|Tx|Hx|Plan|Note|Notes|Ok|OK)$/i.test(x.core);
      const eponymB = b.word && b.cap && LEX.isClinical(b.core) && LEX.isSurname(b.core) && !LEX.isAmbiguous(b.core) && !/['’]s?$/.test(b.raw) && !(j + 2 < toks.length && toks[j + 2].word && (LEX.EPONYM_FOLLOW.has(toks[j + 2].core.toLowerCase()) || LEX.isClinical(toks[j + 2].core)));
      if (!nameTok(a) || !(nameTok(b) || eponymB) || a.nlAfter || endsSentence(a)) continue;
      if (i > 0 && (isHon(toks[i - 1]) || toks[i - 1].cap)) continue; // mid-title ("Infusion For Cancer Care") is not a cue
      const strongA = LEX.isAnchorName(a.core), strongB = LEX.isAnchorName(b.core);
      if (wordNotName(a) || wordNotName(b)) continue; // "Pt Needs Wheelchair", "for Social Work"
      if (!(strongA || strongB) && LEX.isEnglishWord(a.core) && LEX.isEnglishWord(b.core)) continue; // "for Will Power"-style word pairs
      if (b.word && j + 2 < toks.length && toks[j + 2].word && LEX.EPONYM_FOLLOW.has(toks[j + 2].core.toLowerCase())) continue;
      let e = j + 2;
      if (e < toks.length && !used[e] && toks[e].cap && !toks[e].nlAfter && !endsSentence(b) && (inLex(toks[e]) || toks[e].initial) && !LEX.isClinical(toks[e].core) && !isCred(toks[e])) e++;
      addRun(j, e, 'NAME_OTHER', 'cue:person', 0.65);
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
    const placeOk = (t) => t && t.word && t.cap && !used[t.idx] && !LEX.isClinical(t.core) && !COMMON_CAP.has(t.core.toLowerCase()) && !LEX.ORG_SUFFIX_SET.has(t.core.toLowerCase()) && !FIELD_WORD.test(t.core) && !isRel(t) && !isHon(t) && !isCred(t) && !monthIndex(t.core) && !/^(?:epic|mychart|cerner|meditech|athena|teams|zoom|person|writing|spanish|english|french|chinese|arabic|russian|portuguese|vietnamese|korean|general|private|public|network|system|area|town|county)$/i.test(t.core) && !(allow && allow.has(t.core.toLowerCase()));
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
    // Pass L1: a town in brackets after a facility or a home ("St. Brennan Regional (Dunmore)", "home (Kettleby)")
    const orgEnds = new Set(spans.filter((x) => x.type === 'ORG').map((x) => x.end));
    for (let i = 1; i + 2 < toks.length; i++) {
      if (toks[i].raw !== '(') continue;
      const p = toks[i - 1];
      if (!(orgEnds.has(p.end) || (p.word && /^(?:home|house|residence|apartment|apt|shelter|SNF|ALF|facility|hospital|regional|medical|center|centre|clinic|nursing|rehab|hospice|manor|village)$/i.test(p.core)))) continue;
      let e = i + 1; while (e < toks.length && e - i <= 3 && placeOk(toks[e])) e++;
      if (e === i + 1 || !toks[e] || toks[e].raw !== ')') continue;
      if (toks.slice(i + 1, e).some((x) => LEX.isFirstName(x.core) && !LEX.CITY_SET.has(x.core.toLowerCase()))) continue; // "home (Maria)": a person
      addRun(i + 1, e, 'LOCATION', 'cue:place', 0.6); i = e;
    }
    // Pass L2: a town after a residence or travel verb ("lives alone in Coldbrook;", "drives in from Tillinghast", "moved
    // here from Ostrava with her son"): one or two capitalized words closing the phrase
    for (let i = 0; i + 2 < toks.length; i++) {
      const t = toks[i];
      if (!t.word || !/^(?:lives?|living|lived|resides?|residing|resided|moved|moving|relocated|relocating|staying|stays|stayed|drives?|drove|driving|comes|coming|came|travels?|traveled|travelled|traveling|travelling|commutes?|commuting|flies|flew|flying|visiting|visits?|visited|returned|returning|originally|born|raised|grew)$/i.test(t.core)) continue;
      let q = i + 1;
      while (q < toks.length && q - i <= 4 && toks[q].word && /^(?:alone|up|down|over|back|here|out|all|the|way|now|currently|still|together|with|her|his|their|family|husband|wife|son|daughter|mother|father|parents|in|on)$/i.test(toks[q].core) && !(toks[q].core.toLowerCase() === 'in' && toks[q + 1] && toks[q + 1].cap)) q++;
      if (q >= toks.length || !toks[q].word || !/^(?:in|from|near|outside|to)$/i.test(toks[q].core) || toks[q].nlAfter) continue;
      let e = q + 1; while (e < toks.length && e - q <= 2 && placeOk(toks[e]) && !(e > q + 1 && (endsSentence(toks[e - 1]) || toks[e - 1].nlAfter))) e++;
      if (e === q + 1) continue;
      const nx = toks[e];
      if (!(closes(e) || toks[e - 1].nlAfter || (nx && nx.word && !nx.cap && !nx.allcaps))) continue;
      if (toks.slice(q + 1, e).some((x) => inLex(x) && !LEX.CITY_SET.has(x.core.toLowerCase()) && /^to$/i.test(toks[q].core))) continue; // "drives to Karen's"
      const placeTxt = toks.slice(q + 1, e).map((x) => x.core).join(' ').toLowerCase();
      if (LEX.STATE_NAME_SET.has(placeTxt) || LEX.STATE_NAME_SET.has(toks[q + 1].core.toLowerCase()) || LEX.CITY_SET.has(toks[q + 1].core.toLowerCase()) || LEX.PLACE_PREFIX_SET.has(toks[q + 1].core.toLowerCase())) continue; // known places: the city/state passes
      addRun(q + 1, e, 'LOCATION', 'cue:place', 0.6); i = e - 1;
    }
    // Pass W: a message or note typed all in lower case ("hi its beverly szymanski again", "husband rufus at bedside",
    // "thanks, bev"): with no capitals to go by, a word right after a relation word, a self-introduction or a sign-off that
    // is not an ordinary word is a name, and a second such word is the surname
    const wordToks = toks.filter((t) => t.word && t.core.length >= 2);
    const capCount = wordToks.filter((t) => /^\p{Lu}/u.test(t.core)).length;
    if (wordToks.length >= 4 && capCount / wordToks.length <= 0.2) {
      const lowerOk = (t) => t && t.word && t.core === t.core.toLowerCase() && /^[a-z][a-z'’\-]{2,}$/.test(t.core) && !COMMON_LOWER.has(t.core) && !COMMON_CAP.has(t.core) && !LEX.isClinical(t.core) && !relWord(t.core) && !monthIndex(t.core) && !LEX.CREDENTIAL_SET.has(t.core) && !(allow && allow.has(t.core)) && (LEX.isFirstName(t.core) || LEX.isSurname(t.core) || (!NONNAME_END.test(t.core) && !/(?:ing|ed|ly|ment|ies|est|ful|ic|al|ent|ant|ive|ous|less|ble|ward|wise|like|ish|ese|ian|ist|ity|ery|ory|ary)$/.test(t.core)));
      for (let i = 0; i < toks.length; i++) {
        const t = toks[i]; if (!t.word) continue;
        let j = -1, signoff = false;
        if (relWord(t.core) && t.core === t.core.toLowerCase() && !endsSentence(t)) j = i + 1;
        else if (/^(?:its|it's|it’s|im|i'm|i’m)$/i.test(t.core) || (/^is$/i.test(t.core) && i > 0 && /^(?:this|name)$/i.test(toks[i - 1].core))) {
          // "its sore", "im due": a self-introduction only with a known given name, a greeting before it, or a two-word name
          const c1 = toks[i + 1], c2 = toks[i + 2];
          const greet = i > 0 && /^(?:hi|hey|hello|hiya|morning)$/i.test(toks[i - 1].core) || (i > 1 && /^is$/i.test(t.core) && i > 1 && /^(?:hi|hey|hello)$/i.test(toks[i - 2].core));
          if (lowerOk(c1) && (LEX.isFirstName(c1.core) || greet || /^is$/i.test(t.core) || (lowerOk(c2) && LEX.isSurname(c2.core)))) j = i + 1;
        }
        else if (/^(?:thanks|thx|ty|love|regards|cheers|best|sincerely)$/i.test(t.core) && toks[i + 1] && toks[i + 1].raw === ',') { j = i + 2; signoff = true; }
        else if (/^you$/i.test(t.core) && i > 0 && /^thank$/i.test(toks[i - 1].core) && toks[i + 1] && toks[i + 1].raw === ',') { j = i + 2; signoff = true; }
        // "my oncologist dr. fennimore": an honorific before a lower-case word
        else if (isHon(t) && !t.nlAfter && !/^(?:sister|brother|father|mother|nurse)$/i.test(t.core)) j = i + 1;
        if (j < 0 || j >= toks.length || used[j] || !lowerOk(toks[j]) || toks[j - 1].nlAfter && !signoff) continue;
        // an ordinary word that is no given name, followed by a function word, is the verb of the sentence ("mom fell at home",
        // "son drove to the clinic"), not a name
        if (LEX.isEnglishWord(toks[j].core) && !LEX.isFirstName(toks[j].core) && toks[j + 1] && toks[j + 1].word && COMMON_LOWER.has(toks[j + 1].core.toLowerCase())) continue;
        let e = j + 1;
        if (e < toks.length && !used[e] && !toks[j].nlAfter && lowerOk(toks[e]) && !signoff) e++;
        // a surname built with particles: "mac giolla phadraig", "van der berg", "de la cruz"
        for (let ext = 0; !signoff && e < toks.length && ext < 3 && !used[e] && !toks[e - 1].nlAfter && (NAME_PARTICLE.test(toks[e - 1].core) || /^(?:giolla|ui|nic|ni)$/i.test(toks[e - 1].core)) && (lowerOk(toks[e]) || (NAME_PARTICLE.test(toks[e].core) && lowerOk(toks[e + 1]))); ext++) e++;
        if (signoff && !(e >= toks.length || toks[e - 1].nlAfter || /^[.!]$/.test(toks[e].raw))) continue;
        addRun(j, e, 'NAME_OTHER', 'cue:lowercase', 0.6); i = e - 1;
      }
    }
    // Pass F5: "Pt Zbigniew", "patient Oluwaseun": a label and a single capitalised first name of any tier
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i], n = toks[i + 1];
      if (!(t.word && /^(pt|patient)$/i.test(t.core)) || /['’]s$/.test(t.raw) || used[i + 1]) continue;
      if (!n.word || !n.cap || n.initial || LEX.isClinical(n.core) || isRel(n) || isHon(n) || isCred(n) || (allow && allow.has(n.core.toLowerCase()))) continue;
      if (!LEX.isFirstName(n.core) || LEX.isAmbiguous(n.core) || LEX.isEnglishWord(n.core)) continue;
      if (i + 2 < toks.length && toks[i + 2].word && toks[i + 2].cap && !isCred(toks[i + 2])) continue; // a pair is handled elsewhere
      addRun(i + 1, i + 2, 'NAME_OTHER', 'cue:label', 0.6);
    }
    // Pass F5b: the person a fax or letter is addressed to ("attn Gwen 555-0196", "Attention: Dana Whitlock"): a given name of
    // any tier, with the surname when one follows; departments ("attn Billing", "attn Medical Records") stay
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i];
      if (!t.word || !/^(?:attn|attention)$/i.test(t.core) || t.nlAfter) continue;
      let j = i + 1; if (toks[j] && /^[:\-]$/.test(toks[j].raw)) j++;
      const n = toks[j];
      if (!n || used[j] || !n.word || !(n.cap || n.allcaps) || n.initial || isHon(n) || isRel(n) || isCred(n) || LEX.isClinical(n.core) || COMMON_CAP.has(n.core.toLowerCase()) || FIELD_WORD.test(n.core) || LEX.ORG_SUFFIX_SET.has(n.core.toLowerCase()) || LEX.ORG_NAMEWORD_SET.has(n.core.toLowerCase()) || (allow && allow.has(n.core.toLowerCase()))) continue;
      if (!LEX.isFirstName(n.core) && !(LEX.isSurname(n.core) && !LEX.isEnglishWord(n.core))) continue;
      let e = j + 1;
      if (toks[e] && !used[e] && toks[e].word && (toks[e].cap || toks[e].allcaps) && pNameOkLate(toks[e]) && !wordNotName(toks[e]) && !n.nlAfter && !endsSentence(n)) e++;
      addRun(j, e, 'NAME_OTHER', 'cue:attention', 0.65);
      i = e - 1;
    }
    // Pass F5c: a month that is also a given name, where a month cannot be the subject: at a sentence start or after a patient
    // label, right before a person verb ("April called back", "Pt June declined labs"); "May call" and "in June" stay
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i], nx = toks[i + 1];
      if (used[i] || !t.word || !t.cap || t.core.length < 4 || !monthIndex(t.core) || !LEX.isFirstName(t.core) || /['’]s$/.test(t.raw) || t.nlAfter) continue;
      const prev = i > 0 ? toks[i - 1] : null;
      if (!(!prev || prev.nlAfter || endsSentence(prev) || (prev.word && /^(?:pt|patient)$/i.test(prev.core)) || isRel(prev) || isHon(prev))) continue;
      if (!nx.word || nx.cap || !/^(?:called|calls|phoned|texted|emailed|states|stated|says|said|reports|reported|tolerated|tolerating|declined|declines|denies|denied|asked|asks|wants|wanted|prefers|arrived|agrees|agreed|verbalized|requests|requested|returned|cancelled|canceled|rescheduled|refused|refuses)$/i.test(nx.core)) continue;
      addRun(i, i + 1, 'NAME_OTHER', 'cue:month-name', 0.6);
    }
    // Pass G0: places from movement and facility cues ("Mercy Hospital in Carbondale", "moving to Decatur",
    // "drove in from Chardon"), and "Town 44052" (a town right before its ZIP)
    for (let i = -1; i + 1 < toks.length; i++) {
      const t = i >= 0 ? toks[i] : { word: true, core: '', raw: '', nlAfter: true }, n = toks[i + 1];
      const zipAhead = i + 2 < toks.length && toks[i + 2].num && /^\d{5}$/.test(toks[i + 2].raw);
      if (i >= 0 && !t.word && !t.nlAfter && !(zipAhead && /^[,;]$/.test(t.raw))) continue;
      if (used[i + 1] || !n.word || !(n.cap || n.allcaps) || n.initial) continue;
      if (i >= 0 && !t.nlAfter && !/^(to|from|in|near|outside)$/i.test(t.core) && !zipAhead) continue;
      const prev = i > 0 ? toks[i - 1] : null;
      const facilityCue = prev && prev.word && /^(hospital|hosp|clinic|center|centre|ctr|office|practice|pharmacy|institute|inst|group|associates|lab|labs|oncology|hematology|imaging|radiology|dialysis|hospice|rehab|surgery|plant|factory)$/i.test(prev.core) && /^(in|at|near|outside)$/i.test(t.core);
      if (LEX.isClinical(n.core) || (LEX.isEnglishWord(n.core) && !facilityCue && !(LEX.isSurname(n.core) && !LEX.isFirstName(n.core))) || (LEX.isAnchorName(n.core) && !facilityCue) || isRel(n) || isHon(n) || isCred(n) || COMMON_CAP.has(n.core.toLowerCase()) || LEX.ORG_SUFFIX_SET.has(n.core.toLowerCase()) || (allow && allow.has(n.core.toLowerCase()))) continue;
      const movement = i >= 0 && /^(to|from|in|near|outside)$/i.test(t.core) && prev && prev.word && /^(moving|moved|relocating|relocated|relocate|lives|living|live|travel(?:l)?ing|drove|driving|drive|coming|flew|flying|commutes|commuting|commute|traffic|ride|rides|bus|train|flight|resides|residing|staying|stays|wintering|summering|hospital|hosp|clinic|center|centre|ctr|office|practice|pharmacy|home|plant|factory|works|working|job|institute|inst|group|associates|urgent|er|ed|lab|labs|oncology|hematology|imaging|radiology|dialysis|hospice|rehab|surgery)$/i.test(prev.core);
      const nextIsZip = n.cap && !n.allcaps && i + 2 < toks.length && toks[i + 2].num && /^\d{5}$/.test(toks[i + 2].raw) && (i < 0 || t.nlAfter || !/^(mrn|#|id|acct|rm|room|ext|ndc|lot|ref|rx|order|claim|auth)$/i.test(t.core)) && !/^\d{5}-\d/.test(text.slice(toks[i + 2].start, toks[i + 2].start + 7));
      if (!movement && !nextIsZip) continue;
      let e = i + 2; if (nextIsZip) e = i + 3;
      // two-word town (Cedar Falls) before the ZIP
      if (nextIsZip && i + 2 < toks.length && toks[i + 2].word && toks[i + 2].cap && !LEX.isEnglishWord(toks[i + 2].core) && i + 3 < toks.length && /^\d{5}$/.test(toks[i + 3].raw || '')) e = i + 4;
      for (let q = i + 1; q < e; q++) used[q] = true;
      spans.push({ start: n.start, end: toks[e - 1].end, type: 'LOCATION', source: 'cue:place', conf: 0.55, text: text.slice(n.start, toks[e - 1].end) });
      i = e - 1;
    }
    // Pass F6: names typed in lower case after a person cue ("pt lakshmi venkatesan", "called nguyen thi bich ngoc")
    for (let i = 0; i + 2 < toks.length; i++) {
      const t = toks[i];
      if (!(t.word && /^(pt|patient|called|call|phoned|spoke|re|w|with|for)$/i.test(t.core)) || /['’]s$/.test(t.raw)) continue;
      let j = i + 1; if (toks[j] && toks[j].raw === '/' && /^w$/i.test(t.core)) j++;
      // "longtime pt, rosario villanueva," : a comma after a patient label
      const commaCue = !!(toks[j] && toks[j].raw === ',' && /^(pt|patient)$/i.test(t.core) && !t.nlAfter);
      if (commaCue) j++;
      if (toks[j] && toks[j].word && /^(is|was|named|name|are)$/i.test(toks[j].core) && /^(pt|patient)$/i.test(t.core)) j++;
      let e = j;
      const lcName = (x) => x.word && /^[a-z][a-z'’\-]{2,}$/.test(x.core) && (!LEX.isEnglishWord(x.core) || (LEX.isStrongName(x.core) && LEX.isFirstName(x.core))) && !LEX.isClinical(x.core) && !isRel(x) && !isCred(x) && !/^(re|pt|pts|mrn|dob|tx|dx|hx|prn|bid|tid|qd|iv|po|sq|im|mg|mcg|ml|kg|lbs|yo|yrs|wk|wks|mo|mos)$/i.test(x.core) && !(allow && allow.has(x.core.toLowerCase()));
      const particle = (x) => x.word && /^(de|del|dela|la|las|los|van|von|der|den|di|da|du|bin|ibn|al|el|y|e|san|st|mc|mac|o)$/i.test(x.core);
      while (e < toks.length && e - j < 6 && !used[e] && (lcName(toks[e]) || (e > j && particle(toks[e]) && toks[e + 1] && (lcName(toks[e + 1]) || particle(toks[e + 1])))) && !(e > j && endsSentence(toks[e - 1]))) e++;
      while (e > j && particle(toks[e - 1])) e--;
      // "pt augustin, yolene 90yo": a lower-case "last, first" right after the label
      if (e - j === 1 && /^(pt|patient)$/i.test(t.core) && toks[e] && toks[e].raw === ',' && !toks[e - 1].nlAfter && toks[e + 1] && !used[e + 1] && lcName(toks[e + 1]) && (inLex(toks[j]) || inLex(toks[e + 1]))) {
        const nx = toks[e + 2];
        if (!nx || !(nx.word && lcName(nx)) || nx.nlAfter) { addRun(j, j + 1, 'NAME_OTHER', 'cue:lowercase', 0.55); addRun(e + 1, e + 2, 'NAME_OTHER', 'cue:lowercase', 0.55); i = e + 1; continue; }
      }
      if (e - j < 2) continue;
      if (!toks.slice(j, e).some((x) => LEX.isFirstName(x.core) || LEX.isSurname(x.core)) && e - j < 3) continue; // two unknown lower-case words need a third, or a name hit
      if (commaCue && !toks.slice(j, e).some((x) => inLex(x) && (LEX.isStrongName(x.core) || !LEX.isEnglishWord(x.core)))) continue;
      addRun(j, e, 'NAME_OTHER', 'cue:lowercase', 0.55);
      i = e - 1;
    }
    // Pass F6b: a lower-case name stated to be the patient ("marjorie is the pt", "rosario villanueva is the patient")
    for (let i = 0; i + 3 < toks.length; i++) {
      if (!toks[i].word || !/^(?:is|was)$/i.test(toks[i].core) || toks[i + 1].core.toLowerCase() !== 'the' || !/^(?:pt|patient)$/i.test(toks[i + 2].core) || /['’]s$/.test(toks[i + 2].raw)) continue;
      const lcTok = (x) => x && x.word && !x.nlAfter && /^[a-z][a-z'’\-]{2,}$/.test(x.core) && inLex(x) && (LEX.isStrongName(x.core) || !LEX.isEnglishWord(x.core)) && !COMMON_LOWER.has(x.core) && !LEX.isClinical(x.core) && !isRel(x) && !isCred(x) && !monthIndex(x.core) && !(allow && allow.has(x.core));
      let k = i; while (k > 0 && i - k < 3 && !used[k - 1] && lcTok(toks[k - 1])) k--;
      if (k < i) addRun(k, i, 'NAME_OTHER', 'cue:lowercase', 0.55);
    }
    // Pass F6c: one given name typed in lower case in a person slot, with no patient list to check it against ("spoke w/
    // evangelina re: copay", "left vm for evangelina", "per dtr (marguerite)", "evangelina called back"): a strong first name
    // that is not an ordinary word, a clinical word, a month, a relation or a language
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (used[i] || !t.word || !/^[a-z][a-z'’\-]{3,}$/.test(t.core)) continue;
      if (!LEX.isFirstName(t.core) || !LEX.isStrongName(t.core) || LEX.isEnglishWord(t.core) || LEX.isClinical(t.core) || COMMON_LOWER.has(t.core) || COMMON_CAP.has(t.core) || monthIndex(t.core) || relWord(t.core) || LEX.LANGUAGE_SET.has(t.core) || LEX.CREDENTIAL_SET.has(t.core) || (allow && allow.has(t.core))) continue;
      if (!personSlotLoose(text, t.start, t.end)) continue;
      addRun(i, i + 1, 'NAME_OTHER', 'cue:lowercase', 0.6);
    }
    // Pass F8: two word-names at a sentence start followed by a person context ("Rose Bell in chair 4", "Will Hunt reports")
    for (let i = 0; i + 2 < toks.length; i++) {
      const a = toks[i], b = toks[i + 1], nx = toks[i + 2];
      if (used[i] || used[i + 1] || !a.cap || !b.cap || a.nlAfter || endsSentence(a)) continue;
      const ptBefore = i > 0 && toks[i - 1].word && /^(pt|patient)$/i.test(toks[i - 1].core) && !/['’]s$/.test(toks[i - 1].raw);
      if (!(i === 0 || toks[i - 1].nlAfter || endsSentence(toks[i - 1]) || ptBefore)) continue;
      const frequent = (w) => LEX.isStrongName(w) || LEX.isCuratedName(w) || LEX.BIG.S2.has(w.toLowerCase()) || LEX.BIG.F2.has(w.toLowerCase());
      if (!(LEX.isFirstName(a.core) && frequent(a.core) && LEX.isSurname(b.core) && frequent(b.core))) continue;
      if (LEX.isClinical(b.core) && !LEX.isSurname(b.core)) continue;
      const personCtx = (nx.word && !nx.cap && PERSON_VERB_I.test(nx.core)) || (nx.word && /^(in|at|here|for)$/i.test(nx.core) && toks[i + 3] && toks[i + 3].word && /^(chair|bay|room|rm|waiting|lobby|infusion|clinic|cycle|labs?|tx|treatment|for|today|c\d+)$/i.test(toks[i + 3].core)) || nx.raw === ',' || nx.raw === '(' || ptBefore;
      if (!personCtx) continue;
      if (b.word && i + 2 < toks.length && LEX.EPONYM_FOLLOW.has(nx.core.toLowerCase())) continue;
      addRun(i, i + 2, 'NAME_OTHER', 'cue:sentence-pair', 0.6);
      i += 1;
    }
    // Pass G1b: "in Saint-Jérôme", "from San Cristóbal", "to Port-au-Prince": a place-prefixed or hyphenated token after a preposition
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i], n = toks[i + 1];
      if (!t.word || !/^(in|from|to|near|at|outside)$/i.test(t.core) || used[i + 1] || !n.word || !(n.cap || n.allcaps)) continue;
      const placey = /^(?:Saint|St|Ste|San|Santa|Santo|Port|Fort|Ft|Mont|Mount|Mt|Lake|Cape|Bay|East|West|North|South|New)[-\s]/i.test(text.slice(n.start, n.start + 7)) || /^\p{Lu}[\p{Ll}\p{M}]+-\p{Lu}[\p{Ll}\p{M}]+$/u.test(n.core) && /[\u00C0-\u024F]/.test(n.core);
      if (!placey || LEX.isClinical(n.core) || LEX.isFirstName(n.core)) continue;
      let e = i + 2; while (e < toks.length && toks[e].word && toks[e].cap && !LEX.isEnglishWord(toks[e].core) && e - i < 4) e++;
      for (let q = i + 1; q < e; q++) used[q] = true;
      spans.push({ start: n.start, end: toks[e - 1].end, type: 'LOCATION', source: 'cue:place', conf: 0.55, text: text.slice(n.start, toks[e - 1].end) });
    }
    // Pass G1c: "from <Place>" with no known name in it
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i], n = toks[i + 1];
      if (!t.word || !/^from$/i.test(t.core) || used[i + 1] || !n.word || !n.cap || n.initial) continue;
      if (LEX.isClinical(n.core) || LEX.isEnglishWord(n.core) || LEX.isFirstName(n.core) || LEX.isAnchorName(n.core) || isRel(n) || isHon(n) || isCred(n) || LEX.ORG_SUFFIX_SET.has(n.core.toLowerCase()) || LEX.ORG_NAMEWORD_SET.has(n.core.toLowerCase()) || COMMON_CAP.has(n.core.toLowerCase()) || (allow && allow.has(n.core.toLowerCase()))) continue;
      const nx = toks[i + 2];
      const terminated = endsSentence(n) || /[.;,]$/.test(n.raw); // "from Dorchester. Lives at" (the period rides on the token)
      if (!terminated) {
        if (nx && nx.word && nx.cap && !LEX.ORG_SUFFIX_SET.has(nx.core.toLowerCase())) continue;
        if (!(!nx || /^[,.;)]$/.test(nx.raw) || (nx.word && !nx.cap) || nx.num)) continue;
      }
      used[i + 1] = true;
      spans.push({ start: n.start, end: n.end, type: 'LOCATION', source: 'cue:place', conf: 0.5, text: n.core });
    }
    // Pass E5: a first name right before a phone number ("niece Rosalba 555-0109" when OCR dropped the relation word)
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i];
      if (used[i] || !t.word || !t.cap || !LEX.isFirstName(t.core) || LEX.isAmbiguous(t.core) || LEX.isEnglishWord(t.core) || LEX.isClinical(t.core)) continue;
      if (!/^\s*(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3,4}[-.\s]?\d{0,4}\b/.test(text.slice(t.end, t.end + 18))) continue;
      addRun(i, i + 1, 'NAME_OTHER', 'cue:phone', 0.6);
    }
    // Pass H0: a detected name followed directly by a capitalised double-barrelled surname takes it ("pt Amadou Diallo-Barry")
    for (const sp of spans.filter((x) => COARSE(x.type) === 'NAME')) {
      const ti = tokStarting(sp.end + 1) >= 0 ? tokStarting(sp.end + 1) : tokStarting(sp.end + 2);
      if (ti < 0 || used[ti]) continue;
      const n = toks[ti];
      if (!n.word || !/^\p{Lu}[\p{Ll}\p{M}]+-\p{Lu}[\p{Ll}\p{M}]+$/u.test(n.core) || !/^\s+$/.test(text.slice(sp.end, n.start))) continue;
      const halves = n.core.split('-');
      if (halves.some((h) => LEX.isClinical(h) || LEX.ORG_SUFFIX_SET.has(h.toLowerCase()) || (LEX.isEnglishWord(h) && !LEX.isSurname(h)))) continue;
      if (ti + 1 < toks.length && toks[ti + 1].word && LEX.EPONYM_FOLLOW.has(toks[ti + 1].core.toLowerCase())) continue;
      sp.end = n.end; sp.text = text.slice(sp.start, sp.end); used[ti] = true;
    }
    // Pass FN: names inside a file name or a handle, split at underscores, dots and hyphens ("whitcombe_harriet_pathology.pdf",
    // "Okafor.Chidi.CT.2026.png", "scan-nakashima-r"): a part that is a first name next to a part that is a surname is a
    // person, and an anchor surname alone counts in a file name. Each name part is its own span, so the replacement keeps
    // the separators and the rest of the file name.
    {
      const FILE_WORD = /^(?:pdf|docx?|xlsx?|csv|txt|png|jpe?g|gif|tiff?|bmp|heic|html?|zip|rtf|msg|eml|dcm|scan|scans|img|image|images|report|reports|path|pathology|rad|radiology|lab|labs|result|results|note|notes|letter|records?|chart|copy|final|draft|signed|fax|outside|ct|mri|pet|xray|cxr|ekg|ecg|echo|consent|form|forms|order|orders|referral|summary|discharge|op|dc|v\d+)$/i;
      const re = /(?<![A-Za-z0-9@._\-\/])[A-Za-z][A-Za-z0-9]*(?:[._\-][A-Za-z0-9]+)+(?![A-Za-z0-9@_]|[.\-][A-Za-z0-9])/g; let cm;
      while ((cm = re.exec(text))) {
        const whole = cm[0];
        if (!/[._]/.test(whole) || /^(?:https?|www)\b/i.test(whole)) continue;
        const parts = []; const pr = /[A-Za-z]+/g; let pm;
        while ((pm = pr.exec(whole))) parts.push({ w: pm[0], start: cm.index + pm.index });
        const fileLike = /\.[A-Za-z]{2,4}$/.test(whole) && FILE_WORD.test(whole.split('.').pop()) || /\d/.test(whole);
        const nameOk = (w) => w.length >= 3 && !FILE_WORD.test(w) && !LEX.isClinical(w) && !COMMON_LOWER.has(w.toLowerCase()) && !COMMON_CAP.has(w.toLowerCase()) && !monthIndex(w) && !(allow && allow.has(w.toLowerCase())) && (LEX.isFirstName(w) || LEX.isSurname(w)) && (LEX.isStrongName(w) || !LEX.isEnglishWord(w));
        const firstAt = parts.map((p, k) => nameOk(p.w) && LEX.isFirstName(p.w) ? k : -1).filter((k) => k >= 0);
        const pair = (k) => firstAt.some((f) => f !== k && Math.abs(f - k) === 1 && nameOk(parts[k].w));
        // in a file name a given name that is also a word ("abernathy_hope_mri.pdf") counts beside an anchor surname
        const wordGiven = (k) => fileLike && LEX.isFirstName(parts[k].w) && parts[k].w.length >= 3 && !FILE_WORD.test(parts[k].w) && !LEX.isClinical(parts[k].w) && parts.some((q, k2) => Math.abs(k2 - k) === 1 && nameOk(q.w) && LEX.isAnchorName(q.w));
        parts.forEach((p, k) => {
          if (!nameOk(p.w) && !wordGiven(k)) return;
          if (!(pair(k) || wordGiven(k) || (firstAt.includes(k) && parts.some((q, k2) => Math.abs(k2 - k) === 1 && nameOk(q.w))) || (fileLike && LEX.isAnchorName(p.w)))) return;
          if (spans.some((x) => x.start < p.start + p.w.length && p.start < x.end)) return;
          spans.push({ start: p.start, end: p.start + p.w.length, type: 'NAME_OTHER', source: 'cue:filename', conf: 0.6, text: p.w });
        });
      }
    }
    // A language or nationality is not a person where the words around it say language ("prefers French interpreter",
    // "Interpreter (Spanish) used", "speaks Haitian Creole"), even when it is also a surname (French, English, Welsh)
    for (let si = spans.length - 1; si >= 0; si--) {
      const sp = spans[si];
      if (COARSE(sp.type) !== 'NAME' || /^cue:(?:honorific|credential)$/.test(sp.source)) continue;
      const ti = tokStarting(sp.start); if (ti < 0) continue;
      let te = ti; while (te < toks.length && toks[te].end <= sp.end) te++;
      const inner = toks.slice(ti, te).filter((x) => x.word);
      if (!inner.length || !inner.every((x) => LEX.LANGUAGE_SET.has(x.core.toLowerCase()))) continue;
      const nx = toks[te], pv = toks[ti - 1], pv2 = toks[ti - 2];
      const langAfter = nx && nx.word && /^(?:interpreter|interpreters|interpretation|interpreting|translator|translators|translation|translated|language|languages|speaking|speaker|speakers|speaks|only|creole|version|materials?|sign|subtitles|consent|forms?|teaching|handout|handouts|video|line|phone)$/i.test(nx.core);
      const langBefore = pv && ((pv.word && /^(?:speaks?|spoke|speaking|in|prefers|preferred|primary|language|languages|interpreter|translator|fluent|native|only|and|or)$/i.test(pv.core)) || (/^[(\[,\/]$/.test(pv.raw) && pv2 && pv2.word && /^(?:interpreter|interpreters|translator|language|languages|speaks|speaking|interp)$/i.test(pv2.core)));
      if (!langAfter && !langBefore) continue;
      for (let q = ti; q < te; q++) used[q] = false;
      spans.splice(si, 1);
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
  // a token is the patient's own when it is one of the patient's names or a short form cut from one ("finn" of finnegan)
  const ownTokenHas = (set, t) => set.has(t) || (t.length >= 3 && [...set].some((o) => o.length >= t.length + 3 && o.startsWith(t)));
  // A person slot: where a word can only be a person. Before it, a patient label, a contact cue (w/, with, to, for, per,
  // called, spoke with, talked to, left a message for) or a relation word (dtr, husband), optionally with an opening
  // bracket; after it, a person verb (called, asked, says, reports, here, declined), a possessive, " re" or the end of the
  // clause. Or a line or sentence start right before a person verb ("hunter called back").
  const PERSON_CUE_BEFORE = /(?:^|[^A-Za-z0-9])(?:pt|pts|patient|w\/|with|to|for|per|called|calling|call|phoned|spoke(?:[ \t]+(?:with|w\/?|to))?|talked(?:[ \t]+(?:with|w\/?|to))?|left[ \t]+(?:a[ \t]+)?(?:vm|voicemail|message|msg)(?:[ \t]+(?:for|with|w\/?))?|lvm(?:[ \t]+(?:for|w\/?))?|told|tell|asked|ask|remind(?:ed)?|notif(?:y|ied)|texted|emailed|messaged|re:?|mr|mrs|ms|miss)\.?[ \t]*[:(]?[ \t]*$/i;
  const PERSON_VERB_AFTER = /^[ \t]*\)?[ \t]*(?:called|calls|calling|phoned|asked|asks|says|said|states|stated|reports|reported|here|arrived|declined|declines|denies|denied|wants|wanted|requests|requested|prefers|preferred|agrees|agreed|refused|refuses|tolerated|tolerating|confirmed|confirms|came|left|texted|emailed|cancel(?:l?ed|s)|rescheduled|picks|picked|signed|aware|verbalized|verbalizes|understands|no[- ]?show(?:ed)?|is[ \t]+here|will[ \t]+(?:call|fax|come|bring|be|drive|pick))\b/i;
  function personSlotOf(text, start, end) {
    const pre = text.slice(Math.max(0, start - 40), start), post = text.slice(end, end + 40);
    let cue = PERSON_CUE_BEFORE.test(pre);
    // a relation word right before it, never across a full stop ("is POA. Bell's palsy")
    if (!cue) { const rm = pre.match(/(?:^|[^A-Za-z])([A-Za-z][A-Za-z\-]{1,30})[ \t]*[:(]?[ \t]*$/); cue = !!rm && relWord(rm[1]); }
    const lineStart = /(?:^|[\n.;!?]|^[ \t]*[-•*])[ \t]*[("'“]?$/.test(pre);
    const verb = PERSON_VERB_AFTER.test(post);
    const close = /^(?:['’]s\b|[ \t]*\)?[ \t]*(?:[,.;:!?]|$|re\b))/i.test(post);
    // an eponym is clinical, never a person: "Bell's palsy", "Hunter syndrome", "Graves' disease"
    const ep = post.match(/^(?:['’]s?)?[ \t]+([A-Za-z]+)/);
    const eponym = !!ep && (LEX.EPONYM_FOLLOW.has(ep[1].toLowerCase()) || MED_SUFFIX.test(ep[1]));
    return { cue, lineStart, verb, close, eponym };
  }
  // strict: a cue and a person-shaped right side, or a sentence start and a person verb (for word-names: Rose, Will, Hunter)
  const personSlot = (text, start, end) => { const x = personSlotOf(text, start, end); return !x.eponym && ((x.cue && (x.verb || x.close)) || (x.lineStart && x.verb)); };
  // loose: a cue alone, or a sentence start and a person verb (for given names that are not ordinary words)
  const personSlotLoose = (text, start, end) => { const x = personSlotOf(text, start, end); return !x.eponym && (x.cue || (x.lineStart && x.verb)); };
  // a given name that is not an ordinary word, a clinical word, a month, a relation, a language or a stop word: in a patient
  // list it is that patient in any case ("rosario", "kenji")
  const givenNotWord = (t) => t.length >= 4 && /^[\p{L}'’\-]+$/u.test(t) && !LEX.isEnglishWord(t) && !LEX.isClinical(t) && !COMMON_LOWER.has(t.toLowerCase()) && !COMMON_CAP.has(t.toLowerCase()) && !monthIndex(t) && !relWord(t) && !LEX.LANGUAGE_SET.has(t.toLowerCase());
  // an all-capitals credential (DO, PA, MD, RN, NP): never read as a patient's name, by the detector or the self-check
  const isCredentialToken = (t) => t.length <= 4 && t === t.toUpperCase() && LEX.CREDENTIAL_SET.has(t.toLowerCase());
  function censusSpans(text, census, rowPatientKey, rowExtraKeys) {
    const spans = [];
    if (!census || !census.regex) return spans;
    // a census built by this version carries a scan; an older census object may carry the alternation regex itself
    let matches;
    if (census.scan) matches = scanLookup(text, census.scan);
    else if (census.regex instanceof RegExp) { matches = []; const re = census.regex; re.lastIndex = 0; let mm; while ((mm = re.exec(text))) matches.push(mm); }
    else return spans;
    const hasEnt = (hit, k) => (hit.entSet ? hit.entSet.has(k) : hit.entities.includes(k));
    for (const m of matches) {
      const hit = census.lookup.get(m[0].toLowerCase());
      if (!hit) continue;
      // a surname that is also a credential (Do, Pa, Md, Rn, Np) written in capitals after a name is the credential
      // ("per Kavita DO"); the self-check reads it the same way. The full name ("Brittany Do") is a longer variant and still matches.
      if (hit.type === 'NAME_PATIENT' && isCredentialToken(m[0])) continue;
      const own = rowPatientKey && hasEnt(hit, rowPatientKey);
      // a word-name typed in lower case ("grace's husband", "spoke w/ winter") is the patient in their own row when a
      // possessive follows or a contact cue precedes it
      if (hit.needsCue) {
        const after = text.slice(m.index + m[0].length), before = text.slice(Math.max(0, m.index - 14), m.index);
        const cue = /^['’]s\b/.test(after) || /^\s+(?:tolerated|tolerating|reports|reported|states|stated|says|said|arrived|arriving|declined|declines|here|is|was|has|had|called|calls|asked|asks|prefers|wants|requests|requested|denies|denied|agrees|agreed|refused|refuses|will|would|came|left|feels|felt|doing|did|does|needs|needed|ok|okay)\b/i.test(after) || /(?:\bpt|\bpatient|\bw\/|\bwith|\bspoke to|\bcalled|\bre:?|\bper|\btold|\basked)\s*$/i.test(before);
        if (!cue || !own) continue;
      }
      // ... or when an inflected person verb follows it ("yan requests chair 12", "mae called back"): in the patient's own row
      // only, and never a bare "will"/"is" ("will call", "may need")
      const lcOwn = own && !/^[A-Z]/.test(m[0]) && (/^['’]s\b/.test(text.slice(m.index + m[0].length)) || /(?:\bw\/|\bwith|\bspoke to|\bspoke w\/|\bcalled|\bcall|\bre:?|\bper|\btold|\basked|\bpt|\bpatient)\s*$/i.test(text.slice(Math.max(0, m.index - 12), m.index))
        || (hit.type === 'NAME_PATIENT' && /^ {1,2}(?:requests|requested|reports|reported|states|stated|says|said|called|calls|phoned|asked|asks|prefers|preferred|wants|wanted|declined|declines|denies|denied|agrees|agreed|refused|refuses|tolerated|tolerating|arrived|complains|verbalized|verbalizes|confirmed|confirms|endorses|texted|emailed|voiced|understands|consented)\b/i.test(text.slice(m.index + m[0].length, m.index + m[0].length + 16))));
      // a listed patient's given name: in any case when it is not an ordinary word ("called rosario re parking"), and in a
      // person slot when it is ("pt rose called", "hunter called back"); "BP rose to 150", "pt will call" stay
      const givenFree = !!hit.given && hit.type === 'NAME_PATIENT' && givenNotWord(m[0]);
      const givenSlot = !!hit.given && hit.type === 'NAME_PATIENT' && !givenFree && !(monthIndex(m[0]) && /^[ \t]*\d/.test(text.slice(m.index + m[0].length))) && personSlot(text, m.index, m.index + m[0].length);
      if (hit.exactCase && !/^[A-Z]/.test(m[0]) && !lcOwn && !givenFree && !givenSlot) continue;
      const ownExtra = !own && rowExtraKeys ? rowExtraKeys.find((k) => hasEnt(hit, k)) : null;
      if (hit.rowScoped && !own && !ownExtra) {
        // another patient's given name in this row ("same day as Tobias", "Barnaby asked for ..."): it is still a person's
        // name, so it is hidden as a third party; a word-name or clinical word (May, Will, Grey) only in a person slot.
        // On a line that names no patient of its own, a given name of exactly one listed patient is that patient.
        const plainCap = /^[A-Z][a-z'’\-]{2,}$/.test(m[0]) && !LEX.isAmbiguous(m[0]) && !LEX.isClinical(m[0]) && !monthIndex(m[0]) && !COMMON_CAP.has(m[0].toLowerCase());
        if (hit.type === 'NAME_PATIENT' && (plainCap || givenFree || givenSlot)) {
          const after = text.slice(m.index + m[0].length).match(/^(?:['’]s?)?\s+([A-Za-z]+)/);
          if (!(after && LEX.EPONYM_FOLLOW.has(after[1].toLowerCase()))) {
            const sole = hit.given && hit.entities.length === 1 && !rowPatientKey && !(rowExtraKeys && rowExtraKeys.length);
            const p1 = sole ? (census.patient ? census.patient(hit.entities[0]) : census.patients.get(hit.entities[0])) : null;
            if (p1) spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_PATIENT', source: 'census', entity: hit.entities[0], text: m[0], conf: 0.85, ownTokens: p1.ownTokens });
            else spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'census', text: m[0], conf: 0.8 });
          }
        }
        continue;
      }
      // a short form cut from a long given name ("Mild" of Mildred, "Step" of Stephanie) at the start of a sentence is the
      // ordinary word ("Mild rash noted") unless the text is in capitals or a person verb follows ("Finn called")
      if (hit.prefix) {
        const before = text.slice(Math.max(0, m.index - 40), m.index), after = text.slice(m.index + m[0].length); // a bounded look back
        const initial = /(?:^|[.!?:;\n]\s*|^\s*[-•*]\s*)$/.test(before);
        const caps = m[0] === m[0].toUpperCase();
        if (initial && !caps && !/^\s+(?:called|calls|says|said|states|stated|reports|reported|is|was|will|has|had|wants|asked|asks|declined|agrees|agreed|aware|here|arrived|prefers|tolerated|feels|felt|came|went|left)\b/i.test(after)) continue;
      }
      const entity = own ? rowPatientKey : ownExtra || hit.entities[0];
      let start = m.index, end = m.index + m[0].length, type = hit.type;
      if (type === 'NAME_PATIENT') {
        const p = census.patient ? census.patient(entity) : census.patients.get(entity);
        // a clinical eponym that is also the patient's surname stays clinical when the next word says so (Grey Turner sign)
        const after = text.slice(end).match(/^(?:['’]s?)?\s+([A-Za-z]+)/); // also "Bell's palsy", "Graves' disease"
        if ((LEX.isClinical(m[0]) || LEX.isAmbiguous(m[0])) && after && (LEX.EPONYM_FOLLOW.has(after[1].toLowerCase()) || (LEX.isClinical(m[0]) && MED_SUFFIX.test(after[1])))) continue; // also "Graves ophthalmopathy"
        // a surname that is one half of a hyphenated compound (Haddad-Khalil, Wisniewski-Kaminski): take the whole compound
        while (end < text.length && text[end] === '-' && /[A-Za-z]/.test(text[end + 1] || '')) { const mm = text.slice(end + 1).match(/^[A-Za-z'’]+/); end += 1 + mm[0].length; }
        while (start > 0 && text[start - 1] === '-' && /[A-Za-z]/.test(text[start - 2] || '')) { const mm = text.slice(Math.max(0, start - 61), start - 1).match(/[A-Za-z'’]+$/); if (/^[a-z]/.test(mm[0]) && mm[0].length < 3) break; start -= 1 + mm[0].length; }
        let relative = false;
        if (p && p.ownTokens) {
          const toks = text.slice(start, end).toLowerCase().split(/[^a-z'’]+/).filter(Boolean);
          relative = toks.some((t) => !ownTokenHas(p.ownTokens, t) && !(t.length === 1 && [...p.ownTokens].some((o) => o[0] === t)));
        }
        if (relative) { spans.push({ start, end, type: 'NAME_OTHER', source: 'census', relative: entity, text: text.slice(start, end), conf: 0.9, ownTokens: p.ownTokens }); continue; }
        spans.push({ start, end, type, source: 'census', entity, text: text.slice(start, end), conf: 1, ownTokens: p && p.ownTokens });
        continue;
      }
      spans.push({ start, end, type, source: 'census', entity, text: m[0], conf: 1 });
    }
    const patientOf = (k) => (census.patient ? census.patient(k) : census.patients.get(k));
    // a file name glues words with capitals ("ConsentMbekiLarsson.pdf", "OkonkwoChidi_CT.png"): each CamelCase piece, and two
    // or three neighbouring pieces run together, is looked up like a word (a surname or a full name, not a given name alone)
    if (/[a-z][A-Z]/.test(text) && FILE_EXT_RE.test(text)) {
      const ft = new RegExp(FILE_TOKEN_RE.source, 'gi'); let fm;
      while ((fm = ft.exec(text))) {
        const pieces = []; const pr = /[A-Za-z]+/g; let pm;
        while ((pm = pr.exec(fm[0]))) {
          const w = pm[0]; let a = 0;
          for (let i = 1; i <= w.length; i++) if (i === w.length || (/[a-z]/.test(w[i - 1]) && /[A-Z]/.test(w[i]))) { pieces.push({ s: fm.index + pm.index + a, e: fm.index + pm.index + i, run: pm.index }); a = i; }
        }
        for (let i = 0; i < pieces.length; i++) {
          for (let k = Math.min(3, pieces.length - i); k >= 1; k--) {
            const win = pieces.slice(i, i + k); if (win.some((x) => x.run !== win[0].run)) continue;
            const st = win[0].s, en = win[k - 1].e; if (en - st < 4 || spans.some((x) => x.start < en && x.end > st)) continue;
            const hit = census.lookup.get(text.slice(st, en).toLowerCase());
            if (!hit || hit.type !== 'NAME_PATIENT') continue;
            const own = rowPatientKey && hasEnt(hit, rowPatientKey);
            if (hit.rowScoped && !own) continue;
            const ent = own ? rowPatientKey : hit.entities[0]; const pp = patientOf(ent);
            spans.push({ start: st, end: en, type: 'NAME_PATIENT', source: 'census', entity: ent, text: text.slice(st, en), conf: 0.9, ownTokens: pp && pp.ownTokens });
            i += k - 1; break;
          }
        }
      }
    }
    // a listed surname misspelled by one letter or one swap ("Okonkow C.", "Szczepanksi here for Entyvio"): a capitalised
    // word of 6+ letters that is no name, ordinary word, place or clinical term of its own
    if (census.fuzzy && census.fuzzy.idx.size) {
      const wre = /(?<![\p{L}0-9'’])\p{Lu}[\p{L}'’]{5,40}(?![\p{L}0-9])/gu; let wm;
      while ((wm = wre.exec(text))) {
        const w = wm[0].replace(/['’]s$/, ''), st = wm.index, en = st + w.length;
        if (spans.some((x) => x.start < en && x.end > st) || !looksMisspelledName(w)) continue;
        const ents = fuzzySurnameHits(census.fuzzy, w);
        if (!ents.length) continue;
        const ent = ents.length === 1 ? ents[0] : (rowPatientKey && ents.includes(rowPatientKey) ? rowPatientKey : null);
        const pp = ent ? patientOf(ent) : null;
        if (pp) {
          // the patient's own first initial or given name right after it belongs to the name ("Okonkow C.", "Okonkow, Chidi")
          const first = pp.parsed && pp.parsed.first ? pp.parsed.first : '';
          const tail = first ? text.slice(en, en + first.length + 3).match(/^(,?[ \t]{1,2})(\p{L}[\p{L}'’\-]*\.?)/u) : null;
          const tw = tail ? tail[2].replace(/\.$/, '') : '';
          const takeTail = !!tail && ((tw.length === 1 && tw.toUpperCase() === first[0].toUpperCase() && /^\p{Lu}/u.test(tw)) || tw.toLowerCase() === first.toLowerCase());
          if (takeTail) { const e2 = en + tail[0].length; spans.push({ start: st, end: e2, type: 'NAME_PATIENT', source: 'census', entity: ent, text: text.slice(st, e2), conf: 0.85, ownTokens: pp.ownTokens, fuzzy: true, lastFirst: { len: e2 - st, lastLen: w.length, tailAt: w.length + tail[1].length, initial: tw.length === 1 } }); }
          else spans.push({ start: st, end: en, type: 'NAME_PATIENT', source: 'census', entity: ent, text: w, conf: 0.8, ownTokens: pp.ownTokens, fuzzy: true, fragment: 'last' });
        } else spans.push({ start: st, end: en, type: 'NAME_OTHER', source: 'census', text: w, conf: 0.75 });
      }
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
          if (toks.some((t) => !ownTokenHas(k.ownTokens, t) && !(t.length === 1 && [...k.ownTokens].some((o) => o[0] === t)) && !/^(?:md|do|np|pa|rn|jr|sr|ii|iii|iv|mr|mrs|ms|dr|pt)$/.test(t))) { k.type = 'NAME_OTHER'; k.relative = k.entity; delete k.entity; }
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

  // Name finishing (after every pass): a detected name absorbs a neighbouring token on the same line, one space away, that is
  // a name of any tier or, written in the same case, is not an ordinary word ("Seok-jin Yoon", "Rejean Gagnon", "Fritznel
  // Desrosiers" when only the surname was found). Clinical words, eponyms (Bell's palsy, Lee Silverman voice), drug names,
  // credentials, relation words, labels, places, organisations, languages and word-names are never absorbed.
  const FIN_DRUG = /(?:mab|nib|cept|taxel|platin|rubicin|mycin|cycline|floxacin|azole|codone|morphone|parib|lisib|ciclib|statin|pril|sartan|olol|dronate|semide|setron|pitant|prazole|tidine|azepam|asone|olone|poetin|grastim|leucel|tecan|fosfamide|uracil|abine|trexate|limus|zomib|lumab|vir)$/i;
  function finishNames(text, spans, cfg) {
    if (!spans.some((s) => COARSE(s.type) === 'NAME')) return spans;
    const toks = tokenize(text);
    if (toks.length < 2) return spans;
    const allow = cfg.allowSet;
    // spans arrive sorted and disjoint: binary searches keep a long cell with many names linear-ish
    const lowerBound = (arr, key, val) => { let lo = 0, hi = arr.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (key(arr[mid]) < val) lo = mid + 1; else hi = mid; } return lo; };
    const sorted = spans.slice().sort((a, b) => a.start - b.start);
    const covered = (t) => { const k = lowerBound(sorted, (s) => s.start, t.fullEnd); for (let q = k - 1; q >= 0 && q >= k - 3; q--) if (sorted[q].end > t.start) return true; return false; };
    const shape = (t) => (t.allcaps ? 'A' : t.cap ? 'C' : /^[\p{Ll}]/u.test(t.core) ? 'l' : '?');
    const tokOk = (t, ref) => {
      if (!t || !t.word || t.initial || covered(t)) return false;
      const c = t.core, lc = c.toLowerCase(), lex = inLex(t);
      const sh = shape(ref);
      if (sh === '?' || shape(t) !== sh) return false;
      if ((sh === 'A' || sh === 'l') && !lex) return false; // ALL-CAPS notes are full of acronyms, lower-case ones of abbreviations
      if (c.length < (lex ? 2 : 3) || (sh === 'l' && c.length < 3)) return false;
      if (LEX.isClinical(c) || isCred(t) || isRel(t) || isHon(t) || LEX.isAmbiguous(c) || COMMON_CAP.has(lc) || COMMON_LOWER.has(lc) || FIELD_WORD_ALL.test(c) || LEX.STATE_ABBR_SET.has(c) || LEX.ORG_SUFFIX_SET.has(lc) || LEX.ORG_NAMEWORD_SET.has(lc) || LEX.ORG_PREFIX_SET.has(lc) || LEX.CITY_SET.has(lc) || LEX.STATE_NAME_SET.has(lc) || LEX.LANGUAGE_SET.has(lc) || LEX.GREETING_SET.has(lc) || LEX.PLACE_PREFIX_SET.has(lc) || monthIndex(c) || DEVICE_BRAND.test(c) || PLACE_SUFFIX.test(c) || (allow && allow.has(lc))) return false;
      if (lex) return !wordNotName(t);
      return !LEX.isEnglishWord(c) && !NONNAME_END.test(c) && !FIN_DRUG.test(c) && !MED_SUFFIX.test(c) && /[aeiouyà-ÿ]/i.test(c);
    };
    const followsEponym = (k) => { const n = toks[k]; return !!(n && n.word && (LEX.EPONYM_FOLLOW.has(n.core.toLowerCase()) || MED_SUFFIX.test(n.core) || ((n.cap || n.allcaps) && LEX.ORG_SUFFIX_SET.has(n.core.toLowerCase())))); };
    let changed = false;
    for (const sp of spans) {
      if (COARSE(sp.type) !== 'NAME' || sp.initials || sp.manual) continue;
      let ti = lowerBound(toks, (x) => x.start, sp.start);
      let te = lowerBound(toks, (x) => x.start, sp.end);
      if (ti >= toks.length || te <= ti || toks[ti].start !== sp.start) continue;
      if (followsEponym(te)) continue; // "Lee Silverman voice", "Graves disease": the run is clinical
      const added = [];
      // backward: "<Given> <found surname>"
      for (let hop = 0; hop < 2 && ti > 0 && te - ti < 4; hop++) {
        const p = toks[ti - 1];
        // "O'Sullivan-Nwankwo, Bertram": a found given name takes the surname written before it with a comma ("Last, First"),
        // when that word sits right against the comma and is not one item of a longer list
        if (hop === 0 && p.raw === ',' && ti >= 2 && LEX.isFirstName(toks[ti].core) && text.slice(p.fullEnd, toks[ti].start) === ' ' && !p.nlAfter) {
          const q = toks[ti - 2], q0 = toks[ti - 3];
          if (q.fullEnd === p.start && q.fullEnd === q.end && !(q0 && q0.raw === ',') && !q.nlAfter && tokOk(q, toks[ti]) && (inLex(q) || /[-'’]/.test(q.core))) { ti -= 2; added.push(q); }
          break;
        }
        if (p.fullEnd !== p.end || text.slice(p.fullEnd, toks[ti].start) !== ' ' || p.nlAfter) break;
        // a month that is a given name (June, April) before a found surname, where a month cannot stand: at the start of a
        // sentence or after a patient label, relation word or honorific ("June Castellanos here", "Pt April Nakashima")
        const pp = toks[ti - 2];
        const monthGiven = hop === 0 && p.cap && p.core.length >= 4 && monthIndex(p.core) && LEX.isFirstName(p.core) && LEX.isAnchorName(toks[ti].core) && (!pp || pp.nlAfter || endsSentence(pp) || /^[:(\-–]$/.test(pp.raw) || (pp.word && (/^(?:pt|patient)$/i.test(pp.core) || isRel(pp) || isHon(pp))));
        if (!monthGiven && !tokOk(p, toks[ti])) break;
        ti--; added.push(p);
      }
      // forward: "<found given name> <surname>"
      for (let hop = 0; hop < 2 && te < toks.length && te - ti < 4; hop++) {
        const last = toks[te - 1], n = toks[te];
        if (last.fullEnd !== last.end || last.nlAfter || text.slice(last.fullEnd, n.start) !== ' ' || !tokOk(n, last) || followsEponym(te + 1)) break;
        te++; added.push(n);
      }
      if (!added.length) continue;
      sp.start = toks[ti].start; sp.end = toks[te - 1].end; sp.text = text.slice(sp.start, sp.end);
      sp.source = /finish/.test(sp.source) ? sp.source : `${sp.source}+finish`;
      changed = true;
      // a token that is not one of the patient's (or provider's) own names makes this someone else who shares the surname
      if (sp.entity) {
        const own = sp.ownTokens;
        if (!own || added.some((t) => !ownTokenHas(own, t.core.toLowerCase()))) { if (sp.type === 'NAME_PATIENT') sp.relative = sp.entity; sp.type = 'NAME_OTHER'; delete sp.entity; }
      }
    }
    return changed ? mergeAdjacentNames(spans.sort((a, b) => a.start - b.start), text) : spans;
  }

  // A name found anywhere in the cell (or anywhere in the document, by propagation) is the same person when it reappears,
  // in any case, as a part of a file name or handle ("Pt Quennel Nakashima" ... "nakashima_quennel_ct.pdf"): the part is
  // replaced and the separators and the rest of the file name stay.
  function compoundNameParts(text, spans, ctx) {
    if (!/[A-Za-z0-9][._][A-Za-z]/.test(text)) return spans;
    const words = new Set();
    spans.forEach((s) => { if (COARSE(s.type) === 'NAME' && !s.initials) (text.slice(s.start, s.end).match(/\p{L}{3,}/gu) || []).forEach((w) => words.add(w.toLowerCase())); });
    if (ctx && ctx.propagateRegex && ctx.propagateRegex.terms) ctx.propagateRegex.terms.forEach((t) => (String(t).match(/\p{L}{3,}/gu) || []).forEach((w) => words.add(w.toLowerCase())));
    if (!words.size) return spans;
    const added = [];
    const re = /(?<![A-Za-z0-9@])[A-Za-z0-9]+(?:[._][A-Za-z0-9]+)+/g; let cm;
    while ((cm = re.exec(text))) {
      const pr = /[A-Za-z]+/g; let pm;
      while ((pm = pr.exec(cm[0]))) {
        const st = cm.index + pm.index, en = st + pm[0].length;
        if (pm[0].length < 3 || !words.has(pm[0].toLowerCase()) || LEX.isClinical(pm[0]) || COMMON_LOWER.has(pm[0].toLowerCase())) continue;
        if (spans.some((s) => s.start < en && st < s.end) || added.some((s) => s.start < en && st < s.end)) continue;
        added.push({ start: st, end: en, type: 'NAME_OTHER', source: 'propagate', conf: 0.6, text: pm[0] });
      }
    }
    return added.length ? spans.concat(added).sort((a, b) => a.start - b.start) : spans;
  }
  // A bare number of 5-9 digits written straight after a person's name ("1) Dunwich, Dimitra 44102 2) ...") is that person's
  // identifier, whatever its length: a name is never followed by a dose or a count without a unit
  function numberAfterName(text, spans) {
    let added = null;
    for (const sp of spans) {
      if (COARSE(sp.type) !== 'NAME' || sp.initials) continue;
      const m = text.slice(sp.end, sp.end + 16).match(/^,?[ \t]{1,3}(#?\d{5,9})(?![\d\/\-:]|[.,]\d)(?![ \t]*(?:mg|mcg|g|kg|ml|mL|units?|cells|copies|iu|k|%|x|times|days?|wks?|weeks?)\b)/);
      if (!m) continue;
      const st = sp.end + m[0].length - m[1].length, en = sp.end + m[0].length;
      if (spans.some((x) => x.start < en && st < x.end) || (added && added.some((x) => x.start < en && st < x.end))) continue;
      (added = added || []).push({ start: st, end: en, type: 'ID_OTHER', source: 'rule', conf: 0.7, text: m[1] });
    }
    return added ? spans.concat(added).sort((a, b) => a.start - b.start) : spans;
  }
  // A very long cell (a whole note pasted into one cell) is detected in pieces cut at line or sentence ends, so the work stays
  // proportional to the length of the text and a pathological paste cannot freeze the page.
  const DETECT_CHUNK = 6000;
  function detectText(text, ctx) {
    if (!text) return [];
    if (typeof text !== 'string') text = cellToString(text);
    if (!ctx || typeof ctx !== 'object' || !ctx.cfg || !ctx.cfg.layers) ctx = Object.assign({}, ctx && typeof ctx === 'object' ? ctx : {}, { cfg: compileConfig(defaultConfig({})) });
    if (text.length <= DETECT_CHUNK) return detectTextCore(text, ctx);
    const out = []; let pos = 0;
    const sub = Object.assign({}, ctx, { manual: null, fragments: null });
    while (pos < text.length) {
      let end = Math.min(text.length, pos + DETECT_CHUNK);
      if (end < text.length) {
        const cut = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf('. ', end - 2) + 1);
        if (cut > pos + DETECT_CHUNK / 2) end = cut + 1;
        else { const sp = text.lastIndexOf(' ', end - 1); if (sp > pos + DETECT_CHUNK / 2) end = sp + 1; }
      }
      detectTextCore(text.slice(pos, end), sub).forEach((s) => { s.start += pos; s.end += pos; out.push(s); });
      pos = end;
    }
    const manual = ctx.manual && ctx.cellKey ? ctx.manual[ctx.cellKey] : null;
    if (!manual) return out;
    let res = manual.remove ? out.filter((s) => !manual.remove.some((r) => r[0] === s.start && r[1] === s.end)) : out;
    (manual.add || []).forEach((a) => { if (!(a.end > a.start && a.end <= text.length)) return; res = res.filter((s) => s.end <= a.start || s.start >= a.end); res.push({ start: a.start, end: a.end, type: a.type || 'NAME_OTHER', source: 'manual', conf: 1, text: text.slice(a.start, a.end), manual: true }); });
    return res.sort((x, y) => x.start - y.start);
  }
  // ---------------------------------------------------------------------
  // Strict pass: an unrecognised proper noun is treated as an identifier.
  // A capitalised word that no rule claimed and that is not an ordinary or medical word (275k-word dictionary, clinical
  // allowlist, drug-name stems, medical word endings, a dose right after it) is replaced; so is a lower-case word that is
  // a name of any tier and not a dictionary word. Errs toward removal: an unknown brand or place name is lost rather than
  // a real name kept. Flagged as uncertain so the review list shows every one.
  // ---------------------------------------------------------------------
  const DRUG_STEM = /(?:mab|nib|lib|cept|platin|taxel|rubicin|mycin|micin|cillin|floxacin|conazole|azole|vir|zomib|lisib|parib|ciclib|rafenib|statin|olol|pril|sartan|azepam|zolam|oxetine|tidine|prazole|cycline|dronate|semide|thiazide|plase|grastim|poetin|tecan|gliptin|gliflozin|glutide|tide|methasone|olone|sonide|tropin|caine|dipine|terol|lukast|relin|rolimus|uracil|abine|arabine|ribine|trexate|ifen|trozole|lutamide|mustine|phamide|sulfan|carbazine|tepa|bicin|parin|xaban|gatran|grel|setron|pitant|zumab|ximab|tuzumab|leucel|cabtagene|tinib|degib|stat|kinase|mide|feron|leukin|kin)$/i;
  const MED_MORPH = /(?:itis|osis|emia|aemia|penia|penic|cytosis|opathy|pathic|ectomy|otomy|ostomy|plasty|scopy|scopic|graphy|gram|ology|ologic|ological|ologist|oma|omas|algia|uria|plegia|paresis|trophy|trophic|genic|genesis|lytic|lysis|emic|cytic|cyte|cytes|blast|blastic|phylaxis|phylactic|tropic|stasis|megaly|rrhea|rrhage|pnea|ptosis|sclerosis|thermia|tensive|vascular|cardial|dermal|venous|cranial|thoracic|renal|hepatic|pulmonary|myeloid|lymphoid|neoplastic|metastatic|cellular|ocular|ectasia|edema|oedema|iform|form|oid|openia|ectomies|otic)$/i;
  const DOSE_AFTER = /^\s*(?:\d+(?:\.\d+)?\s*(?:mg|mcg|µg|g|gm|units?|u|iu|ml|mL|l|meq|mmol|mg\/m2|mg\/kg|mcg\/kg|%)\b|(?:sq|sc|iv|im|po|ivpb|subq|subcut|infusion|injection|tablet|tab|cap|patch)\b|\d+(?:\.\d+)?\s*mg\/)/i;
  const STRICT_SKIP = /^(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|yesterday|epic|mychart|cerner|snapboard|haiku|canto|rover|beacon|teams|zoom|portal|pyxis|omnicell|alaris|baxter|cadd|powerport|portacath|mediport|picc|huber|onpro|neulasta|pt|pts|dr|mr|mrs|ms|rn|lpn|np|pa|md|do|ok|okay|vit|diff|prbc|ffp|plt|plts|hgb|hct|wbc|anc|alc|inr|ptt|bmp|cmp|lft|lfts|tsh|psa|cea|ldh|egfr|upcr|tsat|dlco|lvef|ivig|scig|cidp|fmla|gcsf|csf|ecog|kps|nivo|ipi|pembro|atezo|durva|dara|ritux|obin|carbo|cis|oxali|gem|pacli|doce|methylpred|solumedrol|benadryl|tylenol|zofran|emend|decadron|pepcid|ativan|compazine|reglan|neupogen|udenyca|ziextenzo|fulphila|nyvepria|zarxio|granix|retacrit|aranesp|procrit|epogen|venofer|injectafer|feraheme|monoferric|infed|reclast|zometa|xgeva|prolia|evenity)$/i;
  const TOWN_WORD = /^(?:Falls|River|Rapids|Springs|Heights|Beach|Lake|Lakes|Valley|Hills|Grove|Bay|Harbor|Harbour|Point|Junction|Creek|Bluffs|Village|City|Ridge|Mills|Station|Landing|Shores|Forge|Ferry|Hollow|Glen|Crossing|Plains|Corners|Port|Haven|Vista|Woods|Meadows|Falls|Bend|Rock|Mountain|Island|Cove|Park)$/;
  function strictSpans(text, spans, cfg) {
    const toks = tokenize(text); if (!toks.length) return spans;
    const covered = (t) => spans.some((sp) => sp.start < t.end && t.start < sp.end);
    const ordinary = (t) => {
      const w = t.core, lw = w.toLowerCase();
      if (LEX.isEnglishWord(w) || LEX.isDictWord(w) || LEX.isClinical(w)) return true;
      const parts = w.split(/[-'’]/).filter(Boolean);
      if (parts.length > 1 && parts.every((x) => x.length < 3 || LEX.isDictWord(x) || LEX.isEnglishWord(x) || LEX.isClinical(x))) return true;
      if (DRUG_STEM.test(lw) || MED_MORPH.test(lw)) return true;
      if (DOSE_AFTER.test(text.slice(t.fullEnd, t.fullEnd + 24))) return true;
      if ((LEX.GREETING_SET && LEX.GREETING_SET.has(lw)) || /^(?:hola|bonjour|bonsoir|salut|ciao|namaste|shalom|salaam|salam|marhaba|konnichiwa|annyeong|xin|chao|ola|oi|hallo|hej|buenos|buenas|gracias|merci|obrigado|obrigada|grazie|danke)$/i.test(w)) return true;
      { const nx = (text.slice(t.fullEnd).match(/^\s+([A-Za-z]+)/) || [])[1]; if (nx && (MED_MORPH.test(nx) || LEX.isClinical(nx)) && /^(?:de|von|van|la|le)$/i.test((text.slice(Math.max(0, t.start - 4), t.start).match(/([A-Za-z]+)\s*$/) || [])[1] || '')) return true; }
      if (STRICT_SKIP.test(w) || COMMON_CAP.has(lw) || COMMON_LOWER.has(lw) || monthIndex(w) || relWord(w)) return true;
      if (LEX.CREDENTIAL_SET.has(lw) || LEX.HONORIFIC_SET.has(lw.replace(/\.$/, '')) || LEX.STATE_ABBR_SET.has(w) || LEX.STATE_NAME_SET.has(lw)) return true;
      if (LEX.ORG_SUFFIX_SET.has(lw) || LEX.ORG_NAMEWORD_SET.has(lw) || LEX.ORG_PREFIX_SET.has(lw) || LEX.GEO_SUFFIX_SET.has(lw)) return true;
      if (cfg.allowSet && cfg.allowSet.has(lw)) return true;
      // a word followed by a regimen/dose context is a drug or product ("Darzalex Faspro wk 9", "Lemtrada D3", "Herzuma charges")
      if (/^\s*(?:C\d+(?:D\d+)?|D\d+|wk\s*\d|week\s*\d|cycle|dose|doses|infusion|infusions|premed|premeds|charges?|load(?:ing)?|maint(?:enance)?|q\d+\s*w(?:ee)?ks?|qw|weekly|monthly|biweekly|induction|reload|faspro|hycela|sc\b|iv\b|subq|\/[a-z]|-[a-z]+\s+(?:wk|c\d|d\d))/i.test(text.slice(t.fullEnd, t.fullEnd + 18))) return true;
      if (/(?:\b(?:start|starting|started|continue|continued|hold|held|resume|resumed|on|off|switch(?:ed)?\s+to|premed(?:icate)?\s+with|given|infuse|infused|due\s+for|move\s+my|approved\s+for|auth\s+for|refill)\s+)$/i.test(text.slice(Math.max(0, t.start - 24), t.start)) && !LEX.isFirstName(w)) return true;
      // "Lee Silverman voice treatment": a name-like word before a program/eponym word is clinical
      if ((text.slice(t.fullEnd).match(/^\s+([A-Za-z]+)/) || [])[1] && LEX.EPONYM_FOLLOW.has(text.slice(t.fullEnd).match(/^\s+([A-Za-z]+)/)[1].toLowerCase())) return true;
      return false;
    };
    const add = [];
    // a town named with ordinary words and a place word after a place cue ("moving to Fall River", "in Central Falls",
    // "from Cedar Rapids", "near Glens Falls NY")
    for (let i = 0; i + 2 < toks.length; i++) {
      const p = toks[i], a = toks[i + 1], b = toks[i + 2];
      if (!p.word || !/^(?:in|from|to|near|outside|towards|toward|at)$/i.test(p.core)) continue;
      if (!a.word || !a.cap || !b.word || !(b.cap || /^[A-Z]{2}$/.test(b.core)) || covered(a) || covered(b)) continue;
      const stateNext = b.allcaps === false && /^[A-Z]{2}$/.test(b.core) && LEX.STATE_ABBR_SET.has(b.core);
      const stateAfter = /^[A-Z]{2}$/.test(b.raw.replace(/[.,;]$/, '')) && LEX.STATE_ABBR_SET.has(b.raw.replace(/[.,;]$/, ''));
      if (stateAfter && a.cap && !LEX.isClinical(a.core) && !LEX.ORG_SUFFIX_SET.has(a.core.toLowerCase())) { add.push({ start: a.start, end: b.start + 2, type: 'LOCATION', source: 'strict', conf: 0.5 }); continue; }
      if (!(LEX.GEO_SUFFIX_SET.has(b.core.toLowerCase()) || TOWN_WORD.test(b.core)) || (LEX.isClinical(a.core) && !/^(?:north|south|east|west|central|upper|lower|old|new|grand|great|little|big|long|high|main)$/i.test(a.core)) || LEX.ORG_SUFFIX_SET.has(a.core.toLowerCase()) || LEX.ORG_SUFFIX_SET.has(b.core.toLowerCase())) continue;
      if (!/^\s+$/.test(text.slice(a.end, b.start))) continue;
      add.push({ start: a.start, end: b.end, type: 'LOCATION', source: 'strict', conf: 0.5 });
    }
    const inAdd = (t) => add.some((x) => x.start <= t.start && x.end >= t.end);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!t.word || !/^\p{L}[\p{L}\p{M}'’\-]*$/u.test(t.core) || inAdd(t)) continue;
      const len = LEX.fold(t.core).replace(/[^a-z]/g, '').length;
      if (len < 3 || covered(t)) continue;
      // an ALL-CAPS word counts only when it is a known name (THOMPSON), never as an unknown acronym (LVEF, PRBC, IIIB)
      const capLike = t.cap || (t.allcaps && len >= 4 && (LEX.isFirstName(t.core) || LEX.isSurname(t.core))) || /^\p{Lu}[\p{Ll}\p{M}]+(?:-\p{L}[\p{Ll}\p{M}]+)+$/u.test(t.core);
      const lower = /^[\p{Ll}][\p{Ll}\p{M}'’\-]*$/u.test(t.core);
      let cand = false;
      if (capLike) cand = !ordinary(t);
      else if (lower && len >= 4) cand = (LEX.isFirstName(t.core) || LEX.isSurname(t.core)) && !ordinary(t);
      if (!cand) continue;
      const prev = toks[i - 1];
      const placeCue = prev && prev.word && /^(?:in|from|to|near|at|outside|towards|toward)$/i.test(prev.core) && !LEX.isFirstName(t.core);
      const last = add[add.length - 1];
      // join with the previous strict token when only a space or a one-letter particle sits between (Cormac Ó Briain)
      if (last && /^\s+(?:\p{L}\.?\s+)?$/u.test(text.slice(last.end, t.start)) && last.type === (placeCue ? 'LOCATION' : last.type)) { last.end = t.end; continue; }
      add.push({ start: t.start, end: t.end, type: placeCue || LEX.CITY_SET.has(t.core.toLowerCase()) ? 'LOCATION' : 'NAME_OTHER', source: 'strict', conf: 0.5 });
    }
    const free = (a, b) => !spans.some((sp) => sp.start < b && a < sp.end) && !add.some((x) => x.start < b && a < x.end);
    let m;
    // a labelled place: "City   Springfield", "Hometown: Cedar Falls", "Town of residence Lowell"
    const PLACE_LABEL = /\b(?:City|Town|Hometown|Home\s+town|Residence|Town\s+of\s+residence|Lives\s+in|Birthplace|Place\s+of\s+birth|County)\b\s*[:\-]?[ \t]+((?:\p{Lu}[\p{L}'’.\-]*)(?:[ \t]\p{Lu}[\p{L}'’.\-]*){0,2})/gu;
    while ((m = PLACE_LABEL.exec(text))) {
      const v = m[1], a = m.index + m[0].length - v.length;
      if (/^(?:Chair|Bay|Pod|Room|Rm|Unit|Floor|State|Zip|Phone|Relationship|Name|Address|Ok|Yes|No|N\/A|Na|None|Unknown)$/i.test(v.split(/\s/)[0])) continue;
      if (free(a, a + v.length)) add.push({ start: a, end: a + v.length, type: 'LOCATION', source: 'strict', conf: 0.5 });
    }
    // a line of ALL-CAPS "LAST, FIRST" names (a census tile row): when one is already a name, the others are names too
    if (spans.some((sp) => /^NAME/.test(sp.type) && /^\p{Lu}{2,}[\p{Lu}'’\-]*,\s?\p{Lu}{2,}/u.test(text.slice(sp.start, sp.end + 12)))) {
      const CAPS_NAME = /(?<![\p{L}\d])(\p{Lu}[\p{Lu}'’\-]+),[ \t]?(\p{Lu}[\p{Lu}'’\-]+)(?![\p{L}\d])/gu;
      while ((m = CAPS_NAME.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 2), m.index), after = text.slice(m.index + m[0].length, m.index + m[0].length + 2);
        if (!(/^(?:\s{2}|\t)|^$/.test(after) || /\s{2}$|\t$|^$/.test(before) || m.index === 0)) continue;
        if ([m[1], m[2]].some((w) => /^(?:MRN|DOB|CSN|FIN|ID|MD|DO|RN|NP|PA|AM|PM|IV|PO|LT|RT|AND|OR|THE|NA|NKDA)$/.test(w))) continue;
        if (free(m.index, m.index + m[0].length)) add.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'strict', conf: 0.5 });
      }
    }
    // nicknames: "Patrick (Paddy) Ó Briain", "goes by Paddy", "known as Bibi"; then every later use of that nickname, and a
    // first name already found as a name in this text when it reappears as a word that is also a name ("Will will return")
    const nameSpans = spans.filter((sp) => /^NAME/.test(sp.type)).concat(add.filter((x) => /^NAME/.test(x.type)));
    const nicks = new Set();
    const nickOfNear = new Set();
    nameSpans.forEach((sp) => (text.slice(sp.start, sp.end).match(/\p{Lu}[\p{Ll}'’]+/gu) || []).forEach((w) => { try { LEX.nicknamesOf(w).forEach((n) => nickOfNear.add(n.toLowerCase())); } catch (e) {} }));
    (text.match(/\b\p{Lu}[\p{Ll}'’]+(?=\s+\()/gu) || []).forEach((w) => { if (LEX.isFirstName(w)) { try { LEX.nicknamesOf(w).forEach((n) => nickOfNear.add(n.toLowerCase())); } catch (e) {} } });
    const nickOk = (w) => LEX.isFirstName(w) || !LEX.isDictWord(w) || nickOfNear.has(w.toLowerCase());
    const NICK_PAREN = /\((\p{Lu}[\p{Ll}'’]{1,14})\)/gu;
    while ((m = NICK_PAREN.exec(text))) {
      const a = m.index + 1, b = a + m[1].length;
      const near = nameSpans.some((sp) => (sp.end <= m.index && m.index - sp.end <= 2) || (sp.start >= m.index + m[0].length && sp.start - (m.index + m[0].length) <= 2) || (sp.start <= m.index && sp.end >= b));
      if (near && !LEX.isClinical(m[1]) && nickOk(m[1]) && !/^(?:Mom|Dad|Son|Wife|Husband|Spouse|Daughter|Sister|Brother|Aunt|Uncle|Pt|Patient|Self|Hcp|Poa|Guardian|Rn|Md|Np|Pa)$/i.test(m[1])) { nicks.add(m[1]); if (free(a, b)) add.push({ start: a, end: b, type: 'NAME_OTHER', source: 'strict', conf: 0.5 }); }
    }
    // a lower-case name in brackets after a relation word: "husband (ike) says"
    { const REL_PAREN = /\b(?:husband|wife|spouse|partner|son|daughter|mother|mom|father|dad|sister|brother|aunt|uncle|niece|nephew|grandson|granddaughter|friend|neighbou?r|caregiver|cousin)\s*\(([\p{L}'’]{2,15})\)/giu; let rm;
      while ((rm = REL_PAREN.exec(text))) { const a = rm.index + rm[0].length - rm[1].length - 1; if ((LEX.isFirstName(rm[1]) || !LEX.isDictWord(rm[1])) && !LEX.isClinical(rm[1]) && free(a, a + rm[1].length)) add.push({ start: a, end: a + rm[1].length, type: 'NAME_OTHER', source: 'strict', conf: 0.5 }); } }
    const NICK_CUE = /\b(?:goes\s+by|go(?:es)?\s+by|known\s+as|a\.?k\.?a\.?|nick-?named|prefers\s+to\s+be\s+called|likes\s+to\s+be\s+called|call\s+(?:him|her|them)|calls\s+(?:him|her)self)\s+["“']?(\p{Lu}[\p{Ll}'’]{1,14})/gu;
    while ((m = NICK_CUE.exec(text))) {
      if (LEX.isClinical(m[1]) || !nickOk(m[1])) continue;
      const a = m.index + m[0].length - m[1].length; nicks.add(m[1]);
      if (free(a, a + m[1].length)) add.push({ start: a, end: a + m[1].length, type: 'NAME_OTHER', source: 'strict', conf: 0.5 });
    }
    const firstNames = new Set();
    nameSpans.forEach((sp) => { const w = (text.slice(sp.start, sp.end).match(/^\p{Lu}[\p{Ll}'’]+/u) || [])[0]; if (w && w.length >= 3 && LEX.isFirstName(w)) firstNames.add(w); });
    if (nicks.size || firstNames.size) {
      for (const t of toks) {
        if (!t.word || !free(t.start, t.end)) continue;
        if (nicks.has(t.core)) { add.push({ start: t.start, end: t.end, type: 'NAME_OTHER', source: 'strict', conf: 0.5 }); continue; }
        if (!firstNames.has(t.core)) continue;
        const nx = text.slice(t.end, t.end + 24);
        if (/^\s+(?:will|would|is|was|has|had|can|could|should|says|said|reports|reported|called|asked|wants|states|stated|denies|tolerated|returns|returned|arrived|left|declined|agreed|feels|felt)\b/.test(nx) || /^['’]s\b/.test(nx)) add.push({ start: t.start, end: t.end, type: 'NAME_OTHER', source: 'strict', conf: 0.5 });
      }
    }
    // a word-name doing what people do: "Will says his wife…", "Grace called back" (a modal or noun is never followed by
    // a reporting verb in the third person); and a lower-case first name right before a phone number ("gladys # 555-0144")
    for (let i = 0; i < toks.length - 1; i++) {
      const t = toks[i]; if (!t.word || !free(t.start, t.end)) continue;
      const nx = text.slice(t.end, t.end + 30);
      const pv = toks[i - 1]; const inPhrase = pv && pv.word && pv.cap && /^\s$/.test(text.slice(pv.end, t.start)) && (LEX.isDictWord(pv.core) || LEX.isClinical(pv.core));
      if (t.cap && !inPhrase && t.core.length >= 3 && LEX.isFirstName(t.core) && !DRUG_STEM.test(t.core) && /^\s+(?:to\s+(?:pick|drive|bring|take|come|stay|call|help|sign)|says|said|reports|reported|states|stated|wants|wanted|asks|asked|called|calls|denies|denied|agrees|agreed|declines|declined|feels|felt|tolerated|arrived|requests|requested|prefers|confirmed|confirms|texted|emailed|phoned|asking|brought|brings|visited|visits|came|comes|drove|drives|picked|signed|stayed|left\s+a)\b/.test(nx)) { add.push({ start: t.start, end: t.end, type: 'NAME_OTHER', source: 'strict', conf: 0.5 }); continue; }
      if (/^[\p{Ll}]/u.test(t.core) && t.core.length >= 3 && LEX.isFirstName(t.core) && !LEX.isEnglishWord(t.core) && /^\s*(?:#|:|at|cell|ph|phone|tel)?\s*\(?\d{3}\)?[\s.\-]?\d{3,4}/i.test(nx)) add.push({ start: t.start, end: t.end, type: 'NAME_OTHER', source: 'strict', conf: 0.5 });
    }
    // "Pt May Tran": a first name that is also a word, between a patient cue and a name already found, is part of the name
    for (const sp of nameSpans) {
      const lead = text.slice(Math.max(0, sp.start - 40), sp.start).match(/\b(?:Pt|Pat|Patient|Mr|Mrs|Ms|Miss|Mx)\.?:?\s+(\p{Lu}[\p{Ll}'’]+)\s$/u);
      if (!lead || !LEX.isFirstName(lead[1])) continue;
      const a = sp.start - 1 - lead[1].length;
      if (free(a, a + lead[1].length)) add.push({ start: a, end: a + lead[1].length, type: 'NAME_OTHER', source: 'strict', conf: 0.5 });
    }
    // where someone is staying or living: "staying with niece in Quincy this week", "moved in with her son in Brockton"
    const STAY_IN = /\b(?:staying|stays|stay|lives|living|live|moved|moving|visiting|relocat\w*|summers?|winters?)\b(?:\s+[\p{L}'’]+){0,4}?\s+in\s+(\p{Lu}[\p{Ll}'’]+(?:\s\p{Lu}[\p{Ll}'’]+)?)/gu;
    while ((m = STAY_IN.exec(text))) {
      const v = m[1], a = m.index + m[0].length - v.length;
      if (LEX.isClinical(v.split(' ')[0]) || /^(?:Bay|Chair|Room|Pod|Unit|Clinic|Hospice|Rehab|Assisted|Memory|January|February|March|April|May|June|July|August|September|October|November|December|Spring|Summer|Fall|Winter)$/i.test(v.split(' ')[0])) continue;
      if (free(a, a + v.length)) add.push({ start: a, end: a + v.length, type: 'LOCATION', source: 'strict', conf: 0.5 });
    }
    // a ZIP on its own after a place or name the screen reader split from its state ("Verlander      91770; transport van")
    spans.concat(add).filter((sp) => sp.type === 'LOCATION' || /^NAME/.test(sp.type)).forEach((sp) => {
      const z = text.slice(sp.end, sp.end + 160).match(/^(?:,\s*|\s{2,}|\s*\n\s*)(\d{5})(?:-\d{4})?(?![\d\/:.\-])(?!\s*(?:mg|mcg|ml|mL|units?|cells|copies|iu|k\b|x\b))/);
      if (!z) return; const a = sp.end + z[0].length - z[1].length;
      if (free(a, a + 5)) add.push({ start: a, end: a + 5, type: 'ZIP', source: 'strict', conf: 0.5 });
    });
    // a known city after a place cue even when it is also a word or a name ("late from Bridgeport traffic", "from Mobile")
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i], p = toks[i - 1];
      if (!t.word || !t.cap || !p.word || !/^(?:from|in|to|near|outside|toward|towards)$/i.test(p.core) || !free(t.start, t.end)) continue;
      { const n = toks[i + 1]; if (n && n.word && n.cap && /^\s$/.test(text.slice(t.end, n.start)) && /^\p{Lu}\p{Ll}{2,}$/u.test(t.core) && /^\p{Lu}\p{Ll}{2,}$/u.test(n.core) && /^(?:from|in|near|outside)$/i.test(p.core) && (LEX.CITY_SET.has(`${t.core} ${n.core}`.toLowerCase()) || (![t.core, n.core].some((w) => LEX.isClinical(w) || STRICT_SKIP.test(w) || LEX.ORG_NAMEWORD_SET.has(w.toLowerCase()) || LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) || LEX.GEO_SUFFIX_SET.has(w.toLowerCase()) || monthIndex(w)) && [t.core, n.core].some((w) => !LEX.isDictWord(w) || LEX.isFirstName(w) || LEX.isSurname(w)) && /^\s*(?:[,.;:)]|$|\s+(?:in|on|at|for|by|this|today|yesterday|last|next|and|to|with)\b)/.test(text.slice(n.end, n.end + 12)))) && free(t.start, n.end)) { add.push({ start: t.start, end: n.end, type: 'LOCATION', source: 'strict', conf: 0.5 }); continue; } }
      if (!/^\p{Lu}\p{Ll}{2,}(?:[\s\-]\p{Lu}\p{Ll}+)?$/u.test(t.core)) continue;
      if (!LEX.CITY_SET.has(t.core.toLowerCase()) && (LEX.isDictWord(t.core) || LEX.isClinical(t.core) || STRICT_SKIP.test(t.core) || DRUG_STEM.test(t.core) || /^[A-Z]{2,}$/.test(t.core) || monthIndex(t.core))) continue;
      if (LEX.isClinical(t.core) && !/^(?:from|near|outside)$/i.test(p.core)) continue;
      add.push({ start: t.start, end: t.end, type: 'LOCATION', source: 'strict', conf: 0.5 });
    }
    // an age of 90 or more said in words around it: "mom is 97 now", "she turned 93", "will be 91 next week"
    const AGE_SAID = /\b(?:is|turned|turns|will\s+be|was)\s+(9\d|1[01]\d)(?=\s+(?:now|today|this|next|last|years?|yrs?|y\.?o\.?|year[-\s]old)\b|\s*(?:[.,;!]|$))/gi;
    while ((m = AGE_SAID.exec(text))) {
      const a = m.index + m[0].length - m[1].length;
      const lead = text.slice(Math.max(0, m.index - 30), m.index);
      if (/(?:sat|spo2|o2|pulse|hr|heart\s+rate|bp|temp|weight|wt|glucose|bg|sugar|score|level|count|plt|platelets?|rate|%)\W*$/i.test(lead)) continue;
      if (free(a, a + m[1].length)) add.push({ start: a, end: a + m[1].length, type: 'AGE', source: 'strict', conf: 0.5 });
    }
    if (!add.length) return spans;
    add.forEach((x) => { x.text = text.slice(x.start, x.end); });
    return spans.concat(add).sort((a, b) => a.start - b.start);
  }

  function detectTextCore(text, ctx) {
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
      if (ctx.propagateRegex.places) {
        const pl = ctx.propagateRegex.places; pl.lastIndex = 0;
        while ((m = pl.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, type: 'LOCATION', source: 'propagate', conf: 0.6, text: m[0], fullText: text });
      }
      if (ctx.propagateRegex.handleParts) {
        const hp = ctx.propagateRegex.handleParts; hp.lastIndex = 0;
        while ((m = hp.exec(text))) spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'propagate', conf: 0.6, text: m[0], fullText: text });
      }
      const amb = ctx.rowAmbiguous || null;
      if (amb) {
        amb.lastIndex = 0;
        while ((m = amb.exec(text))) {
          const before = text.slice(Math.max(0, m.index - 40), m.index), after = text.slice(m.index + m[0].length); // a bounded look back
          // sentence-initial: "Will call", "- Grace noted" stay; a person verb or a possessive after it makes it the person
          // already named in full ("Grace Bishop tolerated ... Grace states she will", "Hope's ride")
          const sentenceStart = /(?:^|[.!?:;\n]\s*|^\s*[-•*]\s*|\s[-–—|]\s*)$/.test(before);
          if ((sentenceStart || (amb.cueOnly && amb.cueOnly.has(m[0]))) && !/^(?:['’]s\b|\s+(?:states|stated|says|said|reports|reported|reporting|tolerated|tolerating|called|calls|phoned|texted|emailed|asked|asks|wants|wanted|prefers|preferred|denies|denied|agrees|agreed|declined|declines|refused|refuses|arrived|arrives|feels|felt|verbalized|verbalizes|understands|endorses|complains|c\/o|presents|presented|returned|requests|requested|confirmed|confirms|tolerates|voiced|expressed|admits|admitted)\b)/i.test(after)) continue;
          const nextWord = (after.match(/^(?:['’]s?)?\s+([A-Za-z]+)/) || [])[1];
          if (nextWord && (LEX.EPONYM_FOLLOW.has(nextWord.toLowerCase()) || /^(to|be|need|needs|call|chart|insurance|for|from|and)$/i.test(nextWord) && /^(will|hope|mark|bill|may|grant|chase|rose|faith|joy|sue|pat|art|guy|bob)$/i.test(m[0]))) continue;
          spans.push({ start: m.index, end: m.index + m[0].length, type: 'NAME_OTHER', source: 'propagate', conf: 0.6, text: m[0], fullText: text });
        }
      }
    }
    // a given name or nickname in brackets right after a name ("also Szymanska-Ruiz (Paulina)", "Quist, Bart (Bartholomew)")
    spans.filter((s) => COARSE(s.type) === 'NAME').forEach((s) => {
      const pm = text.slice(s.end).match(/^(?:['’]s)?\s*\(\s*(\p{Lu}[\p{Ll}'’\-]{2,})\s*\)/u);
      if (!pm) return;
      const w = pm[1], lw = w.toLowerCase();
      if (LEX.isClinical(w) || relWord(w) || COMMON_CAP.has(lw) || COMMON_LOWER.has(lw) || monthIndex(w) || LEX.CREDENTIAL_SET.has(lw) || LEX.CITY_SET.has(lw) || LEX.STATE_NAME_SET.has(lw) || NONNAME_END.test(w) || LEX.ORG_SUFFIX_SET.has(lw) || LEX.ORG_NAMEWORD_SET.has(lw) || LEX.ORG_PREFIX_SET.has(lw) || /^(?:epic|mychart|cerner|zoom|teams|portal|agency)$/.test(lw) || (cfg.allowSet && cfg.allowSet.has(lw))) return;
      if (!LEX.isFirstName(w) && (/(?:ed|ing|ly|ive|ous|ful|ic|ary|ory|ish|ese)$/.test(lw) || /^(?:english|spanish|french|arabic|russian|polish|somali|primary|secondary|deceased|spouse|retired|adopted|biological|legal|estranged|preferred|nickname|alias|maiden|former|verbal|written|phone|cell|home|work|self|same|none|unknown|declined|pending|inactive|active|outside|external|internal|local|other)$/.test(lw))) return;
      const st = s.end + pm[0].indexOf(w, pm[0].indexOf('('));
      if (spans.some((x) => x.start <= st && x.end >= st + w.length)) return;
      spans.push({ start: st, end: st + w.length, type: 'NAME_OTHER', source: 'cue:bracket', conf: 0.7, text: w, fullText: text });
    });
    const frag = ctx.fragments && ctx.cellKey && ctx.rowPatientKey ? ctx.fragments[ctx.cellKey] : null;
    if (frag) frag.forEach((f) => { if (f.end <= text.length) spans.push({ start: f.start, end: f.end, type: 'NAME_PATIENT', source: 'census', entity: ctx.rowPatientKey, fragment: f.part, conf: 1, text: text.slice(f.start, f.end), fullText: text }); });
    const manual = ctx.manual && ctx.cellKey ? ctx.manual[ctx.cellKey] : null;
    if (manual) {
      if (manual.remove) spans = spans.filter((s) => !manual.remove.some((r) => r[0] === s.start && r[1] === s.end));
      if (manual.add) manual.add.forEach((a) => { if (!(a && a.end > a.start && a.start >= 0 && a.end <= text.length)) return; spans.push({ start: a.start, end: a.end, type: TYPES[a.type] ? a.type : 'NAME_OTHER', source: 'manual', conf: 1, text: text.slice(a.start, a.end), fullText: text, manual: true }); });
    }
    let out = mergeAdjacentNames(resolveSpans(spans), text);
    if (cfg.layers.model) out = finishNames(text, out, cfg);
    out = compoundNameParts(text, out, ctx);
    out = numberAfterName(text, out);
    if (cfg.strict) out = strictSpans(text, out, cfg);
    if (manual && manual.remove) {
      // a removed span must stay removed even if a merged/propagated span re-covers exactly it
      for (const r of manual.remove) { const i = out.findIndex((s) => s.start === r[0] && s.end === r[1] && !s.manual); if (i >= 0) out.splice(i, 1); }
    }
    out.forEach((s) => { s.text = text.slice(s.start, s.end); delete s.fullText; });
    return out;
  }

  // Collect tokens worth propagating from a set of spans (document-level).
  function collectPropagation(allSpans, cfg) {
    const terms = new Set(), ambTerms = new Set(), handleParts = new Set(), placeTerms = new Set(), cueOnly = new Set();
    const titleCase = (w) => w.toLowerCase().replace(/(^|[-'’])([a-z])/g, (m, a, b) => a + b.toUpperCase());
    for (const s of allSpans) {
      // the words of a user name or e-mail address ("rosie.delgado62", "lally.marchbanks@...") are the person's names, and
      // are written in lower case elsewhere in the same message ("hi its rosie")
      if ((s.type === 'EMAIL' || (s.type === 'ID_OTHER' && s.handle)) && s.text) {
        const local = s.text.split('@')[0].replace(/^@/, '');
        local.split(/[^A-Za-z]+/).forEach((w) => { if (w.length >= 4 && !COMMON_CAP.has(w.toLowerCase()) && !LEX.isClinical(w) && !LEX.isAmbiguous(w) && !LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) && !LEX.ORG_NAMEWORD_SET.has(w.toLowerCase()) && !/^(?:user|admin|info|mail|noreply|reply|office|dept|nurse|clinic|health|care|team|help|support|contact|example|test|mychart|portal)$/i.test(w)) handleParts.add(w.toLowerCase()); });
        continue;
      }
      // a town fixed by a street address, a ZIP or a state ("19 Tamarack Ln, Ashgrove 04120") is the same place when it is
      // named again without them ("Disconnect at Ashgrove home")
      if ((s.type === 'LOCATION' || s.type === 'ZIP') && s.source === 'rule' && s.text) {
        const town = s.text.replace(/,?\s*(?:[A-Z]{2}\s+)?\d{5}(?:-\d{4})?\s*$/, '').replace(/,?\s+[A-Z]{2}$/, '').trim();
        const ws = town.split(/\s+/);
        if (town.length >= 4 && ws.length <= 3 && ws.every((w) => /^[A-Z][a-z'’\-]+$/.test(w)) && !(ws.length === 1 && (LEX.isClinical(town) || COMMON_CAP.has(town.toLowerCase()) || COMMON_LOWER.has(town.toLowerCase()) || LEX.isAmbiguous(town) || LEX.isFirstName(town) || PLACE_WORD.test(town) || LEX.ORG_SUFFIX_SET.has(town.toLowerCase()) || LEX.ORG_NAMEWORD_SET.has(town.toLowerCase()) || town.length < 5))) placeTerms.add(town);
        continue;
      }
      if (COARSE(s.type) !== 'NAME' || s.source === 'census' || s.source === 'propagate' || s.initials) continue;
      const full = s.text.trim();
      if (full.length >= 4 && /\s/.test(full)) terms.add(full);
      // dotted initials used as a name ("goes by T.J.", "Pt J.R. Whitcombe"): the initials alone are re-found ("T.J. reports")
      (full.match(/(?<![\w.])(?:[A-Z]\.){1,2}[A-Z](?![\w])/g) || []).forEach((x) => { if (!/^(?:I\.V|P\.O|N\.P\.O|R\.N|M\.D|D\.O|N\.P|P\.A|A\.M|P\.M|U\.S|D\.C|B\.I\.D|T\.I\.D|Q\.I\.D|P\.R\.N|E\.R|S\.C|I\.M)$/.test(x)) terms.add(x); });
      const parts = full.split(/[\s,]+/).filter(Boolean);
      for (const tok of parts) {
        const core = tok.replace(/['’]s$/, '').replace(/\.$/, '');
        if (core.length < 3 || !/^[A-Z]/.test(core)) continue;
        if (LEX.HONORIFIC_SET.has(core.toLowerCase()) || LEX.CREDENTIAL_SET.has(core.toLowerCase())) continue;
        if (cfg.allowSet && cfg.allowSet.has(core.toLowerCase())) continue;
        // a month that is also a given name (June, April) of a full name found by a cue: re-found only right before a person
        // verb or a possessive ("June's husband", "April called back"), never as the month ("in June", "June 5")
        if (LEX.isClinical(core)) { if (monthIndex(core) && LEX.isFirstName(core) && parts.length >= 2 && core.length >= 4) { const tc = titleCase(core); ambTerms.add(tc); cueOnly.add(tc); } continue; }
        // a word-name (Grace, Will, Hope) of a full name found by a cue is re-found elsewhere, but only mid-sentence
        // (see detectText), so "Told Grace that is fine" is caught while "Will call back" stays
        if (LEX.isAmbiguous(core)) { if (parts.length >= 2) ambTerms.add(core.length > 1 && core === core.toUpperCase() ? titleCase(core) : core); continue; }
        terms.add(core);
        // an ALL-CAPS name (MARGARITA ELENA RUIZ) is written in Title Case elsewhere in the note (Thank you, Margarita)
        if (core === core.toUpperCase() && /[A-Z]{3}/.test(core)) terms.add(titleCase(core));
      }
    }
    if (!terms.size && !ambTerms.size && !handleParts.size && !placeTerms.size) return null;
    const mk = (set) => new RegExp(`(?<![A-Za-z0-9])(?:${[...set].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'g'); // case-sensitive on purpose
    const re = terms.size ? mk(terms) : /(?!)/g;
    re.terms = [...terms];
    re.ambiguous = ambTerms.size ? mk(ambTerms) : null;
    if (re.ambiguous) re.ambiguous.cueOnly = cueOnly;
    re.places = placeTerms.size ? mk(placeTerms) : null;
    re.handleParts = handleParts.size ? new RegExp(`(?<![A-Za-z0-9])(?:${[...handleParts].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
    return re;
  }
  // names held in identifier columns that are removed (Emergency Contact, Guarantor, Subscriber): a relative listed there
  // is usually mentioned by name in the comments ("Henrik waits in lobby")
  const PERSON_COLUMN = /\b(?:emergency|contact|guarantor|subscriber|kin|nok|caregiver|spouse|relative|family|proxy|poa|visitor|driver|escort|responsible|parent|guardian|insured)\b/i;
  function columnNameSpans(headers, rows, columns) {
    const out = [];
    columns.forEach((col) => {
      // a person column kept as free text (Visitor(s), Contact) holds short lists of people ("Yumi N. + grandson Kenta")
      const textPerson = col.role === 'text' && PERSON_COLUMN.test(col.header || '') && !/\b(?:notes?|comments?|remarks?|log|history|instructions?)\b/i.test(col.header || '');
      if ((col.role !== 'drop' && !textPerson) || !PERSON_COLUMN.test(col.header || '')) return;
      rows.forEach((row) => {
        const v = cellToString(row[col.index]).trim(); if (!v) return;
        if (textPerson && (v.split(/\s+/).length > 8 || /[.!?]\s+\p{Lu}\p{Ll}/u.test(v))) return; // a sentence, not a list of people
        const m = v.match(/^([A-Z][A-Za-z'’\-]+(?:\s[A-Z][A-Za-z'’\-]+)?),\s*([A-Z][A-Za-z'’\-]+)/) || v.match(/^([A-Z][a-z][A-Za-z'’\-]+)\s+([A-Z][A-Za-z'’\-]+)(?=\s|$|\()/);
        const orgish = (w) => w.split(/[\s\-]+/).some((x) => { const l = x.toLowerCase(); return LEX.ORG_SUFFIX_SET.has(l) || LEX.ORG_NAMEWORD_SET.has(l) || LEX.ORG_PREFIX_SET.has(l) || COMMON_CAP.has(l); });
        if (m && [m[1], m[2]].some(orgish)) return; // "Home Health Aide", "Hospice of Buffalo": an agency, not a person
        if (m && ![m[1], m[2]].some((w) => LEX.isClinical(w) || /^(self|same|none|n\/a|patient|pt)$/i.test(w))) { out.push({ type: 'NAME_OTHER', source: 'column', text: m[0], start: 0, end: m[0].length }); return; }
        // "Wife - Lorna 555-0149 cell", "neighbor Mrs. Fenwick 555 0173": every capitalized word of the cell that is not a
        // relation, title, label or clinical word is a name of that contact
        (v.match(/\p{Lu}[\p{Ll}'’\-]{2,}/gu) || []).forEach((w) => {
          const lw = w.toLowerCase();
          if (LEX.isClinical(w) || relWord(w) || LEX.HONORIFIC_SET.has(lw) || LEX.CREDENTIAL_SET.has(lw) || COMMON_CAP.has(lw) || COMMON_LOWER.has(lw) || monthIndex(w) || LEX.ORG_SUFFIX_SET.has(lw) || LEX.ORG_NAMEWORD_SET.has(lw) || LEX.ORG_PREFIX_SET.has(lw) || LEX.CITY_SET.has(lw) || LEX.STATE_NAME_SET.has(lw) || /^(?:epic|mychart|cerner|zoom|teams|portal|agency|services|aide|nursing)$/.test(lw) || /^(?:self|same|none|patient|cell|home|work|mobile|listed|unknown|declined|other|primary|alternate|alt|legal|guardian|spouse|emergency|contact|text|only|call|phone)$/i.test(w)) return;
          out.push({ type: 'NAME_OTHER', source: 'column', text: w, start: 0, end: w.length });
        });
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
    // every name word the census knows for a patient, with the diminutives the self-check looks for (Xander of Alexander):
    // a made-up name equal to one of them would read as a real patient's name and block the download
    const censusWords = new Set();
    if (census && census.patients) for (const p of [...census.patients.values(), ...(census.known ? census.known.values() : [])]) {
      [...[...p.names].map(parseName), p.parsed].filter(Boolean).forEach((pn) => {
        [pn.first, pn.last, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((t) => { if (t) t.toLowerCase().split(/[-\s]+/).forEach((h) => { if (h) censusWords.add(h); }); });
        if (pn.first) LEX.nicknamesOf(pn.first).forEach((n) => censusWords.add(n.toLowerCase()));
      });
      if (p.entity && p.entity.nicks) p.entity.nicks.forEach((n) => String(n).toLowerCase().split(/[\s,]+/).forEach((h) => { if (h) censusWords.add(h); }));
    }
    // once a pool is exhausted, invent a plain capitalized word from two pool entries (Ash+well → Ashwell)
    const invent = (pool) => {
      for (let tries = 0; tries < 200; tries++) {
        const a = pool[Math.floor(rng() * pool.length)], b = pool[Math.floor(rng() * pool.length)];
        const w = a.slice(0, Math.max(2, Math.ceil(a.length / 2))) + b.slice(Math.floor(b.length / 2)).toLowerCase();
        const x = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
        const k = x.toLowerCase();
        if (x.length >= 4 && x.length <= 12 && !taken.has(k) && !docWords.has(k) && !realWords.has(k) && !censusWords.has(k) && !nearReal(k) && !LEX.isFirstName(x) && !LEX.isSurname(x) && !LEX.isAmbiguous(x) && !LEX.isClinical(x)) return x;
      }
      // nothing left: a pool entry with a number, still never one carrying a patient's name word
      const safe = pool.filter((x) => !censusWords.has(x.toLowerCase()) && !censusWordIn(x.toLowerCase()));
      const base = safe.length ? safe[Math.floor(rng() * safe.length)] : 'Name';
      return base + String(Math.floor(rng() * 90) + 10);
    };
    // a made-up name one letter away from a real word of the session (Gwendolen for a real Gwendolyn) reads as a misspelled
    // real name, so it is avoided too: every real word of 5+ letters and its one-letter deletions, compared with the candidate's
    let near = null;
    const nearReal = (k) => {
      if (k.length < 5) return false;
      // (the session's real words and every name word of a listed patient: a made-up "Okonkow" would read as a misspelled
      // real patient's name, and the self-check looks for those)
      if (!near) { near = new Set(); for (const w of [...realWords, ...censusWords]) { if (w.length < 4 || w.length > 40) continue; /* a 30,000-letter "word" would cost 30,000 copies of itself */ near.add(w); for (let i = 0; i < w.length; i++) near.add(w.slice(0, i) + w.slice(i + 1)); } }
      if (near.has(k)) return true;
      for (let i = 0; i < k.length; i++) if (near.has(k.slice(0, i) + k.slice(i + 1))) return true;
      return false;
    };
    // a pool entry of several words (an organization: "Brightwater Insurance") must not carry a patient's name word either
    const censusWordIn = (k) => /[\s\-]/.test(k) && k.split(/[^a-z'’]+/).some((w) => w && censusWords.has(w));
    const pick = (pool) => {
      const fresh = pool.filter((x) => { const k = x.toLowerCase(); return !docWords.has(k) && !taken.has(k) && !realWords.has(k) && !censusWords.has(k) && !censusWordIn(k) && !nearReal(k); });
      const x = fresh.length ? fresh[Math.floor(rng() * fresh.length)] : invent(pool);
      taken.add(x.toLowerCase());
      return x;
    };
    const randDigits = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rng() * 10); return s; };
    // digit strings of 7+ digits written in the document (phones, record numbers), separators removed
    let digitRuns = null;
    // does a candidate contain one of them? (every substring of 7+ digits looked up in a set: a document with thousands of
    // phone numbers costs a few lookups per fake, not a scan of every number)
    let digitRunSet = null;
    const containsRealRun = (fake) => { if (!digitRunSet) digitRunSet = new Set(realDigitRuns()); if (!digitRunSet.size) return false; for (let len = 7; len <= Math.min(12, fake.length); len++) for (let i = 0; i + len <= fake.length; i++) if (digitRunSet.has(fake.slice(i, i + len))) return true; return false; }; // the runs are 7-12 digits long
    // the digits of every census identifier (record numbers, accounts, phones of the patients of this input and of the
    // session), leading zeros stripped, 5+ digits: a made-up phone or number must not contain one, or it would read as that
    // patient's identifier ("(555) 010-1567" carries MRN 000101567) and the self-check would block the file
    let censusIdSet = null;
    const censusIds = () => {
      if (censusIdSet) return censusIdSet;
      censusIdSet = new Set();
      if (census && census.patients) for (const p of [...census.patients.values(), ...(census.known ? census.known.values() : [])]) {
        [...(p.mrns || []), ...(p.accounts || []), ...(p.phones || [])].forEach((x) => { const d = cellToString(x).replace(/\D/g, ''); const k = d.replace(/^0+/, ''); if (k.length >= 5 && k.length <= 20) censusIdSet.add(k); if (d.length === 11 && d[0] === '1') censusIdSet.add(d.slice(1)); });
      }
      return censusIdSet;
    };
    const containsCensusId = (fake) => {
      const ids = censusIds(); if (!ids.size) return false;
      const d = String(fake).replace(/\D/g, '');
      for (let i = 0; i < d.length; i++) { if (d[i] === '0') continue; for (let len = 5; len <= 20 && i + len <= d.length; len++) if (ids.has(d.slice(i, i + len))) return true; }
      return false;
    };
    // a made-up number is drawn again (a few times) while it carries a real number of the document or a census identifier
    const freshNumber = (make) => { let out = make(); for (let tries = 0; tries < 40 && (containsCensusId(out) || containsRealRun(String(out).replace(/\D/g, ''))); tries++) out = make(); return out; };
    const realDigitRuns = () => digitRuns || (digitRuns = [...new Set([/\d[\d \t().\-]{5,}\d/g, /\(?\d{3}\)?[ .\-]?\d{3}[ .\-]?\d{4}/g, /\d{3}[ .\-]?\d{4}/g].flatMap((re) => (documentText || '').match(re) || []).map((x) => x.replace(/\D/g, '')).filter((x) => x.length >= 7 && x.length <= 12))]);
    const range = cfg.surrogate.shiftRange || [30, 365];
    // A date written without a year ("11/24", "Nov 30") moves by the offset modulo a year: an offset near a whole year
    // (340 or 365 days) would leave it almost or exactly where it was. Such a draw is drawn again, so a year-less date
    // always moves by at least the smallest shift of the range (a few tries; a range that allows nothing else keeps its draw).
    const randOffset = () => {
      let mag = range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
      for (let tries = 0; tries < 24 && Number.isFinite(mag) && range[0] > 0; tries++) {
        const r = ((mag % 365) + 365) % 365;
        if (Math.min(r, 365 - r) >= range[0]) break;
        mag = range[0] + Math.floor(rng() * (range[1] - range[0] + 1));
      }
      return rng() < 0.5 ? -mag : mag;
    };

    const patientInfo = new Map(); // key -> {code, fakeFirst, fakeLast, offset}
    const providerInfo = registry.providers; // provider key -> {code, fakeFirst, fakeLast, last, first, credentials}
    const tokenMap = registry.tokenMap; // lowercased real name token -> fake token (third parties and providers)
    const stringMap = registry.strings; // type|lower -> fake (phones, emails, orgs, places, ids)
    // rows with no patient shift by one document offset, drawn once per session so a re-run of the same input is identical
    if (registry.docOffset == null || (cfg.surrogate.dateShift && registry.docOffset === 0)) registry.docOffset = cfg.surrogate.dateShift ? randOffset() : 0;
    const docOffset = cfg.surrogate.dateShift ? registry.docOffset : 0;
    const mapping = { patients: [], providers: [], others: [] };
    // real words of this document are never handed out as surrogates, now or in a later input of the session
    for (const w of docWords) if (w.length >= 3 && w.length <= 40) realWords.add(w);

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
    const matchCase = (orig, fake) => (orig === orig.toUpperCase() && /[A-Z]/.test(orig) ? fake.toUpperCase() : orig === orig.toLowerCase() && /[a-z]{2}/.test(orig) ? fake.toLowerCase() : fake);

    // Render a name surrogate in the same shape as the original text.
    const renderName = (origText, parsedEntity, info, mode) => {
      if (mode === 'code') return info.code;
      const parsed = parseName(origText);
      if (!parsed) return `${info.fakeLast}, ${info.fakeFirst}`;
      // only a credential or punctuation ("DO" of a patient surnamed Do, written after another doctor's name): no name to render
      if (!parsed.first && !parsed.last) return origText;
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
        else if (parsedEntity && parsedEntity.first && lower.length >= 3 && parsedEntity.first.toLowerCase().startsWith(lower)) out = info.fakeFirst; // "Finn" of Finnegan
        else if (parsedEntity && (parsedEntity.nicks || []).some((n) => n.toLowerCase() === lower)) out = info.fakeFirst; // a preferred name
        else if (parsedEntity && parsedEntity.first && /[-\s]/.test(parsedEntity.first) && parsedEntity.first.toLowerCase().split(/[-\s]+/).concat(parsedEntity.first.toLowerCase().replace(/[-\s]+/g, '')).includes(lower)) out = info.fakeFirst; // "Mikyung", "Kyung" of Mi-Kyung
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
      if (/\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/i.test(orig)) return `555-010-${randDigits(4)}`;
      const extM = orig.slice(-40).match(/\s{0,4}(?:x|ext\.?|extension)\s{0,4}\.?\s{0,4}\d{1,6}$/i); // looked for in the last characters only
      const main = extM ? orig.slice(0, orig.length - extM[0].length) : orig, ext = extM ? extM[0] : '';
      const n = (main.match(/\d/g) || []).length;
      // the fake's digits must never contain a real number of the document ("555-010-2437" spells out a real "555-0102") or
      // a census identifier
      return freshNumber(() => {
        const fake = (n === 7 ? '555' : n === 11 && /^\+?1/.test(main.trim()) ? '1555010' : '555010') + randDigits(4);
        let di = 0;
        const out = main.replace(/\d/g, () => fake[di++] != null ? fake[di - 1] : randDigits(1));
        return out + ext.replace(/\d/g, () => randDigits(1));
      });
    });
    // a bare 10-digit number has the shape of a phone number: give it the 555-010 shape rather than digits that could be dialled
    const fakeDigits = (type, orig) => stringSurrogate(type, orig, () => freshNumber(() => (orig.replace(/\D/g, '').length === 10 && !/[A-Za-z]/.test(orig)) ? (() => { const d = ('555010' + randDigits(4)).split(''); let i = 0; return orig.replace(/\d/g, () => d[i++]); })() : orig.replace(/\d/g, () => randDigits(1)).replace(/^(\D*)\d/, '$19')));
    // Other identifiers: numeric/alphanumeric codes keep their shape with new digits; user names and handles
    // (letters that may spell a name) are replaced wholesale so no name fragment survives.
    const fakeId = (orig) => stringSurrogate('ID', orig, () => freshNumber(() => {
      if (/[a-z]{3,}/.test(orig) || /^@/.test(orig)) return orig.replace(/^(@?)[A-Za-z][\w.\-]*/, (m, at) => `${at}user${randDigits(4)}`);
      if (orig.replace(/\D/g, '').length === 10 && !/[A-Za-z]/.test(orig)) { const d = ('555010' + randDigits(4)).split(''); let i = 0; return orig.replace(/\d/g, () => d[i++]); }
      return orig.replace(/\d/g, () => randDigits(1)).replace(/^(\D*)\d/, '$19').replace(/[A-Z]/g, () => String.fromCharCode(65 + Math.floor(rng() * 26)));
    }));

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
            if (span.entity && span.fragment) { const info = ensurePatient(span.entity); if (mode === 'code') return span.fragment === 'cont' ? '' : info.code; return span.fragment === 'cont' ? '' : matchCase(orig, span.fragment === 'first' ? info.fakeFirst : info.fakeLast); } // a piece of a word broken by a narrow column
            // a misspelled surname with the patient's initial or given name after it ("Okonkow C."): written as surname + initial
            const lf = span.entity && span.lastFirst && span.lastFirst.len === orig.length ? span.lastFirst : null;
            if (lf) { const info = ensurePatient(span.entity); if (mode === 'code') return info.code; const tail = orig.slice(lf.tailAt); return matchCase(orig.slice(0, lf.lastLen), info.fakeLast) + orig.slice(lf.lastLen, lf.tailAt) + (lf.initial ? info.fakeFirst[0].toUpperCase() + (tail.endsWith('.') ? '.' : '') : matchCase(tail, info.fakeFirst)); }
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
            if (span.type === 'DOB' && cfg.surrogate.dob !== 'shift') return cfg.surrogate.dob === 'year' && pd && pd.hasYear && new Date().getFullYear() - pd.y < 90 ? String(pd.y) : '[dob]';
            if (!cfg.surrogate.dateShift) return span.type === 'DOB' ? '[dob]' : '[date]';
            if (!pd || pd.kind === 'ord') return '[date]'; // a bare day of the month: no month to shift it within
            const key = span.entity || rowPatientKey;
            const off = key ? ensurePatient(key).offset : docOffset;
            return renderDate(pd, shiftDate(new Date(pd.y, pd.m - 1, pd.d), off));
          }
          case 'AGE': return orig.replace(/(?<!\d)(9\d|1[0-2]\d)(?:st|nd|rd|th)?(?!\d)/, '90+').replace(/\b(9|10)0s\b/, '90s+').replace(/nonagenarian|centenarian/i, '90+ y/o')
            .replace(/\b(?:ninety|one[-\s]hundred)(?:(?:[-\s]|\s+and\s+)(?:one|two|three|four|five|six|seven|eight|nine))?/i, '90+');
          case 'ADDRESS': return stringSurrogate('ADDRESS', orig, () => {
            if (/\bbox\b/i.test(orig)) return orig.replace(/\d+(?!.*\d)/, () => String(Math.floor(rng() * 9000) + 1000)).replace(/^(?:RR|R\.R\.|Rural\s+Route|HC)\s*\d+/i, (m) => m.replace(/\d+/, () => String(Math.floor(rng() * 9) + 1)));
            if (RULES.ADDRESS_UNIT.source && /(?:apt|apartment|unit|suite|ste|#)\.?\s*#?[A-Za-z]?\d+[A-Za-z]?$/i.test(orig) && !/\b(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl)\b/.test(orig)) return `${(Math.floor(rng() * 880) + 120)} ${pick(LEX.FAKE_LAST)} Rd`; const suf = (orig.match(/\b(Rd|Dr|St|Ave|Blvd|Pkwy|Ln|Ct|Hwy|Rte|Route|Way|Pl|Cir|Ter|Trl|Street|Avenue|Road|Drive|Lane|Court|Place|Boulevard|Parkway)\.?(?=\W*$|\s)/) || [])[1] || (/^\d/.test(orig) ? 'St' : 'Rd'); return `${/^\d/.test(orig) ? (Math.floor(rng() * 880) + 120) + ' ' : ''}${pick(LEX.FAKE_LAST)} ${suf}${/\.$/.test(orig) && !/\.$/.test(suf) ? '.' : ''}`; });
          case 'ZIP': return orig.replace(/\d{5}(-\d{4})?/, (z) => zip3(z));
          case 'ORG': return stringSurrogate('ORG', orig, () => pick(LEX.FAKE_ORGS));
          case 'LOCATION': return stringSurrogate('LOCATION', orig, () => pick(LEX.FAKE_CITIES));
        }
        return '[redacted]';
      },
    };
  }

  // HIPAA Safe Harbor: the first three ZIP digits may stay only where that 3-digit area holds more than 20,000 people (2000
  // Census); these 17 prefixes do not, so they become 000.
  const RESTRICTED_ZIP3 = new Set(['036', '059', '063', '102', '203', '556', '692', '790', '821', '823', '830', '831', '878', '879', '884', '890', '893']);
  const isRestrictedZip3 = (z) => RESTRICTED_ZIP3.has(String(z).slice(0, 3));
  const zip3 = (z) => (isRestrictedZip3(z) ? '000' : z.slice(0, 3)) + '00';
  function applySpans(text, spans, replacer) {
    // surrogates are drawn last span first (the allocation order the session key depends on); the text is assembled in one
    // pass, so a long cell with thousands of spans costs linear time, not one copy of the cell per span
    const reps = new Array(spans.length);
    for (let i = spans.length - 1; i >= 0; i--) reps[i] = replacer(spans[i]);
    const parts = [], replacements = [];
    let pos = 0;
    for (let i = 0; i < spans.length; i++) {
      const s = spans[i];
      if (s.start < pos || s.end < s.start) continue; // an overlapping or empty span (never produced by resolveSpans)
      parts.push(text.slice(pos, s.start), reps[i]);
      replacements.push({ start: s.start, end: s.end, original: text.slice(s.start, s.end), replacement: reps[i], type: s.type, source: s.source });
      pos = s.end;
    }
    parts.push(text.slice(pos));
    return { text: parts.join(''), replacements };
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
    const newEntity = () => { const e = { id: `e${entities.length + 1}`, code: `P${String(next++).padStart(3, '0')}`, mrns: new Set(), names: new Set(), parsed: [], dobs: new Set(), accounts: new Set(), phones: new Set(), fakeFirst: null, fakeLast: null, offset: null, seq: entities.length }; entities.push(e); byId.set(e.id, e); return e; };
    // A name can only link to an entity with the same surname or the same birthdate (see nameMatch), so resolve looks at
    // those entities only, not at every patient of the session: a list of 50,000 patients resolves in linear time.
    const byLast = new Map(), byDob = new Map(), byId = new Map(), byLastDel = new Map();
    const indexAdd = (map, k, e) => { if (!k) return; let s = map.get(k); if (!s) map.set(k, (s = new Set())); s.add(e); };
    const absorb = (e, rec) => {
      const mk = rec.mrn ? mrnKeyOf(rec.mrn) : '';
      if (mk) { e.mrns.add(cellToString(rec.mrn).trim()); byMrn.set(mk, e); }
      if (rec.name) { const raw = cellToString(rec.name).trim(); if (raw && !e.names.has(raw)) { e.names.add(raw); const pn = parseName(raw); if (pn) { e.parsed.push(pn); const al = alpha(pn.last); indexAdd(byLast, al, e); if (al.length >= 5 && al.length <= 40) deletionKeys(al).forEach((k) => indexAdd(byLastDel, k, e)); } } }
      const dk = dobKeyOf(rec.dob); if (dk) { e.dobs.add(dk); indexAdd(byDob, dk, e); }
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
        // a surname misspelled by one letter or one swap with the same given name ("Okonkow, Chidi" for Okonkwo, Chidi): the
        // same person when one of the two spellings is no surname at all (Smith and Smyth, both real, stay two people)
        const typoLink = !lastOk && last.length >= 5 && ql.length >= 5 && first.length >= 3 && first === qf && osaDistance(last, ql) <= 1 && (!LEX.isSurname(pn.last) || !LEX.isSurname(q.last));
        if (typoLink) lastOk = true;
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
      // A transaction: checkpoint() returns a function that puts the registry back exactly as it was (same entity objects,
      // same codes, same offsets), so a run that fails half way leaves no half-learned patient behind.
      checkpoint() {
        const cpVal = (v) => (v instanceof Set ? new Set(v) : v instanceof Map ? new Map(v) : Array.isArray(v) ? v.slice() : v);
        const cpObj = (o) => { const c = {}; for (const k of Object.keys(o)) c[k] = cpVal(o[k]); return c; };
        const keep = (v) => (v instanceof Set ? { set: new Set(v) } : v && typeof v === 'object' && !Array.isArray(v) ? { ref: v, copy: cpObj(v) } : { val: cpVal(v) });
        const back = (k) => (k.set ? new Set(k.set) : k.ref ? (Object.keys(k.ref).forEach((x) => { if (!(x in k.copy)) delete k.ref[x]; }), Object.assign(k.ref, cpObj(k.copy)), k.ref) : cpVal(k.val));
        const ents = entities.map((e) => keep(e));
        const maps = [byMrn, providers, tokenMap, strings, byLast, byDob, byId, byLastDel].map((m) => [m, [...m].map(([k, v]) => [k, keep(v)])]);
        const sets = [taken, realWords].map((st) => [st, new Set(st)]);
        const scal = { next, allocations: reg.allocations, docOffset: reg.docOffset };
        return () => {
          entities.length = 0; ents.forEach((k) => entities.push(back(k)));
          maps.forEach(([m, entries]) => { m.clear(); entries.forEach(([k, v]) => m.set(k, back(v))); });
          sets.forEach(([st, copy]) => { st.clear(); copy.forEach((x) => st.add(x)); });
          next = scal.next; reg.allocations = scal.allocations; reg.docOffset = scal.docOffset;
        };
      },
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
      get(id) { return byId.get(id) || null; },
      // rec: { name, mrn, dob, accounts?, phones? } — any subset. Returns the entity (created if new).
      resolve(rec) {
        const mk = rec.mrn ? mrnKeyOf(rec.mrn) : '';
        if (mk && byMrn.has(mk)) return absorb(byMrn.get(mk), rec);
        const pn = rec.name ? parseName(cellToString(rec.name)) : null;
        const dk = dobKeyOf(rec.dob);
        if (pn && pn.last) {
          // the candidates, in the order the entities were created (the first that matches wins, as a scan of all would)
          const al = alpha(pn.last);
          const cand = new Set([...(byLast.get(al) || []), ...((dk && byDob.get(dk)) || [])]);
          if (al.length >= 5 && al.length <= 40) deletionKeys(al).forEach((k) => (byLastDel.get(k) || []).forEach((e) => cand.add(e)));
          const hit = [...cand].sort((a, b) => a.seq - b.seq).find((e) => nameMatch(e, pn, dk, mk));
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
  // (word lengths are bounded so a long run of hyphenated capitals cannot make the match quadratic)
  const LINE_NAME_RE = /(?<![\w,])([A-Z][A-Za-z'’\-]{1,40}(?:[ -][A-Z][A-Za-z'’\-]{1,40})?),[ \t]{0,8}([A-Z][A-Za-z'’\-]{0,40})(?:[ \t]{1,8}([A-Z])\b\.?|[ \t]([A-Z][A-Z'’\-]{0,40})(?=\s|$)|[ \t]([A-Z][a-z'’\-]{2,40})(?=\s{3,}|\s*$))?(?![\w,])/g;
  const STREET_SUFFIX_WORD = /^(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Pkwy|Parkway|Hwy|Highway|Cir|Circle|Ter|Terrace|Trl|Trail|Pike|Row|Sq|Square|Box)\.?$/i;
  const LINE_ID_RE = /(?<![\w\/\-.:])(?:MRN\s*[:#]?\s*)?([A-Z]{0,2}[0-9OIlSB]{6,10})(?![\w\/\-])(?!:\d)(?!\.[\w])/g;
  // a labelled MRN may be written with internal spaces or hyphens ("MRN#0041 2345", "MRN: 0041-2345")
  const LINE_MRN_LABEL_RE = /\b(?:MRN|MR#|Med\s*Rec(?:ord)?\s*(?:No\.?|Num\.?|#)?)\s*[:#]?\s*([A-Z]{0,2}[0-9OIlSB](?:[ \-]?[0-9OIlSB]){5,9})(?![\w\/\-])(?!:\d)(?!\.[\w])/gi;
  const LINE_CRED_AFTER = /^\s*,?\s*(?:MD|DO|NP|PA-C|PA|RN|LPN|BSN|MSN|DNP|APRN|CRNP|CNP|ARNP|PharmD|RPh|MSW|LCSW|FNP|ANP|PhD|DDS|DPM)\b/;
  const LINE_PROVIDER_BEFORE = /\b(?:per|dr\.?|doctor|called|call|with|w\/|by|see|seen|spoke|attending|pcp|provider|md|np|rn|onc|oncologist|referred|referral|signed|cc)\s*[:\-]?\s*$/i;
  const LINE_LABEL_BEFORE = /(?:^|\b(?:pt|patient|name|re|regarding|for|contact))\s*[:#\-]?\s*$/i;
  const LINE_LABEL_WORD = /^(?:dob|mrn|mr|med|rec|record|records|acct|account|csn|har|fin|id|member|subscriber|policy|group|plan|payer|payor|coverage|insurance|ins|ssn|phone|fax|cell|home|work|email|address|addr|age|sex|dx|diagnosis|allergies|allergy|regimen|cycle|day|date|time|appt|visit|status|room|chair|bay|pod|unit|bed|order|orders|ordered|referring|referral|attending|provider|pcp|note|notes|comment|comments|name|patient|pt|male|female)$/i;
  function parseTextDocument(text, opts) {
    const o = Object.assign({ carryForward: true, mrnPattern: null, sectionMarker: /^===/ }, opts && typeof opts === 'object' ? opts : {});
    if (o.sectionMarker && !(o.sectionMarker instanceof RegExp)) o.sectionMarker = /^===/;
    const lines = (normalizeText(cellToString(text)) || '').replace(/\r(?!\n)/g, '\n').replace(/(\d{6,10}?)(?=\d{2}\/\d{2}\/\d{4}(?!\d)|\d{1,2}\/\d{1,2}\/\d{2,4}(?!\d))/g, '$1 ').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
    // a value cut off by the line wrap: a label at the end of one line with its number on the next ("CSN:" / "88120456617"),
    // or a phone number broken after a hyphen ("413-555-" / "0129."). The value is moved up to its label.
    for (let i = 0; i + 1 < lines.length; i++) {
      if (o.sectionMarker && (o.sectionMarker.test(lines[i]) || o.sectionMarker.test(lines[i + 1]))) continue;
      const labelEnd = /\b(?:MRN|MR#|CSN|HAR|FIN|DOB|D\.O\.B\.?|Acct|Account|Med\s*Rec(?:\s*(?:No|#))?|Phone|Ph|Cell|Tel|Fax|Member\s*ID|ID)\s*(?:#|No\.?)?\s*[:#]\s*$/i.test(lines[i]);
      const numEnd = /(?<![\w])\(?\d{3}\)?[-.\s]\d{3}-$|(?<![\w])\d{3}-$/.test(lines[i]);
      if (!labelEnd && !numEnd) continue;
      const head = lines[i + 1].match(labelEnd ? /^\s*([A-Z]{0,3}\d[\d\-\/.]{3,}[A-Z]?)(?=[\s,;.)]|$)/ : /^\s*(\d{4})(?![\d])/);
      if (!head) continue;
      lines[i] = lines[i] + (labelEnd ? ' ' : '') + head[1];
      lines[i + 1] = lines[i + 1].slice(head[0].length).replace(/^\s+/, '');
      if (/^[.,;:)]+$/.test(lines[i + 1].trim())) { lines[i] += lines[i + 1].trim(); lines[i + 1] = ''; }
      if (!lines[i + 1].trim()) lines.splice(i + 1, 1);
    }
    // a dose cut by the wrap of a narrow column: the number ends one line and its unit sits in the same column of the next
    // ("... Oxaliplatin 85" / "Hartley, Rosalind |[MRN      mg/m2 over 2 hr"): the unit is moved up beside its number
    for (let i = 0; i + 1 < lines.length; i++) {
      if (!/[A-Za-z]{3,}\s+\d+(?:\.\d+)?$/.test(lines[i])) continue;
      // the unit may also follow the last cell of the next row when that cell is a date, not a number ("05/14/1946 mg/m2")
      const um = lines[i + 1].match(/(^|(?<!\s)\s{3,}|(?<=\d{1,2}\/\d{1,2}\/\d{2,4})\s+)((?:mg|mcg|g|mL|ml|units?|mEq|mmol)(?:\/(?:m2|m²|kg|day|hr|h|min))?)(?=\s|$)/);
      if (!um) continue;
      const at = um.index + um[1].length;
      lines[i] = lines[i] + ' ' + um[2];
      lines[i + 1] = (lines[i + 1].slice(0, at) + lines[i + 1].slice(at + um[2].length).replace(/^\s/, '')).trimEnd();
      if (!lines[i + 1].trim()) { lines.splice(i + 1, 1); }
    }
    const tileHeads = new Set(); // line indices of tile labels ("Chair 9") after the board is cut into its tiles
    // Tiles of a board read row by row ("Bay 1   Bay 2   Bay 3" over "QUILLFEATHER,   MBEKI-HOLLOWAY,   ORTEGA-FALK, LUZMILA"
    // over "ROSALIND   DESMOND   E4472013 | 92 y F"): the screen reader runs across the tiles, so a name, the rest of the name
    // and the record number of one tile land on different lines between other tiles' text. Under a line of tile labels the
    // block is cut into its columns (wide gaps, then pipes, then position) and written tile by tile, so each tile reads as
    // one patient's lines.
    {
      const TILE_LABEL = /^(?:Bay|Chair|Room|Rm|Pod|Bed|Station|Slot|Recliner|Tile|Spot|Infusion\s+Chair)\s*#?\s*\d{1,3}[A-Z]?$/i;
      tileHeads.clear();
      const segsOf = (line) => { const out = []; const re = /\S+(?:\s{1,2}\S+)*/g; let m; while ((m = re.exec(line))) out.push({ text: m[0], start: m.index }); return out; };
      const out = []; let i = 0;
      while (i < lines.length) {
        const hs = segsOf(lines[i]);
        if (hs.length < 2 || !hs.every((x) => TILE_LABEL.test(x.text))) { out.push(lines[i]); i++; continue; }
        const k = hs.length, cols = hs.map(() => []);
        let n = i + 1;
        for (; n < lines.length; n++) {
          const line = lines[n];
          if (o.sectionMarker && o.sectionMarker.test(line)) break;
          let segs = segsOf(line);
          if (segs.length >= 2 && segs.every((x) => TILE_LABEL.test(x.text))) break; // the next row of tiles
          if (segs.length < k) {
            const piped = segs.flatMap((x) => { let off = 0; return x.text.split(/\s*\|\s*/).map((t) => { const st = x.start + x.text.indexOf(t, off); off = st - x.start + t.length; return { text: t, start: st }; }).filter((t) => t.text.trim()); });
            if (piped.length === k) segs = piped;
          }
          if (segs.length === k) segs.forEach((x, q) => cols[q].push(x.text));
          else segs.forEach((x) => { let best = 0; hs.forEach((h, q) => { if (Math.abs(h.start - x.start) < Math.abs(hs[best].start - x.start)) best = q; }); cols[best].push(x.text); });
        }
        hs.forEach((h, q) => { tileHeads.add(out.length); out.push(h.text); cols[q].forEach((t) => out.push(t)); });
        i = n;
      }
      lines.length = 0; out.forEach((l) => lines.push(l));
    }
    const mrnRe = o.mrnPattern ? new RegExp(o.mrnPattern.replace(/^\\b|\\b$/g, ''), 'g') : null;
    const thisYear = new Date().getFullYear();
    const rows = []; let current = null; let found = 0, inherited = 0;
    // A name cell that wrapped in a narrow table column: "08:00   Teresa   12710386 ..." then "Stewart   09" on the
    // next line (or "Reynolds,   5749277 ..." then "Deepa"). Rebuild the name from the two fragments.
    const WRAP_HEAD = /([A-Z][A-Za-z'’\-]+,?)(?:[ \t]([A-Z][A-Za-z'’\-]+,?))?[ \t]{2,}$/;
    const WRAP_TAIL = /^[ \t]*([A-Z][A-Za-z'’\-]+(?:[ \t][A-Z][A-Za-z'’\-]+)?)(?=[ \t]{2,}|[ \t]*$|[ \t]+\d{1,4}[ \t]*$)/;
    const NOT_NAME = /^(name|patient|pt|mrn|dob|date|time|appt|regimen|order|comments?|chair|cycle|day|dept|attending|provider)$/i;
    const wrappedName = (line, idIndex, next) => {
      const head = line.slice(Math.max(0, idIndex - 120), idIndex).match(WRAP_HEAD);
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
      let m = line.match(/((?:\p{Lu}[\p{L}'’\-]*\.?[ \t]+){1,4}\p{Lu}[\p{L}'’\-]+)[ \t]*[,(\-–—:|]?[ \t]*\(?[ \t]*(?:MRN|MR#|DOB|D\.O\.B)\b/u);
      if (!m) return '';
      // "A. Brzozowska (DOB": an initial and a surname
      if (/^\p{Lu}\.?[ \t]+\p{Lu}[\p{L}'’\-]+$/u.test(m[1].trim()) && (LEX.isSurname(m[1].trim().split(/[ \t]+/)[1]) || !LEX.isEnglishWord(m[1].trim().split(/[ \t]+/)[1]))) return m[1].trim();
      const bad = (w) => !w || LINE_LABEL_WORD.test(w) || NOT_NAME.test(w) || !!monthIndex(w) || COMMON_CAP.has(w.toLowerCase()) || LEX.CREDENTIAL_SET.has(w.toLowerCase()) || LEX.HONORIFIC_SET.has(w.toLowerCase().replace(/\.$/, '')) || LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) || LEX.STATE_ABBR_SET.has(w) || LEX.RELATION_SET.has(w.toLowerCase()) || (LEX.isClinical(w) && !LEX.isSurname(w) && !LEX.isFirstName(w));
      const words = m[1].trim().split(/[ \t]+/);
      while (words.length && bad(words[0])) words.shift();
      if (words.length < 2 || words.length > 4 || words.some((w, k) => bad(w) && !(k > 0 && k < words.length - 1 && LEX.isFirstName(w))) || words.some((w) => w.length < 2)) return '';
      const before = line.slice(Math.max(0, m.index + m[1].indexOf(words[0]) - 80), m.index + m[1].indexOf(words[0]));
      if (LINE_PROVIDER_BEFORE.test(before)) return '';
      // "Allergies: Penicillins, Iodinated Contrast  MRN 40019387": a field label before the words, or ordinary words that
      // are not names of any tier, is a field value, not the patient
      if (/\b(allerg(?:y|ies)|meds?|medications?|dx|diagnos[ie]s|problems?|code|regimen|orders?|labs?|results?|vitals?|history|hx|status|type|note|notes|comment|comments)\s*:?\s*$/i.test(before)) return '';
      if (!words.some((w) => LEX.isStrongName(w)) && words.some((w) => LEX.isEnglishWord(w) && !LEX.isStrongName(w) && !LEX.isCuratedName(w) && !LEX.isFirstName(w) && !LEX.isSurname(w))) return '';
      const nameLike = words.some((w) => LEX.isFirstName(w) || LEX.isSurname(w));
      if (!nameLike && words.some((w) => /(ated|ized|ised|ins|ine|ol|ide|ate|mab|nib|ium|ase|ex|oid)$/i.test(w))) return '';
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
        // a Title-case second given name ("Pham, Quoc Dung") stays only when it is not a label, a clinical word or an ordinary word
        if (m[5] && (LINE_LABEL_WORD.test(m[5]) || LEX.isClinical(m[5]) || LEX.CREDENTIAL_SET.has(m[5].toLowerCase()) || LEX.RELATION_SET.has(m[5].toLowerCase()) || (LEX.isEnglishWord(m[5]) && !LEX.isFirstName(m[5])))) mText = mText.slice(0, mText.length - m[5].length).trimEnd();
        // "52 Birchwood Ln, Tisbury": a street and its town, not "Last, First"
        if (last.split(/[ -]/).some((w) => STREET_SUFFIX_WORD.test(w))) continue;
        const after = line.slice(m.index + m[0].length), before = line.slice(Math.max(0, mIndex - 80), mIndex);
        // a clinician ("per Bruno, Georgiana MD", "Dr. Lee, Karen") is not a new patient
        if (LINE_CRED_AFTER.test(after) || LINE_PROVIDER_BEFORE.test(before)) continue;
        if (LEX.STATE_ABBR_SET.has(first) || LEX.CREDENTIAL_SET.has(first.toLowerCase()) || LEX.HONORIFIC_SET.has(last.toLowerCase())) continue;
        // "Allergies: Penicillins, Iodinated Contrast", "Dx: Lymphoma, Diffuse": a field label before the pair, or a
        // given-name slot that looks like a drug/chemistry word and is not a name of any tier, is not a patient
        if (/\b(allerg(?:y|ies)|meds?|medications?|dx|diagnos[ie]s|problems?|code|regimen|orders?|labs?|results?|vitals?|history|hx|status|type)\s*:?\s*$/i.test(before)) continue;
        const drugLike = (w) => /(ated|ized|ised|ins|ine|ol|ide|ate|mab|nib|ium|ase|ex|oid)$/i.test(w) && !LEX.isFirstName(w) && !LEX.isSurname(w);
        const knownSurname = (w) => w.split(/[-\s]+/).some((h) => LEX.isSurname(h));
        if (drugLike(first) && !knownSurname(last)) continue; // "Penicillins, Iodinated" but not "Kowalczyk-Brennan, Ottoline"
        // a label or form word is not half of a name ("Health Plan, Member ID ...", "Van Minh, DOB 03041951")
        if ([last, first].some((w) => LINE_LABEL_WORD.test(w) || LEX.ORG_SUFFIX_SET.has(w.toLowerCase()) || LEX.GREETING_SET.has(w.toLowerCase()) || /^(?:thanks|thank|thx|regards|sincerely|cheers|hi|hello|hey|dear|yes|no|ok|okay|please|sorry|also|then|today|tomorrow|yesterday|tonight)$/i.test(w))) continue;
        // "this is Bobby, Roberta Szymanski's grandson": the pair runs on into another name, so it is not "Last, First"
        if (/^\s+[A-Z][a-z][A-Za-z'’\-]*(?:['’]s\b|\s+[a-z])/.test(after) && !m[3]) continue;
        if (first.length < 2 && !m[3]) continue;
        // a short all-caps label after the comma ("Pellegrino-Vasquez,   AC: Cyclophosphamide") is the next cell, not a given name
        if (/^[A-Z]{1,3}$/.test(first) && !m[3] && /^\s*:/.test(after)) continue;
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
      const segs = []; const re = /(?:^|(?<!\s)\s{3,})([A-Z][a-z'’]+(?:[ \-][A-Z][A-Za-z'’]+){1,2})(?=\s{3,}|\s*$)/g; let m;
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
    const lineDates = (line) => ruleSpans(line, { mrnRegex: null, accountRegex: null, extraRegexes: [] }).filter((sp) => (sp.type === 'DATE' || sp.type === 'DOB') && sp.date && sp.date.hasYear && !/^(?:My|my|ord)$/.test(sp.date.kind) && sp.date.y <= thisYear - 1 && sp.date.y >= 1900);
    const info = lines.map((line) => isMarker(line) ? null : { names: lineNames(line), segs: segmentNames(line), ids: lineIds(line), dates: lineDates(line) });

    // A name that wrapped over two or three lines of a narrow first column: "0800 Kowalczyk-" / "Hartley, Rosalind |MRN" /
    // "Esperanza   40071823", or "1000 | Ibarrondo   01/05/1962" / "Etxeberria,   MRN" / "Teodoro   40115569".
    const FRAG_TOK = `(?!(?:DOB|MRN|MR#|ID|Acct|CSN)\\b)(?!${MONTH_NC_CAP}\\.?\\s+\\d)[A-Z][A-Za-z'’]*(?:-[A-Z][A-Za-z'’]*)*-?,?`;
    const LEAD_RE = new RegExp(`^\\s*(?:(?:\\d{3,4}|\\d{1,2}:\\d{2})\\s*)?[|\\[\\]'!.]*\\s*(${FRAG_TOK}(?:\\s${FRAG_TOK}){0,3})(?=\\s{2,}|\\s*[|\\[\\]'!]|\\s+\\d|\\s*$|\\s+(?:DOB|MRN|MR#)\\b|\\s+${MONTH_NC_CAP}\\.?\\s+\\d)`);
    const TIME_LED = /^\s*(?:\d{3,4}|\d{1,2}:\d{2})\s*[|\[\]'!]*\s*[A-Z]/;
    // the rest of a word broken by a narrow column ("Vanderhoe" / "k-", "Szczepano" / "wski,", "Bartholom" / "ew")
    const CONT_RE = /^\s*([a-z][a-z'’]{0,9}(?:-[A-Z][A-Za-z'’]*)*-?,?)(?=\s{2,}|\s+\d|\s*$)/;
    const contLead = (li) => {
      if (li >= lines.length || !info[li]) return null;
      const m = lines[li].match(CONT_RE); if (!m) return null;
      const w = m[1].replace(/[-,]+$/, '').split('-')[0];
      if ((w.length >= 3 && (COMMON_LOWER.has(w) || LEX.isClinical(w))) || /^(?:mg|mcg|ml|kg|hr|hrs|min|via|po|iv|sc|im|q\d\w*|x\d*|am|pm|cc|in|on|at|to|of|or|is)$/.test(w)) return null;
      return { text: m[1], rest: lines[li].slice(m.index + m[0].length), cont: true, start: m.index + m[0].length - m[1].length };
    };
    const lead = (li) => {
      if (li >= lines.length || !info[li]) return null;
      const m = lines[li].match(LEAD_RE); if (!m) return null;
      const words = m[1].split(/\s+/).map((w) => w.replace(/[-,]+$/, '')).flatMap((w) => w.split('-'));
      // a middle initial after the given name is part of it ("Cornelius T")
      if (words.some((w, q) => nameWordBad(w) || (w.length < 2 && !(q > 0 && q === words.length - 1 && /^[A-Z]$/.test(w))))) return null;
      return { text: m[1], rest: lines[li].slice(m.index + m[0].length), start: m.index + m[0].length - m[1].length };
    };
    const override = new Map(); const fragments = {};
    for (let li = 0; li < lines.length; li++) {
      if (override.has(li)) continue;
      const L = lead(li); if (!L) continue;
      const midWord = (acc, n) => /[A-Za-z]$/.test(acc) && !acc.includes(',') && TIME_LED.test(lines[li]) && contLead(n);
      const N1 = lead(li + 1) || (midWord(L.text, li + 1) ? contLead(li + 1) : null); if (!N1) continue;
      // a surname whose comma the reader lost ("10:00 Featherstonehaugh Jun 11, 40902287" over "Dmitri   1957"): a single
      // surname on a record line with its number, and a known given name alone under it
      const commaLost = TIME_LED.test(lines[li]) && !/[-,\s]/.test(L.text) && info[li].ids.length > 0 && !N1.cont && /^[A-Z][a-z'’]+$/.test(N1.text) && LEX.isFirstName(N1.text) && info[li + 1] && !info[li + 1].ids.length && !info[li + 1].names.length;
      if (!(/[-,]$/.test(L.text) || (!L.text.includes(',') && /,$/.test(N1.text)) || N1.cont || commaLost)) continue;
      let acc = L.text + (commaLost ? ',' : ''); const chain = [li]; const pieces = [{ li, start: L.start, text: L.text, part: 'last' }];
      // the surname may sit on the line above the record line it belongs to (".   Pellegrino-Vasquez," over "08:00 Annunziata  73310492")
      const aboveRecord = !TIME_LED.test(lines[li]) && /,$/.test(L.text);
      for (let n = li + 1; n < lines.length && chain.length < 6; n++) {
        if (TIME_LED.test(lines[n]) && !(aboveRecord && n === li + 1)) break; // the next record line of the grid
        const N = lead(n) || ((/[A-Za-z]$/.test(acc) && TIME_LED.test(lines[li])) ? contLead(n) : null); if (!N) break;
        if (N.cont) acc += N.text; // a word broken mid-way
        else if (/-$/.test(acc)) acc += N.text;
        else if (/,$/.test(acc)) acc += ' ' + N.text;
        else if (!acc.includes(',') && /,$/.test(N.text)) acc += ' ' + N.text;
        else if (/,\s*\S/.test(acc) && /^[A-Z][a-z'’]+$/.test(N.text) && !/[A-Za-z]{2,}/.test(N.rest.replace(/\b(?:MRN|MR|DOB|ID)\b/gi, ''))) acc += ' ' + N.text;
        else break;
        pieces.push({ li: n, start: N.start, text: N.text, cont: !!N.cont, part: N.cont ? 'cont' : (/,/.test(acc.slice(0, acc.length - N.text.length)) ? 'first' : 'last') });
        chain.push(n);
      }
      acc = acc.replace(/,$/, '').trim();
      if (chain.length < 2 || !/^[^,]+,\s*[A-Z]/.test(acc) || /-$/.test(acc)) continue;
      const ovRec = { name: acc, chain }; chain.forEach((n) => override.set(n, ovRec));
      // pieces of a word broken by the column ("Vanderhoe" + "k-"): no detector can match them, so they are marked as the
      // patient's name for the line they sit on
      pieces.forEach((pc, q) => {
        const broken = pc.cont || (pieces[q + 1] && pieces[q + 1].cont);
        if (!broken) return;
        const letters = pc.text.replace(/[-,]+$/, '');
        const end = pc.start + (pc.cont ? (letters.match(/^[a-z'’]+/) || [''])[0].length : letters.length);
        if (end > pc.start) (fragments[pc.li] = fragments[pc.li] || []).push({ start: pc.start, end, part: pc.cont ? 'cont' : pc.part });
      });
      li = chain[chain.length - 1];
    }
    // Tiles in a grid: k names on one line and exactly k record numbers (or birthdates) on one of the next two lines are
    // k patients, paired in reading order. Without an exact count match nothing is paired: a wrong pair is a merge.
    const grid = new Map(); // line index -> [{ name, mrn, dob }] in reading order
    for (let li = 0; li < lines.length; li++) {
      if (!info[li]) continue;
      const structuralNames = info[li].names.filter((x) => x.structural);
      const names = structuralNames.length >= 2 ? info[li].names : info[li].segs;
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
      // the name line of a tile, right under its label ("Chair 9" / "Solveig Lindgren-Mbeki" / "67 yo F | DOB 12/25/1958" /
      // "MRN 73300176"), possibly wrapped after a hyphen ("Annunziata Pellegrino-" / "Vasquez"): that tile's patient
      if (!ov && tileHeads.has(li - 1) && !info[li].names.length && !info[li].ids.length) {
        let tn = line.trim(), extra = 0;
        if (/-$/.test(tn) && lines[li + 1] && /^\s*\p{Lu}[\p{Ll}'’]+\s*$/u.test(lines[li + 1])) { tn += lines[li + 1].trim(); extra = 1; }
        const tw = tn.split(/[ -]/);
        const later = [1, 2, 3].some((d) => info[li + extra + d] && (info[li + extra + d].ids.length || info[li + extra + d].dates.length || /\b(?:MRN|DOB)\b/.test(lines[li + extra + d])) && !tileHeads.has(li + extra + d));
        if (/^\p{Lu}[\p{L}'’]+(?:[ -]\p{Lu}[\p{L}'’]+){1,3}$/u.test(tn) && tw.length >= 2 && !tw.some((w) => nameWordBad(w) || w.length < 2) && later) {
          current = { name: tn, mrn: '', dob: '', li: li + extra, rows: [li], tile: true }; found++;
          rows.push([tn, '', '', line]);
          if (extra) { li++; current.rows.push(li); rows.push([tn, '', '', lines[li]]); }
          continue;
        }
      }
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
      if (pick && !name) { const lm = line.match(/(?<![\w])([a-z][a-z'’\-]{2,}(?:[ -][a-z][a-z'’\-]{2,})?),[ \t]*([a-z][a-z'’\-]{2,})(?=[ \t]*[(\-–—:|]?[ \t]*\(?[ \t]*(?:mrn|mr#|dob|#)|[ \t]+[a-z]{0,2}\d{6,10}\b)/i); if (lm && !LEX.isEnglishWord(lm[2]) && !LEX.isClinical(lm[2]) && !lm[1].split(/[ -]/).some((w) => LEX.isEnglishWord(w) && !LEX.isSurname(w))) name = `${lm[1]}, ${lm[2]}`; }
      // "First Last" right before its record number or birthdate ("for Rosalind Graves (MRN 66120934)", "PARK MI-SOOK (MRN
      // 8830217)", "Patient Dang Van Minh, DOB 03041951"): that is the line's patient, so the name is not "not read"
      if (!name && (pick || /\b(?:dob|d\.o\.b)\b/i.test(line))) name = firstLastBeforeId(line);
      // DOB: labeled, else a full date whose year makes an adult-ish age
      // a month and year alone ("Dx Mar 2015") is never a birthdate unless it is labelled as one
      const dateSpans = ruleSpans(line, { mrnRegex: null, accountRegex: null, extraRegexes: [] }).filter((sp) => (sp.type === 'DATE' || sp.type === 'DOB') && sp.date && sp.date.hasYear && (sp.type === 'DOB' || !/^(?:My|my|ord)$/.test(sp.date.kind)));
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
      if (!name && (mrn || labeled) && current && current.name && !current.grid && li - current.li <= 3 && !TIME_LED.test(line) && ((mrn && !current.mrn) || (!mrn && labeled && !current.dob))) {
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
    rows.fragments = {}; Object.keys(fragments).forEach((li) => { rows.fragments[`${li}:3`] = fragments[li]; });
    // the section ("===" starts a new one) each line belongs to: a word-name named in full on one line of a note is the same
    // person on the next lines of that note
    { let sec = 0; rows.sectionOf = rows.map((r) => { if (isMarker(r[3])) sec++; return sec; }); }
    // a record number with no legible name whose owner introduces themself within the next few lines
    // ("Sent 11/06 7:42 PM  MRN 6143027" / "Hi, this is Lan Huong. After my infusion ...")
    for (let ri = 0; ri < rows.length; ri++) {
      if (rows[ri][0] || !rows[ri][1]) continue;
      const mrnHere = rows[ri][1];
      for (let k = ri; k < Math.min(rows.length, ri + 8); k++) {
        if (rows[k][1] && rows[k][1] !== mrnHere) break;
        const mm = rows[k][3].match(/\b(?:this is|it'?s|I am|I'm|my name is|patient[:\s]+|pt[:\s]+|from)\s+((?:\p{Lu}[\p{L}'’\-]+[ \t]+){1,3}\p{Lu}[\p{L}'’\-]+)(?=[.,;!?\s]|$)/u);
        if (!mm) continue;
        const words = mm[1].trim().split(/[ \t]+/);
        if (words.some((w) => LEX.isClinical(w) || LEX.isEnglishWord(w) && !LEX.isStrongName(w) && !LEX.isCuratedName(w) || LEX.RELATION_SET.has(w.toLowerCase()) || LEX.HONORIFIC_SET.has(w.toLowerCase()))) continue;
        const nm = words.join(' ');
        for (let q = ri; q < rows.length && (rows[q][1] === mrnHere || (!rows[q][1] && q <= k)); q++) if (!rows[q][0]) rows[q][0] = nm;
        break;
      }
    }
    const headers = ['Patient Name', 'MRN', 'DOB', 'Line'];
    const columns = [{ header: 'Patient Name', index: 0, role: 'patient_name', reason: 'extracted from line', sample: [] }, { header: 'MRN', index: 1, role: 'mrn', reason: 'extracted from line', sample: [] }, { header: 'DOB', index: 2, role: 'dob', reason: 'extracted from line', sample: [] }, { header: 'Line', index: 3, role: 'text', reason: 'the text itself', sample: [] }];
    return { headers, rows, columns, extras, stats: { lines: lines.length, linesWithPatient: found, linesInherited: inherited, gridPatients: extras.length } };
  }

  // Screen-reader misreads that turn clinical shorthand into nonsense: "g21 days" for q21 days, "stage Ill" for stage III.
  // Applied to OCR output only, before detection, so the protected text keeps the clinical meaning.
  const OCR_RELATIONS = ['grandson', 'granddaughter', 'grandmother', 'grandfather', 'daughter', 'husband', 'brother', 'sister', 'nephew', 'partner', 'neighbor', 'neighbour', 'caregiver', 'stepson', 'stepdaughter', 'girlfriend', 'boyfriend', 'roommate'];
  function normalizeOcrText(text) {
    let t = cellToString(text);
    // a narrow grid read with no gap between columns: a record number glued to the next cell ("40955108Zoledronic",
    // "408712491VIG" where the 1 is the I of IVIG). The other record numbers of the same screen give the length.
    const runLens = new Map();
    (t.match(/(?<![\w\/\-.])\d{6,10}(?![\w\/\-]|\.\d)/g) || []).forEach((r) => runLens.set(r.length, (runLens.get(r.length) || 0) + 1));
    const usual = [...runLens.entries()].sort((a, b) => b[1] - a[1])[0];
    t = t.replace(/(?<![\w\/\-.])(\d{6,11})(?=[A-Z][A-Za-z]{1,})/g, (m, run, off, str) => {
      const rest = str.slice(off + m.length).match(/^[A-Za-z]+/)[0];
      if (usual && run.length === usual[0] + 1 && /[1l]$/.test(run) && /^[A-Z]{2,}$/.test(rest)) return run.slice(0, -1) + ' I';
      return run + ' ';
    });
    // a surname glued to the month of the next cell: "Featherstonehaughjun 11, 1957" -> "Featherstonehaugh Jun 11, 1957"
    t = t.replace(/(\b\p{Lu}\p{Ll}{4,}?)(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)(?=\s+\d{1,2},)/gu, (m, w, mo) => `${w} ${mo.charAt(0).toUpperCase()}${mo.slice(1)}`);
    // a relation word with one letter misread ("orandson Edmund", "daughfer Priya"): restored so the name after it is found
    t = t.replace(/\b[a-z]{6,13}\b/g, (w) => {
      if (LEX.isEnglishWord(w) || LEX.isFirstName(w) || LEX.isSurname(w) || LEX.isClinical(w)) return w;
      const hit = OCR_RELATIONS.find((r) => r.length === w.length && [...r].filter((c, i) => c !== w[i]).length === 1);
      return hit || w;
    });
    // a capital I read as a lower-case l at the start of a grid cell: "llesanmi," (an English word almost never starts "ll" + vowel)
    t = t.replace(/(^|\n[ \t]*|[ \t]{2,})ll(?=[aeiou][a-z]{2,}\b)/g, '$1Il');
    return t
      .replace(/(?<![A-Za-z\d])g(\d{1,2})(\s*)(h|hr|hrs|hours?|d|days?|wk|wks|weeks?|mo|months?)\b/g, 'q$1$2$3')
      .replace(/\b(stage|grade|class|type|phase|cycle)(\s+)(?:Ill|IIl|lIl|lll)\b/gi, '$1$2III')
      // a superscript 2 read as "?" or "*" in a dose unit: "mg/m?2", "mg/m?" for mg/m²
      .replace(/(\/m)[?*°](2)?(?![\w])/g, '$12')
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
      strict: true,
      auditColumn: true,
      auditDetail: false,
    };
    const ov = overrides && typeof overrides === 'object' ? overrides : {};
    const cfg = Object.assign({}, base, ov);
    cfg.layers = Object.assign({}, base.layers, ov.layers && typeof ov.layers === 'object' ? ov.layers : {});
    cfg.surrogate = Object.assign({}, base.surrogate, ov.surrogate && typeof ov.surrogate === 'object' ? ov.surrogate : {});
    // options of the wrong shape are normalised or ignored, never a reason for an internal error
    const list = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);
    cfg.columns = Array.isArray(cfg.columns) ? cfg.columns : [];
    cfg.extraPatterns = list(cfg.extraPatterns); cfg.allowlist = list(cfg.allowlist); cfg.denylist = list(cfg.denylist);
    if (typeof cfg.mrnPattern !== 'string') cfg.mrnPattern = null;
    if (typeof cfg.accountPattern !== 'string') cfg.accountPattern = null;
    if (typeof cfg.seed !== 'number' || !Number.isFinite(cfg.seed)) cfg.seed = parseInt(cfg.seed, 10) || base.seed;
    const sr = cfg.surrogate.shiftRange;
    if (!(Array.isArray(sr) && sr.length >= 2 && sr[0] !== null && sr[1] !== null && sr[0] !== '' && sr[1] !== '' && Number.isFinite(+sr[0]) && Number.isFinite(+sr[1]) && +sr[0] >= 0 && +sr[1] >= 0)) cfg.surrogate.shiftRange = base.surrogate.shiftRange.slice();
    else cfg.surrogate.shiftRange = [Math.round(Math.min(+sr[0], +sr[1], 36500)), Math.round(Math.min(Math.max(+sr[0], +sr[1]), 36500))]; // "365-30" reads as 30-365
    if (!['fake', 'code'].includes(cfg.surrogate.patients)) cfg.surrogate.patients = base.surrogate.patients;
    if (!['fake', 'code'].includes(cfg.surrogate.providers)) cfg.surrogate.providers = base.surrogate.providers;
    if (!['drop', 'year', 'shift'].includes(cfg.surrogate.dob)) cfg.surrogate.dob = base.surrogate.dob;
    if (typeof cfg.surrogate.ages !== 'string') cfg.surrogate.ages = base.surrogate.ages;
    // a registry that is not one of ours (no resolve/entities) is ignored: the input gets a fresh one
    if (cfg.registry != null && !(typeof cfg.registry === 'object' && typeof cfg.registry.resolve === 'function' && Array.isArray(cfg.registry.entities) && cfg.registry.taken instanceof Set && cfg.registry.tokenMap instanceof Map)) delete cfg.registry;
    cfg.manual = normalizeManual(cfg.manual);
    return cfg;
  }
  // manual review edits, per cell ("row:col"): { add: [{ start, end, type }], remove: [[start, end]] }; anything else is dropped
  function normalizeManual(m) {
    if (!m || typeof m !== 'object') return null;
    const out = {};
    Object.keys(m).forEach((k) => {
      const e = m[k]; if (!e || typeof e !== 'object') return;
      const add = (Array.isArray(e.add) ? e.add : []).filter((a) => a && typeof a === 'object' && Number.isInteger(a.start) && Number.isInteger(a.end) && a.start >= 0 && a.end > a.start)
        .map((a) => Object.assign({}, a, { type: TYPES[a.type] ? a.type : 'NAME_OTHER' }));
      const remove = (Array.isArray(e.remove) ? e.remove : []).filter((r) => Array.isArray(r) && r.length >= 2);
      out[k] = { add, remove };
    });
    return out;
  }

  function compileConfig(cfg) {
    const c = Object.assign({}, cfg);
    const mk = (src) => { if (!src) return null; try { return new RegExp(src, 'g'); } catch (e) { return null; } };
    c.mrnRegex = mk(cfg.mrnPattern);
    c.accountRegex = mk(cfg.accountPattern);
    c.extraRegexes = (Array.isArray(cfg.extraPatterns) ? cfg.extraPatterns : []).map((p) => mk(typeof p === 'string' ? p : p && typeof p === 'object' && typeof p.regex === 'string' ? p.regex : null)).filter(Boolean);
    const words = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map((x) => cellToString(x).trim().toLowerCase()).filter(Boolean);
    c.allowSet = new Set(words(cfg.allowlist));
    c.denySet = new Set(words(cfg.denylist));
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

  // A header is written in Title Case by convention, so the word cues that find organizations and names in a sentence read
  // column labels as names ("Med Rec #", "Nursing Note", "Emerg Contact Name"). In a header only the census, the identifier
  // rules (record numbers, dates, phones, e-mails, addresses) and names with a word that is not a column label are taken.
  const HEADER_WORD = new Set(('name names nm contact contacts emerg emergency ec last first middle given family sur surname full legal preferred pref nick nickname alias aka '
    + 'patient patients pt pts client resident provider prov attending attend referring ordering prescriber prescribing physician doctor doc nurse nursing rn md np pa pcp onc '
    + 'oncologist note notes comment comments cmnt cmt remark remarks instruction instructions message msg phone ph tel telephone cell home work mobile fax pager email e-mail mail '
    + 'date dt time appt appointment visit encounter type status chair bay room rm pod bed unit dept department clinic location loc site regimen protocol drug med meds medication '
    + 'dose cycle day infusion order orders ordered reason indication rec record records no num number id identifier account acct har csn fin mrn dob birth age sex gender zip '
    + 'postal city state address addr street line insurance ins plan payer payor auth authorization kin nok guarantor relation relationship rel spouse caregiver scheduler user '
    + 'entered signed by of for and or the to re practice facility hospital center centre pharmacy lab labs result results height weight bsa wt ht diagnosis dx code allergies '
    + 'allergy alert alerts flag flags language interpreter primary secondary alt alternate other next prior previous start end due scheduled sched created updated list '
    + 'schedule report printed page total count summary detail details info information mychart portal outside transfer referral source method mode route '
    + 'class financial group member policy subscriber copay balance study trial arm consent driver ride escort visitor visitors agency vendor team service').split(' '));
  function headerSpanKeep(sp) {
    if (!sp || /^(?:census|manual)/.test(sp.source || '')) return true;
    const c = COARSE(sp.type);
    if (c === 'ORG') return false; // an organization in a column label ("Last Infusion", "Referring Practice") is not a patient's
    if (c !== 'NAME') return true;
    const words = String(sp.text || '').match(/[A-Za-z'’\-]+/g) || [];
    return words.some((w) => { const lw = w.toLowerCase().replace(/['’]s$/, ''); return !HEADER_WORD.has(lw) && !LEX.RELATION_SET.has(lw) && !LEX.CREDENTIAL_SET.has(lw) && !LEX.HONORIFIC_SET.has(lw) && !LEX.isClinical(w); });
  }

  // Processing never throws: an unexpected failure returns every cell blanked, with the error in result.errors (the self-check
  // reports it as a hit, so nothing from such a run can be downloaded)
  function processTable(table, userCfg) {
    try { return processTableCore(table, userCfg); } catch (e) {
      try { return failedResult(table, userCfg, e); } catch (e2) { return failedResult(null, null, e); }
    }
  }
  // what a failed run returns: every cell blank, the error listed. Every access to the input is guarded (a row that cannot be
  // read counts as empty), so building this answer cannot fail in turn.
  function failedResult(table, userCfg, e) {
    const tryOr = (f, d) => { try { return f(); } catch (x) { return d; } };
    let cfg = tryOr(() => compileConfig(defaultConfig(userCfg && typeof userCfg === 'object' ? userCfg : {})), null);
    if (!cfg) cfg = compileConfig(defaultConfig({}));
    const srcRows = tryOr(() => (table && Array.isArray(table.rows) ? table.rows : []), []);
    const nRows = tryOr(() => srcRows.length >>> 0, 0);
    const srcHeaders = tryOr(() => (table && Array.isArray(table.headers) ? table.headers : []), []);
    let width = tryOr(() => srcHeaders.length >>> 0, 0);
    for (let i = 0; i < nRows; i++) width = Math.max(width, tryOr(() => (Array.isArray(srcRows[i]) ? srcRows[i].length >>> 0 : 1), 1));
    width = Math.min(width, 100000);
    const headers = Array.from({ length: width }, () => ''); // a header may hold patient information too: not written unread
    const registry = cfg.registry || createRegistry();
    const census = { patients: new Map(), known: new Map(), providers: new Map(), rowPatient: new Array(nRows).fill(null), rowExtra: new Array(nRows).fill(null), lookup: new Map(), regex: null, registry, mrnNorm: new Map(), patient: () => null, nameCols: [], nickCols: [], mrnCols: [], dobCols: [], acctCols: [], phoneCols: [], provCols: [] };
    const rows = Array.from({ length: nRows }, () => headers.map(() => ''));
    const details = Array.from({ length: nRows }, (_, i) => ({ row: i, patientCode: '', offset: 0, cells: [], structured: [] }));
    const message = tryOr(() => String((e && e.message) || e), 'unknown error');
    return { headers, rows, columns: headers.map((h, i) => ({ header: h, index: i, role: 'drop', reason: 'processing failed' })), census, details, stats: { rows: nRows, cells: 0, spans: 0, byType: {}, bySource: {}, structured: {} }, mapping: { patients: [], providers: [], others: [], meta: {} }, cfg, registry, errors: [{ row: -1, col: -1, header: '', message }] };
  }
  function processTableCore(table, userCfg) {
    const cfg = compileConfig(defaultConfig(userCfg && typeof userCfg === 'object' ? userCfg : {}));
    // Input normalisation (the Node path too): Unicode spaces and zero-width characters, NFC, smart quotes. A ragged row is
    // never passed through unread: headers are widened to the widest row, so every cell has a column and a role.
    const srcRows = table && Array.isArray(table.rows) ? table.rows : [];
    // a row that cannot be read at all (a hostile object) fails the whole run: processTable returns every cell blanked
    const rows = srcRows.map((r) => (Array.isArray(r) ? r.map(normalizeCell) : r == null ? [] : [normalizeCell(r)]));
    ['extras', 'fragments', 'sectionOf'].forEach((k) => { if (srcRows[k] != null) rows[k] = srcRows[k]; });
    const srcHeaders = table && Array.isArray(table.headers) ? table.headers : [];
    const width = rows.reduce((w, r) => Math.max(w, r.length), srcHeaders.length);
    const headers = Array.from({ length: width }, (_, i) => (i < srcHeaders.length ? normalizeText(cellToString(srcHeaders[i])) : ''));
    const given = Array.isArray(cfg.columns) && cfg.columns.length && cfg.columns.length <= headers.length && cfg.columns.length >= srcHeaders.length ? cfg.columns : null;
    let columns = given && given.length === headers.length ? given.map((c, i) => ({ header: headers[i], index: i, role: ROLES.includes(c && (c.role || c)) ? (c.role || c) : 'text' }))
      : given ? (() => { const auto = classifyColumns(headers, rows); return auto.map((a, i) => (i < given.length ? { header: headers[i], index: i, role: ROLES.includes(given[i] && (given[i].role || given[i])) ? (given[i].role || given[i]) : 'text' } : a)); })()
      : classifyColumns(headers, rows);
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
    const ctx = { cfg, census, propagateRegex: null, rowPatientKey: null, manual: cfg.manual || null, cellKey: null, fragments: rows.fragments || null };
    // a cell the detector cannot process is blanked and reported (result.errors), never passed through: the self-check turns
    // any error into a hit, so such a file cannot be downloaded
    const errors = [];
    const fail = (ri, ci, e) => errors.push({ row: ri, col: ci, header: ci >= 0 ? headers[ci] : '', message: String((e && e.message) || e) });
    // a cell whose first pass failed is remembered: without propagation its first-pass spans are the ones applied, and an empty
    // list there would pass the cell through unread
    const firstFailed = new Map();
    const firstPass = rows.map((row, ri) => { ctx.rowPatientKey = census.rowPatient[ri]; ctx.rowExtraKeys = census.rowExtra[ri]; return textCols.map((ci) => { ctx.cellKey = `${ri}:${ci}`; try { return detectText(cellToString(row[ci]), ctx); } catch (e) { firstFailed.set(`${ri}:${ci}`, e); return []; } }); });
    ctx.rowPatientKey = null; ctx.rowExtraKeys = null; ctx.cellKey = null;
    // Header cells are written to the output too: a sheet laid out as label/value pairs, or a title row read as the header
    // ("Patient: Gatsby, Jay", "MRN: 00418327"), puts patient information there. Each header goes through the detector with
    // the census and the rules only (no row patient, no propagation, no manual edits), so its output depends on the header
    // alone and is the same in every part of a long input.
    const headerCtx = { cfg, census, propagateRegex: null, rowPatientKey: null, rowExtraKeys: null, manual: null, cellKey: null, fragments: null };
    const headerSpans = headers.map((h, ci) => { if (!h) return []; try { return detectText(h, headerCtx).filter(headerSpanKeep); } catch (e) { fail(-1, ci, e); return null; } });
    if (cfg.layers.propagate) {
      const all = columnNameSpans(headers, rows, columns); firstPass.forEach((cells) => cells.forEach((sp) => all.push(...sp)));
      headerSpans.forEach((sp) => { if (sp) all.push(...sp); }); // a name found in a header is looked for in the cells too
      ctx.propagateRegex = collectPropagation(all, cfg);
      // word-names (Grace, Hope) are re-found only near where their full name was found: the same row, the other rows of the
      // same patient, or the same section of a pasted note (each line of a note is a row)
      const groupOf = (ri) => census.rowPatient[ri] != null ? 'P' + census.rowPatient[ri] : (rows.sectionOf ? 'S' + rows.sectionOf[ri] : 'R' + ri);
      const groupSpans = new Map();
      firstPass.forEach((cells, ri) => { const g = groupOf(ri); if (!groupSpans.has(g)) groupSpans.set(g, []); cells.forEach((sp) => { for (const x of sp) groupSpans.get(g).push(x); }); });
      const groupAmb = new Map();
      groupSpans.forEach((sp, g) => { const r = collectPropagation(sp, cfg); groupAmb.set(g, r ? r.ambiguous : null); });
      ctx.rowAmbiguousList = firstPass.map((_, ri) => groupAmb.get(groupOf(ri)) || null);
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
      while (out.length < headers.length) out.push(''); // a short (ragged) row: the derived and audit columns still line up
      const detail = { row: ri, patientCode: pInfo ? pInfo.code : '', offset, cells: [], structured: [] };
      // Structured columns
      columns.forEach((col) => { try {
        const ci = col.index, v = row[ci];
        if (v == null || v === '') return;
        const sv = cellToString(v);
        switch (col.role) {
          case 'patient_name': {
            if (census.nameCols.length >= 2 && /\b(last|first|sur|given|family|middle)\b/i.test(col.header)) {
              const upper = sv === sv.toUpperCase() && /[A-Z]/.test(sv);
              let part = /\b(last|sur|family)\b/i.test(col.header) ? (pInfo ? pInfo.fakeLast : '[name]') : /\bmiddle\b/i.test(col.header) ? (sv ? sv[0] + '.' : '') : (pInfo ? pInfo.fakeFirst : '[name]');
              if (cfg.surrogate.patients === 'code' && pInfo) part = /\b(last|sur|family)\b/i.test(col.header) ? pInfo.code : '';
              out[ci] = upper ? part.toUpperCase() : part; detail.structured.push([col.header, 'NAME']); bump(stats.structured, 'NAME'); break;
            }
            if (NICK_HEADER.test(col.header) && census.nickCols && census.nickCols.includes(ci) && census.nickCols.length < census.nameCols.length) {
              const upper = sv === sv.toUpperCase() && /[A-Z]/.test(sv);
              out[ci] = pk ? (cfg.surrogate.patients === 'code' ? pInfo.code : (upper ? pInfo.fakeFirst.toUpperCase() : pInfo.fakeFirst)) : '[name]';
              detail.structured.push([col.header, 'NAME']); bump(stats.structured, 'NAME'); break;
            }
            out[ci] = pk ? (cfg.surrogate.patients === 'code' ? pInfo.code : (() => { const p = census.patients.get(pk); const parsed = parseName(sv); const info = pInfo; if (!parsed) return `${info.fakeLast}, ${info.fakeFirst}`; return parsed.format === 'last_first' ? (parsed.upper ? `${info.fakeLast}, ${info.fakeFirst}`.toUpperCase() : `${info.fakeLast}, ${info.fakeFirst}`) : parsed.format === 'single' ? info.fakeLast : (parsed.upper ? `${info.fakeFirst} ${info.fakeLast}`.toUpperCase() : `${info.fakeFirst} ${info.fakeLast}`); })()) : '[name]'; detail.structured.push([col.header, 'NAME']); bump(stats.structured, 'NAME'); break; }
          case 'mrn': out[ci] = pInfo ? pInfo.code : '[mrn]'; detail.structured.push([col.header, 'MRN']); bump(stats.structured, 'MRN'); break;
          case 'account': out[ci] = pInfo ? `A-${pInfo.code}` : '[acct]'; bump(stats.structured, 'ACCOUNT'); break;
          case 'phone': out[ci] = sur.replace({ type: 'PHONE', start: 0, end: sv.length }, sv, pk); bump(stats.structured, 'PHONE'); break;
          case 'provider': {
            out[ci] = sv.replace(/\s+/g, ' ').split(/( ?[;\/] ?| and )/).map((part, idx) => { if (idx % 2 === 1) return part; const parsed = parseName(part); if (!parsed || !parsed.last) return part; const k = `${parsed.last}|${parsed.first}`.toLowerCase(); return census.providers.has(k) ? sur.replace({ type: 'NAME_PROVIDER', entity: k, start: 0, end: part.length }, part, pk) : sur.replace({ type: 'NAME_PROVIDER', start: 0, end: part.length }, part, pk); }).join('');
            bump(stats.structured, 'PROVIDER'); break;
          }
          case 'dob': {
            const d = isDate(v) ? v : parseDateString(sv);
            if (cfg.surrogate.dob === 'drop' || !d) out[ci] = '';
            else if (cfg.surrogate.dob === 'year') out[ci] = new Date().getFullYear() - d.getFullYear() >= 90 ? '90+' : String(d.getFullYear()); // Safe Harbor: no birth year for ages 90 and over
            else if (cfg.surrogate.dob === 'shift') out[ci] = isDate(v) ? shiftDate(d, offset) : sur.replace({ type: 'DOB', start: 0, end: sv.length }, sv, pk);
            else out[ci] = '';
            bump(stats.structured, 'DOB'); break;
          }
          case 'date': {
            if (isDate(v)) out[ci] = cfg.surrogate.dateShift ? shiftDate(v, offset) : '';
            else {
              // a date column holds dates even when they are written as bare digits: "20261029" (YYYYMMDD), "10292026" (MMDDYYYY)
              const cm = sv.match(/^(\s*)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(\s*)$/) || null;
              const cm2 = !cm ? sv.match(/^(\s*)(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])((?:19|20)\d{2})(\s*)$/) : null;
              let spans = detectText(sv, ctx).filter((s) => COARSE(s.type) === 'DATE');
              if (cm && validDMY(+cm[2], +cm[3], +cm[4])) spans = [{ start: cm[1].length, end: sv.length - cm[5].length, type: 'DATE', source: 'rule', text: sv.trim(), date: { y: +cm[2], m: +cm[3], d: +cm[4], hasYear: true, yearDigits: 4, sep: '', kind: 'ymdc', monthStyle: null, text: sv.trim() } }];
              else if (cm2 && validDMY(+cm2[4], +cm2[2], +cm2[3])) spans = [{ start: cm2[1].length, end: sv.length - cm2[5].length, type: 'DATE', source: 'rule', text: sv.trim(), date: { y: +cm2[4], m: +cm2[2], d: +cm2[3], hasYear: true, yearDigits: 4, sep: '', kind: 'compact', monthStyle: null, text: sv.trim() } }];
              const r = applySpans(sv, spans, (s) => sur.replace(s, sv, pk)); out[ci] = r.text;
            }
            bump(stats.structured, 'DATE'); break;
          }
          case 'age': out[ci] = bandAge(v, cfg.surrogate.ages); bump(stats.structured, 'AGE'); break;
          case 'zip': out[ci] = sv.replace(/\d{5}(-\d{4})?/, (z) => zip3(z)); bump(stats.structured, 'ZIP'); break;
          case 'drop': out[ci] = ''; bump(stats.structured, 'DROP'); break;
          default: break;
        }
      } catch (e) { out[col.index] = ''; fail(ri, col.index, e); } });
      // Free text
      textCols.forEach((ci, ti) => {
        const text = cellToString(row[ci]);
        if (!text) return;
        stats.cells++;
        ctx.cellKey = `${ri}:${ci}`;
        ctx.rowAmbiguous = ctx.rowAmbiguousList ? ctx.rowAmbiguousList[ri] : null;
        let spans, r;
        try {
          if (!cfg.layers.propagate && firstFailed.has(`${ri}:${ci}`)) throw firstFailed.get(`${ri}:${ci}`);
          spans = cfg.layers.propagate ? detectText(text, ctx) : firstPass[ri][ti];
          r = applySpans(text, spans, (s) => sur.replace(s, text, pk));
        } catch (e) { fail(ri, ci, e); out[ci] = ''; return; }
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
    const outHeaders = headers.map((h, ci) => {
      if (!h) return h;
      const sp = headerSpans[ci];
      if (!sp) return ''; // the detector failed on this header: blanked, and reported in errors
      if (!sp.length) return h;
      try { return applySpans(h, sp, (x) => sur.replace(x, h, null)).text; } catch (e) { fail(-1, ci, e); return ''; }
    });
    const addDerived = cfg.deriveAge && !ageCols.length && census.dobCols.length;
    if (addDerived) { outHeaders.push('Age (derived)'); outRows.forEach((r, i) => { r.push(details[i].derivedAge || ''); }); }
    if (cfg.auditColumn) { outHeaders.push('DeID Audit'); outRows.forEach((r, i) => { r.push(details[i].audit || ''); }); }

    const mapping = sur.mapping;
    // the registry is the session-wide key: every patient linked so far, with codes, surrogates and offsets, and every
    // provider, third-party name, organization, place and identifier replaced in any input of the session
    mapping.patients = registry.toMappingRows();
    mapping.providers = registry.toProviderRows();
    mapping.others = registry.toOtherRows();
    mapping.meta = { seed: cfg.seed, processedAt: new Date().toISOString(), documentOffsetDays: sur.docOffset, mrnPattern: cfg.inferredMrnPattern || cfg.mrnPattern || '', columns: columns.map((c, i) => (outHeaders[i] !== c.header ? { header: c.header, role: c.role, output: outHeaders[i] } : { header: c.header, role: c.role })) };
    return { headers: outHeaders, rows: outRows, columns, census, details, stats, mapping, cfg, registry, errors };
  }

  // Re-identify: reverse the mapping on a de-identified table.
  function reidentify(table, mapping) {
    const headers = table.headers.map(cellToString);
    // a column is found by its header in the protected file: the source header, or the protected one when the header itself held
    // patient information and was replaced
    const roles = new Map();
    ((mapping.meta && mapping.meta.columns) || []).forEach((c) => { if (!c) return; roles.set(c.header, c.role); if (c.output != null) roles.set(c.output, c.role); });
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
    const re = reverse.length ? new RegExp(`(?<![A-Za-z0-9])(?:${reverse.map((r) => escapeRe(r[0])).join('|')})(?![A-Za-z0-9])`, 'gi') : null;
    const lookup = new Map(); for (const r of reverse) if (!lookup.has(r[0])) lookup.set(r[0], r);
    const lookupLower = new Map(); for (const r of reverse) if (!lookupLower.has(r[0].toLowerCase())) lookupLower.set(r[0].toLowerCase(), r);
    // case-insensitive only for a token that starts with a capital letter (IREDALE, HARRIET), so "port kit" stays;
    // the case of the note is carried over to person names only (ECMC stays ECMC, codes stay codes)
    const restore = (m) => {
      let entry = lookup.get(m);
      if (!entry) {
        entry = lookupLower.get(m.toLowerCase()); if (!entry) return m;
        // a made-up name written in lower case (a lower-case export or message) restores too; short and ordinary words stay
        if (!/^[A-Z]/.test(m) && !(entry[2] && m.length >= 4 && !COMMON_LOWER.has(m.toLowerCase()) && /[a-z]/.test(m))) return m;
      }
      const real = entry[1], isName = entry[2];
      if (!isName) return real;
      if (m === m.toLowerCase() && /[a-z]{2}/.test(m)) return real.toLowerCase();
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
          // dates the patterns below do not cover: a compact date inside a file name, the end of a range written as a bare day,
          // and the start of "11/24-26" (the m/d pattern refuses a number glued to a dash)
          const extra = ruleSpans(s, { mrnRegex: null, accountRegex: null, extraRegexes: [] }).filter((sp) => sp.type === 'DATE' && sp.date && (/^(?:dayr|ymdc|compact)$/.test(sp.date.kind) || (sp.date.kind === 'md' && /^[ \t]*[-–—][ \t]*\d{1,2}(?![\d\/])/.test(s.slice(sp.end))))).sort((a, b) => b.start - a.start);
          for (const sp of extra) s = s.slice(0, sp.start) + renderDate(sp.date, shiftDate(new Date(sp.date.y, sp.date.m - 1, sp.date.d), off)) + s.slice(sp.end);
          for (const pat of DATE_PATTERNS) { if (pat.kind === 'ord') continue; pat.re.lastIndex = 0; s = s.replace(pat.re, (m, ...g) => { const mm = [m, ...g.slice(0, -2)]; mm.index = 0; const pd = parseDateMatch(pat.kind, mm); return pd ? renderDate(pd, shiftDate(new Date(pd.y, pd.m - 1, pd.d), off)) : m; }); }
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
  // The self-check never throws either: a result it cannot read, or a run that reported errors, comes back with a hit, so the
  // page cannot vouch for it and no download is offered
  function selfCheck(result, opts) {
    let out;
    try { out = selfCheckCore(result, opts); } catch (e) {
      out = { hits: [{ row: -1, col: -1, header: '', text: 'self-check failed: ' + String((e && e.message) || e), type: 'ERROR', kind: 'error' }], providerHits: [], coincidences: [], unnamed: [], patients: 0 };
    }
    ((result && result.errors) || []).forEach((er) => out.hits.push({ row: er.row, col: er.col, header: er.header || '', text: 'processing error: ' + er.message, type: 'ERROR', kind: 'error' }));
    return out;
  }
  function selfCheckCore(result, opts) {
    const o = Object.assign({ kind: 'table' }, opts || {});
    const census = result.census, cfg = result.cfg;
    const digitsOf = (v) => cellToString(v).replace(/\D/g, '');
    const dobHasYear = (v) => isDate(v) || /\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\b\d{1,2}-[A-Za-z]{3,}-\d{2}\b/.test(cellToString(v));
    const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;
    const isMonthOfDate = (text, start, end, tok) => MONTH_WORD.test(tok) && (/^\.?\s+\d{1,2}(st|nd|rd|th)?\b/.test(text.slice(end)) || /\d{1,2}(st|nd|rd|th)?(\s+of)?[\s\-]$/i.test(text.slice(Math.max(0, start - 20), start)));
    // the per-patient index is built once per census and reused by every slice of a long result (the page checks a long
    // input in slices that share the census's patient maps)
    const { digitKeys, tokenIndex, tokenScan, initialPairs, stemsByInitial, studyCodes, unnamed, fuzzy } = checkIndexOf(census);
    const hits = [], providerHits = [], coincidences = [];
    const outRows = result.rows, headers = result.headers;
    return selfCheckScan(result, o, census, cfg, { hits, providerHits, coincidences, unnamed, digitKeys, tokenIndex, tokenScan, initialPairs, stemsByInitial, studyCodes, fuzzy, outRows, headers, digitsOf, dobHasYear, isMonthOfDate });
  }
  const CHECK_INDEX = new WeakMap();
  function checkIndexOf(census) {
    const holder = census.patients;
    const nKnown = census.known ? census.known.size : 0;
    const cached = holder && typeof holder === 'object' ? CHECK_INDEX.get(holder) : null;
    if (cached && cached.known === census.known && cached.nP === census.patients.size && cached.nK === nKnown) return cached.index;
    const index = buildCheckIndex(census);
    if (holder && typeof holder === 'object') CHECK_INDEX.set(holder, { known: census.known, nP: census.patients.size, nK: nKnown, index });
    return index;
  }
  function buildCheckIndex(census) {
    const unnamed = [];
    const digitsOf = (v) => cellToString(v).replace(/\D/g, '');
    const dobHasYear = (v) => isDate(v) || /\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|\b\d{1,2}-[A-Za-z]{3,}-\d{2}\b/.test(cellToString(v));
    // per patient: digit keys and name tokens
    const digitKeys = new Map(); // digits (leading zeros stripped) -> { entity, type }
    // every name token of every patient in one lookup, matched by one alternation per cell (a table of thousands of patients
    // is checked in time proportional to its size, not to rows x patients)
    const tokenIndex = new Map(); // lower-case token -> [{ entity, exactCase, text, common }]
    const initialPairs = new Map(); // "F|L" -> entities (dotted initials F.L.)
    const stemsByInitial = new Map(); // surname initial -> [{ stem, entity }] ("Teo… E.")
    const addDigits = (d, entity, type) => { const k = d.replace(/^0+/, ''); if (k.length >= 5) digitKeys.set(k, { entity, type }); };
    // the study codes the tool writes itself (P001, A-P6395): their digits are never a patient's identifier or birthdate
    const studyCodes = new Set();
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
        [pn.first, pn.last, ...(pn.middle ? pn.middle.split(/\s+/) : [])].forEach((t) => { if (!t || t.length > 200) return; const c = t.replace(/\.$/, ''); if (c.length >= 3 && !/\s/.test(c)) toks.add(c); c.split(/[-\s]+/).forEach((h) => { if (h.length >= 3) toks.add(h); }); });
        if (pn.first) LEX.nicknamesOf(pn.first).forEach((n) => { if (n.length >= 3 && !LEX.isCuratedAmbiguous(n) && !LEX.isClinical(n)) toks.add(n); });
        // a hyphenated or two-part given name or surname run together ("mikyung" for Mi-Kyung, "MbekiLarsson")
        if (pn.first && /[-\s]/.test(pn.first)) { const g = pn.first.replace(/[-\s]+/g, ''); if (g.length >= 4) toks.add(g); }
        if (pn.last && /[-\s]/.test(pn.last)) { const g = pn.last.replace(/[-\s]+/g, ''); if (g.length >= 5 && g.length <= 200) toks.add(g); }
        if (pn.first && pn.last) {
          const ik = `${pn.first[0]}|${pn.last[0]}`; if (!initialPairs.has(ik)) initialPairs.set(ik, new Set()); initialPairs.get(ik).add(p.key);
          const stem = pn.first.length >= 4 ? pn.first.slice(0, 3) : pn.first;
          if (!stemsByInitial.has(pn.last[0])) stemsByInitial.set(pn.last[0], []); stemsByInitial.get(pn.last[0]).push({ stem, entity: p.key });
        }
      }
      // the preferred name or nickname from the patient's own column
      if (p.entity && p.entity.nicks) p.entity.nicks.forEach((n) => String(n).split(/[\s,]+/).forEach((w) => { if (w.length > 200) return; const c = w.replace(/^[^\p{L}]+/u, '').replace(/[^\p{L}]+$/u, ''); if (c.length >= 3) toks.add(c); }));
      if (p.entity && p.entity.code) studyCodes.add(String(p.entity.code));
      for (const t of toks) {
        // a common token (an ordinary or clinical word: May, Will, Rose) counts only as the census wrote it and in the patient's
        // own row, unless it sits in a person slot; a name that is only also a place or a rare word ("Rosario") counts in any case
        const common = LEX.isEnglishWord(t) || LEX.isClinical(t) || LEX.RELATION_SET.has(t.toLowerCase()) || COMMON_LOWER.has(t.toLowerCase()) || monthIndex(t) > 0 || /^(the|and|for|not|with|from|pt|pts|per|see|ok|yes|all|one|two|new|old|van|von|der|den|del|los|las|san|dos|da|de|la|le|di|du|bin|ibn|abu|al|el)$/i.test(t);
        const k = t.toLowerCase(); if (!tokenIndex.has(k)) tokenIndex.set(k, []);
        tokenIndex.get(k).push({ entity: p.key, exactCase: common, text: t, common });
      }
      if (!p.known && !p.names.size && !(p.parsed && p.parsed.last)) unnamed.push({ entity: p.key, code: p.entity ? p.entity.code : '', row: p.rows[0] });
    }
    // every token matched by one dictionary scan (letters and digits bound a token), as one alternation regex would
    const tokenScan = tokenIndex.size ? makeScan(tokenIndex.keys()) : null;
    const fuzzy = surnameIndex([...census.patients.values(), ...(census.known ? census.known.values() : [])]);
    return { digitKeys, tokenIndex, tokenScan, initialPairs, stemsByInitial, studyCodes, unnamed, fuzzy };
  }
  function selfCheckScan(result, o, census, cfg, ix) {
    const { hits, providerHits, coincidences, unnamed, digitKeys, tokenIndex, tokenScan, initialPairs, stemsByInitial, studyCodes, fuzzy, outRows, headers, digitsOf, dobHasYear, isMonthOfDate } = ix;
    void digitsOf;
    const ageAfterName = /(?:\b[A-Z][a-z]+,?\s|\b(?:turned|turning|is|now|age|aged)\s)(9\d|1[01]\d)(?![\d+\/%:]|\.\d|\s*(?:mg|mcg|kg|lb|lbs|ml|mL|cc|units?|%|mmhg|bpm|min|hrs?|yo|y\/o|yrs?|years?|day|days|x))/g;
    const vitalBefore = /\b(?:hr|bp|spo2|o2|sat|sats|pulse|wt|weight|glucose|bg|temp|k|na|cr|plt|hgb|wbc|anc|rate|dose|level|count|score|mg|egfr|inr|ldh|auc|room|chair|bay|ext|x|cycle|day|grade|stage|pain)\s*$/i;
    // one cell of the output; a header cell (ri = -1) has no row patient, and a common word (Ward, Bay, May) is never read as a
    // name there, as the detector does not read it as one either
    const scanCell = (v, ri, ci, isHeader) => {
      const s = cellToString(v); if (!s) return;
      const header = isHeader ? 'Column heading' : headers[ci]; if (!isHeader && header === 'DeID Audit') return;
      const rowKey = isHeader ? null : census.rowPatient[ri];
      const rowExtra = isHeader ? null : census.rowExtra ? census.rowExtra[ri] : null;
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
        if (studyCodes.has('P' + nm[0]) && /(?:^|[^A-Za-z0-9])(?:A-)?P$/.test(s.slice(Math.max(0, nm.index - 4), nm.index)) && !/^[A-Za-z]/.test(s.slice(nm.index + nm[0].length))) continue;
        if (hit.type === 'DOB' && rowKey && !ownRow(hit.entity)) { coincidences.push({ row: ri, col: ci, header, text: nm[0] }); continue; }
        push(nm[0], hit.type, hit.entity, 'digits');
      }
      // 3. every name token, diminutive and initial of every census patient
      if (tokenScan) {
        for (const m of scanLookup(s, tokenScan)) {
          for (const nt of tokenIndex.get(m[0].toLowerCase()) || []) {
            if (isCredentialToken(m[0])) continue;
            // in a person slot ("pt rose called", "left vm for regina") any listed token is a hit, whatever its case or row
            if (!isHeader && !/^(?:van|von|der|den|del|los|las|san|dos|da|de|la|le|di|du|bin|ibn|abu|al|el)$/i.test(m[0]) && !(monthIndex(m[0]) && /^[ \t]*\d/.test(s.slice(m.index + m[0].length))) && personSlot(s, m.index, m.index + m[0].length)) { push(m[0], 'NAME_PATIENT', nt.entity, 'token'); break; }
            if (nt.common && isHeader) continue;
            if (nt.common && m[0] !== nt.text) continue; // a common word matches only as the census wrote it
            if (nt.exactCase && !/^[A-Z]/.test(m[0])) continue;
            if (nt.common && isMonthOfDate(s, m.index, m.index + m[0].length, m[0])) continue;
            // a common word (May, Will, Rose, Grey) counts only inside the patient's own row, where it was row-scoped for the detector too
            if (nt.common && rowKey && !ownRow(nt.entity)) continue;
            if (nt.common && /^\s+(?:sign|signs|syndrome|disease|test|reflex|period|garden|geranium|arbor|lodge|turner|curve|call|need|be|hold|chart|insurance|for|to)\b/i.test(s.slice(m.index + m[0].length, m.index + m[0].length + 20))) continue;
            // an eponym the detector kept as clinical ("Bell's palsy" in the row of a patient named Bell): the same rule here
            if (nt.common) { const after = s.slice(m.index + m[0].length, m.index + m[0].length + 40).match(/^(?:['’]s?)?\s+([A-Za-z]+)/); if (after && (LEX.EPONYM_FOLLOW.has(after[1].toLowerCase()) || (LEX.isClinical(m[0]) && MED_SUFFIX.test(after[1])))) continue; }
            push(m[0], 'NAME_PATIENT', nt.entity, 'token');
            break;
          }
        }
      }
      // a file name glues name parts with capitals ("ConsentMbekiLarsson.pdf"): its CamelCase pieces, alone and run together
      if (tokenScan && /[a-z][A-Z]/.test(s) && FILE_EXT_RE.test(s)) {
        const ft = new RegExp(FILE_TOKEN_RE.source, 'gi'); let fm;
        while ((fm = ft.exec(s))) {
          const pieces = (fm[0].match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || []);
          for (let i = 0; i < pieces.length; i++) for (let k = 1; k <= 3 && i + k <= pieces.length; k++) {
            const w = pieces.slice(i, i + k).join(''); if (w.length < 4) continue;
            const nts = tokenIndex.get(w.toLowerCase()); if (!nts) continue;
            const nt = nts.find((x) => !x.common); if (nt) push(w, 'NAME_PATIENT', nt.entity, 'token');
          }
        }
      }
      // a listed surname misspelled by one letter or one swap ("Okonkow", "Szczepanksi"): over-sensitive on purpose
      if (fuzzy && fuzzy.idx.size) {
        const wre = /(?<![\p{L}0-9'’])\p{Lu}[\p{L}'’]{5,40}(?![\p{L}0-9])/gu; let wm;
        while ((wm = wre.exec(s))) { const w = wm[0].replace(/['’]s$/, ''); if (!looksMisspelledName(w)) continue; const ents = fuzzySurnameHits(fuzzy, w); if (ents.length) push(w, 'NAME_PATIENT', ents[0], 'fuzzy'); }
      }
      if (initialPairs.size && /[A-Z]\./.test(s)) {
        const ire = /(?<![\w])([A-Z])\.\s?([A-Z])\.(?![\w])/g; let m;
        while ((m = ire.exec(s))) { const ents = initialPairs.get(`${m[1]}|${m[2]}`); if (ents && !isCredentialToken(m[0])) push(m[0], 'NAME_PATIENT', [...ents][0], 'token'); }
        const sre = /(?<![\w])([A-Za-z'’\-]+)\s([A-Z])\./g;
        while ((m = sre.exec(s))) {
          const cands = stemsByInitial.get(m[2]); if (!cands) continue;
          const hit = cands.find((c) => m[1].startsWith(c.stem) && /^[a-z]*$/.test(m[1].slice(c.stem.length)));
          if (hit) push(m[0], 'NAME_PATIENT', hit.entity, 'token');
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
    };
    // the headers are written to the file too (the audit and derived-age headers are the page's own)
    if (o.headers !== false && Array.isArray(headers)) headers.forEach((h, ci) => { if (h !== 'DeID Audit' && h !== 'Age (derived)') scanCell(h, -1, ci, true); });
    outRows.forEach((row, ri) => (Array.isArray(row) ? row : [row]).forEach((v, ci) => scanCell(v, ri, ci, false)));
    if (cfg.surrogate.dateShift) result.details.forEach((d) => { if (d.patientCode && d.offset === 0) hits.push({ row: d.row, col: -1, header: 'Dates', text: 'not shifted', type: 'DATE', kind: 'offset' }); });
    // a patient created from an MRN or a birthdate whose name was never read: the check above cannot vouch for a name it never saw
    const unnamedHits = o.kind === 'table' ? [] : unnamed.slice();
    return { hits, providerHits, coincidences, unnamed: unnamedHits, patients: census.patients.size };
  }

  const VERSION = '0.1.0';
  // Release scan: an independent check of the protected output against the SOURCE, written apart from the detectors so a
  // miss in them is not repeated here. It never changes the output; it only reports.
  //  identifiers: an identifier-column value (patient last name, MRN, account, phone) that still appears anywhere in the output
  //  words:       a capitalised source word of 4+ letters that survived unchanged and is not a dictionary, clinical,
  //               drug-stem or allowlisted word (the review queue)
  //  needles:     the identifier values, kept so the written file can be re-read and checked again
  function releaseScan(table, result, opts) {
    const o = opts || {};
    const out = { identifiers: [], words: [], needles: { digits: [], names: [] } };
    if (!table || !result || !Array.isArray(result.rows) || !Array.isArray(table.rows)) return out;
    const allow = new Set((o.allowlist || []).map((w) => String(w).toLowerCase()));
    const cols = Array.isArray(result.columns) ? result.columns : [];
    const roleAt = new Map(); cols.forEach((c, i) => roleAt.set(c.index != null ? c.index : i, c.role));
    const digitSet = new Set(), nameSet = new Set();
    table.rows.forEach((row) => roleAt.forEach((role, ci) => {
      const v = cellToString(row && row[ci]).trim(); if (!v) return;
      if (role === 'mrn' || role === 'account' || role === 'phone') { const d = v.replace(/\D/g, ''); if (d.length >= 6) digitSet.add(d); }
      else if (role === 'patient_name') {
        const pn = parseName(v); const last = pn && pn.last ? pn.last : '';
        last.split(/[\s\-]+/).forEach((t) => { const w = t.replace(/[^A-Za-zÀ-ÿ'’]/g, ''); if (w.length >= 4 && !LEX.isEnglishWord(w) && !LEX.isDictWord(w) && !LEX.isClinical(w)) nameSet.add(w.toLowerCase()); });
      }
    }));
    out.needles.digits = [...digitSet]; out.needles.names = [...nameSet];
    const hits = findNeedles(result.headers ? [result.headers, ...result.rows] : result.rows, out.needles);
    hits.forEach((h) => out.identifiers.push({ row: h.row - (result.headers ? 1 : 0), col: h.col, header: cellToString((result.headers || [])[h.col]), text: h.text, type: h.type }));
    const ordinary = (w) => {
      const lc = w.toLowerCase();
      if (allow.has(lc) || /^[A-Z]{2,}s?$/.test(w) || monthIndex(w)) return true;
      if (/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i.test(w)) return true;
      if (LEX.isEnglishWord(w) || LEX.isDictWord(w) || LEX.isClinical(w) || DRUG_STEM.test(w) || MED_MORPH.test(w)) return true;
      return w.split(/[-’']/).filter((x) => x.length >= 2).every((x) => LEX.isEnglishWord(x) || LEX.isDictWord(x) || LEX.isClinical(x)) && /[-]/.test(w);
    };
    const TOK = /[A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ'’\-]*[A-Za-zÀ-ÖØ-öø-ÿ]/g;
    const seen = new Map();
    result.rows.forEach((orow, ri) => {
      const srow = table.rows[ri]; if (!srow) return;
      roleAt.forEach((role, ci) => {
        if (role !== 'text' && role !== 'keep') return;
        const so = cellToString(orow[ci]); if (!so) return;
        const outToks = new Set(so.match(TOK) || []);
        const src = normalizeText(cellToString(srow[ci])); TOK.lastIndex = 0; let m;
        while ((m = TOK.exec(src))) {
          const w = m[0];
          if (w.length < 4 || !/^[A-ZÀ-ÖØ-Þ]/.test(w) || !outToks.has(w) || ordinary(w)) continue;
          // an eponym: "Lee Silverman voice", "Hunter syndrome", "Glasgow Coma scale"
          if (/^\s+(?:[A-Z][a-z]+\s+)?(?:voice|syndrome|disease|sign|test|scale|score|criteria|classification|procedure|maneuver|manoeuvre|palsy|reflex|phenomenon|method|protocol|regimen|catheter|line|port|needle|stage|grade)\b/i.test(src.slice(m.index + w.length, m.index + w.length + 40))) continue;
          const e = seen.get(w); if (e) { e.count++; continue; }
          const rec = { row: ri, col: ci, header: cellToString((result.headers || [])[ci]), text: w, count: 1 }; seen.set(w, rec); out.words.push(rec);
        }
      });
    });
    return out;
  }
  // Look for identifier values in a grid of cells (any cell, any column): digit identifiers inside digit runs (separators
  // allowed), last names as whole words in any case.
  function findNeedles(aoa, needles) {
    const hits = []; if (!needles) return hits;
    const digits = (needles.digits || []).filter((d) => d.length >= 6);
    const names = needles.names || [];
    const nameRe = names.length ? new RegExp(`(?<![A-Za-zÀ-ÿ])(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![A-Za-zÀ-ÿ])`, 'gi') : null;
    (aoa || []).forEach((row, ri) => (Array.isArray(row) ? row : [row]).forEach((cell, ci) => {
      const t = cell instanceof Date ? '' : cellToString(cell); if (!t) return;
      if (digits.length && /\d{3}/.test(t)) {
        for (const run of t.match(/\d[\d\-\s.()\/]*\d/g) || []) {
          const d = run.replace(/\D/g, ''); if (d.length < 6) continue;
          const hit = digits.find((n) => d.includes(n)); if (hit) { hits.push({ row: ri, col: ci, text: run, type: 'ID' }); break; }
        }
      }
      if (nameRe) { nameRe.lastIndex = 0; const m = nameRe.exec(t); if (m) hits.push({ row: ri, col: ci, text: m[0], type: 'NAME_PATIENT' }); }
    }));
    return hits;
  }

  return {
    VERSION, TYPES, COARSE, ROLES, ROLE_LABELS, classifyColumns, inferIdPattern, parseName, nameVariants, buildCensus,
    detectText, ruleSpans, lexiconSpans, censusSpans, resolveSpans, mergeAdjacentNames, collectPropagation,
    parseDateString, renderDate, shiftDate, dateRenderings, bandAge,
    Surrogator, applySpans, defaultConfig, compileConfig, processTable, reidentify, selfCheck,
    createRegistry, normalizeId, mrnKeyOf, dobKeyOf, levenshtein, parseTextDocument, normalizeOcrText,
    cellToString, mulberry32, hashString, tokenize, normalizeText, safeCell, releaseScan, findNeedles, isRestrictedZip3,
  };
});
