#!/usr/bin/env node
/* Browser end-to-end check of dist/infusion-deid.html (and the OCR build) with Playwright + Chromium.
 * Flow under test: drop → auto-run → verdict (self-check) → review → download; a session that links the same
 * patients across a second spreadsheet and pasted text; the columns gate; new session; restore from a key;
 * the Check accuracy tab; Restore identities round trips; and, on the OCR build, two synthetic screenshots of
 * the same patients recognised in the page and linked to one set of codes. */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const XLSX = require('../vendor/xlsx.full.min.js');
const S = require('../src/synth.js');
const D = require('../src/core.js');

const fmtDate = (v) => (v instanceof Date ? `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}` : String(v == null ? '' : v));
const readWb = (p) => XLSX.read(fs.readFileSync(p), { type: 'buffer', cellDates: true });
const aoaOf = (wb, name) => XLSX.utils.sheet_to_json(wb.Sheets[name || wb.SheetNames[0]], { header: 1, raw: true, defval: null });
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

(async () => {
  const dist = path.resolve(__dirname, '../dist/infusion-deid.html');
  const distOcr = path.resolve(__dirname, '../dist/infusion-deid-ocr.html');
  if (!fs.existsSync(dist)) throw new Error('run `node build.js --all` first');
  const tmpRoot = process.env.DEID_TMP || path.join(__dirname, '..', '.e2e-tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  const synth = S.make({ n: 150, seed: 31 });
  const ws = XLSX.utils.aoa_to_sheet([['Infusion Schedule Report', null, null], ['Printed 11/8/2026'], synth.headers, ...synth.rows], { cellDates: true });
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Schedule');
  const input = path.join(tmp, 'schedule.xlsx'); fs.writeFileSync(input, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true }));
  const tinyPng = path.join(tmp, 'tiny.png'); fs.writeFileSync(tinyPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  // columns gate case: a kept column whose header looks like an identifier (name-like values, "First Last" so the classifier keeps it)
  const contactPool = ['Avery Thistlewood', 'Rowan Castellane', 'Marlowe Quenneville', 'Sable Winterbourne', 'Tamsin Oyelaran', 'Perrin Vasquez-Hale', 'Lorcan Bramwell', 'Imani Strickland', 'Soren Lindqvist', 'Briar Holloway', 'Dashiell Okonkwo', 'Wren Fairbanks'];
  const usedNames = new Set(synth.patients.flatMap((p) => [p.first.toLowerCase(), p.last.toLowerCase()]));
  const gateRows = synth.patients.slice(0, 12).map((p, i) => [p.nameCell, p.mrn, contactPool[i].split(/[ -]/).some((w) => usedNames.has(w.toLowerCase())) ? 'Juniper Ashgrove' : contactPool[i], `pt doing well on ${p.regimen}; chair ${i + 1}`]);
  const gwb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(gwb, XLSX.utils.aoa_to_sheet([['Patient Name', 'MRN', 'Contact', 'Comments'], ...gateRows]), 'Sheet1');
  const gateInput = path.join(tmp, 'gate.xlsx'); fs.writeFileSync(gateInput, XLSX.write(gwb, { type: 'buffer', bookType: 'xlsx' }));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  const watch = (pg) => {
    pg.on('pageerror', (e) => errors.push(String(e)));
    pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    pg.on('request', (r) => { if (!r.url().startsWith('file://') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) errors.push('NETWORK REQUEST: ' + r.url()); });
    pg.on('dialog', (d) => { errors.push('DIALOG: ' + d.message()); d.dismiss().catch(() => {}); });
  };
  watch(page);
  await page.goto('file://' + dist);
  const doneIn = () => page.waitForFunction(() => /Done in/.test(document.querySelector('#runInfo').textContent));
  const sessionText = () => page.textContent('#session');
  const patientCount = async () => +((await sessionText()).match(/(\d+) patients/) || [])[1];
  const openAdvanced = () => page.evaluate(() => { document.querySelector('#advanced').open = true; document.querySelectorAll('#advanced details').forEach((d) => { d.open = true; }); });
  let dlSeq = 0;
  // save under the suggested name, but never overwrite an earlier download that the test still needs
  const dl = async (sel) => { const [d] = await Promise.all([page.waitForEvent('download'), page.click(sel)]); let p = path.join(tmp, d.suggestedFilename()); if (fs.existsSync(p)) p = path.join(tmp, `${++dlSeq}_${d.suggestedFilename()}`); await d.saveAs(p); return p; };

  // 0. nav labels
  const nav = await page.$$eval('nav button', (bs) => bs.map((b) => [b.dataset.tab, b.textContent.trim()]));
  assert(JSON.stringify(nav) === JSON.stringify([['deid', 'Protect'], ['validate', 'Check accuracy'], ['reid', 'Restore identities'], ['about', 'About and limits']]), 'nav labels: ' + JSON.stringify(nav));
  assert(!(await page.$('#optAuditDetail')), '#optAuditDetail must not exist');
  assert(await page.$eval('#optAudit', (e) => e.checked && e.disabled), '#optAudit must be checked and disabled');
  assert(!(await page.$eval('#advanced', (e) => e.open)), 'Advanced must start closed');
  for (const id of ['optPatients', 'optProviders', 'optDates', 'optDob', 'optAges', 'optDeny', 'optAllow', 'optRange', 'optMrn', 'optSeed', 'optDerive', 'optOverride']) assert(await page.$('#advanced #' + id), 'missing #' + id + ' inside #advanced');
  assert((await page.$eval('#optDates', (e) => e.value)) === 'shift', 'dates default must be shift');

  // 1. load file (title rows above the header must be auto-detected); the run starts by itself
  await page.setInputFiles('#file', input);
  await page.waitForSelector('#colsCard:not(.hidden)');
  const shape = await page.textContent('#shapeInfo');
  assert(shape.startsWith('150 rows'), 'header row detection failed: ' + shape);
  const roles = await page.$$eval('#colsTable select', (els) => els.map((e) => e.value));
  const expectRole = (h, r) => { const i = synth.headers.indexOf(h); assert(roles[i] === r, `column ${h} classified as ${roles[i]}, expected ${r}`); };
  expectRole('Patient Name', 'patient_name'); expectRole('MRN', 'mrn'); expectRole('DOB', 'dob'); expectRole('Comments', 'text'); expectRole('Appt Date', 'date'); expectRole('Attending', 'provider'); expectRole('Phone', 'phone'); expectRole('Acct #', 'account'); expectRole('Age', 'age');
  await doneIn();
  await page.waitForSelector('#exportCard:not(.hidden)');
  // Run again only shows after a failed run; every change re-runs by itself
  assert(await page.$eval('#run', (e) => e.classList.contains('hidden')), 'Run again must be hidden after a successful run');
  // the primary download sits in the verdict card and is enabled; "Choose a file" is a real button
  assert(await page.$('#verdictActions:not(.hidden) #dlNow:not([disabled])'), 'download button missing from the verdict card');
  assert(await page.$eval('#chooseBtn', (b) => b.tagName === 'BUTTON' && b.classList.contains('primary')), 'Choose a file must be a primary button');
  await page.waitForFunction(() => document.querySelector('#prog').classList.contains('hidden'), null, { timeout: 5000 }).catch(() => { throw new Error('progress bar should hide after the run'); });

  // 2. verdict + summary
  const summary = await page.textContent('#summary');
  assert(/\d+ rows/.test(summary) && /\d+ patients/.test(summary) && /lines need a look/.test(summary), 'summary missing: ' + summary);
  assert(/What was replaced/.test(summary) && /Names|Dates|Record numbers/.test(summary) && !/census|lexicon|propagate|\bcue\b|\brule\b/.test(summary), 'summary pills: ' + summary);
  const verdict = await page.textContent('#verdict');
  assert(/Checked:/.test(verdict) && /Dates: shifted/.test(verdict), 'verdict: ' + verdict.slice(0, 120));
  for (const id of ['dlXlsx', 'dlCsv', 'dlAll']) assert(!(await page.isDisabled('#' + id)), id + ' should be enabled');
  assert(/Dates: shifted/.test(await sessionText()), 'session dates line');
  const firstPatients = await patientCount();
  assert(firstPatients > 0, 'session patient count');
  // plain words only on the Protect tab
  const protectText = await page.$eval('#tab-deid', (el) => { const c = el.cloneNode(true); c.querySelectorAll('option').forEach((o) => o.remove()); return c.textContent; });
  const banned = /\b(de-identif\w*|surrogates?|census|mapping key|re-identif\w*|seed|regex|patterns?|lexicon|cue|propagat\w*|audit|token recall|CI|hide in plain sight)\b/i;
  const bad = protectText.match(banned); assert(!bad, 'banned word on the Protect tab: ' + (bad && bad[0]));
  const filter0 = await page.$eval('#reviewFilter', (e) => e.value);
  const heading = await page.textContent('#reviewHeading');
  assert((/^\d+ lines? needs? a look/.test(heading.trim()) && filter0 === 'model') || (/Nothing needs a look/.test(heading) && filter0 === 'all'), `filter default ${filter0} vs heading ${heading}`);
  // review noise: on a clean synthetic report far fewer than half the rows may be flagged
  const flaggedN = await page.evaluate(() => window.__deid.state.current.flagged);
  assert(flaggedN < synth.rows.length * 0.25, `too many lines flagged for review: ${flaggedN} of ${synth.rows.length}`);
  assert((await page.$$('#reviewTable tr')).length > 1, 'review table must not be empty by default');
  const markAttrs = await page.$$eval('#reviewTable mark', (ms) => ms.map((m) => [m.dataset.type, m.dataset.src, m.title]));
  assert(markAttrs.length && markAttrs.every((a) => a[0] && a[1] && /^Found by:|from the patient list/.test(a[2])), 'marks need data-type/data-src/Found by title');

  // 3. review: toggle the first non-locked highlight off, then back on
  await page.selectOption('#reviewFilter', 'all');
  const firstMark = await page.$('#reviewTable mark:not(.locked)');
  assert(firstMark, 'no highlights rendered');
  const markText = await firstMark.textContent();
  await firstMark.click();
  await doneIn();
  const removed = await page.$('#reviewTable mark.removed');
  assert(removed, 'toggle-off did not render a removed mark');
  await removed.click();
  await doneIn();
  const restored = await page.$$eval('#reviewTable mark', (ms, t) => ms.some((m) => m.textContent === t && !m.classList.contains('removed')), markText);
  assert(restored, 'toggle-on failed');
  // 3b. a patient's own identifier cannot be un-hidden from the table (the mark is locked and explains why)…
  await page.selectOption('#reviewFilter', 'all');
  const pm = await page.$('#reviewTable mark[data-type="NAME_PATIENT"][data-src^="census"]');
  assert(pm, 'no census patient-name mark');
  const pmText = await pm.textContent();
  assert(await pm.evaluate((m) => m.classList.contains('locked')), 'census patient mark must be locked');
  await pm.click();
  assert(/cannot be un-hidden/.test(await page.textContent('#reviewTable')), 'locked mark should explain itself');
  assert(!(await page.$('#reviewTable mark.removed')), 'a locked mark must not be removed by a click');
  assert(!(await page.isDisabled('#dlXlsx')), 'self-check must stay green after clicking a locked mark');
  // …and if one is forced out (test hook), the self-check turns red and blocks downloads
  const forced = await page.evaluate(() => {
    const it = window.__deid.state.current;
    for (const d of it.result.details) for (const c of d.cells) { const sp = c.spans.find((x) => x.entity && x.type === 'NAME_PATIENT'); if (sp) { const key = `${d.row}:${c.col}`; it.manual[key] = { remove: [[sp.start, sp.end, sp.type, sp.source]], add: [] }; window.__deid.runDeid(it, false); return { key, text: sp.text }; } }
    return null;
  });
  assert(forced, 'no census patient span to force out');
  await doneIn();
  assert(await page.isDisabled('#dlXlsx'), 'dlXlsx must be disabled while the self-check is red');
  assert(await page.$eval('#verdictActions', (e) => e.classList.contains('hidden')), 'verdict download button must hide when red');
  const redVerdict = await page.textContent('#verdict');
  assert(/Stop:/.test(redVerdict) && /Row \d+/.test(redVerdict) && /still appears? in the output/.test(redVerdict), 'red verdict: ' + redVerdict.slice(0, 160));
  // compliance override (inside Advanced → Technical)
  await openAdvanced();
  await page.check('#optOverride');
  assert(!(await page.isDisabled('#dlXlsx')), 'override must enable downloads');
  const overReport = fs.readFileSync(await dl('#dlReport'), 'utf8');
  assert(/Self-check overridden: yes/.test(overReport) && /Self-check: overridden/.test(overReport), 'override not recorded in report');
  await page.uncheck('#optOverride');
  assert(await page.isDisabled('#dlXlsx'), 'dlXlsx must be disabled again after the override is removed');
  await page.evaluate((key) => { const it = window.__deid.state.current; delete it.manual[key]; window.__deid.runDeid(it, false); }, forced.key);
  await doneIn();
  assert(!(await page.isDisabled('#dlXlsx')) && /Checked:/.test(await page.textContent('#verdict')), 'self-check did not recover');
  void pmText;
  await page.selectOption('#reviewFilter', 'model');

  // 4. downloads
  const deidPath = await dl('#dlXlsx');
  assert(/^protected_\d{4}-\d{2}-\d{2}_1\.xlsx$/.test(path.basename(deidPath)) && !/schedule/.test(deidPath.slice(tmp.length)), 'output filename: ' + path.basename(deidPath));
  const mapPath = await dl('#dlMap');
  assert(/^SESSION_KEY_PHI_\d{4}-\d{2}-\d{2}_\d{4}_1\.xlsx$/.test(path.basename(mapPath)), 'key filename: ' + path.basename(mapPath));
  assert(await page.$('#session #dlMap:not(.danger)'), '#dlMap must live in the session strip and not look like a danger button');
  assert(/PHI/.test(await page.textContent('#dlMap')), 'key button must say PHI');
  assert(/key saved/.test(await sessionText()), 'session strip should say key saved');
  const keyWb = readWb(mapPath);
  assert(['Patients', 'Providers', 'Others', 'Meta'].every((n) => keyWb.SheetNames.includes(n)), 'key sheets: ' + keyWb.SheetNames);
  const csvPath = await dl('#dlCsv');
  const reportPath = await dl('#dlReport');
  const outWb = readWb(deidPath);
  const outAoa = aoaOf(outWb);
  const outText = JSON.stringify(outAoa).toLowerCase();
  for (const p of synth.patients) {
    assert(!outText.includes(p.mrn), 'MRN leaked: ' + p.mrn);
    assert(!outText.includes(`${p.last}, ${p.first}`.toLowerCase()), 'name leaked: ' + p.last);
  }
  const auditCol = outAoa[0].indexOf('DeID Audit');
  assert(auditCol >= 0, 'audit column missing');
  assert(!outAoa.slice(1).some((r) => /shift:[+-]?\d+d/.test(String(r[auditCol]))), 'audit column must not carry the date offset');
  const csv = fs.readFileSync(csvPath, 'utf8'); assert(/DeID Audit/.test(csv), 'csv missing');
  const report = fs.readFileSync(reportPath, 'utf8');
  assert(/Column roles/.test(report) && /Self-check: passed/.test(report) && /Input 1 of \d+/.test(report) && !/schedule\.xlsx/.test(report), 'report content');

  // 4a. a column change re-runs by itself and remembers the layout
  const sexIdx = synth.headers.indexOf('Sex');
  await page.click('#colsChange');
  assert(await page.$eval('#colsDetails', (d) => d.open), 'Change should open the column details');
  await page.selectOption(`#colsTable select[data-i="${sexIdx}"]`, 'keep');
  assert(/Working/.test(await page.textContent('#runInfo')), 'column change did not auto-run');
  await doneIn();
  const lsKeys = await page.evaluate(() => Object.keys(localStorage));
  assert(lsKeys.some((k) => k.startsWith('deid:cfg:')), 'layout not saved: ' + lsKeys);

  // 4b. the same spreadsheet again: one more source, no new patients, "download everything" has two sheets
  await page.setInputFiles('#file', input);
  await page.waitForFunction(() => /2 sources/.test(document.querySelector('#session').textContent));
  await doneIn();
  assert((await patientCount()) === firstPatients, 'second upload changed the patient count');
  assert(/Remembered layout/.test(await page.textContent('#cfgBadge')), 'remembered layout badge');
  assert(!(await page.isDisabled('#dlAll')), 'dlAll disabled');
  const allPath = await dl('#dlAll');
  const allWb = readWb(allPath);
  assert(JSON.stringify(allWb.SheetNames) === JSON.stringify(['Input 1', 'Input 2']), 'download-everything sheets: ' + allWb.SheetNames);

  // 4c. pasted text about a patient from the spreadsheet links by MRN
  const p0 = synth.patients[0];
  const note = [`${p0.last}, ${p0.first}  MRN ${p0.mrn}  DOB ${fmtDate(p0.dob)}`, 'Tolerated cycle well, no infusion reaction.', 'Premeds given as ordered; chair 4.', 'Labs reviewed by the covering pharmacist.', `Daughter will drive the patient home after the visit.`, 'Next visit as scheduled.'].join('\n');
  await page.click('#pasteOpen');
  await page.waitForSelector('#pasteText:not(.hidden)');
  await page.fill('#pasteText', note);
  await page.click('#pasteRun');
  await page.waitForFunction(() => /3 sources/.test(document.querySelector('#session').textContent));
  await doneIn();
  assert((await patientCount()) === firstPatients, 'pasted text should link to an existing patient');
  // 4c-ii. a pasted census line whose surname is an ordinary word (Bell, Hill) is still captured and protected
  const wordNote = ['Bell, Kevin T  MRN 032767781  DOB 1/1/1960', 'Tolerating well. Bell reports mild nausea; pt Bell to return 11/20/2026.', '=== next ===', 'Hill, Rose  84445786  9/20/1972', 'Hill tolerating infusion. per Bruno, Georgiana MD ok to proceed.'].join('\n');
  await page.click('#pasteOpen'); await page.fill('#pasteText', wordNote); await page.click('#pasteRun');
  await page.waitForFunction(() => /4 sources/.test(document.querySelector('#session').textContent)); await doneIn();
  const wordOut = await page.evaluate(() => { const it = window.__deid.state.current; return { rows: JSON.stringify(it.result.rows), patients: it.result.census.patients.size, verdict: document.querySelector('#verdict').textContent, names: it.result.registry.toMappingRows().map((r) => r.RealName) }; });
  assert(wordOut.patients === 2, 'Bell and Hill should be two patients, got ' + wordOut.patients + ' ' + JSON.stringify(wordOut.names));
  for (const leak of ['Bell', 'Hill', 'Kevin', 'Rose', '032767781', '84445786', '32767781']) assert(!wordOut.rows.includes(leak), `pasted common-word surname leaked: ${leak} in ${wordOut.rows}`);
  assert(wordOut.names.some((n) => /Bell, Kevin/.test(n)) && wordOut.names.some((n) => /Hill, Rose/.test(n)) && !wordOut.names.some((n) => /Bruno/.test(n)), 'registry names: ' + JSON.stringify(wordOut.names));
  assert(/Checked:/.test(wordOut.verdict), 'word-surname note verdict: ' + wordOut.verdict.slice(0, 120));
  // 4c-iii. an MRN-only line (no legible name) cannot get a green verdict
  await page.click('#pasteOpen'); await page.fill('#pasteText', 'MRN 55512345  labs ok, tolerating well.'); await page.click('#pasteRun');
  await page.waitForFunction(() => /5 sources/.test(document.querySelector('#session').textContent)); await doneIn();
  assert(/Stop:[\s\S]*could not be read/.test(await page.textContent('#verdict')), 'unnamed patient must not get a green verdict: ' + (await page.textContent('#verdict')).slice(0, 160));
  assert(await page.isDisabled('#dlXlsx'), 'download must be off while a patient name is unread');
  await page.evaluate(() => { const s = window.__deid.session; const it = s.items[s.items.length - 1]; s.items.splice(s.items.indexOf(it), 1); s.items.splice(s.items.length - 1, 1); window.__deid.state.current = s.items[s.items.length - 1]; });
  await page.evaluate(() => { const it = window.__deid.state.current; window.__deid.runDeid(it, true); }); await doneIn();
  assert(/Found \d+ patients? on \d+ lines/.test(await page.textContent('#colSummary')), 'text column summary');
  assert(/Found 1 patient on/.test(await page.textContent('#colSummary')), 'text column summary must count unique patients: ' + (await page.textContent('#colSummary')));
  // nothing from the pasted census line survives in the protected rows
  const textLeak = await page.evaluate((p) => { const it = window.__deid.state.current; const out = JSON.stringify(it.result.rows).toLowerCase(); return [p.last.toLowerCase(), p.first.toLowerCase(), p.mrn].filter((x) => x.length >= 3 && out.includes(x)); }, { last: p0.last, first: p0.first, mrn: p0.mrn });
  assert(!textLeak.length, 'pasted text leaked: ' + textLeak);
  assert(await page.$('#dlTxt:not(.hidden)'), 'dlTxt must be visible for text items');
  const textPath = await dl('#dlXlsx');
  assert(/_3\.xlsx$/.test(textPath), 'text item filename: ' + path.basename(textPath));
  const textAoa = aoaOf(readWb(textPath));
  assert(JSON.stringify(textAoa[0]) === JSON.stringify(['Patient Name', 'MRN', 'DOB', 'Line', 'Age (derived)', 'DeID Audit']), 'text item headers: ' + textAoa[0]);
  const txtPath = await dl('#dlTxt'); assert(fs.readFileSync(txtPath, 'utf8').split('\n').length >= 6, 'txt download');
  const mapPath2 = await dl('#dlMap');

  // 4d. plain build: an image is refused with a pointer to the OCR build, and adds no source
  await page.setInputFiles('#file', tinyPng);
  await page.waitForFunction(() => /infusion-deid-ocr\.html/.test(document.querySelector('#inputNotice').textContent));
  assert(/3 sources/.test(await sessionText()), 'image must not add a source on the plain build');

  // 4e. columns gate
  await page.setInputFiles('#file', gateInput);
  await page.waitForFunction(() => /4 sources/.test(document.querySelector('#session').textContent));
  await doneIn();
  assert(await page.$('#colsCard.gate'), 'gate not raised');
  assert(await page.$eval('#colsDetails', (d) => d.open), 'colsDetails should open on a warning');
  assert(/Contact/.test(await page.textContent('#colWarnings')), 'warning should name the kept column');
  assert(await page.isDisabled('#dlXlsx') && (await page.getAttribute('#dlXlsx', 'title')) === 'Confirm columns first', 'gate must disable downloads');
  await page.click('#colsConfirm');
  assert(!(await page.isDisabled('#dlXlsx')), 'confirm should enable downloads');
  // dates option: both the strip and the verdict follow it
  await openAdvanced();
  await page.selectOption('#optDates', 'remove'); await doneIn();
  assert(/Dates: removed \(Safe Harbor\)/.test(await sessionText()) && /Dates: removed \(Safe Harbor\)/.test(await page.textContent('#verdict')), 'dates removed label');
  await page.selectOption('#optDates', 'shift'); await doneIn();
  // localStorage holds layouts, word lists and settings only
  const ls = await page.evaluate(() => Object.entries(localStorage));
  assert(ls.every(([k]) => k.startsWith('deid:cfg:') || ['deid:deny', 'deid:allow', 'deid:opts'].includes(k)), 'unexpected localStorage keys: ' + ls.map(([k]) => k));
  const lsText = ls.map(([, v]) => v).join(' ').toLowerCase();
  for (const p of synth.patients) assert(!lsText.includes(p.last.toLowerCase()) && !lsText.includes(p.mrn), 'patient data in localStorage');

  // 4f. new session is an inline two-step (no dialog) even when the key is saved; then continue from the saved key
  const mapPathSaved = await dl('#dlMap'); void mapPathSaved;
  assert(/key saved/.test(await sessionText()), 'key should count as saved');
  await page.click('#newSession');
  await page.waitForSelector('#newSessionConfirm:not(.hidden)');
  assert(/Start over\?[\s\S]*key is saved/.test(await page.textContent('#newSessionConfirm')), 'new session confirm copy (key saved): ' + (await page.textContent('#newSessionConfirm')));
  await page.click('#newSessionYes');
  assert(/0 patients/.test(await sessionText()) || (await page.$eval('#session', (e) => e.classList.contains('hidden'))), 'session not reset');
  assert(await page.$eval('#exportCard', (e) => e.classList.contains('hidden')), 'export card should hide on new session');
  assert(!(await page.$eval('#drop', (e) => e.classList.contains('compact'))), 'drop zone should be full size again');
  // 4g. patients first seen while dates were removed must get a real offset once shifting is turned back on
  await openAdvanced();
  await page.selectOption('#optDates', 'remove');
  await page.setInputFiles('#file', input);
  await page.waitForFunction(() => /1 sources/.test(document.querySelector('#session').textContent));
  await doneIn();
  assert(await page.evaluate(() => window.__deid.session.registry.entities.every((e) => e.offset === 0)), 'offsets should be 0 under remove');
  await page.selectOption('#optDates', 'shift'); await doneIn();
  assert(await page.evaluate(() => window.__deid.session.registry.entities.every((e) => e.offset !== 0 && e.offset != null)), 'offsets must be re-drawn when shifting is turned on');
  assert(/Checked:/.test(await page.textContent('#verdict')), 'verdict after re-shift');
  const reshiftAoa = aoaOf(readWb(await dl('#dlXlsx')));
  const apptIdx = synth.headers.indexOf('Appt Date');
  for (let i = 0; i < synth.rows.length; i++) { const a = reshiftAoa[i + 1][apptIdx]; assert(a instanceof Date && Math.abs(a.getTime() - synth.rows[i][apptIdx].getTime()) >= 29 * 86400000, `appointment date not shifted on row ${i + 1}`); }
  await page.click('#newSession'); await page.waitForSelector('#newSessionConfirm:not(.hidden)'); await page.click('#newSessionYes');
  await page.setInputFiles('#file', mapPath2);
  await page.waitForFunction(() => /Session restored: \d+ patients/.test(document.querySelector('#inputNotice').textContent));
  await page.setInputFiles('#file', input);
  await page.waitForFunction(() => /1 sources/.test(document.querySelector('#session').textContent));
  await doneIn();
  const mapPath3 = await dl('#dlMap');
  assert(/_3\.xlsx$/.test(path.basename(mapPath3)), 'key counter must continue from the restored key (expected _3): ' + path.basename(mapPath3));
  const codesOf = (p) => new Map(XLSX.utils.sheet_to_json(readWb(p).Sheets.Patients, { defval: '' }).filter((r) => r.Code).map((r) => [String(r.MRN).split(';')[0].replace(/^0+/, ''), r.Code]));
  const c2 = codesOf(mapPath2), c3 = codesOf(mapPath3);
  for (const [mrn, code] of c2) assert(c3.get(mrn) === code, `code changed after restore for MRN ${mrn}: ${code} → ${c3.get(mrn)}`);

  // 5. check accuracy tab
  await page.click('nav button[data-tab="validate"]');
  await page.fill('#synN', '200');
  await page.click('#synRun');
  await page.waitForFunction(() => /token recall/.test(document.querySelector('#synOut').textContent));
  const synOut = await page.textContent('#synOut');
  const m = synOut.match(/(\d+\.\d)%token recall/);
  assert(m && parseFloat(m[1]) >= 99, 'synthetic recall too low: ' + (m && m[1]));
  await page.click('#synAdv'); await page.waitForSelector('#advCard:not(.hidden)');
  const adv = await page.textContent('#advOut'); assert(/19 of 20 pass/.test(adv), 'adversarial: ' + adv.slice(0, 60));
  await page.click('#synAbl'); await page.waitForFunction(() => /Tier 0 rules only/.test(document.querySelector('#ablOut').textContent));

  // 6. restore identities round trip on the spreadsheet item
  await page.click('nav button[data-tab="reid"]');
  await page.setInputFiles('#reidFile', deidPath);
  await page.setInputFiles('#reidMap', mapPath2);
  const [reidDl] = await Promise.all([page.waitForEvent('download'), page.click('#reidRun')]);
  const reidPath = path.join(tmp, reidDl.suggestedFilename()); await reidDl.saveAs(reidPath);
  assert(/^restored_\d{4}-\d{2}-\d{2}\.xlsx$/.test(path.basename(reidPath)), 'restored filename: ' + path.basename(reidPath));
  const reidAoa = aoaOf(readWb(reidPath), 'Re-identified');
  const mrnCol = synth.headers.indexOf('MRN'), dateCol = synth.headers.indexOf('Appt Date');
  const norm = (v) => String(v).replace(/^0+/, '');
  let okMrn = 0, okDate = 0;
  for (let i = 0; i < synth.rows.length; i++) {
    if (norm(reidAoa[i + 1][mrnCol]) === norm(synth.rows[i][mrnCol])) okMrn++;
    const a = reidAoa[i + 1][dateCol], b = synth.rows[i][dateCol];
    if (a instanceof Date && Math.abs(a.getTime() - b.getTime()) < 36e5) okDate++;
  }
  assert(okMrn === synth.rows.length, `re-identified MRNs ${okMrn}/${synth.rows.length}`);
  assert(okDate === synth.rows.length, `re-identified dates ${okDate}/${synth.rows.length}`);
  const nameCol = synth.headers.indexOf('Patient Name'), attCol = synth.headers.indexOf('Attending'), cmCol = synth.headers.indexOf('Comments');
  let okName = 0, okAtt = 0, badTokens = [];
  for (let i = 0; i < synth.rows.length; i++) {
    if (String(reidAoa[i + 1][nameCol]) === String(synth.rows[i][nameCol])) okName++;
    if (String(reidAoa[i + 1][attCol]) === String(synth.rows[i][attCol])) okAtt++;
    const origToks = new Set(String(synth.rows[i][cmCol]).match(/[A-Z][a-z]{2,}/g) || []), backToks = new Set(String(reidAoa[i + 1][cmCol]).match(/[A-Z][a-z]{2,}/g) || []);
    for (const t of origToks) if (!backToks.has(t) && (synth.patients.some((p) => p.first === t || p.last === t) || synth.providers.some((p) => p.last === t))) badTokens.push(`row ${i + 1}: ${t}`);
  }
  assert(okName === synth.rows.length, `re-identified patient names ${okName}/${synth.rows.length} (ALL-CAPS cells must restore too)`);
  assert(okAtt === synth.rows.length, `re-identified attending ${okAtt}/${synth.rows.length} (credential must not double)`);
  assert(!badTokens.length, 'patient/provider name tokens not restored in Comments: ' + badTokens.slice(0, 8).join('; '));
  const keyRows = XLSX.utils.sheet_to_json(readWb(mapPath2).Sheets.Patients, { defval: '' }).filter((r) => r.Code);
  const fakes = keyRows.map((r) => r.SurrogateName); assert(new Set(fakes).size === fakes.length, 'made-up names repeat in the key');
  const provRows = XLSX.utils.sheet_to_json(readWb(mapPath2).Sheets.Providers, { defval: '' }).filter((r) => r.SurrogateName);
  // one fake surname per real surname across patients and providers (a relative or a doctor who shares the patient's surname shares its fake)
  const fakeToReal = new Map();
  for (const r of [...keyRows, ...provRows]) { const fake = String(r.SurrogateName).split(',')[0].trim(), real = D.parseName(String(r.RealName).split(';')[0]); if (!real) continue; const rl = real.last.toLowerCase(); if (fakeToReal.has(fake)) assert(fakeToReal.get(fake) === rl, `made-up surname ${fake} stands for ${fakeToReal.get(fake)} and ${rl}`); fakeToReal.set(fake, rl); }
  // 6b. and on the pasted-text item
  await page.setInputFiles('#reidFile', textPath);
  await page.setInputFiles('#reidMap', mapPath2);
  const [reidDl2] = await Promise.all([page.waitForEvent('download'), page.click('#reidRun')]);
  const reidPath2 = path.join(tmp, 'restored-text.xlsx'); await reidDl2.saveAs(reidPath2);
  const reidText = aoaOf(readWb(reidPath2), 'Re-identified');
  const tm = reidText[0].indexOf('MRN');
  assert(reidText.length > 1 && reidText.slice(1).every((r) => norm(r[tm]) === norm(p0.mrn)), 'text item MRN not restored: ' + JSON.stringify(reidText.slice(0, 3)));

  await page.screenshot({ path: path.join(__dirname, '../docs/screenshot-deid.png'), fullPage: false }).catch(() => {});
  await ctx.close();

  // 6c. layout and contrast: a narrow window must stay usable, and the safety colours must be legible in both schemes
  const contrast = (fg, bg) => { const lum = (hex) => { const c = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }; const a = lum(fg), b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
  for (const scheme of ['light', 'dark']) {
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme });
    const mp = await mctx.newPage(); watch(mp);
    await mp.goto('file://' + dist);
    await mp.setInputFiles('#file', input);
    await mp.waitForFunction(() => /Done in/.test(document.querySelector('#runInfo').textContent));
    const vars = await mp.evaluate(() => { const cs = getComputedStyle(document.documentElement); const get = (n) => cs.getPropertyValue(n).trim(); return { ok: get('--ok'), warn: get('--warn'), bad: get('--bad'), okBg: get('--ok-bg'), badBg: get('--bad-bg'), warnBg: get('--warn-bg'), panel: get('--panel') }; });
    for (const [fg, bg, label] of [[vars.ok, vars.okBg, 'ok on ok-bg'], [vars.bad, vars.badBg, 'bad on bad-bg'], [vars.warn, vars.warnBg, 'warn on warn-bg'], [vars.ok, vars.panel, 'ok on panel'], [vars.bad, vars.panel, 'bad on panel'], [vars.warn, vars.panel, 'warn on panel']]) {
      const r = contrast(fg, bg); assert(r >= 4.5, `${scheme}: contrast ${label} = ${r.toFixed(2)} (${fg} on ${bg})`);
    }
    const layout = await mp.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, winW: window.innerWidth, strip: document.querySelector('#session').offsetHeight, padBottom: parseFloat(getComputedStyle(document.querySelector('main')).paddingBottom) }));
    assert(layout.scrollW <= layout.winW, `${scheme}: page overflows horizontally (${layout.scrollW} > ${layout.winW})`);
    assert(layout.strip < 844 * 0.25, `${scheme}: session strip covers ${layout.strip}px of an 844px screen`);
    assert(layout.padBottom >= layout.strip, `${scheme}: main padding-bottom ${layout.padBottom} < strip height ${layout.strip}`);
    // a review highlight can be tapped (the strip must not intercept the tap)
    await mp.selectOption('#reviewFilter', 'all');
    const mk = await mp.$('#reviewTable mark:not(.locked)'); assert(mk, `${scheme}: no highlight to tap`);
    await mk.scrollIntoViewIfNeeded(); await mk.click({ timeout: 5000 });
    await mp.waitForFunction(() => /Done in/.test(document.querySelector('#runInfo').textContent));
    assert(await mp.$('#reviewTable mark.removed'), `${scheme}: tap on a highlight did not register`);
    await mctx.close();
  }

  // 7. OCR build: two synthetic screenshots of the same patients → one registry, same codes
  let ocrSummary = 'skipped (no OCR build)';
  if (fs.existsSync(distOcr)) {
    const small = S.make({ n: 14, seed: 3 });
    const mrnIdx = small.headers.indexOf('MRN');
    const used = small.patients.filter((p) => small.rows.some((r) => norm(String(r[mrnIdx])) === norm(String(p.mrn))));
    const cols = ['Appt Date', 'Appt Time', 'Patient Name', 'MRN', 'DOB', 'Age', 'Regimen', 'Cycle/Day'].map((h) => small.headers.indexOf(h));
    const style = 'margin:0;background:#fff;font:14px "DejaVu Sans",Arial,sans-serif;color:#111';
    const tableHtml = `<html><body style="${style}"><div style="padding:8px;background:#e9eef4;font-weight:bold">Infusion Schedule - Chemo Suite</div><table style="border-collapse:collapse;margin:8px" cellpadding="5"><tr style="background:#dfe6ee">${cols.map((c) => `<th style="text-align:left;border:1px solid #bbb">${small.headers[c]}</th>`).join('')}</tr>${small.rows.map((r) => `<tr>${cols.map((c) => `<td style="border:1px solid #ddd">${fmtDate(r[c])}</td>`).join('')}</tr>`).join('')}</table></body></html>`;
    const orderHtml = `<html><body style="${style}"><div style="padding:8px;background:#e9eef4;font-weight:bold">Order Summary</div>${used.map((p) => `<div style="margin:10px 12px;padding:8px;border:1px solid #ccc"><div style="font-weight:bold">${p.last}, ${p.first}&nbsp;&nbsp;&nbsp;MRN ${p.mrn}&nbsp;&nbsp;&nbsp;DOB ${fmtDate(p.dob)}</div><div>Order: ${p.regimen}, cycle as planned</div><div>Premeds given; hold for fever over 100.4</div></div>`).join('')}</body></html>`;
    const octx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const shot = async (html, name) => { const pg = await octx.newPage({ viewport: { width: 1000, height: 600 } }); await pg.setContent(html); const file = path.join(tmp, name); await pg.screenshot({ path: file, fullPage: true }); await pg.close(); return file; };
    const shot1 = await shot(tableHtml, 'shot-schedule.png'), shot2 = await shot(orderHtml, 'shot-orders.png');
    const opage = await octx.newPage(); watch(opage);
    await opage.goto('file://' + distOcr);
    assert((await opage.getAttribute('html', 'data-ocr')) === 'yes', 'OCR build flag');
    await opage.setInputFiles('#file', [shot1, shot2]);
    await opage.waitForFunction(() => /Starting text recognition|Reading the screenshot/.test(document.querySelector('#stage').textContent), null, { timeout: 60000 });
    await opage.waitForFunction(() => /2 sources/.test(document.querySelector('#session').textContent) && document.querySelector('#working').classList.contains('hidden') && /Done in/.test(document.querySelector('#runInfo').textContent) && window.__deid.session.items.every((it) => it.result), null, { timeout: 180000 });
    assert(await opage.$('#ocrCard:not(.hidden)'), 'ocrCard hidden');
    assert((await opage.$eval('#ocrText', (e) => e.value.trim().length)) > 20, 'ocrText empty');
    assert(await opage.$('#ocrRerun'), 'ocrRerun missing');
    const ov = await opage.textContent('#verdict');
    assert(/Checked:[\s\S]*from the text we could read/.test(ov), 'OCR verdict: ' + ov.slice(0, 200));
    // no rendered patient name or MRN survives in any OCR item's protected rows
    const ocrLeaks = await opage.evaluate((pats) => { const out = window.__deid.session.items.map((it) => JSON.stringify(it.result.rows)).join(' ').toLowerCase(); return pats.filter((p) => out.includes(`${p.last}, ${p.first}`.toLowerCase()) || out.includes(p.mrn)).map((p) => p.last); }, used.map((p) => ({ last: p.last, first: p.first, mrn: String(p.mrn) })));
    assert(!ocrLeaks.length, 'OCR items leaked: ' + ocrLeaks.join(', '));
    const reg = await opage.evaluate(() => {
      const s = window.__deid.session; const rows = s.registry.toMappingRows();
      const items = s.items.map((it) => ({ name: it.name, pairs: it.table.rows.map((r, i) => [String(r[1] || ''), String(it.result.rows[i][1] || '')]).filter((p) => p[0]) }));
      return { rows, items, size: s.registry.size };
    });
    const keys = reg.rows.map((r) => D.mrnKeyOf(String(r.MRN).split(';')[0]));
    assert(new Set(keys).size === keys.length, 'duplicate patients in the registry: ' + JSON.stringify(reg.rows.map((r) => [r.Code, r.MRN, r.RealName])));
    assert(reg.size === used.length, `registry has ${reg.size} patients, expected ${used.length}: ` + JSON.stringify(reg.rows.map((r) => [r.Code, r.MRN, r.RealName])));
    const codeByMrn = new Map();
    for (const it of reg.items) for (const [mrn, code] of it.pairs) { const k = D.mrnKeyOf(mrn); if (!k) continue; const prev = codeByMrn.get(k); assert(!prev || prev === code, `MRN ${mrn} mapped to ${prev} and ${code} across screenshots`); codeByMrn.set(k, code); }
    for (const p of used) assert(codeByMrn.has(D.mrnKeyOf(String(p.mrn))), `patient ${p.mrn} missing from the OCR outputs`);
    const ocrText = await opage.$eval('#ocrText', (e) => e.value);
    await opage.fill('#ocrText', ocrText + '\nAdded by the reviewer: no change to patients.');
    await opage.click('#ocrRerun'); await opage.waitForFunction(() => /Done in/.test(document.querySelector('#runInfo').textContent));
    assert(/corrected/.test(await opage.textContent('#ocrNote')), 'ocr note after correction');
    ocrSummary = `patients ${reg.size}, codes consistent across ${reg.items.length} screenshots`;
    await octx.close();
  }

  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  if (errors.length) throw new Error('browser errors:\n' + errors.join('\n'));
  console.log('e2e OK:', { rows: synth.rows.length, deid: path.basename(deidPath), key: path.basename(mapPath), reidentifiedMrns: okMrn, reidentifiedDates: okDate, ocr: ocrSummary });
})().catch((e) => { console.error('e2e FAILED:', e.message); process.exit(1); });
