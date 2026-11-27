# secret-mask

Replaces secrets with `[MASKED:<label>]` before they are stored. It works in two places:

- **The tool's result** (`tool.call`): the tool's structured record, the copy the transcript keeps as `toolUseResult` (Bash `stdout`/`stderr`, a Read's file text, an MCP result). The engine re-maps the masked record for the model. An errored call (non-zero exit, a failed `psql` printing a DSN) is answered with its masked error text, so the model still reads the error. Both the error text and the stored error result are scanned (a non-string result, such as blocks or an object, is masked deep and sent as JSON), and the longer masked one is sent.
- **Every stored row** (`session.append`): tool results, hook context, attachments, deliveries, notes, compaction summaries, notices, `!` command output and the model's own replies. Not true on a machine with a managed-settings file: see Known gaps.

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

Strings over 2 MB are withheld whole. Images and any `base64` field whose value looks like file bytes (256+ characters of standard or URL-safe base64, no spaces: a Read of a PDF or its pages) are left as they are; text or a lone token under a `base64` key is still scanned, so the bytes are never corrupted. Inside a tool result, a `document` or `search_result` block that holds a secret is swapped for a one-line text placeholder, because the engine does not keep a changed one.

## Why a mod (the gain over the hook)

The hook sees only `PostToolUse`, so only tool output. The mod also masks `hook-context` (text other hooks inject), `attachment` (files and memory the engine attaches), `delivery`, `note`, `compaction`, `notice`, `tool-message`, `command` (`!` output) and `response`.

## Known gaps

- **Managed-settings machines**: if `/etc/claude-code/managed-settings.json` (or another managed-settings file) exists, Claude Code seats the built-in `cc-plugin-sec-default` plugin outermost, and it sends some `session.append` events past every installed mod. Hook context, hook messages, engine attachments and the compaction summary then reach the model and the transcript unmasked, and Claude Code prints "its session.append hook was skipped" once per session. Setting `cc-plugin-sec-default@builtin` to `false` does not undo it (tested on 2.1.332). Cover the gap by masking in the hook's own output, or by scrubbing the transcript when the session ends. Tool results (`tool.call`) are not affected.
- **`prompt` and `queue` doors are not masked**: that is the person's own typing. `prompt-secret-screen` only warns about it after the fact; it does not mask either.
- **Pinned blocks**: at the top level of a row the engine puts back every block that is not text or a tool_result (thinking, tool_use, a top-level `search_result`), whatever a hook does. A secret there, such as one in the model's thinking, is not masked.
- **Base64 is not scanned**: a secret inside a PDF's bytes is not masked (scanning would corrupt the file).
- When a result was masked, the hook answers with its own `{ result }`, so core re-maps it and the answer has no `isReadOnly` for later hooks. Nothing in this setup reads `isReadOnly`.

## Live check (2026-11-24, commit `ef59205`)

Headless sessions with only the mod, run on commit `ef59205` (`claude -p --setting-sources project --plugin-dir plugins/secret-mask --model haiku --allowedTools Bash`). The user settings, and so the old hook, were not loaded. The model ran `python3 -c "print('ghp_'+'a'*36)"`, so the fake token appears only in the tool's output, never in the prompt. The third run adds `; false`, so the command fails and its output takes the errored path.

| Session | Mod | Command | Raw fake token lines in `.jsonl` | `[MASKED:github_token]` lines | `toolUseResult` |
|---|---|---|---|---|---|
| `0bb828bb` | on | succeeds | 0 | 1 | `stdout`: `[MASKED:github_token]` |
| `79e2c731` (control) | `SECRET_MASK=off` | succeeds | 1 | 0 | `stdout`: raw token |
| `587bb49b` | on | fails (`; false`) | 0 | 1 | `Error: Exit code 1\n[MASKED:github_token]` |

Old hook absent from the masked runs: none of the 3 `.jsonl` files holds the old hook's notice (`secret-mask: <number> secret value(s)…`, always with a count). The two `secret value(s)` lines in `0bb828bb` are the mod's own notice, which has no count.

## Fails closed

If masking throws, the row is still stored, with every rewritable text replaced by `[MASKED: secret-mask failed on this row, content withheld]`. A tool result is withheld from the model with a note that the tool already ran and must not be run again, so a retry does not repeat side effects like a push or a send. The first failure shows one toast (`secret-mask failed and is withholding rows`), so a broken mod is visible, not silent. The hook failed open (raw output passed through).

## Settings

- `SECRET_MASK=off` in the environment turns both hooks off.
- `SECRET_MASK_FP_DIR` moves the fingerprint folder.

Not ported: the hook's `~/.claude/logs/secret-mask.log` (mods have no file append), and the `--selftest` CLI / `bin/secret-scrub.js` export (those stay with the hook).

## Cutover

The live check above shows the mod alone masks the transcript copy of a tool result. Install the mod beside the old hook first; both together are safe (already-masked text is skipped). Retiring the hook is a separate step for Pedro (see the PR's Cutover).

## Test

```
claude plugin test plugins/secret-mask
```
