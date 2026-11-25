# M0 prep: answer key + fixtures for session-overseer

Prep for milestone M0 (PM §5). Everything here is built by the scripts in `scripts/`; **Pedro only labels**.

## Public-repo rule (read first)
This repo is public. The real data (session ids, project folders, masked excerpts of Pedro's prompts and
Claude's replies) is written to `m0-prep/data/`, which is **gitignored and never pushed** (FR-21).
Committed: scripts, this README, `duty-table.json`. Rebuild the data with `scripts/build_all.sh`.

## What is in `data/` (local)
| File | What | Pedro step |
|---|---|---|
| `sessions.json` | the 40 sampled sessions: stratum, project folder, canary counts (pointers only) | - |
| `claimed-vs-git.csv` | one row per session: what it claimed vs what git shows | fill `label` (ok / false done / loop / stale), `old_hook_false_positive`, `pedro_notes` |
| `sheet-view.md` | reading aid with masked last-claim excerpts | read only |
| `claim-fixture.json` | 31 positive + 38 negative done-claim replies (FR-1 / C-2) | optional spot-check of `label` |
| `approval-fixture.json` | 23 cases: 12 approvals, 11 not (FR-14 / C-8) | optional spot-check |
| `canary-sample.csv` | 20 of 235 canary ALERT events (gap G1-2) | fill `label` (real-stale / false-alarm / unclear) |

`duty-table.json` (committed): PRD §7 duty table as data. Copied from the PRD, not re-verified in M0 prep.

## Sample strata (C-1)
Seeded (`SEED=20261124`), <=3 sessions per project folder per stratum, one session in one stratum,
transcripts 40 KB..4 MB, 3 h..150 days old, scratch `~` sessions excluded.
- **A canary-fired (15)**: has >=1 ALERT line in `canary-check.log` (88 eligible). Why: the positives the old hook claims.
- **B canary-silent (15)**: canary watched it (>=3 log lines) but never alerted (392 eligible). Why: false negatives + healthy control.
- **C git-heavy + done claims (10)**: best of a 1200-session random pool, scored by successful `git commit` calls x done-claim replies. Why: the false-done class lives here.
Shows up as stratum in `sessions.json` and the sheet. "Fired" is defined by the canary log, not by labels.

## Sheet notes
- `git_window_*` = commits on any ref between the transcript's birth time and last write (+2 min) in the
  repo decoded from the project folder. 25 of 40 sessions have a resolvable git repo; the rest (retired or
  non-git folders) have blank git columns. Git proves a change exists, not who made it (FR-2): read
  `shas_in_output` + `view_cmd` for authorship.
- `hint_*` columns are machine hints, not labels; they are noisy on purpose (error on the side of flagging).
- 19 of 40 sessions have a repeated-command hint, 15 have >=1 compaction: enough to hope for >=5 per class, **unknown until labels exist**; a class under 5 is reported "insufficient data" (PM M0).
- Transcripts are read only through `~/.claude/bin/fsearch`; the sheet stores pointers + keywords, not excerpts.

## Fixture notes
- Claim fixture = turn-final assistant replies (what Stop sees as `last_assistant_message`). `pos` = asserts
  done/fixed/tested/pushed; `neg` = question, in-progress, blocked/failed, info, side-task JSON. Hard cases are
  tagged (`ends_with_question`, `claim_word_but_neg`, ...). Text is head+tail 300 chars, masked.
- **Labels in both fixtures were set by a Claude review pass, not by Pedro** (`labeled_by` field).
- Approval fixture applies the FR-14 rule: action + target, or a bare yes/ok/go bound to the question directly before; else not an approval.

## Write-once rule (labels are safe)
`sessions.json`, `claimed-vs-git.csv` and `canary-sample.csv` are never rebuilt by a plain rerun. `--resample` /
`--regen` rebuild them but refuse over any file holding Pedro's labels (`--discard-labels` destroys them).
`sessions.json` records `cutoff_epoch`; the sampler uses it instead of "now", so `01_sample.py --resample --cutoff <epoch>` reproduces it.
First-run drift came from: age filters on the live clock, new sessions entering the pools, unsorted glob order feeding the shuffle, and the canary log growing.

## Rebuild / check
```
m0-prep/scripts/build_all.sh            # sample, sheet, fixtures, canary sample, self-check (~4 min)
python3 m0-prep/scripts/selfcheck.py    # asserts counts; exit 0 = pass
```
Mining (`03a`, `04a`) is only rerun with `--remine`; the review decisions live in `data/*-picks.json`.

## Waits for plan
1. Final home of `m0-prep/` (plan worker may move it) and a private place for `data/` if it should survive outside this machine.
2. Whether the real fixtures may ever be committed (needs a private repo or fully synthetic text).
3. Who confirms the fixture labels (mine) before M1 scores the detector on them.
4. FR-1 phrase list itself: not frozen here; `CLAIM_RE` in `common.py` is only a mining aid.
5. Old-hook false positives: one blank column added (`old_hook_false_positive`); plan decides if it needs its own protocol.
6. Per-class >=5 positives: cannot be checked before Pedro labels; if a class is short, the plan decides whether to widen the sample.
