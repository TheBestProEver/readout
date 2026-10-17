// Is this engine fast and clean enough on this device? A fixed sentence of 220 tokens is
// synthesized twice (the first run warms up kernels for that length; each WebGPU call also
// has about 1 s of fixed cost, so a short sentence would understate the speed), and the
// second render is checked: speed, NaN, level, and for Kokoro the >6 kHz share that
// onnxruntime #29807's WebGPU corruption shifts. Results are cached per engine, device and
// Chrome major version, since a driver or browser update can change both speed and output.
import { levels, highBandShare } from './pcm.js';

export const CALIBRATION = Object.freeze({
  text: "The committee's preliminary analysis suggests that the compound, although relatively stable at room temperature, deteriorates rapidly when exposed to ultraviolet light and moisture, which matters for storage.",
  // espeak-style IPA that both Kokoro's vocabulary and Piper's phoneme map cover, so
  // calibration does not depend on the G2P step.
  phonemes: 'ðə kəmˈɪɾiz pɹɪlˈɪmɪnˌɛɹi ɐnˈæləsˌɪs sədʒˈɛsts ðæt ðə kˈɑːmpaʊnd, ɔːlðˈoʊ ɹˈɛlətˌɪvli stˈeɪbəl æt ɹˈuːm tˈɛmpɹɪtʃɚ, dɪtˈiəɹɪɹˌeɪts ɹˈæpɪdli wɛn ɛkspˈoʊzd tʊ ˌʊltɹɐvˈaɪəlɪt lˈaɪt ænd mˈɔɪstʃɚ, wˌɪtʃ mˈæɾɚz fɔːɹ stˈoːɹɪdʒ.',
  // Short warm-up input used right after a model loads (shader compilation).
  warmup: 'ɹˈiːdaʊt tˈɜːnz jʊɹ nˈoʊts ˌɪntʊ klˈɪɹ spˈiːtʃ.',
});

export const LIMITS = Object.freeze({ margin: 1.3, rmsMin: 0.02, rmsMax: 0.3, hfTolerance: 0.03 });

// Reference >6 kHz shares of the calibration render per Kokoro voice: onnxruntime-web
// 1.30.0 on the CPU (wasm), where #29807 does not apply. WebGPU on an Arc 140V matched every
// one within 0.0004, and Kokoro is deterministic (data/voice/README.md). Voices without a
// reference skip the spectrum check.
export const HF_REFERENCE = Object.freeze({
  af_heart: 0.1701,
  af_bella: 0.1609,
  am_michael: 0.1452,
  am_fenrir: 0.1056,
  am_puck: 0.1534,
  bf_emma: 0.1822,
  bm_george: 0.1046,
});

// Statistics of a calibration render. pcm: Float32Array; computeMs: time of the timed run.
export function renderStats(pcm, sampleRate, computeMs) {
  const lv = levels(pcm);
  const audioS = pcm.length / sampleRate;
  return {
    rt: computeMs > 0 ? audioS / (computeMs / 1000) : 0,
    audioS,
    computeMs,
    nan: lv.nan,
    rms: lv.rms,
    peak: lv.peak,
    hf: highBandShare(pcm, sampleRate),
  };
}

// Test hook (calibrate({ _corrupt })): damages a render the way broken GPU numerics do, to
// prove the checks catch it. 'hiss' keeps the level in range but adds broadband noise,
// like the WebGPU timbre corruption in onnxruntime #29807, so only the spectrum check sees it.
export function corrupt(pcm, kind) {
  if (!kind) return pcm;
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;
  if (kind === 'nan') for (let i = 0; i < pcm.length; i += 7) pcm[i] = NaN;
  else if (kind === 'zeros') pcm.fill(0);
  else if (kind === 'noise') for (let i = 0; i < pcm.length; i++) pcm[i] = rnd();
  else if (kind === 'hiss') for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i] * 0.8 + 0.04 * rnd();
  return pcm;
}

// Verdict for a requested listening speed: { ok, rt, reason, message }.
export function judge(stats, { speed = 1, hfRef = null } = {}) {
  const need = LIMITS.margin * Math.max(0.5, +speed || 1);
  let reason = null;
  let message = '';
  if (!stats) {
    reason = 'error';
    message = 'no calibration render';
  } else if (stats.nan > 0) {
    reason = 'nan';
    message = `${stats.nan} NaN samples`;
  } else if (!(stats.rms >= LIMITS.rmsMin && stats.rms <= LIMITS.rmsMax)) {
    reason = 'level';
    message = `RMS ${stats.rms.toFixed(4)} outside ${LIMITS.rmsMin}-${LIMITS.rmsMax}`;
  } else if (hfRef != null && Math.abs(stats.hf - hfRef) > LIMITS.hfTolerance) {
    reason = 'spectrum';
    message = `high-band share ${stats.hf.toFixed(3)} vs reference ${hfRef.toFixed(3)}`;
  } else if (!(stats.rt >= need)) {
    reason = 'slow';
    message = `${stats.rt.toFixed(2)}x real time, need ${need.toFixed(2)}x for speed ${speed}`;
  }
  return { ok: !reason, rt: stats ? stats.rt : 0, reason, message };
}

export function chromeMajor() {
  if (typeof navigator === 'undefined') return 0;
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const b = brands.find((x) => /Chrom/.test(x.brand));
  if (b) return +b.version || 0;
  const m = /Chrome\/(\d+)/.exec(navigator.userAgent || '');
  return m ? +m[1] : 0;
}

export function cacheKey(engine, deviceKey) {
  return `readkit.calibration.v1|${engine}|${deviceKey || 'unknown'}|chrome${chromeMajor()}`;
}

export function readCache(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v && typeof v.rt === 'number' ? v : null;
  } catch (e) {
    return null;
  }
}

export function writeCache(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* private mode or quota: calibration just reruns next time */
  }
}
