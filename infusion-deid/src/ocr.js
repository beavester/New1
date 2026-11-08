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
  let workerPromise = null, mainLoaded = false;
  // progress callback of the call in flight; the worker logger is bound once, so it reads this variable
  let currentProgress = null;

  function available() { return !!(el('ocr-core') && el('ocr-worker') && el('ocr-lang') && el('ocr-main')); }
  function simdSupported() {
    try { return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])); } catch (e) { return false; }
  }
  function loadMain() {
    if (mainLoaded || root.Tesseract) { mainLoaded = true; return; }
    const s = document.createElement('script'); s.textContent = el('ocr-main').textContent; document.head.appendChild(s); mainLoaded = true;
  }
  function buildWorkerUrl() {
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
    return URL.createObjectURL(blob);
  }
  function getWorker() {
    if (workerPromise) return workerPromise;
    loadMain();
    workerPromise = (async () => {
      const workerPath = buildWorkerUrl();
      const worker = await root.Tesseract.createWorker('eng', 1, {
        workerPath, workerBlobURL: false, corePath: 'inline-core.js', langPath: 'inline', cacheMethod: 'none', gzip: true,
        logger: (m) => { if (currentProgress) currentProgress(m); },
        errorHandler: (e) => { console.error('OCR worker error', e); },
      });
      // Table screenshots: assume a uniform block of text; keep inter-word spaces.
      await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return worker;
    })();
    workerPromise.catch(() => { workerPromise = null; });
    return workerPromise;
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

  async function recognize(source, opts) {
    const o = opts || {};
    if (!available()) throw new Error('This build has no OCR engine. Use infusion-deid-ocr.html.');
    if (!simdSupported()) throw new Error('This browser lacks WebAssembly SIMD, which the bundled OCR engine needs. Use Edge or Chrome 91+.');
    currentProgress = o.onProgress || null;
    try {
      const worker = await getWorker();
      const canvas = await toCanvas(source, o.scale);
      const t0 = performance.now();
      const res = await worker.recognize(canvas, {}, { text: true, blocks: true, lines: true, hocr: false, tsv: false });
      const lines = linesFrom(res.data);
      return { text: lines.map((l) => l.text).join('\n') || res.data.text, lines, confidence: res.data.confidence, ms: performance.now() - t0, width: canvas.width, height: canvas.height };
    } finally { currentProgress = null; }
  }
  // Why recognize() would refuse, for callers that want plain-language copy: 'no-engine' | 'no-simd' | null.
  function reason() { return !available() ? 'no-engine' : !simdSupported() ? 'no-simd' : null; }

  async function terminate() { if (workerPromise) { try { (await workerPromise).terminate(); } catch (e) {} workerPromise = null; } }

  root.DeIDOCR = { available, simdSupported, reason, recognize, terminate, toCanvas };
})(typeof self !== 'undefined' ? self : this);
