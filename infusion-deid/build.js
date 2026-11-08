#!/usr/bin/env node
/* Build: inline vendor + src into a single self-contained HTML file. */
const fs = require('fs');
const path = require('path');
const root = __dirname;
const tpl = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const built = new Date().toISOString().slice(0, 10);
const out = tpl
  .replace(/<!--INLINE:([^>]+)-->/g, (_, rel) => {
    const code = fs.readFileSync(path.join(root, rel.trim()), 'utf8').replace(/<\/script/gi, '<\\/script');
    return `<script>\n/* ${rel.trim()} */\n${code}\n</script>`;
  })
  .replace('<html lang="en">', `<html lang="en" data-built="${built}">`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const target = path.join(root, 'dist/infusion-deid.html');
fs.writeFileSync(target, out);
console.log(`built ${target} (${(Buffer.byteLength(out) / 1024).toFixed(0)} KB)`);
