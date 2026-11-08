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

// ---------------------------------------------------------------------------------------------------------------
// Fresh infusion-clinic snippets written outside the synthetic generator: Epic scheduling comments, MyChart messages,
// nursing notes and OCR'd screen text (l/1, O/0, rn/m, broken spacing, ALL CAPS, column-aligned tables), covering the
// 18 Safe Harbor classes plus relatives, outside providers, facilities, insurance IDs, device serials, plates, URLs,
// user names, ages 90+, and negatives that must survive. Each case runs as its own one-row table so nothing is caught
// by another row's census or by document-wide propagation. All names are invented.
// ---------------------------------------------------------------------------------------------------------------
const FRESH_CASES = [
  {name: "sched: arrive early + pharmacy",patient: ["Castellanos, Rigoberto","20481133","4/12/1958"],text: "Pt to arrive 30 min early for labs. Rigoberto aware. Pharmacy to premix Keytruda 200 mg. Chair 7.",phi: ["Rigoberto"],keep: ["Keytruda","Chair 7","labs"]},
  {name: "sched: reschedule w/ relative and cell",patient: ["Pemberton, Lucille","20481134"],text: "R/S from 11/19 to 11/21 per dtr Marguerite (cell 716.555.0187). Pt ok w/ change.",phi: ["11/19","11/21","Marguerite","716.555.0187"],keep: ["R/S","ok"]},
  {name: "sched: transport with company and confirmation #",patient: ["Okafor, Ngozi","20481135"],text: "Medicaid transport booked w/ Medical Motors, conf# 88213-A, pickup 0745. Driver Desmond will call pt on arrival.",phi: ["88213-A","Desmond"],keep: ["pickup","arrival"],gap: "Medical Motors (two generic words, no specific token)"},
  {name: "sched: no-show + home phone",patient: ["Vandermeer, Hendrik","20481136"],text: "NO SHOW 11/4. LVM on home # 585-555-0133 and cell. Will try again tmrw.",phi: ["11/4","585-555-0133"],keep: ["NO SHOW","LVM","Will"]},
  {name: "sched: ins auth with member id",patient: ["Thibodeaux, Celestine","20481137"],text: "Auth pending w/ Highmark BCBS, member ID ZXK123456789, ref 2026-1107-44. Cannot start Opdivo until approved.",phi: ["Highmark BCBS","ZXK123456789","2026-1107-44"],keep: ["Opdivo","approved"]},
  {name: "sched: port placement at IR with date",patient: ["Brannigan, Siobhan","20481138"],text: "Port placement IR 11/12 @ 1300, first infusion 11/14. Needs Huber 20g. Sister Caoimhe driving.",phi: ["11/12","11/14","Caoimhe"],keep: ["Huber","IR","Port"]},
  {name: "sched: PCP fax",patient: ["Hightower, Reginald","20481139"],text: "Fax labs to PCP Dr. Okunade at Southtowns Family Practice, fax (716) 555-0144.",phi: ["Okunade","Southtowns Family Practice","(716) 555-0144"],keep: ["PCP","labs"]},
  {name: "sched: ALL CAPS epic comment",patient: ["QUINTANILLA, ESPERANZA","20481140"],text: "PT REQUESTS BAY 3. DAUGHTER ZULEIKA TO BE CALLED AT 716-555-0190 WHEN DONE. NEXT TX 12/02.",phi: ["ZULEIKA","716-555-0190","12/02"],keep: ["BAY 3","TX"]},
  {name: "sched: column aligned table line",patient: null,text: "08:30   Featherstone, Barnaby     00712345   FOLFOX C4D1   Chair 2   Dr. Lindqvist",phi: ["Featherstone, Barnaby","00712345","Lindqvist"],keep: ["FOLFOX","C4D1","Chair 2"]},
  {name: "sched: patient name with suffix",patient: ["Whitlock, Ferdinand Jr","20481141"],text: "Ferdinand Whitlock Jr. prefers window seat; wife Wilhelmina has POA paperwork.",phi: ["Ferdinand Whitlock","Wilhelmina"],keep: ["window","POA"]},
  {name: "mychart: signed message with phone",patient: ["Ostrowski, Bartek","20481142"],text: "Hi, this is Bartek. I have a fever of 100.6 since last night. Should I still come Thursday? You can reach me at 716-555-0128. Thanks, Bartek Ostrowski",phi: ["Bartek","716-555-0128","Bartek Ostrowski"],keep: ["fever","Thursday"]},
  {name: "mychart: relative writes on behalf",patient: ["Nakashima, Hiroko","20481143"],text: "This is Kenji, Hiroko's son. Mom is too weak to come in on 11/10. Can we move to the following week? My email is kenji.nak88@yahoo.com",phi: ["Kenji","Hiroko","11/10","kenji.nak88@yahoo.com"],keep: ["Mom","week"]},
  {name: "mychart: address change",patient: ["Tremblay, Amelie","20481144"],text: "New address: 4821 Delaware Ave Apt 3B, Kenmore NY 14217. Please update my chart.",phi: ["4821 Delaware Ave Apt 3B","Kenmore","14217"],keep: ["update","chart"]},
  {name: "mychart: pharmacy with street",patient: ["Birkenstock, Anneliese","20481145"],text: "Please send the Zofran to the Walgreens on Sheridan Dr in Tonawanda, not the one on Niagara Falls Blvd.",phi: ["Tonawanda"],keep: ["Zofran","Walgreens"]},
  {name: "mychart: URL and portal",patient: ["Montalban, Rosalba","20481146"],text: "I uploaded my outside records to https://mychart.rpci.org/share/abc123 and also emailed rosalba.m@gmail.com a copy.",phi: ["https://mychart.rpci.org/share/abc123","rosalba.m@gmail.com"],keep: ["uploaded","records"]},
  {name: "mychart: employer and work number",patient: ["Falconer, Lysander","20481147"],text: "I work at Moog Inc. in East Aurora; best to call my work line 716-555-0171 x204 between 9 and 5.",phi: ["East Aurora","716-555-0171 x204"],keep: ["work","between"]},
  {name: "nursing: reaction note w/ provider and time",patient: ["Greenblatt, Mordecai","20481148"],text: "Grade 2 infusion rxn at 1410, rituximab paused, Benadryl 25 IV given. Dr. Papadakis at bedside. Resumed at 50% rate 1440. Pt tolerated remainder.",phi: ["Papadakis"],keep: ["Grade 2","rituximab","Benadryl","1410","1440"]},
  {name: "nursing: fall risk, age 90+",patient: ["Sowerby, Winifred","20481149"],text: "94 yo F ambulates w/ walker, lives alone in Lackawanna, granddaughter Fenella checks daily. Morse 55.",phi: ["94 yo","Lackawanna","Fenella"],keep: ["walker","Morse 55"]},
  {name: "nursing: port access and lot number",patient: ["Yarbrough, Cressida","20481150"],text: "Port accessed 20g Huber, brisk blood return, flushed w/ 10 mL NS. Heparin lock 500u. Port serial # BRD-77120931 per wallet card.",phi: ["BRD-77120931"],keep: ["Huber","Heparin","NS"]},
  {name: "nursing: hospice referral with agency",patient: ["Achterberg, Ludovic","20481151"],text: "Family requests hospice info. Referred to Hospice Buffalo; intake nurse Ingrid Holmquist RN 716-555-0160 to call wife Perpetua.",phi: ["Hospice Buffalo","Ingrid Holmquist","716-555-0160","Perpetua"],keep: ["hospice info","intake"]},
  {name: "nursing: outside labs from facility",patient: ["Kuzmenko, Yevgenia","20481152"],text: "Outside CBC from Quest 11/6: WBC 3.1, ANC 1.4, Hgb 10.2, Plt 141. OK to treat per Dr. Strickland.",phi: ["11/6","Strickland"],keep: ["CBC","WBC 3.1","ANC 1.4","Hgb 10.2","Plt 141"]},
  {name: "nursing: SNF discharge destination",patient: ["Dubrovsky, Anselm","20481153"],text: "Pt d/c to Elderwood at Williamsville SNF, room 214. Contact: Thandiwe, unit clerk, 716-555-0152.",phi: ["Elderwood at Williamsville","Thandiwe","716-555-0152"],keep: ["room"]},
  {name: "nursing: caregiver named in parentheses with relation",patient: ["Villanueva, Isadora","20481154"],text: "Teaching done with pt and Tadeo (husband). Both verbalize understanding of neutropenic precautions.",phi: ["Tadeo"],keep: ["neutropenic","Teaching"]},
  {name: "nursing: patient initials and MRN reference",patient: ["Ramasubramanian, Priyanka","20481155"],text: "Verified 2 identifiers: name + MRN 20481155. Pt initials P.R. on consent.",phi: ["20481155","P.R."],keep: ["identifiers","consent"]},
  {name: "nursing: weight and vitals negatives",patient: ["Oyelowo, Ambrose","20481156"],text: "Wt 82.4 kg (up 1.2). BP 132/84, HR 78, T 36.8, SpO2 97% RA. BSA 1.98. Dose 380 mg per 190 mg/m2.",phi: [],keep: ["82.4","132/84","1.98","380 mg","190 mg/m2"]},
  {name: "ocr: MRN with O for 0 and l for 1",patient: ["Sallinen, Thorsten","00891234"],text: "MRN: OO89l234  Sallinen, Thorsten  DOB O3/l5/l960",phi: ["OO89l234","Sallinen, Thorsten"],keep: []},
  {name: "ocr: rn/m confusion in surname + phone with spaces",patient: ["Marchetti, Giselle","20481158"],text: "Marchetti, Gise11e   Ph 7l6 555 0l44   Appt 11/2O/2026",phi: ["Marchetti","7l6 555 0l44"],keep: []},
  {name: "ocr: broken spacing in name",patient: ["Zapatero, Casimir","20481159"],text: "Pt Name: ZAPATERO , CASIMIR    Acct: 4400192837    Sex: M",phi: ["ZAPATERO , CASIMIR","4400192837"],keep: ["Sex"]},
  {name: "ocr: dropped punctuation date",patient: ["Lindgren, Ottoline","20481160"],text: "Next appt Nov 21 2026 0930 Infusion B with Dr Eriksdottir",phi: ["Nov 21 2026","Eriksdottir"],keep: ["Infusion B"]},
  {name: "ocr: header row of epic screen",patient: null,text: "Patient: Haverford, Phineas   MRN 10077321   DOB: 7/4/1949   Age: 77 y.o.   Sex: M   PCP: Mbeki, Lorcan MD",phi: ["Haverford, Phineas","10077321","7/4/1949","Mbeki, Lorcan"],keep: ["Age","Sex"]},
  {name: "ocr: all caps with pipes",patient: null,text: "SZCZEPANSKI, EAMONN | 00552211 | 02/14/1951 | CHAIR 9 | R-CHOP C2D1 | DR. OKONKWO",phi: ["SZCZEPANSKI, EAMONN","00552211","02/14/1951","OKONKWO"],keep: ["CHAIR 9","R-CHOP","C2D1"]},
  {name: "ocr: phone split by OCR",patient: ["Vasilenko, Dorotea","20481163"],text: "Emergency contact: Osric Vasilenko (son) 716 -555- 0177",phi: ["Osric Vasilenko","716 -555- 0177"],keep: ["Emergency contact"]},
  {name: "ocr: tabular ages and zip",patient: null,text: "Kirchhoff, Rutger    91 y.o.    Hamburg, NY 14075    Medicare 1EG4-TE5-MK72",phi: ["Kirchhoff, Rutger","91 y.o.","Hamburg, NY 14075","1EG4-TE5-MK72"],keep: []},
  {name: "id: SSN last 4 and full",patient: ["Delacruz-Ortiz, Baptiste","20481165"],text: "SSN on file ends 4471; full SSN 078-05-1120 per registration.",phi: ["078-05-1120"],keep: ["registration"]},
  {name: "id: vehicle plate for valet",patient: ["Fairbanks, Jedidiah","20481166"],text: "Valet: silver Honda CRV, NY plate KDX 4471. Keys at front desk.",phi: ["KDX 4471"],keep: ["Valet","Keys"]},
  {name: "id: pump device serial",patient: ["Brightwater, Temperance","20481167"],text: "CADD pump SN 2201994-B sent home w/ pt for 5-FU 46 hr infusion. Disconnect appt Wed.",phi: ["2201994-B"],keep: ["CADD","5-FU","46 hr","Wed"]},
  {name: "id: IP address and username",patient: ["Nwachukwu, Chidi","20481168"],text: "Pt MyChart username cnwachukwu71 locked out; IT ticket from 10.42.7.118.",phi: ["cnwachukwu71","10.42.7.118"],keep: ["locked","ticket"]},
  {name: "id: health plan + group numbers",patient: ["Traynor, Seraphina","20481169"],text: "Independent Health member # 900123456701, group 77A2. Copay $40 collected.",phi: ["Independent Health","900123456701"],keep: ["Copay"]},
  {name: "id: clinical trial subject id",patient: ["Ikemefuna, Zebediah","20481170"],text: "Enrolled NRG-GY018, subject ID 018-0442. Study coordinator Vashti at ext 5521.",phi: ["018-0442","Vashti"],keep: ["NRG-GY018","coordinator"]},
  {name: "id: license number",patient: ["Holmquist, Mireille","20481171"],text: "ID verified w/ NYS driver license 123 456 789. Photo taken for chart.",phi: ["123 456 789"],keep: ["verified","Photo"]},
  {name: "id: fax header line",patient: null,text: "FAX FROM: Great Lakes Imaging  716-555-0199  TO: Infusion Center  RE: Pt Papadakis, Evangelina DOB 1962-08-30",phi: ["Great Lakes Imaging","716-555-0199","Papadakis, Evangelina","1962-08-30"],keep: ["FAX","RE"]},
  {name: "date: written day-month with year, and two-digit year",patient: ["Castellano, Ignacia","20481173"],text: "Last scan 14 Oct 2026, prior 03/22/25. Repeat q12wks.",phi: ["14 Oct 2026","03/22/25"],keep: ["q12wks"]},
  {name: "date: dose schedule days are not dates",patient: ["Delacroix, Hamish","20481174"],text: "Taxol D1, D8, D15 of 28-day cycle; cisplatin days 1-3; dexamethasone 8 mg BID x 3 days.",phi: [],keep: ["D1","D8","D15","28-day","1-3","x 3 days"]},
  {name: "date: year alone and relative dates stay",patient: ["Fairweather, Lucinda","20481175"],text: "Dx 2024, s/p lobectomy. Recurrence this spring. Next visit in 3 weeks, then q3mo.",phi: [],keep: ["2024","spring","3 weeks","q3mo"]},
  {name: "date: dob embedded in sentence different format",patient: ["Thistlewood, Rupert","20481176","1947-02-28"],text: "Confirmed DOB Feb 28, 1947 and allergy list. Age 79.",phi: ["Feb 28, 1947"],keep: ["allergy","Age 79"]},
  {name: "age: over 89 written out and ranges",patient: ["Ashcroft, Leocadia","20481177"],text: "Ninety-two year old female; husband is 95 and also a pt here. Daughter 62.",phi: ["Ninety-two year old","95"],keep: ["62"]},
  {name: "age: 89 and under untouched",patient: ["Whitaker, Oisin","20481178"],text: "89 y/o M, ECOG 2; son is 58.",phi: [],keep: ["89 y/o","58"]},
  {name: "date: time stamp with date",patient: ["Beaver, Keziah","20481179"],text: "Signed 11/07/2026 14:22 by Rosalba Vanterpool RN",phi: ["11/07/2026","Rosalba Vanterpool"],keep: ["Signed"]},
  {name: "name: Last, First at sentence start no cue",patient: ["Pendleton, Xiomara","20481180"],text: "Okonkwo, Tobias called re: parking voucher. Advised.",phi: ["Okonkwo, Tobias"],keep: ["parking","Advised"]},
  {name: "name: outside provider with \"per\" and credential after comma",patient: ["Doe, Jane","20481181"],text: "Per Dr. Mbeki, hold Zometa this cycle; per Whitlock, PA-C ok to give premeds.",phi: ["Mbeki","Whitlock"],keep: ["Zometa","premeds"]},
  {name: "name: two patients mentioned, one is row patient",patient: ["Lindqvist, Rutger","20481182"],text: "Rutger and his roommate Phineas Okunade both scheduled 11/18; keep in separate bays.",phi: ["Rutger","Phineas Okunade","11/18"],keep: ["bays"]},
  {name: "name: interpreter and language",patient: ["Montalban, Dorotea","20481183"],text: "Spanish interpreter Marisol Achterberg (ID 4471) present for consent discussion.",phi: ["Marisol Achterberg"],keep: ["Spanish","interpreter"]},
  {name: "name: possessive form",patient: ["Sowerby, Barnaby","20481184"],text: "Barnaby's wife brought his med list. Barnaby's INR 2.1.",phi: ["Barnaby"],keep: ["INR 2.1","med list"]},
  {name: "name: signature block",patient: ["Greenblatt, Anselm","20481185"],text: "Will follow up after labs.\n-- Thorsten Kuzmenko, RN, OCN\nInfusion Center, ext 2200",phi: ["Thorsten Kuzmenko"],keep: ["Infusion Center","OCN"]},
  {name: "name: lowercase email-style and @mention",patient: ["Nakashima, Cressida","20481186"],text: "fyi @dubrovsky pt wants to speak w/ social work. route to lyarbrough.",phi: ["@dubrovsky"],keep: ["social work","route"],gap: "bare lowercase user name lyarbrough"},
  {name: "neg: eponyms and scores",patient: ["Doe, Jane","20481187"],text: "Hodgkin lymphoma, Deauville 2 after 2 cycles ABVD. Gleason 3+4. Karnofsky 80. Charlson 4.",phi: [],keep: ["Hodgkin","Deauville","ABVD","Gleason","Karnofsky","Charlson"]},
  {name: "neg: drugs that look like names",patient: ["Doe, Jane","20481188"],text: "Darzalex Faspro SC, Velcade, dexamethasone. Prolia due. Zarxio x3 days.",phi: [],keep: ["Darzalex","Faspro","Velcade","Prolia","Zarxio"]},
  {name: "neg: chair/bay/pod names",patient: ["Doe, Jane","20481189"],text: "Move from Pod A chair 12 to Bay 4 (lift chair). Room 3 reserved for isolation.",phi: [],keep: ["Pod A","chair 12","Bay 4","Room 3"]},
  {name: "neg: regimen codes and trial names",patient: ["Doe, Jane","20481190"],text: "FOLFIRINOX mod, then KEYNOTE-189 style maintenance. CALGB 10403 backbone. R-CHOP-21.",phi: [],keep: ["FOLFIRINOX","KEYNOTE-189","CALGB 10403","R-CHOP-21"]},
  {name: "neg: lab values w/ slashes and ratios",patient: ["Doe, Jane","20481191"],text: "BP 118/76, ratio 1/2 NS, K 3.9, Cr 0.9, eGFR 88, ANC 2.3, Plt 165. Mg 1.8 repleted 2 g.",phi: [],keep: ["118/76","1/2","3.9","0.9","88","2.3","165"]},
  {name: "neg: month words used clinically",patient: ["Doe, Jane","20481192"],text: "May hold if ANC < 1.0. June and July cycles complete. Will see in March for restaging.",phi: [],keep: ["May","June","July","March"]},
  {name: "neg: capitalized ordinary words at line start",patient: ["Doe, Jane","20481193"],text: "Patient Tolerated Well. Port Flushed. Discharged Ambulatory. Return Precautions Given.",phi: [],keep: ["Patient","Tolerated","Port","Discharged","Return"]},
  {name: "neg: Epic module and device brands",patient: ["Doe, Jane","20481194"],text: "Beacon plan reviewed in Hyperspace. Alaris pump ch 2 occlusion alarm. Baxter bag changed. Neulasta Onpro applied.",phi: [],keep: ["Beacon","Hyperspace","Alaris","Baxter","Neulasta","Onpro"]},
  {name: "neg: dose fractions and percentages",patient: ["Doe, Jane","20481195"],text: "Carbo AUC 5 (dose 1/2 today, 1/2 tomorrow). 75% dose due to neuropathy. 3/4 strength premeds.",phi: [],keep: ["1/2","75%","3/4"]},
  {name: "neg: generic department references",patient: ["Doe, Jane","20481196"],text: "Sent to Pharmacy. Radiology called re: contrast. Social Work consulted. Lab called critical K.",phi: [],keep: ["Pharmacy","Radiology","Social Work","Lab"]},
  {name: "neg: word-names in clinical sense",patient: ["Doe, Jane","20481197"],text: "Will bill 96413. Chase down records. Hope for better counts. Grace period expired. Rose early.",phi: [],keep: ["Will","Chase","Hope","Grace","Rose"]},
  {name: "mixed: referral letter fragment",patient: ["Rutherford, Elias","20481198"],text: "Thank you for referring Mr. Rutherford, a 71-year-old gentleman from Olean, NY, seen at Olean General Hospital on 10/30/2026.",phi: ["Rutherford","Olean, NY","Olean General Hospital","10/30/2026"],keep: ["71-year-old","gentleman"]},
  {name: "mixed: lab callback with callback number and pharmacist",patient: ["Doe, Jane","20481199"],text: "Critical K 2.9 called to Dr. Oyelaran at 1522, read back. Pharmacist Nils ok to add KCl 20 mEq. Callback 716-555-0105.",phi: ["Oyelaran","Nils","716-555-0105"],keep: ["K 2.9","KCl 20 mEq","1522"]},
  {name: "mixed: patient from Canada",patient: ["Fontaine, Celeste","20481200"],text: "Pt from Fort Erie, ON; crosses Peace Bridge. Ontario health card 1234-567-890-AB.",phi: ["Fort Erie, ON","1234-567-890-AB"],keep: ["crosses"]},
  {name: "mixed: text with name then MRN then dob inline (paste)",patient: null,text: "Mireille Papadakis 00234567 05/09/1955 F  Gemzar/Abraxane  Dr. Vandermeer  call 716-555-0140 if late",phi: ["Mireille Papadakis","00234567","05/09/1955","Vandermeer","716-555-0140"],keep: ["Gemzar/Abraxane","late"]},
  {name: "mixed: funeral/obit and relative city",patient: ["Doe, Jane","20481202"],text: "Pt reports brother Osric passed 10/2; services in Jamestown. Grief resources given.",phi: ["Osric","10/2","Jamestown"],keep: ["Grief resources"]},
  {name: "mixed: county and zip only",patient: ["Doe, Jane","20481203"],text: "Erie County resident, ZIP 14043, qualifies for county transport grant.",phi: ["14043"],keep: ["transport grant"]},
  {name: "mixed: multiple phones with labels",patient: ["Doe, Jane","20481204"],text: "H: 716-555-0111  C: 716-555-0112  W: 716-555-0113 ext 7  (prefers cell)",phi: ["716-555-0111","716-555-0112","716-555-0113 ext 7"],keep: ["prefers cell"]},
];
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const covers = (spans, s) => { let pos = s.start; const sorted = spans.filter((p) => overlaps(p, s)).sort((a, b) => a.start - b.start); for (const p of sorted) { if (p.start > pos) break; pos = Math.max(pos, p.end); } return pos >= s.end; };
function runOne(c) {
  const headers = ['Patient Name', 'MRN', 'DOB', 'Comments'];
  const row = [c.patient ? c.patient[0] : '', c.patient ? c.patient[1] : '', c.patient && c.patient[2] ? c.patient[2] : '', c.text];
  const res = D.processTable({ headers, rows: [row] }, { seed: 1, columns: [{ role: 'patient_name' }, { role: 'mrn' }, { role: 'dob' }, { role: 'text' }] });
  const cell = res.details[0].cells[0] || { spans: [], output: '' };
  const text = c.text;
  const found = (phrase) => { let idx = -1, from = 0; while ((idx = text.indexOf(phrase, from)) >= 0) { if (covers(cell.spans, { start: idx, end: idx + phrase.length })) return true; from = idx + 1; } return false; };
  const missed = (c.phi || []).filter((p) => !found(p));
  const over = (c.keep || []).filter((k) => { let idx = -1, from = 0; while ((idx = text.indexOf(k, from)) >= 0) { if (cell.spans.some((s) => overlaps(s, { start: idx, end: idx + k.length }))) return true; from = idx + 1; } return false; });
  return { missed, over, spans: cell.spans, output: cell.output, mapping: res.mapping, res };
}
test('fresh clinic snippets: every identifier covered, negatives kept (' + FRESH_CASES.length + ' cases, isolated rows)', () => {
  const failures = [];
  for (const c of FRESH_CASES) {
    const r = runOne(c);
    if (r.missed.length || r.over.length) failures.push(`${c.name}: missed=${JSON.stringify(r.missed)} over=${JSON.stringify(r.over)} spans=${r.spans.map((s) => s.type + '=' + JSON.stringify(s.text)).join(' ')}`);
    // the de-identified output must not contain any expected PHI phrase verbatim
    for (const p of c.phi || []) if (r.output.includes(p) && !/^\d{1,2}$/.test(p)) failures.push(`${c.name}: "${p}" survives in output "${r.output}"`);
  }
  assert.deepEqual(failures, []);
});
test('fresh snippets: surrogates are reversible from the mapping key (identifiers, initials, handles)', () => {
  const headers = ['Patient Name', 'MRN', 'Comments'];
  const text = 'Highmark BCBS member ID ZXK123456789, conf# 88213-A, username cnwachukwu71, @dubrovsky, serial # BRD-77120931, Medicare 1EG4-TE5-MK72, plate KDX 4471, initials N.O., Ninety-two year old; husband is 95.';
  const res = D.processTable({ headers, rows: [['Okafor, Ngozi', '20481135', text]] }, { seed: 3 });
  const out = res.rows[0][2];
  for (const leak of ['ZXK123456789', '88213-A', 'cnwachukwu71', 'dubrovsky', 'BRD-77120931', '1EG4-TE5-MK72', 'KDX 4471', 'N.O.', 'Ninety-two', 'is 95']) assert.ok(!out.includes(leak), 'leak ' + leak + ' in ' + out);
  assert.ok(out.includes('90+ year old') && out.includes('husband is 90+'), out);
  const back = D.reidentify({ headers: res.headers, rows: res.rows }, res.mapping).rows[0][2];
  for (const orig of ['ZXK123456789', '88213-A', 'cnwachukwu71', '@dubrovsky', 'BRD-77120931', '1EG4-TE5-MK72', 'KDX 4471', 'N.O.']) assert.ok(back.includes(orig), 'not restored: ' + orig + ' in ' + back);
});
test('OCR-noisy dates and phones are covered whole and the date still shifts', () => {
  const r = D.ruleSpans('DOB O3/l5/l960; appt 11/2O/2026; Ph 7l6 555 0l44; 716 -555- 0177', cfg());
  const by = (t) => r.filter((s) => s.type === t).map((s) => s.text);
  assert.deepEqual(by('DATE'), ['O3/l5/l960', '11/2O/2026']);
  assert.deepEqual(by('PHONE').sort(), ['716 -555- 0177', '7l6 555 0l44']);
  const d = r.find((s) => s.text === '11/2O/2026').date; assert.equal(d.y, 2026); assert.equal(d.m, 11); assert.equal(d.d, 20);
});
test('labelled identifiers, MBI, handles; weak labels and plan group numbers stay', () => {
  const ids = (t) => D.ruleSpans(t, cfg()).filter((s) => s.type === 'ID_OTHER').map((s) => s.text);
  assert.deepEqual(ids('member ID ZXK123456789, ref 2026-1107-44, serial # BRD-77120931, SN 2201994-B, driver license 123 456 789, plate KDX 4471, health card 1234-567-890-AB'), ['ZXK123456789', '2026-1107-44', 'BRD-77120931', '2201994-B', '123 456 789', 'KDX 4471', '1234-567-890-AB']);
  assert.deepEqual(ids('Medicare 1EG4-TE5-MK72 and 1EG4TE5MK72'), ['1EG4-TE5-MK72', '1EG4TE5MK72']);
  assert.deepEqual(ids('MyChart username cnwachukwu71 locked; fyi @dubrovsky').sort(), ['@dubrovsky', 'cnwachukwu71']);
  assert.deepEqual(ids('Order 2 units PRBC. Lot 2201. Group 77A2. Room 214, ext 5521. ID 2. case 3'), []);
});
test('ages: y.o. at end, written out, bare number after a person; vitals stay', () => {
  const ages = (t) => D.ruleSpans(t, cfg()).filter((s) => s.type === 'AGE').map((s) => s.text);
  assert.deepEqual(ages('91 y.o.'), ['91 y.o.']);
  assert.deepEqual(ages('Ninety-two year old female; husband is 95. Daughter 62. He turned 101'), ['Ninety-two year old', 'husband is 95', 'He turned 101']);
  assert.deepEqual(ages('HR is 95, BP 95/60, SpO2 is 95% on RA, K is 3.9, pt is 72, wt is 95 kg, Cr is 0.9'), []);
});
test('"Last, First" with structural evidence is a name; comma lists are not', () => {
  const names = (t) => D.lexiconSpans(t, cfg()).filter((s) => D.COARSE(s.type) === 'NAME').map((s) => s.text);
  assert.deepEqual(names('Okonkwo, Tobias called re: parking voucher.'), ['Okonkwo, Tobias']);
  assert.deepEqual(names('Patient: Haverford, Phineas   MRN 10077321'), ['Haverford, Phineas']);
  assert.deepEqual(names('SZCZEPANSKI, EAMONN | 00552211 | CHAIR 9'), ['SZCZEPANSKI, EAMONN']);
  assert.deepEqual(names('08:30   Featherstone, Barnaby     00712345   FOLFOX'), ['Featherstone, Barnaby']);
  assert.deepEqual(names('Mireille Papadakis 00234567 05/09/1955 F'), ['Mireille Papadakis']);
  assert.deepEqual(names('Keytruda, Opdivo, Yervoy considered. NAUSEA, VOMITING CONTROLLED. Carboplatin, Paclitaxel given. Hold, Resume per MD. Port Flushed, Discharged Ambulatory.'), []);
  assert.deepEqual(names('Social Work, Dietitian, Chaplain consulted. Pharmacy, Radiology notified.'), []);
});
test('date context: ranges and fractions are not dates; DOB/appt context makes small m/d a date', () => {
  const dates = (t) => D.ruleSpans(t, cfg()).filter((s) => s.type === 'DATE').map((s) => s.text);
  assert.deepEqual(dates('days 1-3 dex; weeks 1-2 off; dose 1/2 today, 1/2 tomorrow; ratio 1/2 NS; NEXT TX 12/02.'), ['12/02']);
  assert.deepEqual(dates('DOB 1/2 verified; seen 1/3 and 2/4; next cycle 1/2'), ['1/2', '1/3', '2/4', '1/2']);
  assert.deepEqual(dates('next cycle 12/19\nhome address 4110 Niagara Dr'), ['12/19']);
});
test('email containing a census name is replaced whole, not mangled', () => {
  const res = D.processTable({ headers: ['Patient Name', 'MRN', 'Comments'], rows: [['Montalban, Rosalba', '20481146', 'emailed rosalba.m@gmail.com a copy']] }, { seed: 1 });
  assert.match(res.rows[0][2], /^emailed [a-z]+\.[a-z]+@example\.com a copy$/);
});
test('facilities and places: generic department words alone are not organizations', () => {
  assert.deepEqual(lex('Sent to Pharmacy. Fax to PCP Dr. Okunade. Referred to Hospice. d/c to Elderwood at Brookfield SNF').sort(), ['NAME_PROVIDER=Okunade', 'ORG=Elderwood at Brookfield SNF'].sort());
  assert.deepEqual(lex('lives in East Aurora; moved to North Collins; Kenmore NY 14217; Erie County resident; Honda CRV, NY plate').sort(), ['LOCATION=East Aurora', 'LOCATION=North Collins', 'LOCATION=Kenmore NY 14217', 'LOCATION=Erie County'].sort());
  assert.deepEqual(lex('Highmark BCBS auth pending; works at Moog Inc.').sort(), ['ORG=Highmark BCBS', 'ORG=Moog Inc'].sort());
});
test('relation abbreviations and roles cue a name', () => {
  assert.deepEqual(lex('per dtr Marguerite; Contact: Thandiwe, unit clerk; Driver Desmond will call'), ['NAME_OTHER=Marguerite', 'NAME_OTHER=Thandiwe', 'NAME_OTHER=Desmond']);
});
test('registry links the same patient across inputs and keeps different people apart', () => {
  const same = (a, b) => a && b && a.id === b.id;
  let reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia, Maria', mrn: '00412345' }), reg.resolve({ name: 'Garcia, Maria', mrn: '412345' })), 'zero-stripped MRN');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia, Maria', mrn: '00412345' }), reg.resolve({ mrn: 'OO4l2345' })), 'OCR-confused MRN');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia, Maria', dob: '3/4/1951' }), reg.resolve({ name: 'Maria Garcia', dob: new Date(1951, 2, 4) })), 'name + DOB, no MRN');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia, Maria', mrn: '00412345' }), reg.resolve({ name: 'Garcia, M' })), 'initial vs full first name');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia, Maria' }), reg.resolve({ name: 'M. Garcia' })), 'M. Garcia');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia-Lopez, Maria', dob: '3/4/1951' }), reg.resolve({ name: 'Garcia, Maria', dob: '3/4/1951' })), 'hyphenated vs first half, same DOB');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia-Lopez, Maria', dob: '3/4/1951' }), reg.resolve({ name: 'Lopez, Maria', dob: '3/4/1951' })), 'hyphenated vs second half, same DOB');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'GARCIA, MARIA', mrn: '00412345' }), reg.resolve({ name: 'Garcia, Maria' })), 'case-different');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Garcia, Maria L', mrn: '00412345' }), reg.resolve({ name: 'Maria L. Garcia' })), 'middle initial');
  reg = D.createRegistry();
  assert.ok(same(reg.resolve({ name: 'Marchetti, Giselle', mrn: '20481158' }), reg.resolve({ name: 'Marchetti, Giselle'.replace('m', 'rn'), mrn: '2048ll58' })), 'OCR rn/m + l/1');
  reg = D.createRegistry();
  const a = reg.resolve({ name: 'Garcia, Maria', dob: '3/4/1951' }), b = reg.resolve({ name: 'Garcia, Maria', dob: '1951-03-04', mrn: '00412345' }), c = reg.resolve({ mrn: '412345' });
  assert.ok(same(a, b) && same(b, c) && reg.size === 1, 'chain name+dob -> +mrn -> mrn only');
  assert.match(reg.toMappingRows()[0].MRN, /00412345/);
  // non-matches
  reg = D.createRegistry();
  assert.ok(!same(reg.resolve({ name: 'Garcia, Maria', mrn: '00412345' }), reg.resolve({ name: 'Garcia, Maria', mrn: '00999999' })), 'same name, different MRN');
  reg = D.createRegistry();
  assert.ok(!same(reg.resolve({ name: 'Garcia, Maria', dob: '3/4/1951' }), reg.resolve({ name: 'Garcia, Maria', dob: '7/9/1960' })), 'same name, different DOB');
  reg = D.createRegistry();
  assert.ok(!same(reg.resolve({ name: 'Garcia-Lopez, Maria' }), reg.resolve({ name: 'Garcia, Maria' })), 'hyphenated vs plain without DOB must not link');
  reg = D.createRegistry();
  assert.ok(!same(reg.resolve({ name: 'Garcia-Lopez, Maria', dob: '3/4/1951' }), reg.resolve({ name: 'Garcia, Maria', dob: '7/9/1960' })), 'hyphenated vs plain, different DOB');
  reg = D.createRegistry();
  assert.ok(!same(reg.resolve({ name: 'Garcia, Maria', dob: '3/4/1951' }), reg.resolve({ name: 'Garcia, Mario', dob: '3/4/1951' })), 'Maria vs Mario are two people');
  reg = D.createRegistry();
  assert.ok(!same(reg.resolve({ name: 'Garcia, Maria', mrn: '00412345' }), reg.resolve({ name: 'Garcia, Marla', mrn: '00412399' })), 'near-identical names with different MRNs');
  // seeded from a mapping sheet: same code and offset come back
  const seeded = D.createRegistry([{ Code: 'P007', SurrogateName: 'Thorne, Maren', RealName: 'Garcia, Maria', MRN: '00412345', DOB: '1951-03-04', DateOffsetDays: 44 }]);
  const e = seeded.resolve({ name: 'GARCIA, MARIA', mrn: '412345' });
  assert.equal(e.code, 'P007'); assert.equal(e.offset, 44); assert.equal(seeded.size, 1);
});

test('review regressions: Age: labels, Epic field labels, list openers, word prefixes, MBI surrogate, initials propagation', () => {
  const ages = (t) => D.ruleSpans(t, cfg()).filter((s) => s.type === 'AGE').map((s) => s.text);
  assert.deepEqual(ages('Age: 92, lives alone. Age 92. Age: 45'), ['Age: 92', 'Age 92']);
  const names = (t) => D.lexiconSpans(t, cfg()).filter((s) => D.COARSE(s.type) === 'NAME').map((s) => s.text);
  assert.deepEqual(names('Appt Date 11/07/2026 0900 Infusion A'), []);
  assert.deepEqual(names('Start Date 11/01/2026; Last Seen 10/30/2026 by RN; Next Visit 12/01/2026'), []);
  assert.deepEqual(names('Ambulation, Toileting and Feeding independent. Advil, Aleve and Motrin at home. Fever, Chills & Rigors denied.'), []);
  assert.deepEqual(names('Okonkwo, Tobias called re parking'), ['Okonkwo, Tobias']);
  const ids = (t) => D.ruleSpans(t, cfg()).filter((s) => s.type === 'ID_OTHER').map((s) => s.text);
  assert.deepEqual(ids('policy year 2026 renewal; order set 2026; Lot exp 2027; case mgr 1234; member ID ZXK123456789'), ['ZXK123456789']);
  const r = D.processTable({ headers: ['Patient Name', 'MRN', 'Comments'], rows: [['Doe, Jane', '10000001', 'Medicare 1EG4-TE5-MK72; initials P.R. on consent'], ['Roe, Ann', '10000002', 'P.R. interval normal; EG4 not relevant']] }, { seed: 5 });
  const mbi = r.rows[0][2].match(/Medicare (\S+);/)[1];
  assert.notEqual(mbi, '1EG4-TE5-MK72'); assert.match(mbi, /^\d[A-Z]{2}\d-[A-Z]{2}\d-[A-Z]{2}\d{2}$/); assert.ok(!/EG4|TE5|MK72/.test(mbi), mbi);
  assert.equal(r.rows[1][2], 'P.R. interval normal; EG4 not relevant', 'initials must not propagate to other rows');
});

// ---------------------------------------------------------------------------------------------------------------
// Red-team corpus (40 invented free-text cells from three independent reviewers): nicknames, initials, two-word and
// three-part names, relatives sharing a surname, spaced MRNs, ages 90+ as bare numbers, addresses without a suffix,
// town + ZIP, labelled ids with filler words, SSN last-4, role cues, employers. Run as one table (so cross-row census
// effects are exercised) and each row alone. Phrases in `phi` must not survive verbatim; `keep` must survive.
// ---------------------------------------------------------------------------------------------------------------
const REDTEAM = [
 {p:['Okonkwo-Baptiste, Adaeze','00412345','05/16/1958'], t:'Pt: OKONKWO-BAPTISTE,ADAEZE here for C3D1 FOLFOX. MRN#0041 2345 confirmed w/ 2 identifiers. Port-a-Cath flushed, Huber 20g.', phi:['OKONKWO-BAPTISTE,ADAEZE','0041 2345'], keep:['C3D1','FOLFOX','Port-a-Cath','Huber 20g']},
 {p:['Tremblay, Luc','00412346','03/04/1951'], t:'DOB:03041951 verified verbally. Carboplatin AUC5 + Keytruda 200mg. Chair 7. Pre-meds given.', phi:['03041951'], keep:['Carboplatin AUC5','Keytruda 200mg','Chair 7']},
 {p:['Vandenberg, Marguerite','00412347','11/02/1933'], t:'Pt is 91yo, lives alone at 412 Delaware in Kenmore, dtr Anneliese Vandenberg-Kowal checks daily (716.555.0142). Karnofsky 70.', phi:['91yo','412 Delaware','Anneliese','Vandenberg-Kowal','716.555.0142'], keep:['Karnofsky 70','lives alone']},
 {p:['Nguyen, Van Minh','00412348','07/21/1962'], t:'Mr. Minh prefers Vietnamese interpreter; son Nguyen Van Thanh will translate today. R-CHOP cycle 2 day 1. Rituxan rate escalated per protocol.', phi:['Minh','Nguyen Van Thanh','Thanh'], keep:['R-CHOP','Rituxan','rate escalated']},
 {p:['de la Cruz Hernandez, Maria Jose','00412349','09/09/1970'], t:'Maria Jose de la Cruz Hernandez (goes by Majo) tolerated Taxol well. Husband Jose Luis called from 716-555-0188 re pickup time.', phi:['Maria Jose','de la Cruz Hernandez','Majo','Jose Luis','716-555-0188'], keep:['Taxol','tolerated']},
 {p:['Al-Rashid, Fatima','00412350','01/30/1945'], t:"Pt's POA Mary Ann (sister-in-law) at bedside. Fatima al-Rashid consented to Herceptin. Reaction protocol reviewed. BP 142/88.", phi:['Mary Ann','Fatima','al-Rashid'], keep:['Herceptin','BP 142/88','Reaction protocol']},
 {p:['Patel, Devika','00412351','12/12/1980'], t:'Seen w/ Dr Patel-Shah (med onc). Orders per K. Lee NP: zofran 8 mg PO x1, then Oxaliplatin 130 mg/m2.', phi:['Patel-Shah','K. Lee'], keep:['zofran 8 mg','Oxaliplatin 130 mg/m2']},
 {p:['Sokolowski, Bartholomew','00412352','04/04/1940'], t:'Turned 90 last week per family; celebrated at Elderwood. Neulasta Onpro applied L arm. Grade 2 neuropathy, no dose change.', phi:['Turned 90','Elderwood'], keep:['Neulasta Onpro','Grade 2 neuropathy']},
 {p:['Whitfield, Josephine','00412353','06/06/1966'], t:'MyChart username jwhitfield1966 reset; pt also uses josie.whitfield.66@gmail.com for results. Labs: WBC 3.1, ANC 1.4, Hgb 10.2, Plt 98.', phi:['jwhitfield1966','josie.whitfield.66@gmail.com','josie.whitfield.66'], keep:['WBC 3.1','ANC 1.4','Hgb 10.2','Plt 98']},
 {p:['Castellano, Rosa','00412354','08/15/1955'], t:'Insurance: Independent Health member ID IH00928374A, group 4471. Prior auth for Opdivo pending. Rescheduled to 11/14.', phi:['IH00928374A','11/14'], keep:['Opdivo','Prior auth']},
 {p:['Brennan, Fiona','00412355','02/02/1952'], t:'Medicare MBI 1EG4-TE5-MK73 on file. Pt drove herself, plate GXR 2291 in lot B. Gemzar day 8 held for ANC 0.9.', phi:['1EG4-TE5-MK73','GXR 2291'], keep:['Gemzar day 8','ANC 0.9']},
 {p:['Grey, Thomas','00412356','10/10/1948'], t:'No Grey Turner sign. Abd soft. Park the pump in Bay 3 after Vectibix. Lane 2 chair broken.', phi:[], keep:['Grey Turner sign','Park the pump','Bay 3','Vectibix','Lane 2'], gap:'the eponym Grey Turner is kept although the patient is surnamed Grey'},
 {p:['Ferreira dos Santos, Joao Pedro','00412357','05/05/1975'], t:'JOAO PEDRO arrived late; his partner Ana Lucia dos Santos (716) 555-0199 drove. Avastin infused over 30 min, no HTN.', phi:['JOAO PEDRO','Ana Lucia','dos Santos','(716) 555-0199'], keep:['Avastin','30 min','no HTN']},
 {p:['Kowalczyk, Bartosz','00412358','03/03/1959'], t:'Rm 4 at Roswell for consult w/ Dr. Abernathy-Ruiz on 11/21/2026. Pt works at Tops on Sheridan Dr, shift ends 1500.', phi:['Abernathy-Ruiz','11/21/2026','Tops on Sheridan'], keep:['consult','shift ends'], gap:'pharmacy chains (Tops, Walgreens) are kept by design; the street is replaced'},
 {p:['Mbeki, Thandiwe','00412359','09/19/1983'], t:'Pt from Lackawanna, moved from Cape Town 2019. Neighbor Mrs. Oyelaran brings her. Cisplatin 75 mg/m2, mannitol per protocol. Mg 1.6.', phi:['Lackawanna','Cape Town','Oyelaran'], keep:['Cisplatin 75 mg/m2','mannitol','Mg 1.6']},
 {p:['Haddad, Yusuf','00412360','07/07/1935'], t:'Yusuf (age 91) ambulates w/ walker. Grandson Omar Haddad-Khalil is HCP: omar.hk@yahoo.com. Hickman site clean. Decadron given.', phi:['Yusuf','age 91','Omar','Haddad-Khalil','omar.hk@yahoo.com'], keep:['walker','Hickman site clean','Decadron']},
 {p:['Lindqvist, Astrid','00412361','11/11/1961'], t:'Called pt at 716 555 0123 x2 no answer; left VM. Alt # 7165550124 (husband Sven). Reschedule Folfirinox to Thurs.', phi:['716 555 0123','7165550124','Sven'], keep:['Folfirinox','left VM']},
 {p:['O\'Sullivan, Padraig','00412362','01/01/1950'], t:"PADRAIG O'SULLIVAN, acct #A-2024-558812, copay waived. Zometa 4 mg q4w. Ca 9.1, Cr 1.1.", phi:["PADRAIG O'SULLIVAN",'A-2024-558812'], keep:['Zometa 4 mg','Ca 9.1','Cr 1.1']},
 {p:['Rodriguez Pena, Luz Marina','00412363','04/22/1968'], t:'Luz Marina reports N/V since last Tues 10/28. Sister Carmen Pena-Alvarez to pick up at 1430. Emend + Aloxi given.', phi:['Luz Marina','10/28','Carmen','Pena-Alvarez'], keep:['N/V','Emend','Aloxi']},
 {p:['Bergstrom, Ingrid','00412364','06/30/1929'], t:'97 y.o. F, DNR confirmed. Dtr Kirsten (POA) 716-555-0177. Transfusion 2u PRBC, premedicate Tylenol/Benadryl. SSN ending 4471 on consent.', phi:['97 y.o.','Kirsten','716-555-0177'], keep:['DNR','2u PRBC','Tylenol/Benadryl']},
 {p:['Tran, Thi Hong','00412365','08/08/1972'], t:'Pt TRAN THI HONG, Ms. Hong requests female RN. Lives 88 Hertel w/ mother Tran Thi Lan. Paclitaxel 80 mg/m2 wkly.', phi:['TRAN THI HONG','Hong','88 Hertel','Tran Thi Lan','Lan'], keep:['Paclitaxel 80 mg/m2','female RN']},
 {p:['Fitzgerald, Mary Catherine','00412366','12/24/1957'], t:'Mary Catherine says daughter Siobhan Fitzgerald-Nowak (RN at Mercy) will manage pump. 5FU 46hr via CADD. Return 11/10 for disconnect.', phi:['Mary Catherine','Siobhan','Fitzgerald-Nowak','Mercy','11/10'], keep:['5FU 46hr','CADD','disconnect']},
 {p:['Abubakar, Ibrahim','00412367','02/14/1947'], t:'Dr Oluwaseun Adeyemi-Clarke (PCP) faxed labs from Buffalo Medical Group, 716.555.0150. Pt retired from Moog. Enhertu C4.', phi:['Oluwaseun','Adeyemi-Clarke','Buffalo Medical Group','716.555.0150','Moog'], keep:['Enhertu C4','faxed labs']},
 {p:['Yamamoto, Keiko','00412368','05/20/1964'], t:'K.Y. c/o mucositis grade 1. Magic mouthwash. Next cycle 12/1/26. Pt email keiko_y@outlook.com for portal.', phi:['K.Y.','12/1/26','keiko_y@outlook.com'], keep:['mucositis grade 1','Magic mouthwash']},
 {p:['Schwartz, Benjamin','00412369','10/31/1956'], t:'Ben Schwartz (MRN 412369) and his twin Daniel Schwartz (MRN 412370, also on tx here) both scheduled 1300. Rituximab maintenance.', phi:['Ben Schwartz','Ben','412369','Daniel Schwartz','Daniel','412370'], keep:['Rituximab maintenance']},
 {p:['Nakamura-Lopez, Isabella','00412370','09/01/1990'], t:'Isabella Nakamura-Lopez, 36 F, Bay 12. Fiance Marcus Delacroix-Hughes present. Tolerated AC #2. Driving home to Orchard Park.', phi:['Isabella','Nakamura-Lopez','Marcus','Delacroix-Hughes','Orchard Park'], keep:['AC #2','Bay 12']},
 {p:['Pietrangelo, Salvatore','00412371','07/04/1938'], t:'Sal P. (88) via wheelchair. Lives at Brothers of Mercy, Clarence. Case mgr Deondra Washington-Pryce x5521. Darzalex Faspro SQ.', phi:['Sal P.','Brothers of Mercy','Clarence','Deondra','Washington-Pryce'], keep:['Darzalex Faspro SQ','wheelchair']},
 {p:['Johansson, Erik','00412372','03/15/1969'], t:'MRN 00412372 / acct 1122334455 / Erik J. Pt reports fatigue 6/10. Velcade SQ, dexamethasone 20 mg. Weight 82.4 kg.', phi:['00412372','1122334455','Erik J.'], keep:['fatigue 6/10','Velcade SQ','dexamethasone 20 mg','82.4 kg']},
 {p:['Quintero Vasquez, Ana Sofia','00412373','11/05/1977'], t:'ANA SOFIA QUINTERO VASQUEZ: Spanish interpreter ID 4471 (Rosalinda) used. Pt b. 11/5/77. Taxotere + cyclophosphamide.', phi:['ANA SOFIA QUINTERO VASQUEZ','Rosalinda','11/5/77'], keep:['Taxotere','cyclophosphamide']},
 {p:['MacAllister, Duncan','00412374','06/16/1942'], t:'Pt DUNCAN MACALLISTER arrived w/ wife Moira. States he turned 84 yesterday. Vidaza d1-7. Hgb 8.9, transfuse if <8.', phi:['DUNCAN MACALLISTER','Moira'], keep:['Vidaza d1-7','Hgb 8.9']},
 {p:['Chowdhury, Rafiqul','00412375','01/19/1960'], t:'Rafiqul Chowdhury Md. (patient, not a physician) works at GEICO Amherst. Email: rafiqul.chowdhury@geico.com. Yervoy/Opdivo combo.', phi:['Rafiqul','Chowdhury','GEICO','rafiqul.chowdhury@geico.com'], keep:['Yervoy/Opdivo']},
 {p:['Kaminski, Zofia','00412376','08/27/1931'], t:'Zofia, 95, hard of hearing. Son-in-law Grzegorz Wisniewski-Kaminski (716)555-0160 is contact. Reclast infusion, 15 min. Cr 1.3, CrCl 38.', phi:['Zofia','95','Grzegorz','Wisniewski-Kaminski','(716)555-0160'], keep:['Reclast','15 min','CrCl 38']},
 {p:['Dubois, Jean-Baptiste','00412377','04/09/1953'], t:'J-B Dubois from Fort Erie ON, health card 5544-332-211-JB. Crosses Peace Bridge; NEXUS card. Adcetris q3w. Peripheral neuropathy G1.', phi:['J-B Dubois','Fort Erie','5544-332-211-JB'], keep:['Adcetris q3w','neuropathy G1']},
 {p:['Eze, Chukwuemeka','00412378','09/23/1984'], t:'Chukwuemeka (Emeka) Eze: call his boss Mr. Van Der Berg at Sumitomo if late. Blinatumomab bag change 1600. Neuro checks q4h.', phi:['Chukwuemeka','Emeka','Eze','Van Der Berg','Sumitomo'], keep:['Blinatumomab','Neuro checks q4h']},
 {p:['Lefebvre, Genevieve','00412379','12/03/1946'], t:'Pt seen in Rm 4 at Roswell by Dr. Ngozi Okafor-Brennan; see note dated 2026-11-03 for Abraxane dose mod. Pt lives in Tonawanda near Brighton Rd.', phi:['Ngozi','Okafor-Brennan','2026-11-03','Tonawanda','Brighton Rd'], keep:['Abraxane dose mod']},
 {p:['Santos, Rose','00412380','02/28/1965'], t:'Rose states her son Will drive her. Rose geranium lotion for hand-foot syndrome. Xeloda 1500 mg BID d1-14. Rose Hill Pharmacy filled it.', phi:['Rose states','Will drive','Rose Hill Pharmacy'], keep:['Rose geranium','hand-foot syndrome','Xeloda 1500 mg BID'], gap:'Rose geranium (the plant) is kept although the patient is Rose; the self-check still flags the row for a look'},
 {p:['Goldberg, Miriam','00412381','05/11/1939'], t:'Miriam G., DOB 5/11/39 (87). Husband Mordechai 716-555-0170. Kosher meal. Imfinzi 1500 mg. Pt was born in Brooklyn, lives Williamsville 14221.', phi:['Miriam G.','5/11/39','Mordechai','716-555-0170','Brooklyn','Williamsville 14221'], keep:['Kosher meal','Imfinzi 1500 mg']},
 {p:['Nowak-Sullivan, Katarzyna','00412382','07/17/1979'], t:'Kasia Nowak-Sullivan (pt) ok to text 716-555-0133. Employer: Rich Products. Tecentriq 1200 mg. Port accessed, good blood return.', phi:['Kasia','Nowak-Sullivan','716-555-0133','Rich Products'], keep:['Tecentriq 1200 mg','good blood return']},
 {p:['Hussain, Mohammed Ali','00412383','10/08/1954'], t:'Mohammed Ali Hussain (not the boxer, pt jokes). Imam Abdul Karim from Masjid An-Noor visited. Kyprolis 20/56. Watch for cardiac sx.', phi:['Mohammed Ali Hussain','Mohammed','Abdul Karim','Masjid An-Noor'], keep:['Kyprolis 20/56','cardiac sx']},
 {p:['Petrova, Svetlana','00412384','03/27/1950'], t:'Svetlana P. via Uber; driver license on file # 123 456 789. Reports granddaughter Anastasiya Petrova-Walsh (age 9) staying w/ her. Keytruda q6w.', phi:['Svetlana P.','123 456 789','Anastasiya','Petrova-Walsh'], keep:['Keytruda q6w','Uber']},
];

const RT_HEADERS = ['Patient Name', 'MRN', 'DOB', 'Comments'];
const RT_COLS = [{ role: 'patient_name' }, { role: 'mrn' }, { role: 'dob' }, { role: 'text' }];
function rtScan(c, outText) {
  const norm = (x) => String(x).toLowerCase().replace(/\s+/g, ' ');
  const digits = (x) => String(x).replace(/\D/g, '');
  const o = norm(outText); const issues = [];
  for (const p of c.phi) {
    if (o.includes(norm(p)) && !o.includes(norm(p) + '+')) issues.push('verbatim:' + p);
    else if (digits(p).length >= 6 && digits(outText).includes(digits(p))) issues.push('digits:' + p);
  }
  const [last, first] = c.p[0].split(',').map((x) => x.trim());
  for (const tkn of [last, ...(first || '').split(' ')].flatMap((x) => x.split(/[- ]/)).filter((x) => x.length >= 4)) if (new RegExp('(?<![a-z])' + tkn.toLowerCase() + '(?![a-z])').test(o) && !(c.gap && /Grey|Rose/.test(c.gap))) issues.push('ownname:' + tkn);
  if (digits(outText).includes(digits(c.p[1]).replace(/^0+/, ''))) issues.push('ownmrn');
  const over = c.keep.filter((k) => !o.includes(norm(k)));
  return { issues, over };
}
test('red-team corpus: no identifier survives, clinical content kept, as a table and row by row (' + REDTEAM.length + ' cases)', () => {
  const rows = REDTEAM.map((c) => [c.p[0], c.p[1], c.p[2], c.t]);
  const res = D.processTable({ headers: RT_HEADERS, rows }, { seed: 7, columns: RT_COLS });
  const failures = [];
  REDTEAM.forEach((c, i) => {
    const a = rtScan(c, res.rows[i][3]);
    const iso = D.processTable({ headers: RT_HEADERS, rows: [rows[i]] }, { seed: 7, columns: RT_COLS });
    const b = rtScan(c, iso.rows[0][3]);
    for (const [label, r] of [['table', a], ['alone', b]]) if (r.issues.length || r.over.length) failures.push(`#${i} ${c.p[0]} (${label}): leak=${r.issues.join('|')} over=${r.over.join('|')} :: ${label === 'table' ? res.rows[i][3] : iso.rows[0][3]}`);
  });
  assert.deepEqual(failures, []);
  // the self-check agrees: nothing left in the protected output, everything lit up in the raw input
  const clean = D.selfCheck(res); assert.deepEqual(clean.hits.map((h) => `#${h.row} ${h.text}`), []);
  const raw = D.selfCheck({ rows, headers: RT_HEADERS, census: res.census, cfg: res.cfg, details: res.details });
  assert.equal(new Set(raw.hits.map((h) => h.row)).size, REDTEAM.length, 'self-check must flag every unprotected row');
});
test('self-check is over-sensitive: spaced MRN digits, nicknames, initials, bare ages, phone shapes', () => {
  const res = D.processTable({ headers: RT_HEADERS, rows: [['Schwartz, Benjamin', '00412369', '10/31/1956', 'ok']] }, { seed: 1, columns: RT_COLS });
  const probe = (text) => D.selfCheck({ rows: [[res.rows[0][0], 'P001', '', text]], headers: res.headers, census: res.census, cfg: res.cfg, details: res.details }).hits.map((h) => `${h.kind}:${h.text}`);
  assert.deepEqual(probe('MRN#0041 2369 and 0041-2369 and 412369 and Ben and Benny and B.S. and Benj S. and Zofia, 95, and turned 91; call 716-555-0142; j@gmail.com'),
    ['census:412369', 'census:Ben', 'census:Benny', 'census:0041 2369', 'census:0041-2369', 'token:B.S.', 'token:Benj S.', 'age:95', 'age:91', 'shape:j@gmail.com', 'shape:716-555-0142']);
  // the digits-only comparison stands on its own when the census regex is not available
  const noRegex = Object.assign({}, res.census, { regex: null, lookup: new Map() });
  assert.deepEqual(D.selfCheck({ rows: [['x', 'P001', '', 'MRN 0041 2369 and 0041-2369']], headers: res.headers, census: noRegex, cfg: res.cfg, details: res.details }).hits.map((h) => `${h.kind}:${h.text}`), ['digits:0041 2369', 'digits:0041-2369']);
  assert.deepEqual(probe('Call 555-010-4471 or 555-4471 or 1 555-010-9999 x12; mail to x.y@example.com; Plt 98; HR is 95; BP 95/60; he is 90+'), []);
});
test('pasted census lines: common-word surnames are captured; a clinician on a note line is not a patient; spaced MRN label', () => {
  const doc = D.parseTextDocument('Bell, Kevin T  MRN 032767781  DOB 1/1/1960\nTolerating well. Bell reports mild nausea; pt Bell to return 11/20/2026.\n=== next ===\nPark, Susan  MRN 445566778  DOB 2/2/1955\nPark tolerating infusion.\nCalled Bruno re: labs. per Bruno, Georgiana MD ok to proceed.\nMRN#0041 2345 seen', { mrnPattern: '\\b\\d{6,9}\\b' });
  assert.deepEqual(doc.rows.map((r) => r.slice(0, 3)), [['Bell, Kevin T', '032767781', '1/1/1960'], ['Bell, Kevin T', '032767781', '1/1/1960'], ['', '', ''], ['Park, Susan', '445566778', '2/2/1955'], ['Park, Susan', '445566778', '2/2/1955'], ['Park, Susan', '445566778', '2/2/1955'], ['', '00412345', '']]);
  assert.deepEqual(D.parseTextDocument('Hill, Rose  84445786  9/20/1972', {}).rows[0].slice(0, 3), ['Hill, Rose', '84445786', '9/20/1972']);
  assert.deepEqual(D.parseTextDocument('Okonkwo, Tobias called re: parking.\nSpoke w/ Smith, John re schedule.', {}).rows.map((r) => r[0]), ['Okonkwo, Tobias', 'Okonkwo, Tobias']);
  const res = D.processTable({ headers: doc.headers, rows: doc.rows.slice(0, 6) }, { seed: 3, columns: doc.columns.map((c) => ({ role: c.role })) });
  const out = JSON.stringify(res.rows);
  for (const leak of ['Bell', 'Kevin', 'Park', 'Susan', 'Bruno', 'Georgiana', '032767781', '32767781', '445566778']) assert.ok(!out.includes(leak), 'leak ' + leak + ' in ' + out);
  assert.equal(res.census.patients.size, 2);
  assert.ok(res.registry.toMappingRows().every((r) => r.RealName), 'every registry entity has a real name');
  assert.deepEqual(D.selfCheck(res, { kind: 'text' }).unnamed, []);
  const unnamed = D.processTable({ headers: doc.headers, rows: [['', '00412345', '', 'MRN#0041 2345 seen']] }, { seed: 3, columns: doc.columns.map((c) => ({ role: c.role })) });
  assert.equal(D.selfCheck(unnamed, { kind: 'text' }).unnamed.length, 1, 'an MRN-only patient is reported as unnamed');
  assert.equal(D.selfCheck(unnamed, { kind: 'table' }).unnamed.length, 0);
});
test('ages: NNyo and bare numbers after a name or "turned" become 90+; MRNs with spaces map to the code; addresses and town+ZIP', () => {
  const r = D.processTable({ headers: RT_HEADERS, rows: [['Okonkwo, Adaeze', '00412345', '05/16/1958', 'Pt is 91yo, 91y/o, 91y.o. and 91 yo. Zofia, 95, hard of hearing. Turned 90 last week. 97 F. MRN#0041 2345 and MRN: 0041-2345 and 00412345 here. lives alone at 412 Delaware in Kenmore. Lives 88 Hertel. near Brighton Rd. lives Williamsville 14221. driver license on file # 123 456 789. SSN ending 4471. pain 6/10 today.']] }, { seed: 1, columns: RT_COLS });
  const out = r.rows[0][3];
  assert.equal((out.match(/90\+/g) || []).length, 7, out);
  for (const leak of ['91', '95', '97', '0041 2345', '0041-2345', '00412345', 'Delaware', 'Hertel', 'Brighton', 'Williamsville', '14221', '123 456 789', '4471']) assert.ok(!new RegExp('(?<![\\w+])' + leak + '(?![\\w+])').test(out), 'leak ' + leak + ' in ' + out);
  assert.equal((out.match(/P001/g) || []).length, 3, out);
  assert.ok(out.includes('pain 6/10 today'), 'a symptom score is not a date: ' + out);
  assert.ok(/near [A-Z][a-z]+ Rd\./.test(out) && /at \d{3} [A-Z][a-z]+ St in/.test(out), 'address surrogates keep their shape: ' + out);
});
test('nicknames, initials, two-word and three-part names of the census patient are the patient; relatives sharing the surname are not', () => {
  const rows = [
    ['Schwartz, Benjamin', '00412369', '10/31/1956', 'Ben Schwartz and his twin Daniel Schwartz both here; Benny ok.'],
    ['Nowak-Sullivan, Katarzyna', '00412382', '07/17/1979', 'Kasia Nowak-Sullivan (pt) ok to text.'],
    ['Pietrangelo, Salvatore', '00412371', '07/04/1938', 'Sal P. (88) via wheelchair.'],
    ['Yamamoto, Keiko', '00412368', '05/20/1964', 'K.Y. c/o mucositis grade 1.'],
    ['Tran, Thi Hong', '00412365', '08/08/1972', 'Pt TRAN THI HONG, Ms. Hong requests female RN. mother Tran Thi Lan.'],
    ['Rodriguez Pena, Luz Marina', '00412363', '04/22/1968', 'Luz Marina reports N/V.'],
    ['Fitzgerald, Mary Catherine', '00412366', '12/24/1957', 'Mary Catherine says daughter Siobhan Fitzgerald-Nowak will manage pump.'],
    ['Haddad, Yusuf', '00412360', '07/07/1935', 'Grandson Omar Haddad-Khalil is HCP.'],
    ['Kaminski, Zofia', '00412376', '08/27/1931', 'Son-in-law Grzegorz Wisniewski-Kaminski is contact.'],
    ['de la Cruz Hernandez, Maria Jose', '00412349', '09/09/1970', 'Maria Jose (goes by Majo) tolerated Taxol.'],
  ];
  const res = D.processTable({ headers: RT_HEADERS, rows }, { seed: 11, columns: RT_COLS });
  const outs = res.rows.map((r) => r[3]);
  for (const leak of ['Ben', 'Benny', 'Daniel', 'Kasia', 'Sal P', 'K.Y.', 'Hong', 'Lan', 'Marina', 'Catherine', 'Siobhan', 'Omar', 'Khalil', 'Grzegorz', 'Wisniewski', 'Kaminski', 'Majo']) assert.ok(!outs.some((o) => new RegExp('(?<![A-Za-z])' + leak.replace('.', '\\.') + '(?![A-Za-z])').test(o)), 'leak ' + leak + ' in ' + JSON.stringify(outs));
  const spansOf = (i) => res.details[i].cells[0].spans.map((s) => `${s.type}${s.relative ? '*' : ''}=${s.text}`);
  assert.deepEqual(spansOf(0), ['NAME_PATIENT=Ben Schwartz', 'NAME_OTHER*=Daniel Schwartz', 'NAME_PATIENT=Benny']);
  assert.deepEqual(spansOf(6).filter((x) => /Siobhan/.test(x)), ['NAME_OTHER*=Siobhan Fitzgerald-Nowak']);
  assert.deepEqual(spansOf(7), ['NAME_OTHER*=Omar Haddad-Khalil']);
  assert.deepEqual(spansOf(8), ['NAME_OTHER*=Grzegorz Wisniewski-Kaminski']);
  // the relative gets the patient's fake surname with a fresh first name, and the whole text restores
  const fakeLast = res.rows[0][0].split(',')[0];
  assert.ok(new RegExp(`twin [A-Z][a-z]+ ${fakeLast} both`).test(outs[0]) && !outs[0].includes(`${res.rows[0][0].split(', ')[1]} ${fakeLast} both`), outs[0]);
  const back = D.reidentify({ headers: res.headers, rows: res.rows }, res.mapping);
  assert.equal(back.rows[7][3], rows[7][3]); assert.equal(back.rows[8][3], rows[8][3]);
  assert.ok(back.rows[0][3].includes('twin Daniel Schwartz'), back.rows[0][3]);
  assert.ok(back.rows[6][3].includes('daughter Siobhan Fitzgerald-Nowak'), back.rows[6][3]);
});
test('one allocator per session: two inputs sharing a registry never share a made-up name; providers keep one fake; restore is one-to-one', () => {
  const S = require('../src/synth.js');
  const synth = S.make({ n: 120, seed: 31 });
  const reg = D.createRegistry();
  const cols = D.classifyColumns(synth.headers, synth.rows).map((c) => ({ header: c.header, role: c.role }));
  const res = D.processTable({ headers: synth.headers, rows: synth.rows }, { columns: cols, registry: reg, seed: 12345 });
  const s2 = S.make({ n: 40, seed: 777 });
  const lines = []; s2.patients.slice(0, 12).forEach((p, i) => { lines.push(`${p.nameCell}  MRN ${p.mrn}  DOB 1/${(i % 28) + 1}/1960`); lines.push('Tolerating well.'); lines.push('=== next ==='); });
  const prov = synth.rows[0][synth.headers.indexOf('Attending')];
  lines.push(`${synth.patients[0].nameCell}  MRN ${synth.patients[0].mrn}`, `Called ${prov.replace(/,.*$/, '')} re: labs. per ${prov} ok to proceed.`);
  const doc = D.parseTextDocument(lines.join('\n'), { mrnPattern: res.cfg.inferredMrnPattern });
  const res2 = D.processTable({ headers: doc.headers, rows: doc.rows }, { columns: doc.columns.map((c) => ({ header: c.header, role: c.role })), mrnPattern: res.cfg.inferredMrnPattern, registry: reg, seed: 12345 });
  const key = { patients: reg.toMappingRows(), providers: reg.toProviderRows(), others: reg.toOtherRows(), meta: { columns: cols } };
  const fakes = key.patients.map((r) => r.SurrogateName);
  assert.equal(new Set(fakes).size, fakes.length, 'patients share a made-up name');
  const surnames = [...key.patients.map((r) => r.SurrogateName.split(',')[0]), ...key.providers.map((r) => r.SurrogateName.split(',')[0]), ...key.others.filter((o) => o.Type === 'NAME').map((o) => o.Surrogate)];
  assert.equal(new Set(surnames.map((x) => x.toLowerCase())).size, surnames.length, 'a made-up surname stands for two different people: ' + JSON.stringify(surnames.filter((x, i) => surnames.indexOf(x) !== i)));
  assert.ok(key.patients.every((r) => r.RealName), 'a provider line must not create a nameless patient');
  assert.ok(!key.patients.some((r) => /Bruno|Lee|Smith/.test(r.RealName) && !synth.patients.some((p) => r.RealName.includes(p.last))), 'the provider became a patient');
  // the provider surname in the pasted text got the same fake as in the Attending column
  const provFake = res.rows[0][synth.headers.indexOf('Attending')].split(',')[0];
  assert.ok(res2.rows[res2.rows.length - 1][3].includes(provFake), `provider fake differs between inputs: ${provFake} vs ${res2.rows[res2.rows.length - 1][3]}`);
  assert.ok(!/MD MD|NP NP|DO DO/.test(res2.rows[res2.rows.length - 1][3]));
  // round trip of the table through the merged key
  const back = D.reidentify({ headers: res.headers, rows: res.rows }, key);
  const pn = synth.headers.indexOf('Patient Name'), att = synth.headers.indexOf('Attending'), cm = synth.headers.indexOf('Comments');
  synth.rows.forEach((r, i) => {
    assert.equal(String(back.rows[i][pn]), String(r[pn]), `patient name row ${i}`);
    assert.equal(String(back.rows[i][att]), String(r[att]), `attending row ${i}`);
    const origToks = String(r[cm]).match(/[A-Z][a-z]{2,}/g) || [], backToks = new Set(String(back.rows[i][cm]).match(/[A-Z][a-z]{2,}/g) || []);
    for (const t of origToks) if (synth.patients.some((p) => p.first === t || p.last === t) || synth.providers.some((p) => p.last === t || p.first === t)) assert.ok(backToks.has(t), `row ${i}: ${t} not restored in "${back.rows[i][cm]}" from "${r[cm]}"`);
  });
  // a registry seeded from the saved key allocates nothing that the key already uses
  const reg2 = D.createRegistry(key.patients, { providers: key.providers, others: key.others });
  const s3 = S.make({ n: 30, seed: 999 });
  const res3 = D.processTable({ headers: s3.headers, rows: s3.rows }, { columns: cols, registry: reg2, seed: 12345 });
  const all = reg2.toMappingRows().map((r) => r.SurrogateName);
  assert.equal(new Set(all).size, all.length, 'restored key: a new patient reused a made-up name');
  void res3;
});
test('restore keeps acronyms and codes as stored; a re-run of the same input with the same registry is identical', () => {
  const rows = [['Brennan, Fiona', '00412355', '02/02/1952', 'referred from ECMC; outside onc at UPMC Hamot; Highmark BCBS auth; NOWAK, OPAL called'], ['', '', '', 'no patient here, seen 11/20/2026 and 3/6; call 716-555-0142']];
  const reg = D.createRegistry();
  const a = D.processTable({ headers: RT_HEADERS, rows }, { seed: 1, columns: RT_COLS, registry: reg });
  const back = D.reidentify({ headers: a.headers, rows: a.rows }, a.mapping);
  assert.equal(back.rows[0][3], rows[0][3]);
  const b = D.processTable({ headers: RT_HEADERS, rows }, { seed: 1, columns: RT_COLS, registry: reg });
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b.rows), 'a re-run must not re-draw the document date offset or any surrogate');
  assert.ok(!a.rows[1][3].includes('11/20/2026') && !a.rows[1][3].includes('716-555-0142'), a.rows[1][3]);
});
test('DOB in free text follows the DOB setting; a hyphenated day-month does not swallow a following age', () => {
  const row = ['Barnett, Wallace', '4796179', '12/9/1992', 'DOB 12/9/1992 verified; b. 12/9/92; DOB:12091992; appt 11/20/2026; 27-Aug 50; 27-Aug-50'];
  const drop = D.processTable({ headers: RT_HEADERS, rows: [row] }, { seed: 1, columns: RT_COLS }).rows[0][3];
  assert.ok(!/1992|12\/9|12091992/.test(drop) && /DOB \[dob\] verified; b\. \[dob\]; DOB:\[dob\]/.test(drop), drop);
  assert.ok(!/11\/20\/2026/.test(drop) && /appt \d{1,2}\/\d{1,2}\/\d{4}/.test(drop), 'other dates still shift: ' + drop);
  assert.ok(/\d{1,2}-[A-Z][a-z]{2} 50;/.test(drop), 'the age 50 after a hyphenated day-month stays: ' + drop);
  const year = D.processTable({ headers: RT_HEADERS, rows: [row] }, { seed: 1, columns: RT_COLS, surrogate: { dob: 'year' } }).rows[0][3];
  assert.ok(/DOB 1992 verified/.test(year), year);
  const dates = (t) => D.ruleSpans(t, cfg()).filter((s) => s.type === 'DATE' || s.type === 'DOB').map((s) => `${s.type}=${s.text}`);
  assert.deepEqual(dates('7-Nov-26, 14 Feb 2025, 3rd of Jan, 7-Nov, 27-Aug 50'), ['DATE=7-Nov-26', 'DATE=14 Feb 2025', 'DATE=3rd of Jan', 'DATE=7-Nov', 'DATE=27-Aug']);
});

test('town and ZIP after a street address are removed; eponym survives a same-surname patient', () => {
  const headers = ['Patient Name', 'MRN', 'DOB', 'Comments'];
  const rows = [
    ['Tran, Thi Hong', '00731199', '5/5/1961', 'sister lives at 48 Abbott Rd Buffalo 14220. Also 12 Oak St, Eggertsville NY 14226 and 9 Elm Ave 14221.'],
    ['Bell, Grace', '00731201', '7/7/1955', "Bell's palsy noted. Grace tolerated Keytruda. Graves' disease hx."],
  ];
  const r = D.processTable({ headers, rows }, { seed: 9 });
  const t0 = r.rows[0][3], t1 = r.rows[1][3];
  for (const leak of ['Abbott', 'Buffalo', '14220', 'Eggertsville', '14226', '14221']) assert.ok(!t0.includes(leak), leak + ' leaked: ' + t0);
  assert.ok(t1.includes("Bell's palsy"), 'eponym corrupted: ' + t1);
  assert.ok(!/\bGrace\b/.test(t1), 'patient first name leaked: ' + t1);
});
