// The misaki lexicon in a compact text form that is searched in place: no parse step
// at load, and one ASCII string in memory instead of ~180,000 object properties
// (~4 MB instead of ~40 MB of heap).
//
//   #readkit-lex 1 <dialect> <note>
//   #map <symbol><code>...      phoneme symbols written as single ASCII codes
//   #gold
//   <p><key suffix>\t<phonemes>  sorted by key; p = chr(48 + length shared with the previous key)
//   ...
//   #silver
//   ...
//
// Every 16th line of a section stores its whole key (p = '0'), so a lookup is a binary
// search over those lines followed by a short forward scan.

const BLOCK = 16;
const MAX_PREFIX = 40;

// Codes for the non-ASCII misaki symbols. None of these ASCII characters occur in misaki
// phoneme strings, so encoding is reversible.
const CODES = [
  ['ˈ', '1'], ['ˌ', '2'], ['ː', ':'], ['ə', '@'], ['ɹ', 'r'], ['ɪ', 'x'], ['ɛ', 'E'], ['æ', '&'],
  ['ɑ', 'B'], ['ŋ', 'N'], ['ʌ', 'V'], ['ɾ', 'D'], ['ɡ', 'g'], ['ᵊ', '3'], ['ʃ', 'S'], ['ɔ', 'C'],
  ['ʤ', 'J'], ['ᵻ', 'X'], ['ɜ', 'R'], ['ʧ', 'c'], ['θ', 'H'], ['ʊ', 'U'], ['ð', 'F'], ['ʒ', 'Z'],
  ['ʔ', '?'], ['ɒ', 'K'], ['ɐ', 'e'],
];

function decoderOf(pairs) {
  const table = new Array(128).fill(null);
  for (let i = 0; i + 1 < pairs.length; i += 2) table[pairs.charCodeAt(i + 1)] = pairs[i];
  return (s) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += (c < 128 && table[c]) || s[i];
    }
    return out;
  };
}

// key < text[at..end)? Returns <0, 0, >0 like a comparator, without making substrings.
function compareAt(key, text, at, end) {
  const n = Math.min(key.length, end - at);
  for (let i = 0; i < n; i++) {
    const d = key.charCodeAt(i) - text.charCodeAt(at + i);
    if (d) return d;
  }
  return key.length - (end - at);
}

class PackedDict {
  constructor(text, start, end, decode) {
    this.text = text;
    this.decode = decode;
    // offsets of the restart lines (full keys)
    const starts = [];
    let n = 0;
    let i = start;
    while (i < end) {
      if (n % BLOCK === 0) starts.push(i);
      n++;
      const nl = text.indexOf('\n', i);
      i = nl < 0 || nl > end ? end : nl + 1;
    }
    this.starts = Int32Array.from(starts);
    this.end = end;
    this.size = n;
  }

  get(key) {
    const { text, starts } = this;
    let lo = 0;
    let hi = starts.length - 1;
    let block = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = starts[mid] + 1;
      const c = compareAt(key, text, at, text.indexOf('\t', at));
      if (c === 0) return this.value(text.indexOf('\t', at) + 1);
      if (c > 0) {
        block = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (block < 0) return undefined;
    // scan the block, rebuilding keys from their shared prefixes
    let i = starts[block];
    let cur = '';
    const stop = block + 1 < starts.length ? starts[block + 1] : this.end;
    while (i < stop) {
      const tab = text.indexOf('\t', i);
      cur = cur.slice(0, text.charCodeAt(i) - 48) + text.slice(i + 1, tab);
      if (cur === key) return this.value(tab + 1);
      if (cur > key) return undefined;
      const nl = text.indexOf('\n', tab);
      i = nl < 0 ? stop : nl + 1;
    }
    return undefined;
  }

  value(at) {
    const nl = this.text.indexOf('\n', at);
    return this.decode(this.text.slice(at, nl < 0 || nl > this.end ? this.end : nl));
  }

  // Every [key, phonemes] pair, in order (tests and tools only).
  *entries() {
    const { text } = this;
    for (let b = 0; b < this.starts.length; b++) {
      let i = this.starts[b];
      let cur = '';
      const stop = b + 1 < this.starts.length ? this.starts[b + 1] : this.end;
      while (i < stop) {
        const tab = text.indexOf('\t', i);
        cur = cur.slice(0, text.charCodeAt(i) - 48) + text.slice(i + 1, tab);
        const nl = text.indexOf('\n', tab);
        const e = nl < 0 || nl > stop ? stop : nl;
        yield [cur, this.decode(text.slice(tab + 1, e))];
        i = e + 1;
      }
    }
  }
}

export function parsePacked(text) {
  if (!text.startsWith('#readkit-lex 1 ')) throw new Error('Not a readkit lexicon file');
  const line = (at) => text.slice(at, text.indexOf('\n', at));
  const header = line(0).split(' ');
  const mapAt = text.indexOf('\n#map ') + 1;
  const decode = decoderOf(line(mapAt).slice(5));
  const goldAt = text.indexOf('\n#gold\n') + 7;
  const silverMark = text.indexOf('\n#silver\n');
  const silverAt = silverMark + 9;
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end--;
  return {
    dialect: header[2],
    gold: new PackedDict(text, goldAt, silverMark + 1, decode),
    silver: new PackedDict(text, silverAt, end, decode),
  };
}

// Build side: { gold, silver } (Map or object of key -> phonemes) -> file text.
export function packLexicon({ gold, silver }, dialect, note = '') {
  const enc = new Map(CODES);
  const used = new Set(CODES.map(([, c]) => c));
  const encode = (v) => {
    let out = '';
    for (const ch of v) {
      if (used.has(ch)) throw new Error(`phoneme string uses the code character ${ch}: ${v}`);
      if (ch === '\t' || ch === '\n') throw new Error('bad phoneme string');
      out += enc.get(ch) ?? ch;
    }
    return out;
  };
  const section = (dict) => {
    const m = dict instanceof Map ? dict : new Map(Object.entries(dict));
    const keys = [...m.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    let prev = '';
    return keys.map((k, n) => {
      if (/[\t\n]/.test(k) || !k) throw new Error('bad key ' + JSON.stringify(k));
      let p = 0;
      if (n % BLOCK) while (p < prev.length && p < k.length && p < MAX_PREFIX && prev[p] === k[p]) p++;
      prev = k;
      return String.fromCharCode(48 + p) + k.slice(p) + '\t' + encode(m.get(k));
    }).join('\n');
  };
  return [
    `#readkit-lex 1 ${dialect} ${note}`.trim(),
    '#map ' + CODES.map(([s, c]) => s + c).join(''),
    '#gold',
    section(gold),
    '#silver',
    section(silver),
    '',
  ].join('\n');
}
