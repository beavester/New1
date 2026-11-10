/* Infusion De-ID — in-page OCR (optical character recognition) using Tesseract.js, fully offline.
 *
 * The OCR build inlines four assets as inert <script type="text/plain"> blocks:
 *   #ocr-core    tesseract-core-simd-lstm.wasm.js  (Emscripten glue with the wasm embedded)
 *   #ocr-worker  worker.min.js                     (tesseract.js worker script)
 *   #ocr-lang    eng.traineddata.gz, base64        (LSTM English model)
 *   #ocr-main    tesseract.min.js                  (main-thread API)
 * The worker is a Blob whose source is: core glue + a fetch override that serves the language
 * bytes + the worker script. tesseract.js skips its own core loader when TesseractCore is already
 * defined, and its language loader calls fetch(), which we answer locally. Nothing touches a URL.
 */
(function (root) {
  'use strict';
  const el = (id) => document.getElementById(id);
  let mainLoaded = false, workerUrl = null;
  // A small pool of workers. One is enough to read a screenshot; the others let several screenshots, or the bands of one
  // tall screenshot, be read at the same time. They are started in the background (warm) so the first read does not wait.
  const pool = [];      // { promise, worker, busy, progress }
  const waiters = [];   // resolvers waiting for an idle worker
  const cores = () => Math.max(1, (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2);
  // each worker holds its own copy of the engine and the language model (roughly 100 MB), so a small machine gets fewer
  const POOL_MAX = () => { const mem = (typeof navigator !== 'undefined' && navigator.deviceMemory) || 8; return Math.max(1, Math.min(mem <= 2 ? 1 : mem <= 4 ? 2 : 4, cores())); };
  const BAND_MIN = 360; // a band shorter than this (in upscaled pixels) is not worth a hand-off

  function available() { return !!(el('ocr-core') && el('ocr-worker') && el('ocr-lang') && el('ocr-main')); }
  function simdSupported() {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
  }
  function loadMain() {
    if (mainLoaded || root.Tesseract) { mainLoaded = true; return; }
    const s = document.createElement('script'); s.textContent = el('ocr-main').textContent; document.head.appendChild(s); mainLoaded = true;
  }
  function buildWorkerUrl() {
    if (workerUrl) return workerUrl;
    const core = el('ocr-core').textContent;
    const worker = el('ocr-worker').textContent;
    const langB64 = el('ocr-lang').textContent.replace(/\s+/g, '');
    const shim = `
      (function(){
        var b64=${JSON.stringify(langB64)};
        var bin=atob(b64); var bytes=new Uint8Array(bin.length); for (var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i); b64=bin=null;
        var origFetch=self.fetch;
        self.fetch=function(url,opts){
          if (typeof url==='string' && /traineddata/.test(url)) return Promise.resolve(new Response(bytes.slice().buffer,{status:200,headers:{'Content-Type':'application/octet-stream'}}));
          return origFetch ? origFetch.call(self,url,opts) : Promise.reject(new Error('network disabled'));
        };
        self.importScripts=function(){ throw new Error('importScripts disabled in offline OCR worker: '+Array.prototype.join.call(arguments,',')); };
      })();`;
    const blob = new Blob([core, '\n', shim, '\n', worker], { type: 'application/javascript' });
    workerUrl = URL.createObjectURL(blob);
    return workerUrl;
  }
  function spawn() {
    loadMain();
    const slot = { promise: null, worker: null, busy: false, progress: null };
    slot.promise = (async () => {
      const worker = await root.Tesseract.createWorker('eng', 1, {
        workerPath: buildWorkerUrl(), workerBlobURL: false, corePath: 'inline-core.js', langPath: 'inline', cacheMethod: 'none', gzip: true,
        logger: (m) => { if (slot.progress) slot.progress(m); },
        errorHandler: (e) => { console.error('OCR worker error', e); },
      });
      // Table screenshots: assume a uniform block of text; keep inter-word spaces.
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', user_defined_dpi: '300' });
      // the first read on a worker loads the recognition network (about half a second); pay that here, in the background
      try { const c = document.createElement('canvas'); c.width = 220; c.height = 48; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 220, 48); g.fillStyle = '#000'; g.font = '26px sans-serif'; g.fillText('Ready 123', 8, 34); await worker.recognize(c, {}, { text: true }); } catch (e) { /* a failed warm-up read costs nothing: the real read reports its own error */ }
      slot.worker = worker;
      release(slot);
      return worker;
    })();
    slot.promise.catch(() => { const i = pool.indexOf(slot); if (i >= 0) pool.splice(i, 1); waiters.splice(0).forEach((w) => w(null)); });
    pool.push(slot);
    return slot;
  }
  function release(slot) { slot.busy = false; slot.progress = null; const w = waiters.shift(); if (w) w(slot); }
  const idle = () => pool.filter((s) => s.worker && !s.busy);
  // An idle worker, starting one if none exists yet. Waits when all are busy or still starting.
  async function acquire() {
    for (;;) {
      const free = idle()[0];
      if (free) { free.busy = true; return free; }
      if (pool.length < POOL_MAX() && pool.length <= waiters.length + pool.filter((x) => x.busy).length) spawn();
      const got = await new Promise((resolve) => waiters.push(resolve));
      if (got && got.worker && !got.busy) { got.busy = true; return got; }
      if (!pool.length) { const s = spawn(); await s.promise; } // a worker failed to start: this throws its error
    }
  }
  // Start workers in the background, one after another, so starting them never competes with a read in progress.
  let warming = null;
  function warm(n) {
    if (!available() || !simdSupported()) return Promise.resolve(0);
    const want = Math.max(1, Math.min(POOL_MAX(), n || POOL_MAX()));
    const step = () => (pool.length >= want ? Promise.resolve(pool.length) : spawn().promise.then(step, () => pool.length));
    warming = (warming || Promise.resolve()).then(step, step);
    return warming;
  }

  // Draw an image/blob to a canvas, upscaled so small UI text reaches a size Tesseract reads well.
  async function toCanvas(source, scale) {
    const img = await new Promise((resolve, reject) => {
      if (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement) return resolve(source);
      const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('could not decode image'));
      i.src = source instanceof Blob ? URL.createObjectURL(source) : String(source);
    });
    const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    const s = scale || (w < 1600 ? 2 : w < 2600 ? 1.5 : 1);
    const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 0, 0, c.width, c.height);
    // grayscale + mild contrast stretch; dark-theme screenshots are inverted so text is dark on light
    const d = g.getImageData(0, 0, c.width, c.height), p = d.data;
    let sum = 0; for (let i = 0; i < p.length; i += 4) { const y = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2]; p[i] = p[i + 1] = p[i + 2] = y; sum += y; }
    const mean = sum / (p.length / 4);
    const invert = mean < 110;
    for (let i = 0; i < p.length; i += 4) { let y = p[i]; if (invert) y = 255 - y; y = Math.max(0, Math.min(255, (y - 128) * 1.25 + 128)); p[i] = p[i + 1] = p[i + 2] = y; }
    g.putImageData(d, 0, 0);
    if (source instanceof Blob && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
    return c;
  }

  function linesFrom(data) {
    const out = [];
    if (Array.isArray(data.lines) && data.lines.length) data.lines.forEach((l) => out.push({ text: l.text.replace(/\s+$/, ''), confidence: l.confidence, bbox: l.bbox }));
    else if (Array.isArray(data.blocks)) data.blocks.forEach((b) => (b.paragraphs || []).forEach((pg) => (pg.lines || []).forEach((l) => out.push({ text: l.text.replace(/\s+$/, ''), confidence: l.confidence, bbox: l.bbox }))));
    return out.filter((l) => l.text.trim());
  }

  // Rows where a tall screenshot can be cut without touching text. A row of text has hundreds of light/dark changes along
  // it; the gap between two rows has only the table's column rules. A cut goes in the middle of the quietest run of rows
  // near each even split, and is skipped when no quiet run is there, so a band never ends inside a line of text.
  function cutRows(canvas, n) {
    const w = canvas.width, h = canvas.height;
    if (n < 2 || h < BAND_MIN * 2) return [];
    const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    const T = new Uint32Array(h);
    for (let y = 0; y < h; y++) { let t = 0, o = y * w * 4, prev = data[o]; for (let x = 2; x < w; x += 2) { const v = data[o + x * 4]; if (v - prev > 48 || prev - v > 48) t++; prev = v; } T[y] = t; }
    let busy = 0, rows = 0; for (let y = 0; y < h; y++) if (T[y] > 0) { busy += T[y]; rows++; }
    const quiet = Math.max(6, Math.round(0.12 * (rows ? busy / rows : 0)));
    // split by the amount of text, not by height: each band gets about the same share of the light/dark changes
    const cum = new Float64Array(h + 1); for (let y = 0; y < h; y++) cum[y + 1] = cum[y] + T[y];
    const at = (k) => { const goal = cum[h] * k / n; let lo = 0, hi = h; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < goal) lo = m + 1; else hi = m; } return lo; };
    const cuts = [], reach = Math.round(Math.min(h / n * 0.35, 260));
    for (let k = 1; k < n; k++) {
      const target = at(k); let best = -1, bestLen = 0, bestDist = Infinity;
      for (let y = Math.max(BAND_MIN >> 1, target - reach); y < Math.min(h - (BAND_MIN >> 1), target + reach); y++) {
        if (T[y] > quiet) continue;
        let e = y; while (e + 1 < h && T[e + 1] <= quiet) e++;
        const len = e - y + 1, mid = (y + e) >> 1, dist = Math.abs(mid - target);
        if (len >= 5 && (len > bestLen + 2 || (len >= bestLen - 2 && dist < bestDist))) { best = mid; bestLen = len; bestDist = dist; }
        y = e;
      }
      if (best > 0 && (!cuts.length || best - cuts[cuts.length - 1] >= (BAND_MIN >> 1))) cuts.push(best);
    }
    return cuts;
  }
  function crop(canvas, y0, y1) {
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = y1 - y0;
    c.getContext('2d').drawImage(canvas, 0, y0, canvas.width, y1 - y0, 0, 0, canvas.width, y1 - y0);
    return c;
  }
  const OUT = { text: true, blocks: true, lines: true, hocr: false, tsv: false };
  async function readPart(slot, canvas, y0, onProgress) {
    slot.progress = onProgress || null;
    const res = await slot.worker.recognize(canvas, {}, OUT);
    const lines = linesFrom(res.data);
    if (y0) lines.forEach((l) => { if (l.bbox) l.bbox = { x0: l.bbox.x0, x1: l.bbox.x1, y0: l.bbox.y0 + y0, y1: l.bbox.y1 + y0 }; });
    return { lines, text: res.data.text, confidence: res.data.confidence };
  }

  // opts.share: how many screenshots are being read at once (the page says). One screenshot alone may be read in bands
  // by every idle worker; several at once take one worker each.
  async function recognize(source, opts) {
    const o = opts || {};
    if (!available()) throw new Error('This build has no OCR engine. Use infusion-deid-ocr.html.');
    if (!simdSupported()) throw new Error('This browser lacks WebAssembly SIMD, which the bundled OCR engine needs. Use Edge or Chrome 91+.');
    const report = (status, progress) => { if (o.onProgress) o.onProgress({ status, progress }); };
    if (!idle().length) report('loading', 0);
    // the worker first, the canvas second: twenty screenshots dropped together must not all be drawn at full size at once
    const first = await acquire();
    let canvas; try { canvas = await toCanvas(source, o.scale); } catch (e) { release(first); throw e; }
    const t0 = performance.now();
    // bands: the worker in hand plus the others that are idle right now; never wait for a worker to start. One band per
    // worker, cut so each holds about the same amount of text.
    const others = (o.share || 1) > 1 || o.bands === 1 ? [] : idle();
    others.forEach((s) => { s.busy = true; });
    const slots = [first, ...others];
    let parts;
    try {
      const cuts = slots.length > 1 ? cutRows(canvas, Math.min(slots.length, o.bands || 99, Math.floor(canvas.height / BAND_MIN))) : [];
      const edges = [0, ...cuts, canvas.height], n = edges.length - 1, prog = new Array(n).fill(0);
      parts = new Array(n); let next = 0;
      await Promise.all(slots.slice(0, n).map(async (slot) => {
        for (let i = next++; i < n; i = next++) {
          parts[i] = await readPart(slot, n === 1 ? canvas : crop(canvas, edges[i], edges[i + 1]), edges[i], (m) => {
            if (!m || !/recognizing/i.test(m.status || '')) return;
            prog[i] = m.progress || 0; report('recognizing text', prog.reduce((x, y) => x + y, 0) / n);
          });
          prog[i] = 1;
        }
      }));
    } finally { slots.forEach(release); }
    const lines = parts.flatMap((p) => p.lines);
    // overall confidence: the mean over the lines read (a band with no text has no say)
    const confidence = lines.length ? lines.reduce((a, l) => a + (l.confidence || 0), 0) / lines.length : (parts[0] ? parts[0].confidence : 0);
    return { text: lines.map((l) => l.text).join('\n') || parts.map((p) => p.text).join('\n'), lines, confidence, ms: performance.now() - t0, width: canvas.width, height: canvas.height, bands: parts.length };
  }
  // Why recognize() would refuse, for callers that want plain-language copy: 'no-engine' | 'no-simd' | null.
  function reason() { return !available() ? 'no-engine' : !simdSupported() ? 'no-simd' : null; }

  async function terminate() { const all = pool.splice(0); warming = null; for (const s of all) { try { (await s.promise).terminate(); } catch (e) {} } }

  root.DeIDOCR = { available, simdSupported, reason, recognize, terminate, toCanvas, warm, workers: () => pool.filter((s) => s.worker).length };
})(typeof self !== 'undefined' ? self : this);
