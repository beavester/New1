// Surrogates (the made-up replacement values): realistic pools, no collision with real names, same type and shape as the
// original, organizations of the same kind, one role per made-up word, consistency and determinism.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const D = require('../src/core.js');
const L = require('../src/lexicon.js');
const S = require('../src/synth.js');

const lc = (s) => String(s).toLowerCase();
const wordsOf = (s) => (lc(s).match(/[a-z][a-z'’]*/g) || []);
const text = (t, seed, registry) => {
  const p = D.parseTextDocument(t);
  const r = D.processTable({ headers: p.headers, rows: p.rows }, { columns: p.columns, registry: registry || D.createRegistry(), seed: seed == null ? 11 : seed });
  return { r, reps: r.details.flatMap((d) => d.cells.flatMap((c) => c.replacements)) };
};
const repOf = (reps, original) => { const x = reps.find((y) => y.original === original); assert.ok(x, `no replacement for ${original}: ${JSON.stringify(reps.map((y) => y.original))}`); return x.replacement; };
const inPool = (pool, w) => pool.some((x) => lc(x) === lc(w));
// replace the content of a pool for the duration of fn (the arrays are shared with the engine)
const withPools = (pools, fn) => {
  const saved = pools.map(([arr]) => arr.slice());
  try { pools.forEach(([arr, items]) => arr.splice(0, arr.length, ...items)); return fn(); } finally { pools.forEach(([arr], i) => arr.splice(0, arr.length, ...saved[i])); }
};

test('pools: ordinary names, a few hundred each, no short, clinical or duplicate entries, people/streets/cities/organizations disjoint', () => {
  assert.ok(L.FAKE_FIRST.length >= 300 && L.FAKE_LAST.length >= 300, `${L.FAKE_FIRST.length} first, ${L.FAKE_LAST.length} last`);
  for (const w of ['Smith', 'Garcia', 'Nguyen', 'Kowalski', 'Patel', 'Johansson']) assert.ok(inPool(L.FAKE_LAST, w), w);
  for (const w of ['Maria', 'James', 'Linh', 'Priya', 'Jamal']) assert.ok(inPool(L.FAKE_FIRST, w), w);
  for (const [name, pool] of [['first', L.FAKE_FIRST], ['last', L.FAKE_LAST], ['street', L.FAKE_STREETS], ['city', L.FAKE_CITIES], ['stem', L.FAKE_ORG_STEMS]]) {
    assert.equal(new Set(pool.map(lc)).size, pool.length, `${name} pool has duplicates`);
    pool.forEach((w) => { assert.ok(w.length >= 4, `${name}: ${w} is under 4 letters`); assert.ok(!L.isClinical(w), `${name}: ${w} is a clinical word`); });
  }
  // word-names that read as ordinary words are not handed out
  for (const w of ['Will', 'Rose', 'June', 'Hope', 'Grace', 'Brown', 'Hill', 'Bell', 'Graves', 'Turner']) assert.ok(!inPool(L.FAKE_FIRST, w) && !inPool(L.FAKE_LAST, w), w);
  L.FAKE_FIRST.forEach((w) => assert.ok(L.isFirstName(w), `${w} is not a first name in the lexicon`));
  L.FAKE_LAST.forEach((w) => assert.ok(L.isSurname(w), `${w} is not a surname in the lexicon`));
  L.FAKE_FIRST_F.forEach((w) => assert.ok(!L.FAKE_MALE.has(lc(w)), w));
  // one role per word: no token of one pool appears in another (the kind words of an organization aside)
  const owner = new Map();
  const groups = { people: [...L.FAKE_FIRST, ...L.FAKE_LAST], street: L.FAKE_STREETS, city: L.FAKE_CITIES, org: [...L.FAKE_ORGS.map((o) => o.split(' ')[0]), ...L.FAKE_ORG_STEMS] };
  for (const [g, arr] of Object.entries(groups)) for (const w of arr) { const k = lc(w); assert.ok(!owner.has(k) || owner.get(k) === g, `${w} is in both ${owner.get(k)} and ${g}`); owner.set(k, g); }
  assert.equal(new Set(L.FAKE_FIRST.map(lc).filter((w) => L.FAKE_LAST.some((x) => lc(x) === w))).size, 0, 'a first name is also in the surname pool');
  // organizations: one pool per kind, each name's first word its own; FAKE_ORGS is their union
  assert.deepEqual(Object.keys(L.FAKE_ORG_POOLS).sort(), ['cancer', 'church', 'clinic', 'employer', 'hospital', 'insurer', 'nursing', 'pharmacy', 'school', 'shop', 'unknown']);
  assert.equal(L.FAKE_ORGS.length, Object.values(L.FAKE_ORG_POOLS).flat().length);
  assert.equal(new Set(L.FAKE_ORGS.map((o) => lc(o.split(' ')[0]))).size, L.FAKE_ORGS.length, 'two organizations share a first word');
  const local = new Set(L.LOCAL_ORGS.map(lc)); L.FAKE_ORGS.forEach((o) => assert.ok(!local.has(lc(o)), `${o} is a real local organization`));
});

test('the made-up pools are read only by the Surrogator, never by detection', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/core.js'), 'utf8');
  const a = src.indexOf('function Surrogator('), b = src.indexOf('// HIPAA Safe Harbor', a);
  assert.ok(a > 0 && b > a);
  const helpers = src.lastIndexOf('// the large lexicon', a);
  assert.ok(helpers > 0 && helpers < a, 'helper anchor not found');
  const re = /LEX\.(FAKE_\w+|LOCAL_ORG_KIND)/g; let m;
  while ((m = re.exec(src))) {
    const inHelpers = m.index > helpers && m.index < a; // bigNames/orgKind, used only by the Surrogator
    assert.ok((m.index > a && m.index < b) || inHelpers, `${m[0]} used outside surrogation at offset ${m.index}`);
  }
  // and detection does not move when the pools change: the same spans with the old distinctive pools as with the new ones
  const synth = S.make({ n: 80, seed: 5 });
  const spansWith = () => D.processTable({ headers: synth.headers, rows: synth.rows }, { seed: 3 }).details.map((d) => d.cells.map((c) => c.spans.map((s) => `${s.type}:${s.start}-${s.end}`).join(',')).join('|')).join('\n');
  const now = spansWith();
  const old = withPools([[L.FAKE_FIRST, ['Alden', 'Bettina', 'Caspian', 'Delia', 'Everett', 'Flora']], [L.FAKE_LAST, ['Ashgrove', 'Brightwell', 'Calloway', 'Dunmore', 'Ellery', 'Fairchild']]], spansWith);
  assert.equal(old, now);
});

test('collisions: a real "Smith, Maria" never meets a made-up Smith or Maria, though both are in the pools; key round-trips', () => {
  assert.ok(inPool(L.FAKE_LAST, 'Smith') && inPool(L.FAKE_FIRST, 'Maria') && inPool(L.FAKE_LAST, 'Nguyen') && inPool(L.FAKE_FIRST, 'Linh'));
  const headers = ['Patient Name', 'MRN', 'Appt Date', 'Comments'];
  const rows = [
    ['Smith, Maria', '30411001', '11/02/2026', 'Maria tolerated Herceptin. Husband Jose drove her. Seen by Dr. Patel.'],
    ['Nguyen, Linh', '30411002', '11/03/2026', 'Linh reports nausea; daughter Thu at bedside. Called Garcia re: ride.'],
    ['SMITH, MARIA', '30411001', '11/09/2026', 'Pt Maria Smith f/u. Wife of Jose Smith.'],
  ];
  const real = new Set(rows.flatMap((r) => wordsOf(r.join(' '))));
  const check = (res, label) => {
    const outWords = res.rows.flatMap((r) => r.slice(0, 4).flatMap((v) => wordsOf(D.cellToString(v))));
    for (const w of ['smith', 'maria', 'nguyen', 'linh', 'jose', 'thu', 'patel', 'garcia']) assert.ok(!outWords.includes(w), `${label}: ${w} in ${JSON.stringify(res.rows.map((r) => r[3]))}`);
    // every made-up word is new: none is a word of the input
    res.details.forEach((d) => d.cells.forEach((c) => c.replacements.forEach((x) => wordsOf(x.replacement).forEach((w) => { if (w.length > 2 && !/^(?:dr|st|rd|ave)$/.test(w)) assert.ok(!real.has(w) || wordsOf(x.original).includes(w), `${label}: made-up "${x.replacement}" reuses real word ${w}`); }))));
    assert.equal(D.selfCheck(res).hits.length, 0, `${label}: ${JSON.stringify(D.selfCheck(res).hits)}`);
    const rs = D.releaseScan({ headers, rows }, res);
    assert.equal(rs.identifiers.length, 0, `${label}: release scan ${JSON.stringify(rs.identifiers)}`);
    const back = D.reidentify({ headers: res.headers, rows: res.rows }, res.mapping);
    // (the name column is restored as the key first recorded it: "SMITH, MARIA" comes back as "Smith, Maria", as before)
    // (dates are compared as dates: how a restored date is written belongs to the date handling)
    const day = (v) => { const d = v instanceof Date ? v : D.parseDateString(D.cellToString(v)); return d ? d.toDateString() : D.cellToString(v); };
    rows.forEach((r, i) => assert.deepEqual(back.rows[i].slice(0, 4).map((v, j) => (j === 0 ? lc(D.cellToString(v)) : j === 2 ? day(v) : D.cellToString(v))), [lc(r[0]), r[1], day(r[2]), r[3]], `${label}: row ${i} does not round-trip`));
  };
  for (let seed = 1; seed <= 25; seed++) check(D.processTable({ headers, rows }, { seed }), `seed ${seed}`);
  // the proof that exclusion, not luck, keeps them apart: pools that hold almost nothing but the real names
  withPools([[L.FAKE_LAST, ['Smith', 'Nguyen', 'Garcia', 'Patel', 'Lopez', 'Rivera']], [L.FAKE_FIRST, ['Maria', 'Linh', 'Jose', 'Thu', 'Mara', 'Rosa', 'Ana']],
    [L.FAKE_FIRST_F, ['Maria', 'Linh', 'Thu', 'Mara', 'Rosa', 'Ana']], [L.FAKE_FIRST_M, ['Jose', 'Juan', 'Luis']]], () => {
    for (let seed = 1; seed <= 10; seed++) {
      const res = D.processTable({ headers, rows }, { seed });
      check(res, `forced pool seed ${seed}`);
      const fakes = res.mapping.patients.map((p) => p.SurrogateName).join(' ');
      assert.ok(!/\bMara\b/.test(fakes), 'Mara is one letter from a real Maria: ' + fakes);
    }
  });
});

test('collisions across a session: a real name that an earlier input handed out as a made-up one is reported, and not handed out again', () => {
  const reg = D.createRegistry();
  const headers = ['Patient Name', 'MRN', 'Comments'];
  const first = withPools([[L.FAKE_LAST, ['Lopez', 'Rivera']], [L.FAKE_FIRST, ['Rosa', 'Ana']]], () => D.processTable({ headers, rows: [['Kowalczyk, Teresa', '30500001', 'ok']] }, { seed: 2, registry: reg }));
  const fake = first.mapping.patients[0].SurrogateName; // e.g. "Lopez, Rosa"
  const [fl, ff] = fake.split(', ');
  assert.deepEqual(first.surrogateCollisions, []);
  const second = D.processTable({ headers, rows: [[`${fl}, ${ff}`, '30500002', `${ff} here with sister`]] }, { seed: 2, registry: reg });
  assert.deepEqual(second.surrogateCollisions.sort(), [lc(fl), lc(ff)].sort());
  const p2 = second.mapping.patients.find((p) => p.MRN === '30500002');
  assert.ok(p2 && !p2.SurrogateName.split(', ').some((w) => w === fl || w === ff), JSON.stringify(p2));
  assert.ok(!second.rows.some((r) => r.slice(0, 3).some((v) => new RegExp(`\\b(?:${fl}|${ff})\\b`).test(D.cellToString(v)))), JSON.stringify(second.rows));
});

test('type and shape: a first name gets a first name, a surname a surname, in the same case and form', () => {
  let { reps } = text('Called Terry about the appt. Wife Bernadette at bedside. spouse Summer called. Thu (daughter) will drive.');
  for (const o of ['Terry', 'Summer']) assert.ok(inPool(L.FAKE_FIRST, repOf(reps, o)), `${o} -> ${repOf(reps, o)}`);
  for (const o of ['Bernadette', 'Thu']) assert.ok(inPool(L.FAKE_FIRST_F, repOf(reps, o)), `${o} -> ${repOf(reps, o)}`);
  ({ reps } = text("pt's husband jose called. WIFE BERNADETTE AT BEDSIDE."));
  assert.ok(/^[a-z]+$/.test(repOf(reps, 'jose')) && inPool(L.FAKE_FIRST_M, repOf(reps, 'jose')), repOf(reps, 'jose'));
  assert.ok(/^[A-Z]+$/.test(repOf(reps, 'BERNADETTE')) && inPool(L.FAKE_FIRST_F, repOf(reps, 'BERNADETTE')), repOf(reps, 'BERNADETTE'));
  ({ reps } = text('Mr. Kowalski called. Per Dr. Lee. Seen by Patel PA-C.'));
  for (const o of ['Kowalski', 'Lee', 'Patel']) assert.ok(inPool(L.FAKE_LAST, repOf(reps, o)), `${o} -> ${repOf(reps, o)}`);
  ({ reps } = text('per Nguyen. f/u w/ Patel. per Dr. Terry.'));
  for (const o of ['Nguyen', 'Patel', 'Terry']) assert.ok(inPool(L.FAKE_LAST, repOf(reps, o)), `${o} -> ${repOf(reps, o)}`);
  ({ reps } = text('Emergency contact: Kowalski, Teresa (sister). Contact: Teresa Kowalski (sister). Son J.R. here. Daughter Siobhan Fitzgerald-Nowak.'));
  const lf = repOf(reps, 'Kowalski, Teresa').split(', ');
  assert.ok(inPool(L.FAKE_LAST, lf[0]) && inPool(L.FAKE_FIRST, lf[1]), lf.join(', '));
  const fl = repOf(reps, 'Teresa Kowalski').split(' ');
  assert.deepEqual(fl, [lf[1], lf[0]], 'the same person in the other order keeps the same made-up parts');
  assert.match(repOf(reps, 'J.R'), /^[A-Z]\.[A-Z]$/);
  const hy = repOf(reps, 'Siobhan Fitzgerald-Nowak').split(' ');
  assert.ok(inPool(L.FAKE_FIRST_F, hy[0]) && hy[1].split('-').length === 2 && hy[1].split('-').every((h) => inPool(L.FAKE_LAST, h)), hy.join(' '));
});

test('organizations: a replacement of the same kind, kind words kept, acronyms stay acronyms', () => {
  const kindOf = (name) => Object.keys(L.FAKE_ORG_POOLS).find((k) => L.FAKE_ORG_POOLS[k].includes(name));
  let { reps } = text('Transferred from Kenmore Mercy to Roswell. Works at Tops.');
  assert.equal(kindOf(repOf(reps, 'Kenmore Mercy')), 'hospital', repOf(reps, 'Kenmore Mercy'));
  assert.equal(kindOf(repOf(reps, 'Roswell')), 'cancer', repOf(reps, 'Roswell'));
  assert.equal(kindOf(repOf(reps, 'Tops')), 'shop', repOf(reps, 'Tops'));
  ({ reps } = text('Transferred from Kenmore Mercy Hospital to ECMC. Rx sent to Delaware Pharmacy. Seen at Lakeview Clinic.'));
  for (const [o, tail] of [['Kenmore Mercy Hospital', ' Hospital'], ['Delaware Pharmacy', ' Pharmacy'], ['Lakeview Clinic', ' Clinic']]) {
    const r = repOf(reps, o); assert.ok(r.endsWith(tail) && inPool(L.FAKE_ORG_STEMS, r.slice(0, -tail.length)), `${o} -> ${r}`);
  }
  assert.match(repOf(reps, 'ECMC'), /^[A-Z]{2,6}$/); assert.notEqual(repOf(reps, 'ECMC'), 'ECMC');
  // straight through the Surrogator: the kind from the words around an unknown name
  const sur = D.Surrogator(D.compileConfig(D.defaultConfig({ seed: 3 })), { patients: new Map(), providers: new Map() }, '');
  const org = (t, o) => { const s = t.indexOf(o); return sur.replace({ type: 'ORG', start: s, end: s + o.length }, t); };
  assert.equal(kindOf(org('Works at Acme Widgets.', 'Acme Widgets')), 'employer');
  assert.equal(kindOf(org('Admitted to Brightside overnight.', 'Brightside')), 'hospital');
  assert.equal(kindOf(org('Filled at Corner Rx', 'Corner Rx')), 'pharmacy');
  assert.equal(kindOf(org('Insurance through Quorum denied the claim', 'Quorum')), 'insurer');
  assert.equal(kindOf(org('Lives at Maple Glen since March', 'Maple Glen')), 'nursing');
  assert.equal(kindOf(org('Mentioned Zenthos yesterday', 'Zenthos')), 'unknown');
  assert.equal(org('Works at ACME WIDGETS', 'ACME WIDGETS'), org('Works at ACME WIDGETS', 'ACME WIDGETS').toUpperCase());
});

test('one made-up word, one role (within a session and between sessions); the same real thing keeps its made-up value; same seed, same output', () => {
  const reg = D.createRegistry();
  const roles = new Map(); // made-up word -> role
  const note = (role, s) => wordsOf(s).forEach((w) => { if (w.length < 4 || /^(?:hospital|medical|center|clinic|pharmacy|cancer|street|road|avenue)$/.test(w)) return; const r = roles.get(w); assert.ok(!r || r === role, `"${w}" is both ${r} and ${role}`); roles.set(w, role); });
  const outs = [];
  // two inputs of one session, then two separate sessions: the pools themselves are disjoint, so the roles stay apart even
  // between files protected independently
  for (const [seed, registry] of [[21, reg], [22, reg], [23, D.createRegistry()], [24, D.createRegistry()]]) {
    const s = S.make({ n: 200, seed });
    const res = D.processTable({ headers: s.headers, rows: s.rows }, { seed: seed === 24 ? 5 : 4, registry });
    outs.push(res);
    res.details.forEach((d) => d.cells.forEach((c) => c.replacements.forEach((x) => {
      const role = /^NAME/.test(x.type) ? 'person' : x.type === 'ADDRESS' ? 'street' : x.type === 'LOCATION' ? 'city' : x.type === 'ORG' ? 'org' : null;
      if (!role) return;
      const made = role === 'street' ? x.replacement.replace(/^\d+\s+/, '').split(' ')[0] : role === 'org' ? x.replacement.split(' ')[0] : x.replacement;
      note(role, made);
    })));
  }
  // the same real organization keeps its made-up name in the second input of the session
  const t1 = text('Called Terry about the appt. Transferred from Kenmore Mercy to Roswell.', 9, reg), t2 = text('Called Terry about the labs. Transferred from Kenmore Mercy to Roswell again.', 9, reg);
  for (const o of ['Roswell', 'Kenmore Mercy', 'Terry']) assert.equal(repOf(t2.reps, o), repOf(t1.reps, o), o);
  // determinism: the same input, seed and fresh registry give the same output
  const s = S.make({ n: 120, seed: 8 });
  const a = D.processTable({ headers: s.headers, rows: s.rows }, { seed: 6 }), b = D.processTable({ headers: s.headers, rows: s.rows }, { seed: 6 });
  assert.equal(JSON.stringify(a.rows), JSON.stringify(b.rows));
});

test('a long session never runs out: every made-up patient name unique, still an ordinary name, never a real word, and the self-check stays clean', () => {
  const rows = []; for (let i = 0; i < 700; i++) rows.push([`${L.SURNAMES[i % L.SURNAMES.length]}${i >= L.SURNAMES.length ? 'son' : ''}, ${L.FIRST_NAMES[(i * 7) % L.FIRST_NAMES.length]}`, String(40000000 + i), i % 3 ? 'ok' : `${L.FIRST_NAMES[(i * 7) % L.FIRST_NAMES.length]} tolerated infusion`]);
  const r = D.processTable({ headers: ['Patient Name', 'MRN', 'Comments'], rows }, { seed: 5 });
  const real = new Set(rows.flatMap((x) => wordsOf(x.join(' '))));
  const firsts = r.mapping.patients.map((p) => p.SurrogateName.split(', ')[1]), lasts = r.mapping.patients.map((p) => p.SurrogateName.split(', ')[0]);
  assert.equal(new Set(firsts.map(lc)).size, 700); assert.equal(new Set(lasts.map(lc)).size, 700);
  firsts.forEach((f) => { assert.ok(L.isFirstName(f), f); assert.ok(!real.has(lc(f)), f); });
  lasts.forEach((l) => { assert.ok(L.isSurname(l), l); assert.ok(!real.has(lc(l)), l); });
  assert.equal(D.selfCheck(r).hits.length, 0);
});
