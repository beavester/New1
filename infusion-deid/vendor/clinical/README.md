# Clinical vocabulary for the strict pass

Compiled into `src/clinvocab.js` by `tools/build-clinvocab.js`. None of this is patient data. The raw files are kept
here so the build is reproducible.

| File | What | Origin and licence |
| --- | --- | --- |
| `drugs.json` | 1,000 brand and generic drug names (source given in the file: US National Library of Medicine Drug Information Portal) | `dariusk/corpora`, file `data/medicine/drugs.json`, CC0 1.0 (see `CORPORA-LICENSE`). sha256 `0e28675af73af024ceb470ea152158fb856dde232faf1a758d72893623b460cd` |
| `drugNameStems.json` | 464 generic drug name stems (USAN stems; source given in the file: NLM Drug Information Portal) | `dariusk/corpora`, file `data/medicine/drugNameStems.json`, CC0 1.0. sha256 `b1499e668f26c9e091d83125b97c6ee1212f83489f7606288f426e7da0acf27c` |
| `cars.json` | 66 car manufacturers | `dariusk/corpora`, file `data/corporations/cars.json`, CC0 1.0. sha256 `75731ac82d8dcace2ce7c52cd9b7e8e3093cd8b3204086e2ae1c1b72efafbbc3` |

Fetched from `https://raw.githubusercontent.com/dariusk/corpora/master/data/...` at commit
`1109305242d08d851a50f929792a0e7caa7a655b`.

What the build keeps: single words of four or more letters that are not in the 275k-word dictionary and not in the
name lexicon (a drug that is also a given name or a surname stays a name unless its context says otherwise); stems of
four or more letters. A word in this vocabulary is *kept* in the output, so a wrong entry is a missed name: the lists are
stored as plain words (no Bloom filter, no false positives).

To refresh: download the three files into this directory, then run `node tools/build-clinvocab.js`.
Not used: `benjamin-burns/openFDADrugMap` (89k brand/generic pairs derived from openFDA; the repository has no licence
file) and `glutanimate/wordlist-medicalterms-en` / `@cspell/dict-medicalterms` (GPL-3.0).
