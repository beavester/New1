#!/usr/bin/env node
/* Synthetic evaluation: per-category recall with CIs on several seeds, ablation, adversarial cases.
 * Exits non-zero if the acceptance bar from the research memo is missed on the synthetic set
 * (names/MRN/dates >= 99%, every other category >= 95%, over-redaction <= 2%, zero structured leaks). */
const D = require('../src/core.js');
const S = require('../src/synth.js');
const E = require('../src/evaluate.js');

const pct = (x) => (x == null ? '   –  ' : (x * 100).toFixed(1).padStart(5) + '%');
const seeds = (process.argv[2] || '7,11,23,99').split(',').map(Number);
const n = parseInt(process.argv[3] || '600', 10);
let fail = false;
const BAR = { NAME: 0.99, MRN: 0.99, DATE: 0.99, default: 0.95, overRedaction: 0.02 };

console.log(`Infusion De-ID ${D.VERSION} — synthetic evaluation (${n} rows per seed)\n`);
for (const seed of seeds) {
  const synth = S.make({ n, seed });
  const r = E.runSynthetic(synth);
  const sc = r.score;
  console.log(`seed ${seed}: overall token recall ${pct(sc.overall.recall)}  over-redaction ${pct(sc.overRedaction.rate)} (${sc.overRedaction.redacted}/${sc.overRedaction.nonPhiTokens})  leaks ${r.leaks.length}  unshifted dates ${r.unshifted}`);
  console.log('  category     recall   95% CI              entity   n');
  for (const [T, v] of Object.entries(sc.byType).sort()) {
    const bar = BAR[T] || BAR.default;
    const ok = v.recall >= bar;
    if (!ok) fail = true;
    console.log(`  ${T.padEnd(11)} ${pct(v.recall)}  [${pct(v.ci[0])}, ${pct(v.ci[1])}]  ${pct(v.entityRecall)}  ${String(v.entities).padStart(4)} ${ok ? '' : ' <-- below bar ' + bar}`);
  }
  const subs = Object.entries(sc.subStats).sort().map(([k, v]) => `${k} ${pct(v.hit / v.tot)}`).join('  ');
  console.log('  names:', subs);
  if (sc.overRedaction.rate > BAR.overRedaction) { fail = true; console.log('  <-- over-redaction above bar'); }
  if (r.leaks.length || r.unshifted) { fail = true; console.log('  <-- structured leak', r.leaks.slice(0, 5)); }
  if (sc.misses.length) { console.log('  misses:'); sc.misses.slice(0, 8).forEach((m) => console.log(`    [${m.type}${m.holdout ? ' out-of-lexicon' : ''}] "${m.token}"  …${m.context.replace(/\n/g, '⏎')}…`)); }
  if (sc.falsePositives.length) { console.log('  over-redactions:'); sc.falsePositives.slice(0, 8).forEach((m) => console.log(`    [${m.predType}/${m.source}] "${m.token}"  …${m.context.replace(/\n/g, '⏎')}…`)); }
  console.log('');
}

console.log('Ablation (seed 7, 400 rows): token recall by category');
const abl = E.runAblation(S.make({ n: 400, seed: 7 }));
const types = [...new Set(abl.flatMap((a) => Object.keys(a.score.byType)))].sort();
console.log('  ' + 'configuration'.padEnd(48) + types.map((t) => t.padStart(9)).join('') + '  over-red');
for (const a of abl) console.log('  ' + a.label.padEnd(48) + types.map((t) => pct(a.score.byType[t] ? a.score.byType[t].recall : null).padStart(9)).join('') + '  ' + pct(a.score.overRedaction.rate));

console.log('\nAdversarial cases:');
const adv = E.runAdversarial();
for (const c of adv) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  if (!c.pass) { console.log(`        missed: ${c.phi.filter((p) => !p.caught).map((p) => p.phrase).join(', ') || '-'}; over-redacted: ${c.keep.filter((k) => !k.kept).map((k) => k.phrase).join(', ') || '-'}`); }
}
const advFails = adv.filter((c) => !c.pass && !/expected hard/.test(c.name));
if (advFails.length) fail = true;

console.log(fail ? '\nRESULT: below the acceptance bar on the synthetic set.' : '\nRESULT: meets the acceptance bar on the synthetic set (upper bound; the gold set on real reports is the number that counts).');
process.exit(fail ? 1 : 0);
