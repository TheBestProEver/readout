// Links, email addresses, bare domains and file names.
//   https://www.example.com/docs  -> 'example dot com slash docs'
//   john.doe@example.com         -> 'john dot doe at example dot com'
//   budget.xlsx                  -> 'budget dot X L S X'
// skip.urls: 'auto' (path when it is short and readable, else the domain), 'domain', 'full', 'skip'.

import { spellLetters } from './util.js';
import { digitWord } from '../numbers.js';

const TLD = 'com|org|net|edu|gov|mil|int|io|ai|co|uk|us|ca|au|de|fr|es|nl|se|ch|ie|nz|eu|jp|cn|ru|info|biz|app|dev|tv|ly|gg|xyz|site|online|tech|store|blog|news|museum|ac';
const TLD_SAY = { io: 'I O', ai: 'A I', uk: 'U K', us: 'U S', ca: 'C A', au: 'A U', de: 'D E', fr: 'F R', es: 'E S', nl: 'N L', se: 'S E', ch: 'C H', ie: 'I E', nz: 'N Z', eu: 'E U', jp: 'J P', cn: 'C N', ru: 'R U', tv: 'T V', ly: 'L Y', gg: 'G G', ac: 'A C', xyz: 'X Y Z' };
const EXT = 'pdf|docx|doc|xlsx|xls|pptx|ppt|csv|txt|md|json|xml|html|htm|css|js|mjs|ts|tsx|jsx|py|rb|java|cpp|cs|go|rs|php|sh|bat|exe|dmg|apk|zip|rar|7z|tar|gz|tgz|jpg|jpeg|png|gif|svg|webp|heic|mp3|mp4|wav|flac|m4a|mov|avi|mkv|epub|mobi|odt|ods|odp|rtf|ics|vcf|log|yaml|yml|toml|ini|sql|db|key|wasm|onnx';
const EXT_SAY = { docx: 'doc X', doc: 'doc', json: 'JSON', jpeg: 'JPEG', gif: 'gif', zip: 'zip', rar: 'rar', tar: 'tar', java: 'java', go: 'go', bat: 'bat', key: 'key', wav: 'wav', mov: 'mov', flac: 'flac', epub: 'E pub', mobi: 'mobi', yaml: 'yaml', toml: 'toml', ini: 'ini', log: 'log', webp: 'web P', wasm: 'wasm', onnx: 'onnx', ics: 'I C S', sql: 'S Q L', heic: 'H E I C' };
const EXT_END = new RegExp(`\\.(?:${EXT})$`, 'i');
// Lowercase extensions, or all-caps ones ('REPORT.PDF'); 'word.Go' is a missing space, not a file.
const FILE_RE = new RegExp(`(?<![\\w.@/\\\\-])[A-Za-z0-9_][\\w-]*(?:\\.[\\w-]+)*\\.(?:${EXT}|${EXT.toUpperCase()})(?![\\w-])`, 'g');
const DOMAIN_RE = new RegExp(`(?<![\\w.@/\\\\-])((?:[A-Za-z0-9][A-Za-z0-9-]*\\.)+)(${TLD})((?:/[^\\s<>"]*)?)(?![\\w-])`, 'g');

const dash = (ctx) => (ctx.uk ? ' hyphen ' : ' dash ');

function sayLabel(label, ctx) {
  const low = label.toLowerCase();
  if (TLD_SAY[low]) return TLD_SAY[low];
  // short labels with no vowel are initials: bbc, cnn, nyt
  if (/^[a-z]{2,4}$/i.test(label) && !/[aeiouy]/i.test(label)) return spellLetters(label);
  return label.replace(/-/g, dash(ctx)).replace(/_/g, ' underscore ');
}

function sayHost(host, ctx) {
  return host.replace(/^www\./i, '').split('.').filter(Boolean).map((l) => sayLabel(l, ctx)).join(' dot ');
}

function sayExt(ext) {
  const low = ext.toLowerCase();
  if (EXT_SAY[low]) return EXT_SAY[low];
  if (/[aeiou]/.test(low) && low.length > 3 && !/\d/.test(low)) return low;
  return [...low].map((c) => (/\d/.test(c) ? digitWord(c) : c.toUpperCase())).join(' ');
}

function sayFile(name) {
  const dot = name.lastIndexOf('.');
  const base = name.slice(0, dot).replace(/[_-]+/g, ' ').replace(/\./g, ' dot ');
  return base + ' dot ' + sayExt(name.slice(dot + 1));
}

// Path segments worth reading: words and short numbers, not ids or hashes.
const readable = (seg) => /^[A-Za-z][A-Za-z0-9._-]{0,24}$/.test(seg) && !/\d{5,}/.test(seg);

function sayPath(segs) {
  return segs.map((seg) => (EXT_END.test(seg) ? sayFile(seg) : seg.replace(/[_-]+/g, ' ').replace(/\./g, ' dot '))).join(' slash ');
}

function sayUrl(raw, ctx) {
  const mode = ctx.skip.urls;
  if (mode === 'skip') return '';
  const url = raw.replace(/^(?:https?|ftp):\/\//i, '').replace(/^www\./i, '');
  const cut = url.search(/[/?#]/);
  const host = (cut < 0 ? url : url.slice(0, cut)).replace(/:\d+$/, '');
  const path = cut < 0 ? '' : url.slice(cut).replace(/[?#].*$/, '');
  const segs = path.split('/').filter(Boolean);
  const say = sayHost(host, ctx);
  if (!segs.length || mode === 'domain') return say;
  if (mode === 'full' || (segs.length <= 3 && segs.every(readable))) return say + ' slash ' + sayPath(segs);
  return say;
}

// Trailing sentence punctuation is not part of the link; a closing bracket only if unbalanced.
function splitTrail(raw) {
  let url = raw;
  let trail = '';
  for (;;) {
    const c = url[url.length - 1];
    if (/[.,;:!?'"]/.test(c) || (c === ')' && !url.includes('(')) || (c === ']' && !url.includes('['))) {
      trail = c + trail;
      url = url.slice(0, -1);
    } else break;
  }
  return [url, trail];
}

export function webRules(t, ctx) {
  const s = t.s;
  if (s.includes('://') || /www\./i.test(s)) {
    t.replace(/(?<![\w@./])(?:(?:https?|ftp):\/\/|www\.)[^\s<>"]+/gi, (m) => {
      const [url, trail] = splitTrail(m[0]);
      const said = sayUrl(url, ctx);
      return [[said, 0, url.length], [trail, url.length, m[0].length]];
    });
  }
  if (t.s.includes('@')) {
    t.replace(/(?<![\w.+\-@])[\w.+\-]+@[\w\-]+(?:\.[\w\-]+)+/g, (m) => {
      const at = m[0].indexOf('@');
      const user = m[0].slice(0, at).replace(/\./g, ' dot ').replace(/_/g, ' underscore ').replace(/\+/g, ' plus ').replace(/-/g, dash(ctx));
      return user + ' at ' + sayHost(m[0].slice(at + 1), ctx);
    });
    t.replace(/(?<![\w@])@([A-Za-z_]\w{0,30})/g, (m) => 'at ' + m[1].replace(/_/g, ' '));
  }
  if (t.s.includes('.')) {
    // bare domains: example.com, bbc.co.uk/news
    t.replace(DOMAIN_RE, (m) => {
      const host = m[1] + m[2];
      if (/^\d+\.$/.test(m[1])) return null;
      const [path, trail] = splitTrail(m[3]);
      if (!path) return sayHost(host, ctx);
      return [[sayUrl(host + path, ctx), 0, host.length + path.length], [trail, host.length + path.length, m[0].length]];
    });
    // file names: report.pdf, node.js, README.md
    t.replace(FILE_RE, (m) => sayFile(m[0]));
    // .NET
    t.replace(/(?<![\w.])\.NET\b/g, 'dot net');
  }
  return t;
}
