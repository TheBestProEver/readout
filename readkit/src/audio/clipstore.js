// Clip cache in IndexedDB: the Opus packets of each generated segment, keyed by
// sha256(engine, model revision, voice, generated speed, spoken text), least recently used
// evicted above ~300 MB (about 20 hours of speech). Works in workers too. Clips replay into
// the player without regenerating, and export to an Ogg/Opus file.
//
// Clip = { sampleRate (the voice's), samples, speed, packets: [{ data, duration }],
//          words: [{ alignIndex, start, end }] (samples within the clip) | null }
import { oggBlob } from './ogg.js';
import { FRAME_US, encoderRate } from './opus.js';

export const DB_NAME = 'readkit-clips';
export const MAX_BYTES = 300 * 1024 * 1024;
const VERSION = 1;
const TOUCH_MS = 60000; // refresh a clip's LRU time at most once a minute

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof crypto !== 'undefined' && crypto.subtle) return hex(await crypto.subtle.digest('SHA-256', bytes));
  // Insecure contexts have no crypto.subtle (plain-http LAN testing).
  const m = await import('../formats/sha256.js');
  return m.sha256Hex(bytes);
}

export function clipKey({ engine = '', revision = '', voice = '', speed = 1, spoken = '' }) {
  return sha256Hex(JSON.stringify(['readkit-clip/1', String(engine), String(revision || ''), String(voice), Math.round(+speed * 1000) / 1000, String(spoken)]));
}

const req = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

function pack(clip) {
  const sizes = new Uint16Array(clip.packets.length);
  let n = 0;
  clip.packets.forEach((p, i) => {
    sizes[i] = p.data.length;
    n += p.data.length;
  });
  const data = new Uint8Array(n);
  let o = 0;
  for (const p of clip.packets) {
    data.set(p.data, o);
    o += p.data.length;
  }
  const words = clip.words ? clip.words.map((w) => [w.alignIndex, w.start, w.end]) : null;
  return { sampleRate: clip.sampleRate, samples: clip.samples, speed: clip.speed, frameUs: FRAME_US, sizes, data, words, bytes: n + sizes.byteLength + 64 };
}

function unpack(v) {
  const packets = [];
  let o = 0;
  for (const s of v.sizes) {
    packets.push({ data: v.data.subarray(o, o + s), duration: v.frameUs || FRAME_US });
    o += s;
  }
  return { sampleRate: v.sampleRate, samples: v.samples, speed: v.speed, packets, words: v.words ? v.words.map(([alignIndex, start, end]) => ({ alignIndex, start, end })) : null, bytes: v.bytes };
}

export function openClipStore({ name = DB_NAME, maxBytes = MAX_BYTES } = {}) {
  let dbp = null;
  const db = () => {
    if (dbp) return dbp;
    if (typeof indexedDB === 'undefined') return (dbp = Promise.reject(Object.assign(new Error('IndexedDB is not available'), { code: 'unsupported' })));
    const r = indexedDB.open(name, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      const clips = d.createObjectStore('clips', { keyPath: 'key' });
      clips.createIndex('at', 'at');
      d.createObjectStore('meta');
    };
    dbp = req(r).then((d) => {
      d.onversionchange = () => d.close();
      return d;
    });
    return dbp;
  };

  // Runs fn(stores) in one transaction; resolves with fn's value when it commits.
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(['clips', 'meta'], mode);
      let out;
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('transaction aborted'));
      Promise.resolve(fn(t.objectStore('clips'), t.objectStore('meta'), t)).then(
        (v) => (out = v),
        (e) => {
          try {
            t.abort();
          } catch (x) {
            /* already finished */
          }
          reject(e);
        },
      );
    });
  }

  // Request helpers that keep the transaction alive (no awaits on other promises inside).
  const get = (store, key) => req(store.get(key));

  const store = {
    maxBytes,
    async get(key) {
      const v = await tx('readonly', (clips) => get(clips, key));
      if (!v) return null;
      if (Date.now() - (v.at || 0) > TOUCH_MS)
        tx('readwrite', async (clips) => {
          const cur = await get(clips, key);
          if (cur) {
            cur.at = Date.now();
            clips.put(cur);
          }
        }).catch(() => {});
      return unpack(v);
    },
    async has(key) {
      const n = await tx('readonly', (clips) => req(clips.count(key)));
      return n > 0;
    },
    async put(key, clip) {
      const v = { key, at: Date.now(), ...pack(clip) };
      return tx('readwrite', async (clips, meta) => {
        const old = await get(clips, key);
        const m = (await get(meta, 'usage')) || { bytes: 0, count: 0 };
        if (old) {
          m.bytes -= old.bytes || 0;
          m.count--;
        }
        clips.put(v);
        m.bytes += v.bytes;
        m.count++;
        if (m.bytes > maxBytes) {
          // Evict least recently used clips down to 90% of the limit.
          await new Promise((resolve, reject) => {
            const cur = clips.index('at').openCursor();
            cur.onerror = () => reject(cur.error);
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c || m.bytes <= maxBytes * 0.9) return resolve();
              if (c.value.key !== key) {
                m.bytes -= c.value.bytes || 0;
                m.count--;
                c.delete();
              }
              c.continue();
            };
          });
        }
        meta.put(m, 'usage');
        return { bytes: m.bytes, count: m.count };
      });
    },
    async delete(key) {
      return tx('readwrite', async (clips, meta) => {
        const old = await get(clips, key);
        if (!old) return false;
        const m = (await get(meta, 'usage')) || { bytes: 0, count: 0 };
        m.bytes -= old.bytes || 0;
        m.count--;
        clips.delete(key);
        meta.put(m, 'usage');
        return true;
      });
    },
    async usage() {
      return (await tx('readonly', (clips, meta) => get(meta, 'usage'))) || { bytes: 0, count: 0 };
    },
    async clear() {
      return tx('readwrite', (clips, meta) => {
        clips.clear();
        meta.put({ bytes: 0, count: 0 }, 'usage');
      });
    },
    // Ogg/Opus file of the clips under these keys, in order. Missing keys are skipped and
    // reported. tags: { title, artist, ... }.
    async exportOgg(keys, { tags } = {}) {
      const packets = [];
      const missing = [];
      let rate = 0;
      let samples48 = 0;
      for (let i = 0; i < keys.length; i++) {
        const c = await store.get(keys[i]);
        if (!c) {
          missing.push(i);
          continue;
        }
        rate = rate || c.sampleRate;
        for (const p of c.packets) packets.push(p);
        samples48 += c.packets.length * Math.round((FRAME_US * 48000) / 1e6);
      }
      return { blob: oggBlob(packets, { inputRate: encoderRate(rate || 24000), samples48, tags }), missing, packets: packets.length };
    },
    close() {
      if (dbp) dbp.then((d) => d.close()).catch(() => {});
      dbp = null;
    },
  };
  return store;
}

// Keys of a document's segments for a voice and generated speed (for exportOgg).
export function segmentKeys(segments, { engine, revision, voice, speed }) {
  return Promise.all(segments.map((s) => clipKey({ engine, revision, voice, speed, spoken: s.spoken })));
}
