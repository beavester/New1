#!/usr/bin/env node
/* Browser end-to-end check of dist/infusion-deid.html with Playwright + Chromium.
 * Loads the built single file over file://, writes a synthetic xlsx, uploads it, runs the pipeline,
 * exercises review edits and all downloads, runs the Validate tab, and round-trips Re-identify. */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const XLSX = require('../vendor/xlsx.full.min.js');
const S = require('../src/synth.js');

(async () => {
  const dist = path.resolve(__dirname, '../dist/infusion-deid.html');
  if (!fs.existsSync(dist)) throw new Error('run `node build.js` first');
  const tmpRoot = process.env.DEID_TMP || path.join(__dirname, '..', '.e2e-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  const synth = S.make({ n: 150, seed: 31 });
  const ws = XLSX.utils.aoa_to_sheet([['Infusion Schedule Report', null, null], ['Printed 11/8/2026'], synth.headers, ...synth.rows], { cellDates: true });
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
  const input = path.join(tmp, 'schedule.xlsx'); fs.writeFileSync(input, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('request', (r) => { if (!r.url().startsWith('file://') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) errors.push('NETWORK REQUEST: ' + r.url()); });
  await page.goto('file://' + dist);

  // 1. load file (title rows above the header must be auto-detected)
  await page.setInputFiles('#file', input);
  await page.waitForSelector('#colsCard:not(.hidden)');
  const shape = await page.textContent('#shapeInfo');
  if (!shape.startsWith('150 rows')) throw new Error('header row detection failed: ' + shape);
  const roles = await page.$$eval('#colsTable select', (els) => els.map((e) => e.value));
  const expectRole = (h, r) => { const i = synth.headers.indexOf(h); if (roles[i] !== r) throw new Error(`column ${h} classified as ${roles[i]}, expected ${r}`); };
  expectRole('Patient Name', 'patient_name'); expectRole('MRN', 'mrn'); expectRole('DOB', 'dob'); expectRole('Comments', 'text'); expectRole('Appt Date', 'date'); expectRole('Attending', 'provider'); expectRole('Phone', 'phone'); expectRole('Acct #', 'account'); expectRole('Age', 'age');

  // 2. run
  await page.click('#run');
  await page.waitForSelector('#exportCard:not(.hidden)');
  await page.waitForFunction(() => /Done in/.test(document.querySelector('#runInfo').textContent));
  const summary = await page.textContent('#summary');
  if (!/patients in census/.test(summary)) throw new Error('summary missing');

  // 3. review: toggle the first highlight off, then back on
  const firstMark = await page.$('#reviewTable mark');
  if (!firstMark) throw new Error('no highlights rendered');
  const markText = await firstMark.textContent();
  await firstMark.click();
  await page.waitForFunction(() => /Done in/.test(document.querySelector('#runInfo').textContent));
  const removed = await page.$('#reviewTable mark.removed');
  if (!removed) throw new Error('toggle-off did not render a removed mark');
  await removed.click();
  await page.waitForFunction(() => /Done in/.test(document.querySelector('#runInfo').textContent));
  const restored = await page.$$eval('#reviewTable mark', (ms, t) => ms.some((m) => m.textContent === t && !m.classList.contains('removed')), markText);
  if (!restored) throw new Error('toggle-on failed');

  // 4. downloads
  const dl = async (sel) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); const p = path.join(tmp, d.suggestedFilename()); await d.saveAs(p); return p; };
  const deidPath = await dl('#dlXlsx');
  const mapPath = await dl('#dlMap');
  const csvPath = await dl('#dlCsv');
  const reportPath = await dl('#dlReport');
  const readWb = (p) => XLSX.read(fs.readFileSync(p), { type: 'buffer', cellDates: true });
  const outWb = readWb(deidPath);
  const outAoa = XLSX.utils.sheet_to_json(outWb.Sheets[outWb.SheetNames[0]], { header: 1, raw: true, defval: null });
  const outText = JSON.stringify(outAoa).toLowerCase();
  for (const p of synth.patients) {
    if (outText.includes(p.mrn)) throw new Error('MRN leaked: ' + p.mrn);
    if (outText.includes(`${p.last}, ${p.first}`.toLowerCase())) throw new Error('name leaked: ' + p.last);
  }
  if (!outAoa[0].includes('DeID Audit')) throw new Error('audit column missing');
  const csv = fs.readFileSync(csvPath, 'utf8'); if (!/DeID Audit/.test(csv)) throw new Error('csv missing');
  const report = fs.readFileSync(reportPath, 'utf8'); if (!/Column roles/.test(report)) throw new Error('report missing');

  // 5. validate tab
  await page.click('nav button[data-tab="validate"]');
  await page.fill('#synN', '200');
  await page.click('#synRun');
  await page.waitForFunction(() => /token recall/.test(document.querySelector('#synOut').textContent));
  const synOut = await page.textContent('#synOut');
  const m = synOut.match(/(\d+\.\d)%token recall/);
  if (!m || parseFloat(m[1]) < 99) throw new Error('synthetic recall too low: ' + (m && m[1]));
  await page.click('#synAdv'); await page.waitForSelector('#advCard:not(.hidden)');
  const adv = await page.textContent('#advOut'); if (!/19 of 20 pass/.test(adv)) throw new Error('adversarial: ' + adv.slice(0, 60));
  await page.click('#synAbl'); await page.waitForFunction(() => /Tier 0 rules only/.test(document.querySelector('#ablOut').textContent));

  // 6. re-identify round trip
  await page.click('nav button[data-tab="reid"]');
  await page.setInputFiles('#reidFile', deidPath);
  await page.setInputFiles('#reidMap', mapPath);
  const [reidDl] = await Promise.all([page.waitForEvent('download'), page.click('#reidRun')]);
  const reidPath = path.join(tmp, reidDl.suggestedFilename()); await reidDl.saveAs(reidPath);
  const reidAoa = XLSX.utils.sheet_to_json(readWb(reidPath).Sheets['Re-identified'], { header: 1, raw: true, defval: null });
  const mrnCol = synth.headers.indexOf('MRN'), dateCol = synth.headers.indexOf('Appt Date');
  let okMrn = 0, okDate = 0;
  for (let i = 0; i < synth.rows.length; i++) {
    const norm = (v) => String(v).replace(/^0+/, '');
    if (norm(reidAoa[i + 1][mrnCol]) === norm(synth.rows[i][mrnCol])) okMrn++;
    const a = reidAoa[i + 1][dateCol], b = synth.rows[i][dateCol];
    if (a instanceof Date && Math.abs(a.getTime() - b.getTime()) < 36e5) okDate++;
  }
  if (okMrn !== synth.rows.length) throw new Error(`re-identified MRNs ${okMrn}/${synth.rows.length}`);
  if (okDate !== synth.rows.length) throw new Error(`re-identified dates ${okDate}/${synth.rows.length}`);

  await page.screenshot({ path: path.join(__dirname, '../docs/screenshot-deid.png'), fullPage: false }).catch(() => {});
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (errors.length) throw new Error('browser errors:\n' + errors.join('\n'));
  console.log('e2e OK:', { rows: synth.rows.length, deid: path.basename(deidPath), mapping: path.basename(mapPath), reidentifiedMrns: okMrn, reidentifiedDates: okDate });
})().catch((e) => { console.error('e2e FAILED:', e.message); process.exit(1); });
