#!/usr/bin/env node
/* Build: inline vendor + src into a single self-contained HTML file. */
const fs = require('fs');
const path = require('path');
const root = __dirname;
const tpl = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const built = new Date().toISOString().slice(0, 10);
const withOcr = process.argv.includes('--ocr') || process.argv.includes('--all');
const plain = !process.argv.includes('--ocr');
const escapeScript = (code) => code.replace(/<\/script/gi, '<\\/script');
const ocrAssets = () => {
  const b = (f) => fs.readFileSync(path.join(root, 'vendor/ocr', f));
  const block = (id, content) => `<script type="text/plain" id="${id}">\n${escapeScript(content)}\n</script>`;
  return [
    block('ocr-main', b('tesseract.min.js').toString('utf8')),
    block('ocr-worker', b('worker.min.js').toString('utf8')),
    block('ocr-core', b('tesseract-core-simd-lstm.wasm.js').toString('utf8')),
    block('ocr-lang', b('eng.traineddata.gz').toString('base64')),
  ].join('\n');
};
const render = (ocr) => tpl
  .replace(/<!--INLINE:([^>]+)-->/g, (_, rel) => {
    const code = escapeScript(fs.readFileSync(path.join(root, rel.trim()), 'utf8'));
    return `<script>\n/* ${rel.trim()} */\n${code}\n</script>`;
  })
  .replace('<!--OCR-ASSETS-->', ocr ? ocrAssets() : '')
  .replace('<html lang="en">', `<html lang="en" data-built="${built}" data-ocr="${ocr ? 'yes' : 'no'}">`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const write = (name, html) => { const target = path.join(root, 'dist', name); fs.writeFileSync(target, html); console.log(`built ${target} (${(Buffer.byteLength(html) / 1024 / 1024).toFixed(1)} MB)`); };
if (plain) write('infusion-deid.html', render(false));
if (withOcr) write('infusion-deid-ocr.html', render(true));
