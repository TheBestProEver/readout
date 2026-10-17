# data/lang: files used by OCR correction

| File | Source | License |
|---|---|---|
| `bigrams-en.txt` | SymSpell's `frequency_bigramdictionary_en_243_342.txt` (https://github.com/wolfgarbe/SymSpell, Wolf Garbe; derived by SymSpell from Google Books Ngram counts), lowercased, pairs whose words are both in `words-en.txt` only, counts quantized to `q = round(4 ln(count / 6400000))`. Rebuild with `node data/lang/make-bigrams.mjs <path to frequency_bigramdictionary_en_243_342.txt>`. 16,600 first words, 242,342 pairs, 2.2 MB. | MIT |
| `make-bigrams.mjs` | readkit (builds `bigrams-en.txt`) | MIT (this repo) |

The word list itself (`words-en.txt`) is described in `README.md`.

Code-side word lists in `src/lang/` are readkit's own, written for this project:

- `src/lang/period.js`: older English spellings (17th to 19th century print: Hume, Johnson, Defoe, Austen, the King James Bible) and the rules that recognise regular old forms (`publick`, `errour`, `surprize`, `loveth`), each checked against the modern list.
- `src/lang/tokens.js`: one- and two-letter words, capitalised abbreviations, code shapes (B12, CO2, COVID-19, x86).
- `src/lang/symspell.js`: the OCR confusion table (`rn`/`m`, `cl`/`d`, `li`/`h`, `1`/`l`, `0`/`o`, ...).
