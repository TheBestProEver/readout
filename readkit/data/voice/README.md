# voice data

readkit ships no voice model files. Models download at runtime from Hugging Face at pinned
revisions into OPFS (`src/voice/store.js`). This file records where every number in
`src/voice/catalog.js` and `src/voice/calibrate.js` comes from.

## Kokoro-82M (HD voices)

- Repo: `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped`, revision
  `dd4401a9add81ac692d20e240d22ec9dda82cc29`. Licence: Apache-2.0 (model and voices, from
  `hexgrad/Kokoro-82M`).
- `onnx/model.onnx` (fp32, the only dtype that is correct on WebGPU): 325,532,171 bytes,
  sha256 `651ea8291843a92276a4a003581a215cb07d15e47dde6fcfb1b768f9a1682054`. Outputs
  `waveform` and `durations` (one value per input token; one rounded step = 600 samples at
  24 kHz, verified sample-exact).
- Voices (`voices/<id>.bin`, 522,240 bytes = 510 x 256 float32 style rows each):

| id | accent | gender | grade | sha256 |
|---|---|---|---|---|
| af_heart | US | female | A | d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b |
| af_bella | US | female | A- | f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b |
| am_michael | US | male | C+ | 1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1 |
| am_fenrir | US | male | C+ | c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43 |
| am_puck | US | male | C+ | fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0 |
| bf_emma | UK | female | B- | 669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73 |
| bm_george | UK | male | C | c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc |

  Grades are the overall grades in `hexgrad/Kokoro-82M` `VOICES.md`. Sizes and hashes are
  the LFS metadata from the Hugging Face API at the pinned revision
  (`/api/models/onnx-community/Kokoro-82M-v1.0-ONNX-timestamped/tree/<rev>/voices`), and
  match sha256 of downloaded copies.
- Tokenizer vocabulary (`VOCAB` in `src/voice/kokoro-text.js`): `hexgrad/Kokoro-82M`
  `config.json` (Apache-2.0), identical to the repo's `tokenizer.json`, which adds `$` = 0.

## Piper (standard voices)

- Repo: `rhasspy/piper-voices`, revision `c10ece1aade47bb51c153c893d14e5bf8e5b7117`.
  Piper code and exports: MIT. Each voice's dataset licence is in its `MODEL_CARD`.
  Medium quality only (high voices are too slow for phones).

| id | accent | gender | .onnx bytes | .onnx sha256 | .onnx.json bytes / sha256 | dataset licence |
|---|---|---|---|---|---|---|
| en_US-lessac-medium | US | female | 63,201,294 | 5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f | 4,885 / efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0 | Blizzard 2013 Lessac licence (non-commercial) |
| en_US-ryan-medium | US | male | 63,201,294 | abf4c274862564ed647ba0d2c47f8ee7c9b717d27bdad9219100eb310db4047a | 4,883 / 44034c056cb15681b2ad494307c7f3f2e4499d1253c700c711fa0a4607ffe78d | CC BY-NC-SA 4.0 (RyanSpeech) |
| en_US-hfc_male-medium | US | male | 63,201,294 | d11e403a02bdf5a670c877b3dc56e0e1c8cece6fb30289586314dffdc0a78cb0 | 5,033 / f66847424aed0bf99ecbb5d7cfde47c0a906f426a0daf7c46f305e7d21afd886 | CC BY-NC-SA 4.0 (Hi-Fi CAPTAIN) |
| en_GB-alba-medium | UK | female | 63,201,294 | 401369c4a81d09fdd86c32c5c864440811dbdcc66466cde2d64f7133a66ad03b | 4,888 / aa965a2f02ecced632c2694e1fc72bbff6d65f265fab567ca945918c73dd89f4 | CC BY 4.0 |
| en_GB-cori-medium | UK | female | 63,531,379 | 1899f98e5fb8310154f3c2973f4b8a929ba7245e722b3d3a85680b833d95f10d | 4,966 / e262c16d7f192f69d4edd6b4ef8a5915379e67495fcc402f1ab15eeb33da3d36 | public domain (LibriVox) |
| en_GB-northern_english_male-medium | UK | male | 63,201,294 | 57a219ae8e638873db7d18893304be5069c42868f392bb95c3ff17f0690d0689 | 4,847 / 69557ed3d974463453e9b0c09dd99a7ed0e52b8b87b64b357dbeeb2540a97d47 | CC BY-SA 4.0 (OpenSLR 83) |

  `.onnx` sizes and sha256 are the LFS metadata from
  `/api/models/rhasspy/piper-voices/tree/<rev>/en/<lang>/<voice>`; the `.onnx.json`
  files are plain git files, so their sha256 was computed from the downloaded bytes.
  All were checked against downloaded copies on 2026-10-16.

## Defaults

`default: true` marks one voice per engine + accent + gender; `defaultVoice()` reads it.
Kokoro: af_heart, am_michael, bf_emma, bm_george. Piper: lessac, ryan, alba,
northern_english_male. The library default (`DEFAULT_VOICE`) stays af_heart, the best
graded voice; the user of Readout prefers an American male voice, so Readout should call
`defaultVoice({ dialect: 'en-US', gender: 'male' })`.

## Calibration references (`HF_REFERENCE` in `src/voice/calibrate.js`)

Share of RMS above 6 kHz (4th-order high-pass) of the fixed calibration sentence
(`CALIBRATION.phonemes`, 222 tokens with pads, speed 1). onnxruntime issue #29807's
WebGPU corruption shifts this number; calibration rejects a render more than 0.03 away.
Measured with onnxruntime-web 1.30.0 in headless Chrome on a Core Ultra 7 256V: `wasm`
(CPU, the reference) and `webgpu` (Arc 140V). Kokoro is deterministic: repeated renders
gave identical values.

| voice | wasm (reference) | webgpu |
|---|---|---|
| af_heart | 0.1701 | 0.1704 |
| af_bella | 0.1609 | 0.1608 |
| am_michael | 0.1452 | 0.1453 |
| am_fenrir | 0.1056 | 0.1055 |
| am_puck | 0.1534 | 0.1531 |
| bf_emma | 0.1822 | 0.1822 |
| bm_george | 0.1046 | 0.1043 |

The largest WebGPU-vs-CPU difference is 0.0004, far inside the 0.03 tolerance; the
tolerance is wide because other GPUs may round differently, and a false rejection sends the
user to the lower-quality Piper voice. Re-measure after changing the calibration sentence:
`createVoice({ id, device: 'wasm', phonemizer: 'none' }).calibrate({ force: true })`.
