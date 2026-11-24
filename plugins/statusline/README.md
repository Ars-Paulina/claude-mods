# statusline

Two rows above the prompt: context fill, 5h and 7d limits, last prompt/answer times, then model, session, folder, branch, turn count. Optionally writes a per-session snapshot file (`<session id>.json`) every 30 seconds and after each turn, for other tools to read.

Ported from a `statusLine` command (a Node renderer wrapped by a Python capture script). Same layout and the same snapshot keys (`session_id`, `rendered`, `payload`, `captured_at`), so a reader that matches `Ctx … N%` in `rendered` keeps working.

## Install

```
/plugin install statusline --marketplace Ars-Paulina/claude-mods
```

Settings: **Show the status rows** (kill switch) and **Snapshot folder** (empty = no snapshot file).

## Gain over the command

- No process per render: the command spawned node + python on every redraw. The mod reads `$.session.usage()` in-process.
- Rows stack with other bands (pendings-band, flow-board) instead of living in a separate line.
- Snapshot written on a timer and per turn, not per keystroke redraw.

## Not ported (no `$` source, honest gaps)

- **Effort level (`E:high`)**: no `$` noun returns the session's effort; only classic command hooks see it.
- **Transcript path row, graft node count, project colour tint / money-repo warning**: left out of v0.1.
- **Side effects of the old renderer**: it also wrote `~/.claude/cache/rate-limits/<sid>.json` (read by the claude-run supervisor), `/tmp/claude-ctx-<sid>.json` (read by gsd-context-monitor) and kicked off a usage-cache refresh. This mod does not. Keep the `statusLine` command until those readers move.
- **Branch in a git worktree**: `.git` is a file there, so the branch is blank (`ponytail:` note in `band.tsx`).
- Turn timing: "▲" is derived from the previous turn's duration, not the exact prompt time.

## Test

```
node plugins/statusline/hooks/format.test.mjs
```

Covers the pure text builders (bars, limits, rows, snapshot shape, the `Ctx N%` regex a reader uses, branch parsing). The engine wiring (`band.tsx`) is checked by `claude plugin validate`, not by a runtime test.
