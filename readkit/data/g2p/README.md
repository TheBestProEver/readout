# data/g2p

Pronunciation data for `src/g2p/`. Rebuild everything with `data/g2p/build/build.mjs`
(see its header for the arguments). Loaded at runtime by `createG2P()` only, and only
the files for the dialect asked for; nothing here loads when readkit is imported.

| File | Size (gzip) | What | Source | License |
|---|---|---|---|---|
| `lex-us.txt` | 2,759 KB (1,116 KB) | misaki US gold + silver lexicons, packed (format below) | [hexgrad/misaki](https://github.com/hexgrad/misaki) `misaki/data/us_gold.json`, `us_silver.json` at commit `fba1236595f2d2bf21d414ba6e57d25256afada3` | Apache-2.0 (hexgrad) |
| `lex-gb.txt` | 2,978 KB (1,200 KB) | misaki GB gold + silver lexicons, packed | same, `gb_gold.json`, `gb_silver.json` | Apache-2.0 (hexgrad) |
| `pos-us.json`, `pos-gb.json` | 46 KB (9 KB) each | misaki's part-of-speech entries (the gold entries whose value is `{ DEFAULT, NOUN, VERB, VBD, ... }`, about 790 words) | same misaki files | Apache-2.0 (hexgrad) |
| `tags.txt` | 196 KB (84 KB) | Penn part-of-speech tags for the 30,000 most frequent words of `data/lang/words-en.txt`, most likely first, one code letter per tag (codes in `src/g2p/tagger.js`) | [en-lexicon](https://www.npmjs.com/package/en-lexicon) 1.0.11 by Alex Corvi, built on Eric Brill's tagger lexicon | MIT |
| `hetero.json` | 13 KB (3 KB) | heteronym senses the part of speech can't separate (lead the metal, a tear in cloth, take a bow, a row = quarrel, bass, does = deer, just deserts, résumé), readkit's lexicon overrides (US 'aluminium' as spelled, GB 'Z' = zed), and espeak IPA for each misaki POS reading, used by `ipa()` for Piper | hand-written for readkit; the `ipa` table is output of espeak-ng (phonemizer 1.2.1) generated at build time by `build/hetero-ipa.mjs` | MIT (readkit). The espeak IPA strings are program output, not espeak-ng code |
| `build/` | | build scripts, not loaded at runtime | readkit | MIT |

espeak-ng itself (GPL-3.0) is never copied here; it loads at runtime from
`config.phonemizer`.

## Lexicon format (`lex-*.txt`)

Plain ASCII text, searched in place by `src/g2p/packed.js` (no parse step; about 3 MB of
heap per dialect instead of ~40 MB for the parsed JSON):

```
#readkit-lex 1 en-US <note>
#map ˈ1ˌ2ː:ə@ɹr...          misaki symbol, then the ASCII code that stands for it
#gold
0'Merica	m1Er@k@          <shared-prefix char><rest of key><TAB><encoded phonemes>
1Ndrangheta	ndr&Ng1ED@
...
#silver
...
```

Keys are sorted (UTF-16 code-unit order). The first character of a line is
`chr(48 + n)`, where `n` is the number of leading characters shared with the previous
key; every 16th line of a section has `n = 0`, so a lookup is a binary search over those
lines and a scan of at most 16 more.

What was left out, and why it is safe: the build drops Capitalized copies of lowercase
keys with the same phonemes (misaki adds exactly those copies itself when it loads a
dictionary) and silver entries that gold always wins over. It then looks up every
original key, its lowercase/Capitalized/UPPER forms and its `'s`, `s`, `'` and `s'` forms
in both the full and the reduced lexicon, with eleven part-of-speech tags and two
contexts, and fails unless every result is identical. Dropping inflections that misaki's
stemming rebuilds was tried and abandoned: almost all of them are needed as stems of
other forms ("hand's" needs `hand`), which saved under 1%.

Compared with misaki's own JSON (gzip): US 1,369 KB to 1,116 KB, GB 1,460 KB to 1,200 KB.
`build/lex.mjs` runs the same `src/g2p/lexicon.js` the runtime uses; separately, that
port was checked against misaki's own Python `Lexicon` on 360,000 word/tag pairs per
dialect (identical apart from readkit's plural-possessive extension).
Leaving out entries that espeak-ng already pronounces the same was considered and
rejected: espeak is an optional, separately loaded GPL component that may be missing,
misaki's stemming needs the stems to be in the dictionary, and a lookup is ~1,000 times
cheaper than an espeak call.
