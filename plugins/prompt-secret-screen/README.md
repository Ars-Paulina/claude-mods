# prompt-secret-screen

Masks credential-shaped values in your prompt **before** Claude Code records it. A pasted key becomes `[secret masked: github_pat]` in the conversation row and in what the model reads.

Port of the `UserPromptSubmit` hook `~/.claude/hooks/prompt-secret-screen.js`. That hook could only warn, because it runs after the prompt was written. This mod hooks `prompt.submit`, which runs before the prompt is recorded. So it prevents the leak instead of only containing it: the masked text is what lands in the conversation row, the prompt history file and the model's request (evidence below).

## What it does

- Same credential kinds as the old hook: OpenAI, JWT, Telegram bot, Google OAuth secret, Supabase secret key and PAT, GitHub PAT, AWS key id, Slack token, Postgres URL with a password, hex32/hex64 next to a secret word, and a bare high-entropy paste.
- Some rules differ from the old hook's, because a false positive now rewrites your prompt instead of only warning:
  - **OpenAI key:** the part after `sk-` must hold a digit and an uppercase letter, as random keys do. So `fix/task-queue-retry` and `desk-booking-widget.tsx` are left alone, while glued keys (`OPENAI_API_KEY=sk-…`, `--key-sk-proj-…`) are still caught.
  - **JWT:** `eyJ` must not follow a letter or digit (`ID_TOKEN_eyJ…` is still caught). A short fixed prefix finds a start, then the match runs to the end of the token, so a long header (an x5c certificate chain), payload or signature is masked whole. The scan stays linear. The old regex was quadratic: a 300 KB run of `eyJ` took 28 s, past the hook's 10 s budget.
  - **Hex32/hex64 keyword:** it needs a secret word within 40 characters. The word may be glued to a name before it (`accessToken`, `apiKey`, `SECRETKEY`, `API_KEY`), but may not run on into a lowercase word after it (`keyboard`, `tokenizer`).
  - **Hex32/hex64 in a file path:** a folder name in a file path is not masked, so cache folders survive. The rule only applies when the token really looks like a file path:
    - it starts with `/`, `~/`, `./` or `../`, or holds two or more `/`
    - it is not a URL, so `https://app/api/cron/<hex>` is still masked
    - no secret word sits in it, so `/api/token/<hex>` is still masked

    `KEY=<hex>/` and `token <hex>/<hex>` are still masked.
    A secret word anywhere in the path turns the rule off, so a hex folder under `keys/`, `secrets/` or `tokens/` is masked (`/etc/ssl/keys/<hex>.pem`). The old hook masked these too.
- Once a value is detected, every copy of it in the prompt is masked, including a copy that would not pass a gate on its own.
- Overlapping matches are merged and masked as one span, so no tail of either value is left showing.
- Text over 1,000,000 characters is refused, not scanned. The cap keeps the scan far inside the hook budget: the worst inputs found take under 200 ms at the cap.
  - A prompt that long is **dropped**: it is not sent, stored or shown to the model. The hook answers `{ drop }` with the message "this text is over 1000000 characters, too long to screen for secrets, so it was not sent. Split it, or turn the mod off with /plugin." A slash command with arguments that long does not run, and its output shows that message.
  - **Not verified:** what the person actually sees on screen. Only the hook's answer is tested; per the engine docs, a drop's text is shown to the user as the reason.
- Plain prompt: each match is replaced by `[secret masked: <kind>]`, a toast says how many were masked, and the model gets a short note.
- Slash command: its arguments are masked at `command.run`, before the command runs.
- Hidden prompt that starts its own turn (`isMeta`): the engine allows no rewrite there, so the mod only adds the old warning to the model.
- Every detection appends one redacted line to `~/.claude/logs/prompt-secret-detections.log` (same format as the old hook: kind + sha256[:12], never the value).
- Fails closed: if the screen throws or runs out of time on a plain prompt, the prompt is dropped, not sent raw (tested). If the screen throws on a slash command, the command does not run, except `/plugin`. Its arguments then pass unmasked, so a broken mod can still be turned off.

Kill switches: the `enabled` option (default on), and the old hook's `ECOSYSTEM_SECRET_SCREEN=off`, still honored.

## Limits

- Masking does not make a live key safe: it was still on your clipboard and screen. Rotate it.
- False positives still change your prompt. Known cases:
  - A mixed-case slug with a digit after `sk-` (`risk-Assessment-2024-final`) is taken for an OpenAI key. The old hook did the same.
  - Keywords at the end of other words (`monkey`, `turkey`) still open the hex gate, so a hex near them is masked. The old hook did the same.
  - A prompt that is one token of 20 to 64 characters, mixed letters and digits, with no `/` (a version string such as `release-v2.3.1-build4567-final.tar`), is replaced whole by the standalone rule.
- A hidden prompt that starts its own turn passes unmasked (an engine rule). The model gets a warning instead.
- The log keeps the same sha256[:12] fingerprint as the old hook. For a weak password, someone holding the log could find it with a word list.
- Not caught, besides the cases above:
  - a hex32/hex64 folder name in a file path (on purpose)
  - a JWT glued straight to a letter or digit (`xeyJ…`)
  - an OpenAI-style key with no digit or no uppercase letter after `sk-`
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
node --no-warnings plugins/prompt-secret-screen/scripts/parity.mjs
```

The second command runs the old hook (`~/.claude/hooks/prompt-secret-screen.js`, with `HOME` pointed at a temp folder) and the mod on 49 probes from four reviews. It checks two things: on every probe the mod catches at least what the old hook caught, except the intended false-positive fixes, which are listed with reasons. And no fake secret is left raw after masking. It skips itself when the old hook is not there.
