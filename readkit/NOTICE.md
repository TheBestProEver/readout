# Notices

readkit itself is MIT licensed (see `LICENSE`, copyright 2026 Arnav Rai). It includes some
third-party data, and it loads some third-party code and models at runtime. Those parts keep
their own licences, listed here. This is a record of sources, not legal advice.

The licence texts for the data included are in `LICENSES/`: `Apache-2.0.txt` (the Apache
License, Version 2.0, for the misaki lexicons, the NeMo-derived tables and Kokoro's vocabulary),
`SymSpell-MIT.txt` (SymSpell's copyright and permission notice) and `en-lexicon-MIT.txt`
(en-lexicon's). Copies of readkit (`tools/copy-into.mjs`, `tools/vendor.mjs`) carry them with
this file.

## Data included in this repository

| Files | What | Source | Licence |
|---|---|---|---|
| `data/g2p/lex-us.txt`, `lex-gb.txt`, `pos-us.json`, `pos-gb.json` | misaki US and GB gold + silver pronunciation lexicons, repacked (`data/g2p/build/lex.mjs`, proven entry-for-entry equivalent) | [hexgrad/misaki](https://github.com/hexgrad/misaki) `misaki/data/{us,gb}_{gold,silver}.json` at commit `fba1236595f2d2bf21d414ba6e57d25256afada3` | Apache-2.0 (`LICENSES/Apache-2.0.txt`), copyright hexgrad; repacked, not changed in content |
| `data/g2p/tags.txt` | most likely part-of-speech tags of 30,000 frequent words | [en-lexicon](https://www.npmjs.com/package/en-lexicon) 1.0.11 by Alex Corvi, built on Eric Brill's tagger lexicon | MIT, copyright 2017 Alex Corvi (`LICENSES/en-lexicon-MIT.txt`) |
| `data/g2p/hetero.json` | heteronym senses and overrides; its `ipa` table is espeak-ng output (program output, not espeak-ng code) | readkit | MIT |
| `data/lang/words-en.txt` | 95,395 English words with frequencies (US + UK spellings) | union of SymSpell `frequency_dictionary_en_82_765.txt` and SymSpell.FrequencyDictionary `en-80k.txt` ([wolfgarbe/SymSpell](https://github.com/wolfgarbe/SymSpell)); the counts derived by SymSpell from Google Books Ngram data | MIT, copyright 2018 Wolf Garbe (`LICENSES/SymSpell-MIT.txt`); the counts CC BY 3.0 (Google Books Ngram, see below) |
| `data/lang/bigrams-en.txt` | word-pair counts for OCR correction, filtered and quantized | SymSpell `frequency_bigramdictionary_en_243_342.txt` (derived by SymSpell from Google Books Ngram counts) | MIT, copyright 2018 Wolf Garbe (`LICENSES/SymSpell-MIT.txt`); the counts CC BY 3.0 (Google Books Ngram, see below) |
| `data/speech/abbreviations.js`, `units.js`, `roman.js`, `symbols.js` | verbalizer rule tables; parts adapted (re-grouped, extended) | [NVIDIA NeMo-text-processing](https://github.com/NVIDIA/NeMo-text-processing) `en/data/` TSV files (commits in `data/speech/README.md`) | Apache-2.0 (`LICENSES/Apache-2.0.txt`), copyright NVIDIA Corporation (adapted parts: re-grouped and extended); MIT (readkit's additions) |
| `data/speech/acronyms.js` | words read as words vs spelled | readkit | MIT |
| `src/voice/kokoro-text.js` `VOCAB` | Kokoro's phoneme vocabulary | `hexgrad/Kokoro-82M` `config.json` | Apache-2.0 (`LICENSES/Apache-2.0.txt`) |
| `lab/passage.txt` | Chapter 5 of *Frankenstein* by Mary Shelley (1818), for the lab's screen-off test | Project Gutenberg #84 | public domain |

Google Books Ngram: the word and word-pair counts in `data/lang/words-en.txt` and
`data/lang/bigrams-en.txt` are derived from the Google Books Ngram dataset by Google
(https://books.google.com/ngrams), licensed under the Creative Commons Attribution 3.0 Unported
License (CC BY 3.0, https://creativecommons.org/licenses/by/3.0/), by way of SymSpell's frequency
dictionaries. readkit changed them: two word lists merged and kept to lowercase words, the pairs
filtered and quantized (see `data/lang/README.md`).

Provenance note on misaki: the misaki lexicons are published by hexgrad under Apache-2.0; where
their entries were originally drawn from is an open question upstream (hexgrad/misaki issue
#107). readkit uses them as published, unchanged in content.

Only NeMo's data was adapted; no NeMo code is used. No espeak-ng or piper-phonemize code or
data (GPL-3.0) is in this repository.

## Code loaded at runtime (not included; pinned URLs in `src/config.js`)

| Library | Version | Used for | Licence |
|---|---|---|---|
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 5.6.205 | reading PDFs | Apache-2.0, Mozilla |
| [Tesseract.js](https://github.com/naptha/tesseract.js) + `tesseract.js-core` | 7.0.0 | OCR of scans and photos | Apache-2.0 |
| Tesseract English model (`@tesseract.js-data/eng`, `4.0.0_best_int`) | 1.0.0 | OCR | Apache-2.0 (tessdata_best, Google) |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) | 1.30.0 | running Kokoro (WebGPU) and Piper (WASM) | MIT, Microsoft |
| [phonemizer](https://www.npmjs.com/package/phonemizer) (espeak-ng compiled to WASM) | 1.2.1 | phonemes for words not in the lexicon | **GPL-3.0** (espeak-ng). Loaded at runtime only, as a separate program; never copied into readkit |
| [@diffusionstudio/piper-wasm](https://www.npmjs.com/package/@diffusionstudio/piper-wasm) (`piper_phonemize`, espeak-ng) | 1.0.0 | Piper's phonemizer fallback | **GPL-3.0** (espeak-ng, piper-phonemize). Loaded at runtime only; never copied into readkit |
| [Defuddle](https://github.com/kepano/defuddle) | 0.19.5 | main content of web pages | MIT |
| [Readability](https://github.com/mozilla/readability) (`@mozilla/readability`) | 0.6.0 | web page fallback | Apache-2.0, Mozilla |

## Voice models downloaded at runtime (not included)

Models download from Hugging Face at pinned revisions into the browser's private storage
(OPFS) when the user installs a voice. Details and checksums: `data/voice/README.md`.

| Voices | Source | Licence |
|---|---|---|
| Kokoro-82M (all Kokoro voices: af_heart, af_bella, am_michael, am_fenrir, am_puck, bf_emma, bm_george) | `onnx-community/Kokoro-82M-v1.0-ONNX-timestamped` @ `dd4401a9`, from `hexgrad/Kokoro-82M` | Apache-2.0 |
| Piper code and model exports | `rhasspy/piper-voices` @ `c10ece1a` | MIT |
| Piper en_US-lessac-medium | Blizzard 2013 Lessac dataset | Blizzard 2013 Lessac licence (non-commercial) |
| Piper en_US-ryan-medium | RyanSpeech | CC BY-NC-SA 4.0 (non-commercial) |
| Piper en_US-hfc_male-medium | Hi-Fi CAPTAIN | CC BY-NC-SA 4.0 (non-commercial) |
| Piper en_GB-alba-medium | Alba dataset | CC BY 4.0 |
| Piper en_GB-cori-medium | LibriVox recordings | public domain |
| Piper en_GB-northern_english_male-medium | OpenSLR 83 | CC BY-SA 4.0 |

`voiceCatalog` marks the non-commercial voices with `commercial: false`.
