# secret-mask

Replaces secrets with `[MASKED:<label>]` in every row the conversation keeps that nobody typed: tool results, hook context, attachments, deliveries, notes, compaction summaries and notices. The model and the transcript file only ever see the masked text.

## Install

```
/plugin install secret-mask --marketplace Ars-Paulina/claude-mods
```

## What it masks

Four layers, in this order (ported from the `secret-mask.js` PostToolUse hook, layers b-d copied verbatim):

1. **Exact values.** sha256 fingerprints that `devrun` writes to `~/.cache/secret-mask/<APP>.json` (`{ "fingerprints": [{ "name", "sha256", "len" }] }`). Any token whose hash matches is masked under its key name.
2. **Known token shapes.** Private keys, JWTs, `sk-…`, GitHub, Slack, AWS, npm, Vercel, Supabase, Google OAuth, Telegram.
3. **Key-name context.** `NAME=value`, `"name": "value"`, `name: value` where the name looks secret (`*_PASSWORD*`, `*_SECRET`, `*_API_KEY`, …) and the value looks literal.
4. **URL and header passwords.** `scheme://user:PASSWORD@host`, `?password=…`, `Bearer …`.

Strings over 2 MB are withheld whole. Image and document blocks are left as they are.

## Why a mod (the gain over the hook)

The hook sees only `PostToolUse`, so only tool output. The mod hooks `session.append`, which every stored row passes through, so it also masks:

- `hook-context`: text other hooks inject (a hook that cats a log with a token in it)
- `attachment`: files and memory the engine attaches beside the conversation
- `delivery`, `note`, `compaction`, `notice`, `tool-message`

Left alone: `prompt`, `command` and `queue` (the person's own typing; `prompt-secret-screen` warns about that) and `response` (the model's own words, built from rows already masked).

## Fails closed

If masking throws, the `.catch` handler stores the row with every text replaced by `[MASKED: secret-mask failed on this row, content withheld]`. The hook failed open (raw output passed through).

## Settings

- `SECRET_MASK=off` in the environment turns it off.
- `SECRET_MASK_FP_DIR` moves the fingerprint folder.

Not ported: the hook's `~/.claude/logs/secret-mask.log` (mods have no file append), and the `--selftest` CLI / `bin/secret-scrub.js` export (those stay with the hook).

## Test

```
claude plugin test plugins/secret-mask
```
