// Minimal WebM (Matroska) writer for one mono Opus track, for MediaSource in 'sequence'
// mode: an EBML header + an unknown-size Segment with Info and Tracks (the init segment),
// then Clusters of SimpleBlocks. Timecodes are in milliseconds (TimecodeScale 1 ms); block
// timecodes are int16 relative to their cluster, so clusters are kept to 10 s or less.
import { opusHead, PRE_SKIP, CODEC_DELAY_NS, SEEK_PRE_ROLL_NS, FRAME_US } from './opus.js';

export const MIME = 'audio/webm; codecs="opus"';
export const MAX_CLUSTER_MS = 10000;

// EBML variable-length size.
function vint(n) {
  if (n < 0x7f) return [0x80 | n];
  if (n < 0x3fff) return [0x40 | (n >> 8), n & 0xff];
  if (n < 0x1fffff) return [0x20 | (n >> 16), (n >> 8) & 0xff, n & 0xff];
  if (n < 0x0fffffff) return [0x10 | (n >>> 24), (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const b = [0x01, 0, 0, 0, 0, 0, 0, 0];
  let x = n;
  for (let i = 7; i >= 1; i--) {
    b[i] = x % 256;
    x = Math.floor(x / 256);
  }
  return b;
}

function uint(n) {
  const b = [];
  do {
    b.unshift(n % 256);
    n = Math.floor(n / 256);
  } while (n > 0);
  return b;
}

const str = (s) => Array.from(new TextEncoder().encode(s));

function f64(x) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x);
  return Array.from(b);
}

function el(id, payload) {
  const p = payload instanceof Uint8Array ? Array.from(payload) : payload;
  return [...id, ...vint(p.length), ...p];
}

// Init segment. inputRate is the PCM rate fed to the encoder (OpusHead field, informative).
export function webmHeader({ inputRate = 48000, preSkip = PRE_SKIP, codecDelayNs = CODEC_DELAY_NS, seekPreRollNs = SEEK_PRE_ROLL_NS, app = 'readkit' } = {}) {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [
    ...el([0x42, 0x86], [1]), // EBMLVersion
    ...el([0x42, 0xf7], [1]), // EBMLReadVersion
    ...el([0x42, 0xf2], [4]), // EBMLMaxIDLength
    ...el([0x42, 0xf3], [8]), // EBMLMaxSizeLength
    ...el([0x42, 0x82], str('webm')), // DocType
    ...el([0x42, 0x87], [4]), // DocTypeVersion
    ...el([0x42, 0x85], [2]), // DocTypeReadVersion
  ]);
  const info = el([0x15, 0x49, 0xa9, 0x66], [
    ...el([0x2a, 0xd7, 0xb1], uint(1000000)), // TimecodeScale: 1 ms
    ...el([0x4d, 0x80], str(app)), // MuxingApp
    ...el([0x57, 0x41], str(app)), // WritingApp
  ]);
  const audio = el([0xe1], [...el([0xb5], f64(48000)), ...el([0x9f], [1])]); // SamplingFrequency, Channels
  const track = el([0xae], [
    ...el([0xd7], [1]), // TrackNumber
    ...el([0x73, 0xc5], [1]), // TrackUID
    ...el([0x83], [2]), // TrackType: audio
    ...el([0x86], str('A_OPUS')),
    ...el([0x63, 0xa2], opusHead({ preSkip, inputRate })), // CodecPrivate
    ...el([0x56, 0xaa], uint(codecDelayNs)), // CodecDelay
    ...el([0x56, 0xbb], uint(seekPreRollNs)), // SeekPreRoll
    ...audio,
  ]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], track);
  // Segment with unknown size: the stream is open-ended.
  const seg = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  return new Uint8Array([...ebml, ...seg, ...info, ...tracks]);
}

// Clusters for packets starting at startUs (stream time, microseconds). Returns one
// Uint8Array holding as many clusters as needed (each <= maxClusterMs).
export function webmClusters(packets, startUs, { maxClusterMs = MAX_CLUSTER_MS } = {}) {
  const out = [];
  let i = 0;
  let t = startUs;
  while (i < packets.length) {
    const base = Math.round(t / 1000);
    const blocks = [];
    let size = 0;
    while (i < packets.length) {
      const rel = Math.round(t / 1000) - base;
      if (rel > maxClusterMs || rel > 32767) break;
      const p = packets[i];
      // SimpleBlock: track 1, int16 relative timecode, flags 0x80 (keyframe), payload.
      const head = [0x81, (rel >> 8) & 0xff, rel & 0xff, 0x80];
      const len = head.length + p.data.length;
      const hdr = [0xa3, ...vint(len), ...head];
      blocks.push(hdr, p.data);
      size += hdr.length + p.data.length;
      t += p.duration || FRAME_US;
      i++;
    }
    const tc = el([0xe7], uint(base)); // Cluster Timecode
    size += tc.length;
    const ch = [0x1f, 0x43, 0xb6, 0x75, ...vint(size)];
    const buf = new Uint8Array(ch.length + size);
    buf.set(ch, 0);
    let o = ch.length;
    buf.set(tc, o);
    o += tc.length;
    for (const b of blocks) {
      buf.set(b, o);
      o += b.length;
    }
    out.push(buf);
  }
  if (out.length === 1) return out[0];
  let n = 0;
  for (const b of out) n += b.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const b of out) {
    all.set(b, o);
    o += b.length;
  }
  return all;
}

// A complete WebM file (header + clusters), e.g. for a Blob.
export function webmFile(packets, o = {}) {
  const h = webmHeader(o);
  const c = webmClusters(packets, 0, o);
  const all = new Uint8Array(h.length + c.length);
  all.set(h, 0);
  all.set(c, h.length);
  return all;
}

// Tiny reader for tests: walks top-level elements of a cluster stream and returns
// [{ timecode, blocks: [{ rel, size }] }].
export function readClusters(bytes) {
  const readVint = (o, keepMarker) => {
    const b = bytes[o];
    let len = 1;
    while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++;
    let v = keepMarker ? b : b & (0xff >> len);
    for (let i = 1; i < len; i++) v = v * 256 + bytes[o + i];
    return { v, len };
  };
  const out = [];
  let o = 0;
  while (o < bytes.length) {
    const id = readVint(o, true);
    const sz = readVint(o + id.len, false);
    const start = o + id.len + sz.len;
    const end = start + sz.v;
    if (id.v === 0x1f43b675) {
      const cl = { timecode: 0, blocks: [] };
      let p = start;
      while (p < end) {
        const cid = readVint(p, true);
        const csz = readVint(p + cid.len, false);
        const cs = p + cid.len + csz.len;
        if (cid.v === 0xe7) {
          let v = 0;
          for (let i = 0; i < csz.v; i++) v = v * 256 + bytes[cs + i];
          cl.timecode = v;
        } else if (cid.v === 0xa3) {
          const rel = (bytes[cs + 1] << 8) | bytes[cs + 2];
          cl.blocks.push({ rel: rel > 32767 ? rel - 65536 : rel, size: csz.v - 4 });
        }
        p = cs + csz.v;
      }
      out.push(cl);
    }
    o = end;
  }
  return out;
}
