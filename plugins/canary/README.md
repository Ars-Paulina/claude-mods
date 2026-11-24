# canary

A context-rot heartbeat. Claude is asked to end every prose reply with a secret footer like `⟦9F3A:417⟧`. The mod scores each reply; when Claude keeps dropping or garbling the footer, early instructions are probably fading, and you get a warning to checkpoint (`/progress-report`, then `/compact`).

Port of the `canary-plant.js` (SessionStart) + `canary-check.js` (UserPromptSubmit + Stop) hooks. Same `⟦TOKEN:VALUE⟧` footer contract: 4 hex-digit token, 3-digit value.

## What it does

- **Plant** (`prompt.compose`): adds a `canary:directive` section to the system prompt with this session's pair. The pair is random per session and kept in the plugin store under `canary:<session id>`, so resume, compact and clear reuse it and the token never rotates.
- **Check** (`turn.complete`): scores the reply the turn just produced:

| Reply ends with | Result | Counts as |
|---|---|---|
| current pair | HEALTHY | healthy |
| current token, wrong value | CONFABULATION | miss |
| footer shape, unknown token | WRONG-TOKEN | miss |
| no footer, substantive prose | DECAY | miss |
| no footer, under `minProse` chars of prose (code blocks removed) | SKIP | not scored |

  The footer must be the last non-whitespace of the reply, so a mention mid-reply is not healthy. Subagent turns, interrupted turns, refusals and API errors are not scored.
- **Alert**: a sliding window of the last `window` (10) scored replies. When the window is full and at least `missRate` (0.8) of it missed, the mod alerts once: a toast, a log line, and a `canary:alert` section in the system prompt until the next main-loop turn ends, telling Claude to surface it and recommend `/progress-report`. It never runs anything itself. It re-arms when the rate drops below the threshold.
- **Cleanup**: store entries of other sessions untouched for 14 days are deleted at session start.
- **Fail-open**: any error skips the hook and the chain goes on. It never blocks a prompt or a turn.

## What the mod gains over the hooks

Weak candidate: the behavior is the same, the gains are small but real.

1. **No transcript parsing.** The hook re-reads the whole session `.jsonl` on every prompt and every Stop to find the last main-thread reply. The mod gets the reply as `turn.complete`'s `answer`, and subagent turns by `agentId`. Gone with it: the `lastUuid` dedupe between Stop and the next UserPromptSubmit, and the `plantedAt` timestamp guard.
2. **Interrupted and failed turns are skipped.** The hook scored an interrupted reply as DECAY. The mod checks `reason === 'answer'`.
3. **No directive stacking.** The hook adds a new `[CANARY]` context block on every SessionStart (startup, resume, compact, clear); the "supersedes earlier" wording and the transcript-adopt step exist because of that. The mod's directive is one system-prompt section, rebuilt each request.
4. **Unreadable store still plants.** If the store read throws, a fresh pair is planted, as the hook planted when its state file failed.
5. **Store, not cache files.** State is in the plugin store instead of `~/.claude/cache/canary-*.json`, and the sweep needs no 2000-file cap.

What it loses or changes:

- **No sound.** `$.audio.play` plays nothing in a Linux terminal (the types say so), so the `paplay` chime became a toast. `CANARY_ALERT_SOUND` / `CANARY_NO_SOUND` are gone.
- **No adopt-from-transcript, no rotation grace.** The mod never rotates a pair, so the hook's STALE-HEALTHY grace (echo of the previous pair) is gone. A session that comes back under a new session id, or a session started under the old hook and resumed under the mod, gets a new pair; its transcript still holds the old `[CANARY]` block, and echoes of that old pair score WRONG-TOKEN. Start fresh sessions after cutover.
- **Log** goes to `$.ui.log` instead of `~/.claude/logs/canary-check.log`.
- **Subagent prompts.** The mod skips `prompt.compose` renders with the `teammate` trait. The types don't say whether other subagent system prompts fire `prompt.compose`; if they do, subagents also see the directive (harmless, their turns are never scored).

## Options

Set in `/plugin` (the hook's env vars become these):

| Option | Default | Hook env var |
|---|---|---|
| `enabled` | `true` | `CANARY_ENABLED` |
| `window` | `10` | `CANARY_WINDOW` |
| `missRate` | `0.8` | `CANARY_MISS_RATE` |
| `minProse` | `40` | `CANARY_MIN_PROSE_CHARS` |

Bad values fall back to the defaults.

## Install

```
/plugin install canary --marketplace Ars-Paulina/claude-mods
```

Do not run it next to the old hooks: both would plant a directive with different pairs.

## Self-check

```bash
claude plugin test plugins/canary
```
