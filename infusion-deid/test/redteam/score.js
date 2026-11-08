#!/usr/bin/env node
/* Red-team scorer. Deterministic judge for adversarial cases; no agent decides pass/fail.
 *
 *   node test/redteam/score.js            text + table cases (Node, fast)
 *   node test/redteam/score.js --ocr      also screenshot cases through the built OCR page in Chromium
 *   node test/redteam/score.js --only r3  only case files whose name contains "r3"
 *
 * cases/*.json  : [{ id, kind: 'table'|'text', headers?, rows?, text?, phi: [..], keep: [..], note? }]
 * screens/*.json: [{ id, htmls: [html, ...], phi: [..], keep: [..], expectPatients?, viewport?: {width,height}, scale?, note? }]
 *
 * A LEAK is any phi string still present in the protected output: exact (case-insensitive, word-bounded) or,
 * for words of 5+ letters, within one edit (so an OCR misread of a name still counts as a leak).
 * LOST is a keep string missing from the output (clinical content destroyed).
 * BLOCKED (screens only) is the self-check refusing to vouch for a file that contains no leak.
 */
const fs = require('fs');
const path = require('path');
const D = require('../../src/core.js');

const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const withOcr = args.includes('--ocr');
const ocrOnly = args.includes('--ocr-only');
const json = args.includes('--json');
const dir = (d) => path.join(__dirname, d);
const load = (d) => fs.existsSync(dir(d)) ? fs.readdirSync(dir(d)).filter((f) => f.endsWith('.json') && (!only || f.includes(only))).sort().flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir(d), f), 'utf8')).map((c) => Object.assign({ file: f }, c))) : [];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function lev(a, b) { if (a === b) return 0; let p = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { const c = [i]; for (let j = 1; j <= b.length; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[b.length]; }
function present(out, needle, inputText) {
  const o = out.toLowerCase(), n = String(needle).toLowerCase().trim();
  if (!n) return false;
  const digits = n.replace(/\D/g, '');
  if (/^[\d\s\-().+]+$/.test(n) && digits.length >= 6) return out.replace(/\D/g, '').includes(digits); // numbers: ignore formatting
  // exact match; an age written as "... 90" followed by "+" is the Safe Harbor 90-or-older group, not a leak
  const tail = /(?:9\d|1[01]\d)$/.test(n) ? '(?![a-z0-9+])' : '(?![a-z0-9])';
  if (new RegExp(`(?<![a-z0-9])${esc(n)}${tail}`, 'i').test(o)) return true;
  // one-edit match catches OCR misreads of a name; a word that is already in the case's own input (e.g. "grade"
  // near "Grace") is not a misread and does not count
  if (/^[a-z'’\-]{5,}$/.test(n)) {
    const inputToks = new Set((String(inputText || '').toLowerCase().match(/[a-z'’\-]{4,}/g) || []));
    const toks = o.match(/[a-z'’\-]{4,}/g) || [];
    return toks.some((t) => !inputToks.has(t) && Math.abs(t.length - n.length) <= 1 && lev(t, n) <= 1);
  }
  return false;
}
const inputOf = (c) => c.text || (c.rows ? JSON.stringify(c.rows) : '') || (c.htmls ? c.htmls.join(' ').replace(/<[^>]+>/g, ' ') : '');
function judge(c, out) {
  const leaks = (c.phi || []).filter((p) => present(out, p, inputOf(c)));
  const lost = (c.keep || []).filter((k) => !out.toLowerCase().includes(String(k).toLowerCase()));
  return { leaks, lost };
}

function runCase(c) {
  const reg = D.createRegistry();
  let res;
  if (c.kind === 'text') { const t = D.parseTextDocument(c.text); res = D.processTable({ headers: t.headers, rows: t.rows }, { columns: t.columns, registry: reg, seed: 7 }); }
  else res = D.processTable({ headers: c.headers, rows: c.rows }, { registry: reg, seed: 7 });
  const out = res.rows.map((r) => r.map(D.cellToString).join(' | ')).join('\n');
  return Object.assign({ id: c.id, file: c.file, out }, judge(c, out));
}

async function runScreens(cases) {
  const { chromium } = require('playwright');
  const dist = path.resolve(__dirname, '../../dist/infusion-deid-ocr.html');
  if (!fs.existsSync(dist)) throw new Error('build first: node build.js --all');
  const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-'));
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const c of cases) {
      const vp = c.viewport || { width: 1200, height: 700 };
      const mk = await browser.newContext({ viewport: vp, deviceScaleFactor: c.scale || 1 });
      const files = [];
      for (let i = 0; i < c.htmls.length; i++) { const pg = await mk.newPage(); await pg.setContent(c.htmls[i]); const f = path.join(tmp, `${c.id}-${i}.png`); await pg.screenshot({ path: f, fullPage: true }); await pg.close(); files.push(f); }
      await mk.close();
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage(); const net = [];
      page.on('request', (r) => { if (!/^(file|blob|data):/.test(r.url())) net.push(r.url()); });
      await page.goto('file://' + dist);
      await page.setInputFiles('#file', files);
      const n = files.length;
      try {
        await page.waitForFunction((k) => window.__deid && window.__deid.session.items.length >= k && window.__deid.session.items.every((it) => it.result) && document.querySelector('#working').classList.contains('hidden'), n, { timeout: 120000 * n });
      } catch (e) { results.push({ id: c.id, file: c.file, error: 'timeout', leaks: [], lost: [] }); await ctx.close(); continue; }
      const st = await page.evaluate(() => {
        const s = window.__deid.session;
        return { out: s.items.map((it) => it.result.rows.map((r) => r.map((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v == null ? '' : v))).join(' | ')).join('\n')).join('\n'),
          ocr: s.items.map((it) => (it.ocr && it.ocr.text) || '').join('\n---\n'), patients: s.registry.size,
          red: s.items.some((it) => it.leak && it.leak.hits.length), dlAll: !document.querySelector('#dlAll').disabled,
          hits: s.items.flatMap((it) => (it.leak ? it.leak.hits : []).map((h) => h.kind + ':' + h.text)).slice(0, 8) };
      });
      const j = judge(c, st.out);
      results.push({ id: c.id, file: c.file, out: st.out, ocr: st.ocr, patients: st.patients, expectPatients: c.expectPatients, red: st.red, dlAll: st.dlAll, hits: st.hits, net, ...j,
        blocked: st.red && !j.leaks.length, merge: c.expectPatients != null && st.patients !== c.expectPatients });
      await ctx.close();
    }
  } finally { await browser.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
  return results;
}

(async () => {
  const report = { cases: 0, leaks: 0, lost: 0, screens: 0, screenLeaks: 0, blocked: 0, mismerge: 0, network: 0, failures: [] };
  if (!ocrOnly) for (const c of load('cases')) {
    report.cases++;
    let r; try { r = runCase(c); } catch (e) { r = { id: c.id, file: c.file, error: e.message, leaks: [], lost: [] }; }
    if (r.leaks.length) report.leaks++;
    if (r.lost.length) report.lost++;
    if (r.leaks.length || r.lost.length || r.error) report.failures.push(r);
  }
  if (withOcr || ocrOnly) {
    const screens = load('screens');
    for (const r of await runScreens(screens)) {
      report.screens++;
      if (r.leaks.length) report.screenLeaks++;
      if (r.lost.length) report.lost++;
      if (r.blocked) report.blocked++;
      if (r.merge) report.mismerge++;
      if (r.net && r.net.length) report.network++;
      if (r.leaks.length || r.lost.length || r.blocked || r.merge || r.error || (r.net && r.net.length)) report.failures.push(r);
    }
  }
  if (json) { console.log(JSON.stringify(report, null, 1)); }
  else {
    console.log(`text/table cases: ${report.cases}  with leaks: ${report.leaks}  with lost clinical text: ${report.lost}`);
    if (withOcr || ocrOnly) console.log(`screenshot cases: ${report.screens}  with leaks: ${report.screenLeaks}  blocked by self-check: ${report.blocked}  wrong patient count: ${report.mismerge}  network: ${report.network}`);
    for (const f of report.failures.slice(0, 60)) {
      console.log(`\n[${f.file} :: ${f.id}]${f.error ? ' ERROR ' + f.error : ''}`);
      if (f.leaks.length) console.log('  LEAK: ' + f.leaks.join(' · '));
      if (f.lost.length) console.log('  LOST: ' + f.lost.join(' · '));
      if (f.blocked) console.log('  BLOCKED: ' + (f.hits || []).join(' · '));
      if (f.merge) console.log(`  PATIENTS: got ${f.patients}, expected ${f.expectPatients}`);
      if (f.out) console.log('  OUT: ' + f.out.replace(/\n/g, ' ⏎ ').slice(0, 600));
    }
  }
  process.exit(report.leaks || report.screenLeaks || report.mismerge || report.network ? 1 : 0);
})();
