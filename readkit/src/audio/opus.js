// WebCodecs Opus: one AudioEncoder per session, mono, 32 kbps VBR, voice, 20 ms frames.
// No DOM use, so it runs in workers too. Packets are { data: Uint8Array, duration } with
// duration in microseconds (20000 for every packet Chrome emits at these settings).
//
// A clip is the Opus packets of one stretch of PCM (one segment with its pause, or the
// comfort-noise filler): feed it with encode(), then flush() returns its packets. Clips play
// back to back in one stream; each flush pads the last frame with silence, so a clip lasts
// a whole number of 20 ms frames.

export const FRAME_US = 20000;
// RFC 7845 counts pre-skip at 48 kHz. Chrome's own OpusHead says 156 for 24 kHz input (it
// counts input samples), so readkit writes its own header with the encoder's real 6.5 ms.
export const PRE_SKIP = 312;
export const CODEC_DELAY_NS = 6500000;
export const SEEK_PRE_ROLL_NS = 80000000;

export function opusConfig(sampleRate, o = {}) {
  return {
    codec: 'opus',
    sampleRate,
    numberOfChannels: 1,
    bitrate: o.bitrate || 32000,
    bitrateMode: 'variable',
    opus: { application: 'audio', signal: o.signal || 'voice', complexity: o.complexity == null ? 9 : o.complexity, frameDuration: FRAME_US },
  };
}

// { encoder: bool, config } for this sample rate (22050 and 24000 are the voices' rates).
export async function opusSupport(sampleRate = 24000, o = {}) {
  if (typeof AudioEncoder === 'undefined') return { encoder: false, reason: 'no-webcodecs' };
  try {
    const r = await AudioEncoder.isConfigSupported(opusConfig(encoderRate(sampleRate), o));
    return { encoder: !!r.supported, config: r.config, reason: r.supported ? null : 'config' };
  } catch (e) {
    return { encoder: false, reason: e.name || 'error' };
  }
}

// OpusHead (RFC 7845 section 5.1): version 1, mono, pre-skip at 48 kHz, input rate, gain 0,
// mapping family 0.
export function opusHead({ preSkip = PRE_SKIP, inputRate = 48000, channels = 1 } = {}) {
  const b = new Uint8Array(19);
  const v = new DataView(b.buffer);
  for (let i = 0; i < 8; i++) b[i] = 'OpusHead'.charCodeAt(i);
  b[8] = 1;
  b[9] = channels;
  v.setUint16(10, preSkip, true);
  v.setUint32(12, inputRate, true);
  v.setInt16(16, 0, true);
  b[18] = 0;
  return b;
}

const encError = (e) => Object.assign(new Error('Opus encoder: ' + ((e && e.message) || e)), { code: 'encoder', cause: e });

// Opus codes 8/12/16/24/48 kHz natively. Other rates (Piper's 22.05 kHz) go through Chrome's
// internal resampler, which does not drain on flush: about 8 ms of every clip's tail leaks into
// the next clip and the last frame is lost (measured). So readkit resamples those itself.
export const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
export const encoderRate = (sr) => (OPUS_RATES.includes(sr) ? sr : sr <= 24000 ? 24000 : 48000);

const gcd = (a, b) => {
  while (b) [a, b] = [b, a % b];
  return a;
};

// Streaming windowed-sinc resampler (Blackman window, 16 taps per side at the lower rate).
// process() returns what can be computed so far; flush() pads with silence and returns the
// rest, so a clip of N input samples gives exactly round(N * out / in) output samples; then
// the state is clear for the next clip.
export function createResampler(inRate, outRate, { half = 16 } = {}) {
  const g = gcd(inRate, outRate);
  const L = outRate / g; // output phases
  const M = inRate / g; // input step per L outputs
  const ratio = outRate / inRate;
  const cut = Math.min(1, ratio) * 0.94; // cutoff as a fraction of the input Nyquist
  const hw = Math.ceil(half / Math.min(1, ratio)); // taps per side, in input samples
  const taps = 2 * hw;
  const table = new Float32Array(L * taps);
  for (let ph = 0; ph < L; ph++) {
    const frac = ((ph * M) % L) / L; // fractional input position of this phase
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const x = k - hw + 1 - frac; // distance from the output position, input samples
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cut * x) / (Math.PI * cut * x);
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / hw) + 0.08 * Math.cos((2 * Math.PI * x) / hw);
      const v = Math.abs(x) >= hw ? 0 : cut * sinc * w;
      table[ph * taps + k] = v;
      sum += v;
    }
    for (let k = 0; k < taps; k++) table[ph * taps + k] /= sum || 1;
  }
  let buf = new Float32Array(0); // input samples from absolute index `base`
  let base = 0;
  let total = 0; // input samples seen in this clip
  let next = 0; // next output index
  const run = (limitIn, maxOut) => {
    const out = [];
    for (;;) {
      if (next >= maxOut) break;
      const ph = next % L;
      const ip = Math.floor((next * M) / L); // integer input position
      if (ip + hw >= limitIn) break;
      let s = 0;
      const t0 = ph * taps;
      const from = ip - hw + 1;
      for (let k = 0; k < taps; k++) {
        const i = from + k - base;
        if (i >= 0 && i < buf.length) s += buf[i] * table[t0 + k];
      }
      out.push(s);
      next++;
    }
    // Drop input no longer needed.
    const keepFrom = Math.floor((next * M) / L) - hw + 1;
    if (keepFrom > base) {
      buf = buf.slice(Math.min(buf.length, keepFrom - base));
      base = keepFrom;
    }
    return Float32Array.from(out);
  };
  return {
    inRate,
    outRate,
    process(x) {
      if (!x || !x.length) return new Float32Array(0);
      const nb = new Float32Array(buf.length + x.length);
      nb.set(buf, 0);
      nb.set(x, buf.length);
      buf = nb;
      total += x.length;
      return run(total, Infinity);
    },
    flush() {
      const want = Math.round(total * ratio);
      const out = run(Infinity, want);
      buf = new Float32Array(0);
      base = 0;
      total = 0;
      next = 0;
      return out;
    },
  };
}

// createEncoder({ sampleRate, bitrate, onPacket }) -> encoder
//   encode(pcm)        queue Float32 mono samples (any length; copied)
//   flush()            -> Promise<packets of everything encoded since the last flush>
//   reset()            drop queued input (seek); the next clip starts clean
//   close()
// onPacket(packet) sees every packet as soon as Chrome emits it, so a long clip can be
// appended before its flush.
export function createEncoder({ sampleRate, bitrate, signal, complexity, onPacket } = {}) {
  if (typeof AudioEncoder === 'undefined') throw Object.assign(new Error('WebCodecs AudioEncoder is not available'), { code: 'unsupported' });
  const inputRate = sampleRate;
  sampleRate = encoderRate(inputRate);
  const rs = sampleRate !== inputRate ? createResampler(inputRate, sampleRate) : null;
  const config = opusConfig(sampleRate, { bitrate, signal, complexity });
  let clip = [];
  let failed = null;
  let samples = 0; // input samples since the encoder was configured, for AudioData timestamps
  let closed = false;
  const make = () =>
    new AudioEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const p = { data, duration: chunk.duration || FRAME_US };
        clip.push(p);
        if (onPacket) {
          try {
            onPacket(p);
          } catch (e) {
            /* listener bugs must not stop encoding */
          }
        }
      },
      error: (e) => {
        failed = encError(e);
      },
    });
  let enc = make();
  enc.configure(config);
  // AudioData copies the samples, so callers may reuse or drop theirs.
  const feed = (pcm) => {
    const step = sampleRate; // 1 s per AudioData keeps the queue short
    for (let i = 0; i < pcm.length; i += step) {
      const part = pcm.subarray(i, Math.min(pcm.length, i + step));
      const data = new AudioData({ format: 'f32', sampleRate, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round((samples / sampleRate) * 1e6), data: part });
      samples += part.length;
      enc.encode(data);
      data.close();
    }
  };

  return {
    sampleRate, // the encoder's rate (input at other rates is resampled to it)
    inputRate,
    config,
    get error() {
      return failed;
    },
    get queue() {
      return enc.encodeQueueSize;
    },
    encode(pcm) {
      if (failed) throw failed;
      if (closed) throw encError('closed');
      if (!pcm || !pcm.length) return;
      feed(rs ? rs.process(pcm) : pcm);
    },
    async flush() {
      if (failed) throw failed;
      if (rs) feed(rs.flush());
      try {
        await enc.flush();
      } catch (e) {
        throw failed || encError(e);
      }
      if (failed) throw failed;
      const out = clip;
      clip = [];
      return out;
    },
    reset() {
      clip = [];
      samples = 0;
      if (rs) rs.flush();
      if (closed) return;
      try {
        enc.reset();
        enc.configure(config);
      } catch (e) {
        // A closed (errored) encoder cannot be reset: start a new one.
        enc = make();
        enc.configure(config);
        failed = null;
      }
    },
    close() {
      closed = true;
      try {
        enc.close();
      } catch (e) {
        /* already closed */
      }
    },
  };
}

// One-shot: PCM -> { packets, sampleRate, samples }.
export async function encodeClip(pcm, sampleRate, o = {}) {
  const enc = createEncoder({ sampleRate, ...o });
  try {
    enc.encode(pcm);
    const packets = await enc.flush();
    return { packets, sampleRate, samples: pcm.length };
  } finally {
    enc.close();
  }
}

// Decode Opus packets to Float32 mono at 48 kHz with WebCodecs (tests, export checks).
// The first preSkip samples are dropped, as a player would.
export async function decodePackets(packets, { inputRate = 48000, preSkip = PRE_SKIP } = {}) {
  if (typeof AudioDecoder === 'undefined') throw Object.assign(new Error('WebCodecs AudioDecoder is not available'), { code: 'unsupported' });
  const parts = [];
  let failed = null;
  let rate = 48000;
  const dec = new AudioDecoder({
    output: (d) => {
      rate = d.sampleRate;
      const x = new Float32Array(d.numberOfFrames);
      d.copyTo(x, { planeIndex: 0, format: 'f32-planar' });
      parts.push(x);
      d.close();
    },
    error: (e) => {
      failed = e;
    },
  });
  dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1, description: opusHead({ preSkip, inputRate }) });
  let ts = 0;
  for (const p of packets) {
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: ts, duration: p.duration || FRAME_US, data: p.data }));
    ts += p.duration || FRAME_US;
  }
  await dec.flush();
  dec.close();
  if (failed) throw failed;
  let n = 0;
  for (const x of parts) n += x.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const x of parts) {
    out.set(x, o);
    o += x.length;
  }
  return { pcm: out, sampleRate: rate };
}

export const packetsDurationUs = (packets) => {
  let us = 0;
  for (const p of packets) us += p.duration || FRAME_US;
  return us;
};

export const packetsBytes = (packets) => {
  let n = 0;
  for (const p of packets) n += p.data.length;
  return n;
};
