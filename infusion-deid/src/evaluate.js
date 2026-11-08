/* Infusion De-ID — scorer
 * Token-level and entity-level recall per PHI category, over-redaction rate,
 * bootstrap confidence intervals, ablation across pipeline layers, and the
 * adversarial case table. Pure JS; browser and Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'), require('./synth.js'));
  else root.DeIDEval = factory(root.DeID, root.DeIDSynth);
})(typeof self !== 'undefined' ? self : this, function (D, SYNTH) {
  'use strict';

  const TOKEN_RE = /[A-Za-z0-9][A-Za-z0-9'’.@\-\/]*|\S/g;
  function tokens(text) {
    const out = []; let m; TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
    return out;
  }
  const overlaps = (a, b) => a.start < b.end && b.start < a.end;
  const covers = (spans, s) => {
    // s fully covered by the union of spans (allowing a leading/trailing punctuation char)
    let pos = s.start;
    const sorted = spans.filter((p) => overlaps(p, s)).sort((a, b) => a.start - b.start);
    for (const p of sorted) { if (p.start > pos) break; pos = Math.max(pos, p.end); }
    return pos >= s.end;
  };

  // truthCells: [{row, col, text, spans:[{start,end,type,sub,holdout}]}]
  // predByCell: Map "row:col" -> spans [{start,end,type}]
  function score(truthCells, predByCell, opts) {
    const o = Object.assign({ bootstrap: 300, seed: 99 }, opts || {});
    const rowStats = []; // per truth cell: {perType: {T: {tot, hit, strict}}, nonPhi, fp, entities: {T: {tot, hit}}}
    const misses = [], fps = [];
    const subStats = {}; // NAME sub-type / holdout breakdown
    const bumpSub = (k, hit) => { subStats[k] = subStats[k] || { tot: 0, hit: 0 }; subStats[k].tot++; if (hit) subStats[k].hit++; };

    for (const cell of truthCells) {
      const preds = predByCell.get(`${cell.row}:${cell.col}`) || [];
      const toks = tokens(cell.text);
      const st = { perType: {}, ent: {}, nonPhi: 0, fp: 0 };
      for (const t of toks) {
        const gt = cell.spans.filter((s) => overlaps(s, t));
        const pr = preds.filter((p) => overlaps(p, t));
        if (gt.length) {
          const types = [...new Set(gt.map((s) => s.type))];
          for (const T of types) {
            st.perType[T] = st.perType[T] || { tot: 0, hit: 0, strict: 0 };
            st.perType[T].tot++;
            if (pr.length) st.perType[T].hit++;
            if (pr.some((p) => D.COARSE(p.type) === T)) st.perType[T].strict++;
          }
          if (!pr.length) misses.push({ row: cell.row, token: t.text, type: types.join('/'), sub: gt[0].sub, holdout: gt[0].holdout, context: cell.text.slice(Math.max(0, t.start - 40), Math.min(cell.text.length, t.end + 40)) });
        } else {
          st.nonPhi++;
          if (pr.length && /[A-Za-z0-9]/.test(t.text)) { st.fp++; fps.push({ row: cell.row, token: t.text, predType: pr[0].type, source: pr[0].source, context: cell.text.slice(Math.max(0, t.start - 40), Math.min(cell.text.length, t.end + 40)) }); }
        }
      }
      for (const s of cell.spans) {
        st.ent[s.type] = st.ent[s.type] || { tot: 0, hit: 0 };
        st.ent[s.type].tot++;
        const hit = covers(preds, s);
        if (hit) st.ent[s.type].hit++;
        if (s.type === 'NAME') { bumpSub(`NAME:${s.sub || 'any'}`, hit); bumpSub(s.holdout ? 'NAME:holdout' : 'NAME:in-lexicon', hit); }
      }
      rowStats.push(st);
    }

    const aggregate = (idxs) => {
      const perType = {}, ent = {}; let nonPhi = 0, fp = 0;
      for (const i of idxs) {
        const st = rowStats[i];
        for (const [T, v] of Object.entries(st.perType)) { perType[T] = perType[T] || { tot: 0, hit: 0, strict: 0 }; perType[T].tot += v.tot; perType[T].hit += v.hit; perType[T].strict += v.strict; }
        for (const [T, v] of Object.entries(st.ent)) { ent[T] = ent[T] || { tot: 0, hit: 0 }; ent[T].tot += v.tot; ent[T].hit += v.hit; }
        nonPhi += st.nonPhi; fp += st.fp;
      }
      return { perType, ent, nonPhi, fp };
    };
    const all = aggregate(rowStats.map((_, i) => i));
    // bootstrap over cells
    const rng = D.mulberry32(o.seed);
    const samples = {}; const orSamples = [];
    for (let b = 0; b < o.bootstrap; b++) {
      const idxs = []; for (let i = 0; i < rowStats.length; i++) idxs.push(Math.floor(rng() * rowStats.length));
      const ag = aggregate(idxs);
      for (const [T, v] of Object.entries(ag.perType)) { (samples[T] = samples[T] || []).push(v.tot ? v.hit / v.tot : 1); }
      orSamples.push(ag.nonPhi ? ag.fp / ag.nonPhi : 0);
    }
    const ci = (arr) => { if (!arr || !arr.length) return [null, null]; const s = arr.slice().sort((a, b) => a - b); return [s[Math.floor(s.length * 0.025)], s[Math.min(s.length - 1, Math.floor(s.length * 0.975))]]; };

    const byType = {};
    const typesAll = new Set([...Object.keys(all.perType), ...Object.keys(all.ent)]);
    for (const T of typesAll) {
      const v = all.perType[T] || { tot: 0, hit: 0, strict: 0 }, e = all.ent[T] || { tot: 0, hit: 0 };
      byType[T] = { tokens: v.tot, tokensHit: v.hit, recall: v.tot ? v.hit / v.tot : null, strictRecall: v.tot ? v.strict / v.tot : null, ci: ci(samples[T]), entities: e.tot, entitiesHit: e.hit, entityRecall: e.tot ? e.hit / e.tot : null };
    }
    const totTok = Object.values(all.perType).reduce((a, v) => a + v.tot, 0), hitTok = Object.values(all.perType).reduce((a, v) => a + v.hit, 0);
    return {
      byType, subStats,
      overall: { tokens: totTok, tokensHit: hitTok, recall: totTok ? hitTok / totTok : null },
      overRedaction: { nonPhiTokens: all.nonPhi, redacted: all.fp, rate: all.nonPhi ? all.fp / all.nonPhi : 0, ci: ci(orSamples) },
      misses, falsePositives: fps, cells: truthCells.length,
    };
  }

  // Run the pipeline on a synthetic set and score it. layers: override for ablation.
  function runSynthetic(synth, cfgOverrides) {
    const cfg = Object.assign({ seed: 4242 }, cfgOverrides || {});
    const res = D.processTable({ headers: synth.headers, rows: synth.rows }, cfg);
    const predByCell = new Map();
    res.details.forEach((d) => d.cells.forEach((c) => predByCell.set(`${d.row}:${c.col}`, c.spans)));
    const s = score(synth.truth, predByCell);
    // Leak check on the surrogated output: does any real patient identifier survive anywhere?
    const leaks = [];
    const outText = res.rows.map((r) => r.map(D.cellToString).join(' | ')).join('\n');
    const outLower = outText.toLowerCase();
    for (const p of synth.patients) {
      if (outLower.includes(p.mrn.toLowerCase())) leaks.push({ kind: 'MRN', value: p.mrn });
      const fullLower = `${p.first} ${p.last}`.toLowerCase();
      if (outLower.includes(fullLower) || outLower.includes(`${p.last}, ${p.first}`.toLowerCase())) leaks.push({ kind: 'NAME', value: `${p.last}, ${p.first}` });
      if (outLower.includes(p.phone.toLowerCase())) leaks.push({ kind: 'PHONE', value: p.phone });
      if (outLower.includes(p.acct)) leaks.push({ kind: 'ACCOUNT', value: p.acct });
    }
    // Dates in date columns should all be shifted
    const dateCol = synth.headers.indexOf('Appt Date');
    let unshifted = 0;
    synth.rows.forEach((r, i) => { const a = r[dateCol], b = res.rows[i][dateCol]; if (a instanceof Date && b instanceof Date && a.getTime() === b.getTime()) unshifted++; });
    return { result: res, score: s, leaks, unshifted, structuredLeakFree: leaks.length === 0 && unshifted === 0 };
  }

  const ABLATIONS = [
    { key: 'full', label: 'Full pipeline', layers: {} },
    { key: 'no_census', label: 'Without census dictionary', layers: { census: false } },
    { key: 'no_model', label: 'Rules + census only (no lexicon/cue detector)', layers: { model: false, propagate: false } },
    { key: 'rules_only', label: 'Tier 0 rules only', layers: { census: false, model: false, propagate: false } },
  ];
  function runAblation(synth) {
    return ABLATIONS.map((a) => { const r = runSynthetic(synth, { layers: a.layers }); return { key: a.key, label: a.label, score: r.score }; });
  }

  function runAdversarial() {
    const adv = SYNTH.adversarial();
    const res = D.processTable({ headers: adv.headers, rows: adv.rows }, { seed: 1 });
    return adv.cases.map((c, i) => {
      const d = res.details[i]; const cell = d.cells[0] || { spans: [], output: '' };
      const text = c.text;
      const found = (phrase) => { let idx = -1, from = 0, ok = false; while ((idx = text.indexOf(phrase, from)) >= 0) { if (covers(cell.spans, { start: idx, end: idx + phrase.length })) { ok = true; break; } from = idx + 1; } return ok; };
      const phiResults = c.phi.map((p) => ({ phrase: p, caught: found(p) }));
      const keepResults = c.keep.map((k) => { let idx = -1, from = 0, redacted = false; while ((idx = text.indexOf(k, from)) >= 0) { const tokSpan = { start: idx, end: idx + k.length }; if (cell.spans.some((s) => overlaps(s, tokSpan))) { redacted = true; break; } from = idx + 1; } return { phrase: k, kept: !redacted }; });
      const pass = phiResults.every((r) => r.caught) && keepResults.every((r) => r.kept);
      return { name: c.name, text, output: cell.output, phi: phiResults, keep: keepResults, pass, spans: cell.spans };
    });
  }

  return { score, runSynthetic, runAblation, runAdversarial, ABLATIONS, tokens };
});
