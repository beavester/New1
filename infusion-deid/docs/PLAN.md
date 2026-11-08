# Plan: a de-identifier that runs on a work computer

Companion to the PHI Detection Research memo (Nov 7, 2026). This is the plan the build follows, what it leaves out, and what comes next.

## 1. The constraint that decides the topology

The memo weighs two topologies: detection inside an Office add-in (WebAssembly in the task pane) or detection in a hospital-network container with the add-in as a thin client. Both assume you can get software onto the machine. On a typical hospital workstation you cannot: no local admin, no Python, no Docker, no add-in sideloading, Office add-ins only through the admin center, and outbound web filtered.

What survives all of that is a browser opening a local HTML file. Edge is already there, `file://` works, FileReader and Blob downloads work, local storage works, and a Content-Security-Policy meta tag can forbid every network connection so the privacy claim is checkable rather than asserted.

So the build is **topology C: one self-contained HTML file**, with the pipeline written as plain JavaScript modules that have no DOM dependency. That keeps the memo's preferred topology open: the same `processTable` function can run inside a hospital-network Node or Python-wrapped service later, and the HTML becomes the thin client. The Office.js shell is deferred (the memo's own step 5) and is not needed for the first measured result.

## 2. What is built (v0.1)

| Memo element | Status | Where |
| --- | --- | --- |
| Schema pass with per-report-type config | Built. Header + value heuristics, roles saved per header signature. | `core.classifyColumns`, `app.js` |
| Census dictionary from structured columns | Built. Name variants, MRN with/without leading zeros, DOB renderings, account, phone, providers. Row-scoped matching for ambiguous single tokens so "May" the patient does not eat "May" the month in another patient's row. | `core.buildCensus`, `censusSpans` |
| Tier 0 rules with validation | Built. MRN regex inferred from the MRN column (floor 6 digits, prefix-aware), phones with extensions, email, SSN, URL, IP, address, ZIP, ages 90+, dates in 5 pattern families with unit/cycle exclusions. | `core.ruleSpans` |
| Tier 1 compact encoder | **Not built.** Replaced by a lexicon + cue detector (honorific, credential, relation, contact verb, facility word, acronym, City/ST, preposition + place). Explicit slot in `detectText` for a model layer. | `core.lexiconSpans` |
| Tier 2 post-processor | Built. Priority overlap resolution with name-union and org-over-name rules, adjacent-name merging, document-wide propagation, sentence boundaries. | `core.resolveSpans`, `collectPropagation` |
| Tier 3 LLM review | Not built (needs local or BAA-covered model). | — |
| HIPS surrogation, consistent, date-shifted | Built. Per-patient offsets ±30–365 d, format-preserving date rendering, surrogate pools disjoint from document vocabulary, mapping key separate. | `core.Surrogator` |
| Audit cell | Built. | `processTable` |
| Round trip | Built. Re-identify from workbook + mapping key, including un-shifting dates. | `core.reidentify` |
| Synthetic stress set | Built. Templates mimic infusion schedule comments; 30% of third-party names from a hold-out list outside the lexicon so out-of-lexicon recall is measured separately. | `synth.make` |
| Adversarial cases | Built. 20 cases from the memo's list; 19 pass, the out-of-lexicon-no-cue case fails by design. | `synth.adversarial` |
| Metrics with CIs, worst category reported | Built. Token and entity recall per category, bootstrap 95% CI, over-redaction, leak check. | `evaluate.score` |
| Ablation | Built. Full / no census / no lexicon / rules only. | `evaluate.runAblation` |
| Re-identification test (DIRI) | Not built (needs an adversary model). | — |
| Gold set on real reports | **Your job, on the hospital machine.** The tool's review panel is the annotation surface. | — |

## 3. What the synthetic numbers mean

On 600 rows × 4 seeds: 99.9–100% token recall in every category, 0–0.1% over-redaction, zero structured leaks. The ablation is the useful part: the census dictionary adds ~7–11 points of name recall over the lexicon alone; the lexicon/cue tier is responsible for ~43 points of name recall and essentially all organization and location recall.

These are an upper bound and should be presented as such. Three reasons: the same person wrote the generator and the detector; the generator's comment fragments share vocabulary with the cues; the lexicon covers most of the generator's name pool. The memo's cross-institution finding (99% at home, 70–90% elsewhere) applies to this tool too. The gold set is the only number compliance should see.

## 4. Validation plan (unchanged from the memo, now concrete)

1. **Gold set.** Export 2–3 real schedule and 1–2 ordering reports. Run the tool. In the review panel, two annotators (you and one colleague) go row by row and add or remove highlights until the cell is right. The manual edits are the annotation. Export the run report and the edited output; keep both on the hospital drive. Target 200–300 free-text cells.
2. **Score.** The number of manual *additions* over the number of true identifiers is the miss rate; *removals* over non-PHI tokens is the over-redaction rate. Report per category, worst category first, with a binomial CI. (A small script to compute this from two review exports is the next code task.)
3. **Tune.** Fill the always-redact list from the misses that are local facility names; fill never-redact from the removals that are local vocabulary. Re-run. Do not touch the detector code for a gold-set miss until it has been seen twice.
4. **Re-identification test.** When a BAA-covered or local model is available: give it the de-identified export and the census and ask it to match rows to patients. Zero matches is the bar.
5. **Expert determination memo.** Method (this document), measured miss rates with CIs, residual-risk argument (surrogates, date shifting, small-cell handling), operational controls (mapping key stays internal; human review of least-certain rows before export).

Acceptance bar from the memo, applied to the gold set: ≥99% on patient names, MRNs and dates (census + rules should guarantee this); ≥95% on every other category; ≤2% over-redaction; zero re-identification matches.

## 5. Known gaps, in order of risk

1. **Out-of-lexicon names with no cue** ("Vanterpool called about labs"). This is exactly the Tier 1 encoder's job. Options when the time comes: SHIELD's DeBERTa-v3 (licence unverified) or MedDeID's RoBERTa exported to ONNX and run with `onnxruntime-web` inside this same file (~100–180 MB int8; first load slow, then cached), or the hospital-network service. The `detectText` function already merges spans from any number of sources, so the integration is adding one more span producer.
2. **Local facility and department names** without a generic word. The always-redact list handles it; the list should be seeded from the ordering report's "referring" column once that is exported.
3. **Small cells.** A unique regimen identifies a patient regardless of redaction. The tool cannot detect it; the memo for compliance must address it (k-anonymity check on regimen × dept × month is a cheap add).
4. **Relative dates and years** are left as is, correctly under Safe Harbor, but "next Tues" plus a shifted date around it is a weak interval leak. Acceptable; note it.
5. **Free text in columns classified as keep.** The column warning flags headers that look like they hold identifiers; a column of short comments with a non-obvious header could slip through. The review table shows only text columns, so check the role table.

### 5a. What the fresh-snippet probe found and fixed (v0.2 detector pass)

73 hand-written snippets in the style of Epic scheduling comments, MyChart messages, nursing notes and OCR'd screens (none from the generator's templates) were run one row at a time. The first pass caught 40/73; the fixes below bring it to 71/73 with the synthetic set unchanged (100% recall, 0.0% over-redaction, 4 seeds). The cases are now `test/unit.test.js` ("fresh clinic snippets"), each run as an isolated one-row table so nothing is rescued by another row's census or by propagation.

Fixed, generally (no snippet strings added to the lexicon):

- **`Last, First` with no cue** (the dominant Epic rendering: `Okonkwo, Tobias called…`, `Patient: Haverford, Phineas   MRN …`, `SZCZEPANSKI, EAMONN | 00552211 |`). New structural pass: a comma pair of capitalized, non-clinical words counts as a name when at least two signals agree (lexicon hit, label before, line start, column gap or pipe beside it, identifier/date within four tokens, person-verb after). ALL-CAPS pairs need a structural signal so `NAUSEA, VOMITING` lists stay. `First Last` right before an MRN-like number or a dated DOB (`Mireille Papadakis 00234567 05/09/1955`) is handled by a sibling pass.
- **Leak path in overlap resolution**: an email or URL that contained a census name was dropped in favour of the name span, leaving `.m@gmail.com` in the output. Containing EMAIL/URL/ID/PHONE spans now replace the names inside them; a labelled identifier absorbs a rule-matched MRN inside it (`SN 2201994-B`).
- **OCR-noisy dates and phones** (`11/2O/2026`, `O3/l5/l960`, `7l6 555 0l44`, `716 -555- 0177`): confusable letters are normalized, the whole noisy token is covered, and the date still shifts. Before, `11/2O/2026` was matched as `11/2` and the year survived.
- **Ages**: `91 y.o.` at end of text (the old regex needed a word boundary after the period), written-out ages (`Ninety-two year old`), and a bare number after a person subject (`husband is 95`) with vitals excluded (`HR is 95`, `BP 95/60`, `SpO2 is 95%`).
- **Labelled identifiers** (Safe Harbor 9–13, 18): member/subscriber/policy IDs, confirmation and reference numbers, device serials, licence and plate numbers, study subject IDs, health cards, user names and `@handles`, Medicare Beneficiary Identifiers by shape, labelled initials (`initials P.R.`). User names are replaced wholesale (`user4821`) so no name fragment survives; all are reversible through the mapping key.
- **Bare 6–9 digit integers** in text with no learned MRN pattern (pasted or OCR'd lines) are identifiers.
- **Dates**: `days 1-3`, `weeks 1-2`, `dose 1/2 today, 1/2 tomorrow` are not dates; hyphen `m-d` and small fractions need a date-context word (`seen`, `DOB`, `next cycle`, `labs`, `f/u`…) or a time after. The `m/d` unit lookahead could cross a newline (`12/19\nhome…` read as `12/19 h`); it no longer does.
- **Facilities and places**: `to Pharmacy` / `from Radiology` (generic word alone) are departments, not organizations; `Elderwood at Brookfield SNF` joins over `at` when the word before it is not a person name; `Erie County` is a LOCATION; `Kenmore NY 14217` without a comma; `in East Aurora` / `to North Collins` (directional compound); insurer and employer suffixes (BCBS, Insurance, Inc, LLC); the clinical allowlist gained common abbreviations (PCP, SW, HCP, POA…), generic drug names, pump and pharmacy brands, and status words that start sentences in Title Case.
- **Relation cues**: abbreviations (`dtr`, `dau`, `hus`, `gma`…) and roles (`Contact:`, `caller`, `interpreter`, `clerk`, `driver`). Title-Case profession words in a department list (`Social Work, Dietitian, Chaplain consulted`) are not relation cues.
- **Registry**: hyphenated/married surname halves link only when both records carry the same DOB (`Garcia-Lopez` ↔ `Garcia`, DOB equal); two distinct known first names one letter apart (`Maria` / `Mario`) are two people even with the same surname and DOB.

Still open after this pass (documented, not forced):

- **Organization names made only of generic words** (`Medical Motors`, `General Hospital` alone): no specific token to anchor on. Always-redact list.
- **Bare lowercase user names** with no label or `@` (`route to lyarbrough`): indistinguishable from a typo without a dictionary. Labelled or `@`-prefixed forms are caught.
- **OCR-garbled first names inside the text** (`Gise11e` for Giselle): the registry links the *row* via the MRN, but the garbled token in free text is not matched to the census. A fuzzy census matcher (edit distance 1 on tokens ≥6 letters) is the next step; it must stay row-scoped to avoid eating ordinary words.
- **Out-of-lexicon surname with no cue at all** (`Vanterpool called about labs`): unchanged; gap 1 above.
- **Unlabelled 4–5 digit numbers** (`ID 4471`, room, extension) are left alone on purpose: staff IDs and extensions are not patient identifiers and redacting them would eat chair, room and dose numbers.

### 5b. Red-team pass (v0.3): what three independent reviews found and what changed

Forty invented free-text cells plus a walk through a two-input session found leaks the synthetic set could not see. Fixed generally, each with a unit case:

- **Pasted census lines with common-word surnames** (`Bell, Kevin T  MRN …`, `Hill, Rose  84445786`) were not captured, so the registry held an MRN with no name, the real surname passed through, and the self-check vouched for a name it never saw. A column gap, pipe, identifier or DOB beside the pair now overrides the word lists; a `Last, First MD` on a note line, or a pair preceded by `per`/`Dr.`/`Called`, is a clinician, not a new patient; and a patient with a record number but no legible name turns the verdict red on text and screenshot items.
- **One surrogate allocator per session.** Fake names used to be drawn per input from an 80-name pool with a per-input "taken" set, so a second input re-used the first input's names and a 120-row table ran out of surnames and recycled them across patients, providers and relatives; Restore identities then restored the wrong person. The registry now owns the allocator (patients, providers, third parties, streets, organizations, the words of every document seen), the pools are ~200/~250 names with a deterministic generator past that, providers are stored without their credential, and a saved key seeds everything. Restore is one-to-one; ALL-CAPS cells restore; the credential no longer doubles.
- **Relatives who share the surname** (`daughter Siobhan Fitzgerald-Nowak`, `twin Daniel Schwartz`, `Grandson Omar Haddad-Khalil`) were swallowed into the patient's surrogate and restored as the patient. The census span now carries the patient's own tokens; a span widened with a token that is not the patient's becomes a third party who gets the patient's fake surname with a fresh first name. Hyphenated compounds are taken whole. First names and diminutives alone are row-scoped.
- **Name variants**: each given name of a two-word or three-part name (`Mary Catherine`, `Thi Hong`), diminutives from a nickname table (English, Spanish, Polish, Italian), `K.Y.`, `Sal P.`, `Erik J`, `goes by Majo`; diminutives that are ordinary words (Will, Bill, Pat, Jan) only with the surname.
- **Rules**: `MRN#0041 2345` (labelled numbers split by spaces or hyphens; digits-only census compare), `91yo` (the AGE surrogate used a word boundary that `yo` did not provide), `Zofia, 95,`, `Turned 90`, `97 F`, `lives alone at 412 Delaware`, `Lives 88 Hertel`, `near Brighton Rd`, `Williamsville 14221`, `driver license on file # 123 456 789`, `SSN ending 4471`, `DOB:03041951`, `27-Aug 50` (no longer a year), `pain 6/10` (a score, not a date), `Imam Abdul Karim`, `Masjid An-Noor`, `Case mgr …`, `interpreter ID 4471 (Rosalinda)`, `retired from Moog`, `boss at Sumitomo`, `from Cape Town`.
- **Self-check** is now a different, over-sensitive matcher in core (`selfCheck`): digits only, every name token/diminutive/initial, bare ages, and phone/e-mail/SSN shapes the surrogates never produce. It flags every raw red-team row and nothing in the protected output.
- **UI**: the download button sits in the green verdict; the key button is no longer the most prominent control; "Choose a file" is a button; safety colours meet 4.5:1 in dark and light; the review list flags only word-clue finds (the certain count is shown beside it); a patient's own identifier is locked in the review table; 390px layout works; copy pluralises; the key filename carries the time and a counter that survives a restore.

Left on purpose: `Grey Turner sign` and `Rose geranium` stay clinical even when the patient is Grey or Rose; pharmacy chains (Tops, Walgreens) stay; a two-word given name restores as the first word only (`Mary Catherine` → `Mary`), a surname-first three-part name (`TRAN THI HONG`) restores without its last given name, and `Ben` restores as `Benjamin`; the DOB column is removed and cannot be restored (by design); `May 20th` restored from `December 11th` renders as `Dec` because `May` is both a full and an abbreviated month; a patient literally named Will in a row that says `Will call` is still redacted.

### 5c. Red-team round 1 (r1): blind cases, what changed

A blind red team wrote 24 text, 16 table and 8 screenshot cases (`test/redteam/*/r1-*.json`, scored by the fixed `test/redteam/score.js`). Before: 20 text/table cases and 4 screenshots leaked, 2 screenshots were blocked. After: no leaks, nothing blocked, patient counts right. Fixed generally, each class with a unit test (`r1 …` in `test/unit.test.js`):

- **Column roles**: a bare `Patient`/`Pt` header is the name column; `MR#` is a record number; a date header over mixed renderings (`Tue 11/03`, `2026.11.03`, `November 3rd, 2026`) stays a date column, and a header that promised dates but holds something else goes through the full pipeline instead of being kept; columns under generic headers whose values are phones (7 or 10 digits, any punctuation), e-mails, links, addresses or a relation word beside a name are processed; `Attending Notes` is text, not a provider list.
- **Rules**: PO boxes and rural routes, a house number + street + unit with no suffix (`apt 3C`, `#12B`), the town and ZIP after any address, dotted ISO dates, licence and plate numbers with a state between label and value, `turned 91`, `Grandma is 97`, table ages (`93y M`), 7-digit phones after a contact word.
- **Names with no lexicon hit** (structure, not word lists): particle-joined names (`van der`, `de la`, `bin … al-`), `First Last` at a sentence/label start before a person verb or after a label before a comma, a line-start name before a colon and contact details, sign-offs (`Thank you, X`, `- X`), message senders, companions (`sent home with X Y`), a first name before a surname that is also an eponym when nothing clinical follows. All-caps names after `from` are no longer read as facility acronyms.
- **Propagation**: names in removed contact columns (Emergency Contact, Guarantor) are looked for in the comments; ALL-CAPS names are also looked for in Title Case; a word-name of a full name (`Grace` of `Grace Bishop`) is re-found mid-sentence in the same row only.
- **Text and screenshots**: a name wrapped over three lines of a narrow first column is rebuilt; a record number or birthdate on its own line under a patient whose number was not on the name line is that patient's (no more "name not read"); tiles side by side are paired with the record numbers below them only on an exact count match; label words (`Plan, Member ID`) are never half of a name; every patient the session already knows is looked for in every later input, and earlier inputs are re-protected when the session learns a new patient. OCR misreads of clinical shorthand (`g21 days`, `stage Ill`) are corrected before detection.
- **Places and surrogates**: `in Harlowe Springs`-style towns, `Pell Hollow, OH`; `Castellane W.` is the patient (not a relative) and renders as `Fake F.`; particles stay as written in made-up names.

Left failing: `Oxaliplatin 85 mg/m2` in the narrow-grid screenshot is split by the screen reader across two table lines (`Oxaliplatin 85` / `mg/m2`); rejoining wrapped cell text needs the image layout, not the text. Case correction: `Age 90` in `tbl-very-old-and-deceased` was listed as PHI, but the output `Age 90+` is the Safe Harbor aggregate the project uses everywhere; it moved to `keep` as `Age 90+`.

### 5d. Red-team round 2 (r2): blind cases, what changed

A second blind round (`test/redteam/*/r2-*.json`: 24 text, 16 table, 8 screenshot cases). Before: 19 text/table cases and 4 screenshots leaked. After: no leaks in any round, nothing blocked, patient counts right; the only open item is still r1's `Oxaliplatin 85 mg/m2` split across two OCR lines. Fixed generally, each class with a unit test (`r2 …` in `test/unit.test.js`):

- **Rules**: `d/c 11/21` is a date (the cycle exclusion read the `c` of `d/c` as `C1`); a 10-digit phone before a full stop (`fax#5085550171.`); no phone is read out of a birth year (`10/23/1983 555-0158` used to lose `1983` to a `1 983 555 0158` phone, leaving the month and day); plates with a space (`MCB 4471`), placards and permits; ordinal ages (`101st bday`); compact military dates (`13NOV2026`) and day-first dates when the first field is over 12 (`16/10/2026`), shifted and written back in the same order.
- **Columns**: authorization, serial, plate/vehicle, placard, claim and implant/device-ID headers, and any column whose values are mostly identifier-shaped codes (`SN 2026-CS-448190`, `PA-2026-0091827`, `AMB-0099412`), are removed; lot/NDC/drug columns are not. A merged `Patient / MRN` cell (`KRISTOFFERSEN,ELSA (MRN:2210984)`) is the name column and its record number feeds the census. A value is a date only with a month word (`Chair 4` is not).
- **Census**: another patient's given name in a different row (`same day as Tobias`) is hidden as a third party; word-names (May, Will) stay row-scoped.
- **Pasted text**: a label in front of a surname (`PT HUYNH,THANH LOAN`), an all-caps two-word given name, `Med Rec No. 77120934.` with a sentence-final full stop, `(Park, Ji-hoon)` after `message from`; a street and its town (`52 Birchwood Ln, Tisbury`) is not a patient; a 10-digit fax after its label is not a record number.
- **User names**: unlabelled handles (`jhpark_1951`, `rosie.delgado62`, `From MyChart (x)`) are identifiers, and the name parts of a handle or e-mail are looked for in lower case in the same document (`hi its rosie`); word-names, versions (`v2.1`) and file names stay.
- **Names with no lexicon hit**: dotted initials as a given name after a label (`Pt J.R. Whitcombe-Faraday`, then `J.R.` alone), with consistent fake initials and dotted clinical abbreviations (`I.V.`, `P.O.`, `N.P.O.`) excluded; a credential before a name (`RN Joanne Pruett,`); `Hospice of the Valley`; `Great-granddaughter`/`step-son` as relation cues; a clinical eponym as a given name after `Pt`/an honorific (`Pt Addison Graves, 34F` while `Addison's disease` stays); `Pt X Y aware`/`pt X Y:`; Vietnamese names by family + middle name (`Nguyễn Thị Hồng Nhung`, `TRAN VAN MINH`); a three-word signature; `Preferred: Lally`. The tokenizer now reads accented letters as letters and the name lists are looked up with accents folded.
- **Places**: a town right after a person (`Dr. Tran Van Minh in Pocasset.`) and at the end of a residence sentence (`Lives at Bayview Manor rm 214, Wareham.`); departments and systems (`in Radiology`, `in Epic`) and descriptions (`Lives alone, Independent`) stay.
- **Screenshots**: a given name whose capital I was read as `l` after `Surname, ` (`Ferreira, lolanthe`); a tile whose name wrapped onto the next line beside tiles that were paired with their record numbers is one more patient, with the record number under it.
- **Surrogates**: a made-up phone never contains the digits of a real number in the document (`555-010-2437` spelled out a real `555-0102`), and a made-up name is never one letter away from a real word of the session (`Gwendolen` for a real `Gwendolyn`).

Case correction: `aged 90` and `turns 90` in `tbl2-ages-over-89` were listed as PHI; the output `aged 90+` / `turns 90+` is the Safe Harbor aggregate (the r1 `Age 90` precedent), so they moved to `keep` as the aggregate. `101st` was a real leak and is fixed.

Left open: a lower-case nickname that appears in no handle and is not a known diminutive (`hi its mari` from `Marisol`) is not found; that needs the Tier 1 model.

## 6. Open questions for compliance (send as one email)

1. Is any AI or cloud surface already under a BAA (Azure tenant, M365 Copilot, Epic's own)? If Azure Health De-ID is available inside the tenant, the detection engine is bought, not built, and this tool becomes the census/date-shift/tabular layer around it.
2. Will they accept an expert-determination memo for a tool with measured, documented miss rates, or will they require Safe Harbor? Safe Harbor means dates are removed, not shifted; the tool already has that switch.
3. Under what umbrella (QI or IRB) may two staff members annotate 200–300 rows of real reports on a hospital machine for the gold set?

## 7. Next actions, in order

1. Copy `dist/infusion-deid.html` to the work computer; run it on the synthetic demo to confirm it opens and downloads work under the hospital's browser policy.
2. Send the compliance email above.
3. Run a real schedule export through it. Fix column roles, save them. Note what the detector misses in the first 50 rows; that is the first version of the always-redact list.
4. Gold set with a second annotator (section 4, steps 1–2). Write the scoring script for review exports.
5. Only after the gold number exists: decide between adding the ONNX encoder to the file or standing up the network service, based on what the misses look like and what compliance answered.
