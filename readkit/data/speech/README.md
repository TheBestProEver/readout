# data/speech

Rule tables for the verbalizer (`src/speech/`). They are ES modules so they load with the code,
in the browser and in Node, without a fetch.

| File | What | Source | License |
|---|---|---|---|
| `abbreviations.js` | titles (Dr, Mr, St...), street words, abbreviations read only before a number (Fig., pp., No., s., ch.), anywhere abbreviations (e.g., i.e., etc., &c.), months, weekdays; old-book references (sect., cap., fol., i. e., viz, inst., ult.) | Titles and several general entries adapted from NVIDIA NeMo-text-processing `nemo_text_processing/text_normalization/en/data/whitelist/lj_speech.tsv` (last changed in commit 372b7a1f, 2022-11-15) and `whitelist/tts.tsv` (commit cb104cad, 2024-06-07), regrouped by the context each one needs; the rest is readkit's own | Apache-2.0 (NeMo parts), MIT (readkit) |
| `units.js` | unit symbols with singular and plural words, and risk flags | Adapted from NeMo-text-processing `en/data/measure/unit.tsv` (commit e23f6e13, 2024-08-21): re-cased, plurals added, extended (bytes, bits, cooking units, electrical units) | Apache-2.0 (NeMo parts), MIT (readkit) |
| `roman.js` | words before a Roman numeral that make it a number (Chapter, Book, Part, World War...), regnal names and titles (Henry, Pope...) | Cue words extend NeMo-text-processing `en/data/roman/key_word.tsv` (commit 372b7a1f); names are readkit's own list | Apache-2.0 (NeMo parts), MIT (readkit) |
| `symbols.js` | Greek letters, maths operators, symbols | Greek names and some symbols from NeMo-text-processing `en/data/whitelist/tts.tsv` and `whitelist/symbol.tsv` (commit 66380ca2, 2022-12-14) | Apache-2.0 (NeMo parts), MIT (readkit) |
| `acronyms.js` | ALL-CAPS words read as words (NASA, COVID) vs spelled (FBI, NHS), mixed-case initialisms | readkit's own lists | MIT |

NeMo-text-processing: https://github.com/NVIDIA/NeMo-text-processing (checked against `main` at
ddadfb2a, 2026-09-18). Copyright NVIDIA CORPORATION, licensed under the Apache License 2.0.
Only data was adapted; no NeMo code is used.

Test fixtures in `tests/fixtures/speech/` (bench-dev, bench-heldout, realistic100, fresh60, junk-tokens,
oldbook-pdf) were written by hand for readkit; oldbook-pdf's text imitates eighteenth-century style but is
not taken from any book.
