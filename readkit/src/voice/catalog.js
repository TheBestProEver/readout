// The voices readkit offers, and the files each one needs. URLs come from config at call
// time, so configure() (tests, self-hosting) applies even after this module has loaded.
// Sizes and sha256 values are the Hugging Face LFS metadata at the pinned revisions,
// re-checked against downloaded copies (see data/voice/README.md).
import { config } from '../config.js';

// The library default (DESIGN.md). Apps pick per accent and gender with defaultVoice().
export const DEFAULT_VOICE = 'af_heart';
export const KOKORO_REVISION = 'dd4401a9add81ac692d20e240d22ec9dda82cc29';
export const PIPER_REVISION = 'c10ece1aade47bb51c153c893d14e5bf8e5b7117';

const KOKORO_MODEL = { bytes: 325532171, sha256: '651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054' };
const KOKORO_LICENSE = 'Apache-2.0';
const KOKORO_VOICE_BYTES = 522240;

// [id, name, dialect, gender, grade, sha256, default for its dialect + gender].
// Grades are the overall grades in hexgrad/Kokoro-82M VOICES.md. Kokoro's US male voices
// all grade C+; am_michael is the default until the user picks among the three by ear.
const KOKORO = [
  ['af_heart', 'Heart', 'en-US', 'female', 'A', 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b', true],
  ['af_bella', 'Bella', 'en-US', 'female', 'A-', 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b', false],
  ['am_michael', 'Michael', 'en-US', 'male', 'C+', '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1', true],
  ['am_fenrir', 'Fenrir', 'en-US', 'male', 'C+', 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43', false],
  ['am_puck', 'Puck', 'en-US', 'male', 'C+', 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0', false],
  ['bf_emma', 'Emma', 'en-GB', 'female', 'B-', '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73', true],
  ['bm_george', 'George', 'en-GB', 'male', 'C', 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc', true],
];

// Piper medium voices (one 63 MB model each). The code and exports are MIT; each voice
// carries its dataset's licence, and several are non-commercial. Piper has no official
// grades, so grade is null.
const PIPER = [
  {
    id: 'en_US-lessac-medium',
    name: 'Lessac',
    dialect: 'en-US',
    gender: 'female',
    default: true,
    path: 'en/en_US/lessac/medium/',
    bytes: 63201294,
    sha256: '5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f',
    json: { bytes: 4885, sha256: 'efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0' },
    license: 'Blizzard 2013 Lessac dataset licence (https://www.cstr.ed.ac.uk/projects/blizzard/2013/lessac_blizzard2013/license.html)',
    commercial: false,
  },
  {
    id: 'en_US-ryan-medium',
    name: 'Ryan',
    dialect: 'en-US',
    gender: 'male',
    default: true,
    path: 'en/en_US/ryan/medium/',
    bytes: 63201294,
    sha256: 'abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a',
    json: { bytes: 4883, sha256: '44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d' },
    license: 'CC-BY-NC-SA-4.0 (RyanSpeech dataset)',
    commercial: false,
  },
  {
    id: 'en_US-hfc_male-medium',
    name: 'HFC Male',
    dialect: 'en-US',
    gender: 'male',
    default: false,
    path: 'en/en_US/hfc_male/medium/',
    bytes: 63201294,
    sha256: 'd11e403a02bdf5a670c877b3dc56e0e1c8cece6fb30289586314dffdc0a78cb0',
    json: { bytes: 5033, sha256: 'f66847424aed0bf99ecbb5d7cfde47c0a906f426a0daf7c46f305e7d21afd886' },
    license: 'CC-BY-NC-SA-4.0 (Hi-Fi CAPTAIN dataset)',
    commercial: false,
  },
  {
    id: 'en_GB-alba-medium',
    name: 'Alba',
    dialect: 'en-GB',
    gender: 'female',
    default: true,
    path: 'en/en_GB/alba/medium/',
    bytes: 63201294,
    sha256: '401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b',
    json: { bytes: 4888, sha256: 'aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4' },
    license: 'CC-BY-4.0 (dataset)',
    commercial: true,
  },
  {
    id: 'en_GB-cori-medium',
    name: 'Cori',
    dialect: 'en-GB',
    gender: 'female',
    default: false,
    path: 'en/en_GB/cori/medium/',
    bytes: 63531379,
    sha256: '1899f98e5fb8310154f3c2973f4b8a929ba7245e722b3d3a85680b833d95f10d',
    json: { bytes: 4966, sha256: 'e262c16d7f192f69d4edd6b4ef8a5915379e67495fcc402f1ab15eeb33da3d36' },
    license: 'Public domain (LibriVox dataset)',
    commercial: true,
  },
  {
    // The UK male fallback when Kokoro (bm_george) cannot run: same accent and gender.
    id: 'en_GB-northern_english_male-medium',
    name: 'Northern English Male',
    dialect: 'en-GB',
    gender: 'male',
    default: true,
    path: 'en/en_GB/northern_english_male/medium/',
    bytes: 63201294,
    sha256: '57a219ae8e638873db7d18893304be5069c42868f392bb95c3ff17f0690d0689',
    json: { bytes: 4847, sha256: '69557ed3d974463453e9b0c09dd99a7ed0e52b8b87b64b357dbeeb2540a97d47' },
    license: 'CC-BY-SA-4.0 (OpenSLR 83 dataset)',
    commercial: true,
  },
];

function revisionOf(url, fallback) {
  const m = /\/resolve\/([0-9a-f]{40})\//.exec(url || '');
  return m ? m[1] : fallback;
}

// Every file a voice needs, with the URL it downloads from and the OPFS name it is stored
// under. Names are content addressed, so the Kokoro model shared by all Kokoro voices is
// stored once, and a revision bump that changes the bytes never reuses a stale file.
export function voiceFiles(id) {
  const k = KOKORO.find((v) => v[0] === id);
  if (k) {
    const base = config.kokoro.base;
    return [
      { role: 'model', url: base + config.kokoro.model, bytes: KOKORO_MODEL.bytes, sha256: KOKORO_MODEL.sha256, name: storeName(KOKORO_MODEL.sha256, 'kokoro-model.onnx') },
      { role: 'voice', url: base + config.kokoro.voices + id + '.bin', bytes: KOKORO_VOICE_BYTES, sha256: k[5], name: storeName(k[5], 'kokoro-' + id + '.bin') },
    ];
  }
  const p = PIPER.find((v) => v.id === id);
  if (p) {
    const base = config.piper + p.path + p.id;
    return [
      { role: 'model', url: base + '.onnx', bytes: p.bytes, sha256: p.sha256, name: storeName(p.sha256, p.id + '.onnx') },
      { role: 'config', url: base + '.onnx.json', bytes: p.json.bytes, sha256: p.json.sha256, name: storeName(p.json.sha256, p.id + '.onnx.json') },
    ];
  }
  return [];
}

export function storeName(sha256, base) {
  return (sha256 ? sha256.slice(0, 16) : 'nohash') + '-' + base;
}

function entry(fields) {
  // url and revision are getters so they follow configure().
  const e = { ...fields };
  Object.defineProperty(e, 'url', { enumerable: true, get: () => (voiceFiles(e.id)[0] || {}).url || null });
  Object.defineProperty(e, 'revision', {
    enumerable: true,
    get: () => (e.engine === 'kokoro' ? revisionOf(config.kokoro.base, KOKORO_REVISION) : e.engine === 'piper' ? revisionOf(config.piper, PIPER_REVISION) : null),
  });
  return Object.freeze(e);
}

// default: true marks one voice per engine + dialect + gender (system voices: per dialect).
export const voiceCatalog = Object.freeze([
  ...KOKORO.map(([id, name, dialect, gender, grade, , def]) =>
    entry({ id, engine: 'kokoro', tier: 'hd', name, dialect, gender, grade, default: def, bytes: KOKORO_MODEL.bytes + KOKORO_VOICE_BYTES, license: KOKORO_LICENSE, commercial: true, sha256: KOKORO_MODEL.sha256, sampleRate: 24000 }),
  ),
  ...PIPER.map((p) => entry({ id: p.id, engine: 'piper', tier: 'standard', name: p.name, dialect: p.dialect, gender: p.gender, grade: null, default: p.default, bytes: p.bytes + p.json.bytes, license: p.license, commercial: p.commercial, sha256: p.sha256, sampleRate: 22050 })),
  entry({ id: 'system-en-US', engine: 'system', tier: 'device', name: 'Device voice (US)', dialect: 'en-US', gender: null, grade: null, default: true, bytes: 0, license: null, commercial: null, sha256: null, sampleRate: null }),
  entry({ id: 'system-en-GB', engine: 'system', tier: 'device', name: 'Device voice (UK)', dialect: 'en-GB', gender: null, grade: null, default: true, bytes: 0, license: null, commercial: null, sha256: null, sampleRate: null }),
]);

export function findVoice(id) {
  return voiceCatalog.find((v) => v.id === id) || null;
}

// The default voice id for an engine, accent and gender; any of them may be left out.
// Falls back to the other gender, then to any voice of the engine, so a known engine
// always gets an answer. defaultVoice({ dialect: 'en-US', gender: 'male' }) -> 'am_michael'.
export function defaultVoice({ engine = 'kokoro', dialect = 'en-US', gender = null } = {}) {
  const of = voiceCatalog.filter((v) => v.engine === engine);
  const pick = (list) => list.find((v) => v.default) || list[0] || null;
  const v = pick(of.filter((x) => x.dialect === dialect && (!gender || !x.gender || x.gender === gender))) || pick(of.filter((x) => x.dialect === dialect)) || pick(of);
  return v ? v.id : null;
}

// The Piper voice to switch to when a Kokoro voice cannot run here: same accent and gender.
export function fallbackVoice(id) {
  const v = findVoice(id);
  if (!v || v.engine !== 'kokoro') return null;
  return defaultVoice({ engine: 'piper', dialect: v.dialect, gender: v.gender });
}
