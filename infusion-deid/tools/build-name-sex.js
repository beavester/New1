#!/usr/bin/env node
/* Build the first-name -> sex table used by the Surrogator (a made-up first name of the same sex as the real one).
 *
 * Sources (vendor/names/, see vendor/names/README.md):
 *   baby-names.csv   SSA top-1000 baby names per year 1880-2008, with sex (public domain)
 *   surnames.csv     US Census 2000 surnames with counts (public domain)
 *
 * Output: the block between the GENERATED:NAME_SEX markers in src/lexicon.js (replaced in place):
 *   f / m   names given to one sex at least 90% of the time (weighted by share of births), "given-dominant" ones
 *   fs / ms the same, for names that are more common as a surname than as a first name (Lee, Kelly, Jordan, Kim)
 *   u       given-dominant names used by both sexes (Casey, Riley)
 * "Given-dominant": estimated bearers as a first name exceed the Census count as a surname.
 *
 *   node tools/build-name-sex.js          rewrite the block
 *   node tools/build-name-sex.js --check  exit 1 when the block is out of date
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, 'vendor/names', f), 'utf8');
const norm = (s) => s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const BIRTHS_PER_SEX_YEAR = 1.5e6; // rough: enough to compare a first name's bearers with a surname's

const census = new Map();
for (const line of read('surnames.csv').split(/\r?\n/).slice(1)) { const [name, , count] = line.split(','); const n = norm(name || ''); if (n && +count) census.set(n, +count); }
const share = new Map(); // name -> [girl, boy] summed share of births
for (const line of read('baby-names.csv').split(/\r?\n/).slice(1)) {
  const p = line.split(','); if (p.length < 4) continue;
  const n = norm(p[1].replace(/"/g, '')), pct = +p[2], girl = /girl/.test(p[3]);
  if (!/^[a-z]{2,20}$/.test(n) || !(pct > 0)) continue;
  const s = share.get(n) || [0, 0]; s[girl ? 0 : 1] += pct; share.set(n, s);
}
const out = { f: [], m: [], fs: [], ms: [], u: [] };
for (const [n, [g, b]] of share) {
  const tot = g + b, given = tot * BIRTHS_PER_SEX_YEAR > (census.get(n) || 0);
  if (g / tot >= 0.9) out[given ? 'f' : 'fs'].push(n);
  else if (b / tot >= 0.9) out[given ? 'm' : 'ms'].push(n);
  else if (given) out.u.push(n);
}
const wrap = (arr) => { const lines = []; let cur = ''; for (const w of arr.sort()) { if (cur.length + w.length + 1 > 116) { lines.push(cur); cur = ''; } cur += (cur ? ' ' : '') + w; } if (cur) lines.push(cur); return lines.map((l) => '      ' + l).join('\n'); };
const block = `// GENERATED:NAME_SEX begin (tools/build-name-sex.js from vendor/names; do not edit by hand)
  const NAME_SEX_DATA = {
${Object.keys(out).map((k) => `    ${k}: \`\n${wrap(out[k])}\`,`).join('\n')}
  };
  // GENERATED:NAME_SEX end`;
const file = path.join(root, 'src/lexicon.js');
const src = fs.readFileSync(file, 'utf8');
const re = /\/\/ GENERATED:NAME_SEX begin[\s\S]*?\/\/ GENERATED:NAME_SEX end/;
if (!re.test(src)) { console.error('markers not found in src/lexicon.js'); process.exit(1); }
const next = src.replace(re, () => block);
if (process.argv.includes('--check')) { if (next !== src) { console.error('src/lexicon.js NAME_SEX block is out of date'); process.exit(1); } console.log('NAME_SEX block is up to date'); process.exit(0); }
fs.writeFileSync(file, next);
console.log(Object.keys(out).map((k) => `${k}: ${out[k].length}`).join('  '), `(${(Buffer.byteLength(block) / 1024).toFixed(1)} KB)`);
