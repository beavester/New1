#!/usr/bin/env bash
# Download the public name lists used to build src/biglex.js. See vendor/names/README.md for provenance.
set -euo pipefail
cd "$(dirname "$0")/../vendor/names"
get() { curl -sS -L --fail -o "$2" "$1"; echo "fetched $2 ($(wc -l < "$2") lines)"; }
get https://raw.githubusercontent.com/fivethirtyeight/data/master/most-common-name/surnames.csv surnames.csv
get https://raw.githubusercontent.com/hadley/data-baby-names/master/baby-names.csv baby-names.csv
get "https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/first%20names/all.txt" first-all.txt
get https://raw.githubusercontent.com/smashew/NameDatabases/master/NamesDatabases/surnames/us.txt surnames-us.txt
get https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt english-20k.txt
echo "now run: node tools/build-lexicon.js"
