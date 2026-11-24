# statusline

Rows above the prompt, same layout as the old `statusLine` command:

1. project name (bold, project colour, red `⚠` on money repos) · context fill · 5h and 7d limits · last prompt/answer times
2. model · session · folder · branch (`*` when dirty) · turn count, tinted in the project colour
3. transcript path
4. graft nodes/edges and freshness

It also writes the files other tools read from the old status line, so it can replace the command.

## Install

```
/plugin install statusline --marketplace Ars-Paulina/claude-mods
```

Settings (all have working defaults for `~/.claude`):

| Setting | Default | What |
| -- | -- | -- |
| Show the status rows | on | Kill switch: off draws and writes nothing |
| Claude config folder | `~/.claude` | Where the caches, refresh script and `config/project-colors.json` are |
| Snapshot folder | `~/.claude/hermes/statusline` | `<session>.json` for the hermes digest (same keys as before). Empty = off |
| Write the files the old status line wrote | on | The two files and the refresh below |

## Files written (same paths and keys as the old renderer)

Every 30 seconds and after each turn, interactive sessions only (a `claude -p` run writes nothing):

- `<snapshot folder>/<session>.json`: `session_id`, `rendered` (still contains `Ctx N%` for the hermes regex), `payload`, `captured_at`.
- `<config>/cache/rate-limits/<session>.json`: `written_at`, `session_id`, `cwd`, `transcript`, `five_hour`, `seven_day` (`used_percentage`, `resets_at` in epoch seconds). Read by the claude-run auto-resume supervisor. Only written when the session has a limit window.
- `/tmp/claude-ctx-<session>.json`: `session_id`, `remaining_percentage`, `used_pct`, `timestamp` (seconds). Read by the gsd context monitor, which ignores it when over 60 seconds old.
- Runs `<config>/hooks/statusline-refresh.js` (git dirty flag, turn clock) through `$.process.run`, at most every 2 minutes, using the old lock and cache-age guards.

## Gain over the command

- No node + python process per redraw: figures come from `$.session.usage()` in-process.
- Branch works in git worktrees (follows the `.git` file); the old command showed the folder name there.
- Rows stack with other bands (pendings-band, flow-board).

## Not ported

- **Effort level (`E:high`)**: no `$` call returns the session's current effort (only classic command hooks get it on stdin).
- **Exact turn clock**: `▲ ▼` times come from the refresh script's cache, not the status line payload; right after a restart they fall back to the last turn's duration.
- **Usage-cache refresh is not detached**: `$.process.run` waits for the child (a few hundred ms, in a timer, off the draw path).
- **Graft**: reads graft's `graft/.cache/stats.json`; when graft only built `wiring.json` the segment is empty (the old one recomputed from it). `GRAFT_DIR` overrides are not followed.
- Files are written with `$.fs.write`, which is not atomic (no rename); a reader can catch a half-written file for a moment.
- No `project-colors.json` = palette colour and no money warning.

## Test

```
claude plugin test plugins/statusline
```

Pure functions (`format.test.ts`, `identity.test.ts`: rows, file shapes, POSIX `cksum` palette, worktree branch, colour rules) and the engine (`register.test.tsx`: draws the rows, writes each file with the old keys, worktree branch, kill switch, headless).
