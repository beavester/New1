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
  const yieldUI = () => new Promise((r) => setTimeout(r, 0));
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

  // Formula-injection guard on every file this page writes: a text cell a spreadsheet would read as a formula (= + - @,
  // tab, carriage return, or their full-width forms) is written with a leading apostrophe. DeID.safeCell (core) is used
  // when it exists, and its answer is checked again here so the guarantee does not depend on it.
  const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;
  const localSafeCell = (v) => (typeof v === 'string' && FORMULA_START.test(v) ? `'${v}` : v);
  const safeCell = (v) => {
    let out = v;
    if (typeof DeID.safeCell === 'function') { try { out = DeID.safeCell(v); } catch (e) { out = v; } }
    return localSafeCell(out);
  };
  const safeAoa = (aoa) => aoa.map((r) => (Array.isArray(r) ? r.map(safeCell) : safeCell(r)));
  // the session key is read back by this page: undo exactly the local guard, nothing else
  const unsafeCell = (v) => (typeof v === 'string' && v.length > 1 && v[0] === "'" && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v);
  const mapValues = (o, f) => { const r = {}; Object.keys(o || {}).forEach((k) => { r[k] = f(o[k]); }); return r; };

  // test hooks (window.__deid.failNext): make the next protect run or the next self-check throw, to prove the page fails closed
  const testHooks = { process: 0, check: 0 };

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
    if (s === 'strict') return 'Found by: unrecognised word (strict check; may be an ordinary word)';
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
  // roster: the patient list (today's schedule or roster). Its tables are kept in this tab's memory only, so the list can be
  // re-applied when a session is restored from a key; ids are the registry entities it named.
  // The made-up names and date shifts are drawn from a number chosen at random for each session (kept only in the session
  // key, so a restored session draws the same ones). A fixed default would make every session's date shift the same, and so
  // predictable and reversible; a number typed under Advanced is used for this session only and never saved.
  const randomSeed = () => {
    try { const a = new Uint32Array(1); (window.crypto || window.msCrypto).getRandomValues(a); if (a[0] >>> 1) return a[0] >>> 1; } catch (e) { /* no crypto: fall through */ }
    return 1 + Math.floor(Math.random() * 0x7ffffffe);
  };
  const session = { registry: DeID.createRegistry(), items: [], seed: 0, baseSeed: randomSeed(), mrnPattern: null, keyStamp: null, keySaves: 0, startedAt: new Date().toISOString(), roster: { ids: new Set(), sources: [] } };
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

  // ------------------------------------------------------------ size limits
  // What one page can protect without stalling: past these the page asks for the file to be split instead of starting.
  // (Core costs grow with the number of patients the session knows; a reading or a run that never ends would leave the
  // tab frozen with nothing to show for it.)
  // (text is read in one call, so pasted or .txt text has its own, lower limits; a CSV or workbook is read in one call too)
  const LIMITS = { rows: 50000, cols: 1000, cells: 2500000, patients: 10000, textMB: 8, bookMB: 15, textLines: 10000, pasteMB: 3 };
  const tooBig = (what) => new Error(`${what}. Split it into smaller files (for example one week or one clinic at a time) and protect them one after another in this session.`);
  function checkFileSize(file) {
    const mb = (file && file.size || 0) / 1048576;
    const isText = /\.(csv|txt|tsv)$/i.test((file && file.name) || '') || /^text\//.test((file && file.type) || '');
    if (mb > (isText ? LIMITS.textMB : LIMITS.bookMB)) throw tooBig(`This file is ${mb.toFixed(1)} MB, more than the ${isText ? LIMITS.textMB : LIMITS.bookMB} MB one page can read`);
  }
  function tableLimits(headers, rows) {
    const nr = rows.length, nc = headers.length;
    if (nc > LIMITS.cols) throw tooBig(`This table has ${nc.toLocaleString()} columns, more than the ${LIMITS.cols.toLocaleString()} one page can protect`);
    if (nr > LIMITS.rows) throw tooBig(`This table has ${nr.toLocaleString()} rows, more than the ${LIMITS.rows.toLocaleString()} one page can protect`);
  }

  // ------------------------------------------------------------ file reading
  function readWorkbook(file) {
    return new Promise((resolve, reject) => {
      try { checkFileSize(file); } catch (e) { reject(e); return; }
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      // sheetRows: no sheet is parsed past 50,101 rows (the row limit plus title rows); a longer sheet is refused in sheetToAoa
      r.onload = () => { try { resolve(XLSX.read(new Uint8Array(r.result), { type: 'array', cellDates: true, raw: false, sheetRows: 50101 })); } catch (e) { reject(e); } };
      r.readAsArrayBuffer(file);
    });
  }
  function readText(file) { return new Promise((resolve, reject) => { try { checkFileSize(file); } catch (e) { reject(e); return; } const r = new FileReader(); r.onerror = () => reject(r.error); r.onload = () => resolve(String(r.result || '')); r.readAsText(file); }); }
  function sheetToAoa(ws) {
    if (!ws || typeof ws !== 'object') return [];
    // The range is taken from the cells that exist, never from the sheet's declared dimension: a 16 KB file can declare
    // A1:XFD1048576 and SheetJS would walk all 17 billion cells. A sheet whose real range is past what the page can protect
    // is refused (everything that reads a sheet catches this and says so). Everything this function needs is defined inside
    // it (a test harness lifts it out of this file on its own).
    const MAX_ROWS = 50100, MAX_COLS = 1000, MAX_CELLS = 2500000, MAX_MERGE_WORK = 20000000;
    const cells = [];
    let r0 = Infinity, c0 = Infinity, r1 = -1, c1 = -1;
    for (const k of Object.keys(ws)) {
      if (k[0] === '!') continue;
      let a; try { a = XLSX.utils.decode_cell(k); } catch (e) { continue; }
      if (!a || !(a.r >= 0) || !(a.c >= 0)) continue;
      cells.push([a.r, a.c, k]);
      if (a.r < r0) r0 = a.r; if (a.r > r1) r1 = a.r; if (a.c < c0) c0 = a.c; if (a.c > c1) c1 = a.c;
    }
    if (!cells.length) return [];
    // keep the declared top-left corner when it is valid and not past a real cell (column and row numbering stay as before)
    let decl = null; try { decl = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null; } catch (e) { decl = null; }
    if (decl && decl.s && decl.s.r >= 0 && decl.s.c >= 0) { r0 = Math.min(r0, decl.s.r); c0 = Math.min(c0, decl.s.c); }
    const nRows = r1 - r0 + 1, nCols = c1 - c0 + 1;
    const split = 'Split it into smaller files (for example one week or one clinic at a time) and protect them one after another in this session.';
    if (nRows >= MAX_ROWS) throw new Error(`This sheet has more than ${(MAX_ROWS - 100).toLocaleString()} rows, more than one page can protect. ${split}`);
    if (nCols > MAX_COLS) throw new Error(`This sheet has ${nCols.toLocaleString()} columns, more than the ${MAX_COLS.toLocaleString()} one page can protect. ${split}`);
    if (nRows * nCols > MAX_CELLS) throw new Error(`This sheet has ${nRows.toLocaleString()} rows × ${nCols.toLocaleString()} columns, more than one page can protect. ${split}`);
    const src = Object.assign({}, ws);
    src['!ref'] = XLSX.utils.encode_range({ s: { r: r0, c: c0 }, e: { r: r1, c: c1 } });
    // a value hidden under a merged range is never read: Excel shows only the top-left cell of a merge, so the rest is not
    // part of the visible table, and in a column kept as is it would be written out unread. Cells are visited by row, so
    // the work is bounded by the cells each merge covers, not by cells × merges.
    const merges = Array.isArray(ws['!merges']) ? ws['!merges'].filter((m) => m && m.s && m.e && m.e.r >= m.s.r && m.e.c >= m.s.c) : [];
    if (merges.length) {
      const byRow = new Map();
      cells.forEach((x) => { let l = byRow.get(x[0]); if (!l) byRow.set(x[0], (l = [])); l.push(x); });
      const rowsSorted = [...byRow.keys()].sort((a, b) => a - b);
      const firstAtOrAfter = (r) => { let lo = 0, hi = rowsSorted.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (rowsSorted[mid] < r) lo = mid + 1; else hi = mid; } return lo; };
      let work = 0;
      for (const m of merges) {
        for (let i = firstAtOrAfter(m.s.r); i < rowsSorted.length && rowsSorted[i] <= m.e.r; i++) {
          const list = byRow.get(rowsSorted[i]); work += list.length;
          if (work > MAX_MERGE_WORK) throw new Error(`This sheet has too many merged cells to read safely. ${split}`);
          for (const x of list) if (x[1] >= m.s.c && x[1] <= m.e.c && !(x[0] === m.s.r && x[1] === m.s.c)) delete src[x[2]];
        }
      }
    }
    return XLSX.utils.sheet_to_json(src, { header: 1, raw: true, defval: null, blankrows: false });
  }
  // a session-key sheet as objects (first row = field names), read through sheetToAoa so its range is never trusted either
  function sheetObjects(ws) {
    const aoa = sheetToAoa(ws);
    if (!aoa.length) return [];
    const keys = (aoa[0] || []).map((h) => (h == null ? '' : String(h)));
    return aoa.slice(1).map((r) => { const o = {}; keys.forEach((k, i) => { if (k) o[k] = r && r[i] != null ? r[i] : ''; }); return o; });
  }
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
    const it = { id: `i${Date.now()}_${Math.floor(Math.random() * 1e6)}`, n: session.items.length + 1, kind, name, sizeKB: 0, sheet: null, headerRow: 0, aoa: null, wb: null, table: null, columns: null, ocr: null, result: null, manual: {}, confirmedColumns: false, viewedReview: false, firstRun: true, leak: null, flagged: 0, savedLayout: false, linkedBy: {}, noteKey: null, learn: null, rawText: null, error: null, running: false, gen: 0 };
    session.items.push(it);
    return it;
  }
  function dropItem(it) { it.gen++; it.running = false; const i = session.items.indexOf(it); if (i >= 0) session.items.splice(i, 1); session.items.forEach((x, k) => { x.n = k + 1; }); if (state.current === it) state.current = session.items[session.items.length - 1] || null; }

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
    } catch (e) { console.warn(e); hideWorking(); notice(`Could not read this file: ${esc((e && e.message) || e)}`, 'danger'); }
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
  function textLimits(text) {
    const t = String(text || '');
    if (t.length > LIMITS.pasteMB * 1048576) throw tooBig(`This text is ${(t.length / 1048576).toFixed(1)} MB, more than the ${LIMITS.pasteMB} MB of text one page can protect`);
    let lines = 1; for (let i = t.indexOf('\n'); i >= 0; i = t.indexOf('\n', i + 1)) if (++lines > LIMITS.textLines) throw tooBig(`This text has more than ${LIMITS.textLines.toLocaleString()} lines, more than one page can protect as text`);
  }
  function buildTextItem(item, text) {
    item.result = null; item.leak = null; item.manual = {}; item.firstRun = true;
    try {
      textLimits(text);
      const doc = DeID.parseTextDocument(text, { mrnPattern: session.mrnPattern });
      item.table = { headers: doc.headers, rows: doc.rows }; item.columns = doc.columns; item.docStats = doc.stats; item.savedLayout = false;
    } catch (e) { failItem(item, e); showItem(item); renderSession(); return; }
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
  $('pasteOpen').addEventListener('click', () => { $('rosterBox').classList.add('hidden'); $('pasteBox').classList.toggle('hidden'); if (!$('pasteBox').classList.contains('hidden')) $('pasteText').focus(); });
  $('pasteRun').addEventListener('click', () => { const t = $('pasteText').value; if (!t.trim()) { notice('Paste some text first.', 'warn'); return; } routeText(t, 'pasted text'); $('pasteText').value = ''; $('pasteBox').classList.add('hidden'); });

  // ------------------------------------------------------------ patient list (today's schedule or roster)
  // The list only tells the session's patient registry who today's patients are. It never becomes an input of its own (no
  // protected file is made from it) and it is kept in this tab's memory only, never in local storage. Every input already
  // protected is run again so the check before download looks for these patients too.
  const rosterNotice = (html, cls) => { $('rosterInfo').innerHTML = html ? `<span class="${cls || ''}">${html}</span>` : ''; };
  const MONTH_OR_DAY = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|mon(?:day)?|tues?(?:day)?|wed(?:nesday)?|thu(?:rs?(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/i;
  // "Clifford Nyambura   00987654": a line with a First Last name and no comma. Only when what is left after times, numbers,
  // dates and labels is two to four capitalised words, none of them clinical, a month or weekday, or an ordinary word
  // that is not also a name (so "Chair 4 Hydration" or "Infusion Schedule" never become patients).
  function rosterNameFromLine(line) {
    const rest = String(line || '')
      .replace(/\b\d{1,2}:\d{2}(?:\s*[AaPp]\.?[Mm]\.?)?/g, ' ')
      .replace(/\b(?:MRN|MR#|DOB|D\.O\.B\.?|Acct|Account|CSN|HAR|FIN|Pt|Patient|Name|Chair|Bay|Room|Rm|Age|Sex)(?![A-Za-z])\s*[:#]?/gi, ' ')
      .replace(/[A-Za-z]{0,3}\d[\w\/\-.]*/g, ' ')
      .replace(/[|,;:#()\[\]{}<>"“”*•·]+/g, ' ');
    const toks = rest.split(/\s+/).filter(Boolean);
    if (toks.length < 2 || toks.length > 4) return null;
    if (!toks.every((t) => /^[A-Z][A-Za-z'’\-]*\.?$/.test(t))) return null;
    const words = toks.map((t) => t.replace(/\.$/, '')).filter((w) => w.length >= 2);
    if (words.length < 2) return null;
    const L = LEXN;
    const nameish = (w) => !!L && (L.isFirstName(w) || L.isSurname(w));
    const lw = (w) => w.toLowerCase();
    // a staff line ("Dr. Patel", "Okafor NP") is not a patient
    const orgWord = (w) => !!L && [L.ORG_SUFFIX_SET, L.ORG_NAMEWORD_SET, L.LOCAL_ORG_SET].some((set) => set && set.has(lw(w)));
    if (words.some((w) => MONTH_OR_DAY.test(w) || orgWord(w) || (L && (L.isClinical(w) || L.HONORIFIC_SET.has(lw(w)) || L.CREDENTIAL_SET.has(lw(w)))) || (L && L.isEnglishWord(w) && !nameish(w)))) return null;
    return `${toks[toks.length - 1]}, ${toks.slice(0, -1).join(' ')}`;
  }
  // Text into a table of patients. Tab-separated lines with a header go through the column reader; otherwise every line is
  // read on its own (a roster has one patient per line, so a name is never carried to the next line).
  function rosterTableFromText(text) {
    textLimits(text);
    const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());
    if (!lines.length) throw new Error('the list is empty');
    if (lines.length > LIMITS.patients * 2) throw tooBig(`This list has ${lines.length.toLocaleString()} lines; one session can hold up to ${LIMITS.patients.toLocaleString()} patients`);
    const tabbed = lines.filter((l) => l.includes('\t')).length;
    if (lines.length >= 2 && tabbed / lines.length >= 0.6) {
      const cells = lines.map((l) => l.split('\t').map((c) => c.trim()));
      const headers = cells[0].map((h, i) => h || `Column ${i + 1}`);
      const rows = cells.slice(1).map((r) => headers.map((_, i) => (r[i] == null || r[i] === '' ? null : r[i])));
      const columns = DeID.classifyColumns(headers, rows);
      if (columns.some((c) => c.role === 'patient_name' || c.role === 'mrn')) return { headers, rows, columns };
    }
    const headers = ['Patient Name', 'MRN', 'DOB'];
    const rows = [];
    lines.forEach((line) => {
      let doc = null;
      try { doc = DeID.parseTextDocument(line, { mrnPattern: session.mrnPattern, carryForward: false }); } catch (e) { doc = null; }
      const col = (role) => (doc ? doc.columns.findIndex((c) => c.role === role) : -1);
      const r = doc && doc.rows[0] ? doc.rows[0] : null;
      const get = (role) => { const i = col(role); return r && i >= 0 && r[i] != null ? r[i] : ''; };
      let name = DeID.cellToString(get('patient_name')).trim();
      const mrn = DeID.cellToString(get('mrn')).trim(), dob = get('dob');
      if (!name) name = rosterNameFromLine(line) || '';
      if (name || mrn) rows.push([name || null, mrn || null, dob === '' ? null : dob]);
      ((doc && doc.rows.extras) || []).forEach((x) => { if (x && (x.name || x.mrn)) rows.push([x.name || null, x.mrn || null, x.dob || null]); });
    });
    return { headers, rows, columns: [{ role: 'patient_name' }, { role: 'mrn' }, { role: 'dob' }].map((c, i) => ({ header: headers[i], index: i, role: c.role })) };
  }
  // Enter the list's patients into the session registry (the same reader a spreadsheet's patients go through).
  function seedRoster(table) {
    const columns = table.columns.map((c, i) => ({ header: String(table.headers[i] == null ? '' : table.headers[i]), index: i, role: c.role }));
    const before = new Set(session.registry.entities.map((e) => e.id));
    const census = DeID.buildCensus(table.headers, table.rows, columns, { registry: session.registry });
    let added = 0, known = 0;
    census.patients.forEach((p, id) => { if (session.roster.ids.has(id)) return; session.roster.ids.add(id); if (before.has(id)) known++; else added++; });
    return { patients: census.patients.size, added, known };
  }
  async function addRoster(src) {
    try {
      rosterNotice('Reading the patient list…', 'muted');
      let table;
      if (typeof src === 'string') table = rosterTableFromText(src);
      else if (/\.txt$/i.test((src && src.name) || '') || (src && src.type === 'text/plain')) table = rosterTableFromText(await readText(src));
      else {
        const wb = await readWorkbook(src);
        const aoa = sheetToAoa(wb.Sheets[wb.SheetNames[0]]); const hr = detectHeaderRow(aoa);
        const headers = (aoa[hr] || []).map((h, i) => (h == null || h === '' ? `Column ${i + 1}` : String(h)));
        const rows = aoa.slice(hr + 1).filter((r) => r && r.some((v) => v != null && v !== '')).map((r) => headers.map((_, i) => (r[i] == null ? null : r[i])));
        tableLimits(headers, rows);
        table = { headers, rows, columns: DeID.classifyColumns(headers, rows) };
      }
      if (!table.rows.length || !table.columns.some((c) => c.role === 'patient_name' || c.role === 'mrn')) throw new Error('no patient names or record numbers were found in it');
      patientLimit(table.headers, table.rows, table.columns);
      const r = seedRoster(table);
      if (!r.patients) throw new Error('no patient names or record numbers were found in it');
      session.roster.sources.push(table);
      rosterNotice(`Patient list: ${plural(r.added, 'new patient', 'new patients')}${r.known ? `, ${r.known} already in this session` : ''}.${session.items.length ? ' Everything protected so far is checked again.' : ''}`, 'ok');
      renderSession();
      if (session.items.length) rerunAll();
      return r;
    } catch (e) {
      console.warn(e);
      rosterNotice(`Could not use this as a patient list: ${esc((e && e.message) || e)}`, 'bad');
      return null;
    }
  }
  function openRoster() {
    showTab('deid');
    $('pasteBox').classList.add('hidden'); $('rosterBox').classList.remove('hidden');
    $('rosterBox').scrollIntoView({ block: 'center' }); $('rosterText').focus();
  }
  $('rosterOpen').addEventListener('click', () => { if ($('rosterBox').classList.contains('hidden')) openRoster(); else $('rosterBox').classList.add('hidden'); });
  $('rosterPanelAdd').addEventListener('click', openRoster);
  $('rosterRun').addEventListener('click', async () => {
    const t = $('rosterText').value;
    if (!t.trim()) { rosterNotice('Paste the schedule or roster first.', 'warn'); return; }
    const r = await addRoster(t);
    if (r) $('rosterText').value = '';
  });
  $('rosterChoose').addEventListener('click', () => $('rosterFile').click());
  $('rosterFile').addEventListener('change', (e) => { const f = (e.target.files || [])[0]; e.target.value = ''; if (f) addRoster(f); });
  // a roster file dropped on the box is a patient list, not an input to protect
  (() => {
    const box = $('rosterBox');
    ['dragenter', 'dragover'].forEach((ev) => box.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); box.classList.add('over'); }));
    box.addEventListener('dragleave', (e) => { e.stopPropagation(); box.classList.remove('over'); });
    box.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); box.classList.remove('over'); $('drop').classList.remove('over'); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) addRoster(f); });
  })();

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
    try {
      item.sheet = name;
      item.aoa = sheetToAoa(item.wb.Sheets[name]);
      item.headerRow = headerRow == null ? detectHeaderRow(item.aoa) : headerRow;
    } catch (e) { item.result = null; failItem(item, e); showItem(item); renderSession(); return; }
    buildTable(item);
  }
  function buildTable(item) {
    item.result = null; item.leak = null; item.manual = {}; item.firstRun = true; item.confirmedColumns = false;
    try {
      const aoa = item.aoa || [];
      const headers = (aoa[item.headerRow] || []).map((h, i) => (h == null || h === '' ? `Column ${i + 1}` : String(h)));
      const rows = aoa.slice(item.headerRow + 1).filter((r) => r && r.some((v) => v != null && v !== '')).map((r) => headers.map((_, i) => (r[i] == null ? null : r[i])));
      tableLimits(headers, rows);
      item.table = { headers, rows };
      item.columns = DeID.classifyColumns(headers, rows);
      const saved = loadSavedConfig(headers);
      item.savedLayout = !!saved;
      if (saved && Array.isArray(saved.roles)) saved.roles.forEach((role, i) => { if (item.columns[i] && DeID.ROLES.includes(role)) { item.columns[i].role = role; item.columns[i].reason = 'saved'; } });
    } catch (e) { failItem(item, e); showItem(item); renderSession(); return; }
    showItem(item);
    runDeid(item, true);
  }
  function cfgKey(headers) { return 'deid:cfg:' + DeID.hashString(headers.join('|').toLowerCase()); }
  function loadSavedConfig(headers) { try { const j = lsGet(cfgKey(headers)); return j ? JSON.parse(j) : null; } catch (e) { return null; } }
  function saveLayout(item) { if (!item || item.kind !== 'table') return; lsSet(cfgKey(item.table.headers), JSON.stringify({ roles: item.columns.map((c) => c.role), saved: new Date().toISOString() })); item.savedLayout = true; }
  $('saveCfg').addEventListener('click', () => { if (state.current) { saveLayout(state.current); renderColumns(state.current); } });
  $('forgetCfg').addEventListener('click', () => { const it = state.current; if (!it || it.kind !== 'table' || !it.table) return; lsDel(cfgKey(it.table.headers)); it.savedLayout = false; it.columns = DeID.classifyColumns(it.table.headers, it.table.rows); it.confirmedColumns = false; runDeid(it, true); });
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
    const nRows = item.table ? item.table.rows.length : 0, nCols = item.table ? item.table.headers.length : 0;
    $('shapeInfo').textContent = `${nRows} rows × ${nCols} columns${item.headerRow > 0 ? ` · using row ${item.headerRow + 1} as the header` : ''}`;
    $('verdictActions').classList.add('hidden');
    $('fileInfo').textContent = `${item.kind === 'image' ? 'Screenshot' : item.kind === 'text' ? 'Text' : 'Spreadsheet'} ${item.n}: ${item.name}${item.sizeKB ? ` · ${item.sizeKB} KB` : ''} · ${nRows} rows`;
    const hasCols = !!(item.table && item.columns);
    $('colsCard').classList.toggle('hidden', !hasCols);
    if (hasCols) renderColumns(item);
    renderOcrCard(item);
    if (item.error) renderError(item);
    else if (item.result && item.leak) { renderVerdict(item); renderSummary(item); renderReview(item); renderExport(item); ['reviewCard', 'exportCard'].forEach((id) => $(id).classList.remove('hidden')); }
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
  // A value that reads as a person's name: "Last, First" or two or three capitalised words, none an ordinary English word or
  // a clinical word ("Short Stay", "Med Onc", "Roswell Park" are not names), the given name or the surname in the name lists.
  const nameShaped = (v) => {
    const t = DeID.cellToString(v).trim();
    if (!t || t.length > 60) return false;
    let f, l;
    const lf = t.match(/^([A-Za-z'’\-]{2,40}),\s*([A-Za-z'’\-]{2,40})(?:\s+[A-Za-z.'’\-]{1,40})?$/);
    if (lf) { f = lf[2]; l = lf[1]; }
    else {
      const ws = t.split(/\s+/);
      if (ws.length < 2 || ws.length > 3 || !ws.every((w) => /^[A-Z][A-Za-z'’\-]*\.?$/.test(w))) return false;
      f = ws[0].replace(/\.$/, ''); l = ws[ws.length - 1].replace(/\.$/, '');
    }
    if (f.length < 2 || l.length < 2) return false;
    if (!LEXN) return !!lf;
    if ([f, l].some((w) => LEXN.isClinical(w) || LEXN.isEnglishWord(w))) return false;
    return LEXN.isFirstName(f) || LEXN.isSurname(l);
  };
  // Column warnings, worked out once per layout. A critical one (no patient-name column; a kept column whose header looks
  // like an identifier or whose values look like names) raises the gate even for a remembered layout: a remembered "Keep
  // unchanged" on a name column must never pass the next file through unread.
  function colWarnings(item) {
    if (!item || item.kind !== 'table' || !item.table || !item.columns) return [];
    const sig = item.columns.map((c) => c.role).join('|');
    if (item.warnCache && item.warnCache.sig === sig && item.warnCache.table === item.table) return item.warnCache.list;
    const roles = item.columns.map((c) => c.role);
    const w = [];
    const crit = (msg) => w.push({ msg, critical: true }), info = (msg) => w.push({ msg, critical: false });
    const rows = item.table.rows.length > 2000 ? item.table.rows.slice(0, 2000) : item.table.rows; // a sample is enough to warn
    if (!roles.includes('mrn')) info('No MRN column found: patients will be keyed by name and date of birth.');
    if (!roles.includes('patient_name')) crit('We could not find a column of patient names, so names inside notes may be missed. Pick the column that holds them.');
    const kept = item.columns.filter((c) => c.role === 'keep');
    kept.filter((c) => /name|address|contact|phone|email|guarantor|employer|insur/i.test(c.header)).forEach((c) => crit(`"${c.header}" is kept unchanged but its header looks like an identifier. Is that right?`));
    kept.forEach((c) => {
      const vals = rows.map((r) => r[c.index]).filter((v) => v != null && v !== '');
      if (vals.length < 2) return;
      const named = vals.filter(nameShaped).length;
      if (named >= 2 && named / vals.length >= 0.3) crit(`"${c.header}" is kept unchanged but its values look like people's names. Choose "Patient name", "Doctor or staff name" or "Free text" for it, unless it holds no names.`);
    });
    kept.forEach((c) => {
      const vals = rows.map((r) => DeID.cellToString(r[c.index])).filter(Boolean);
      if (vals.length < 3) return;
      const avg = vals.reduce((a, x) => a + x.length, 0) / vals.length;
      const uniq = new Set(vals.map((x) => x.toLowerCase())).size / vals.length;
      if (avg > 40 && uniq > 0.5) info(`"${c.header}" looks like free text but will be kept unchanged.`);
    });
    item.warnCache = { sig, table: item.table, list: w };
    return w;
  }
  const isGated = (item) => !!item && item.kind === 'table' && !item.confirmedColumns && colWarnings(item).some((x) => x.critical || !item.savedLayout);
  function renderWarnings(item) {
    const w = colWarnings(item);
    const gated = isGated(item);
    $('colWarnings').innerHTML = w.length ? w.map((x) => `<div class="warn">⚠ ${esc(x.msg)}</div>`).join('') : '';
    $('colsCard').classList.toggle('gate', gated);
    $('colsHeading').textContent = gated ? 'Before you download, check these columns' : 'Columns';
    $('colsConfirm').classList.toggle('hidden', !gated);
    if (gated) $('colsDetails').open = true;
    setDownloadState();
  }
  $('colsChange').addEventListener('click', () => { $('colsDetails').open = !$('colsDetails').open; });
  $('colsConfirm').addEventListener('click', () => { const it = state.current; if (!it) return; it.confirmedColumns = true; if ($('rememberLayout').checked) saveLayout(it); renderColumns(it); renderSession(); });

  // ------------------------------------------------------------ config
  // The MRN format field is a pattern typed by the user. One that is long, refers back to itself, or repeats a group that
  // itself repeats or branches (the shapes that can stall a page for minutes) is not used; the learned format applies.
  function userMrnPattern() {
    const src = $('optMrn').value.trim();
    if (!src) return null;
    const risky = src.length > 120 || /\\[1-9]|\\k</.test(src) || /\((?:[^()\\]|\\.)*(?:[+*|]|\{\d+,\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\d*\})/.test(src);
    let ok = !risky;
    if (ok) { try { new RegExp(src); } catch (e) { ok = false; } }
    $('optMrnBad').textContent = ok ? '' : 'This MRN format is not used: keep it simple (for example \\d{7,8}); a complex one could stall the page.';
    return ok ? src : null;
  }
  function collectConfig(item) {
    item = item || state.current;
    const [a, b] = ($('optRange').value || '30-365').split(/[-–,\s]+/).map((x) => parseInt(x, 10));
    const lines = (id) => $(id).value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    const hasMrnCol = !!(item && item.columns && item.table) && item.columns.some((c) => c.role === 'mrn' && item.table.rows.some((r) => r[c.index] != null && r[c.index] !== ''));
    return {
      columns: item && item.columns ? item.columns.map((c) => ({ header: c.header, role: c.role })) : [],
      mrnPattern: userMrnPattern() || (hasMrnCol ? null : session.mrnPattern) || null,
      seed: session.seed,
      registry: session.registry,
      surrogate: { patients: $('optPatients').value, providers: $('optProviders').value, dob: $('optDates').value === 'remove' && $('optDob').value === 'shift' ? 'year' : $('optDob').value, ages: $('optAges').value, dateShift: $('optDates').value === 'shift', shiftRange: [isNaN(a) ? 30 : a, isNaN(b) ? 365 : b] },
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
      if (!p || !p.entity) continue;
      const prev = before.get(p.entity.id);
      if (!prev) { out[p.entity.id] = 'new'; continue; }
      let how = 'similar name';
      for (const ri of p.rows || []) {
        const row = item.table.rows[ri]; if (!row) continue;
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
  // A later input can teach the session a name an earlier screenshot could not read (a name wrapped over two
  // lines, a cropped column). Re-protect those earlier items so they pick up the name and can pass the check.
  // The same goes for any earlier input once the session knows a patient (name or record number) it did not know when that
  // input was protected: a later tile view can name a patient that an earlier table listed, and the earlier output is rescanned.
  const registryStamp = () => session.registry.entities.reduce((n, e) => n + e.names.size + e.mrns.size + 1, 0);
  // What a result was made from: tool version, the session's patients, the item's settings, column roles and review edits.
  // A download is allowed only while this still matches; anything changed since the check means the file would not be the
  // one that was checked.
  const resultKey = (item) => {
    const c = collectConfig(item);
    return JSON.stringify([DeID.VERSION, registryStamp(), c.columns, userMrnPattern() || '', c.surrogate, c.denylist, c.allowlist, c.deriveAge, c.manual, session.seed]);
  };

  // One job at a time: every run, re-run and repair of an earlier input goes through this queue, so two runs never
  // interleave on the session's patient registry. A newer request for the same input supersedes an older one (item.gen),
  // and an input removed from the session is skipped.
  let runChain = Promise.resolve();
  function enqueue(job) { const p = runChain.then(job).catch((e) => console.warn('Infusion De-ID: a run failed', e)); runChain = p; return p; }
  const BIG_ROWS = 1200;     // longer inputs are protected in parts, with a pause for the page between parts
  const PART_MS = 700;       // aim for parts of about this long
  const SLICE_MS = 250;      // and for self-check slices of about this long
  const WHOLE_CHECK = 40000; // rows × patients the self-check may do in one call (well under a second)
  const SEED_ROWS = 1000;    // first step when a long input's patients are entered into the registry (then sized by time)
  // Every core call pays a fixed cost that grows with the patients the session knows (their names are looked for in every
  // part), on top of a cost per row. A step is sized from both, measured: rows that fill what is left of the time budget,
  // and when the fixed cost alone is past half the budget, as much row time as fixed time (so a step stays near twice the
  // fixed cost, never minutes long).
  const stepRows = (fixedMs, perRowMs, budgetMs, lo, hi) => clamp(Math.round(Math.max(budgetMs - fixedMs, fixedMs) / Math.max(0.002, perRowMs)), lo, hi);

  // Fail closed: an input whose run or whose check threw keeps no result at all, so nothing from it can be exported
  // until a later run succeeds.
  function failItem(item, e) {
    const msg = String((e && e.message) || e || 'unknown error').replace(/\s+/g, ' ').slice(0, 300);
    item.error = { message: msg, at: new Date().toISOString() };
    item.result = null; item.leak = null; item.flagged = 0;
    console.warn('Infusion De-ID: this input could not be processed; nothing from it can be downloaded.', e);
  }
  function checkResultShape(r, nRows) {
    if (!r || !Array.isArray(r.rows) || !Array.isArray(r.headers) || !Array.isArray(r.details) || !r.census || !(r.census.patients instanceof Map) || !r.stats || !r.cfg) throw new Error('the protected table came back incomplete');
    if (r.rows.length !== nRows || r.details.length !== nRows) throw new Error(`the protected table has ${r.rows.length} rows but the input has ${nRows}`);
  }
  // Rows of a text document carry the patients of a tile view (extras, with row numbers) and name fragments (keyed
  // "row:col") beside them; a slice keeps the ones that fall inside it, renumbered.
  function rowSlice(rows, a, b) {
    const out = rows.slice(a, b);
    if (Array.isArray(rows.extras)) out.extras = rows.extras.filter(Boolean).map((rec) => (Array.isArray(rec.rows) ? Object.assign({}, rec, { rows: rec.rows.filter((ri) => ri >= a && ri < b).map((ri) => ri - a) }) : rec)).filter((rec) => !Array.isArray(rec.rows) || rec.rows.length);
    if (rows.fragments && typeof rows.fragments === 'object') {
      out.fragments = {};
      Object.keys(rows.fragments).forEach((k) => { const i = k.indexOf(':'); const r = +k.slice(0, i); if (r >= a && r < b) out.fragments[`${r - a}${k.slice(i)}`] = rows.fragments[k]; });
    }
    return out;
  }
  function manualSlice(manual, a, b) {
    const out = {};
    Object.keys(manual || {}).forEach((k) => { const i = k.indexOf(':'); const r = +k.slice(0, i); if (r >= a && r < b) out[`${r - a}${k.slice(i)}`] = manual[k]; });
    return out;
  }

  // A very long input is protected in parts so the page can repaint, show progress and answer clicks between them.
  // Every patient of the whole input enters the session registry first, so each part is protected, and checked, against
  // all of them; the MRN and account formats are learned once from the whole column. Each part is checked as soon as it
  // is protected, while its full census is at hand, and then only what the page needs is kept (a part's census holds every
  // patient of the session, too much to keep forty of). Core costs grow with the registry on every call, so parts are sized
  // from that fixed cost and the cost per row, both measured (stepRows). Known limit: a name found from a word clue alone is
  // spread within its own part only.
  async function processInParts(item, cfg, live, progress) {
    const headers = item.table.headers, rows = item.table.rows, total = rows.length;
    const columns = cfg.columns.length === headers.length ? cfg.columns.map((c, i) => ({ header: DeID.cellToString(headers[i]), index: i, role: c.role })) : DeID.classifyColumns(headers, rows);
    // the fixed cost of a call: a census of no rows still builds the look-up of every patient the session knows
    const fixedNow = () => { const t0 = performance.now(); DeID.buildCensus(headers, [], columns, { registry: cfg.registry }); return performance.now() - t0; };
    let fixed = fixedNow(), fixedAt = cfg.registry.size, perRow = 0.05;
    for (let a = 0, step = SEED_ROWS; a < total;) {
      const b = Math.min(total, a + step);
      const t0 = performance.now();
      DeID.buildCensus(headers, rowSlice(rows, a, b), columns, { registry: cfg.registry });
      perRow = Math.max(0.002, (performance.now() - t0 - fixed) / (b - a));
      a = b;
      progress(`Finding patients: row ${a.toLocaleString()} of ${total.toLocaleString()}…`, 0.1 * a / total);
      await yieldUI(); if (!live()) return null;
      if (a < total && cfg.registry.size > fixedAt * 1.25 + 200) { fixed = fixedNow(); fixedAt = cfg.registry.size; await yieldUI(); if (!live()) return null; }
      step = stepRows(fixed, perRow, PART_MS, 200, 20000);
    }
    const pcfg = Object.assign({}, cfg, { columns: columns.map((c) => ({ header: c.header, role: c.role })) });
    const firstOf = (role) => columns.find((c) => c.role === role);
    let inferred = null;
    if (!pcfg.mrnPattern && firstOf('mrn')) { inferred = DeID.inferIdPattern(rows.map((r) => r[firstOf('mrn').index])) || null; if (inferred) pcfg.mrnPattern = inferred; }
    if (!pcfg.accountPattern && firstOf('account')) { const acc = DeID.inferIdPattern(rows.map((r) => r[firstOf('account').index])); if (acc) pcfg.accountPattern = acc; }
    // a protect call costs more than a census of the same rows (surrogates, propagation): its fixed part is measured once
    // the registry holds every patient of the input; parts are not made smaller than 1/40 of the input while that keeps a
    // part under twice the time budget (fewer parts spread a word-clue name further)
    await yieldUI(); if (!live()) return null;
    fixed = fixedNow() * 1.3; perRow = 2;
    const minPart = Math.ceil(total / 40);
    const m = checkMerger();
    const lite = []; let size = Math.max(stepRows(fixed, perRow, PART_MS, 20, 4000), Math.min(minPart, stepRows(fixed, perRow, 2 * PART_MS, 20, 4000)));
    for (let a = 0; a < total;) {
      const b = Math.min(total, a + size);
      const t0 = performance.now();
      const res = DeID.processTable({ headers, rows: rowSlice(rows, a, b) }, Object.assign({}, pcfg, { manual: manualSlice(cfg.manual, a, b) }));
      checkResultShape(res, b - a);
      if (lite.length && JSON.stringify(res.headers) !== JSON.stringify(lite[0].headers)) throw new Error('the parts of this long input came back with different columns');
      perRow = Math.max(0.002, (performance.now() - t0 - fixed) / (b - a));
      size = Math.max(stepRows(fixed, perRow, PART_MS, 20, 4000), Math.min(minPart, stepRows(fixed, perRow, 2 * PART_MS, 20, 4000)));
      progress(`Protecting row ${b.toLocaleString()} of ${total.toLocaleString()}…`, 0.1 + 0.9 * (a + (b - a) / 2) / total);
      await yieldUI(); if (!live()) return null;
      let checked;
      try { checked = await checkInto(m, res, item.kind, a, total, live, progress, false); } catch (e) { throw new Error(`the check of the result could not run (${(e && e.message) || e})`); }
      if (!checked) return null;
      const c = res.census;
      lite.push({ offset: a, rows: res.rows, details: res.details, stats: res.stats, headers: res.headers, columns: res.columns, cfg: lite.length ? null : res.cfg, registry: res.registry,
        census: { patients: c.patients, providers: c.providers, rowPatient: c.rowPatient, rowExtra: c.rowExtra, nameCols: c.nameCols, mrnCols: c.mrnCols, dobCols: c.dobCols, acctCols: c.acctCols, phoneCols: c.phoneCols, provCols: c.provCols } });
      a = b;
    }
    const result = mergeParts(lite, cfg.registry, inferred);
    return { result, leak: m.finish(result.census.patients.size) };
  }
  // One result for the page out of the parts: rows, details and per-row census entries in order (rows renumbered),
  // patients merged, counts added.
  function mergeParts(parts, registry, inferred) {
    const first = parts[0], last = parts[parts.length - 1];
    const rows = [], details = [], rowPatient = [], rowExtra = [];
    const patients = new Map(), providers = new Map();
    const stats = { rows: 0, cells: 0, spans: 0, byType: {}, bySource: {}, structured: {} };
    const add = (dst, src) => Object.keys(src || {}).forEach((k) => { dst[k] = (dst[k] || 0) + src[k]; });
    parts.forEach((r) => {
      const offset = r.offset;
      r.rows.forEach((x) => rows.push(x));
      r.details.forEach((d) => details.push(Object.assign({}, d, { row: d.row + offset })));
      for (let i = 0; i < r.rows.length; i++) { rowPatient.push(r.census.rowPatient ? r.census.rowPatient[i] : null); rowExtra.push(r.census.rowExtra ? r.census.rowExtra[i] : null); }
      r.census.patients.forEach((p, k) => { const shifted = (p.rows || []).map((x) => x + offset); const mp = patients.get(k); if (mp) shifted.forEach((x) => mp.rows.push(x)); else patients.set(k, Object.assign({}, p, { rows: shifted })); });
      (r.census.providers || new Map()).forEach((p, k) => { if (!providers.has(k)) providers.set(k, p); });
      stats.rows += r.stats.rows || 0; stats.cells += r.stats.cells || 0; stats.spans += r.stats.spans || 0;
      add(stats.byType, r.stats.byType); add(stats.bySource, r.stats.bySource); add(stats.structured, r.stats.structured);
    });
    const known = new Map();
    registry.entities.forEach((e) => { if (!patients.has(e.id) && (e.names.size || e.mrns.size)) known.set(e.id, { key: e.id, entity: e, rows: [], known: true, names: new Set(e.names), mrns: new Set(e.mrns) }); });
    const census = Object.assign({}, last.census, { patients, known, providers, rowPatient, rowExtra, patient: (k) => patients.get(k) || known.get(k) || null });
    return { headers: first.headers, rows, columns: first.columns, census, details, stats, mapping: null, cfg: Object.assign({}, first.cfg, { inferredMrnPattern: inferred || first.cfg.inferredMrnPattern }), registry: last.registry || registry, parts: parts.map((p) => ({ offset: p.offset, rows: p.rows.length })) };
  }

  // ------------------------------------------------------------ self-check (pure, in core.js): over-sensitive scan of the output
  // A long result is checked in slices: the per-row arrays of the result and its census are cut to the slice (details
  // renumbered) and every hit is put back on its real row. A short result gets the single whole call.
  const NOT_PER_ROW = new Set(['headers', 'columns', 'parts', 'nameCols', 'mrnCols', 'dobCols', 'acctCols', 'phoneCols', 'provCols']);
  function sliceForCheck(r, a, b) {
    const n = r.rows.length;
    const cut = (obj) => { const o = {}; Object.keys(obj).forEach((k) => { const v = obj[k]; o[k] = !NOT_PER_ROW.has(k) && Array.isArray(v) && v.length === n ? v.slice(a, b) : v; }); return o; };
    const out = cut(r);
    out.census = cut(r.census);
    out.details = r.details.slice(a, b).map((d) => Object.assign({}, d, { row: d.row - a }));
    return out;
  }
  function checkMerger() {
    const sc = { hits: [], providerHits: [], coincidences: [], unnamed: [], patients: 0 };
    const seenUnnamed = new Set();
    const at = (h, base) => Object.assign({}, h, { row: typeof h.row === 'number' && h.row >= 0 ? h.row + base : h.row });
    return {
      take(s, base, partBase) {
        if (!s || !Array.isArray(s.hits)) throw new Error('the check returned no answer');
        s.hits.forEach((h) => sc.hits.push(at(h, base)));
        (s.providerHits || []).forEach((h) => sc.providerHits.push(at(h, base)));
        (s.coincidences || []).forEach((h) => sc.coincidences.push(at(h, base)));
        // unnamed patients come from the census, not the rows: the same in every slice, numbered within the part
        (s.unnamed || []).forEach((u) => { const k = u.entity || u.code || JSON.stringify(u); if (seenUnnamed.has(k)) return; seenUnnamed.add(k); sc.unnamed.push(at(u, partBase)); });
      },
      finish(patients) {
        sc.patients = patients;
        // a patient whose name was never read (pasted text or a screenshot with an MRN but no legible name): the check cannot
        // vouch for a name it never saw, so the verdict cannot be green
        sc.unnamed.forEach((u) => sc.hits.push({ row: u.row, col: -1, header: 'Patient name', text: `name not read for ${u.code || 'this patient'}`, type: 'NAME_PATIENT', kind: 'unnamed' }));
        return sc;
      },
    };
  }
  // Check one result (an input, or one part of a long input starting at row `offset`) into the merger. Returns false when
  // the run was superseded or stopped meanwhile.
  async function checkInto(m, r, kind, offset, total, live, progress, allowWhole) {
    if (testHooks.check > 0) { testHooks.check--; throw new Error('forced test failure inside the check'); }
    const n = r.rows.length;
    const people = r.census.patients.size + (r.census.known ? r.census.known.size : 0) + 1;
    // the header row is checked once, with the first rows of the input (every part and slice carries the same headers)
    if (allowWhole && n * people <= WHOLE_CHECK) { m.take(DeID.selfCheck(r, { kind, headers: offset === 0 }), offset, offset); return true; }
    // the check's look-up of every patient is built once per result (in its first slice) and shared by the later slices, so
    // slices are sized by time alone
    let size = clamp(Math.floor(WHOLE_CHECK / people), 10, Math.max(10, n));
    for (let a = 0; a < n;) {
      const b = Math.min(n, a + size);
      const t0 = performance.now();
      m.take(DeID.selfCheck(sliceForCheck(r, a, b), { kind, headers: offset + a === 0 }), offset + a, offset);
      size = clamp(Math.round((b - a) * SLICE_MS / Math.max(1, performance.now() - t0)), 10, 5000);
      a = b;
      progress(`Checking the result: row ${(offset + a).toLocaleString()} of ${total.toLocaleString()}…`, (offset + a) / total);
      await yieldUI(); if (!live()) return false;
    }
    return true;
  }
  async function selfCheckOf(result, kind, live, progress) {
    const m = checkMerger();
    if (!(await checkInto(m, result, kind, 0, result.rows.length, live, progress, true))) return null;
    return m.finish(result.census.patients.size);
  }
  // the same check in one synchronous call (window.__deid.leakCheck); a long input was checked part by part as it ran
  function leakCheck(item) {
    if (item.result && item.result.parts) return item.leak;
    const m = checkMerger(); m.take(DeID.selfCheck(item.result, { kind: item.kind }), 0, 0);
    return m.finish(item.result.census.patients.size);
  }

  // Distinct patients an input would add to the session, counted before the run (record number, else name): a session past
  // LIMITS.patients is refused with a request to split, instead of a run whose every step slows with the registry.
  function patientLimit(headers, rows, columns) {
    const idx = (role) => (columns || []).map((c, i) => (c && c.role === role ? (c.index != null ? c.index : i) : -1)).filter((i) => i >= 0);
    const nameCols = idx('patient_name'), mrnCols = idx('mrn');
    if (!nameCols.length && !mrnCols.length) return;
    const norm = (v) => DeID.cellToString(v).toLowerCase().replace(/\s+/g, ' ').trim();
    const known = new Set();
    session.registry.entities.forEach((e) => { e.mrns.forEach((m) => known.add('m:' + DeID.mrnKeyOf(m))); e.names.forEach((n) => known.add('n:' + norm(n))); });
    const fresh = new Set();
    for (const r of rows) {
      if (!Array.isArray(r)) continue;
      const m = mrnCols.map((c) => DeID.cellToString(r[c]).trim()).find(Boolean);
      const k = m ? 'm:' + DeID.mrnKeyOf(m) : (() => { const n = nameCols.map((c) => norm(r[c])).find(Boolean); return n ? 'n:' + n : ''; })();
      if (k && !known.has(k)) { fresh.add(k); if (session.registry.size + fresh.size > LIMITS.patients) break; }
    }
    if (session.registry.size + fresh.size > LIMITS.patients) throw new Error(`This input names more patients than one session can hold (${LIMITS.patients.toLocaleString()}; ${session.registry.size.toLocaleString()} are in this session already). Split the file, and save the key and start a new session when this one is full.`);
  }
  async function processItem(item, opts) {
    const o = opts && typeof opts === 'object' ? opts : { noHeal: !!opts };
    const gen = item.gen;
    const live = () => item.gen === gen && session.items.includes(item);
    const progress = typeof o.progress === 'function' ? o.progress : () => {};
    let rollback = null;
    try {
      if (!item.table || !Array.isArray(item.table.rows) || !Array.isArray(item.table.headers)) throw new Error('there is nothing readable in this input');
      tableLimits(item.table.headers, item.table.rows);
      patientLimit(item.table.headers, item.table.rows, item.columns);
      const before = snapshotRegistry();
      rollback = session.registry.checkpoint();
      const cfg = collectConfig(item);
      if (testHooks.process > 0) { testHooks.process--; throw new Error('forced test failure while protecting'); }
      const nRows = item.table.rows.length;
      let result, leak = null;
      if (nRows > BIG_ROWS) {
        const out = await processInParts(item, cfg, live, progress);
        if (!live() || !out) return false;
        result = out.result; leak = out.leak;
      } else result = DeID.processTable(item.table, cfg);
      checkResultShape(result, nRows);
      if (item.ocr && !item.ocr.edited) {
        const conf = new Map(item.ocr.lines.map((l) => [l.text.replace(/\s+$/, ''), l.confidence]));
        const lineCol = item.table.headers.indexOf('Line');
        result.details.forEach((d, ri) => { const c = conf.get(DeID.cellToString(item.table.rows[ri][lineCol])); if (c != null && c < 70) d.lowOcr = true; });
      }
      if (!leak) {
        try { leak = await selfCheckOf(result, item.kind, live, progress); } catch (e) { throw new Error(`the check of the result could not run (${(e && e.message) || e})`); }
      }
      if (!live()) return false;
      if (!leak || !Array.isArray(leak.hits)) throw new Error('the check of the result returned no answer');
      const release = DeID.releaseScan(item.table, result, { allowlist: cfg.allowlist });
      item.result = result; item.leak = leak; item.release = release; item.error = null;
      if (!session.mrnPattern && result.cfg.inferredMrnPattern) session.mrnPattern = result.cfg.inferredMrnPattern;
      item.linkedBy = computeLinks(item, before);
      item.flagged = result.details.filter(isFlagged).length;
      item.regStamp = registryStamp();
      item.resultKey = resultKey(item);
    } catch (e) {
      // a failed run leaves the session's patients as they were before it
      if (rollback) { try { rollback(); } catch (e2) { console.warn(e2); } }
      if (!live()) return false;
      failItem(item, e);
    }
    try { $('optMrnLearned').textContent = session.mrnPattern ? `Learned from your file: ${session.mrnPattern.replace(/\\b/g, '').replace(/\\d\{(\d+),(\d+)\}/, (m, a, b) => a === b ? `${a} digits` : `${a} to ${b} digits`).replace(/\\d/g, 'digits')}` : ''; } catch (e) {}
    if (!o.noHeal && !item.error) await healEarlier(item);
    return true;
  }
  async function healEarlier(src) {
    const stamp = registryStamp();
    for (const it of session.items.slice()) {
      if (it === src || !it.result || it.running) continue;
      const unnamed = it.leak && it.leak.hits.some((h) => h.kind === 'unnamed');
      if (!unnamed && it.regStamp === stamp) continue;
      const g = it.gen; it.running = true;
      try { await processItem(it, { noHeal: true }); } finally { if (it.gen === g) it.running = false; }
    }
  }
  const isFlagged = (d) => !!d.lowOcr || d.cells.some((c) => c.spans.some(isUncertain));
  const certainCount = (item) => item.result.details.reduce((n, d) => n + d.cells.reduce((m, c) => m + c.spans.filter((sp) => !isUncertain(sp)).length, 0), 0);
  function runDeid(item, resetPage) {
    if (typeof item === 'boolean' || item == null) { resetPage = item; item = state.current; }
    if (!item) return Promise.resolve();
    state.current = item;
    const gen = ++item.gen;
    item.running = true;
    const prog = $('prog'); prog.classList.remove('hidden'); prog.firstElementChild.style.width = '30%';
    $('verdict').classList.remove('hidden');
    $('run').disabled = true; $('runInfo').textContent = 'Working…';
    if (item.table && item.table.rows.length > BIG_ROWS) {
      $('stopRun').classList.remove('hidden');
      $('verdictBody').innerHTML = `<div class="verdict">Working on ${item.table.rows.length.toLocaleString()} rows. The page stays usable; downloads are off until the check has finished.</div>`;
    }
    setDownloadState();
    return enqueue(async () => {
      if (item.gen !== gen || !session.items.includes(item)) return;
      await new Promise((r) => setTimeout(r, 30)); // let the page paint "Working…"
      if (item.gen !== gen || !session.items.includes(item)) return;
      const t0 = performance.now();
      const onProgress = (text, frac) => { if (state.current !== item || item.gen !== gen) return; $('runInfo').textContent = text; if (frac != null) prog.firstElementChild.style.width = `${Math.round(10 + 90 * clamp(frac, 0, 1))}%`; };
      try {
        const done = await processItem(item, { progress: onProgress });
        if (!done || item.gen !== gen) return; // superseded: the newer run shows its own result
        item.running = false;
        prog.firstElementChild.style.width = '100%';
        if (item.firstRun && item.result) { $('reviewFilter').value = item.flagged > 0 ? 'model' : 'all'; item.firstRun = false; }
        if (resetPage) state.page = 1;
        if (state.current === item) {
          if (item.table && item.columns) renderColumns(item);
          if (item.error) { renderError(item); $('runInfo').innerHTML = `<span class="bad">Error: ${esc(item.error.message)}</span>`; }
          else {
            renderVerdict(item); renderSummary(item); renderReview(item); renderExport(item);
            ['reviewCard', 'exportCard'].forEach((id) => $(id).classList.remove('hidden'));
            $('runInfo').textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
          }
          $('run').classList.toggle('hidden', !item.error);
        }
        renderSession();
      } catch (e) {
        // a fault while showing the result counts as a fault of the run: nothing from this input may be downloaded
        if (item.gen !== gen) return;
        failItem(item, e); item.running = false;
        if (state.current === item) {
          try { renderError(item); } catch (e2) { console.warn(e2); }
          $('runInfo').innerHTML = `<span class="bad">Error: ${esc(item.error.message)}</span>`; $('run').classList.remove('hidden');
        }
        try { renderSession(); } catch (e3) { console.warn(e3); }
      } finally {
        if (item.gen === gen) {
          item.running = false;
          $('run').disabled = false; $('stopRun').classList.add('hidden');
          if (state.queueActive) $('runInfo').textContent = 'Reading…'; else hideWorking();
          prog.firstElementChild.style.width = '100%';
          setTimeout(() => { if (!item.running) { prog.classList.add('hidden'); prog.firstElementChild.style.width = '0%'; } }, 400);
          setDownloadState();
        }
      }
    });
  }
  $('run').addEventListener('click', () => runDeid(state.current, true));
  // Stop a long run: the input keeps no result (nothing from it can be downloaded) until it is run again.
  $('stopRun').addEventListener('click', () => {
    const it = state.current; if (!it || !it.running) return;
    it.gen++; it.running = false;
    failItem(it, new Error('Stopped before the check had finished'));
    $('stopRun').classList.add('hidden'); $('run').disabled = false; $('prog').classList.add('hidden');
    showItem(it);
    $('runInfo').innerHTML = '<span class="bad">Stopped. Nothing from this input can be downloaded until it is run again.</span>'; $('run').classList.remove('hidden');
  });
  // Every input again (a setting, a word list, the patient list or a restored key changed): the others first, in the queue,
  // then the one on screen.
  function rerunAll() {
    const others = session.items.filter((it) => it !== state.current && it.table);
    others.forEach((it) => { it.running = true; });
    if (others.length) {
      setDownloadState();
      enqueue(async () => {
        for (const it of others) {
          if (!session.items.includes(it)) continue;
          const g = it.gen;
          try { await processItem(it, { noHeal: true }); } finally { if (it.gen === g) it.running = false; }
        }
        renderSession();
      });
    }
    if (state.current) runDeid(state.current, false); else renderSession();
  }

  // ------------------------------------------------------------ verdict + summary
  const releaseIds = (item) => (item && item.release ? item.release.identifiers : []);
  const isRed = (item) => !!item && ((!!item.leak && item.leak.hits.length > 0) || releaseIds(item).length > 0);
  const surviving = (item) => (item && item.release ? item.release.words : []);
  // Green needs patients to check against: the input's own, or any the session already knows (patient list, earlier inputs).
  // With none at all the check had nothing to look for, so the verdict is amber, never green.
  const checkedAgainst = (item) => { const c = item && item.result && item.result.census; return c ? c.patients.size + (c.known ? c.known.size : 0) : 0; };
  // A spreadsheet with rows but no patient of its own (no name or record number column was found or chosen) is never green:
  // the check can only look for patients it knows, and the names in such a table are none of them. Its downloads stay off
  // until a name or record number column is chosen (or the compliance override is on).
  const noOwnPatients = (item) => !!item && item.kind === 'table' && !!item.result && !!item.table && item.table.rows.length > 0 && !!item.result.census && item.result.census.patients.size === 0;
  const isAmber = (item) => !!item && !!item.result && !!item.leak && !item.error && !isRed(item) && (checkedAgainst(item) === 0 || noOwnPatients(item));
  // Review required: text or a screenshot with no patient list (names found by rules alone), or source words that survived
  // the protection and are not ordinary words. Downloads then need a person to say they looked, for this exact result.
  const needsReview = (item) => !!item && !!item.result && !item.error && !isRed(item) && (isAmber(item) || surviving(item).length > 0);
  const reviewed = (item) => !!item && !!item.resultKey && item.ackKey === item.resultKey;
  // Why an input may not be downloaded right now ('' when it may). Every export path asks this itself.
  function blockReason(it, override) {
    if (!it) return 'Nothing to download yet';
    if (it.error) return 'This input could not be processed. Run it again first.';
    if (it.running) return 'Still working…';
    if (!it.result || !it.leak) return 'Not protected yet';
    if (isGated(it)) return 'Confirm columns first';
    if (!it.resultKey || it.resultKey !== resultKey(it)) return 'Something changed after this was checked (settings, patients or edits). Run it again first.';
    if (isRed(it) && !override) return 'Fix the identifiers that still appear first';
    if (noOwnPatients(it) && !override) return 'Choose the column that holds patient names or record numbers first';
    if (needsReview(it) && !reviewed(it)) return 'Review required: look over the flagged text, then press "I have reviewed this"';
    return '';
  }
  const allBlockReason = (override) => (!session.items.length ? 'Nothing to download yet' : session.items.map((x) => blockReason(x, override)).find(Boolean) || '');
  const DL_LABEL = 'Download protected file (.xlsx)';
  function setDownloadState() {
    const it = state.current; const override = $('optOverride').checked;
    const set = (id, dis, title) => { const b = $(id); b.disabled = !!dis; b.title = dis ? title : ''; };
    const reason = blockReason(it, override);
    ['dlXlsx', 'dlCsv', 'dlTxt', 'dlNow'].forEach((id) => set(id, !!reason, reason));
    set('dlReport', !!reason, reason);
    $('verdictActions').classList.toggle('hidden', !!reason || isRed(it));
    const allReason = allBlockReason(override);
    set('dlAll', !!allReason, allReason);
    // amber: downloads stay allowed, but the buttons say what the check could not do
    const amber = !reason && isAmber(it);
    $('dlNow').textContent = amber ? 'Download (.xlsx): reviewed, no patient list' : DL_LABEL;
    $('dlXlsx').textContent = amber ? `${DL_LABEL}: reviewed, no patient list` : DL_LABEL;
    $('dlAmber').textContent = amber ? 'Not checked against a patient list: names were found by rules only and a person reviewed the result. Add today\'s schedule under Patient list to make the check real.' : '';
  }
  function renderError(item) {
    $('verdict').classList.remove('hidden');
    $('verdictBody').innerHTML = `<div class="verdict bad"><b>Blocked: this input could not be processed.</b> Error: ${esc(item.error.message)}. Nothing from it can be downloaded, and Download all stays off, until it runs without an error. <span class="lnk" id="retryRun">Try again</span> · <span class="lnk" id="removeItem">Remove this input</span></div>`;
    $('verdictActions').classList.add('hidden');
    $('summary').innerHTML = '';
    $('reviewCard').classList.add('hidden');
    $('exportCard').classList.remove('hidden');
    $('dlTxt').classList.toggle('hidden', item.kind === 'table');
    $('dlNudge').textContent = ''; $('dlNote').textContent = 'This input could not be processed, so there is nothing to download from it.';
    $('datesLine').textContent = datesLabel();
    $('retryRun').addEventListener('click', () => runDeid(item, true));
    $('removeItem').addEventListener('click', () => {
      dropItem(item);
      if (state.current) showItem(state.current);
      else { ['ocrCard', 'colsCard', 'verdict', 'reviewCard', 'exportCard'].forEach((id) => $(id).classList.add('hidden')); $('drop').classList.remove('compact'); $('runInfo').textContent = ''; }
      renderSession();
    });
    setDownloadState();
  }
  function renderVerdict(item) {
    const L = item.leak; const n = L.patients;
    $('verdict').classList.remove('hidden');
    if (!L.hits.length && noOwnPatients(item)) {
      $('verdictBody').innerHTML = `<div class="verdict amber"><b>No patient column</b> – no patient names or record numbers were found in this table, so the check had nothing to look for and names in it may pass through. Choose the column that holds them under <span class="lnk" data-cols="1">Columns</span>; downloads stay off until then.</div>`;
      $('verdictBody').querySelectorAll('[data-cols]').forEach((a) => a.addEventListener('click', () => { $('colsDetails').open = true; $('colsCard').scrollIntoView({ block: 'center' }); }));
      $('verdictActions').classList.add('hidden');
    } else if (!isRed(item) && needsReview(item)) {
      const words = surviving(item);
      const why = [isAmber(item) ? `no patient list, so names were found by rules only (paste today's schedule under <span class="lnk" data-roster="1">Patient list</span> to make the check real)${item.kind === 'image' ? '; the check covers only the text that could be read' : ''}` : '',
        words.length ? `${plural(words.length, 'word from the source survived', 'words from the source survived')} that ${words.length === 1 ? 'is' : 'are'} not an ordinary or medical word: ${words.slice(0, 12).map((w) => `<span class="lnk" data-word="${esc(w.text)}">${esc(w.text)}</span>${w.count > 1 ? ` ×${w.count}` : ''}`).join(', ')}${words.length > 12 ? ', …' : ''}. If any is a name or place, mark it in the review below` : ''].filter(Boolean);
      const done = reviewed(item);
      $('verdictBody').innerHTML = `<div class="verdict amber"><b>Review required</b> – ${why.join('; and ')}.${item.flagged > 0 ? ` ${plural(item.flagged, 'line is', 'lines are')} flagged below.` : ''}<div style="margin-top:8px">${done ? '<span class="ok">Reviewed. Downloads are on for this result.</span>' : '<button id="ackReview" class="secondary">I have reviewed this</button> <span class="small muted">Downloads stay off until then. A new run needs a new review.</span>'}</div></div>`;
      $('verdictBody').querySelectorAll('[data-roster]').forEach((a) => a.addEventListener('click', openRoster));
      $('verdictBody').querySelectorAll('[data-word]').forEach((a) => a.addEventListener('click', () => { $('reviewFilter').value = 'all'; $('reviewSearch').value = a.dataset.word; state.page = 1; renderReview(item); $('reviewCard').scrollIntoView({ block: 'start' }); }));
      const ack = $('ackReview'); if (ack) ack.addEventListener('click', () => { item.ackKey = item.resultKey; item.viewedReview = true; renderVerdict(item); });
      $('verdictActions').classList.toggle('hidden', isGated(item) || !done);
      $('toReview').textContent = item.flagged > 0 ? `${plural(item.flagged, 'line needs', 'lines need')} a look first` : 'Nothing needs a look';
    } else if (!isRed(item)) {
      $('verdictBody').innerHTML = `<div class="verdict ok"><b>Release check passed:</b> none of your ${plural(n, "patient's", "patients'")} names, nicknames, initials, MRNs, phone numbers, account numbers or birthdates appear in the output, in any spacing or spelling the page can predict.${item.kind === 'image' ? ' (from the text we could read)' : ''}${L.providerHits.length ? `<div class="small muted" style="margin-top:6px">${plural(L.providerHits.length, 'staff name still appears', 'staff names still appear')}; staff names are not patient identifiers but you may want to look.</div>` : ''}${L.coincidences.length ? `<div class="small muted" style="margin-top:6px">${plural(L.coincidences.length, 'shifted date', 'shifted dates')} in other patients' rows happen to equal a birthdate in the file (row ${L.coincidences.map((c) => c.row + 1).slice(0, 5).join(', ')}); nothing links them to that patient.</div>` : ''}</div>`;
      const gated = isGated(item);
      $('verdictActions').classList.toggle('hidden', gated);
      $('toReview').textContent = item.flagged > 0 ? `${plural(item.flagged, 'line needs', 'lines need')} a look first` : 'Nothing needs a look';
    } else {
      const allHits = L.hits.concat(releaseIds(item).map((h) => Object.assign({ kind: 'release' }, h)));
      const unnamed = allHits.filter((h) => h.kind === 'unnamed'), others = allHits.filter((h) => h.kind !== 'unnamed');
      const list = allHits.slice(0, 50).map((h, i) => h.kind === 'unnamed' ? `<li>Row ${h.row + 1}: the patient's name could not be read, only the record number. Check the line and add the name as patient info if it is there. <span class="lnk" data-show="${i}">Show</span></li>` : `<li>${h.row >= 0 ? `Row ${h.row + 1}, ${esc(h.header)}` : esc(h.header || 'Column heading')}: "${esc(h.text)}" (${TYPE_UI[h.type] || h.type}) <span class="lnk" data-show="${i}">Show</span></li>`).join('');
      const head = others.length ? `${plural(others.length, 'patient identifier still appears', 'patient identifiers still appear')} in the output.` : '';
      const head2 = unnamed.length ? ` ${plural(unnamed.length, "patient's name", "patients' names")} could not be read, so the check cannot vouch for ${unnamed.length === 1 ? 'it' : 'them'}.` : '';
      $('verdictBody').innerHTML = `<div class="verdict bad"><b>Blocked:</b> ${head}${head2} Fix this below before downloading.<ul>${list}</ul>${$('optOverride').checked ? '<div class="small warn" style="margin-top:6px">Compliance override is on: downloads are allowed and the run summary records it.</div>' : ''}</div>`;
      $('verdictActions').classList.add('hidden');
      $('verdictBody').querySelectorAll('[data-show]').forEach((a) => a.addEventListener('click', () => { const h = allHits[+a.dataset.show]; $('reviewFilter').value = 'all'; $('reviewSearch').value = h.kind === 'unnamed' ? '' : h.text; state.page = 1; renderReview(item); const td = $('reviewTable').querySelector(`td[data-row="${h.row}"]`); if (td) td.scrollIntoView({ block: 'center' }); }));
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
  // every protected file goes through here: the offset never leaves the page and no cell can start a formula
  function aoaOut(item) {
    const r = item.result; const ai = r.headers.indexOf('DeID Audit');
    return safeAoa([r.headers, ...r.rows.map((row) => { if (ai < 0) return row; const o = row.slice(); o[ai] = String(o[ai] == null ? '' : o[ai]).replace(AUDIT_OFFSET, ' | dates shifted'); return o; })]);
  }
  // each export path asks for itself, not only through the disabled buttons
  function exportBlocked(item) {
    const why = blockReason(item, $('optOverride').checked);
    if (why) notice(`Not downloaded: ${esc(why)}`, 'warn');
    return !!why;
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
    const item = state.current; if (exportBlocked(item)) return;
    if (item.flagged > 0 && !item.viewedReview) $('dlNudge').textContent = `You have not looked at the ${item.flagged} line${item.flagged === 1 ? '' : 's'} flagged above. The file downloaded anyway.`;
    releaseExport([item], 'xlsx');
  });
  // CSV written here, not by SheetJS: every field holding a quote, comma, line feed or a bare carriage return is quoted
  // (RFC 4180), so a line break inside a cell can never start a new record whose first cell is a formula; every field
  // goes through the formula guard as well
  const csvValue = (v) => String(safeCell(v == null ? '' : v instanceof Date ? String(fmtDate(v)) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)));
  function csvText(aoa) {
    const field = (v) => { const x = csvValue(v); return /[",\r\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    return aoa.map((r) => (Array.isArray(r) ? r : [r]).map(field).join(',')).join('\r\n') + '\r\n';
  }
  // RFC 4180 reader, used only to read back what csvText wrote
  function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; continue; }
      if (ch === '"') q = true; else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\r' && text[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; }
      else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  }
  const txtOut = (item) => {
    const li = item.result.headers.indexOf('Line');
    // every line is guarded, including a line that starts after a break inside a cell
    return item.result.rows.map((r) => DeID.cellToString(r[li < 0 ? 0 : li]).split(/\r\n|\r|\n/).map(safeCell).join('\n')).join('\n');
  };
  $('dlCsv').addEventListener('click', () => releaseExport([state.current], 'csv'));
  $('dlTxt').addEventListener('click', () => releaseExport([state.current], 'txt'));

  // ------------------------------------------------------------ release
  // Every protected download goes through here. It asks again whether each input may leave (fresh result, check passed,
  // review done), builds the file, reads the written bytes back with an independent reader, and checks them: same sheets,
  // same cells, no formulas, and none of the identifier-column values (names, MRNs, accounts, phones) anywhere. Only then is
  // the file handed to the browser. Any failure downloads nothing.
  function mergedNeedles(items) {
    const d = new Set(), n = new Set();
    items.forEach((it) => { const nd = it.release && it.release.needles; if (!nd) return; nd.digits.forEach((x) => d.add(x)); nd.names.forEach((x) => n.add(x)); });
    return { digits: [...d], names: [...n] };
  }
  function verifyGrid(expect, got, label) {
    if (got.length < expect.length) throw new Error(`${label}: ${expect.length - got.length} rows missing after writing`);
    let bad = 0;
    expect.forEach((row, r) => (Array.isArray(row) ? row : [row]).forEach((v, c) => {
      if (v == null || v === '' || v instanceof Date) return;
      const g = (got[r] || [])[c];
      if (typeof v === 'number' ? Number(g) !== v : String(g == null ? '' : g) !== String(v)) bad++;
    }));
    if (bad) throw new Error(`${label}: ${bad} cells differ after writing`);
  }
  function releaseExport(items, kind) {
    items = items.filter(Boolean);
    const override = $('optOverride').checked;
    if (!items.length) { notice('Not downloaded: nothing to download yet', 'warn'); return false; }
    for (const it of items) { const why = blockReason(it, override); if (why) { notice(`Not downloaded${items.length > 1 ? ` (input ${it.n})` : ''}: ${esc(why)}`, 'warn'); return false; } }
    const needles = override && items.some(isRed) ? { digits: [], names: [] } : mergedNeedles(items);
    try {
      let blob, name;
      if (kind === 'xlsx' || kind === 'all') {
        const wb = XLSX.utils.book_new(); const expect = [];
        items.forEach((it) => { const aoa = aoaOut(it); expect.push(aoa); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { cellDates: true }), kind === 'all' ? `Input ${it.n}` : 'Protected'); });
        const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true });
        const back = XLSX.read(bytes, { type: 'array', cellFormula: true, cellDates: true });
        if (back.SheetNames.join('|') !== wb.SheetNames.join('|')) throw new Error('the written workbook has different sheets');
        back.SheetNames.forEach((sn, i) => {
          const ws = back.Sheets[sn];
          Object.keys(ws).forEach((k) => { if (k[0] !== '!' && ws[k] && ws[k].f) throw new Error(`a formula was found in ${sn}!${k}`); });
          const got = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '', blankrows: true });
          verifyGrid(expect[i], got, sn);
          got.forEach((row) => row.forEach((v) => { if (typeof v === 'string' && FORMULA_START.test(v)) throw new Error(`a cell in ${sn} starts like a formula`); }));
          const hits = DeID.findNeedles(got, needles); if (hits.length) throw new Error(`an identifier from the patient columns is in ${sn}, row ${hits[0].row + 1}`);
        });
        blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        name = kind === 'all' ? `protected_${today()}_all.xlsx` : `${fileStamp(items[0])}.xlsx`;
      } else {
        const item = items[0];
        const text = kind === 'csv' ? csvText(aoaOut(item)) : kind === 'txt' ? txtOut(item) : reportLines(item).join('\n');
        if (kind === 'csv') {
          const exp = aoaOut(item).map((r) => (Array.isArray(r) ? r : [r]).map(csvValue));
          const got = parseCsv(text);
          if (got.length !== exp.length) throw new Error(`the written CSV has ${got.length} records, not ${exp.length}`);
          verifyGrid(exp, got, 'CSV');
          got.forEach((row) => row.forEach((v) => { if (FORMULA_START.test(v)) throw new Error('a CSV field starts like a formula'); }));
        } else {
          text.split('\n').forEach((l) => { if (FORMULA_START.test(l)) throw new Error('a line starts like a formula'); });
        }
        const hits = DeID.findNeedles(text.split(/\r?\n/).map((l) => [l]), needles); if (hits.length) throw new Error(`an identifier from the patient columns is in line ${hits[0].row + 1}`);
        blob = new Blob([text], { type: kind === 'csv' ? 'text/csv' : 'text/plain' });
        name = `${fileStamp(item)}${kind === 'csv' ? '.csv' : kind === 'txt' ? '.txt' : '_report.txt'}`;
      }
      download(blob, name);
      items.forEach((it) => { it.releasedKey = it.resultKey; });
      return true;
    } catch (e) {
      notice(`Not downloaded: the check of the written file failed (${esc((e && e.message) || e)}). Nothing was saved.`, 'danger');
      return false;
    }
  }
  function reportLines(item) {
    const r = item.result, s = r.stats, L = item.leak;
    const kind = item.kind === 'image' ? 'screenshot' : item.kind === 'text' ? 'pasted text' : 'spreadsheet';
    const self = L.hits.length ? ($('optOverride').checked ? 'overridden' : `FAILED (${L.hits.length} identifiers)`) : noOwnPatients(item) ? 'no patient column (no names or record numbers to check against)' : isAmber(item) ? 'no patients to check against (no patient list; names found by rules only)' : 'passed';
    return [`Infusion De-ID run report · no patient data`, `Tool version: ${DeID.VERSION}`, `Run at: ${new Date().toISOString()}`,
      `Input ${item.n} of ${session.items.length}: ${kind}, ${s.rows} rows, ${r.headers.length} columns`,
      `Release profile: ${$('optDates').value === 'shift' ? 'research pseudonymization (dates shifted per patient, intervals kept). This is NOT HIPAA Safe Harbor: shifted dates are still dates.' : 'HIPAA Safe Harbor rules applied by the tool (every date removed; birth year only below age 90; ages 90+ grouped; ZIP to 3 digits, restricted areas to 000). Safe Harbor also requires that you have no actual knowledge the rest could identify someone.'}`,
      `Release scan (independent of the detectors): ${releaseIds(item).length} identifier-column values found in the output; ${surviving(item).length} unrecognised source words survived${needsReview(item) ? `; review ${reviewed(item) ? 'done' : 'NOT done'}` : ''}`,
      `Self-check: ${self}`, `Self-check overridden: ${L.hits.length && $('optOverride').checked ? 'yes' : 'no'}`,
      `Patients in this input: ${r.census.patients.size}; patients in the session: ${session.registry.size}; on the patient list: ${session.roster.ids.size}; checked against: ${checkedAgainst(item)}; providers: ${r.census.providers.size}`, '',
      // the headings as they were written to the protected file, never the input's: a heading can hold patient information
      'Column roles (protected headings):', ...r.columns.map((c, i) => `  ${i + 1}. ${DeID.cellToString(r.headers[c.index != null ? c.index : i])}: ${c.role}`), '',
      `MRN pattern: ${r.cfg.inferredMrnPattern || r.cfg.mrnPattern || 'none'}`, `Options: ${JSON.stringify(r.cfg.surrogate)}`,
      `Always-remove words: ${(r.cfg.denylist || []).length}; never-remove words: ${(r.cfg.allowlist || []).length}`, `Manual review edits: ${Object.keys(item.manual).length} cells`, '',
      'Identifiers replaced in free text by type:', ...Object.entries(s.byType).map(([k, v]) => `  ${k}: ${v}`), 'By layer:', ...Object.entries(s.bySource).map(([k, v]) => `  ${k}: ${v}`), 'Structured columns:', ...Object.entries(s.structured).map(([k, v]) => `  ${k}: ${v}`), '',
      'This report contains no patient data. The session key does.'];
  }
  $('dlReport').addEventListener('click', () => releaseExport([state.current], 'report'));
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }

  // ------------------------------------------------------------ session strip, key, panel
  function renderSession() {
    const s = $('session'); const show = session.items.length > 0 || session.registry.size > 0;
    s.classList.toggle('hidden', !show);
    if (show) $('sessionText').textContent = `This session: ${session.registry.size} patients · ${session.roster.ids.size ? `Patient list: ${plural(session.roster.ids.size, 'patient', 'patients')}` : 'No patient list'} · ${session.items.length} sources · ${session.keySaved ? 'key saved' : 'key not saved'} · ${$('optDates').value === 'shift' ? 'Dates: shifted' : 'Dates: removed (Safe Harbor)'}`;
    setDownloadState();
    if (!$('sessionPanel').classList.contains('hidden')) renderSessionPanel();
    layoutStrip();
  }
  function mergedMapping() {
    // the registry holds every replacement of the session: patients, providers, third-party names, organizations, places, ids
    // a column is also listed under its protected header when the header itself held patient information (Restore identities
    // finds columns by the headers of the protected file)
    const cols = new Map(); session.items.forEach((it) => (it.columns || []).forEach((c, i) => {
      if (!cols.has(c.header)) cols.set(c.header, { header: c.header, role: c.role });
      const out = it.result && Array.isArray(it.result.headers) ? it.result.headers[c.index != null ? c.index : i] : null;
      if (out != null && out !== c.header && !cols.has(out)) cols.set(out, { header: out, role: c.role });
    }));
    return { patients: session.registry.toMappingRows(), providers: session.registry.toProviderRows(), others: session.registry.toOtherRows(), meta: { seed: session.seed, docOffset: session.registry.docOffset == null ? '' : session.registry.docOffset, processedAt: new Date().toISOString(), mrnPattern: session.mrnPattern || '', columns: [...cols.values()], keySaves: session.keySaves + 1 } };
  }
  $('dlMap').addEventListener('click', () => {
    const m0 = mergedMapping();
    const guard = (rows) => rows.map((r) => mapValues(r, localSafeCell));
    const m = Object.assign({}, m0, { patients: guard(m0.patients), providers: guard(m0.providers), others: guard(m0.others) });
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
    // all or nothing: one input that errored, is still running, is unconfirmed or fails its check stops the whole download
    const why = allBlockReason($('optOverride').checked);
    if (why) { notice(`Not downloaded: ${esc(why)}`, 'warn'); return; }
    releaseExport(session.items.slice(), 'all');
  });
  function restoreSession(wb) {
    const toJson = (name) => (wb.Sheets[name] ? sheetObjects(wb.Sheets[name]).map((r) => mapValues(r, unsafeCell)) : []);
    const metaAoa = wb.Sheets.Meta ? sheetToAoa(wb.Sheets.Meta) : [];
    let meta = {}; try { meta = JSON.parse((metaAoa[1] || [])[0] || '{}'); } catch (e) {}
    const patients = toJson('Patients').filter((p) => p.Code);
    session.registry = DeID.createRegistry(patients, { providers: toJson('Providers').filter((p) => p.SurrogateName && p.RealName), others: toJson('Others').filter((o) => o.Surrogate && o.Original) });
    session.baseSeed = parseInt(meta.seed, 10) || randomSeed(); $('optSeed').value = ''; session.seed = session.baseSeed;
    // rows with no patient shift by the session's document offset: restored from the key when it carries one
    if (meta.docOffset !== '' && meta.docOffset != null && !isNaN(+meta.docOffset)) session.registry.docOffset = +meta.docOffset;
    session.mrnPattern = meta.mrnPattern || null;
    session.keySaves = parseInt(meta.keySaves, 10) || 0;
    session.keyStamp = keyStamp();
    refreshOffsets();
    // the patient list named entities of the old registry: apply it again to the restored one
    const sources = session.roster.sources; session.roster.ids = new Set();
    sources.forEach((t) => { try { seedRoster(t); } catch (e) { console.warn(e); } });
    notice(`Session restored: ${patients.length} patients from the key. New files will reuse their codes, made-up names and date offsets.`, '');
    $('runInfo').textContent = '';
    if (session.items.length) rerunAll(); else renderSession();
  }
  $('continueKey').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { restoreSession(await readWorkbook(f)); } catch (err) { notice(`Could not read the key: ${esc(err.message)}`, 'danger'); } });
  function startOver() {
    session.items.forEach((it) => { it.gen++; it.running = false; });
    session.registry = DeID.createRegistry(); session.items.length = 0; session.mrnPattern = null; session.baseSeed = randomSeed(); session.seed = seedNow(); session.roster = { ids: new Set(), sources: [] }; session.keyStamp = null; session.keySaves = 0; session.startedAt = new Date().toISOString();
    state.current = null; state.page = 1; state.reidPreload = null;
    ['working', 'ocrCard', 'colsCard', 'verdict', 'reviewCard', 'exportCard', 'sessionPanel', 'newSessionConfirm'].forEach((id) => $(id).classList.add('hidden'));
    $('drop').classList.remove('compact'); notice(''); $('runInfo').textContent = ''; $('dlNudge').textContent = '';
    $('rosterBox').classList.add('hidden'); $('rosterText').value = ''; rosterNotice('');
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
    const seen = (e) => session.items.filter((it) => it.result && it.result.census.patients.has(e.id)).map((it) => `${it.name} (${it.result.census.patients.get(e.id).rows.length})`).concat(session.roster.ids.has(e.id) ? ['patient list'] : []).join('; ');
    const nr = session.roster.ids.size;
    $('rosterPanelInfo').textContent = nr ? `${plural(nr, 'patient', 'patients')} from today's schedule or roster.` : 'None yet: protected text and screenshots are then checked by rules only.';
    const linked = (e) => { let how = ''; session.items.forEach((it) => { if (it.linkedBy && it.linkedBy[e.id] && it.linkedBy[e.id] !== 'new') how = it.linkedBy[e.id]; }); return how; };
    $('patientsTable').innerHTML = '<tr><th>Code</th><th>Made-up name</th><th>Real name</th><th>MRN</th><th>Seen in</th><th>Linked by</th></tr>' + session.registry.entities.map((e) => {
      const how = linked(e); const amber = how === 'similar name';
      return `<tr class="${amber ? 'amber' : ''}"><td>${esc(e.code)}</td><td>${esc(e.fakeLast ? `${e.fakeLast}, ${e.fakeFirst}` : '')}</td><td>${hide ? '••••' : esc([...e.names].join('; '))}</td><td>${hide ? '••••' : esc([...e.mrns].join('; '))}</td><td class="small">${esc(seen(e))}</td><td class="small">${esc(how)}${amber ? ` <button class="btn small" data-same="${e.id}">Same person</button>${typeof session.registry.split === 'function' ? ` <button class="btn small" data-split="${e.id}">Different people</button>` : ''}` : ''}</td></tr>`;
    }).join('');
    $('patientsTable').querySelectorAll('[data-same]').forEach((b) => b.addEventListener('click', () => { session.items.forEach((it) => { if (it.linkedBy) it.linkedBy[b.dataset.same] = 'confirmed'; }); renderSessionPanel(); }));
    $('sourcesList').innerHTML = session.items.map((it) => `<div class="row" style="margin-top:4px"><span>${it.n}. ${esc(it.name)} <span class="muted">(${it.kind === 'image' ? 'screenshot' : it.kind === 'text' ? 'text' : 'spreadsheet'}, ${it.table ? it.table.rows.length : 0} rows)</span></span>${it.error ? '<span class="bad">could not be processed</span>' : it.result ? `<span class="lnk" data-dl="${it.id}">Download</span>` : '<span class="muted">working…</span>'}<span class="lnk" data-showitem="${it.id}">Show</span></div>`).join('') || '<span class="muted">No sources yet.</span>';
    $('sourcesList').querySelectorAll('[data-dl]').forEach((a) => a.addEventListener('click', () => { const it = session.items.find((x) => x.id === a.dataset.dl); releaseExport([it], 'xlsx'); }));
    $('sourcesList').querySelectorAll('[data-showitem]').forEach((a) => a.addEventListener('click', () => { const it = session.items.find((x) => x.id === a.dataset.showitem); if (it) { showItem(it); if (it.result) { $('runInfo').textContent = 'Shown'; } window.scrollTo(0, 0); } }));
  }
  window.addEventListener('beforeunload', (e) => { if ((session.items.length > 0 || session.registry.size > session.roster.ids.size) && !session.keySaved) { e.preventDefault(); e.returnValue = 'The session key has not been saved. Leave anyway?'; } });

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
      const fixLines = res.lines.map((l) => Object.assign({}, l, { text: DeID.normalizeOcrText(l.text) }));
      const fixedText = DeID.normalizeOcrText(res.text);
      item.ocr = { lines: fixLines, confidence: res.confidence, text: fixedText, edited: false };
      stage('Finding patients…');
      buildTextItem(item, `=== screenshot ${item.n} ===\n${fixedText}`);
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
  // (the consistency number is not among the saved settings: see randomSeed)
  const OPT_IDS = ['optPatients', 'optProviders', 'optDates', 'optDob', 'optAges', 'optRange', 'optDerive'];
  function seedNow() { const v = String($('optSeed').value || '').trim(); const n = parseInt(v, 10); return /^\d{1,9}$/.test(v) && n > 0 ? n : session.baseSeed; }
  (function initOpts() {
    try { const o = JSON.parse(lsGet('deid:opts') || '{}'); OPT_IDS.forEach((id) => { if (o[id] == null) return; const el = $(id); if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = o[id]; }); } catch (e) {}
    $('optDeny').value = lsGet('deid:deny') || ''; $('optAllow').value = lsGet('deid:allow') || '';
  })();
  function saveOpts() { const o = {}; OPT_IDS.forEach((id) => { const el = $(id); o[id] = el.type === 'checkbox' ? el.checked : el.value; }); lsSet('deid:opts', JSON.stringify(o)); lsSet('deid:deny', $('optDeny').value); lsSet('deid:allow', $('optAllow').value); }
  // An entity first processed while dates were removed carries offset 0; once shifting is on it needs a real offset,
  // or its real dates would pass through under a "Dates: shifted" label.
  function refreshOffsets() { if ($('optDates').value === 'shift') session.registry.entities.forEach((e) => { if (e.offset === 0) e.offset = null; }); }
  OPT_IDS.concat(['optDeny', 'optAllow', 'optMrn', 'optSeed']).forEach((id) => $(id).addEventListener('change', () => { saveOpts(); session.seed = seedNow(); refreshOffsets(); rerunAll(); }));
  session.seed = seedNow();
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
      const toJson = (name) => (mwb.Sheets[name] ? sheetObjects(mwb.Sheets[name]).map((r) => mapValues(r, unsafeCell)) : []);
      const metaAoa = mwb.Sheets.Meta ? sheetToAoa(mwb.Sheets.Meta) : [];
      let meta = {}; try { meta = JSON.parse((metaAoa[1] || [])[0] || '{}'); } catch (e) {}
      const mapping = { patients: toJson('Patients').filter((p) => p.Code), providers: toJson('Providers').filter((p) => p.SurrogateName), others: toJson('Others').filter((o) => o.Surrogate), meta };
      const aoa = sheetToAoa(wb.Sheets[wb.SheetNames[0]]).map((r) => (Array.isArray(r) ? r.map(unsafeCell) : r));
      if (!aoa.length || !Array.isArray(aoa[0])) throw new Error('the protected workbook is empty');
      const headers = aoa[0].map((h) => String(h == null ? '' : h)), rows = aoa.slice(1);
      const out = DeID.reidentify({ headers, rows }, mapping);
      const ws = XLSX.utils.aoa_to_sheet(safeAoa([out.headers, ...out.rows]), { cellDates: true });
      const owb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(owb, ws, 'Re-identified');
      XLSX.writeFile(owb, `restored_${today()}.xlsx`, { cellDates: true });
      $('reidOut').innerHTML = `<span class="ok">Restored ${rows.length} rows using ${mapping.patients.length} patient codes, ${mapping.providers.length} providers and ${mapping.others.length} other replacements.</span>`;
    } catch (e) { console.warn(e); $('reidOut').innerHTML = `<span class="bad">Error: ${esc((e && e.message) || e)}</span>`; }
  });

  renderSession();
  // Expose for automated tests. failNext('process' | 'check'): the next protect run (or the next check of a result) throws.
  window.__deid = {
    state, runDeid, collectConfig, addItem: addInput, addInputs, leakCheck, session, processItem, rerunAll, addRoster, blockReason,
    failNext: (what, n) => { const k = what === 'check' || what === 'selfcheck' ? 'check' : 'process'; testHooks[k] = n == null ? 1 : n; return testHooks[k]; },
  };
})();
