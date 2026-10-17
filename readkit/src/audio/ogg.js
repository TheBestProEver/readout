// Ogg/Opus (RFC 7845) writer for export: OpusHead page, OpusTags page, then audio pages of
// up to 50 packets (1 s). Granule positions count 48 kHz samples including pre-skip; the
// last page's granule trims the final frame's padding to the true length.
import { opusHead, PRE_SKIP, FRAME_US } from './opus.js';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

export function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc;
}

// flags: 1 continued, 2 first page (BOS), 4 last page (EOS).
function page(packets, granule, serial, seq, flags) {
  const lacing = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('ogg: too many segments in one page');
  let body = 0;
  for (const p of packets) body += p.length;
  const out = new Uint8Array(27 + lacing.length + body);
  const v = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  out[4] = 0;
  out[5] = flags;
  v.setUint32(6, granule % 0x100000000, true);
  v.setUint32(10, Math.floor(granule / 0x100000000), true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  v.setUint32(22, 0, true);
  out[26] = lacing.length;
  out.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) {
    out.set(p, o);
    o += p.length;
  }
  v.setUint32(22, oggCrc(out), true);
  return out;
}

function tagsPacket(vendor, tags) {
  const enc = new TextEncoder();
  const v = enc.encode(vendor);
  const items = Object.entries(tags || {})
    .filter(([, x]) => x != null && x !== '')
    .map(([k, x]) => enc.encode(k.toUpperCase() + '=' + String(x)));
  let n = 8 + 4 + v.length + 4;
  for (const t of items) n += 4 + t.length;
  const b = new Uint8Array(n);
  const dv = new DataView(b.buffer);
  for (let i = 0; i < 8; i++) b[i] = 'OpusTags'.charCodeAt(i);
  let o = 8;
  dv.setUint32(o, v.length, true);
  b.set(v, o + 4);
  o += 4 + v.length;
  dv.setUint32(o, items.length, true);
  o += 4;
  for (const t of items) {
    dv.setUint32(o, t.length, true);
    b.set(t, o + 4);
    o += 4 + t.length;
  }
  return b;
}

// packets: [{ data, duration (us) }] in play order. samples48: true length in 48 kHz samples
// (optional; defaults to the packets' full duration). tags: { title, artist, ... }.
// Returns the file as Uint8Array parts (pass to new Blob(parts)).
export function oggPages(packets, { inputRate = 48000, preSkip = PRE_SKIP, samples48, tags, serial = 0x52454144 } = {}) {
  const pages = [];
  let seq = 0;
  pages.push(page([opusHead({ preSkip, inputRate })], 0, serial, seq++, 2));
  pages.push(page([tagsPacket('readkit', tags)], 0, serial, seq++, 0));
  let total = 0;
  for (const p of packets) total += Math.round(((p.duration || FRAME_US) * 48000) / 1e6);
  const end = preSkip + Math.min(total, samples48 == null ? total : Math.max(0, Math.round(samples48)));
  let granule = preSkip;
  let batch = [];
  let lacing = 0;
  for (let i = 0; i < packets.length; i++) {
    const d = packets[i].data;
    batch.push(d);
    lacing += Math.floor(d.length / 255) + 1;
    granule += Math.round(((packets[i].duration || FRAME_US) * 48000) / 1e6);
    const last = i === packets.length - 1;
    // 50 packets is 1 s; big packets also stay under the 255 lacing values a page holds.
    if (last || batch.length >= 50 || lacing > 200) {
      pages.push(page(batch, last ? end : granule, serial, seq++, last ? 4 : 0));
      batch = [];
      lacing = 0;
    }
  }
  if (!packets.length) pages.push(page([], preSkip, serial, seq++, 4));
  return pages;
}

export function oggBlob(packets, o = {}) {
  return new Blob(oggPages(packets, o), { type: 'audio/ogg; codecs=opus' });
}

// Reader for tests: [{ granule, flags, serial, seq, packets: Uint8Array[], crcOk }].
export function readOgg(bytes) {
  const out = [];
  let o = 0;
  let carry = null;
  while (o + 27 <= bytes.length) {
    if (bytes[o] !== 0x4f || bytes[o + 1] !== 0x67 || bytes[o + 2] !== 0x67 || bytes[o + 3] !== 0x53) throw new Error('ogg: bad capture pattern at ' + o);
    const v = new DataView(bytes.buffer, bytes.byteOffset + o);
    const flags = bytes[o + 5];
    const granule = v.getUint32(6, true) + v.getUint32(10, true) * 0x100000000;
    const serial = v.getUint32(14, true);
    const seq = v.getUint32(18, true);
    const crc = v.getUint32(22, true);
    const nseg = bytes[o + 26];
    const lacing = bytes.subarray(o + 27, o + 27 + nseg);
    let body = 0;
    for (const l of lacing) body += l;
    const len = 27 + nseg + body;
    const copy = bytes.slice(o, o + len);
    copy[22] = copy[23] = copy[24] = copy[25] = 0;
    const packets = [];
    let p = o + 27 + nseg;
    let cur = carry || [];
    carry = null;
    for (let i = 0; i < nseg; i++) {
      cur.push(bytes.subarray(p, p + lacing[i]));
      p += lacing[i];
      if (lacing[i] < 255) {
        let n = 0;
        for (const c of cur) n += c.length;
        const pk = new Uint8Array(n);
        let k = 0;
        for (const c of cur) {
          pk.set(c, k);
          k += c.length;
        }
        packets.push(pk);
        cur = [];
      }
    }
    if (cur.length) carry = cur;
    out.push({ granule, flags, serial, seq, packets, crcOk: oggCrc(copy) === crc });
    o += len;
  }
  return out;
}
