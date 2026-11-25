#!/usr/bin/env bash
# Rebuild all M0 prep data (m0-prep/data/, gitignored). Usage: build_all.sh [--remine] [--resample]
# sessions.json, claimed-vs-git.csv and canary-sample.csv are WRITE-ONCE: a plain rerun keeps them, so
# Pedro's labels never move. --resample picks a new sample (and rebuilds the sheet; refuses if labeled).
# The hand-reviewed picks (data/claim-picks.json, data/approval-picks.json) are kept unless --remine,
# because mining draws new random candidates and the picks are review decisions.
set -euo pipefail
cd "$(dirname "$0")"
RS=(); [[ "${*}" == *--resample* ]] && RS=(--resample)
python3 01_sample.py "${RS[@]}"
python3 02_sheet.py ${RS[@]+--regen}
if [[ "${1:-}" == "--remine" || ! -f ../data/claim-picks.json ]]; then
  python3 03a_claim_candidates.py; python3 04a_approval_candidates.py
  echo "candidates mined: write data/claim-picks.json + data/approval-picks.json (see README), then rerun" >&2
  [[ -f ../data/claim-picks.json ]] || exit 3
fi
python3 03b_claim_fixture.py
python3 04b_approval_fixture.py
python3 05_canary_sample.py
python3 selfcheck.py --no-rerun
