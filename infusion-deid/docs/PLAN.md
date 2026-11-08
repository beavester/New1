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
