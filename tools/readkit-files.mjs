// Writes the list of readkit runtime files (readkit/index.js, src/**, data/** without notes)
// and readkit's version into sw.js, so the service worker can keep them for offline use.
// Run after vendoring a new readkit:  node tools/readkit-files.mjs
// tests/core.test.js fails when the list in sw.js is out of date.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) =>
  fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name]));

const files = ['readkit/index.js', ...walk('readkit/src'), ...walk('readkit/data').filter((f) => !/\.md$/.test(f))].sort();
const lines = fs.readFileSync(path.join(ROOT, 'readkit/VERSION'), 'utf8').split('\n');
const version = (lines[0] || '').replace(/^readkit\s+/, '').trim();
const commit = ((lines.find((l) => /^commit /.test(l)) || '').split(' ')[1] || '').slice(0, 7);
const kitVersion = commit ? `${version}-${commit}` : version;

const swPath = path.join(ROOT, 'sw.js');
let sw = fs.readFileSync(swPath, 'utf8');
const list = files.map((f) => `  ${JSON.stringify(f)},`).join('\n');
const re = /(\/\/ readkit files: begin)[\s\S]*?(\n[ \t]*\/\/ readkit files: end)/;
if (!re.test(sw)) throw new Error('sw.js has no "// readkit files: begin/end" markers');
sw = sw.replace(re, (m, a, b) => `${a}\n${list}${b}`);
sw = sw.replace(/const KIT_VERSION = '[^']*';/, `const KIT_VERSION = '${kitVersion}';`);
fs.writeFileSync(swPath, sw);
let bytes = 0;
for (const f of files) bytes += fs.statSync(path.join(ROOT, f)).size;
console.log(`sw.js: ${files.length} readkit files (${(bytes / 1e6).toFixed(1)} MB), readkit ${kitVersion}`);
