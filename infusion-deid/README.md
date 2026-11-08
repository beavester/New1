# Infusion De-ID

A single HTML file that de-identifies Epic infusion schedule and ordering exports on a locked-down work computer. No install, no admin rights, no network, no Office add-in sideloading. Open `dist/infusion-deid.html` in Edge (or Chrome), drop in the export, confirm column roles once, run, review, download.

It implements the architecture from the PHI (protected health information) detection research memo (`docs/PLAN.md` has the plan and the gaps):

| Stage | What it does |
| --- | --- |
| Schema pass | Classifies each column (patient name, MRN, DOB, account, phone, provider, date, age, ZIP, free text, keep, drop) from header and values. You confirm once; roles are remembered per report layout (headers only, in browser local storage). |
| Census dictionary | Every patient's name variants (`Last, First`, `First Last`, `F. Last`, surname, each given name of a two-word or three-part name, diminutives such as Ben/Kasia/Sal, initials `K.Y.` and `Sal P.`), MRN with and without leading zeros and with internal spaces, DOB in nine renderings, account, phone, plus provider names, become an exact-match detector over all free text. A relative who shares the surname (`daughter Siobhan Fitzgerald-Nowak`) is told apart from the patient and gets a surrogate of her own. Deterministic recall on the identifiers that matter most. |
| Tier 0 rules | MRN pattern learned from your MRN column, labelled record numbers even when split (`MRN#0041 2345`), phones with extensions, emails, SSNs and SSN last-4, URLs, street addresses with or without a suffix (`lives at 412 Delaware`, `near Brighton Rd`), town + ZIP, ages 90+ in every spelling (`91yo`, `Zofia, 95,`, `Turned 90`), dates in every Epic format (`11/7/26`, `2026-11-07`, `Nov. 7th`, `7-Nov`, `3rd of Jan`, `11/13`). Cycle fractions (`1/2 dose`, `Cycle 1/2`) and symptom scores (`pain 6/10`) are not dates. A birthdate written in a note follows the DOB setting (removed by default). |
| Tier 1-lite | Large frequency-tiered lexicon (Census 2000 surnames, SSA first names: 190k names, built by `tools/build-lexicon.js`) plus a cue detector for names, organizations, locations: honorifics, credentials (`Smith, J NP`), relationship words (`pt's son Mark`, `Mark (son)`), contact verbs (`Called Xiomara at 315-…`), facility words and acronyms (`Kenmore Mercy`, `ECMC`), `City, ST`. Clinical eponyms and drug names are protected (Hodgkin, Bell's, Graves, Ann Arbor, Keytruda…). |
| Post-processing | Overlap resolution by priority, name merging, document-wide propagation of every detected name, sentence-boundary awareness. |
| Hide in plain sight | Realistic surrogate names from one allocator per session: a made-up name is never handed to two people, whether patient, doctor, relative, street or organization, across every input, and a saved key seeds the allocator. Per-patient date shifting (±30–365 days, intervals preserved), age banding, 3-digit ZIPs, fake organizations and cities, `555-010-xxxx` phones (bare 10-digit numbers too). MRN → `P001` study code. |
| Self-check and audit | Before any download the page re-scans every output cell with a deliberately over-sensitive check: digits only (so a spaced or hyphenated MRN is found), every name token, diminutive and initial of every patient, ages 90+ as bare numbers, and phone/e-mail/SSN shapes the surrogates never produce. A hit, or a patient whose name could not be read from pasted text or a screenshot, blocks the download. A `DeID Audit` column per row: patient code, counts by type, counts by layer; the date offset lives only in the session key. A run summary (`.txt`, no PHI) and the session key (`.xlsx`, **PHI**, one per session covering every input) are separate downloads. |
| Review | Highlighted detections per cell; "lines need a look" lists only the places found from a word clue alone (or text the screenshot reader was unsure of), with the count of certain replacements shown beside it. Click a highlight to drop it, select text to add one. Edits re-run the pipeline with the same seed so surrogates stay consistent. A patient's own identifier is locked and cannot be un-hidden. |
| Session registry | One patient registry per page session: the same real patient (matched by MRN with leading-zero and OCR-confusion normalisation, then name + DOB, then a close name) keeps one code, one surrogate and one date offset across spreadsheets, pasted text and screenshots. A saved key can seed a later session. |
| Text and screenshots | Pasted text and OCR output become a per-line table (name, MRN, DOB carried forward to following lines; `===` starts a new section) and run through the same pipeline. The OCR build reads screenshots in the page with Tesseract.js, offline. |
| Re-identify | Load the de-identified workbook plus the mapping key on the hospital machine to restore MRNs, names (ALL-CAPS cells included), providers without doubled credentials, relatives, organizations and dates. |
| Validate | Built-in synthetic stress set with exact ground truth, per-category token and entity recall with bootstrap 95% CIs, over-redaction rate, leak check, the memo's adversarial cases, and a layer ablation. |

![De-identify tab](docs/screenshot-deid.png)
![Review](docs/screenshot-review.png)

## Using it on a work computer

Three actions: **drop, glance, download.**

1. Copy `dist/infusion-deid-ocr.html` to the machine (email it to yourself, USB, shared drive). It is one file, about 10 MB, and handles exports, pasted text and screenshots. `dist/infusion-deid.html` (3 MB) is the same without the screenshot reader. If you need to protect **screenshots**, copy `dist/infusion-deid-ocr.html` instead (about 9 MB; it carries an offline text reader). Double-click to open in Edge or Chrome. The page makes no network connections: its Content-Security-Policy forbids them and the end-to-end test asserts that no request leaves the page.
2. **Drop** an Epic export (`.xlsx`/`.csv`), a Snipping Tool screenshot, or a `.txt` file onto the page, or paste text with Ctrl+V. There is no mode to pick: the page tells a spreadsheet from a screenshot from a note by its content and starts work at once. Title rows above the header are detected. Drop more files to add them to the same session: the same patient keeps the same code, made-up name and date shift across every file.
3. **Glance** at the verdict. Green `Checked:` means none of the real names, nicknames, initials, MRNs, phone numbers, account numbers or birthdates in the file appear anywhere in the output, in any spacing the page can predict (the page re-scans its own result before it lets you download), and the download button sits right there in the verdict. Red `Stop:` lists what still appears, with a `Show` link to each line, and keeps the download buttons off until it is fixed; a pasted line or screenshot with a record number but no legible name also stops. Below the verdict, "lines need a look" are the places found from a word clue alone; tap a highlight if it is not patient information, or select text and press *This is patient info*. The first time a report layout is seen, a one-line sentence says how each column was treated (`Change` opens the details); when something looks risky, the card turns amber and asks you to confirm before downloading.
4. **Download** the protected file. It is named `protected_<date>_<n>.xlsx`, never after the source file, and its audit column carries counts only, never the date offset. The **session key** (`SESSION_KEY_PHI_<date>_<time>_<k>.xlsx`, the counter continues when a session is restored from a key) is a separate button on the strip at the bottom of the page, marked with a lock and the word PHI: it links codes and made-up names back to real patients for every file in the session, and it stays on the hospital drive. *Download all* writes one workbook with a sheet per source.

Screenshots: the recognised text is shown in an editable box ("What the screenshot says"); fix misreads and press *Use my corrections*. Lines the reader was unsure about are flagged *Unclear in screenshot*. Only the text is protected; the image itself is never written anywhere and must not leave the hospital.

Under **Advanced**: how names appear (made-up names or codes), dates (shifted per patient with intervals kept, the default; or removed for Safe Harbor), *Always remove* for your hospital, clinic and department names, *Never remove* for local vocabulary. Settings and word lists are remembered on the computer; patient data never is. **Restore identities** takes a protected file plus the session key and puts the real values back, on the hospital machine only. **Check accuracy** scores the detector on an invented report.

## Measured on the synthetic set

`node test/run_eval.js` on 600 rows × 4 seeds (token recall; 95% bootstrap CI). `node --test test/unit.test.js` also runs a 40-cell red-team corpus (nicknames, relatives, spaced MRNs, bare ages, addresses, employers) as a table and row by row, and the self-check against the raw and protected output.

| Category | Recall | Notes |
| --- | --- | --- |
| Names (patient, relative, provider; in- and out-of-lexicon) | 99.9–100% | out-of-lexicon names caught only when a cue is present |
| MRN, account, phone, email, dates, ages 90+ | 100% | rules + census |
| Organizations | 100% | synthetic facilities only; real local names need the always-redact list |
| Locations | 100% | `City, ST`, prepositions, addresses |
| Over-redaction | 0.0–0.1% of non-PHI tokens | eponyms and word-names (Will, Hope, Grace) stay |
| Structured leaks (real MRN, name, phone or account anywhere in output) | 0 | checked on every run |

**These numbers are an upper bound.** The generator and the detector were written by the same hands, and the generator's fragments share vocabulary with the detector's cues. The number that counts is the gold set on your own reports (see `docs/PLAN.md`). Layer ablation on the same set shows what each tier buys: without the census dictionary, name recall drops to ~93%; without the lexicon/cue tier, names fall to ~57% and organizations to ~2%. That delta is the argument for the architecture.

Known gap: an out-of-lexicon surname with no cue at all (`Vanterpool called about labs`) is missed. That is the slot for the compact clinical transformer (Tier 1) from the memo; this build does not carry one.

## Measured on blind red-team cases

Rounds 1–4 were find-and-fix rounds: the fixed corpus in `test/redteam/` (170 text/table cases, 45 screenshots) is a regression guarantee, not a miss rate. Round 5 was measurement only (92 fresh cases, no fixes): with the curated lexicon, 10 of 56 ordinary comments and 12 of 24 hard ones leaked at least one identifier; screenshots 0 of 12. Nine of the ten ordinary leaks were a patient's full name in a stand-alone note; v0.3's large lexicon and person-cue rules target exactly that. The unbiased number for v0.3 comes from round 6 (see `docs/PLAN.md` §7). Run the scorer yourself: `node test/redteam/score.js --ocr`.

## Development

```
node build.js --all      # -> dist/infusion-deid.html (plain) and dist/infusion-deid-ocr.html (with the offline screenshot reader)
node --test test/unit.test.js
node test/run_eval.js    # synthetic evaluation, ablation, adversarial; exits 1 below the acceptance bar
node test/e2e.js         # Playwright + Chromium: drop → auto-run → self-check → review → downloads; second file, pasted text (incl. common-word
                         # surnames and an MRN-only line), columns gate, new session, restore from key, Check accuracy, Restore identities round trip
                         # (names, attending, comment tokens), 390px layout and dark/light contrast; on the OCR build, two screenshots of the same patients
```

Layout:

```
src/lexicon.js    name lists, ambiguous word-names, clinical allowlist, facility words, surrogate pools
src/core.js       pipeline: classify → census → detect (census, rules, lexicon/cue) → resolve → surrogate → audit; re-identify
src/synth.js      synthetic stress set with exact ground truth; adversarial cases from the memo
src/evaluate.js   scorer: token/entity recall, bootstrap CI, over-redaction, leak check, ablation
src/ocr.js        offline OCR wrapper (Tesseract.js worker built from inlined assets; OCR build only)
src/app.js        browser UI: input routing, session registry, self-check, review, downloads
src/index.html    template; build.js inlines vendor + src into dist/
vendor/           SheetJS Community Edition 0.18.5 (Apache-2.0); vendor/ocr: Tesseract.js + English model (OCR build)
```

`core.js`, `synth.js` and `evaluate.js` are plain JS with no DOM dependency: the same code runs in Node for tests and in the page. A hospital-network service (the memo's preferred topology) can wrap `processTable` as is.
