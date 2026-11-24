# prompt-secret-screen

Masks credential-shaped values in your prompt **before** Claude Code records it. A pasted key becomes `[secret masked: github_pat]` in the conversation row and in what the model reads.

Port of the `UserPromptSubmit` hook `~/.claude/hooks/prompt-secret-screen.js`. That hook could only warn, because it runs after the prompt was written. This mod hooks `prompt.submit`, which runs before the prompt is recorded. So it prevents the leak instead of only containing it: the masked text is what lands in the conversation row, the prompt history file and the model's request (evidence below).

## What it does

- Same credential kinds as the old hook: OpenAI, JWT, Telegram bot, Google OAuth secret, Supabase secret key and PAT, GitHub PAT, AWS key id, Slack token, Postgres URL with a password, hex32/hex64 next to a secret word, and a bare high-entropy paste.
- Three rules are tighter than the old hook's, because a false positive now rewrites your prompt instead of only warning:
  - `sk-` and `eyJ` must not follow a letter, digit, `_` or `-`. So `fix/task-queue-retry` and `desk-booking-widget.tsx` are left alone. This also makes the JWT regex linear: a 300 KB run of `eyJ` took 28 s with the old regex.
  - Hex32/hex64 needs a secret word as a whole word (`token`, `API_KEY`, not `keyboard`) within 40 characters.
  - Hex32/hex64 is never masked as a path segment (a `/` right before or after it), so cache folder names in paths survive.
- Overlapping matches are merged and masked as one span, so no tail of either value is left showing.
- Plain prompt: each match is replaced by `[secret masked: <kind>]`, a toast says how many were masked, and the model gets a short note.
- Slash command: its arguments are masked at `command.run`, before the command runs.
- Hidden prompt that starts its own turn (`isMeta`): the engine allows no rewrite there, so the mod only adds the old warning to the model.
- Every detection appends one redacted line to `~/.claude/logs/prompt-secret-detections.log` (same format as the old hook: kind + sha256[:12], never the value).
- Fails closed: if the screen throws on a plain prompt, the prompt is dropped, not sent raw (tested). If the screen throws on a slash command, the command does not run, except `/plugin`. Its arguments then pass unmasked, so a broken mod can still be turned off.

Kill switches: the `enabled` option (default on), and the old hook's `ECOSYSTEM_SECRET_SCREEN=off`, still honored.

## Limits

- Masking does not make a live key safe: it was still on your clipboard and screen. Rotate it.
- False positives still change your prompt. One known case is left: a prompt that is one token of 20 to 64 characters, mixed letters and digits, with no `/` (a version string such as `release-v2.3.1-build4567-final.tar`), is replaced whole by the standalone rule.
- A hidden prompt that starts its own turn passes unmasked (an engine rule). The model gets a warning instead.
- The log keeps the same sha256[:12] fingerprint as the old hook. For a weak password, someone holding the log could find it with a word list.
- Not caught, same as the old hook: zero-width or full-width characters inside a token, URL-encoded Postgres URLs, and a Postgres password that contains `@` or `/`.

## Evidence: is the history file masked?

Yes. I checked on Claude Code 2.1.331 on 2026-11-24, in an isolated live session: `CLAUDE_CONFIG_DIR` and `HOME` pointed at a scratch folder, `claude --plugin-dir plugins/prompt-secret-screen`, run in tmux, not logged in, so no model call was made. I typed a fake 40-character `ghp_` token into the prompt box. Then:

- `history.jsonl` (the up-arrow history) held `"display":"reply only ok. probe [secret masked: github_pat] end"`: 0 raw hits, 1 masked hit.
- The session transcript under `projects/`: 0 raw hits, 1 masked hit.
- `grep` for the raw token across the whole scratch config and home: no file.
- `~/.claude/logs/prompt-secret-detections.log` (in the scratch home) held one real line, `DETECT github_pat:<12 hex> session=<id>`. So the real `$.fs` write works.

So the old hook's note ("history is written before UserPromptSubmit") is true for settings hooks only. The mod's `prompt.submit` runs before that write. This was checked on one version; recheck after a big Claude Code update.

## Test

```
claude plugin test plugins/prompt-secret-screen
```
