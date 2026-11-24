# secret-mask

Replaces secrets with `[MASKED:<label>]` before they are stored. It works in two places:

- **The tool's result** (`tool.call`): the tool's structured record, the copy the transcript keeps as `toolUseResult` (Bash `stdout`/`stderr`, a Read's file text, an MCP result). The engine re-maps the masked record for the model.
- **Every stored row** (`session.append`): tool results, hook context, attachments, deliveries, notes, compaction summaries, notices, `!` command output and the model's own replies.

## Install

```
/plugin install secret-mask --marketplace Ars-Paulina/claude-mods
```

## What it masks

Four layers, in this order (ported from the `secret-mask.js` PostToolUse hook, layers b-d copied verbatim):

1. **Exact values.** sha256 fingerprints that `devrun` writes to `~/.cache/secret-mask/<APP>.json` (`{ "fingerprints": [{ "name", "sha256", "len" }] }`). Any token whose hash matches is masked under its key name. Files are re-read when their modified time changes; a corrupt file is skipped.
2. **Known token shapes.** Private keys, JWTs, `sk-…`, GitHub, Slack, AWS, npm, Vercel, Supabase, Google OAuth, Telegram.
3. **Key-name context.** `NAME=value`, `"name": "value"`, `name: value` where the name looks secret (`*_PASSWORD*`, `*_SECRET`, `*_API_KEY`, …) and the value looks literal.
4. **URL and header passwords.** `scheme://user:PASSWORD@host`, `?password=…`, `Bearer …`.

Strings over 2 MB are withheld whole. Images are left as they are. Inside a tool result, a `document` or `search_result` block that holds a secret is swapped for a one-line text placeholder, because the engine does not keep a changed one.

## Why a mod (the gain over the hook)

The hook sees only `PostToolUse`, so only tool output. The mod also masks `hook-context` (text other hooks inject), `attachment` (files and memory the engine attaches), `delivery`, `note`, `compaction`, `notice`, `tool-message`, `command` (`!` output) and `response`.

## Known gaps

- **`prompt` and `queue` doors are not masked**: that is the person's own typing. `prompt-secret-screen` only warns about it after the fact; it does not mask either.
- **Pinned blocks**: at the top level of a row the engine puts back every block that is not text or a tool_result (thinking, tool_use, a top-level `search_result`), whatever a hook does. A secret there is not masked.
- **Transcript copy not yet checked live.** The `tool.call` rewrite follows the engine's documented contract ("records it in the transcript as the tool's result"). Until a live session shows a masked `toolUseResult` in the `.jsonl`, keep the old hook on (see Cutover).

## Fails closed

If masking throws, the row is still stored, with every rewritable text replaced by `[MASKED: secret-mask failed on this row, content withheld]`, and a tool result is withheld from the model. The first failure shows one toast (`secret-mask failed and is withholding rows`), so a broken mod is visible, not silent. The hook failed open (raw output passed through).

## Settings

- `SECRET_MASK=off` in the environment turns both hooks off.
- `SECRET_MASK_FP_DIR` moves the fingerprint folder.

Not ported: the hook's `~/.claude/logs/secret-mask.log` (mods have no file append), and the `--selftest` CLI / `bin/secret-scrub.js` export (those stay with the hook).

## Cutover

Run the mod **beside** the old hook; do not remove the hook yet. Both together are safe (already-masked text is skipped). Retire the hook only after a live check: run a Bash command that prints a fake `ghp_` token, then look at that call's `toolUseResult` in the session's `.jsonl` with the hook turned off for that one session (`SECRET_MASK` cannot be used for this, since both read it).

## Test

```
claude plugin test plugins/secret-mask
```
