/*
 * Readout core: pure text and timing helpers with no DOM access.
 * Loaded in the page as window.ReadoutCore, and in Node tests via require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ReadoutCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Each utterance stays short. Chrome's online voices cut out after ~15 s of
  // continuous speech, and Android's speech engine has a per-utterance length cap.
  const MAX_CHUNK = 200;
  const LETTER = /[\p{L}\p{N}]/u;
  const HAS_SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

  /* ---------- input cleanup ---------- */

  function normalizeText(text) {
    return String(text == null ? '' : text)
      .replace(/\r\n?/g, '\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  }

  /* ---------- line breaks ---------- */

  const TERMINAL = /[.!?…:;"”’')\]]$/;
  const LIST_START = /^(?:[-*•▪◦‣–—]|\d{1,3}[.)]|[a-zA-Z][.)])\s/;
  const HEADING = /^#{1,6}\s/;

  // Is the newline between these two lines just a hard wrap inside a sentence?
  function isSoftBreak(prev, next, aggressive) {
    const p = prev.trim();
    const n = next.trim();
    if (!p || !n) return false;
    if (LIST_START.test(n) || HEADING.test(n) || HEADING.test(p)) return false;
    if (/^\p{Ll}/u.test(n)) return true;
    if (TERMINAL.test(p)) return aggressive ? p.length >= 55 : false;
    return p.length >= (aggressive ? 40 : 55);
  }

  function softNewlines(text, aggressive) {
    const soft = [];
    let i = text.indexOf('\n');
    while (i !== -1) {
      const a = i === 0 ? 0 : text.lastIndexOf('\n', i - 1) + 1;
      let b = text.indexOf('\n', i + 1);
      if (b === -1) b = text.length;
      if (isSoftBreak(text.slice(a, i), text.slice(i + 1, b), aggressive)) soft.push(i);
      i = text.indexOf('\n', i + 1);
    }
    return soft;
  }

  // Same length as the input: soft newlines become spaces so a sentence that
  // wraps across lines is still read as one sentence.
  function maskSoftBreaks(text) {
    const soft = softNewlines(text, false);
    if (!soft.length) return text;
    const parts = [];
    let last = 0;
    for (const i of soft) {
      parts.push(text.slice(last, i), ' ');
      last = i + 1;
    }
    parts.push(text.slice(last));
    return parts.join('');
  }

  // Rewrites hard-wrapped text (PDFs, emails) into flowing paragraphs.
  function reflow(text, opts) {
    const aggressive = !opts || opts.aggressive !== false;
    let t = normalizeText(text);
    t = t.replace(/(\p{L})-\n(?=\p{Ll})/gu, '$1'); // re-join hyphenated words
    const soft = new Set(softNewlines(t, aggressive));
    let out = '';
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      out += c === '\n' && soft.has(i) ? ' ' : c;
    }
    return out
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /* ---------- sentence chunking ---------- */

  const segmenters = new Map();
  function getSegmenter(lang) {
    const key = lang || '';
    if (!segmenters.has(key)) {
      let seg;
      try {
        seg = new Intl.Segmenter(lang || undefined, { granularity: 'sentence' });
      } catch (e) {
        seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
      }
      segmenters.set(key, seg);
    }
    return segmenters.get(key);
  }

  function splitSentences(str, lang) {
    const out = [];
    if (HAS_SEGMENTER) {
      for (const s of getSegmenter(lang).segment(str)) {
        out.push({ start: s.index, end: s.index + s.segment.length });
      }
      return out;
    }
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*\s*|$)/g;
    let m;
    while ((m = re.exec(str))) {
      if (!m[0]) {
        re.lastIndex++;
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  // Sentence ends that are probably abbreviations or initials, not real ends.
  const ABBREV = /(?:^|[\s(])(?:mr|mrs|ms|dr|prof|sr|jr|st|mt|vs|etc|e\.g|i\.e|cf|al|fig|figs|eq|eqs|no|vol|ch|sec|pp?|ed|eds|approx|dept|est|inc|ltd|co|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|\p{L})\.$/iu;

  function isBlank(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\v';
  }

  function pushIfSpeakable(chunks, seg, a, b) {
    while (a < b && isBlank(seg[a])) a++;
    while (b > a && isBlank(seg[b - 1])) b--;
    if (b > a && LETTER.test(seg.slice(a, b))) chunks.push({ start: a, end: b });
  }

  function splitLong(seg, a, b, max, chunks) {
    while (b - a > max) {
      const win = seg.slice(a, a + max);
      let cut = -1;
      const re = /[,;:—–)\]](?=\s)|\s[—–-]\s/g;
      let m;
      while ((m = re.exec(win))) {
        const pos = m.index + m[0].length;
        if (pos >= max * 0.4) cut = pos;
      }
      if (cut === -1) {
        const sp = win.lastIndexOf(' ');
        if (sp >= max * 0.4) cut = sp;
      }
      if (cut === -1) cut = max;
      pushIfSpeakable(chunks, seg, a, a + cut);
      a += cut;
      while (a < b && isBlank(seg[a])) a++;
    }
    pushIfSpeakable(chunks, seg, a, b);
  }

  function chunkBlock(seg, bs, be, chunks, max, lang) {
    const pieces = [];
    for (const s of splitSentences(seg.slice(bs, be), lang)) {
      let a = bs + s.start;
      let b = bs + s.end;
      while (a < b && isBlank(seg[a])) a++;
      while (b > a && isBlank(seg[b - 1])) b--;
      if (b > a && LETTER.test(seg.slice(a, b))) pieces.push([a, b]);
    }
    for (let i = 0; i < pieces.length; i++) {
      const a = pieces[i][0];
      let b = pieces[i][1];
      while (i + 1 < pieces.length && ABBREV.test(seg.slice(a, b)) && pieces[i + 1][1] - a <= max * 1.5) {
        b = pieces[i + 1][1];
        i++;
      }
      splitLong(seg, a, b, max, chunks);
    }
  }

  // Splits text into speakable chunks. Offsets index into the original text.
  function chunkText(text, opts) {
    const max = (opts && opts.max) || MAX_CHUNK;
    const lang = opts && opts.lang;
    const chunks = [];
    if (!text) return chunks;
    const seg = maskSoftBreaks(text);
    let start = 0;
    while (start <= seg.length) {
      let nl = seg.indexOf('\n', start);
      if (nl === -1) nl = seg.length;
      if (nl > start) chunkBlock(seg, start, nl, chunks, max, lang);
      if (nl >= seg.length) break;
      start = nl + 1;
    }
    return chunks;
  }

  // cum[i] = characters before chunk i; cum[n] = total characters.
  function prefixLengths(chunks) {
    const cum = new Array(chunks.length + 1);
    cum[0] = 0;
    for (let i = 0; i < chunks.length; i++) cum[i + 1] = cum[i] + (chunks[i].end - chunks[i].start);
    return cum;
  }

  // Index of the chunk that contains (or follows) a character offset.
  function findChunkIndex(chunks, offset) {
    if (!chunks.length) return 0;
    let lo = 0;
    let hi = chunks.length - 1;
    if (offset <= chunks[0].start) return 0;
    if (offset >= chunks[hi].end) return hi;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (chunks[mid].end <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /* ---------- text sent to the speech engine ---------- */

  const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'”’)\]]+/gi;

  function spaces(n) {
    return n > 0 ? ' '.repeat(n) : '';
  }

  // Strips symbols that speech engines read aloud badly. Output length always
  // equals input length, so word-boundary positions still line up with the text.
  function speakable(str) {
    let s = String(str);
    s = s.replace(URL_RE, (m) => (m.length >= 4 ? 'link' + spaces(m.length - 4) : spaces(m.length)));
    s = s.replace(/^[ \t]*>+/gm, (m) => spaces(m.length));
    s = s.replace(/([-=_~])\1{2,}/g, (m) => spaces(m.length));
    s = s.replace(/\.{4,}/g, (m) => spaces(m.length));
    s = s.replace(/[*_`~#|•▪◦►▶■□●]+/g, (m) => spaces(m.length));
    return s;
  }

  /* ---------- titles, counts, formatting ---------- */

  function deriveTitle(text) {
    const m = String(text || '').match(/^.*[\p{L}\p{N}].*$/mu);
    let line = m ? m[0] : '';
    line = line.replace(/^[\s#>*\-•]+/, '').replace(/\s+/g, ' ').trim();
    if (!line) return 'Untitled';
    if (line.length <= 60) return line;
    const cut = line.slice(0, 60);
    const sp = cut.lastIndexOf(' ');
    return (sp > 30 ? cut.slice(0, sp) : cut).replace(/[,;:.\-–—\s]+$/, '') + '…';
  }

  function wordCount(text) {
    const m = String(text || '').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
    return m ? m.length : 0;
  }

  function formatDuration(sec) {
    if (!isFinite(sec) || sec <= 0) return '0 min';
    if (sec < 60) return 'under 1 min';
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return h + ' h' + (mm ? ' ' + mm + ' min' : '');
  }

  function relativeTime(ts, now) {
    if (!ts) return '';
    const diff = Math.max(0, (now || Date.now()) - ts);
    const min = Math.round(diff / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return min + ' min ago';
    const h = Math.round(min / 60);
    if (h < 24) return h + ' h ago';
    const d = Math.round(h / 24);
    if (d === 1) return 'yesterday';
    if (d < 7) return d + ' days ago';
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts));
    } catch (e) {
      return new Date(ts).toDateString();
    }
  }

  /* ---------- dictation ---------- */

  const SPOKEN = [
    [/[ \t]*\bnew paragraph\b[ \t]*/gi, '\n\n'],
    [/[ \t]*\b(?:new line|next line)\b[ \t]*/gi, '\n'],
    [/[ \t]*\b(?:full stop|period)\b/gi, '.'],
    [/[ \t]*\bcomma\b/gi, ','],
    [/[ \t]*\bquestion mark\b/gi, '?'],
    [/[ \t]*\bexclamation (?:mark|point)\b/gi, '!'],
    [/[ \t]*\bsemicolon\b/gi, ';'],
    [/[ \t]*\bcolon\b/gi, ':'],
  ];

  function applySpokenPunctuation(str) {
    let s = String(str || '');
    for (const [re, rep] of SPOKEN) s = s.replace(re, rep);
    return s;
  }

  // Formats dictated text for insertion between `before` and `after`:
  // spacing on both sides and capitals at sentence starts.
  function formatInsert(before, piece, after) {
    let p = String(piece || '').replace(/[ \t]+/g, ' ');
    if (!/\S/.test(p)) return '';
    const tail = String(before || '').slice(-200);
    const head = String(after || '').slice(0, 5);
    p = p.replace(/^ +/, '');
    const startsSentence = !/\S/.test(tail) || /[.!?]["”’)]?\s*$/.test(tail) || /\n\s*$/.test(tail);
    if (startsSentence) p = p.replace(/^(\s*)(\p{Ll})/u, (m, sp, ch) => sp + ch.toUpperCase());
    p = p.replace(/([.!?]\s+|\n\s*)(\p{Ll})/gu, (m, sep, ch) => sep + ch.toUpperCase());
    if (tail && !/[\s(\[{“"‘']$/.test(tail) && !/^[\s,.;:!?)\]}”’'"]/.test(p)) p = ' ' + p;
    if (head && !/^[\s,.;:!?)\]}”’]/.test(head) && !/\s$/.test(p)) p += ' ';
    return p;
  }

  /* ---------- voices ---------- */

  function normalizeLang(lang) {
    return String(lang || '').replace(/_/g, '-');
  }

  function pickVoice(voices, uri) {
    if (!uri || !voices || !voices.length) return null;
    return voices.find((v) => v.voiceURI === uri) || null;
  }

  /* ---------- backup ---------- */

  function isValidDoc(d) {
    return !!d && typeof d.id === 'string' && d.id.length > 0 && typeof d.text === 'string';
  }

  // When a doc last changed in any way that syncs (text, title, pin).
  function docStamp(d) {
    return Number(d && d.changedAt) || Number(d && d.updatedAt) || 0;
  }

  function mergeDocs(existing, incoming) {
    const byId = new Map(existing.map((d) => [d.id, d]));
    let added = 0;
    let updated = 0;
    for (const raw of incoming || []) {
      if (!isValidDoc(raw)) continue;
      const d = {
        id: raw.id,
        title: typeof raw.title === 'string' && raw.title.trim() ? raw.title : deriveTitle(raw.text),
        titleLocked: !!raw.titleLocked,
        text: normalizeText(raw.text),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        pinned: !!raw.pinned,
      };
      if (Number(raw.changedAt)) d.changedAt = Number(raw.changedAt);
      if (raw.vv) d.vv = cleanVV(raw.vv);
      if (raw.tv) d.tv = cleanVV(raw.tv);
      if (Number(raw.pinAt)) d.pinAt = Number(raw.pinAt);
      if (Number(raw.titleAt)) d.titleAt = Number(raw.titleAt);
      const cur = byId.get(d.id);
      if (!cur) {
        byId.set(d.id, d);
        added++;
      } else if (docStamp(d) > docStamp(cur)) {
        byId.set(d.id, d);
        updated++;
      }
    }
    return { docs: Array.from(byId.values()), added, updated };
  }

  /* ---------- sync ---------- */

  // The synced library lives in a few files: one index (reading positions and
  // deletions) and up to 16 shards of texts, so a gist never needs more than 17 files.
  const SYNC_SCHEMA = 1;
  const SYNC_INDEX = 'readout-index.json';
  const SYNC_SHARD = /^readout-docs-[0-9a-f]\.json$/;

  function isSyncFile(name) {
    return name === SYNC_INDEX || SYNC_SHARD.test(name);
  }

  function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function shardName(id) {
    return 'readout-docs-' + (hash32(id) % 16).toString(16) + '.json';
  }

  /*
   * Version vectors: { deviceId: number of changes made there }. They tell
   * "this version already includes that one" apart from "both changed at once",
   * without trusting device clocks. Each doc has two: vv counts every change,
   * tv counts only changes to the text.
   */
  function cleanVV(vv) {
    const out = {};
    if (vv && typeof vv === 'object') {
      for (const k of Object.keys(vv).sort()) {
        const n = Math.floor(Number(vv[k]));
        if (n > 0) out[k] = n;
      }
    }
    return out;
  }

  // 0: same, 1: a includes b, -1: b includes a, 2: changed separately.
  function compareVV(a, b) {
    let more = false;
    let less = false;
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const x = a[k] || 0;
      const y = b[k] || 0;
      if (x > y) more = true;
      else if (x < y) less = true;
    }
    return more && less ? 2 : more ? 1 : less ? -1 : 0;
  }

  function maxVV(a, b) {
    const out = cleanVV(a);
    const other = cleanVV(b);
    for (const k of Object.keys(other)) out[k] = Math.max(out[k] || 0, other[k]);
    return cleanVV(out);
  }

  // Docs from before sync have no vectors. Seeding them from their text keeps
  // identical copies equal, while copies that drifted apart count as separate changes.
  function seedVV(d) {
    if (d.vv) return false;
    const k = 'v0-' + hash32(String(d.text)).toString(36);
    d.vv = { [k]: 1 };
    d.tv = { [k]: 1 };
    return true;
  }

  // Counts one more change made on `device`.
  function bumpVV(vv, device) {
    const out = cleanVV(vv);
    out[device] = (out[device] || 0) + 1;
    return cleanVV(out);
  }

  // Fixed fields in a fixed order, so every device writes the same doc identically.
  function syncDoc(d) {
    return {
      id: d.id,
      title: typeof d.title === 'string' && d.title.trim() ? d.title : deriveTitle(d.text),
      titleLocked: !!d.titleLocked,
      text: d.text,
      createdAt: Number(d.createdAt) || 0,
      updatedAt: Number(d.updatedAt) || 0,
      changedAt: docStamp(d),
      pinned: !!d.pinned,
      pinAt: Number(d.pinAt) || 0,
      titleAt: Number(d.titleAt) || 0,
      vv: cleanVV(d.vv),
      tv: cleanVV(d.tv),
    };
  }

  function syncPos(p) {
    return {
      id: p.id,
      offset: Math.max(0, Number(p.offset) || 0),
      progress: clamp(Number(p.progress) || 0, 0, 1),
      done: !!p.done,
      at: Number(p.at) || 0,
    };
  }

  function syncTomb(t) {
    if (typeof t === 'number') return t > 0 ? { at: t, vv: {} } : null;
    if (!t || typeof t !== 'object' || !(Number(t.at) > 0)) return null;
    return { at: Number(t.at), vv: cleanVV(t.vv) };
  }

  // Newer stamp wins; on a tie the larger serialization wins, so every device picks the same one.
  function wins(a, b, stamp) {
    const sa = stamp(a);
    const sb = stamp(b);
    return sa !== sb ? sa > sb : JSON.stringify(a) > JSON.stringify(b);
  }

  function byId(a, b) {
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }

  // The losing side of a clash, kept as its own text. Its id comes from its
  // content, so devices that spot the same clash make the same copy.
  function clashCopy(d, suffix) {
    const id = d.id + '-' + hash32(d.text + '\u0000' + JSON.stringify(d.tv)).toString(36);
    const title = d.title.endsWith(suffix) ? d.title : d.title + suffix;
    return Object.assign({}, d, { id, title, titleLocked: true });
  }

  /*
   * Merges this device's library with the synced copy. Nothing is lost silently:
   * - a version that includes the other one wins;
   * - if both sides changed the same doc, its title and pin each keep their
   *   latest change, and if both changed its text, the newer text wins and the
   *   other is kept as a copy;
   * - a deletion removes only the versions the deleting device had seen.
   * local/remote: { docs, positions, tombs: { id: { at, vv } } }
   * Returns { docs, positions, tombs, copies } with docs/positions sorted by id.
   */
  function mergeSync(local, remote, opts) {
    const o = opts || {};
    const pruneBefore = Number(o.pruneBefore) || 0;
    const suffix = o.copySuffix || ' (other copy)';
    const maxText = Number(o.maxText) || Infinity;

    const tombs = new Map();
    for (const src of [local && local.tombs, remote && remote.tombs]) {
      if (!src || typeof src !== 'object') continue;
      for (const id of Object.keys(src)) {
        const t = syncTomb(src[id]);
        if (!t || t.at <= pruneBefore) continue;
        const cur = tombs.get(id);
        tombs.set(id, cur ? { at: Math.max(cur.at, t.at), vv: maxVV(cur.vv, t.vv) } : t);
      }
    }

    const collect = (list) => {
      const m = new Map();
      for (const raw of list || []) {
        if (!isValidDoc(raw) || !raw.text.trim() || raw.text.length > maxText) continue;
        const d = syncDoc(raw);
        const cur = m.get(d.id);
        if (!cur || wins(d, cur, docStamp)) m.set(d.id, d);
      }
      return m;
    };
    const mine = collect(local && local.docs);
    const theirs = collect(remote && remote.docs);

    const docs = new Map();
    const copies = [];
    for (const id of new Set([...mine.keys(), ...theirs.keys()])) {
      const a = mine.get(id);
      const b = theirs.get(id);
      let d = a || b;
      if (a && b) {
        const c = compareVV(a.vv, b.vv);
        if (c === 1) d = a;
        else if (c === -1) d = b;
        else {
          const meta = wins(a, b, docStamp) ? a : b;
          const tc = compareVV(a.tv, b.tv);
          const body = tc === 1 ? a : tc === -1 ? b : meta;
          if (tc !== 1 && tc !== -1 && a.text !== b.text) {
            const copy = clashCopy(body === a ? b : a, suffix);
            if (!mine.has(copy.id) && !theirs.has(copy.id)) {
              docs.set(copy.id, copy);
              copies.push(copy.id);
            }
          }
          const pin = a.pinAt !== b.pinAt ? (a.pinAt > b.pinAt ? a : b) : meta;
          const named = a.titleAt !== b.titleAt ? (a.titleAt > b.titleAt ? a : b) : meta;
          d = Object.assign({}, meta, {
            title: named.titleLocked ? named.title : deriveTitle(body.text),
            titleLocked: named.titleLocked,
            titleAt: named.titleAt,
            text: body.text,
            updatedAt: body.updatedAt,
            changedAt: Math.max(a.changedAt, b.changedAt),
            pinned: pin.pinned,
            pinAt: pin.pinAt,
            vv: maxVV(a.vv, b.vv),
            tv: maxVV(a.tv, b.tv),
          });
        }
      }
      const t = tombs.get(id);
      if (t) {
        if (compareVV(d.vv, t.vv) <= 0) continue; // the deleting device had seen this version
        tombs.delete(id); // changed somewhere the deletion didn't know about, so it stays
      }
      docs.set(id, d);
    }

    const positions = new Map();
    for (const list of [local && local.positions, remote && remote.positions]) {
      for (const raw of list || []) {
        if (!raw || typeof raw.id !== 'string' || !docs.has(raw.id)) continue;
        const p = syncPos(raw);
        const cur = positions.get(p.id);
        if (!cur || wins(p, cur, (x) => x.at)) positions.set(p.id, p);
      }
    }

    return {
      docs: [...docs.values()].sort(byId),
      positions: [...positions.values()].sort(byId),
      tombs: Object.fromEntries([...tombs.keys()].sort().map((id) => [id, tombs.get(id)])),
      copies,
    };
  }

  // Splits a merged library into gist files: { filename: content }.
  function buildSyncFiles(m) {
    const files = {};
    files[SYNC_INDEX] = JSON.stringify({ app: 'readout', schema: SYNC_SCHEMA, positions: m.positions || [], tombs: m.tombs || {} });
    const shards = new Map();
    for (const d of m.docs || []) {
      const name = shardName(d.id);
      if (!shards.has(name)) shards.set(name, []);
      shards.get(name).push(d);
    }
    for (const name of [...shards.keys()].sort()) {
      files[name] = JSON.stringify({ app: 'readout', schema: SYNC_SCHEMA, docs: shards.get(name) });
    }
    return files;
  }

  // Reads gist files back into { docs, positions, tombs }. `newer` means another
  // device wrote a format this version doesn't know, and `bad` lists unreadable files.
  function parseSyncFiles(files) {
    const out = { docs: [], positions: [], tombs: {}, newer: false, bad: [] };
    for (const name of Object.keys(files || {}).sort()) {
      if (!isSyncFile(name)) continue;
      let data = null;
      try {
        data = JSON.parse(files[name]);
      } catch (e) {
        /* unreadable */
      }
      if (!data || typeof data !== 'object' || data.app !== 'readout') {
        out.bad.push(name);
        continue;
      }
      if (Number(data.schema) > SYNC_SCHEMA) out.newer = true;
      if (name === SYNC_INDEX) {
        if (Array.isArray(data.positions)) out.positions = data.positions;
        if (data.tombs && typeof data.tombs === 'object') out.tombs = data.tombs;
      } else if (Array.isArray(data.docs)) {
        for (const d of data.docs) out.docs.push(d);
      }
    }
    return out;
  }

  // The gist update that turns `remote` into `next`: changed files, and null for files to delete.
  function diffSyncFiles(next, remote) {
    const patch = {};
    let n = 0;
    for (const name of Object.keys(next)) {
      if (!remote || remote[name] !== next[name]) {
        patch[name] = { content: next[name] };
        n++;
      }
    }
    for (const name of Object.keys(remote || {})) {
      if (isSyncFile(name) && !(name in next)) {
        patch[name] = null;
        n++;
      }
    }
    return n ? patch : null;
  }

  // A sync key carries everything another device needs: the gist and the token.
  const SYNC_KEY_PREFIX = 'readout-sync:';
  function makeSyncKey(gistId, token) {
    return SYNC_KEY_PREFIX + gistId + ':' + token;
  }
  function parseSyncKey(str) {
    const s = String(str || '').trim();
    if (s.startsWith(SYNC_KEY_PREFIX)) {
      const m = s.slice(SYNC_KEY_PREFIX.length).match(/^([0-9a-f]{20,40}):(\S{20,})$/i);
      return m ? { gistId: m[1].toLowerCase(), token: m[2] } : null;
    }
    if (/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(s)) return { gistId: null, token: s };
    return null;
  }

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  return {
    MAX_CHUNK,
    normalizeText,
    isSoftBreak,
    maskSoftBreaks,
    reflow,
    splitSentences,
    chunkText,
    prefixLengths,
    findChunkIndex,
    speakable,
    deriveTitle,
    wordCount,
    formatDuration,
    relativeTime,
    applySpokenPunctuation,
    formatInsert,
    normalizeLang,
    pickVoice,
    docStamp,
    mergeDocs,
    SYNC_INDEX,
    isSyncFile,
    shardName,
    compareVV,
    maxVV,
    bumpVV,
    seedVV,
    syncDoc,
    mergeSync,
    buildSyncFiles,
    parseSyncFiles,
    diffSyncFiles,
    makeSyncKey,
    parseSyncKey,
    uid,
    clamp,
  };
});
