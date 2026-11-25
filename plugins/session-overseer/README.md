# session-overseer

Log-only collector. It watches the main session and writes one line per signal saying what it
*would* have done (`none`, `warn`, `block`, `handoff`). It takes no action: no messages, no
denials, no prompts, no UI.

## What it logs

| Signal | When | Would |
|---|---|---|
| `claim` | the reply claims done/fixed/passing; in a repo with checks and no check run after the last edit | `block` (code), `warn` (read-only, no cited source), `none` when backed |
| `claim_vs_git` | the claim names files or commits; git (250 ms budget) shows them missing, or shows files this session did not edit | `warn` |
| `loop` | the same failing Bash command 3 times, the same edit 3 times, or an edit back to an earlier state | `warn` |
| `pin_violation` | a tool call breaks a pinned rule in `data/pins.json` | `warn` |
| `compaction` | the context was compacted | `warn` |
| `stale` | a second claim with no evidence in the same session | `handoff` |
| `approval` | the person typed a prompt (pointer only; the text, masked, goes to `approvals/`) | `none` |
| `blind` | the mod cannot see enough: tool calls the mod did not parse, no tested-version stamp, a new Claude Code version, or an internal error | `none` |
| `timing` | every handled event: `ms` spent | `none` |

Each row: `{ts, sid, event, signal, would, detail, ms}`. `detail` holds counts, hashes and
pointers, never transcript text.

## Files

Under `~/.claude/state/overseer/` (dirs 0700, files 0600):

- `log/<session>.jsonl`: the rows above
- `approvals/<session>.jsonl`: approvals, masked by `~/.claude/hooks/secret-mask.js`, max 4 KB each, pruned after 60 days. No masker = nothing stored and a `blind` row.
- `<session>.json`: dot colour (green / yellow / grey), counts, compactions
- `raw/<session>.count`: one byte per tool call, from the classic hook (blind check)
- `tested-version`: written by `scripts/replay.ts --stamp`

## Off switches

- `touch ~/.claude/state/overseer/OFF`: every hook returns at once
- plugin option `enabled: false`: nothing is registered
- `OVERSEER_COMPACTION=0`: no compaction rows

Env overrides: `OVERSEER_STATE_DIR`, `OVERSEER_MASK_JS`, `OVERSEER_CANARY_LOG`. `OVERSEER_CHECKER=1`
marks a checker session (ignored). `OVERSEER_FAILTEST=1` throws inside the wrapper to prove it fails
open (a grey dot and a `blind` row, the session goes on).

## Event map

What each input comes from, checked in a headless spike (`claude -p --plugin-dir`) on 2.1.331.

| Input | Event | Field | Seen |
|---|---|---|---|
| reply text | mod `turn.complete` | `answer` | yes |
| tool call + result | mod `tool.call` | `tool`, `input`, `await next(e)` → `isError`, text `Exit code N` | yes; no exit-code field |
| typed prompt | mod `prompt.submit` | `text`, `isMeta`, `origin.kind` | yes; `task-notification` and `peer` origins are skipped |
| session start | mod `session.start` | `cwd`, `isInteractive` | yes |
| subagent work | mod `tool.call` / `turn.complete` | `agentId` | yes; skipped |
| compaction | classic `SessionStart` command hook, matcher `compact` | `source` | yes (`claude -p --resume <id> "/compact"`) |
| compaction | classic `PostCompact` | | fires; not hooked, so one compaction counts once |
| raw tool count | classic `PostToolUse` command hook | `session_id`, `agent_id` | yes |
| end of turn | classic `Stop` | | in the types only; not used |
| classic hooks from the mod | mod `classic.*` | | skipped by the default plugin security policy, with a visible notice each time, so not used |

## Local scripts (Node 24)

- `node scripts/replay.ts [--stamp]`: replays `test/fixtures/golden-transcript.json`, exit 1 on any diff
- `node scripts/score-fixture.ts <fixture.jsonl> [--split holdout] [--gate 0.9]`: claim-detector accuracy with 90% intervals
- `node scripts/replay-history.ts <labels.csv> --out <dir>` then `node scripts/score-replay.ts --labels <labels.csv> --replay <dir>`: replays past sessions through the masking transcript reader (`FSEARCH_BIN`) and scores them. The reader has no exit codes, cwd or timestamps, so `claim_vs_git`, `compaction` and `blind` cannot be replayed.

Tests: `claude plugin test plugins/session-overseer` and `node --test 'plugins/session-overseer/scripts/*.test.cjs'`.
