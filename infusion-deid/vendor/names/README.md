# Name data for the large lexicon

Downloaded by `tools/fetch-names.sh`; compiled into `src/biglex.js` by `tools/build-lexicon.js`.
None of this is patient data. Keep the raw files here so the build is reproducible.

| File | What | Origin and licence |
| --- | --- | --- |
| `surnames.csv` | 151,671 US surnames with 2000 Census counts (names with 100+ bearers) | US Census Bureau, public domain; mirrored by FiveThirtyEight (`fivethirtyeight/data`, CC-BY-4.0 for the mirror) |
| `baby-names.csv` | SSA top-1000 baby names per year, 1880–2008 (6,782 distinct) | US Social Security Administration, public domain; mirror `hadley/data-baby-names` |
| `first-all.txt` | 19,947 first names, many countries | `smashew/NameDatabases`, public domain (Unlicense) |
| `surnames-us.txt` | 88,799 US surnames | `smashew/NameDatabases`, public domain (Unlicense) |
| `english-20k.txt` | 20,000 most common English words | `first20hours/google-10000-english`, derived from the Google Web Trillion Word Corpus; permitted for educational, personal and research use. Used only to mark names that are also ordinary words so they need a cue. Replace with another word list if this tool is ever sold. |
| `english-words.txt` | 274,937 English words (lower case) | `an-array-of-english-words` 2.0.0, MIT (licence in `ENGLISH-WORDS-LICENSE`). Compiled into `src/dict.js` as a Bloom filter by `tools/build-dict.js`; used by the strict pass to tell ordinary and medical words from names. |

Not used: `MatthiasWinkelmann/firstname-database` (46k names, GFDL licence, which would attach to the build).
