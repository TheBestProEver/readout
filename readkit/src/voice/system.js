// Device voices through speechSynthesis: Readout's old screen-on mode and last fallback.
// There is no PCM (synth() is unsupported), so the app plays these with speak(), one
// segment at a time, and gets word boundaries from onboundary where the voice sends them.

// Chrome's online voices stop after ~15 s of continuous speech and Android's engine caps
// utterance length, so long segments are spoken in pieces of at most this many characters.
const MAX_CHUNK = 200;

function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

export function dialectOf(lang) {
  const l = String(lang || '').replace(/_/g, '-').toLowerCase();
  if (l === 'en-us' || l.startsWith('en-us-')) return 'en-US';
  if (l === 'en-gb' || l.startsWith('en-gb-')) return 'en-GB';
  return null;
}

export function hasSpeech() {
  return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
}

// US and UK voices, best first: the platform default, then on-device voices (they work
// offline and do not stop mid-sentence), then by name.
export async function systemVoices({ dialect, timeout = 1500 } = {}) {
  if (!hasSpeech()) return [];
  let list = speechSynthesis.getVoices();
  if (!list.length) {
    list = await new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        speechSynthesis.removeEventListener('voiceschanged', done);
        resolve(speechSynthesis.getVoices());
      };
      const t = setTimeout(done, timeout);
      speechSynthesis.addEventListener('voiceschanged', done);
    });
  }
  return list
    .map((v) => ({ name: v.name, lang: v.lang, dialect: dialectOf(v.lang), localService: !!v.localService, default: !!v.default, voiceURI: v.voiceURI, voice: v }))
    .filter((v) => v.dialect && (!dialect || v.dialect === dialect))
    .sort((a, b) => b.default - a.default || b.localService - a.localService || a.name.localeCompare(b.name));
}

// Pieces of at most max characters, cut after sentence or clause punctuation when
// possible, else at a space. Returns [{ start, end }] over text.
export function chunkText(text, max = MAX_CHUNK) {
  const out = [];
  let a = 0;
  const n = text.length;
  while (a < n) {
    while (a < n && /\s/.test(text[a])) a++;
    if (a >= n) break;
    if (n - a <= max) {
      out.push({ start: a, end: n });
      break;
    }
    let cut = -1;
    let soft = -1;
    for (let i = a + max; i > a + max / 3; i--) {
      if (/\s/.test(text[i])) {
        if (/[.!?;:,—]/.test(text[i - 1])) {
          cut = i;
          break;
        }
        if (soft < 0) soft = i;
      }
    }
    if (cut < 0) cut = soft > 0 ? soft : a + max;
    out.push({ start: a, end: cut });
    a = cut;
  }
  return out;
}

function alignAt(seg, charIndex) {
  const align = seg.align || [];
  for (let k = 0; k < align.length; k++) if (charIndex >= align[k][0] && charIndex < align[k][1]) return k;
  return -1;
}

export function createSystemVoice(entry) {
  const dialect = entry.dialect;
  const live = new Set(); // keeps utterances reachable: Chrome may drop onend for collected ones
  let current = null;

  async function pick(name) {
    const list = await systemVoices({ dialect });
    return (name && list.find((v) => v.name === name || v.voiceURI === name)) || list[0] || null;
  }

  // Speaks one segment; resolves after its pauseAfterMs. opts: { speed, voice (name),
  // onBoundary(charIndex, alignIndex), onStart(), signal }.
  async function speak(seg, opts = {}) {
    if (!hasSpeech()) throw Object.assign(new Error('speechSynthesis is not available'), { code: 'unsupported' });
    const { signal } = opts;
    if (signal && signal.aborted) throw abortError();
    const v = await pick(opts.voice);
    const text = String(seg.spoken || '');
    const chunks = chunkText(text);
    return new Promise((resolve, reject) => {
      let i = 0;
      let finished = false;
      let timer = 0;
      const end = (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        current = null;
        err ? reject(err) : resolve();
      };
      function onAbort() {
        speechSynthesis.cancel();
        end(abortError());
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      current = { cancel: onAbort };
      const next = () => {
        if (finished) return;
        if (i >= chunks.length) {
          const ms = Math.max(0, +seg.pauseAfterMs || 0);
          if (!ms) return end();
          timer = setTimeout(() => end(), ms);
          return;
        }
        const c = chunks[i++];
        const u = new SpeechSynthesisUtterance(text.slice(c.start, c.end));
        if (v) {
          u.voice = v.voice;
          u.lang = v.lang;
        } else u.lang = dialect;
        u.rate = Math.min(10, Math.max(0.1, +opts.speed || 1));
        live.add(u);
        u.onstart = () => {
          if (i === 1 && opts.onStart) opts.onStart();
        };
        u.onboundary = (e) => {
          if (e.name && e.name !== 'word') return;
          const ci = c.start + (e.charIndex || 0);
          if (opts.onBoundary) opts.onBoundary(ci, alignAt(seg, ci));
        };
        u.onend = () => {
          live.delete(u);
          next();
        };
        u.onerror = (e) => {
          live.delete(u);
          if (finished) return;
          if (e.error === 'interrupted' || e.error === 'canceled') return end(abortError());
          end(Object.assign(new Error('Speech failed: ' + e.error), { code: 'speech-error' }));
        };
        speechSynthesis.speak(u);
      };
      next();
    });
  }

  return {
    id: entry.id,
    engine: 'system',
    dialect,
    sampleRate: null,
    device: 'system',
    info: { engine: 'system' },
    async calibrate() {
      const ok = hasSpeech() && (await systemVoices({ dialect })).length > 0;
      return { ok, rt: null, device: 'system', reason: ok ? null : 'unsupported', message: ok ? '' : 'No ' + dialect + ' speech voices on this device' };
    },
    async synth() {
      throw Object.assign(new Error('System voices produce no audio data; use speak() for the screen-on mode'), { code: 'unsupported', name: 'NotSupportedError' });
    },
    speak,
    cancel() {
      if (current) current.cancel();
      else if (hasSpeech()) speechSynthesis.cancel();
    },
    voices: () => systemVoices({ dialect }),
    dispose() {
      if (current) current.cancel();
    },
  };
}
