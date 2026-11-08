/* Infusion De-ID — synthetic stress set
 * Generates infusion-schedule style rows with PHI injected programmatically,
 * recording the exact character spans of every identifier. Ground truth is
 * exact by construction, so this set can be shared outside the hospital.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./lexicon.js'), require('./core.js'));
  else root.DeIDSynth = factory(root.DeIDLexicon, root.DeID);
})(typeof self !== 'undefined' ? self : this, function (LEX, D) {
  'use strict';

  const pad2 = (n) => String(n).padStart(2, '0');
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const REGIMENS = ['FOLFOX', 'FOLFIRI', 'R-CHOP', 'ABVD', 'Keytruda 200 mg q3w', 'Opdivo 480 mg q4w', 'Carbo/Taxol', 'AC-T', 'TCHP', 'Gemzar/Abraxane', 'Darzalex SC', 'Rituxan maint', 'Velcade/Dex', 'Zometa', 'Xgeva', 'Iron sucrose', 'IVIG', 'Ocrevus', 'Entyvio', 'Remicade', 'Pemetrexed', 'Cisplatin/Etoposide', 'CAPOX', 'Tecentriq', 'Imfinzi', 'Enhertu'];
  const DEPTS = ['Infusion A', 'Infusion B', 'Chemo Suite', 'Heme Onc', 'Med Onc', 'Rad Onc Infusion', 'Short Stay'];
  const STREETS = ['Oak', 'Maple', 'Elm', 'Delaware', 'Main', 'Transit', 'Sheridan', 'Niagara', 'Union', 'Genesee', 'Park', 'Hertel', 'Elmwood', 'Kenmore', 'Lake'];
  const RELS = ['son', 'daughter', 'wife', 'husband', 'sister', 'brother', 'mother', 'father', 'granddaughter', 'grandson', 'niece', 'nephew', 'friend', 'neighbor', 'caregiver', 'partner', 'spouse', 'aunt', 'uncle'];
  const CITIES_ST = [['Buffalo', 'NY'], ['Rochester', 'NY'], ['Amherst', 'NY'], ['Cheektowaga', 'NY'], ['Erie', 'PA'], ['Cleveland', 'OH'], ['Syracuse', 'NY'], ['Hamburg', 'NY'], ['Niagara Falls', 'NY'], ['Jamestown', 'NY'], ['Toronto', 'ON'], ['Pittsburgh', 'PA'], ['Orlando', 'FL'], ['Phoenix', 'AZ'], ['Lockport', 'NY'], ['Tonawanda', 'NY'], ['Batavia', 'NY'], ['Olean', 'NY']];
  const STATES = ['Florida', 'Arizona', 'North Carolina', 'Ohio', 'Pennsylvania', 'Texas', 'California', 'Georgia', 'Vermont', 'Maine'];
  const ORGS = ['Roswell Park Cancer Center', 'Buffalo General Hospital', 'Mercy Hospital', 'Sisters of Charity Hospital', 'Kenmore Mercy', 'ECMC', 'Strong Memorial Hospital', 'Wilmot Cancer Institute', 'Cleveland Clinic', 'UPMC Hamot', 'Oishei Children\'s Hospital', 'Catholic Health', 'Great Lakes Cancer Care', 'Windsong Radiology', 'Hospice Buffalo', 'Niagara Falls Memorial Medical Center', 'Trinity Medical Associates', 'Mount St. Mary\'s Hospital', 'Dent Neurologic Institute', 'Southtowns Oncology'];
  const EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'aol.com', 'icloud.com', 'roadrunner.com'];

  // Non-PHI fragments. Includes eponyms, drug names, and words-that-are-names
  // so the scorer measures over-redaction on the hard cases.
  const NEG = [
    'ANC 1.2, hold if <1.0', 'Port flushed, no issues', 'Keytruda 200 mg q3w', 'Hodgkin lymphoma s/p ABVD', "Bell's palsy hx", 'Graves disease, on methimazole',
    'Ewing sarcoma protocol', 'Wilms tumor survivor', 'Burkitt lymphoma, R-EPOCH', 'Will call if fever >100.4', 'grace period for labs ok', 'rose from chair without assist',
    'C1D1 today', '1/2 dose carbo per MD', 'Cycle 3/6', 'Zofran 8 mg PO premed', 'Decadron 12 mg IV', 'pt tolerated well', 'Chair 4 preferred', 'Labs drawn at 0900',
    'ECOG 1', 'Stage IIIB', 'Gleason 7', 'Ann Arbor stage II', "Parkinson's dx", "Cushing's hx", 'Crohn disease', 'Richter transformation', 'Merkel cell carcinoma',
    'Paget disease of bone', "Addison's, on hydrocortisone", 'hold Lasix day of tx', 'May need dose reduction', 'Benadryl 25 mg premed', 'Reglan prn', 'sent to pharmacy',
    'Neulasta Onpro placed', 'Hgb 9.8, transfuse if <8', 'K 3.4 repleted', 'Mg 1.6 replete', 'cold cap requested', 'Huber needle 20g x 1 in', 'TPA for sluggish port',
    'Pt in Bay 2', 'Plt 88k, ok per protocol', 'Dose banded per Epic', 'Beacon plan signed', 'verbal consent obtained', 'pt NPO for scan', 'Dexa 20 mg day 1 only',
    'No premeds needed', 'Will hold if Cr >1.5', 'Mark chart for delay', 'Bill for 96413', 'June cycle complete', 'hope to resume next week', 'pt rose BP 150/90',
    'Jan and Feb cycles done', 'No Hope Lodge needed', 'Rose Garden entrance', 'Grant funding approved', 'Chase for records', 'Wilson disease ruled out',
    'Lee Silverman voice tx referral', 'Bell curve ok', 'May be late', 'Will reschedule', 'Grace noted good tolerance', 'Hunter syndrome n/a', 'Turner syndrome hx',
    'Lynch syndrome +', 'Down syndrome', 'Barrett esophagus', 'Kaposi sarcoma', 'Waldenstrom macroglobulinemia', 'Fanconi anemia', 'Li-Fraumeni +',
  ];

  function make(opts) {
    const o = Object.assign({ n: 500, seed: 7, holdoutShare: 0.3, patientsRatio: 0.4, startDate: new Date(2026, 10, 2) }, opts || {});
    const rng = D.mulberry32(o.seed);
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const chance = (p) => rng() < p;
    const randInt = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const digits = (n) => { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(rng() * 10); return s; };

    const firstName = (holdout) => (holdout ? pick(LEX.HOLDOUT_FIRST) : pick(LEX.FIRST_NAMES));
    const lastName = (holdout) => (holdout ? pick(LEX.HOLDOUT_LAST) : pick(LEX.SURNAMES));
    const thirdPartyName = () => {
      const holdout = chance(o.holdoutShare);
      const f = firstName(holdout), l = lastName(holdout);
      return { first: f, last: l, holdout };
    };
    const phone = () => {
      const area = pick(['716', '585', '315', '814', '216', '412', '905', '647']);
      const fmt = pick(['###-###-####', '(###) ###-####', '###.###.####', '##########', '###-####', '+1 ###-###-####']);
      let out = '', d = fmt.includes('###-####') && fmt.length === 8 ? digits(7) : area + digits(7);
      let i = 0; for (const ch of fmt) out += ch === '#' ? d[i++] : ch;
      if (chance(0.15)) out += pick([' x', ' ext ', ' ext. ']) + digits(randInt(2, 4));
      return out;
    };
    const dateStr = (d, style) => {
      const m = d.getMonth() + 1, day = d.getDate(), y = d.getFullYear();
      switch (style || randInt(0, 8)) {
        case 0: return `${m}/${day}/${pad2(y % 100)}`;
        case 1: return `${m}/${day}/${y}`;
        case 2: return `${y}-${pad2(m)}-${pad2(day)}`;
        case 3: return `${MON[m - 1]} ${day}`;
        case 4: return `${MON[m - 1]} ${day}, ${y}`;
        case 5: return `${day}-${MON[m - 1]}`;
        case 6: return `${day} ${MON[m - 1]} ${y}`;
        case 7: return `${m}/${day}`;
        case 8: return `${MONTH_FULL[m - 1]} ${day}${['th', 'st', 'nd', 'rd'][day % 10 > 3 || (day % 100 >= 11 && day % 100 <= 13) ? 0 : day % 10]}`;
      }
      return `${m}/${day}/${y}`;
    };
    const nearDate = (base) => new Date(base.getTime() + randInt(-60, 60) * 86400000);

    // Patients
    const nPatients = Math.max(3, Math.round(o.n * o.patientsRatio));
    const patients = [];
    const usedMrn = new Set();
    for (let i = 0; i < nPatients; i++) {
      const holdout = chance(0.15);
      const first = firstName(holdout), last = lastName(holdout);
      let mrn; do { mrn = (chance(0.3) ? '0' : '') + digits(chance(0.3) ? 7 : 8); } while (usedMrn.has(mrn)); usedMrn.add(mrn);
      const age = randInt(28, 97);
      const dob = new Date(2026 - age, randInt(0, 11), randInt(1, 28));
      const nameStyle = pick(['last_first', 'last_first', 'last_first', 'upper', 'first_last']);
      const middle = chance(0.3) ? pick('ABCDEJKLMRST'.split('')) : '';
      const nameCell = nameStyle === 'first_last' ? `${first} ${middle ? middle + '. ' : ''}${last}` : nameStyle === 'upper' ? `${last}, ${first}${middle ? ' ' + middle : ''}`.toUpperCase() : `${last}, ${first}${middle ? ' ' + middle : ''}`;
      patients.push({ first, last, holdout, mrn, age, dob, nameCell, acct: digits(10), phone: phone(), sex: pick(['F', 'M']), regimen: pick(REGIMENS) });
    }
    const providers = [];
    for (let i = 0; i < 8; i++) { const f = pick(LEX.FIRST_NAMES), l = pick(LEX.SURNAMES); providers.push({ first: f, last: l, cell: `${l}, ${f} ${pick(['MD', 'MD', 'DO', 'NP', 'PA-C'])}` }); }

    // Fragment builders: return { text, spans:[{start,end,type,sub,holdout}] }
    const frag = (parts) => {
      // parts: array of strings or {t, type, sub, holdout}
      let text = '', spans = [];
      for (const p of parts) {
        if (typeof p === 'string') { text += p; continue; }
        spans.push({ start: text.length, end: text.length + p.t.length, type: p.type, sub: p.sub || '', holdout: !!p.holdout });
        text += p.t;
      }
      return { text, spans };
    };
    const N = (t, sub, holdout) => ({ t, type: 'NAME', sub, holdout });
    const PH = (t) => ({ t, type: 'PHONE' });
    const DT = (t) => ({ t, type: 'DATE' });
    const ORG = (t) => ({ t, type: 'ORG' });
    const LOC = (t) => ({ t, type: 'LOCATION' });
    const AGE = (t) => ({ t, type: 'AGE' });
    const EM = (t) => ({ t, type: 'EMAIL' });
    const MR = (t) => ({ t, type: 'MRN' });
    const AC = (t) => ({ t, type: 'ACCOUNT' });

    const PHI_FRAGS = [
      (ctx) => { const n = thirdPartyName(); const full = chance(0.5); return frag([pick(["pt's ", 'pts ', 'patient\'s ', '']), pick(RELS), ' ', N(full ? `${n.first} ${n.last}` : n.first, 'relative', n.holdout), ' ', PH(phone()), pick([' will pick up', ' to be called w/ results', ' is contact', ' driving'])]); },
      (ctx) => { const n = thirdPartyName(); return frag(['Called ', N(n.first, 'relative', n.holdout), ' at ', PH(phone()), pick([' re: labs, LVM', ', no answer', ', confirmed appt'])]); },
      (ctx) => { const p = pick(providers); return frag(['Dr. ', N(p.last, 'provider'), ' (', ORG(pick(ORGS)), ') to send records']); },
      (ctx) => frag(['Referred from ', ORG(pick(ORGS)), '; last tx ', DT(dateStr(nearDate(ctx.appt)))]),
      (ctx) => { const [c, st] = pick(CITIES_ST); const a = ctx.p.age; return a >= 90 ? frag(['pt is ', AGE(`${a} y/o`), ', lives in ', LOC(`${c}, ${st}`)]) : frag([`pt is ${a} y/o, lives in `, LOC(`${c}, ${st}`)]); },
      (ctx) => { const p = pick(providers); return frag(['Premeds per Dr. ', N(p.last, 'provider'), '; next cycle ', DT(dateStr(nearDate(ctx.appt)))]); },
      (ctx) => frag([N(ctx.p.first, 'patient', ctx.p.holdout), pick([' prefers chair ', ' requests chair ']), String(randInt(1, 12))]),
      (ctx) => frag(['Spoke w/ ', N(`${ctx.p.last}, ${ctx.p.first}`, 'patient', ctx.p.holdout), ' re schedule']),
      (ctx) => frag(['pt ', N(ctx.p.last, 'patient', ctx.p.holdout), ' requests AM slot']),
      (ctx) => frag(['MRN ', MR(ctx.p.mrn), ' confirmed']),
      (ctx) => frag(['DOB ', DT(dateStr(ctx.p.dob, pick([0, 1, 2]))), ' verified']),
      (ctx) => frag(['send results to ', EM(`${pick([ctx.p.first[0].toLowerCase() + ctx.p.last.toLowerCase(), ctx.p.first.toLowerCase() + randInt(1, 99)])}@${pick(EMAIL_DOMAINS)}`)]),
      (ctx) => { const n = thirdPartyName(); return frag([N(`${n.first} ${n.last}`, 'relative', n.holdout), ' (', pick(RELS), ') is POA']); },
      (ctx) => { const n = thirdPartyName(); return frag([N(n.first, 'relative', n.holdout), ', ', pick(['her ', 'his ', 'their ']), pick(RELS), ', drives']); },
      (ctx) => { const n = thirdPartyName(); return frag([N(`${n.first} ${n.last}`, 'provider', n.holdout), ' RN called from ', ORG(pick(ORGS))]); },
      (ctx) => frag([pick(['moved to ', 'wintering in ', 'relocating to ']), LOC(pick(STATES))]),
      (ctx) => { const [c, st] = pick(CITIES_ST); return frag([pick(['from ', 'lives in ', 'coming from ']), LOC(c), ' — ', String(randInt(20, 120)), ' min drive']); },
      (ctx) => { const [c, st] = pick(CITIES_ST); return frag(['home address ', LOC(`${randInt(10, 9999)} ${pick(STREETS)} ${pick(['St', 'Ave', 'Rd', 'Dr', 'Blvd'])}`), ', ', LOC(`${c}, ${st} ${digits(5)}`)]); },
      (ctx) => { const n = thirdPartyName(); return frag(['caregiver ', N(n.first, 'relative', n.holdout), ' ', PH(phone())]); },
      (ctx) => { const p = pick(providers); const cred = p.cell.slice(p.cell.lastIndexOf(' ')); return frag(['f/u ', DT(dateStr(nearDate(ctx.appt))), ' with ', N(p.cell.slice(0, p.cell.lastIndexOf(' ')), 'provider'), cred]); },
      (ctx) => frag(['acct ', AC(ctx.p.acct), ' updated']),
      (ctx) => { const n = thirdPartyName(); return frag(['per ', N(`${n.last}, ${n.first}`, 'relative', n.holdout), ' (', pick(RELS), ')']); },
      (ctx) => frag(['labs ', DT(dateStr(nearDate(ctx.appt))), ', scan ', DT(dateStr(nearDate(ctx.appt))), ', MD visit ', DT(dateStr(nearDate(ctx.appt)))]),
      (ctx) => { const p = pick(providers); return frag(['per ', N(`${p.first} ${p.last}`, 'provider'), ' ', pick(['MD', 'NP', 'PA']), ' ok to proceed']); },
      (ctx) => ctx.p.age >= 90 ? frag([AGE(`${ctx.p.age}-year-old`), ' w/ fall risk']) : frag([`${ctx.p.age}-year-old w/ fall risk`]),
      (ctx) => ctx.p.age >= 90 ? frag(['pt in ', AGE('her 90s'), ', needs transport']) : frag(['pt needs transport']),
      (ctx) => { const n = thirdPartyName(); return frag(['Mrs. ', N(n.last, 'relative', n.holdout), ' (mother) at bedside']); },
      (ctx) => { const n = thirdPartyName(); return frag(['outside onc Dr. ', N(n.last, 'provider', n.holdout), ' at ', ORG(pick(ORGS)), ' ', PH(phone())]); },
    ];

    const headers = ['Appt Date', 'Appt Time', 'Patient Name', 'MRN', 'DOB', 'Age', 'Sex', 'Acct #', 'Phone', 'Attending', 'Regimen', 'Cycle/Day', 'Chair', 'Dept', 'Comments'];
    const COMMENT_COL = headers.indexOf('Comments');
    const rows = [], truth = [];
    for (let i = 0; i < o.n; i++) {
      const p = pick(patients);
      const appt = new Date(o.startDate.getTime() + randInt(0, 20) * 86400000);
      const prov = pick(providers);
      const ctx = { p, appt, prov };
      // comment: 0-3 PHI fragments + 0-3 negatives, shuffled
      const nPhi = chance(0.1) ? 0 : randInt(1, 3), nNeg = randInt(0, 3);
      const items = [];
      for (let k = 0; k < nPhi; k++) items.push(pick(PHI_FRAGS)(ctx));
      for (let k = 0; k < nNeg; k++) items.push({ text: pick(NEG), spans: [] });
      for (let k = items.length - 1; k > 0; k--) { const j = Math.floor(rng() * (k + 1)); [items[k], items[j]] = [items[j], items[k]]; }
      let text = '', spans = [];
      items.forEach((it, idx) => { if (idx) text += pick(['. ', '; ', ' - ', '. ', '\n']); it.spans.forEach((s) => spans.push(Object.assign({}, s, { start: s.start + text.length, end: s.end + text.length }))); text += it.text; });
      const dobCell = chance(0.5) ? p.dob : dateStr(p.dob, pick([0, 1, 2]));
      const row = [appt, `${pad2(randInt(7, 16))}:${pick(['00', '15', '30', '45'])}`, p.nameCell, chance(0.7) ? p.mrn : Number(p.mrn), dobCell, p.age, p.sex, p.acct, p.phone, prov.cell, p.regimen, `C${randInt(1, 8)}D${pick([1, 1, 8, 15])}`, randInt(1, 14), pick(DEPTS), text];
      rows.push(row);
      truth.push({ row: i, col: COMMENT_COL, text, spans });
    }
    return { headers, rows, truth, patients, providers, commentCol: COMMENT_COL, options: o };
  }

  // Hand-built adversarial cases from the research memo. Each has a patient
  // (so the census layer is exercised), a comment, the PHI spans, and the
  // tokens that must NOT be redacted.
  function adversarial() {
    const cases = [
      { name: 'Word-names with relation cue', patient: ['Doe, Jane', '10000001'], text: "pt's daughter Grace will call; grace period for labs", phi: ['Grace'], keep: ['grace', 'period'] },
      { name: 'Eponym must survive', patient: ['Doe, Jane', '10000002'], text: 'Hodgkin lymphoma s/p ABVD; Ewing sarcoma clinic; Wilms tumor hx', phi: [], keep: ['Hodgkin', 'Ewing', 'Wilms'] },
      { name: "Bell's palsy vs Grace Bell", patient: ['Doe, Jane', '10000003'], text: "Bell's palsy hx. Daughter Grace Bell is POA.", phi: ['Grace Bell'], keep: ["Bell's", 'palsy'] },
      { name: 'Dr. Lee vs patient Lee', patient: ['Lee, Robert', '10000004'], text: 'Dr. Lee ok with premeds; pt Lee requests chair 3', phi: ['Lee', 'Lee'], keep: ['premeds', 'chair'] },
      { name: 'Dates in every format', patient: ['Doe, Jane', '10000005'], text: 'seen 11/7/26, 2026-11-07, Nov 7, 7-Nov, November 7th; next Tues', phi: ['11/7/26', '2026-11-07', 'Nov 7', '7-Nov', 'November 7th'], keep: ['next', 'Tues'] },
      { name: 'MRN with/without leading zeros, prefix, mid-sentence', patient: ['Doe, Jane', '00123456'], text: 'MRN 00123456 confirmed; chart 123456 merged; E00123456 old', phi: ['00123456', '123456', '00123456'], keep: ['confirmed', 'merged'] },
      { name: 'Ages 90+ and written', patient: ['Doe, Jane', '10000007'], text: 'pt is 92 y/o; husband in his 90s; daughter is 45', phi: ['92 y/o', 'his 90s'], keep: ['45'] },
      { name: 'Phones formatted and not, with extension', patient: ['Doe, Jane', '10000008'], text: 'call 716-555-0142 or (585) 555-0199 ext 22 or 7165550123; office 555-0100', phi: ['716-555-0142', '(585) 555-0199 ext 22', '7165550123', '555-0100'], keep: ['call', 'office'] },
      { name: 'Third parties', patient: ['Doe, Jane', '10000009'], text: 'spouse Mark Jones 716-555-0101; home-care agency Visiting Nurse Association; outside oncologist Dr. Patel at Roswell Park Cancer Center; referred by Mercy Hospital', phi: ['Mark Jones', '716-555-0101', 'Patel', 'Roswell Park Cancer Center', 'Mercy Hospital'], keep: ['spouse', 'outside', 'oncologist'] },
      { name: 'Hold-out (non-lexicon) names with cue', patient: ['Doe, Jane', '10000010'], text: 'son Thaddeus Abernathy 716-555-0177 will drive; Oluwaseun (niece) is POA', phi: ['Thaddeus Abernathy', '716-555-0177', 'Oluwaseun'], keep: ['will', 'drive'] },
      { name: 'Hold-out name without cue (expected hard)', patient: ['Doe, Jane', '10000011'], text: 'Vanterpool called about labs', phi: ['Vanterpool'], keep: ['called', 'labs'] },
      { name: 'Patient first name alone, mixed case', patient: ['Nguyen, May', '10000012'], text: 'May called re appt; MAY prefers chair 2; may need dose reduction', phi: ['May', 'MAY'], keep: ['may', 'need'] },
      { name: 'Census name in other row context', patient: ['Doe, Jane', '10000013'], text: 'Jane Doe spoke to scheduler; J. Doe confirmed', phi: ['Jane Doe', 'J. Doe'], keep: ['scheduler', 'confirmed'] },
      { name: 'Drug names and cycle fractions', patient: ['Doe, Jane', '10000014'], text: 'Keytruda 200 mg; Cycle 1/2; 1/2 dose carbo; Taxol 80 mg/m2 on D1,8,15', phi: [], keep: ['Keytruda', 'Taxol', '1/2', 'Cycle'] },
      { name: 'Email, SSN, address, ZIP', patient: ['Doe, Jane', '10000015'], text: 'jdoe55@gmail.com; SSN 123-45-6789; 123 Oak St, Buffalo, NY 14201', phi: ['jdoe55@gmail.com', '123-45-6789', '123 Oak St', 'Buffalo, NY 14201'], keep: ['SSN'] },
      { name: 'Provider credentials', patient: ['Doe, Jane', '10000016'], text: 'per Karen Lee MD; J. Smith, NP to see; seen by Patel PA-C', phi: ['Karen Lee', 'J. Smith', 'Patel'], keep: ['per', 'see', 'seen'] },
      { name: 'Location with preposition', patient: ['Doe, Jane', '10000017'], text: 'moved to Florida; lives in Rochester; from Erie, PA', phi: ['Florida', 'Rochester', 'Erie, PA'], keep: ['moved', 'lives'] },
      { name: 'Common-word names without cue stay', patient: ['Doe, Jane', '10000018'], text: 'Will call back. Hope to resume. Mark chart. Bill insurance. Rose from chair.', phi: [], keep: ['Will', 'Hope', 'Mark', 'Bill', 'Rose'] },
      { name: 'Rare regimen small cell (flag only)', patient: ['Doe, Jane', '10000019'], text: 'only pt at center on Elahere; unique regimen', phi: [], keep: ['Elahere', 'unique'] },
      { name: 'Relative with surname only + honorific', patient: ['Doe, Jane', '10000020'], text: 'Mrs. Abernathy (mother) at bedside; Mr. Okonkwo to pick up', phi: ['Abernathy', 'Okonkwo'], keep: ['mother', 'bedside'] },
    ];
    const headers = ['Patient Name', 'MRN', 'Comments'];
    const rows = cases.map((c) => [c.patient[0], c.patient[1], c.text]);
    return { cases, headers, rows, commentCol: 2 };
  }

  return { make, adversarial, NEG };
});
