// Detection rules, cue logic, normalisation and span boundaries: each case checks both directions, the identifier gone and
// the clinical text around it kept.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core.js');

// pasted text through the same path as the page: parseTextDocument -> processTable, one string per output
const run = (text, seed = 11) => {
  const reg = D.createRegistry(); const p = D.parseTextDocument(text);
  const r = D.processTable({ headers: p.headers, rows: p.rows }, { columns: p.columns, registry: reg, seed });
  return { out: r.rows.map((x) => x.map(D.cellToString).join(' | ')).join('\n'), res: r, reg };
};
const out = (text) => run(text).out;
const gone = (o, ...xs) => xs.forEach((x) => assert.ok(!new RegExp(`(?<![\\p{L}\\d])${x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\d])`, 'iu').test(o), `"${x}" survived: ${o}`));
const kept = (o, ...xs) => xs.forEach((x) => assert.ok(o.includes(x), `"${x}" lost: ${o}`));

test('must-pass clinical sentences stay untouched', () => {
  for (const t of ["Hx of Crohn's, Sjogren's; s/p Whipple. On Rituxan, Venofer, Ocrevus. Hickman line. Foley out.", 'Rose from chair. Mark on arm.', 'ANC 1.2; K 3.4; plt 90; wt 91 kg; BP 110/70; pain 9/10']) kept(out(t), t);
  // two drugs in a row are a list, not "Last, First" (this used to make a patient of them)
  kept(out('On Rituxan, Venofer.'), 'On Rituxan, Venofer.');
  kept(out('Pt here for Aranesp, Hgb 9.1. BP 152/88'), 'Aranesp, Hgb 9.1');
});

test('SSN in spaced, dotted and mixed 3-2-4 groups, with or without a cue', () => {
  let o = out('MRN 00731942 and DOB 2/29/1948; SSN 123 45 6789');
  gone(o, '123 45 6789', '6789'); kept(o, 'SSN ');
  o = out('social security 123.45.6789 on file; ss# 234-56 7890');
  gone(o, '123.45.6789', '234-56 7890'); kept(o, 'on file');
  o = out('SSN: 345678901 verified');
  gone(o, '345678901'); kept(o, 'verified');
  o = out('pt gave 456 78 9012 as her number');
  gone(o, '456 78 9012'); kept(o, 'as her number');
  // no cue: labs, vitals, phones and numbers the SSA never issues stay
  for (const t of ['Plt 120 45 1234 trend', 'vitals 120 80 1234', 'call 716 555 0142', 'lot 000 12 3456', 'id 912 34 5678', 'counts 666 12 3456']) {
    const r = D.ruleSpans(t, D.compileConfig(D.defaultConfig({}))).filter((s) => s.type === 'SSN');
    assert.deepEqual(r, [], t + ': ' + JSON.stringify(r));
  }
});

test('lower-case surname after a patient cue, propagated with its possessive', () => {
  let o = out("pt nguyen here, vitals stable. nguyen's daughter linh has the pump.");
  gone(o, 'nguyen', 'linh'); kept(o, "'s daughter", 'vitals stable', 'has the pump');
  o = out('patient okafor tolerated well; okafor to return thu. Mrs tran called back.');
  gone(o, 'okafor', 'tran'); kept(o, 'tolerated well', 'to return thu', 'called back');
  o = out('pt augustin, yolene 90yo here w/ granddaughter for Prolia.');
  gone(o, 'augustin', 'yolene'); kept(o, 'Prolia', 'granddaughter');
  // ordinary words after "pt" stay, and a word-name after the comma is not taken
  o = out('pt walker at bedside; pt states fatigue; pt long wait; pt stable.');
  kept(o, 'pt walker at bedside', 'pt states fatigue', 'pt long wait', 'pt stable');
  o = out('pt nguyen, will monitor bp');
  gone(o, 'nguyen'); kept(o, 'will monitor bp');
  // nursing shorthand after "pt" is not a surname, even when a rare one is spelled the same
  const sh = "pt tol infusion well. pt sob on exertion. pt hoh, speak up. pt gerd controlled. pt amb independently. pt oob to chair. pt ams today. pt lue swelling. pt prn tylenol.";
  kept(out(sh), sh);
});

test('"Last, First Second" takes the second given name, in any script', () => {
  let o = out('Pt Nuñez, José Ángel (MRN 5512093) c/o nausea.');
  gone(o, 'Nuñez', 'José', 'Ángel', '5512093'); kept(o, 'c/o nausea');
  o = out('Pt Nunez, Jose Angel c/o nausea.');
  gone(o, 'Nunez', 'Jose', 'Angel'); kept(o, 'c/o nausea');
  o = out('Okafor, Chidi Emeka, 4410923, here for IVIG');
  gone(o, 'Okafor', 'Chidi', 'Emeka', '4410923'); kept(o, 'here for IVIG');
  // a second given name in a table comment is replaced too, not copied from the original
  const r = D.processTable({ headers: ['Patient', 'MRN', 'Comment'], rows: [['Ferreira, Joao Paulo', '5512001', 'seen; spoke to Ferreira, Maria Luisa re rides']] }, { seed: 4 });
  gone(r.rows[0][2], 'Ferreira', 'Luisa'); kept(r.rows[0][2], 're rides');
});

test('surname particles belong to the surname in any letter case', () => {
  let o = out('VAN DER MERWE, PIETER 0088123 arrived late.');
  gone(o, 'VAN', 'MERWE', 'PIETER', '0088123'); kept(o, 'arrived late');
  o = out('van der merwe, pieter 0088123 arrived late.');
  gone(o, 'van', 'merwe', 'pieter'); kept(o, 'arrived late');
  o = out('De la Cruz, Maria Elena  MRN 4410923 for IVIG');
  gone(o, 'Cruz', 'Maria', 'Elena'); kept(o, 'for IVIG');
  o = out('Dr van der Berg called re labs');
  gone(o, 'Berg'); kept(o, 'called re labs');
  // ordinary uses of the same short words stay
  o = out('Kept on dex; da Vinci robot booked; Van ride at 3');
  kept(o, 'da Vinci robot', 'Van ride at 3');
});

test('a two-word name after a role or kin word is taken whole; Na stays sodium', () => {
  let o = out('Zhang Wei here with interpreter Li Na.');
  gone(o, 'Zhang', 'Wei', 'Li', 'Na'); kept(o, 'here with interpreter');
  o = out('caregiver Li Na here; Na 136, K 4.1');
  gone(o, 'Li'); kept(o, 'Na 136, K 4.1');
  o = out('daughter Mai Ho will drive');
  gone(o, 'Mai', 'Ho'); kept(o, 'will drive');
  kept(out('Na+ low. Na 138. Na 129 this am'), 'Na+ low. Na 138. Na 129 this am');
});

test('locations and organisations named by their cues', () => {
  let o = out('Works at Tops on Elmwood as a cashier; husband is a Buffalo firefighter at Engine 21.');
  gone(o, 'Tops', 'Elmwood', 'Buffalo', 'Engine 21'); kept(o, 'as a cashier', 'firefighter');
  o = out("Pt's obituary ran in the Buffalo News on Sunday.");
  gone(o, 'Buffalo', 'Buffalo News'); kept(o, 'on Sunday', 'obituary');
  o = out('Transferred from Sisters to Roswell, then to Brooks-TLC.');
  gone(o, 'Sisters', 'Roswell', 'Brooks-TLC');
  o = out('Transferred from Mercy to ECMC, then to Kaleida for rehab.');
  gone(o, 'ECMC', 'Kaleida'); kept(o, 'for rehab');
  o = out('Son is an Amherst police officer at Precinct 4. Photo in the Lockport Gazette.');
  gone(o, 'Amherst', 'Precinct 4', 'Lockport'); kept(o, 'police officer');
  o = out('Employed at Boeing on Elm. Lives on Hertel. Lives across from Delaware Park.');
  gone(o, 'Boeing', 'Elm', 'Hertel', 'Delaware');
  // what follows the same prepositions in clinical notes stays
  o = out('Transferred to chair 4. On Rituxan. From Whipple. On Monday. In Bay 3. Rose from chair. Moved to chair 6 then to Bay 2.');
  kept(o, 'Transferred to chair 4. On Rituxan. From Whipple. On Monday. In Bay 3. Rose from chair. Moved to chair 6 then to Bay 2.');
  o = out('Transferred from ICU to 5 North. on Keytruda since May; from Hodgkin. Works at night. Works at home.');
  kept(o, 'Transferred from ICU to 5 North', 'on Keytruda since', 'from Hodgkin', 'Works at night', 'Works at home');
  o = out('Station 3 nurse aware. Engine runs fine. Times New Roman font. Referred to Meals on Wheels and Road to Recovery.');
  kept(o, 'Station 3 nurse aware', 'Engine runs fine', 'Times New Roman font', 'Meals on Wheels', 'Road to Recovery');
  // units and services after a transfer verb, and what a person lives on, are ordinary words
  o = out('sent to Physical Therapy. went to Emergency Dept. transferred to Step Down. transferred to Main Campus. lives on Disability. lives on Fixed Income. Works at Tops on Weekends.');
  kept(o, 'sent to Physical Therapy. went to Emergency Dept. transferred to Step Down. transferred to Main Campus. lives on Disability. lives on Fixed Income.', 'on Weekends.');
});

test('staff named by "per" or by their department', () => {
  let o = out("Dr Patel's NP (Kim) ok'd. Per Jen in pharmacy, hold dose.");
  gone(o, 'Patel', 'Kim', 'Jen'); kept(o, 'in pharmacy, hold dose', "NP (");
  o = out('per Marisol, ok to run at 100. Kim from lab called re K. per Kowalczyk ok to run');
  gone(o, 'Marisol', 'Kim', 'Kowalczyk'); kept(o, 'ok to run at 100', 'from lab called re K');
  o = out('Per protocol, hold. Per MD ok. Per Pharmacy hold. Per Epic order. Per Oncology note. Per Rituxan protocol. Per policy.');
  kept(o, 'Per protocol, hold. Per MD ok. Per Pharmacy hold. Per Epic order. Per Oncology note. Per Rituxan protocol. Per policy.');
});

test('vehicle identification numbers, with and without the label', () => {
  let o = out('Plate JKL-4821. VIN 1HGCM82633A004352.');
  gone(o, 'JKL-4821', '1HGCM82633A004352'); kept(o, 'Plate ', 'VIN ');
  o = out('vin 1hgcm82633a004352 noted; car 2T1BURHE0JC034461 blue');
  gone(o, '1hgcm82633a004352', '2T1BURHE0JC034461'); kept(o, 'noted', 'blue');
  // a 17-character run with I, O or Q, or with no digit or no letter, is not a VIN
  const vins = (t) => D.ruleSpans(t, D.compileConfig(D.defaultConfig({}))).filter((s) => /^[A-Z0-9]{17}$/i.test(s.text));
  assert.deepEqual(vins('lot ABCDEFGHJKLMNPRST and 12345678901234567 and 1HGCM82633A0O4352'), []);
});

test('full-width letters, digits and punctuation are folded before detection, offsets kept', () => {
  assert.equal(D.normalizeText('ＭＲＮ ００７３１９４２ seen ２０２６／１１／０３'), 'MRN 00731942 seen 2026/11/03');
  assert.equal(D.normalizeText('ＭＲＮ ００７３１９４２').length, 'ＭＲＮ ００７３１９４２'.length);
  let o = out('ＭＲＮ ００７３１９４２ seen ２０２６／１１／０３');
  gone(o, '00731942', '2026/11/03'); kept(o, 'seen');
  o = out('Ｄｏｅ， Ｊａｎｅ  ＭＲＮ ４４１０９２３ for IVIG');
  gone(o, 'Doe', 'Jane', '4410923'); kept(o, 'for IVIG');
  // compatibility forms that change length or clinical meaning are left as written
  kept(out('BSA 1.8 m² ½ dose'), 'BSA 1.8 m² ½ dose');
  // a roster read straight into the census is folded the same way
  const reg = D.createRegistry();
  D.buildCensus(['Patient', 'MRN'], [['Ｏｋａｆｏｒ， Ｃｈｉｄｉ', '５５１２０９３']], [{ index: 0, role: 'patient_name' }, { index: 1, role: 'mrn' }], { registry: reg });
  const r = D.processTable({ headers: ['Note'], rows: [['Okafor called, MRN 5512093']] }, { registry: reg, seed: 2, columns: [{ index: 0, role: 'text' }] });
  gone(r.rows[0][0], 'Okafor', '5512093'); kept(r.rows[0][0], 'called');
});

test('a span never starts inside a token glued to an identifier; Insurance ID is a label', () => {
  let o = out('CSN 300418822, HAR 7001234567, Rx# 4481923, order 99812-A. Insurance ID W2948 11023 (BCBS).');
  gone(o, '300418822', '7001234567', '4481923', 'W2948 11023'); kept(o, '. Insurance ID ', '(BCBS)');
  o = out('Lot 4471-B. Policy # 88812 on file.');
  kept(o, '. Policy # ', 'on file');
  // a real organisation with the same words is still found
  gone(out('Fidelis Insurance called re auth'), 'Fidelis');
  gone(out('Referred by Buffalo/Niagara Hospice today'), 'Niagara');
});

test('an ordinary sentence-initial word is no patient; the address after it is still removed', () => {
  let { out: o, reg } = run('Addr: 1420 Hertel Ave Apt 3B, Buffalo NY 14216. Summers at 8 Lakeshore, Angola.');
  assert.equal(reg.size, 0, 'phantom patient');
  gone(o, '1420 Hertel', 'Hertel', '14216', 'Lakeshore', 'Angola'); kept(o, 'Summers at ');
  ({ out: o, reg } = run('Winters at 22 Seaview, Naples. home on 41 Glenwood, Eden'));
  assert.equal(reg.size, 0, 'phantom patient');
  gone(o, 'Seaview', 'Naples', 'Glenwood', 'Eden'); kept(o, 'Winters at ', 'home on ');
  // a patient line keeps its patient, a schedule time included
  ({ reg } = run('Summers, Jane  MRN 4410923 here for IVIG')); assert.equal(reg.size, 1);
  ({ reg } = run('0900 Smith, Jane  MRN 4410923')); assert.equal(reg.size, 1);
  kept(out('took 2 Tylenol, Benadryl at 3 pm. in 3 Days, Monday'), 'took 2 Tylenol, Benadryl at 3 pm. in 3 Days, Monday');
  // a hospital unit or an oxygen setting is no street
  ({ out: o, reg } = run('on 2 Liters, Nasal cannula. back to 5 North, then home'));
  assert.equal(reg.size, 0, 'phantom patient'); kept(o, 'on 2 Liters, Nasal cannula. back to 5 North, then home');
});

test('replacement keeps the punctuation around a name', () => {
  let o = out("Pt goes by 'Bunny'. Emergency contact: Bob (brother) 555-0171");
  gone(o, 'Bunny', 'Bob', '555-0171'); assert.match(o, /goes by '[A-Z][a-z]+'\. Emergency contact: [A-Z][a-z]+ \(brother\)/, o);
  o = out('prefers "Peggy", aka ‘Mags’ here');
  gone(o, 'Peggy'); assert.match(o, /prefers "[A-Z][a-z]+",/, o);
  const sp = D.detectText("goes by 'Bunny'.", {}).find((s) => /^NAME/.test(s.type));
  assert.equal(sp.text, 'Bunny');
});
