// Writes the list of readkit runtime files (readkit/*.js, src/**, data/** without notes), each
// with a fingerprint of its content, and readkit's version into sw.js and app.js, so the
// service worker can keep them for offline use and the page knows which readkit it was made for.
// Run after vendoring a new readkit:  node tools/readkit-files.mjs
// tests/core.test.js fails when the list in sw.js (or the version in app.js) is out of date.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const walk = (dir) =>
  fs
    .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(dir + '/' + e.name) : [dir + '/' + e.name]));

// readkit's runtime: its entry points at the top (index.js, voice.js, player.js), src/ and data/.
export function kitFiles() {
  const top = fs
    .readdirSync(path.join(ROOT, 'readkit'), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.js$/.test(e.name))
    .map((e) => 'readkit/' + e.name);
  return [...top, ...walk('readkit/src'), ...walk('readkit/data').filter((f) => !/\.md$/.test(f))].sort();
}

// A file's fingerprint: SHA-256 of its bytes with CRLF line ends read as LF (a Windows checkout
// may have CRLF where the host serves LF), first 16 hex digits. sw.js computes the same.
export function fingerprint(bytes) {
  const b = new Uint8Array(bytes);
  const out = new Uint8Array(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) if (!(b[i] === 13 && b[i + 1] === 10)) out[n++] = b[i];
  return crypto.createHash('sha256').update(out.subarray(0, n)).digest('hex').slice(0, 16);
}

// [[file, fingerprint], ...] and the version: readkit's own, its commit, and a hash of all the
// fingerprints (so a copy with uncommitted changes, or the same commit copied again after
// edits, still gets a cache of its own).
export function kitManifest() {
  const files = kitFiles().map((f) => [f, fingerprint(fs.readFileSync(path.join(ROOT, f)))]);
  const lines = fs.readFileSync(path.join(ROOT, 'readkit/VERSION'), 'utf8').split('\n');
  const version = (lines[0] || '').replace(/^readkit\s+/, '').trim();
  const commit = ((lines.find((l) => /^commit /.test(l)) || '').split(' ')[1] || '').slice(0, 7);
  const sum = crypto.createHash('sha256').update(files.map(([f, h]) => f + ' ' + h).join('\n')).digest('hex').slice(0, 8);
  const kitVersion = [version, commit, sum].filter(Boolean).join('-');
  return { files, kitVersion };
}

const VERSION_RE = /const KIT_VERSION = '[^']*';/;

function main() {
  const { files, kitVersion } = kitManifest();
  const swPath = path.join(ROOT, 'sw.js');
  let sw = fs.readFileSync(swPath, 'utf8');
  const list = files.map((e) => `  ${JSON.stringify(e)},`).join('\n');
  const re = /(\/\/ readkit files: begin)[\s\S]*?(\n[ \t]*\/\/ readkit files: end)/;
  if (!re.test(sw)) throw new Error('sw.js has no "// readkit files: begin/end" markers');
  if (!VERSION_RE.test(sw)) throw new Error('sw.js has no KIT_VERSION');
  sw = sw.replace(re, (m, a, b) => `${a}\n${list}${b}`);
  sw = sw.replace(VERSION_RE, `const KIT_VERSION = '${kitVersion}';`);
  fs.writeFileSync(swPath, sw);

  const appPath = path.join(ROOT, 'app.js');
  const app = fs.readFileSync(appPath, 'utf8');
  if (!VERSION_RE.test(app)) throw new Error('app.js has no KIT_VERSION');
  fs.writeFileSync(appPath, app.replace(VERSION_RE, `const KIT_VERSION = '${kitVersion}';`));

  let bytes = 0;
  for (const [f] of files) bytes += fs.statSync(path.join(ROOT, f)).size;
  console.log(`sw.js: ${files.length} readkit files (${(bytes / 1e6).toFixed(1)} MB); sw.js and app.js: readkit ${kitVersion}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
