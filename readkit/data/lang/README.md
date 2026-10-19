# data/lang

| File | Source | License |
|---|---|---|
| `words-en.txt` | Union of SymSpell's `frequency_dictionary_en_82_765.txt` (UK-leaning) and SymSpell.FrequencyDictionary `en-80k.txt` (US), lowercase words only, highest count kept. 95,395 words, `word count` per line, most frequent first. | MIT (copyright 2018 Wolf Garbe, SymSpell: `LICENSES/SymSpell-MIT.txt`); counts from Google Books Ngram data, CC BY 3.0 |
| `bigrams-en.txt` | SymSpell's `frequency_bigramdictionary_en_243_342.txt`, filtered and quantized for OCR correction (`make-bigrams.mjs`). | MIT (copyright 2018 Wolf Garbe, SymSpell: `LICENSES/SymSpell-MIT.txt`); counts from Google Books Ngram data, CC BY 3.0 |

The word and pair counts are derived from the Google Books Ngram dataset by Google
(https://books.google.com/ngrams), licensed under CC BY 3.0
(https://creativecommons.org/licenses/by/3.0/), by way of SymSpell. readkit merged, filtered and
quantized them as described above.
