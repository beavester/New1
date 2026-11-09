# Place data for the place-name detector

Compiled into `src/places.js` by `tools/build-places.js` (three Bloom filters: place names, "name|state" pairs, and the names of the 1,000 largest cities).
None of this is patient data. The raw files are kept here so the build is reproducible.

| File | What | Origin and licence |
| --- | --- | --- |
| `us_cities.csv` | 29,880 US cities, towns, villages and post-office places with state and county (18,720 distinct names, 50 states + DC + PR) | `kelvins/US-Cities-Database`, file `csv/us_cities.csv`, MIT (licence in `US-CITIES-DATABASE-LICENSE`). Fetched from `https://raw.githubusercontent.com/kelvins/US-Cities-Database/main/csv/us_cities.csv` at commit `ab0961970d41f43f731314ef6f91e36606aafaac`. sha256 `5d048592002dc4d6f4f6d3c4b8130251a00b25d2c49426bb095e3862dc5bdf55` |
| `us-cities-top-1k.csv` | The 1,000 most populous US cities with state | `plotly/datasets`, file `us-cities-top-1k.csv`, MIT (licence in `PLOTLY-DATASETS-LICENSE`). Fetched from `https://raw.githubusercontent.com/plotly/datasets/master/us-cities-top-1k.csv` at commit `0c447c47b757ad74edecab31f0d72f849d2e67c2`. sha256 `09d64b5af1bab9fda314f368baf0e9097ad901983c8b129371e0c47d8dd43fb1` |

Why two lists: the first is built from postal place names, so large suburbs without a post office of their own
(Hoover AL, Wauwatosa WI, Tigard OR) are missing; it covers 952 of the 1,000 largest cities. The second adds those.
Together: 18,926 normalised names and 30,081 name-and-state pairs.

Normalisation (the same at build time and at lookup): lower case; `St`/`Ft`/`Mt` spelled out; hyphens become spaces;
periods and apostrophes dropped; "Mc Kinney" is also stored as "McKinney".

To refresh: download the two files from the URLs above into this directory, then run `node tools/build-places.js`.
Not used: `grammakov/USA-cities-and-states` (63k rows, no licence file).
