#!/usr/bin/env bash
# Rebuild all M0 prep data (m0-prep/data/, gitignored). Usage: build_all.sh [--remine]
# The hand-reviewed picks (data/claim-picks.json, data/approval-picks.json) are kept unless --remine,
# because mining draws new random candidates and the picks are review decisions.
set -euo pipefail
cd "$(dirname "$0")"
python3 01_sample.py
python3 02_sheet.py
if [[ "${1:-}" == "--remine" || ! -f ../data/claim-picks.json ]]; then
  python3 03a_claim_candidates.py; python3 04a_approval_candidates.py
  echo "candidates mined: write data/claim-picks.json + data/approval-picks.json (see README), then rerun" >&2
  [[ -f ../data/claim-picks.json ]] || exit 3
fi
python3 03b_claim_fixture.py
python3 04b_approval_fixture.py
python3 05_canary_sample.py
python3 selfcheck.py
