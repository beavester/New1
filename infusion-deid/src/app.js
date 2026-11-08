/* Infusion De-ID — browser UI. Depends on XLSX (SheetJS), DeID, DeIDSynth, DeIDEval, DeIDOCR.
 * Flow: drop → (auto-run) → glance at the verdict and flagged lines → download.
 * One patient registry per page session links the same person across every input. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (x, d) => (x == null ? '–' : (x * 100).toFixed(d == null ? 1 : d) + '%');
  const fmtDate = (v) => (v instanceof Date ? `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}` : v);
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) {} };

  // Plain words for the screen. Option values stay the core's role keys.
  const ROLE_UI = {
    patient_name: 'Patient name', mrn: 'MRN or record number', dob: 'Date of birth', account: 'Account or visit number', phone: 'Phone or fax',
    provider: 'Doctor or staff name', date: 'Appointment or other date', age: 'Age', zip: 'ZIP code', text: 'Free text (notes, comments)', keep: 'Keep unchanged', drop: 'Remove the whole column',
  };
  const ROLE_AS = { patient_name: 'names', mrn: 'record numbers', dob: 'birthdates', account: 'account numbers', phone: 'phone numbers', provider: 'staff names', date: 'dates', age: 'ages', zip: 'ZIP codes', text: 'free text' };
  const SOURCE_UI = (src) => {
    const s = String(src || '').split(/[:+]/)[0];
    if (s === 'manual') return 'Found by: you';
    if (s === 'census') return 'Found by: patient list';
    if (s === 'rule' || s === 'rules') return 'Found by: a pattern';
    if (s === 'lexicon' || s === 'cue') return 'Found by: a word clue (less certain)';
    if (s === 'propagate') return 'Found by: seen elsewhere in this file';
    return 'Found by: ' + (s || 'the tool');
  };
  const TYPE_UI = { NAME_PATIENT: 'patient name', NAME_PROVIDER: 'staff name', NAME_OTHER: 'name', MRN: 'MRN', ACCOUNT: 'account number', PHONE: 'phone number', DOB: 'birthdate', DATE: 'date', EMAIL: 'email', ORG: 'organization', LOCATION: 'place', ADDRESS: 'address', ZIP: 'ZIP', AGE: 'age', SSN: 'SSN', ID_OTHER: 'other ID', URL: 'web address', IP: 'network address' };
  const GROUP_OF = (t) => (/^NAME/.test(t) ? 'Names' : /^(DATE|DOB)$/.test(t) ? 'Dates' : /^(MRN|ACCOUNT|ID_OTHER|SSN|URL|IP)$/.test(t) ? 'Record numbers' : /^(PHONE|EMAIL)$/.test(t) ? 'Phone numbers or emails' : /^(LOCATION|ADDRESS|ZIP)$/.test(t) ? 'Places' : t === 'ORG' ? 'Organizations' : t === 'AGE' ? 'Ages 90+' : 'Other');
  // A line needs a look when a highlight rests on a word clue alone: low confidence, or a cue-found name whose tokens are
  // outside the name lists. Census, rule, lexicon and propagated hits are certain enough to leave to the summary count.
  const LEXN = (typeof DeIDLexicon !== 'undefined') ? DeIDLexicon : null;
  const isUncertain = (sp) => {
    const src = String(sp.source || '').split('+')[0];
    if (sp.manual || src === 'census' || src === 'rule' || src === 'propagate' || src === 'custom') return false;
    if (sp.conf != null && sp.conf <= 0.6) return true;
    if (/^cue:(relation|honorific|credential|verb|last-first|census-line|alias)/.test(src) && LEXN) {
      const toks = String(sp.text || '').split(/[^A-Za-z'’\-]+/).filter((t) => t.length >= 2 && !/^[A-Z]\.?$/.test(t));
      if (toks.some((t) => !LEXN.isFirstName(t) && !LEXN.isSurname(t) && !LEXN.CREDENTIAL_SET.has(t.toLowerCase()))) return true;
    }
    return false;
  };
  const PLAIN_BUILD_MSG = 'This copy cannot read screenshots. Open infusion-deid-ocr.html instead (the larger file). Tables and pasted text still work here.';
  const NO_SIMD_MSG = 'This browser cannot run the screenshot reader. Use Edge or Chrome 91 or newer. Tables and pasted text still work.';
  const TEXT_HEADERS = ['Patient Name', 'MRN', 'DOB', 'Line'];

  // ------------------------------------------------------------ state
  const session = { registry: DeID.createRegistry(), items: [], seed: 12345, mrnPattern: null, keyStamp: null, keySaves: 0, startedAt: new Date().toISOString() };
  const hhmm = () => { const d = new Date(); return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`; };
  // the key counts as saved only while it covers every patient and source in the session
  const keyStamp = () => `${session.registry.size}|${session.items.length}`;
  Object.defineProperty(session, 'keySaved', { get: () => session.keyStamp === keyStamp() });
  const state = { session, current: null, page: 1, synth: null, synthResult: null, reidPreload: null, cancel: false, queue: 0 };
  Object.defineProperty(state, 'items', { get: () => session.items });
  const hasOcr = () => document.documentElement.dataset.ocr === 'yes' && typeof DeIDOCR !== 'undefined' && DeIDOCR.available();

  // ------------------------------------------------------------ tabs
  const showTab = (name) => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    document.querySelectorAll('section.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  };
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('verInfo').textContent = `Infusion De-ID ${DeID.VERSION} · built ${document.documentElement.dataset.built || 'from source'}${hasOcr() ? ' · screenshot reader included' : ''}`;
  $('verFoot').textContent = `v${DeID.VERSION}`;
  if (!hasOcr()) { $('chipShot').classList.add('off'); $('chipShot').title = 'Needs infusion-deid-ocr.html'; }

  // ------------------------------------------------------------ small UI helpers
  const notice = (html, cls) => { const n = $('inputNotice'); n.innerHTML = html ? `<div class="note ${cls || ''}" style="margin-top:8px">${html}</div>` : ''; };
  const stage = (text) => { $('stage').textContent = text; };
  const showWorking = (name) => { $('working').classList.remove('hidden'); $('workingName').textContent = name || ''; $('workProg').firstElementChild.style.width = '10%'; };
  const hideWorking = () => { $('working').classList.add('hidden'); $('thumb').classList.add('hidden'); $('cancelRun').classList.add('hidden'); stage(''); };
  const layoutStrip = () => {
    const s = $('session'); const h = s.classList.contains('hidden') ? 0 : s.offsetHeight;
    document.documentElement.style.setProperty('--strip-h', `${Math.max(60, h + 24)}px`);
  };
  window.addEventListener('resize', layoutStrip);

  // ------------------------------------------------------------ file reading
  function readWorkbook(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => { try { resolve(XLSX.read(new Uint8Array(r.result), { type: 'array', cellDates: true, raw: false })); } catch (e) { reject(e); } };
      r.readAsArrayBuffer(file);
    });
  }
  function readText(file) { return new Promise((resolve, reject) => { const r = new FileReader(); r.onerror = () => reject(r.error); r.onload = () => resolve(String(r.result || '')); r.readAsText(file); }); }
  function sheetToAoa(ws) { return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false }); }
  function detectHeaderRow(aoa) {
    let best = 0, bestScore = -1;
    for (let i = 0; i < Math.min(15, aoa.length); i++) {
      const row = aoa[i] || [];
      const strs = row.filter((v) => typeof v === 'string' && v.trim() && !/^\d+(\.\d+)?$/.test(v.trim())).length;
      const filled = row.filter((v) => v != null && v !== '').length;
      const score = strs * 2 + filled - (row.filter((v) => v instanceof Date).length * 3);
      if (score > bestScore && filled >= 2) { bestScore = score; best = i; }
    }
    return best;
  }

  // ------------------------------------------------------------ items
  function newItem(kind, name) {
    const it = { id: `i${Date.now()}_${Math.floor(Math.random() * 1e6)}`, n: session.items.length + 1, kind, name, sizeKB: 0, sheet: null, headerRow: 0, aoa: null, wb: null, table: null, columns: null, ocr: null, result: null, manual: {}, confirmedColumns: false, viewedReview: false, firstRun: true, leak: null, flagged: 0, savedLayout: false, linkedBy: {}, noteKey: null, learn: null, rawText: null };
    session.items.push(it);
    return it;
  }
  function dropItem(it) { const i = session.items.indexOf(it); if (i >= 0) session.items.splice(i, 1); session.items.forEach((x, k) => { x.n = k + 1; }); if (state.current === it) state.current = session.items[session.items.length - 1] || null; }

  // ------------------------------------------------------------ input routing (no mode picker)
  async function addInputs(list) {
    const files = Array.from(list || []);
    state.cancel = false; state.queueActive = true;
    const images = files.filter(isImage);
    let imgIdx = 0;
    for (const f of files) {
      if (state.cancel) break;
      if (isImage(f)) { imgIdx++; await addInput(f, imgIdx, images.length); } else await addInput(f);
    }
    state.queueActive = false;
    hideWorking();
  }
  function isImage(f) { return !!f && (String(f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(f.name || '')); }
  async function addInput(src, imgIdx, imgTotal) {
    try {
      if (typeof src === 'string') { addTextItem(src, 'pasted text', 'text'); return; }
      const file = src; const name = file.name || 'file';
      if (isImage(file)) { await runOcrItem(file, imgIdx || 1, imgTotal || 1); return; }
      if (/\.txt$/i.test(name) || file.type === 'text/plain') { const text = await readText(file); routeText(text, name); return; }
      showWorking(name); stage(`Reading ${name}…`);
      const wb = await readWorkbook(file);
      const names = wb.SheetNames;
      if (['Patients', 'Providers', 'Others', 'Meta'].every((n) => names.includes(n))) { hideWorking(); restoreSession(wb); return; }
      const aoa0 = sheetToAoa(wb.Sheets[names[0]]); const hr = detectHeaderRow(aoa0);
      if ((aoa0[hr] || []).some((v) => String(v).trim() === 'DeID Audit')) {
        hideWorking(); state.reidPreload = file;
        notice(`This file is already protected. Restore identities instead? <span class="lnk" id="openReid">Open Restore identities</span>`, 'warn');
        $('openReid').addEventListener('click', () => { showTab('reid'); $('reidOut').innerHTML = `<span class="muted">Using ${esc(name)} as the protected workbook. Add the session key and press Restore.</span>`; });
        return;
      }
      const item = newItem('table', name); item.wb = wb; item.sizeKB = Math.round((file.size || 0) / 1024);
      selectSheet(item, names[0]);
    } catch (e) { console.error(e); hideWorking(); notice(`Could not read this file: ${esc(e.message)}`, 'danger'); }
  }
  function routeText(text, name) {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    const tabbed = lines.filter((l) => l.includes('\t')).length;
    if (lines.length >= 2 && tabbed / lines.length >= 0.6) {
      const cells = lines.map((l) => l.split('\t').map((c) => c.trim()));
      const headers = cells[0].map((h, i) => h || `Column ${i + 1}`);
      const rows = cells.slice(1).map((r) => headers.map((_, i) => (r[i] == null || r[i] === '' ? null : r[i])));
      const item = newItem('table', name); item.rawText = text; item.aoa = [headers, ...rows]; item.headerRow = 0; item.sheet = null;
      buildTable(item);
      notice(`Treated as a table — <span class="lnk" id="asText">treat as text instead</span>`);
      $('asText').addEventListener('click', () => { notice(''); item.kind = 'text'; item.wb = null; item.aoa = null; buildTextItem(item, text); });
      return;
    }
    addTextItem(text, name, 'text');
  }
  function addTextItem(text, name, kind) { const item = newItem(kind || 'text', name); item.rawText = text; buildTextItem(item, text); return item; }
  function buildTextItem(item, text) {
    const doc = DeID.parseTextDocument(text, { mrnPattern: session.mrnPattern });
    item.table = { headers: doc.headers, rows: doc.rows }; item.columns = doc.columns; item.docStats = doc.stats; item.savedLayout = false;
    item.result = null; item.manual = {}; item.firstRun = true;
    showItem(item);
    runDeid(item, true);
  }

  // Ctrl+V anywhere on the page
  document.addEventListener('paste', (e) => {
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
    const imgs = items.filter((it) => it.type && it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
    if (imgs.length) { e.preventDefault(); showTab('deid'); addInputs(imgs.map((f, i) => Object.assign(f, { name: f.name || `pasted-image-${i + 1}.png` }))); return; }
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
    if (text && text.trim()) { e.preventDefault(); showTab('deid'); addInput(text); }
  });
  $('pasteOpen').addEventListener('click', () => { $('pasteBox').classList.toggle('hidden'); if (!$('pasteBox').classList.contains('hidden')) $('pasteText').focus(); });
  $('pasteRun').addEventListener('click', () => { const t = $('pasteText').value; if (!t.trim()) { notice('Paste some text first.', 'warn'); return; } routeText(t, 'pasted text'); $('pasteText').value = ''; $('pasteBox').classList.add('hidden'); });

  // drag/drop + choose
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => addInputs(e.dataTransfer.files));
  $('file').addEventListener('change', (e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; addInputs(fs); });
  $('chooseBtn').addEventListener('click', () => $('file').click());
  $('cancelRun').addEventListener('click', () => { state.cancel = true; stage('Stopping after this screenshot…'); });
  $('loadDemo').addEventListener('click', () => {
    const synth = DeIDSynth.make({ n: 120, seed: Date.now() % 100000 });
    const ws = XLSX.utils.aoa_to_sheet([synth.headers, ...synth.rows], { cellDates: true });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Infusion Schedule');
    const item = newItem('table', 'made-up-example.xlsx'); item.wb = wb;
    notice('Made-up example: 120 rows generated in this tab. Names, MRNs and comments are invented.');
    selectSheet(item, 'Infusion Schedule', 0);
  });

  // ------------------------------------------------------------ table items
  function selectSheet(item, name, headerRow) {
    item.sheet = name;
    item.aoa = sheetToAoa(item.wb.Sheets[name]);
    item.headerRow = headerRow == null ? detectHeaderRow(item.aoa) : headerRow;
    buildTable(item);
  }
  function buildTable(item) {
    const aoa = item.aoa;
    const headers = (aoa[item.headerRow] || []).map((h, i) => (h == null || h === '' ? `Column ${i + 1}` : String(h)));
    const rows = aoa.slice(item.headerRow + 1).filter((r) => r && r.some((v) => v != null && v !== '')).map((r) => headers.map((_, i) => (r[i] == null ? null : r[i])));
    item.table = { headers, rows };
    item.columns = DeID.classifyColumns(headers, rows);
    const saved = loadSavedConfig(headers);
    item.savedLayout = !!saved;
    if (saved) saved.roles.forEach((role, i) => { if (item.columns[i]) { item.columns[i].role = role; item.columns[i].reason = 'saved'; } });
    item.result = null; item.manual = {}; item.firstRun = true; item.confirmedColumns = false;
    showItem(item);
    runDeid(item, true);
  }
  function cfgKey(headers) { return 'deid:cfg:' + DeID.hashString(headers.join('|').toLowerCase()); }
  function loadSavedConfig(headers) { try { const j = lsGet(cfgKey(headers)); return j ? JSON.parse(j) : null; } catch (e) { return null; } }
  function saveLayout(item) { if (!item || item.kind !== 'table') return; lsSet(cfgKey(item.table.headers), JSON.stringify({ roles: item.columns.map((c) => c.role), saved: new Date().toISOString() })); item.savedLayout = true; }
  $('saveCfg').addEventListener('click', () => { if (state.current) { saveLayout(state.current); renderColumns(state.current); } });
  $('forgetCfg').addEventListener('click', () => { const it = state.current; if (!it || it.kind !== 'table') return; lsDel(cfgKey(it.table.headers)); it.savedLayout = false; it.columns = DeID.classifyColumns(it.table.headers, it.table.rows); it.confirmedColumns = false; runDeid(it, true); });
  $('sheetSel').addEventListener('change', (e) => { const it = state.current; if (it && it.wb) selectSheet(it, e.target.value); });
  $('headerSel').addEventListener('change', (e) => { const it = state.current; if (it && it.aoa) { item_setHeader(it, +e.target.value); } });
  function item_setHeader(it, hr) { it.headerRow = hr; buildTable(it); }

  // ------------------------------------------------------------ showing an item
  function showItem(item) {
    state.current = item;
    $('drop').classList.add('compact');
    const multi = item.wb && item.wb.SheetNames.length > 1;
    if (item.kind === 'table' && (multi || item.headerRow > 0)) {
      $('sheetRow').classList.remove('hidden');
      $('sheetSel').innerHTML = (item.wb ? item.wb.SheetNames : ['(text)']).map((n) => `<option ${n === item.sheet ? 'selected' : ''}>${esc(n)}</option>`).join('');
      $('headerSel').innerHTML = (item.aoa || []).slice(0, Math.min(15, (item.aoa || []).length)).map((r, i) => `<option value="${i}" ${i === item.headerRow ? 'selected' : ''}>Row ${i + 1}: ${esc((r || []).filter((v) => v != null).slice(0, 4).map(fmtDate).join(' | ')).slice(0, 70)}</option>`).join('');
    } else $('sheetRow').classList.add('hidden');
    $('shapeInfo').textContent = `${item.table.rows.length} rows × ${item.table.headers.length} columns${item.headerRow > 0 ? ` · using row ${item.headerRow + 1} as the header` : ''}`;
    $('verdictActions').classList.add('hidden');
    $('fileInfo').textContent = `${item.kind === 'image' ? 'Screenshot' : item.kind === 'text' ? 'Text' : 'Spreadsheet'} ${item.n}: ${item.name}${item.sizeKB ? ` · ${item.sizeKB} KB` : ''} · ${item.table.rows.length} rows`;
    $('colsCard').classList.remove('hidden');
    renderColumns(item);
    renderOcrCard(item);
    if (item.result) { renderVerdict(item); renderSummary(item); renderReview(item); renderExport(item); }
    else { ['verdict', 'reviewCard', 'exportCard'].forEach((id) => $(id).classList.add('hidden')); }
    renderSession();
  }

  // ------------------------------------------------------------ columns card
  function renderColumns(item) {
    const cols = item.columns;
    if (item.kind === 'table') {
      const groups = {};
      cols.forEach((c) => { if (c.role !== 'keep' && c.role !== 'drop') (groups[c.role] = groups[c.role] || []).push(c.header); });
      const treated = Object.entries(groups).map(([role, hs]) => `${hs.map((h) => `<b>${esc(h)}</b>`).join(', ')} as ${ROLE_AS[role] || role}`).join(', ');
      const kept = cols.filter((c) => c.role === 'keep').map((c) => esc(c.header));
      const dropped = cols.filter((c) => c.role === 'drop').map((c) => esc(c.header));
      $('colSummary').innerHTML = `${treated ? 'Treated ' + treated : 'No identifier columns found'}${kept.length ? '; kept ' + kept.join(', ') : ''}${dropped.length ? '; removed ' + dropped.join(', ') : ''}.`;
      $('colsChange').classList.remove('hidden');
      $('cfgBadge').textContent = item.savedLayout ? 'Remembered layout' : 'Guessed from headers'; $('cfgBadge').className = item.savedLayout ? 'pill ok' : 'pill warn'; $('cfgBadge').classList.remove('hidden');
    } else {
      const s = item.docStats || { lines: item.table.rows.length, linesWithPatient: 0, linesInherited: 0 };
      const uniq = item.result ? item.result.census.patients.size : s.linesWithPatient;
      $('colSummary').innerHTML = `Found ${uniq} patient${uniq === 1 ? '' : 's'} on ${s.lines} lines (${s.linesWithPatient} line${s.linesWithPatient === 1 ? '' : 's'} named a patient; ${s.linesInherited} carried the patient from the line above).`;
      $('colsChange').classList.add('hidden'); $('cfgBadge').classList.add('hidden');
    }
    const t = $('colsTable');
    t.innerHTML = '<tr><th>Header</th><th>A few values</th><th>What it is</th></tr>' + cols.map((c, i) => `<tr><td><b>${esc(c.header)}</b></td><td class="muted small">${esc((c.sample || []).map((s) => s.length > 40 ? s.slice(0, 40) + '…' : s).join(' · '))}</td><td><select data-i="${i}" ${item.kind !== 'table' ? 'disabled' : ''}>${DeID.ROLES.map((r) => `<option value="${r}" ${r === c.role ? 'selected' : ''}>${esc(ROLE_UI[r] || r)}</option>`).join('')}</select></td></tr>`).join('');
    t.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => {
      item.columns[+s.dataset.i].role = s.value; item.columns[+s.dataset.i].reason = 'set by you';
      if ($('rememberLayout').checked) saveLayout(item);
      runDeid(item, true);
    }));
    $('forgetCfg').classList.toggle('hidden', !item.savedLayout);
    renderWarnings(item);
  }
  function colWarnings(item) {
    if (item.kind !== 'table') return [];
    const roles = item.columns.map((c) => c.role);
    const w = [];
    if (!roles.includes('mrn')) w.push('No MRN column found: patients will be keyed by name and date of birth.');
    if (!roles.includes('patient_name')) w.push('We could not find a column of patient names, so names inside notes may be missed. Pick the column that holds them.');
    item.columns.filter((c) => c.role === 'keep' && /name|address|contact|phone|email|guarantor|employer|insur/i.test(c.header)).forEach((c) => w.push(`"${c.header}" is kept unchanged but its header looks like an identifier. Is that right?`));
    item.columns.filter((c) => c.role === 'keep').forEach((c) => {
      const vals = item.table.rows.map((r) => DeID.cellToString(r[c.index])).filter(Boolean);
      if (vals.length < 3) return;
      const avg = vals.reduce((a, s) => a + s.length, 0) / vals.length;
      const uniq = new Set(vals.map((s) => s.toLowerCase())).size / vals.length;
      if (avg > 40 && uniq > 0.5) w.push(`"${c.header}" looks like free text but will be kept unchanged.`);
    });
    return w;
  }
  const isGated = (item) => !!item && item.kind === 'table' && !item.savedLayout && !item.confirmedColumns && colWarnings(item).length > 0;
  function renderWarnings(item) {
    const w = colWarnings(item);
    const gated = isGated(item);
    $('colWarnings').innerHTML = w.length ? w.map((x) => `<div class="warn">⚠ ${esc(x)}</div>`).join('') : '';
    $('colsCard').classList.toggle('gate', gated);
    $('colsHeading').textContent = gated ? 'Before you download, check these columns' : 'Columns';
    $('colsConfirm').classList.toggle('hidden', !gated);
    if (gated) $('colsDetails').open = true;
    setDownloadState();
  }
  $('colsChange').addEventListener('click', () => { $('colsDetails').open = !$('colsDetails').open; });
  $('colsConfirm').addEventListener('click', () => { const it = state.current; if (!it) return; it.confirmedColumns = true; if ($('rememberLayout').checked) saveLayout(it); renderColumns(it); renderSession(); });

  // ------------------------------------------------------------ config
  function collectConfig(item) {
    item = item || state.current;
    const [a, b] = ($('optRange').value || '30-365').split(/[-–,\s]+/).map((x) => parseInt(x, 10));
    const lines = (id) => $(id).value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const hasMrnCol = item && item.columns.some((c) => c.role === 'mrn' && item.table.rows.some((r) => r[c.index] != null && r[c.index] !== ''));
    return {
      columns: item ? item.columns.map((c) => ({ header: c.header, role: c.role })) : [],
      mrnPattern: $('optMrn').value.trim() || (hasMrnCol ? null : session.mrnPattern) || null,
      seed: session.seed,
      registry: session.registry,
      surrogate: { patients: $('optPatients').value, providers: $('optProviders').value, dob: $('optDob').value, ages: $('optAges').value, dateShift: $('optDates').value === 'shift', shiftRange: [isNaN(a) ? 30 : a, isNaN(b) ? 365 : b] },
      denylist: lines('optDeny'), allowlist: lines('optAllow'),
      auditColumn: true, auditDetail: false, deriveAge: $('optDerive').checked,
      manual: item ? item.manual : {},
    };
  }
  const datesLabel = () => ($('optDates').value === 'shift' ? 'Dates: shifted per patient, intervals kept' : 'Dates: removed (Safe Harbor)') + ({ drop: ' · Birthdates: removed, age kept', year: ' · Birthdates: year only', shift: ' · Birthdates: shifted' }[$('optDob').value] || '');

  // ------------------------------------------------------------ run
  const alphaKey = (x) => String(x || '').toLowerCase().replace(/[^a-z]/g, '').replace(/rn/g, 'm').replace(/vv/g, 'w').replace(/cl/g, 'd');
  function snapshotRegistry() {
    const m = new Map();
    session.registry.entities.forEach((e) => m.set(e.id, { mrnKeys: new Set([...e.mrns].map(DeID.mrnKeyOf)), lasts: new Set(e.parsed.map((p) => alphaKey(p.last))) }));
    return m;
  }
  function computeLinks(item, before) {
    const census = item.result.census; const out = {};
    for (const p of census.patients.values()) {
      const prev = before.get(p.entity.id);
      if (!prev) { out[p.entity.id] = 'new'; continue; }
      let how = 'similar name';
      for (const ri of p.rows) {
        const row = item.table.rows[ri];
        const mrn = census.mrnCols.map((c) => DeID.cellToString(row[c]).trim()).find(Boolean);
        if (mrn && prev.mrnKeys.has(DeID.mrnKeyOf(mrn))) { how = 'MRN'; break; }
        const nm = census.nameCols.map((c) => DeID.cellToString(row[c]).trim()).find(Boolean);
        const pn = nm ? DeID.parseName(nm) : null;
        if (pn && prev.lasts.has(alphaKey(pn.last))) how = 'name + DOB';
      }
      out[p.entity.id] = how;
    }
    return out;
  }
  function processItem(item) {
    const before = snapshotRegistry();
    const result = DeID.processTable(item.table, collectConfig(item));
    item.result = result;
    if (!session.mrnPattern && result.cfg.inferredMrnPattern) session.mrnPattern = result.cfg.inferredMrnPattern;
    item.linkedBy = computeLinks(item, before);
    if (item.ocr && !item.ocr.edited) {
      const conf = new Map(item.ocr.lines.map((l) => [l.text.replace(/\s+$/, ''), l.confidence]));
      const lineCol = item.table.headers.indexOf('Line');
      result.details.forEach((d, ri) => { const c = conf.get(DeID.cellToString(item.table.rows[ri][lineCol])); if (c != null && c < 70) d.lowOcr = true; });
    }
    item.leak = leakCheck(item);
    item.flagged = result.details.filter(isFlagged).length;
    $('optMrnLearned').textContent = session.mrnPattern ? `Learned from your file: ${session.mrnPattern.replace(/\\b/g, '').replace(/\\d\{(\d+),(\d+)\}/, (m, a, b) => a === b ? `${a} digits` : `${a} to ${b} digits`).replace(/\\d/g, 'digits')}` : '';
    return result;
  }
  const isFlagged = (d) => !!d.lowOcr || d.cells.some((c) => c.spans.some(isUncertain));
  const certainCount = (item) => item.result.details.reduce((n, d) => n + d.cells.reduce((m, c) => m + c.spans.filter((sp) => !isUncertain(sp)).length, 0), 0);
  function runDeid(item, resetPage) {
    if (typeof item === 'boolean' || item == null) { resetPage = item; item = state.current; }
    if (!item) return;
    state.current = item;
    const prog = $('prog'); prog.classList.remove('hidden'); prog.firstElementChild.style.width = '30%';
    $('verdict').classList.remove('hidden');
    $('run').disabled = true; $('runInfo').textContent = 'Working…';
    setTimeout(() => {
      try {
        const t0 = performance.now();
        processItem(item);
        const ms = performance.now() - t0;
        prog.firstElementChild.style.width = '100%';
        if (item.firstRun) { $('reviewFilter').value = item.flagged > 0 ? 'model' : 'all'; item.firstRun = false; }
        if (resetPage) state.page = 1;
        if (state.current === item) {
          renderColumns(item); renderVerdict(item); renderSummary(item); renderReview(item); renderExport(item);
          ['reviewCard', 'exportCard'].forEach((id) => $(id).classList.remove('hidden'));
          $('runInfo').textContent = `Done in ${(ms / 1000).toFixed(1)} s`;
        }
        renderSession();
        $('run').classList.add('hidden');
      } catch (e) { console.error(e); $('runInfo').innerHTML = `<span class="bad">Error: ${esc(e.message)}</span>`; $('run').classList.remove('hidden'); }
      finally { $('run').disabled = false; if (state.queueActive) $('runInfo').textContent = 'Reading…'; else hideWorking(); prog.firstElementChild.style.width = '100%'; setTimeout(() => { prog.classList.add('hidden'); prog.firstElementChild.style.width = '0%'; }, 400); }
    }, 30);
  }
  $('run').addEventListener('click', () => runDeid(state.current, true));
  function rerunAll() {
    session.items.forEach((it) => { if (it !== state.current && it.table) { try { processItem(it); } catch (e) { console.error(e); } } });
    if (state.current) runDeid(state.current, false); else renderSession();
  }

  // ------------------------------------------------------------ self-check (pure, in core.js): over-sensitive scan of the output
  function leakCheck(item) {
    const sc = DeID.selfCheck(item.result, { kind: item.kind });
    // a patient whose name was never read (pasted text or a screenshot with an MRN but no legible name): the check cannot
    // vouch for a name it never saw, so the verdict cannot be green
    sc.unnamed.forEach((u) => sc.hits.push({ row: u.row, col: -1, header: 'Patient name', text: `name not read for ${u.code || 'this patient'}`, type: 'NAME_PATIENT', kind: 'unnamed' }));
    return sc;
  }

  // ------------------------------------------------------------ verdict + summary
  const isRed = (item) => !!item && !!item.leak && item.leak.hits.length > 0;
  function setDownloadState() {
    const it = state.current; const override = $('optOverride').checked;
    const gated = isGated(it), red = isRed(it) && !override;
    const set = (id, dis, title) => { const b = $(id); b.disabled = !!dis; b.title = dis ? title : ''; };
    const perItem = gated ? 'Confirm columns first' : red ? 'Fix the identifiers that still appear first' : '';
    ['dlXlsx', 'dlCsv', 'dlTxt', 'dlNow'].forEach((id) => set(id, !it || !it.result || gated || red, perItem));
    $('verdictActions').classList.toggle('hidden', !it || !it.result || gated || isRed(it));
    const anyGated = session.items.some(isGated), anyRed = !override && session.items.some(isRed);
    set('dlAll', !session.items.some((x) => x.result) || anyGated || anyRed, anyGated ? 'Confirm columns first' : 'Fix the identifiers that still appear first');
  }
  function renderVerdict(item) {
    const L = item.leak; const n = L.patients;
    $('verdict').classList.remove('hidden');
    const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
    if (!L.hits.length) {
      $('verdictBody').innerHTML = `<div class="verdict ok"><b>Checked:</b> none of your ${plural(n, "patient's", "patients'")} names, nicknames, initials, MRNs, phone numbers, account numbers or birthdates appear in the output, in any spacing or spelling the page can predict.${item.kind === 'image' ? ' (from the text we could read)' : ''}${L.providerHits.length ? `<div class="small muted" style="margin-top:6px">${plural(L.providerHits.length, 'staff name still appears', 'staff names still appear')}; staff names are not patient identifiers but you may want to look.</div>` : ''}${L.coincidences.length ? `<div class="small muted" style="margin-top:6px">${plural(L.coincidences.length, 'shifted date', 'shifted dates')} in other patients' rows happen to equal a birthdate in the file (row ${L.coincidences.map((c) => c.row + 1).slice(0, 5).join(', ')}); nothing links them to that patient.</div>` : ''}</div>`;
      const gated = isGated(item);
      $('verdictActions').classList.toggle('hidden', gated);
      $('toReview').textContent = item.flagged > 0 ? `${plural(item.flagged, 'line needs', 'lines need')} a look first` : 'Nothing needs a look';
    } else {
      const unnamed = L.hits.filter((h) => h.kind === 'unnamed'), others = L.hits.filter((h) => h.kind !== 'unnamed');
      const list = L.hits.slice(0, 50).map((h, i) => h.kind === 'unnamed' ? `<li>Row ${h.row + 1}: the patient's name could not be read, only the record number. Check the line and add the name as patient info if it is there. <span class="lnk" data-show="${i}">Show</span></li>` : `<li>Row ${h.row + 1}, ${esc(h.header)}: "${esc(h.text)}" (${TYPE_UI[h.type] || h.type}) <span class="lnk" data-show="${i}">Show</span></li>`).join('');
      const head = others.length ? `${plural(others.length, 'patient identifier still appears', 'patient identifiers still appear')} in the output.` : '';
      const head2 = unnamed.length ? ` ${plural(unnamed.length, "patient's name", "patients' names")} could not be read, so the check cannot vouch for ${unnamed.length === 1 ? 'it' : 'them'}.` : '';
      $('verdictBody').innerHTML = `<div class="verdict bad"><b>Stop:</b> ${head}${head2} Fix this below before downloading.<ul>${list}</ul>${$('optOverride').checked ? '<div class="small warn" style="margin-top:6px">Compliance override is on: downloads are allowed and the run summary records it.</div>' : ''}</div>`;
      $('verdictActions').classList.add('hidden');
      $('verdictBody').querySelectorAll('[data-show]').forEach((a) => a.addEventListener('click', () => { const h = L.hits[+a.dataset.show]; $('reviewFilter').value = 'all'; $('reviewSearch').value = h.kind === 'unnamed' ? '' : h.text; state.page = 1; renderReview(item); const td = $('reviewTable').querySelector(`td[data-row="${h.row}"]`); if (td) td.scrollIntoView({ block: 'center' }); }));
    }
    $('datesLine').textContent = datesLabel();
    setDownloadState();
  }
  function renderSummary(item) {
    const r = item.result, s = r.stats;
    const groups = {}; Object.entries(s.byType).forEach(([t, v]) => { const g = GROUP_OF(t); groups[g] = (groups[g] || 0) + v; });
    const pills = Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([g, v]) => `<span class="pill">${esc(g)} ${v}</span>`).join('');
    const certain = certainCount(item);
    $('summary').innerHTML = `<div class="small">${s.rows} rows · ${r.census.patients.size} patient${r.census.patients.size === 1 ? '' : 's'} · ${s.spans} item${s.spans === 1 ? '' : 's'} replaced in text (${certain} certain) · ${item.flagged} line${item.flagged === 1 ? '' : 's'} need${item.flagged === 1 ? 's' : ''} a look</div>
      <details class="small" style="margin-top:4px"><summary>What was replaced</summary><div style="margin-top:6px">${pills || '<span class="muted">Nothing was found in the free text.</span>'}</div></details>`;
  }

  // ------------------------------------------------------------ review
  const PAGE = 40;
  function markHtml(sp, text, extraCls) {
    const coarse = DeID.COARSE(sp.type);
    const locked = !!sp.entity && /^(NAME_PATIENT|MRN|ACCOUNT|PHONE|DOB)$/.test(sp.type);
    const patientEnt = locked ? ' data-entity="1"' : '';
    const title = locked ? `${esc(TYPE_UI[sp.type] || sp.type)} from the patient list · this is the patient's own identifier and cannot be un-hidden` : `${esc(SOURCE_UI(sp.source))} · ${esc(TYPE_UI[sp.type] || sp.type)}`;
    return `<mark class="${coarse}${sp.manual ? ' manual' : ''}${locked ? ' locked' : ''}${extraCls || ''}" data-s="${sp.start}" data-e="${sp.end}" data-type="${esc(sp.type)}" data-src="${esc(sp.source)}"${patientEnt} title="${title}">${esc(text.slice(sp.start, sp.end))}</mark>`;
  }
  function highlight(item, cellInfo) {
    const text = cellInfo.original, spans = cellInfo.spans;
    const removed = (item.manual[`${cellInfo.row}:${cellInfo.col}`] || {}).remove || [];
    const marks = spans.map((sp) => ({ s: sp.start, e: sp.end, sp })).concat(removed.map((r) => ({ s: r[0], e: r[1], rem: r }))).sort((a, b) => a.s - b.s);
    let out = '', p = 0;
    for (const m of marks) {
      if (m.s < p) continue;
      out += esc(text.slice(p, m.s));
      if (m.rem) out += `<mark class="removed" data-s="${m.s}" data-e="${m.e}" data-rem="1" data-type="${esc(m.rem[2] || 'NAME_OTHER')}" data-src="${esc(m.rem[3] || 'manual')}" title="Found by: you (un-hidden) · click to hide again">${esc(text.slice(m.s, m.e))}</mark>`;
      else out += markHtml(m.sp, text);
      p = m.e;
    }
    out += esc(text.slice(p));
    return out;
  }
  function filteredDetails(item) {
    const f = $('reviewFilter').value, q = $('reviewSearch').value.trim().toLowerCase();
    return item.result.details.filter((d) => d.cells.length).filter((d) => {
      if (f === 'model') return isFlagged(d);
      if (f === 'certain') return !isFlagged(d) && d.cells.some((c) => c.spans.length);
      if (f === 'none') return d.cells.every((c) => !c.spans.length);
      if (f === 'manual') return d.cells.some((c) => item.manual[`${d.row}:${c.col}`]);
      return true;
    }).filter((d) => !q || d.cells.some((c) => c.original.toLowerCase().includes(q)));
  }
  function renderReview(item) {
    const list = filteredDetails(item);
    const shown = list.slice(0, state.page * PAGE);
    const certain = certainCount(item);
    $('reviewHeading').textContent = item.flagged > 0 ? `${item.flagged} line${item.flagged === 1 ? '' : 's'} need${item.flagged === 1 ? 's' : ''} a look: a name found from a word clue alone, or text the screenshot reader was unsure of. The other ${certain} replacements are certain.` : `Nothing needs a look. ${certain} replacement${certain === 1 ? '' : 's'} came from the patient list or a fixed rule. You can still browse every line.`;
    $('reviewInfo').textContent = `${shown.length} of ${list.length} lines shown`;
    $('morePages').style.display = shown.length < list.length ? '' : 'none';
    const t = $('reviewTable');
    const rows = [];
    shown.forEach((d) => d.cells.forEach((c, i) => {
      const key = `${d.row}:${c.col}`;
      const ent = d.patientCode ? item.result.registry.entities.find((e) => e.code === d.patientCode) : null;
      rows.push(`<tr>${i === 0 ? `<td rowspan="${d.cells.length}">${d.row + 1}${d.lowOcr ? '<br><span class="pill warn">Unclear in screenshot — check</span>' : ''}</td><td rowspan="${d.cells.length}">${esc(d.patientCode || '–')}${ent && ent.fakeLast ? `<br><span class="small muted">${esc(ent.fakeLast)}, ${esc(ent.fakeFirst)}</span>` : ''}</td>` : ''}<td class="muted">${esc(c.header)}</td><td class="cell" data-row="${d.row}" data-col="${c.col}">${highlight(item, Object.assign({ row: d.row }, c))}</td><td class="cell muted">${esc(c.output)}</td></tr>`);
      if (item.noteKey === key) rows.push(`<tr class="rownote"><td colspan="5" class="bad">This is the patient's own identifier. It cannot be un-hidden: the self-check would fail.</td></tr>`);
      if (item.learn && item.learn.key === key) rows.push(`<tr class="rownote"><td colspan="5"><label><input type="checkbox" id="learnBox"> Always treat "${esc(item.learn.text)}" this way on this computer</label></td></tr>`);
    }));
    t.innerHTML = '<tr><th>Row</th><th>Patient code · made-up name</th><th>Column</th><th style="width:42%">Before (highlighted)</th><th style="width:42%">After</th></tr>' + rows.join('');
    const lb = $('learnBox'); if (lb) lb.addEventListener('change', () => { if (lb.checked) learnWord(item.learn); });
  }
  function learnWord(learn) {
    if (!learn || !/^(ORG|LOCATION)$/.test(learn.type)) return; // never a patient identifier
    const id = learn.mode === 'deny' ? 'optDeny' : 'optAllow';
    const cur = $(id).value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (!cur.some((w) => w.toLowerCase() === learn.text.toLowerCase())) cur.push(learn.text);
    $(id).value = cur.join('\n'); lsSet(learn.mode === 'deny' ? 'deid:deny' : 'deid:allow', $(id).value);
    if (state.current) state.current.learn = null;
    rerunAll();
  }
  const markViewed = () => { if (state.current) state.current.viewedReview = true; };
  $('reviewFilter').addEventListener('change', () => { state.page = 1; markViewed(); if (state.current && state.current.result) renderReview(state.current); });
  $('reviewSearch').addEventListener('input', () => { state.page = 1; markViewed(); if (state.current && state.current.result) renderReview(state.current); });
  $('morePages').addEventListener('click', () => { state.page++; markViewed(); if (state.current) renderReview(state.current); });
  $('reviewTable').addEventListener('scroll', markViewed, true);
  $('reviewCard').addEventListener('scroll', markViewed, true);
  $('reviewTable').addEventListener('click', (e) => {
    markViewed();
    const item = state.current; if (!item || !item.result) return;
    const m = e.target.closest('mark'); if (!m) return;
    const cell = m.closest('.cell'); const key = `${cell.dataset.row}:${cell.dataset.col}`;
    if (m.dataset.entity && !m.dataset.rem) { item.noteKey = key; renderReview(item); return; } // the patient's own identifier stays hidden
    const s = +m.dataset.s, en = +m.dataset.e, type = m.dataset.type || 'NAME_OTHER';
    const man = item.manual[key] = item.manual[key] || { remove: [], add: [] };
    item.noteKey = null; item.learn = null;
    if (m.dataset.rem) { man.remove = man.remove.filter((r) => !(r[0] === s && r[1] === en)); }
    else if (m.classList.contains('manual')) man.add = man.add.filter((a) => !(a.start === s && a.end === en));
    else {
      man.remove.push([s, en, type, m.dataset.src || '']);
      if (m.dataset.entity) item.noteKey = key;
      if (/^(ORG|LOCATION)$/.test(type)) item.learn = { key, text: m.textContent, type, mode: 'allow' };
    }
    if (!man.remove.length && !man.add.length) delete item.manual[key];
    runDeid(item, false);
  });
  $('markSel').addEventListener('click', () => {
    const item = state.current; if (!item || !item.result) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { $('reviewInfo').textContent = 'Select text inside one "Before" cell first.'; return; }
    const range = sel.getRangeAt(0);
    const cell = range.startContainer.parentElement.closest('.cell[data-row]');
    if (!cell || !cell.contains(range.endContainer)) { $('reviewInfo').textContent = 'Select text inside one "Before" cell first.'; return; }
    const pre = document.createRange(); pre.selectNodeContents(cell); pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length, end = start + range.toString().length;
    const key = `${cell.dataset.row}:${cell.dataset.col}`;
    const man = item.manual[key] = item.manual[key] || { remove: [], add: [] };
    const text = item.result.details[+cell.dataset.row].cells.find((c) => c.col === +cell.dataset.col).original;
    let s = start, e = end; while (s < e && /\s/.test(text[s])) s++; while (e > s && /\s/.test(text[e - 1])) e--;
    const type = $('markType').value;
    if (e > s) { man.add.push({ start: s, end: e, type }); item.learn = /^(ORG|LOCATION)$/.test(type) ? { key, text: text.slice(s, e), type, mode: 'deny' } : null; item.noteKey = null; }
    sel.removeAllRanges(); markViewed(); runDeid(item, false);
  });

  // ------------------------------------------------------------ export
  const fileStamp = (item) => `protected_${today()}_${item.n}`;
  // The audit column names the layer counts only; the per-patient date offset belongs in the key, never in the output.
  const AUDIT_OFFSET = /\s*\|\s*shift:[+-]?\d+d\b/g;
  function aoaOut(item) {
    const r = item.result; const ai = r.headers.indexOf('DeID Audit');
    return [r.headers, ...r.rows.map((row) => { if (ai < 0) return row; const o = row.slice(); o[ai] = String(o[ai] == null ? '' : o[ai]).replace(AUDIT_OFFSET, ' | dates shifted'); return o; })];
  }
  function renderExport(item) {
    $('exportCard').classList.remove('hidden');
    $('dlTxt').classList.toggle('hidden', item.kind === 'table');
    $('dlNudge').textContent = '';
    $('dlNote').textContent = `Output file: ${fileStamp(item)}.xlsx. The original file name is not reused. The session key (PHI) is saved separately from the strip at the bottom.`;
    setDownloadState();
  }
  $('dlNow').addEventListener('click', () => $('dlXlsx').click());
  $('toReview').addEventListener('click', () => { $('reviewCard').scrollIntoView({ block: 'start', behavior: 'smooth' }); markViewed(); });
  $('dlXlsx').addEventListener('click', () => {
    const item = state.current; if (!item || !item.result) return;
    if (item.flagged > 0 && !item.viewedReview) $('dlNudge').textContent = `You have not looked at the ${item.flagged} line${item.flagged === 1 ? '' : 's'} flagged above. The file downloaded anyway.`;
    const ws = XLSX.utils.aoa_to_sheet(aoaOut(item), { cellDates: true });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Protected');
    XLSX.writeFile(wb, `${fileStamp(item)}.xlsx`, { cellDates: true });
  });
  $('dlCsv').addEventListener('click', () => {
    const item = state.current; if (!item || !item.result) return;
    const ws = XLSX.utils.aoa_to_sheet(aoaOut(item).map((r) => r.map(fmtDate)));
    download(new Blob([XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv' }), `${fileStamp(item)}.csv`);
  });
  $('dlTxt').addEventListener('click', () => {
    const item = state.current; if (!item || !item.result) return;
    const li = item.result.headers.indexOf('Line');
    const text = item.result.rows.map((r) => DeID.cellToString(r[li < 0 ? 0 : li])).join('\n');
    download(new Blob([text], { type: 'text/plain' }), `${fileStamp(item)}.txt`);
  });
  function reportLines(item) {
    const r = item.result, s = r.stats, L = item.leak;
    const kind = item.kind === 'image' ? 'screenshot' : item.kind === 'text' ? 'pasted text' : 'spreadsheet';
    const self = L.hits.length ? ($('optOverride').checked ? 'overridden' : `FAILED (${L.hits.length} identifiers)`) : 'passed';
    return [`Infusion De-ID run report · no patient data`, `Tool version: ${DeID.VERSION}`, `Run at: ${new Date().toISOString()}`,
      `Input ${item.n} of ${session.items.length}: ${kind}, ${s.rows} rows, ${r.headers.length} columns`,
      `Dates: ${$('optDates').value === 'shift' ? 'shifted per patient (intervals kept)' : 'removed (Safe Harbor)'}`,
      `Self-check: ${self}`, `Self-check overridden: ${L.hits.length && $('optOverride').checked ? 'yes' : 'no'}`,
      `Patients in this input: ${r.census.patients.size}; patients in the session: ${session.registry.size}; providers: ${r.census.providers.size}`, '',
      'Column roles:', ...r.columns.map((c) => `  ${c.header}: ${c.role}`), '',
      `MRN pattern: ${r.cfg.inferredMrnPattern || r.cfg.mrnPattern || 'none'}`, `Options: ${JSON.stringify(r.cfg.surrogate)}`,
      `Always-remove words: ${(r.cfg.denylist || []).length}; never-remove words: ${(r.cfg.allowlist || []).length}`, `Manual review edits: ${Object.keys(item.manual).length} cells`, '',
      'Identifiers replaced in free text by type:', ...Object.entries(s.byType).map(([k, v]) => `  ${k}: ${v}`), 'By layer:', ...Object.entries(s.bySource).map(([k, v]) => `  ${k}: ${v}`), 'Structured columns:', ...Object.entries(s.structured).map(([k, v]) => `  ${k}: ${v}`), '',
      'This report contains no patient data. The session key does.'];
  }
  $('dlReport').addEventListener('click', () => { const item = state.current; if (!item || !item.result) return; download(new Blob([reportLines(item).join('\n')], { type: 'text/plain' }), `${fileStamp(item)}_report.txt`); });
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }

  // ------------------------------------------------------------ session strip, key, panel
  function renderSession() {
    const s = $('session'); const show = session.items.length > 0 || session.registry.size > 0;
    s.classList.toggle('hidden', !show);
    if (show) $('sessionText').textContent = `This session: ${session.registry.size} patients · ${session.items.length} sources · ${session.keySaved ? 'key saved' : 'key not saved'} · ${$('optDates').value === 'shift' ? 'Dates: shifted' : 'Dates: removed (Safe Harbor)'}`;
    setDownloadState();
    if (!$('sessionPanel').classList.contains('hidden')) renderSessionPanel();
    layoutStrip();
  }
  function mergedMapping() {
    // the registry holds every replacement of the session: patients, providers, third-party names, organizations, places, ids
    const cols = new Map(); session.items.forEach((it) => (it.columns || []).forEach((c) => { if (!cols.has(c.header)) cols.set(c.header, { header: c.header, role: c.role }); }));
    return { patients: session.registry.toMappingRows(), providers: session.registry.toProviderRows(), others: session.registry.toOtherRows(), meta: { seed: session.seed, processedAt: new Date().toISOString(), mrnPattern: session.mrnPattern || '', columns: [...cols.values()], keySaves: session.keySaves + 1 } };
  }
  $('dlMap').addEventListener('click', () => {
    const m = mergedMapping();
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m.patients.length ? m.patients : [{ Code: '', SurrogateName: '', RealName: '', MRN: '', DOB: '', Account: '', Phone: '', DateOffsetDays: '' }]), 'Patients');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m.providers.length ? m.providers : [{ Code: '', SurrogateName: '', RealName: '', Credential: '' }]), 'Providers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m.others.length ? m.others : [{ Type: '', Original: '', Surrogate: '' }]), 'Others');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['meta'], [JSON.stringify(m.meta)]]), 'Meta');
    session.keySaves++; session.keyStamp = keyStamp();
    XLSX.writeFile(wb, `SESSION_KEY_PHI_${today()}_${hhmm()}_${session.keySaves}.xlsx`);
    $('newSessionConfirm').classList.add('hidden');
    renderSession();
  });
  $('dlAll').addEventListener('click', () => {
    const wb = XLSX.utils.book_new();
    session.items.forEach((it) => { if (!it.result) return; XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoaOut(it), { cellDates: true }), `Input ${it.n}`); });
    if (!wb.SheetNames.length) return;
    XLSX.writeFile(wb, `protected_${today()}_all.xlsx`, { cellDates: true });
  });
  function restoreSession(wb) {
    const toJson = (name) => (wb.Sheets[name] ? XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }) : []);
    const metaAoa = wb.Sheets.Meta ? sheetToAoa(wb.Sheets.Meta) : [];
    let meta = {}; try { meta = JSON.parse((metaAoa[1] || [])[0] || '{}'); } catch (e) {}
    const patients = toJson('Patients').filter((p) => p.Code);
    session.registry = DeID.createRegistry(patients, { providers: toJson('Providers').filter((p) => p.SurrogateName && p.RealName), others: toJson('Others').filter((o) => o.Surrogate && o.Original) });
    session.seed = parseInt(meta.seed, 10) || 12345; $('optSeed').value = session.seed;
    session.mrnPattern = meta.mrnPattern || null;
    session.keySaves = parseInt(meta.keySaves, 10) || 0;
    session.keyStamp = keyStamp();
    refreshOffsets();
    notice(`Session restored: ${patients.length} patients from the key. New files will reuse their codes, made-up names and date offsets.`, '');
    $('runInfo').textContent = '';
    if (session.items.length) rerunAll(); else renderSession();
  }
  $('continueKey').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { restoreSession(await readWorkbook(f)); } catch (err) { notice(`Could not read the key: ${esc(err.message)}`, 'danger'); } });
  function startOver() {
    session.registry = DeID.createRegistry(); session.items.length = 0; session.mrnPattern = null; session.keyStamp = null; session.keySaves = 0; session.startedAt = new Date().toISOString();
    state.current = null; state.page = 1; state.reidPreload = null;
    ['working', 'ocrCard', 'colsCard', 'verdict', 'reviewCard', 'exportCard', 'sessionPanel', 'newSessionConfirm'].forEach((id) => $(id).classList.add('hidden'));
    $('drop').classList.remove('compact'); notice(''); $('runInfo').textContent = ''; $('dlNudge').textContent = '';
    renderSession();
  }
  $('newSession').addEventListener('click', () => {
    if (session.registry.size === 0 && session.items.length === 0) { startOver(); return; }
    $('newSessionText').textContent = session.keySaved ? 'Start over? The key is saved. Protected files you have not downloaded, and your column and review choices, will be lost.' : 'Start over? The key for this session has not been saved. Without it you cannot restore names or continue linking later.';
    $('newSessionSaveFirst').classList.toggle('hidden', session.keySaved);
    $('newSessionConfirm').classList.remove('hidden'); layoutStrip();
  });
  $('newSessionYes').addEventListener('click', startOver);
  $('newSessionCancel').addEventListener('click', () => { $('newSessionConfirm').classList.add('hidden'); layoutStrip(); });
  $('newSessionSaveFirst').addEventListener('click', () => $('dlMap').click());
  $('sessionShow').addEventListener('click', () => { const p = $('sessionPanel'); p.classList.toggle('hidden'); $('sessionShow').textContent = p.classList.contains('hidden') ? 'Show patients' : 'Hide patients'; if (!p.classList.contains('hidden')) renderSessionPanel(); });
  $('hideReal').addEventListener('change', renderSessionPanel);
  function renderSessionPanel() {
    const hide = $('hideReal').checked;
    const seen = (e) => session.items.filter((it) => it.result && it.result.census.patients.has(e.id)).map((it) => `${it.name} (${it.result.census.patients.get(e.id).rows.length})`).join('; ');
    const linked = (e) => { let how = ''; session.items.forEach((it) => { if (it.linkedBy && it.linkedBy[e.id] && it.linkedBy[e.id] !== 'new') how = it.linkedBy[e.id]; }); return how; };
    $('patientsTable').innerHTML = '<tr><th>Code</th><th>Made-up name</th><th>Real name</th><th>MRN</th><th>Seen in</th><th>Linked by</th></tr>' + session.registry.entities.map((e) => {
      const how = linked(e); const amber = how === 'similar name';
      return `<tr class="${amber ? 'amber' : ''}"><td>${esc(e.code)}</td><td>${esc(e.fakeLast ? `${e.fakeLast}, ${e.fakeFirst}` : '')}</td><td>${hide ? '••••' : esc([...e.names].join('; '))}</td><td>${hide ? '••••' : esc([...e.mrns].join('; '))}</td><td class="small">${esc(seen(e))}</td><td class="small">${esc(how)}${amber ? ` <button class="btn small" data-same="${e.id}">Same person</button>${typeof session.registry.split === 'function' ? ` <button class="btn small" data-split="${e.id}">Different people</button>` : ''}` : ''}</td></tr>`;
    }).join('');
    $('patientsTable').querySelectorAll('[data-same]').forEach((b) => b.addEventListener('click', () => { session.items.forEach((it) => { if (it.linkedBy) it.linkedBy[b.dataset.same] = 'confirmed'; }); renderSessionPanel(); }));
    $('sourcesList').innerHTML = session.items.map((it) => `<div class="row" style="margin-top:4px"><span>${it.n}. ${esc(it.name)} <span class="muted">(${it.kind === 'image' ? 'screenshot' : it.kind === 'text' ? 'text' : 'spreadsheet'}, ${it.table ? it.table.rows.length : 0} rows)</span></span>${it.result ? `<span class="lnk" data-dl="${it.id}">Download</span>` : ''}<span class="lnk" data-showitem="${it.id}">Show</span></div>`).join('') || '<span class="muted">No sources yet.</span>';
    $('sourcesList').querySelectorAll('[data-dl]').forEach((a) => a.addEventListener('click', () => { const it = session.items.find((x) => x.id === a.dataset.dl); if (!it || isGated(it) || (isRed(it) && !$('optOverride').checked)) { notice('That source cannot be downloaded until its columns are confirmed and its self-check passes.', 'warn'); return; } const ws = XLSX.utils.aoa_to_sheet(aoaOut(it), { cellDates: true }); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Protected'); XLSX.writeFile(wb, `${fileStamp(it)}.xlsx`, { cellDates: true }); }));
    $('sourcesList').querySelectorAll('[data-showitem]').forEach((a) => a.addEventListener('click', () => { const it = session.items.find((x) => x.id === a.dataset.showitem); if (it) { showItem(it); if (it.result) { $('runInfo').textContent = 'Shown'; } window.scrollTo(0, 0); } }));
  }
  window.addEventListener('beforeunload', (e) => { if (session.registry.size > 0 && !session.keySaved) { e.preventDefault(); e.returnValue = 'The session key has not been saved. Leave anyway?'; } });

  // ------------------------------------------------------------ OCR items
  async function runOcrItem(file, i, n) {
    if (!hasOcr()) { hideWorking(); notice(typeof DeIDOCR !== 'undefined' && DeIDOCR.reason && DeIDOCR.reason() === 'no-simd' ? NO_SIMD_MSG : PLAIN_BUILD_MSG, 'warn'); return; }
    const item = newItem('image', file.name || `screenshot-${i}.png`);
    item.sizeKB = Math.round((file.size || 0) / 1024);
    const prefix = n > 1 ? `Screenshot ${i} of ${n}: ` : '';
    showWorking(item.name); $('cancelRun').classList.toggle('hidden', n <= 1);
    stage(`${prefix}Starting text recognition (the first screenshot takes about 20 seconds)…`);
    $('runInfo').textContent = 'Reading…';
    let url = null;
    try {
      url = URL.createObjectURL(file);
      await new Promise((resolve) => { const img = new Image(); img.onload = () => { try { const c = $('thumb'); c.height = Math.max(20, Math.round(160 * img.naturalHeight / img.naturalWidth)); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); c.classList.remove('hidden'); } catch (e) {} resolve(); }; img.onerror = resolve; img.src = url; });
      const res = await DeIDOCR.recognize(file, { onProgress: (m) => {
        if (!m || !m.status) return;
        if (/loading|initializ/i.test(m.status)) stage(`${prefix}Starting text recognition…`);
        else if (/recognizing/i.test(m.status)) { const p = Math.round((m.progress || 0) * 100); stage(`${prefix}Reading the screenshot… ${p}%`); $('workProg').firstElementChild.style.width = `${Math.max(10, p)}%`; }
      } });
      item.ocr = { lines: res.lines, confidence: res.confidence, text: res.text, edited: false };
      stage('Finding patients…');
      buildTextItem(item, `=== screenshot ${item.n} ===\n${res.text}`);
    } catch (e) {
      console.error(e); dropItem(item);
      const msg = /no OCR engine/i.test(e.message) ? PLAIN_BUILD_MSG : /SIMD/i.test(e.message) ? NO_SIMD_MSG : `Could not read the screenshot: ${esc(e.message)}`;
      notice(msg, 'danger'); $('runInfo').textContent = '';
    } finally {
      if (url) URL.revokeObjectURL(url);
      const c = $('thumb'); try { c.getContext('2d').clearRect(0, 0, c.width, c.height); } catch (e) {}
      c.classList.add('hidden');
    }
  }
  function renderOcrCard(item) {
    const card = $('ocrCard');
    if (!item.ocr) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const low = item.ocr.lines.filter((l) => l.confidence < 70).length;
    $('ocrNote').textContent = `Read ${item.ocr.lines.length} lines · ${low} lines were hard to read and are flagged below.${item.ocr.edited ? ' (You corrected the text; the flags were cleared.)' : ''}`;
    if (document.activeElement !== $('ocrText')) $('ocrText').value = item.ocr.text;
  }
  $('ocrRerun').addEventListener('click', () => {
    const item = state.current; if (!item || !item.ocr) return;
    item.ocr.text = $('ocrText').value; item.ocr.edited = true;
    $('runInfo').textContent = 'Reading…';
    buildTextItem(item, `=== screenshot ${item.n} ===\n${item.ocr.text}`);
  });

  // ------------------------------------------------------------ advanced settings (persisted: words and settings only)
  const OPT_IDS = ['optPatients', 'optProviders', 'optDates', 'optDob', 'optAges', 'optRange', 'optSeed', 'optDerive'];
  (function initOpts() {
    try { const o = JSON.parse(lsGet('deid:opts') || '{}'); OPT_IDS.forEach((id) => { if (o[id] == null) return; const el = $(id); if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = o[id]; }); } catch (e) {}
    $('optDeny').value = lsGet('deid:deny') || ''; $('optAllow').value = lsGet('deid:allow') || '';
  })();
  function saveOpts() { const o = {}; OPT_IDS.forEach((id) => { const el = $(id); o[id] = el.type === 'checkbox' ? el.checked : el.value; }); lsSet('deid:opts', JSON.stringify(o)); lsSet('deid:deny', $('optDeny').value); lsSet('deid:allow', $('optAllow').value); }
  // An entity first processed while dates were removed carries offset 0; once shifting is on it needs a real offset,
  // or its real dates would pass through under a "Dates: shifted" label.
  function refreshOffsets() { if ($('optDates').value === 'shift') session.registry.entities.forEach((e) => { if (e.offset === 0) e.offset = null; }); }
  OPT_IDS.concat(['optDeny', 'optAllow', 'optMrn']).forEach((id) => $(id).addEventListener('change', () => { saveOpts(); session.seed = parseInt($('optSeed').value, 10) || 12345; refreshOffsets(); rerunAll(); }));
  session.seed = parseInt($('optSeed').value, 10) || 12345;
  $('optOverride').addEventListener('change', () => { if (state.current && state.current.result) renderVerdict(state.current); setDownloadState(); });

  // ------------------------------------------------------------ check accuracy (validate)
  function synthOpts() { return { n: Math.max(20, parseInt($('synN').value, 10) || 600), seed: parseInt($('synSeed').value, 10) || 7, holdoutShare: Math.min(1, Math.max(0, parseFloat($('synHold').value) || 0.3)) }; }
  $('synRun').addEventListener('click', () => {
    $('synOut').innerHTML = '<span class="muted">Generating and scoring…</span>';
    setTimeout(() => {
      try {
        state.synth = DeIDSynth.make(synthOpts());
        const r = DeIDEval.runSynthetic(state.synth); state.synthResult = r;
        const sc = r.score;
        const rows = Object.entries(sc.byType).sort().map(([T, v]) => `<tr><td><b>${T}</b></td><td>${pct(v.recall)}</td><td class="muted">${pct(v.ci[0])} – ${pct(v.ci[1])}</td><td>${pct(v.strictRecall)}</td><td>${pct(v.entityRecall)}</td><td class="muted">${v.entities}</td></tr>`).join('');
        const sub = Object.entries(sc.subStats).sort().map(([k, v]) => `<span class="pill">${esc(k)} ${pct(v.tot ? v.hit / v.tot : null)} (${v.hit}/${v.tot})</span>`).join('');
        const misses = sc.misses.slice(0, 60).map((m) => `<tr><td>${m.row + 1}</td><td><b>${esc(m.type)}</b>${m.sub ? ' / ' + esc(m.sub) : ''}${m.holdout ? ' <span class="pill warn">out-of-lexicon</span>' : ''}</td><td class="cell">${esc(m.context)}</td></tr>`).join('');
        const fps = sc.falsePositives.slice(0, 60).map((m) => `<tr><td>${m.row + 1}</td><td>${esc(m.predType)} <span class="muted">${esc(m.source)}</span></td><td class="cell">${esc(m.context)}</td></tr>`).join('');
        $('synOut').innerHTML = `
          <div class="stats">
            <div class="stat"><b>${pct(sc.overall.recall)}</b><span>token recall, all PHI</span></div>
            <div class="stat"><b>${pct(sc.overRedaction.rate, 2)}</b><span>over-redaction (${sc.overRedaction.redacted} / ${sc.overRedaction.nonPhiTokens} non-PHI tokens)</span></div>
            <div class="stat"><b class="${r.leaks.length ? 'bad' : 'ok'}">${r.leaks.length}</b><span>census identifiers surviving in output</span></div>
            <div class="stat"><b class="${r.unshifted ? 'bad' : 'ok'}">${r.unshifted}</b><span>unshifted appointment dates</span></div>
            <div class="stat"><b>${sc.cells}</b><span>free-text cells scored</span></div>
          </div>
          <table style="margin-top:12px"><tr><th>Category</th><th>Token recall</th><th>95% CI (bootstrap)</th><th>Same-type recall</th><th>Whole-entity recall</th><th>n entities</th></tr>${rows}</table>
          <div class="small" style="margin-top:10px"><b>Names by kind:</b> ${sub}</div>
          <details style="margin-top:10px"><summary>Missed tokens (${sc.misses.length})</summary><table><tr><th>Row</th><th>Type</th><th>Context</th></tr>${misses || '<tr><td colspan="3" class="muted">none</td></tr>'}</table></details>
          <details style="margin-top:6px"><summary>Over-redacted tokens (${sc.falsePositives.length})</summary><table><tr><th>Row</th><th>Predicted</th><th>Context</th></tr>${fps || '<tr><td colspan="3" class="muted">none</td></tr>'}</table></details>
          ${r.leaks.length ? `<div class="note danger" style="margin-top:8px">Leaks: ${esc(r.leaks.slice(0, 10).map((l) => l.kind + ' ' + l.value).join('; '))}</div>` : ''}`;
      } catch (e) { console.error(e); $('synOut').innerHTML = `<span class="bad">Error: ${esc(e.message)}</span>`; }
    }, 20);
  });
  $('synDl').addEventListener('click', () => {
    const synth = state.synth || DeIDSynth.make(synthOpts());
    const ws = XLSX.utils.aoa_to_sheet([synth.headers, ...synth.rows], { cellDates: true });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Infusion Schedule');
    const truth = XLSX.utils.json_to_sheet(synth.truth.flatMap((t) => t.spans.map((s) => ({ Row: t.row + 2, Column: synth.headers[t.col], Start: s.start, End: s.end, Type: s.type, Sub: s.sub, OutOfLexicon: s.holdout ? 'Y' : '', Text: t.text.slice(s.start, s.end) }))));
    XLSX.utils.book_append_sheet(wb, truth, 'Ground truth');
    XLSX.writeFile(wb, `synthetic_infusion_schedule_seed${synth.options.seed}.xlsx`, { cellDates: true });
  });
  $('synAdv').addEventListener('click', () => {
    const cases = DeIDEval.runAdversarial();
    $('advCard').classList.remove('hidden');
    $('advOut').innerHTML = `<p class="small muted">${cases.filter((c) => c.pass).length} of ${cases.length} pass.</p><table><tr><th>Result</th><th>Case</th><th>Input</th><th>Output</th><th>Detail</th></tr>` + cases.map((c) => `<tr><td class="${c.pass ? 'ok' : 'bad'}"><b>${c.pass ? 'PASS' : 'FAIL'}</b></td><td>${esc(c.name)}</td><td class="cell">${esc(c.text)}</td><td class="cell muted">${esc(c.output)}</td><td class="small">${c.phi.map((p) => `<span class="pill ${p.caught ? 'ok' : 'bad'}">${p.caught ? '✓' : '✗'} ${esc(p.phrase)}</span>`).join('')}${c.keep.map((k) => `<span class="pill ${k.kept ? 'ok' : 'bad'}">${k.kept ? 'kept' : 'LOST'} ${esc(k.phrase)}</span>`).join('')}</td></tr>`).join('') + '</table>';
  });
  $('synAbl').addEventListener('click', () => {
    $('ablCard').classList.remove('hidden'); $('ablOut').innerHTML = '<span class="muted">Running four configurations…</span>';
    setTimeout(() => {
      const synth = state.synth || DeIDSynth.make(Object.assign(synthOpts(), { n: Math.min(400, synthOpts().n) }));
      const res = DeIDEval.runAblation(synth);
      const types = [...new Set(res.flatMap((r) => Object.keys(r.score.byType)))].sort();
      $('ablOut').innerHTML = `<p class="small muted">Token recall by category when layers are switched off. The deltas are the argument for the architecture: the census dictionary and the cue/lexicon tier are where names, organizations and locations come from; rules alone cover structured identifiers and dates.</p><table><tr><th>Configuration</th>${types.map((t) => `<th>${t}</th>`).join('')}<th>Over-redaction</th></tr>` + res.map((r) => `<tr><td><b>${esc(r.label)}</b></td>${types.map((t) => { const v = r.score.byType[t]; const x = v ? v.recall : null; return `<td class="${x == null ? '' : x >= 0.99 ? 'ok' : x >= 0.9 ? 'warn' : 'bad'}">${pct(x)}</td>`; }).join('')}<td>${pct(r.score.overRedaction.rate, 2)}</td></tr>`).join('') + '</table>';
    }, 20);
  });

  // ------------------------------------------------------------ restore identities
  $('reidRun').addEventListener('click', async () => {
    const f = $('reidFile').files[0] || state.reidPreload, mf = $('reidMap').files[0];
    if (!f || !mf) { $('reidOut').innerHTML = '<span class="bad">Choose both files: the protected workbook and the session key.</span>'; return; }
    try {
      const wb = await readWorkbook(f), mwb = await readWorkbook(mf);
      const toJson = (name) => (mwb.Sheets[name] ? XLSX.utils.sheet_to_json(mwb.Sheets[name], { defval: '' }) : []);
      const metaAoa = mwb.Sheets.Meta ? sheetToAoa(mwb.Sheets.Meta) : [];
      let meta = {}; try { meta = JSON.parse((metaAoa[1] || [])[0] || '{}'); } catch (e) {}
      const mapping = { patients: toJson('Patients').filter((p) => p.Code), providers: toJson('Providers').filter((p) => p.SurrogateName), others: toJson('Others').filter((o) => o.Surrogate), meta };
      const aoa = sheetToAoa(wb.Sheets[wb.SheetNames[0]]);
      const headers = aoa[0].map((h) => String(h == null ? '' : h)), rows = aoa.slice(1);
      const out = DeID.reidentify({ headers, rows }, mapping);
      const ws = XLSX.utils.aoa_to_sheet([out.headers, ...out.rows], { cellDates: true });
      const owb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(owb, ws, 'Re-identified');
      XLSX.writeFile(owb, `restored_${today()}.xlsx`, { cellDates: true });
      $('reidOut').innerHTML = `<span class="ok">Restored ${rows.length} rows using ${mapping.patients.length} patient codes, ${mapping.providers.length} providers and ${mapping.others.length} other replacements.</span>`;
    } catch (e) { console.error(e); $('reidOut').innerHTML = `<span class="bad">Error: ${esc(e.message)}</span>`; }
  });

  renderSession();
  // Expose for automated tests
  window.__deid = { state, runDeid, collectConfig, addItem: addInput, addInputs, leakCheck, session, processItem };
})();
