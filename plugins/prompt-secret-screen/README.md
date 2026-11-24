# prompt-secret-screen

Masks credential-shaped values in your prompt **before** Claude Code records it. A pasted key becomes `[secret masked: github_pat]` in the conversation row and in what the model reads.

Port of the `UserPromptSubmit` hook `~/.claude/hooks/prompt-secret-screen.js`. That hook could only warn, because it runs after the prompt was written. This mod hooks `prompt.submit`, which runs before the prompt is recorded. So for the conversation row and the model it prevents the leak instead of only containing it (the up-arrow history file: see Limits).

## What it does

- Same detection as the old hook: OpenAI, JWT, Telegram bot, Google OAuth secret, Supabase secret key and PAT, GitHub PAT, AWS key id, Slack token, Postgres URL with a password, hex32/hex64 next to a secret word, and a bare high-entropy paste.
- Plain prompt: each match is replaced by `[secret masked: <kind>]`, a toast says how many were masked, and the model gets a short note.
- Slash command: its arguments are masked at `command.run`, before the command runs.
- Hidden prompt that starts its own turn (`isMeta`): the engine allows no rewrite there, so the mod only adds the old warning to the model.
- Every detection appends one redacted line to `~/.claude/logs/prompt-secret-detections.log` (same format as the old hook: kind + sha256[:12], never the value).
- Fails closed: if the screen throws on a plain prompt, the prompt is dropped, not sent raw (tested). Commands still run, so `/plugin` can turn the mod off.

Kill switches: the `enabled` option (default on), and the old hook's `ECOSYSTEM_SECRET_SCREEN=off`, still honored.

## Limits

- Masking does not make a live key safe: it was still on your clipboard and screen. Rotate it.
- False positives now change your prompt; under the old hook they only caused a warning. Detection is kept the same as the hook on purpose. Two known cases:
  - A prompt that is one token of 20 to 64 characters with mixed letters and digits (a hyphenated file name, a version string) can be replaced whole by the standalone rule.
  - The hex rule fires when a secret word appears anywhere in the prompt, even inside another word (`key` in "keyboard"), so a pasted checksum next to it gets masked.
- The docs say a `prompt.submit` rewrite lands in the conversation row and the queue record. They do not say whether the up-arrow history file (`~/.claude/history.jsonl`) gets the masked text. Not verified yet: check it once by hand after cutover (see the PR).
- The log write to `~/.claude/logs` was tested against a mocked file system only; the real write is not verified yet.

## Test

```
claude plugin test plugins/prompt-secret-screen
```
