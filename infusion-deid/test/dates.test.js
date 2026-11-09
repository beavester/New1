// Date handling: whole-week offsets (weekdays stay true), named holidays, birthdates written in a note, N/M counts.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/core.js');

const cfg = () => D.compileConfig(D.defaultConfig({ mrnPattern: '\\b\\d{8}\\b' }));
const dateSpans = (t) => D.ruleSpans(t, cfg()).filter((s) => s.type === 'DATE' || s.type === 'DOB').map((s) => `${s.type}=${s.text}`);
const SAFE_HARBOR = { dateShift: false, dob: 'year' }; // what the page sends for the HIPAA Safe Harbor profile
function runText(text, opts) {
  const reg = D.createRegistry(); const p = D.parseTextDocument(text);
  const r = D.processTable({ headers: p.headers, rows: p.rows }, Object.assign({ columns: p.columns, registry: reg, seed: 11 }, opts || {}));
  return r.rows.map((x) => x.map(D.cellToString).join(' | ')).join('\n');
}
const both = (text) => [runText(text), runText(text, { surrogate: SAFE_HARBOR })];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ------------------------------------------------------------------ 1. whole-week offsets
test('weekday words beside dates stay true after the shift (text)', () => {
  const out = runText('Tuesday 11/3/2026 C1D1. Returns Tuesday 11/10/2026 for C1D8.');
  const ds = [...out.matchAll(/Tuesday (\d{1,2})\/(\d{1,2})\/(\d{4})/g)];
  assert.equal(ds.length, 2, out);
  for (const m of ds) assert.equal(new Date(+m[3], +m[1] - 1, +m[2]).getDay(), 2, `not a Tuesday: ${m[0]} in ${out}`);
  assert.ok(!/11\/3\/2026|11\/10\/2026/.test(out), 'dates not shifted: ' + out);
  assert.ok(out.includes('C1D1') && out.includes('C1D8') && out.includes('Returns Tuesday'), 'clinical text lost: ' + out);
});

test('every drawn offset is a whole number of weeks, inside the range, away from a whole year', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 400; seed++) {
    const r = D.processTable({ headers: ['Patient Name', 'MRN', 'Comments'], rows: [['Quennell, Orsolya', '00418327', 'seen 11/24'], ['', '', 'no patient here 11/25']] }, { seed });
    const o = r.details[0].offset, k = Math.abs(o) % 365;
    assert.equal(Math.abs(o % 7), 0, `seed ${seed}: patient offset ${o}`);
    assert.ok(Math.abs(o) >= 30 && Math.abs(o) <= 365 && Math.min(k, 365 - k) >= 30, `seed ${seed}: offset ${o}`);
    assert.equal(Math.abs(r.mapping.meta.documentOffsetDays % 7), 0,`seed ${seed}: document offset ${r.mapping.meta.documentOffsetDays}`);
    seen.add(o);
  }
  // the default range 30-365 leaves 43 week magnitudes (35..329 days), in either direction: 86 offsets
  const pool = []; for (let w = Math.ceil(30 / 7); w <= Math.floor(365 / 7); w++) { const r = (7 * w) % 365; if (Math.min(r, 365 - r) >= 30) pool.push(7 * w, -7 * w); }
  assert.equal(pool.length, 86);
  for (const o of seen) assert.ok(pool.includes(o), 'offset outside the pool: ' + o);
  assert.ok(seen.size > 60, 'too few distinct offsets drawn: ' + seen.size);
});

test('a configured range keeps whole weeks; a range with no multiple of 7 still shifts; [0,0] still shifts nothing', () => {
  const off = (shiftRange, seed) => D.processTable({ headers: ['Patient Name', 'MRN', 'Appt'], rows: [['Quennell, Orsolya', '00418327', new Date(2026, 10, 3)]] }, { seed, surrogate: { shiftRange } }).details[0].offset;
  for (let seed = 1; seed <= 50; seed++) {
    const o = off([10, 60], seed); assert.ok(o % 7 === 0 && Math.abs(o) >= 14 && Math.abs(o) <= 56, `[10,60] seed ${seed}: ${o}`);
    const n = off([30, 33], seed); assert.ok(Math.abs(n) >= 30 && Math.abs(n) <= 33, `[30,33] seed ${seed}: ${n}`);
    assert.equal(Math.abs(off([0, 0], seed)), 0);
  }
});

test('table: a weekday column and weekday words in comments agree with the shifted date column', () => {
  const r = D.processTable({ headers: ['Patient Name', 'MRN', 'Day', 'Appt Date', 'Appt', 'Comments'], rows: [
    ['Garcia, Maria', '00412345', 'Tuesday', new Date(2026, 10, 3), 'Tue 11/03/2026', 'Seen Tuesday 11/3/2026; back Thu 11/12/2026 for labs.'],
    ['Lee, Ann', '00412399', 'Wednesday', new Date(2026, 10, 4), 'Wed 11/04/2026', 'Wednesday 11/4/2026 C2D1 ok to treat'],
  ] }, { seed: 5 });
  r.rows.forEach((row, i) => {
    const day = row[2];
    assert.ok(row[3] instanceof Date, 'date column is a date');
    assert.equal(WEEKDAYS[row[3].getDay()], day, `row ${i}: ${row[3]} is not a ${day}`);
    const m = String(row[4]).match(/^(\w{3}) (\d{2})\/(\d{2})\/(\d{4})$/); assert.ok(m, String(row[4]));
    assert.equal(WEEKDAYS[new Date(+m[4], +m[2] - 1, +m[3]).getDay()].slice(0, 3), m[1], `row ${i}: ${row[4]}`);
    for (const t of String(row[5]).matchAll(/(Tuesday|Thu|Wednesday) (\d{1,2})\/(\d{1,2})\/(\d{4})/g)) assert.ok(WEEKDAYS[new Date(+t[4], +t[2] - 1, +t[3]).getDay()].startsWith(t[1]), `row ${i}: ${t[0]}`);
    assert.ok(!/11\/0?[34]\/2026|11\/12\/2026/.test(row.map(D.cellToString).join(' ')), 'unshifted date: ' + row.join(' | '));
  });
  assert.ok(r.rows[0][5].includes('for labs') && r.rows[1][5].includes('C2D1 ok to treat'));
});

test('an offset stored by an earlier version (not whole weeks) is used unchanged, for the patient, the document and re-identification', () => {
  const reg = D.createRegistry([{ Code: 'P007', SurrogateName: 'Thorne, Maren', RealName: 'Garcia, Maria', MRN: '00412345', DOB: '1951-03-04', DateOffsetDays: 44 }]);
  reg.docOffset = -45;
  const appt = new Date(2026, 10, 3);
  const res = D.processTable({ headers: ['Patient Name', 'MRN', 'Appt Date', 'Comments'], rows: [['Garcia, Maria', '00412345', appt, 'seen 11/3/2026'], ['', '', new Date(2026, 10, 3), 'walk-in 11/3/2026']] }, { registry: reg, seed: 3 });
  assert.equal(Math.round((res.rows[0][2] - appt) / 864e5), 44, 'patient offset changed');
  assert.ok(res.rows[0][3].includes('12/17/2026'), res.rows[0][3]);
  assert.equal(Math.round((res.rows[1][2] - appt) / 864e5), -45, 'document offset changed');
  assert.ok(res.rows[1][3].includes('9/19/2026'), res.rows[1][3]);
  assert.equal(reg.entities[0].offset, 44); assert.equal(reg.docOffset, -45);
  const key = { patients: reg.toMappingRows(), providers: reg.toProviderRows(), others: reg.toOtherRows(), meta: res.mapping.meta };
  assert.equal(key.patients[0].DateOffsetDays, 44);
  const back = D.reidentify({ headers: res.headers, rows: res.rows }, key);
  assert.equal(back.rows[0][2].getTime(), appt.getTime(), 're-identified date');
  assert.ok(String(back.rows[0][3]).includes('11/3/2026'), back.rows[0][3]);
});

// ------------------------------------------------------------------ 2. holidays
test('holidays are dates: replaced in both profiles, never left beside a shifted date', () => {
  for (const out of both('Seen day after Thanksgiving; next visit Christmas Eve. Last tx was Halloween.')) {
    for (const h of ['Thanksgiving', 'Christmas', 'Halloween']) assert.ok(!out.includes(h), h + ' left: ' + out);
    assert.ok(out.includes('Seen day after [holiday]; next visit [holiday]. Last tx was [holiday].'), out);
  }
  const forms = ["New Year's", "New Year's Day", 'new years eve', 'July 4th', '4th of July', 'Fourth of July', 'Thanksgiving', 'Memorial Day', 'Labor Day', 'Easter', 'Easter Sunday', 'Halloween', 'Black Friday', 'Christmas', 'Xmas', 'Independence Day', 'MLK Day', 'Martin Luther King Jr. Day', "Presidents' Day", 'Juneteenth', 'Veterans Day', 'Columbus Day', 'Good Friday', 'Hanukkah', 'Passover', 'Rosh Hashanah', 'Yom Kippur', 'Diwali', 'Ramadan', 'Eid al-Fitr', 'Kwanzaa', "Mother's Day", "Valentine's Day", "St. Patrick's Day", 'Lunar New Year'];
  for (const f of forms) {
    const s = dateSpans(`pt away over ${f}, back after`);
    assert.deepEqual(s, [`DATE=${f}`], f + ' -> ' + s);
  }
  for (const out of both('Labs before Memorial Day weekend; Thanksgiving 2025 was rough; seen 11/3/2026.')) {
    assert.ok(out.includes('Labs before [holiday] weekend; [holiday] was rough;'), out);
    assert.ok(!/2025|11\/3\/2026/.test(out), out);
  }
});

test('a holiday with a year after "born" is a birthdate; "July 4th" with a year is an ordinary date', () => {
  assert.ok(runText('born on Christmas Day 1931').includes('born on [dob]'));
  assert.deepEqual(dateSpans('scan July 4th, 2026 ok'), ['DATE=July 4th, 2026']);
  assert.deepEqual(dateSpans('Reschedule from the 4th of July, holiday hours'), ['DATE=4th of July']);
});

test('clinical words that share a holiday word survive', () => {
  const keep = ['Labor and delivery note reviewed', 'hx of preterm labor', 'admitted via Memorial Hospital ED', 'records from Memorial Sloan Kettering', 'independence with ADLs', 'functional independence improving',
    'Christmas disease (hemophilia B), factor IX 50 units/kg', 'drug holiday x2 weeks', 'holiday schedule question', 'Christmas factor level', 'new year of treatment', 'had a good friday at home', 'Eid called back'];
  for (const t of keep) assert.deepEqual(dateSpans(t), [], t + ' -> ' + dateSpans(t));
  for (const out of both('Labor and delivery hx; independence with ADLs; Christmas disease (hemophilia B), factor IX 50 units/kg; drug holiday x2 weeks before C3.')) {
    for (const k of ['Labor and delivery hx', 'independence with ADLs', 'Christmas disease (hemophilia B)', 'factor IX 50 units/kg', 'drug holiday x2 weeks before C3']) assert.ok(out.includes(k), k + ' lost: ' + out);
    assert.ok(!out.includes('[holiday]'), out);
  }
  // a name that is also a holiday word keeps a name surrogate, not a holiday placeholder
  assert.deepEqual(dateSpans('Dr. Easter reviewed labs'), []);
  assert.deepEqual(dateSpans('spoke with John Easter re: ride'), []);
  assert.deepEqual(dateSpans('Easter, Margaret called'), []);
});

// ------------------------------------------------------------------ 3. birthdates in notes
test('birthdates after a cue follow the DOB setting (removed by default), spelled-out forms included', () => {
  for (const [t, d] of [['Born on the 4th of July 1931, turns ninety-five next year.', '4th of July 1931'], ['Born July 4, 1931.', 'July 4, 1931'], ['pt born the fourth of July 1963, DOB verified', 'fourth of July 1963'],
    ['birthday is March 3', 'March 3'], ['bday 12/3, wants cake', '12/3'], ['b. 7/4/31', '7/4/31'], ['DOB: 07/04/1931', '07/04/1931'], ['date of birth is 3rd of Jan 1950', '3rd of Jan 1950'], ['birthday was on the 3rd', '3rd'], ['b-day March 3rd', 'March 3rd']]) {
    assert.ok(dateSpans(t).includes('DOB=' + d), t + ' -> ' + dateSpans(t));
  }
  const out = runText('Born on the 4th of July 1931, turns ninety-five next year.');
  assert.ok(out.includes('Born on the [dob], turns 90+ next year.'), out);
  assert.ok(!/July|1931|1932/.test(out), out);
  assert.ok(runText('birthday is March 3; next appt 11/20/2026').includes('birthday is [dob]; next appt'), 'yearless birthday');
  // year-only setting: the year stays when there is one and the patient is under 90, a yearless birthday is removed
  const yr = (t) => runText(t, { surrogate: { dob: 'year' } });
  assert.ok(yr('Born July 4, 1961.').includes('Born 1961.'), yr('Born July 4, 1961.'));
  assert.ok(yr('birthday is March 3').includes('birthday is [dob]'));
  assert.ok(yr('Born on the 4th of July 1931').includes('Born on the [dob]'), 'no birth year for 90+');
  for (const out2 of both('DOB: 3/4/1950. Seen 11/3/2026, birthday next week.')) assert.ok(/DOB: (?:\[dob\]|1950)\./.test(out2) && out2.includes('birthday next week'), out2);
});

test('a date near a birth word but not tied to it stays an ordinary shifted date', () => {
  assert.deepEqual(dateSpans('DOB verified, seen 11/12/2026'), ['DATE=11/12/2026']);
  assert.deepEqual(dateSpans('born in Ohio, moved here 3/4/2020'), ['DATE=3/4/2020']);
  assert.deepEqual(dateSpans('Tab. 3/4 given'), []);
  assert.deepEqual(dateSpans('hep b. seen 11/12'), ['DATE=11/12'], 'b. needs a year and to be right before the date');
  const out = runText('Daughter has a birthday party; infusion moved to 11/12/2026.');
  assert.ok(out.includes('Daughter has a birthday party; infusion moved to ') && !out.includes('11/12/2026') && !out.includes('[dob]'), out);
});

// ------------------------------------------------------------------ 4. N/M counts
test('N/M after dose, cycle, fraction, fx, # or "N of" is a count, not a date', () => {
  for (const t of ['Dose 1/2 of 11/12 planned; ANC 1.2', 'fx 11/12 today', 'fraction 11/12 delivered', 'dose 3/6 given', 'Cycle 5/6 today', '#3/5 iron sucrose', '# 3/5 infusions', 'dose #3/5', '2 of 11/12 vials', 'cycle 11/12 tolerated'])
    assert.deepEqual(dateSpans(t), [], t + ' -> ' + dateSpans(t));
  for (const out of both('Dose 1/2 of 11/12 planned; ANC 1.2')) assert.ok(out.includes('Dose 1/2 of 11/12 planned; ANC 1.2'), out);
  for (const out of both('Iron sucrose 200 mg #3/5. RT fx 11/12 today.')) assert.ok(out.includes('Iron sucrose 200 mg #3/5. RT fx 11/12 today.'), out);
});

test('real slash dates near count words stay dates', () => {
  for (const [t, d] of [['seen 11/12', '11/12'], ['on 11/12', '11/12'], ['11/12 appt', '11/12'], ['Second dose 11/12.', '11/12'], ['last dose 9/16, due 11/11', '9/16'], ['Last dose 10/21.', '10/21'], ['Zometa q12wk, last dose 08/26', '08/26'],
    ['next dose 11/12', '11/12'], ['next cycle 12/19', '12/19'], ['dose on 11/12', '11/12'], ['week of 11/23', '11/23'], ['Wk of 11/23', '11/23'], ['as of 11/1', '11/1'], ['results of 11/05 CT', '11/05'], ['infusion 4 of 6 on 11/12', '11/12'],
    ['dose 11/12 at 10:00', '11/12'], ['2nd half dose 12/03 timing', '12/03'], ['fx 11/12 on 11/14', '11/14']])
    assert.ok(dateSpans(t).includes('DATE=' + d), t + ' -> ' + dateSpans(t));
  const out = runText('Dose 1/2 of 11/12 planned; seen 11/12, next appt 11/20.');
  assert.ok(out.includes('Dose 1/2 of 11/12 planned; seen ') && !/seen 11\/12/.test(out) && !/appt 11\/20/.test(out), out);
});
