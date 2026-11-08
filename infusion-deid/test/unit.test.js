const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core.js');

const cfg = () => D.compileConfig(D.defaultConfig({ mrnPattern: '\\b\\d{8}\\b' }));
const rules = (t) => D.ruleSpans(t, cfg()).map((s) => `${s.type}=${s.text}`);
const lex = (t) => D.lexiconSpans(t, cfg()).map((s) => `${s.type}=${s.text}`);

test('dates in every format', () => {
  const r = rules('seen 11/7/26, 2026-11-07, Nov 7, 7-Nov, November 7th, 14 Feb 2025, 3rd of Jan, 10/27. next');
  for (const d of ['11/7/26', '2026-11-07', 'Nov 7', '7-Nov', 'November 7th', '14 Feb 2025', '3rd of Jan', '10/27']) assert.ok(r.includes('DATE=' + d), 'missing ' + d + ' in ' + r);
});
test('fractions, doses and cycles are not dates', () => {
  const r = rules('Cycle 1/2; 1/2 dose carbo; C1D1; dose 2/3 of plan; ratio 3/4');
  assert.equal(r.filter((x) => x.startsWith('DATE')).length, 0, r.join(','));
});
test('next cycle m/d is a date', () => assert.ok(rules('next cycle 12/19').includes('DATE=12/19')));
test('phones with and without formatting and extensions', () => {
  const r = rules('call 716-555-0142 or (585) 555-0199 ext 22 or 7165550123 x5 or 555-0100');
  assert.deepEqual(r.filter((x) => x.startsWith('PHONE')), ['PHONE=716-555-0142', 'PHONE=(585) 555-0199 ext 22', 'PHONE=555-0100', 'PHONE=7165550123 x5']);
});
test('ages 90+ only', () => {
  const r = rules('pt is 92 y/o; husband in his 90s; daughter is 45; 101-year-old');
  assert.deepEqual(r.filter((x) => x.startsWith('AGE')), ['AGE=92 y/o', 'AGE=his 90s', 'AGE=101-year-old']);
});
test('email, ssn, address, zip', () => {
  const r = rules('jdoe55@gmail.com; SSN 123-45-6789; 123 Oak St, Buffalo, NY 14201');
  assert.ok(r.includes('EMAIL=jdoe55@gmail.com')); assert.ok(r.includes('SSN=123-45-6789')); assert.ok(r.includes('ADDRESS=123 Oak St')); assert.ok(r.includes('ZIP=NY 14201'));
});
test('honorific, credential, relation cues', () => {
  assert.deepEqual(lex('Dr. Lee ok; per Karen Lee MD; J. Smith, NP to see'), ['NAME_PROVIDER=Lee', 'NAME_PROVIDER=Karen Lee', 'NAME_PROVIDER=J. Smith']);
  assert.deepEqual(lex("pt's son Thaddeus Abernathy will drive; Oluwaseun (niece) is POA"), ['NAME_OTHER=Thaddeus Abernathy', 'NAME_OTHER=Oluwaseun']);
});
test('eponyms survive, cue overrides eponym', () => {
  assert.deepEqual(lex('Hodgkin lymphoma; Ewing sarcoma; Wilms tumor; Bell\'s palsy; Graves disease; Ann Arbor stage II'), []);
  assert.deepEqual(lex('Daughter Grace Bell is POA. Sister Mary Graves also. caregiver Ann 716'), ['NAME_OTHER=Grace Bell', 'NAME_OTHER=Mary Graves', 'NAME_OTHER=Ann']);
});
test('word-names without cue stay', () => {
  assert.deepEqual(lex('Will call back. Hope to resume. Mark chart. Bill insurance. Rose from chair. May need dose reduction.'), []);
});
test('organizations and locations', () => {
  assert.deepEqual(lex('Referred from Roswell Park Cancer Center; Dr. Patel at Mercy Hospital; from Kenmore Mercy; (ECMC); St. Mary\'s Hospital').sort(),
    ['ORG=Roswell Park Cancer Center', 'ORG=Mercy Hospital', 'ORG=Kenmore Mercy', 'ORG=ECMC', 'ORG=St. Mary\'s Hospital', 'NAME_PROVIDER=Patel'].sort());
  assert.deepEqual(lex('moved to Florida; lives in Rochester; from Erie, PA; Buffalo, NY 14201; coming from Niagara Falls').sort(),
    ['LOCATION=Erie, PA', 'LOCATION=Buffalo, NY 14201', 'LOCATION=Florida', 'LOCATION=Rochester', 'LOCATION=Niagara Falls'].sort());
});
test('sentence boundaries stop cue runs', () => {
  assert.deepEqual(lex('Gallagher, Bertha NP\nDOB 5/20 verified; (nephew) is POA. Li-Fraumeni +'), ['NAME_PROVIDER=Gallagher, Bertha']);
});
test('date shifting preserves format', () => {
  const sp = D.ruleSpans('Nov. 14th and 11/13 and 2026-11-07 and 7-Nov-26', cfg()).filter((s) => s.type === 'DATE').sort((a, b) => a.start - b.start);
  const out = sp.map((s) => D.renderDate(s.date, D.shiftDate(new Date(s.date.y, s.date.m - 1, s.date.d), 20)));
  assert.deepEqual(out, ['Dec. 4th', '12/3', '2026-11-27', '27-Nov-26']);
});
test('name parsing and variants', () => {
  const p = D.parseName('Smith, John A MD');
  assert.equal(p.last, 'Smith'); assert.equal(p.first, 'John'); assert.equal(p.credentials, 'MD');
  const v = D.nameVariants(p);
  for (const x of ['Smith', 'John', 'John Smith', 'Smith, John', 'J. Smith', 'John A. Smith']) assert.ok(v.includes(x), x);
  assert.ok(D.parseName('Smith,'), 'trailing comma must not crash');
});
test('inferred MRN pattern floors at 6 digits and keeps prefix', () => {
  assert.equal(D.inferIdPattern(['E0012345', 'E0099999']), '\\b(?:E)\\d{6,7}\\b');
  assert.equal(D.inferIdPattern(['00012', '00013']), '\\b\\d{6,6}\\b');
});
test('whole-table processing: structured columns, census, surrogates, mapping, audit', () => {
  const headers = ['Appt Date', 'Patient Name', 'MRN', 'DOB', 'Age', 'Attending', 'Comments'];
  const rows = [
    [new Date(2026, 10, 12), 'Smith, John A', '00412345', '3/4/1951', 75, 'Lee, Karen MD', "pt's son Mark 716-555-0142 will pick up. Dr. Lee ok. Spoke w/ John re chair 4. DOB 3/4/1951 verified. in May labs."],
    [new Date(2026, 10, 12), 'Nguyen, May', '00412399', '1951-03-04', 92, 'Lee, Karen MD', 'May called re: 11/13 appt. pt is 92 y/o.'],
  ];
  const res = D.processTable({ headers, rows }, { seed: 1 });
  const out = res.rows;
  assert.equal(out[0][2], 'P001'); assert.equal(out[1][2], 'P002');
  assert.notEqual(out[0][1], 'Smith, John A'); assert.match(out[0][1], /^[A-Z][a-z]+, [A-Z][a-z]+$/);
  assert.equal(out[0][3], ''); assert.equal(out[1][4], '90+');
  assert.equal(out[0][0].getTime() - rows[0][0].getTime(), res.mapping.patients[0].DateOffsetDays * 86400000);
  const text0 = out[0][6], text1 = out[1][6];
  for (const leak of ['Mark', '716-555-0142', 'Lee', 'John', '3/4/1951']) assert.ok(!text0.includes(leak), 'leak ' + leak + ' in ' + text0);
  assert.ok(text1.startsWith(res.rows[1][1].split(', ')[1]) , 'patient first name in text maps to surrogate first name: ' + text1);
  assert.ok(text0.includes('in May labs'), 'month name in another patient\'s row is kept: ' + text0);
  assert.ok(text1.includes('90+ y/o'));
  assert.equal(res.headers[res.headers.length - 1], 'DeID Audit');
  assert.match(out[0][7], /^P001 \| NAME:/);
  // provider consistency between column and text
  const provFake = out[0][5].replace(/ MD$/, '').split(', ')[0];
  assert.ok(text0.includes('Dr. ' + provFake), 'provider surrogate consistent: ' + text0 + ' vs ' + provFake);
  // re-identification round trip on structured columns
  const back = D.reidentify({ headers: res.headers, rows: res.rows }, res.mapping);
  assert.equal(back.rows[0][2], '00412345');
  assert.equal(back.rows[0][0].getTime(), rows[0][0].getTime());
});
test('manual overrides add and remove spans', () => {
  const headers = ['Patient Name', 'MRN', 'Comments']; const rows = [['Doe, Jane', '10000001', 'Grace noted good tolerance. Vanterpool called.']];
  const r1 = D.processTable({ headers, rows }, {});
  assert.equal(r1.details[0].cells[0].spans.length, 0);
  const r2 = D.processTable({ headers, rows }, { manual: { '0:2': { add: [{ start: 28, end: 38, type: 'NAME_OTHER' }] } } });
  assert.equal(r2.details[0].cells[0].spans[0].text, 'Vanterpool');
  assert.ok(!r2.details[0].cells[0].output.includes('Vanterpool'));
});
