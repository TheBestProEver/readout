// ZIP reader for DOCX, PPTX, ODF and EPUB. Works over a Blob with random access (only the
// tail, the central directory and the entries read are loaded, so a 150 MB image-heavy
// EPUB costs almost no memory) or over bytes already in memory. Entry sizes come from the
// central directory, because local headers may leave them out. ZIP64 aware. Inflates with
// DecompressionStream('deflate-raw'), which also works in workers and Node.

import { userError, toBytes } from './util.js';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const END64 = 0x06064b50;
const LOC64 = 0x07064b50;
const DESC = 0x08074b50;
const MAX_ENTRY = 512 * 1024 * 1024; // a guard against zip bombs
const MAX_SCAN = 256 * 1024 * 1024;

const view = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
const utf8 = new TextDecoder('utf-8');
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
// IBM code page 437, the original ZIP file-name encoding (bytes 0x80-0xFF).
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

function decodeName(bytes, flags, extra) {
  // Info-ZIP Unicode Path extra field (0x7075): version, CRC-32, then the UTF-8 name.
  for (let x = 0; x + 4 <= extra.length; ) {
    const id = extra[x] | (extra[x + 1] << 8);
    const sz = extra[x + 2] | (extra[x + 3] << 8);
    if (id === 0x7075 && sz > 5) return utf8.decode(extra.subarray(x + 9, x + 4 + sz));
    x += 4 + sz;
  }
  if (flags & 0x800) return utf8.decode(bytes);
  // Most tools write UTF-8 without setting the flag; true CP437 names are rare.
  try {
    return utf8Strict.decode(bytes);
  } catch (e) {
    let s = '';
    for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437[b - 0x80];
    return s;
  }
}

function normName(name) {
  return name.replace(/\\/g, '/').replace(/^(?:\.?\/)+/, '');
}

// ZIP64 extra field (id 1): the 64-bit values for whichever fields were 0xFFFFFFFF, in order.
function zip64Extra(extra, e) {
  for (let x = 0; x + 4 <= extra.length; ) {
    const id = extra[x] | (extra[x + 1] << 8);
    const sz = extra[x + 2] | (extra[x + 3] << 8);
    if (id === 1) {
      const dv = view(extra.subarray(x + 4, x + 4 + sz));
      let q = 0;
      const next = () => {
        const v = q + 8 <= dv.byteLength ? Number(dv.getBigUint64(q, true)) : -1;
        q += 8;
        return v;
      };
      if (e.usize === 0xffffffff) e.usize = next();
      if (e.csize === 0xffffffff) e.csize = next();
      if (e.offset === 0xffffffff) e.offset = next();
      return;
    }
    x += 4 + sz;
  }
}

function parseCentral(cd, shift) {
  const dv = view(cd);
  const entries = new Map();
  for (let p = 0; p + 46 <= cd.length && dv.getUint32(p, true) === CENTRAL; ) {
    const flags = dv.getUint16(p + 8, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
    const e = {
      name: normName(decodeName(cd.subarray(p + 46, p + 46 + nlen), flags, extra)),
      method: dv.getUint16(p + 10, true),
      flags,
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      offset: dv.getUint32(p + 42, true),
    };
    zip64Extra(extra, e);
    e.offset += shift;
    e.encrypted = !!(flags & 1);
    if (e.name && !e.name.endsWith('/') && !entries.has(e.name)) entries.set(e.name, e);
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

// Reads the directory through yield [from, to] requests, so the same code runs
// synchronously over bytes and asynchronously over a Blob.
function* directory(size) {
  const tailStart = Math.max(0, size - (65535 + 22 + 20));
  const tail = yield [tailStart, size];
  const tv = view(tail);
  let e = -1;
  let loose = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) !== END) continue;
    if (loose < 0) loose = i;
    // The comment length must reach the end of the file; otherwise this is a lookalike inside the comment.
    if (i + 22 + tv.getUint16(i + 20, true) === tail.length) {
      e = i;
      break;
    }
  }
  if (e < 0) e = loose;
  if (e < 0) return null;
  const endPos = tailStart + e;
  let cdSize = tv.getUint32(e + 12, true);
  let cdOff = tv.getUint32(e + 16, true);
  if (tv.getUint16(e + 10, true) === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const l = e - 20;
    if (l >= 0 && tv.getUint32(l, true) === LOC64) {
      const off = Number(tv.getBigUint64(l + 8, true));
      const z = yield [off, off + 56];
      if (z.length >= 56 && view(z).getUint32(0, true) === END64) {
        cdSize = Number(view(z).getBigUint64(40, true));
        cdOff = Number(view(z).getBigUint64(48, true));
      }
    }
  }
  let cd = yield [cdOff, cdOff + cdSize];
  let shift = 0;
  if (cd.length < 4 || view(cd).getUint32(0, true) !== CENTRAL) {
    // Data prepended to the archive (self-extractors, some mail gateways) shifts every offset.
    const delta = endPos - cdOff - cdSize;
    if (delta <= 0) return null;
    cd = yield [cdOff + delta, cdOff + delta + cdSize];
    if (cd.length < 4 || view(cd).getUint32(0, true) !== CENTRAL) return null;
    shift = delta;
  }
  return parseCentral(cd, shift);
}

function findSig(u8, sig, from) {
  const b0 = sig & 0xff;
  const b1 = (sig >>> 8) & 0xff;
  const b2 = (sig >>> 16) & 0xff;
  const b3 = sig >>> 24;
  for (let i = u8.indexOf(b0, from); i >= 0 && i + 3 < u8.length; i = u8.indexOf(b0, i + 1)) {
    if (u8[i + 1] === b1 && u8[i + 2] === b2 && u8[i + 3] === b3) return i;
  }
  return -1;
}

// No usable central directory (a truncated download, say): walk the local headers instead.
export function scanLocal(u8) {
  const dv = view(u8);
  const entries = new Map();
  for (let p = findSig(u8, LOCAL, 0); p >= 0 && p + 30 <= u8.length; ) {
    const flags = dv.getUint16(p + 6, true);
    const nlen = dv.getUint16(p + 26, true);
    const xlen = dv.getUint16(p + 28, true);
    const extra = u8.subarray(p + 30 + nlen, p + 30 + nlen + xlen);
    const e = {
      name: normName(decodeName(u8.subarray(p + 30, p + 30 + nlen), flags, extra)),
      method: dv.getUint16(p + 8, true),
      flags,
      csize: dv.getUint32(p + 18, true),
      usize: dv.getUint32(p + 22, true),
      offset: p,
      encrypted: !!(flags & 1),
    };
    zip64Extra(extra, e);
    const data = p + 30 + nlen + xlen;
    if (flags & 8 && !e.csize) {
      // Sizes follow the data in a descriptor: find one whose size field matches the distance.
      e.csize = -1;
      for (let d = findSig(u8, DESC, data); d >= 0; d = findSig(u8, DESC, d + 1)) {
        if (d + 12 <= u8.length && dv.getUint32(d + 8, true) === d - data) {
          e.csize = d - data;
          break;
        }
      }
      if (e.csize < 0) {
        const nxt = findSig(u8, LOCAL, data);
        e.csize = (nxt < 0 ? u8.length : nxt) - data;
      }
    }
    if (e.name && !e.name.endsWith('/') && !entries.has(e.name)) entries.set(e.name, e);
    const next = data + Math.max(0, e.csize);
    p = findSig(u8, LOCAL, next > p ? next : p + 4);
  }
  return entries;
}

function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// Inflates raw deflate data. A damaged or cut-off stream returns what could be read.
export async function inflateRaw(data, max = MAX_ENTRY) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer
    .write(data)
    .then(() => writer.close())
    .catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > max) {
        reader.cancel().catch(() => {});
        throw userError('This file unpacks to more data than can be read safely.', 'too-large');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e.user) throw e;
    truncated = true;
  }
  return { data: concat(chunks, total), truncated };
}

function decodeXmlBytes(b) {
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(b);
  return utf8.decode(b);
}

class Zip {
  constructor(entries, read, recovered) {
    this.entries = entries;
    this._read = read;
    this.recovered = recovered;
    this.truncated = false;
    this.names = [...entries.keys()];
    this._lower = null;
  }

  // Exact name first, then percent-decoded, then case-insensitive (some writers differ in case).
  entry(name) {
    if (!name) return null;
    const n = normName(String(name));
    let e = this.entries.get(n);
    if (e) return e;
    let dec = n;
    try {
      dec = decodeURIComponent(n);
    } catch (err) {
      /* keep */
    }
    e = this.entries.get(dec);
    if (e) return e;
    if (!this._lower) {
      this._lower = new Map();
      for (const [k, v] of this.entries) if (!this._lower.has(k.toLowerCase())) this._lower.set(k.toLowerCase(), v);
    }
    return this._lower.get(n.toLowerCase()) || this._lower.get(dec.toLowerCase()) || null;
  }

  has(name) {
    return !!this.entry(name);
  }

  async bytes(name, max = MAX_ENTRY) {
    const e = this.entry(name);
    if (!e) return null;
    if (e.encrypted) throw userError('This file is password-protected. Remove the password and try again.', 'encrypted');
    if (e.usize > max && e.usize !== 0xffffffff) throw userError('This file unpacks to more data than can be read safely.', 'too-large');
    const lh = await this._read(e.offset, e.offset + 30);
    if (lh.length < 30 || view(lh).getUint32(0, true) !== LOCAL) throw userError('This file looks damaged, so it can’t be opened.', 'corrupt');
    const start = e.offset + 30 + view(lh).getUint16(26, true) + view(lh).getUint16(28, true);
    const raw = await this._read(start, start + e.csize);
    if (raw.length < e.csize) this.truncated = true;
    if (e.method === 0) return raw;
    if (e.method !== 8) throw userError('This file uses a kind of compression the browser can’t unpack.', 'unsupported');
    const out = await inflateRaw(raw, max);
    if (out.truncated) this.truncated = true;
    return out.data;
  }

  async text(name) {
    const b = await this.bytes(name);
    return b == null ? null : decodeXmlBytes(b);
  }
}

// src: Blob | Uint8Array | ArrayBuffer
export async function openZip(src) {
  let u8 = toBytes(src);
  const blob = u8 ? null : src;
  if (!u8 && !(typeof Blob !== 'undefined' && blob instanceof Blob)) throw new TypeError('openZip needs a Blob or bytes');
  const size = u8 ? u8.length : blob.size;
  let read = u8 ? (a, b) => u8.subarray(a, b) : async (a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer());
  const gen = directory(size);
  let r = gen.next();
  while (!r.done) r = gen.next(await read(Math.max(0, r.value[0]), Math.min(size, r.value[1])));
  let entries = r.value;
  let recovered = false;
  if (!entries || !entries.size) {
    if (!u8 && size <= MAX_SCAN) {
      const all = new Uint8Array(await blob.arrayBuffer());
      u8 = all;
      read = (a, b) => all.subarray(a, b);
    }
    entries = u8 ? scanLocal(u8) : null;
    recovered = true;
  }
  if (!entries || !entries.size) throw userError('This file looks damaged or incomplete, so it can’t be opened.', 'corrupt');
  return new Zip(entries, async (a, b) => read(a, b), recovered);
}

// Synchronous listing for sniffing: entry names, plus the content of a stored 'mimetype' entry.
// Works on a whole file, or on just its first bytes (then only the leading entries are seen).
export function zipListing(u8) {
  let entries = null;
  try {
    const gen = directory(u8.length);
    let r = gen.next();
    while (!r.done) r = gen.next(u8.subarray(Math.max(0, r.value[0]), Math.min(u8.length, r.value[1])));
    entries = r.value;
  } catch (e) {
    entries = null;
  }
  if (!entries || !entries.size) entries = scanLocal(u8);
  let mimetype = '';
  const m = entries.get('mimetype');
  if (m && m.method === 0 && m.offset + 30 <= u8.length) {
    const dv = view(u8);
    if (dv.getUint32(m.offset, true) === LOCAL) {
      const start = m.offset + 30 + dv.getUint16(m.offset + 26, true) + dv.getUint16(m.offset + 28, true);
      mimetype = utf8.decode(u8.subarray(start, Math.min(u8.length, start + Math.min(m.csize, 200)))).trim();
    }
  }
  return { names: [...entries.keys()], mimetype, encrypted: [...entries.values()].some((e) => e.encrypted) };
}
