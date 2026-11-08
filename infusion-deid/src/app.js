/* Infusion De-ID — browser UI. Depends on XLSX (SheetJS), DeID, DeIDSynth, DeIDEval. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (x, d) => (x == null ? '–' : (x * 100).toFixed(d == null ? 1 : d) + '%');
  const fmtDate = (v) => (v instanceof Date ? `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}` : v);

  const state = { wb: null, fileName: '', sheet: null, headerRow: 0, table: null, columns: null, result: null, manual: {}, page: 1, synth: null, synthResult: null };

  // ------------------------------------------------------------ tabs
  document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('section.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + b.dataset.tab));
  }));
  $('verInfo').textContent = `Infusion De-ID ${DeID.VERSION} · built ${document.documentElement.dataset.built || 'from source'}`;
  $('verFoot').textContent = `v${DeID.VERSION}`;

  // ------------------------------------------------------------ file loading
  function readWorkbook(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(r.error);
      r.onload = () => { try { resolve(XLSX.read(new Uint8Array(r.result), { type: 'array', cellDates: true, raw: false })); } catch (e) { reject(e); } };
      r.readAsArrayBuffer(file);
    });
  }
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
  async function loadFile(file) {
    try {
      state.wb = await readWorkbook(file); state.fileName = file.name;
      $('fileInfo').textContent = `${file.name} · ${(file.size / 1024).toFixed(0)} KB · ${state.wb.SheetNames.length} sheet(s)`;
      const sel = $('sheetSel'); sel.innerHTML = state.wb.SheetNames.map((n) => `<option>${esc(n)}</option>`).join('');
      $('sheetRow').style.display = '';
      selectSheet(state.wb.SheetNames[0]);
    } catch (e) { alert('Could not read file: ' + e.message); }
  }
  function selectSheet(name, headerRow) {
    state.sheet = name;
    const aoa = sheetToAoa(state.wb.Sheets[name]);
    state.aoa = aoa;
    state.headerRow = headerRow == null ? detectHeaderRow(aoa) : headerRow;
    const hs = $('headerSel'); hs.innerHTML = aoa.slice(0, Math.min(15, aoa.length)).map((r, i) => `<option value="${i}" ${i === state.headerRow ? 'selected' : ''}>Row ${i + 1}: ${esc((r || []).filter((v) => v != null).slice(0, 4).map(fmtDate).join(' | ')).slice(0, 70)}</option>`).join('');
    buildTable();
  }
  function buildTable() {
    const aoa = state.aoa;
    const headers = (aoa[state.headerRow] || []).map((h, i) => (h == null || h === '' ? `Column ${i + 1}` : String(h)));
    const rows = aoa.slice(state.headerRow + 1).filter((r) => r && r.some((v) => v != null && v !== '')).map((r) => { const o = headers.map((_, i) => (r[i] == null ? null : r[i])); return o; });
    state.table = { headers, rows };
    $('shapeInfo').textContent = `${rows.length} rows × ${headers.length} columns`;
    state.columns = DeID.classifyColumns(headers, rows);
    const saved = loadSavedConfig(headers);
    if (saved) { saved.roles.forEach((role, i) => { if (state.columns[i]) { state.columns[i].role = role; state.columns[i].reason = 'saved'; } }); $('cfgBadge').textContent = 'saved roles applied'; $('cfgBadge').className = 'pill ok'; }
    else { $('cfgBadge').textContent = 'guessed'; $('cfgBadge').className = 'pill warn'; }
    renderColumns();
    const mrnCol = state.columns.find((c) => c.role === 'mrn');
    $('mrnInferred').textContent = mrnCol ? `(auto: ${DeID.inferIdPattern(rows.map((r) => r[mrnCol.index])) || 'none'})` : '(no MRN column)';
    ['colsCard', 'optsCard', 'runCard'].forEach((id) => $(id).classList.remove('hidden'));
    ['reviewCard', 'exportCard'].forEach((id) => $(id).classList.add('hidden'));
    $('summary').classList.add('hidden'); state.result = null; state.manual = {};
  }
  function cfgKey(headers) { return 'deid:cfg:' + DeID.hashString(headers.join('|').toLowerCase()); }
  function loadSavedConfig(headers) { try { const j = localStorage.getItem(cfgKey(headers)); return j ? JSON.parse(j) : null; } catch (e) { return null; } }
  $('saveCfg').addEventListener('click', () => { try { localStorage.setItem(cfgKey(state.table.headers), JSON.stringify({ roles: state.columns.map((c) => c.role), saved: new Date().toISOString() })); $('cfgBadge').textContent = 'saved'; $('cfgBadge').className = 'pill ok'; } catch (e) { alert('Could not save: ' + e.message); } });
  $('forgetCfg').addEventListener('click', () => { try { localStorage.removeItem(cfgKey(state.table.headers)); } catch (e) {} buildTable(); });

  function renderColumns() {
    const t = $('colsTable');
    t.innerHTML = '<tr><th>#</th><th>Header</th><th>Sample values</th><th>Role</th><th>Why</th></tr>' + state.columns.map((c, i) => `<tr><td class="muted">${i + 1}</td><td><b>${esc(c.header)}</b></td><td class="muted small">${esc(c.sample.map((s) => s.length > 40 ? s.slice(0, 40) + '…' : s).join(' · '))}</td><td><select data-i="${i}">${DeID.ROLES.map((r) => `<option value="${r}" ${r === c.role ? 'selected' : ''}>${esc(DeID.ROLE_LABELS[r])}</option>`).join('')}</select></td><td class="muted small">${esc(c.reason)}</td></tr>`).join('');
    t.querySelectorAll('select').forEach((s) => s.addEventListener('change', () => { state.columns[+s.dataset.i].role = s.value; state.columns[+s.dataset.i].reason = 'set by you'; colWarnings(); }));
    colWarnings();
  }
  function colWarnings() {
    const roles = state.columns.map((c) => c.role);
    const w = [];
    if (!roles.includes('mrn')) w.push('No MRN column: patients are keyed by name + DOB, and MRNs in text can only be caught by pattern.');
    if (!roles.includes('patient_name')) w.push('No patient-name column: the census dictionary will have no names.');
    const kept = state.columns.filter((c) => c.role === 'keep' && /name|address|contact|phone|email|guarantor|employer|insur/i.test(c.header));
    if (kept.length) w.push(`Kept columns that may hold identifiers: ${kept.map((c) => c.header).join(', ')}.`);
    $('colWarnings').innerHTML = w.length ? `<span class="warn">⚠ ${esc(w.join(' '))}</span>` : '<span class="ok">Roles look complete.</span>';
  }

  // drag/drop + demo
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
  $('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
  $('sheetSel').addEventListener('change', (e) => selectSheet(e.target.value));
  $('headerSel').addEventListener('change', (e) => selectSheet(state.sheet, +e.target.value));
  $('loadDemo').addEventListener('click', () => {
    const synth = DeIDSynth.make({ n: 120, seed: Date.now() % 100000 });
    const ws = XLSX.utils.aoa_to_sheet([synth.headers, ...synth.rows], { cellDates: true });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Infusion Schedule');
    state.wb = wb; state.fileName = 'synthetic-demo.xlsx';
    $('fileInfo').textContent = 'Synthetic demo: 120 rows generated in this tab. Names, MRNs and comments are invented.';
    $('sheetSel').innerHTML = '<option>Infusion Schedule</option>'; $('sheetRow').style.display = '';
    selectSheet('Infusion Schedule', 0);
  });

  // ------------------------------------------------------------ options → config
  function collectConfig() {
    const [a, b] = ($('optRange').value || '30-365').split(/[-–,\s]+/).map((x) => parseInt(x, 10));
    const lines = (id) => $(id).value.split(/\n/).map((s) => s.trim()).filter(Boolean);
    return {
      columns: state.columns.map((c) => ({ header: c.header, role: c.role })),
      mrnPattern: $('optMrn').value.trim() || null,
      seed: parseInt($('optSeed').value, 10) || 12345,
      surrogate: { patients: $('optPatients').value, providers: $('optProviders').value, dob: $('optDob').value, ages: $('optAges').value, dateShift: $('optDates').value === 'shift', shiftRange: [isNaN(a) ? 30 : a, isNaN(b) ? 365 : b] },
      denylist: lines('optDeny'), allowlist: lines('optAllow'),
      auditColumn: $('optAudit').checked, auditDetail: $('optAuditDetail').checked, deriveAge: $('optDerive').checked,
      manual: state.manual,
    };
  }

  // ------------------------------------------------------------ run
  $('run').addEventListener('click', () => runDeid(true));
  function runDeid(resetPage) {
    const prog = $('prog'); prog.classList.remove('hidden'); prog.firstElementChild.style.width = '30%';
    $('run').disabled = true; $('runInfo').textContent = 'Working…';
    setTimeout(() => {
      try {
        const t0 = performance.now();
        state.result = DeID.processTable(state.table, collectConfig());
        const ms = performance.now() - t0;
        prog.firstElementChild.style.width = '100%';
        $('runInfo').textContent = `Done in ${(ms / 1000).toFixed(1)} s`;
        renderSummary(); if (resetPage) state.page = 1; renderReview();
        ['reviewCard', 'exportCard'].forEach((id) => $(id).classList.remove('hidden'));
      } catch (e) { console.error(e); $('runInfo').innerHTML = `<span class="bad">Error: ${esc(e.message)}</span>`; }
      finally { $('run').disabled = false; setTimeout(() => prog.classList.add('hidden'), 400); }
    }, 30);
  }
  function renderSummary() {
    const r = state.result, s = r.stats;
    const by = Object.entries(s.byType).sort((a, b) => b[1] - a[1]);
    const src = Object.entries(s.bySource).sort((a, b) => b[1] - a[1]);
    const low = r.details.filter((d) => d.cells.some((c) => c.spans.some((sp) => /^(lexicon|cue|propagate)/.test(sp.source)))).length;
    $('summary').classList.remove('hidden');
    $('summary').innerHTML = `
      <div class="stats">
        <div class="stat"><b>${s.rows}</b><span>rows</span></div>
        <div class="stat"><b>${r.census.patients.size}</b><span>patients in census</span></div>
        <div class="stat"><b>${r.census.providers.size}</b><span>providers in census</span></div>
        <div class="stat"><b>${s.cells}</b><span>free-text cells</span></div>
        <div class="stat"><b>${s.spans}</b><span>identifiers replaced in text</span></div>
        <div class="stat"><b>${low}</b><span>rows with least-certain detections</span></div>
      </div>
      <div class="row small" style="margin-top:10px">
        <div><b>By type:</b> ${by.map(([k, v]) => `<span class="pill">${esc(k)} ${v}</span>`).join('') || '<span class="muted">none</span>'}</div>
        <div><b>By layer:</b> ${src.map(([k, v]) => `<span class="pill">${esc(k)} ${v}</span>`).join('')}</div>
      </div>
      <div class="row small" style="margin-top:6px"><b>Structured columns handled:</b> ${Object.entries(s.structured).map(([k, v]) => `<span class="pill">${esc(k)} ${v}</span>`).join('') || '<span class="muted">none</span>'} <span class="muted">MRN pattern used: <code>${esc(r.cfg.inferredMrnPattern || r.cfg.mrnPattern || 'none')}</code></span></div>`;
  }

  // ------------------------------------------------------------ review
  const PAGE = 40;
  function highlight(cellInfo) {
    const text = cellInfo.original, spans = cellInfo.spans;
    let html = '', pos = 0;
    spans.forEach((sp, i) => {
      html += esc(text.slice(pos, sp.start));
      const coarse = DeID.COARSE(sp.type);
      html += `<mark class="${coarse}${sp.manual ? ' manual' : ''}" data-s="${sp.start}" data-e="${sp.end}" title="${esc(sp.type)} · ${esc(sp.source)}${sp.entity ? ' · census entity' : ''}">${esc(text.slice(sp.start, sp.end))}</mark>`;
      pos = sp.end;
    });
    html += esc(text.slice(pos));
    const removed = (state.manual[`${cellInfo.row}:${cellInfo.col}`] || {}).remove || [];
    // show removed spans struck through so the reviewer can undo
    if (removed.length) { /* re-render with removed markers */
      let out = '', p = 0; const marks = spans.map((sp) => ({ s: sp.start, e: sp.end, sp })).concat(removed.map((r) => ({ s: r[0], e: r[1], rem: true }))).sort((a, b) => a.s - b.s);
      for (const m of marks) { if (m.s < p) continue; out += esc(text.slice(p, m.s)); out += m.rem ? `<mark class="removed" data-s="${m.s}" data-e="${m.e}" data-rem="1" title="removed by you — click to restore">${esc(text.slice(m.s, m.e))}</mark>` : `<mark class="${DeID.COARSE(m.sp.type)}${m.sp.manual ? ' manual' : ''}" data-s="${m.s}" data-e="${m.e}" title="${esc(m.sp.type)} · ${esc(m.sp.source)}">${esc(text.slice(m.s, m.e))}</mark>`; p = m.e; }
      out += esc(text.slice(p)); html = out;
    }
    return html;
  }
  function filteredDetails() {
    const f = $('reviewFilter').value, q = $('reviewSearch').value.trim().toLowerCase();
    return state.result.details.filter((d) => d.cells.length).filter((d) => {
      if (f === 'model') return d.cells.some((c) => c.spans.some((sp) => /^(lexicon|cue|propagate)/.test(sp.source)));
      if (f === 'none') return d.cells.every((c) => !c.spans.length);
      if (f === 'manual') return d.cells.some((c) => state.manual[`${d.row}:${c.col}`]);
      return true;
    }).filter((d) => !q || d.cells.some((c) => c.original.toLowerCase().includes(q)));
  }
  function renderReview() {
    const list = filteredDetails();
    const shown = list.slice(0, state.page * PAGE);
    $('reviewInfo').textContent = `${shown.length} of ${list.length} rows shown`;
    $('morePages').style.display = shown.length < list.length ? '' : 'none';
    const t = $('reviewTable');
    t.innerHTML = '<tr><th>Row</th><th>Patient</th><th>Column</th><th style="width:42%">Original with detections</th><th style="width:42%">De-identified</th></tr>' + shown.map((d) => d.cells.map((c, i) => `<tr>${i === 0 ? `<td rowspan="${d.cells.length}">${d.row + 1}</td><td rowspan="${d.cells.length}">${esc(d.patientCode || '–')}</td>` : ''}<td class="muted">${esc(c.header)}</td><td class="cell" data-row="${d.row}" data-col="${c.col}">${highlight(Object.assign({ row: d.row }, c))}</td><td class="cell muted">${esc(c.output)}</td></tr>`).join('')).join('');
  }
  $('reviewFilter').addEventListener('change', () => { state.page = 1; renderReview(); });
  $('reviewSearch').addEventListener('input', () => { state.page = 1; renderReview(); });
  $('morePages').addEventListener('click', () => { state.page++; renderReview(); });
  $('reviewTable').addEventListener('click', (e) => {
    const m = e.target.closest('mark'); if (!m) return;
    const cell = m.closest('.cell'); const key = `${cell.dataset.row}:${cell.dataset.col}`;
    const s = +m.dataset.s, en = +m.dataset.e;
    const man = state.manual[key] = state.manual[key] || { remove: [], add: [] };
    if (m.dataset.rem) man.remove = man.remove.filter((r) => !(r[0] === s && r[1] === en));
    else if (m.classList.contains('manual')) man.add = man.add.filter((a) => !(a.start === s && a.end === en));
    else man.remove.push([s, en]);
    if (!man.remove.length && !man.add.length) delete state.manual[key];
    runDeid(false);
  });
  $('markSel').addEventListener('click', () => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) { alert('Select some text in an "Original" cell first.'); return; }
    const range = sel.getRangeAt(0);
    const cell = range.startContainer.parentElement.closest('.cell[data-row]');
    if (!cell || !cell.contains(range.endContainer)) { alert('Select text inside a single "Original with detections" cell.'); return; }
    const pre = document.createRange(); pre.selectNodeContents(cell); pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length, end = start + range.toString().length;
    const key = `${cell.dataset.row}:${cell.dataset.col}`;
    const man = state.manual[key] = state.manual[key] || { remove: [], add: [] };
    // trim whitespace
    const text = state.result.details[+cell.dataset.row].cells.find((c) => c.col === +cell.dataset.col).original;
    let s = start, e = end; while (s < e && /\s/.test(text[s])) s++; while (e > s && /\s/.test(text[e - 1])) e--;
    if (e > s) man.add.push({ start: s, end: e, type: $('markType').value });
    sel.removeAllRanges(); runDeid(false);
  });

  // ------------------------------------------------------------ export
  function baseName() { return (state.fileName || 'report').replace(/\.[^.]+$/, ''); }
  function aoaOut() { return [state.result.headers, ...state.result.rows]; }
  $('dlXlsx').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet(aoaOut(), { cellDates: true });
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'De-identified');
    XLSX.writeFile(wb, `${baseName()}_DEID.xlsx`, { cellDates: true });
  });
  $('dlCsv').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet(aoaOut().map((r) => r.map(fmtDate)));
    const csv = XLSX.utils.sheet_to_csv(ws);
    download(new Blob([csv], { type: 'text/csv' }), `${baseName()}_DEID.csv`);
  });
  $('dlMap').addEventListener('click', () => {
    const m = state.result.mapping;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m.patients.length ? m.patients : [{ Code: '', SurrogateName: '', RealName: '', MRN: '', DOB: '', Account: '', Phone: '', DateOffsetDays: '' }]), 'Patients');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m.providers.length ? m.providers : [{ Code: '', SurrogateName: '', RealName: '' }]), 'Providers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(m.others.length ? m.others : [{ Type: '', Original: '', Surrogate: '' }]), 'Others');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['meta'], [JSON.stringify(m.meta)]]), 'Meta');
    XLSX.writeFile(wb, `${baseName()}_MAPPING_KEY_PHI.xlsx`);
  });
  $('dlReport').addEventListener('click', () => {
    const r = state.result, s = r.stats;
    const lines = [`Infusion De-ID run report`, `Tool version: ${DeID.VERSION}`, `Run at: ${new Date().toISOString()}`, `Source file: ${state.fileName} / sheet "${state.sheet}" / header row ${state.headerRow + 1}`, `Rows: ${s.rows}; patients in census: ${r.census.patients.size}; providers: ${r.census.providers.size}`, '', 'Column roles:', ...r.columns.map((c) => `  ${c.header}: ${c.role}`), '', `MRN pattern: ${r.cfg.inferredMrnPattern || r.cfg.mrnPattern || 'none'}`, `Options: ${JSON.stringify(r.cfg.surrogate)}`, `Always-redact terms: ${(r.cfg.denylist || []).length}; never-redact terms: ${(r.cfg.allowlist || []).length}`, `Manual review edits: ${Object.keys(state.manual).length} cells`, '', 'Identifiers replaced in free text by type:', ...Object.entries(s.byType).map(([k, v]) => `  ${k}: ${v}`), 'By layer:', ...Object.entries(s.bySource).map(([k, v]) => `  ${k}: ${v}`), 'Structured columns:', ...Object.entries(s.structured).map(([k, v]) => `  ${k}: ${v}`), '', 'This report contains no patient data. The mapping key does.'];
    download(new Blob([lines.join('\n')], { type: 'text/plain' }), `${baseName()}_DEID_report.txt`);
  });
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500); }

  // ------------------------------------------------------------ validate
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

  // ------------------------------------------------------------ re-identify
  $('reidRun').addEventListener('click', async () => {
    const f = $('reidFile').files[0], mf = $('reidMap').files[0];
    if (!f || !mf) { $('reidOut').innerHTML = '<span class="bad">Choose both files.</span>'; return; }
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
      XLSX.writeFile(owb, f.name.replace(/\.[^.]+$/, '') + '_REIDENTIFIED.xlsx', { cellDates: true });
      $('reidOut').innerHTML = `<span class="ok">Re-identified ${rows.length} rows using ${mapping.patients.length} patient codes, ${mapping.providers.length} providers and ${mapping.others.length} other surrogates.</span>`;
    } catch (e) { console.error(e); $('reidOut').innerHTML = `<span class="bad">Error: ${esc(e.message)}</span>`; }
  });

  // Expose for automated tests
  window.__deid = { state, runDeid, collectConfig };
})();
