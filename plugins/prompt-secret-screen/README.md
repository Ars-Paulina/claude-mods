# prompt-secret-screen

Masks credential-shaped values in your prompt **before** Claude Code stores or sends it. A pasted key becomes `[secret masked: github_pat]` in the conversation row and in what the model reads.

Port of the `UserPromptSubmit` hook `~/.claude/hooks/prompt-secret-screen.js`. That hook could only warn, because it runs after the prompt was written. This mod hooks `prompt.submit`, which runs before the prompt is recorded. So it prevents the leak instead of only containing it.

## What it does

- Same detection as the old hook: OpenAI, JWT, Telegram bot, Google OAuth secret, Supabase secret key and PAT, GitHub PAT, AWS key id, Slack token, Postgres URL with a password, hex32/hex64 next to a secret word, and a bare high-entropy paste.
- Plain prompt: each match is replaced by `[secret masked: <kind>]`, a toast says how many were masked, and the model gets a short note.
- Slash command: its arguments are masked at `command.run`, before the command runs.
- Hidden prompt that starts its own turn (`isMeta`): the engine allows no rewrite there, so the mod only adds the old warning to the model.
- Every detection appends one redacted line to `~/.claude/logs/prompt-secret-detections.log` (same format as the old hook: kind + sha256[:12], never the value).
- Fails closed: if the screen throws on a plain prompt, the prompt is dropped, not sent raw. Commands still run, so `/plugin` can turn the mod off.

Kill switch: the `enabled` option (default on), replacing `ECOSYSTEM_SECRET_SCREEN=off`.

## Limits

- Masking does not make a live key safe: it was still on your clipboard and screen. Rotate it.
- The docs say a `prompt.submit` rewrite lands in the conversation row and the queue record. They do not say whether the up-arrow history file (`~/.claude/history.jsonl`) gets the masked text. Check this once by hand after cutover (see the PR).

## Test

```
claude plugin test plugins/prompt-secret-screen
```
