# Infusion De-ID

A single HTML file that de-identifies Epic infusion schedule and ordering exports on a locked-down work computer. No install, no admin rights, no network, no Office add-in sideloading. Open `dist/infusion-deid.html` in Edge (or Chrome), drop in the export, confirm column roles once, run, review, download.

It implements the architecture from the PHI (protected health information) detection research memo (`docs/PLAN.md` has the plan and the gaps):

| Stage | What it does |
| --- | --- |
| Schema pass | Classifies each column (patient name, MRN, DOB, account, phone, provider, date, age, ZIP, free text, keep, drop) from header and values. You confirm once; roles are remembered per report layout (headers only, in browser local storage). |
| Census dictionary | Every patient's name variants (`Last, First`, `First Last`, `F. Last`, surname, first name), MRN with and without leading zeros, DOB in nine renderings, account, phone, plus provider names, become an exact-match detector over all free text. Deterministic recall on the identifiers that matter most. |
| Tier 0 rules | MRN pattern learned from your MRN column, phones with extensions, emails, SSNs, URLs, street addresses, ZIPs, ages 90+, dates in every Epic format (`11/7/26`, `2026-11-07`, `Nov. 7th`, `7-Nov`, `3rd of Jan`, `11/13`). Cycle fractions (`1/2 dose`, `Cycle 1/2`) are not dates. |
| Tier 1-lite | Lexicon + cue detector for names, organizations, locations: honorifics, credentials (`Smith, J NP`), relationship words (`pt's son Mark`, `Mark (son)`), contact verbs (`Called Xiomara at 315-…`), facility words and acronyms (`Kenmore Mercy`, `ECMC`), `City, ST`. Clinical eponyms and drug names are protected (Hodgkin, Bell's, Graves, Ann Arbor, Keytruda…). |
| Post-processing | Overlap resolution by priority, name merging, document-wide propagation of every detected name, sentence-boundary awareness. |
| Hide in plain sight | Realistic surrogate names consistent per person across the whole document, per-patient date shifting (±30–365 days, intervals preserved), age banding, 3-digit ZIPs, fake organizations and cities, `555-01xx` phones. MRN → `P001` study code. |
| Audit | A `DeID Audit` column per row: patient code, counts by type, counts by layer, date offset. A run report (`.txt`, no PHI) and a mapping key (`.xlsx`, **PHI**) are separate downloads. |
| Review | Highlighted detections per cell, filter to the least-certain rows, click a highlight to drop it, select text to add one. Edits re-run the pipeline with the same seed so surrogates stay consistent. |
| Re-identify | Load the de-identified workbook plus the mapping key on the hospital machine to restore MRNs, names, surrogates and dates. |
| Validate | Built-in synthetic stress set with exact ground truth, per-category token and entity recall with bootstrap 95% CIs, over-redaction rate, leak check, the memo's adversarial cases, and a layer ablation. |

![De-identify tab](docs/screenshot-deid.png)
![Review](docs/screenshot-review.png)

## Using it on a work computer

1. Copy `dist/infusion-deid.html` to the machine (email it to yourself, USB, shared drive). It is one file, about 1 MB.
2. Double-click it. It opens in the default browser. It sends nothing anywhere: there is a Content-Security-Policy in the page that forbids all network connections, and the end-to-end test asserts that no request leaves the page.
3. Export the schedule or ordering report from Epic as `.xlsx` (or `.csv`) and drop it onto the page. Title rows above the header are detected.
4. Check the column roles. Fix anything wrong, then **Save roles for this layout** so next time it is one click.
5. Fill **Always redact** with your local referral sources and departments (ECMC, Roswell, Southtowns…). Fill **Never redact** with local vocabulary the detector should leave alone (chair names, local drug nicknames).
6. **De-identify**, then look at the review table with the filter set to *least certain*. Toggle anything wrong.
7. Download the de-identified workbook. Download the mapping key **only** to the hospital drive next to the source; it is PHI.

Options worth knowing: **Dates → Remove** gives Safe Harbor-style output if compliance refuses expert determination; **Patient names → Study codes** if surrogates would confuse the downstream reader; **DOB → Year only** keeps age precision for research that needs it.

## Measured on the synthetic set

`node test/run_eval.js` on 600 rows × 4 seeds (token recall; 95% bootstrap CI):

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

## Development

```
node build.js            # -> dist/infusion-deid.html (single file)
node --test test/unit.test.js
node test/run_eval.js    # synthetic evaluation, ablation, adversarial; exits 1 below the acceptance bar
node test/e2e.js         # Playwright + Chromium: loads the built file, uploads, runs, reviews, downloads, re-identifies
```

Layout:

```
src/lexicon.js    name lists, ambiguous word-names, clinical allowlist, facility words, surrogate pools
src/core.js       pipeline: classify → census → detect (census, rules, lexicon/cue) → resolve → surrogate → audit; re-identify
src/synth.js      synthetic stress set with exact ground truth; adversarial cases from the memo
src/evaluate.js   scorer: token/entity recall, bootstrap CI, over-redaction, leak check, ablation
src/app.js        browser UI
src/index.html    template; build.js inlines vendor + src into dist/
vendor/           SheetJS Community Edition 0.18.5 (Apache-2.0)
```

`core.js`, `synth.js` and `evaluate.js` are plain JS with no DOM dependency: the same code runs in Node for tests and in the page. A hospital-network service (the memo's preferred topology) can wrap `processTable` as is.
