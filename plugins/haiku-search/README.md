# haiku-search

Pushes multi-step file search off the expensive main model and onto an Explore subagent running on Haiku.

## What it does

Two PreToolUse hooks, registered in `hooks/hooks.json`:

- **`scripts/search-delegate.js`** counts the searches the **main thread** runs itself during one user prompt:
  - Counted: `Grep`, `Glob`, and Bash commands where any chained step (split on `;`, `&&`, `||`, newline) is `grep`, `rg`, `find`, `fd`, `ag` or `ack`, optionally behind `VAR=value` prefixes. Pipe filters like `ps aux | grep node` are not counted.
  - Searches 1–2: pass. Searches 3–5: pass, plus a nudge to hand the rest to Explore. Search 6 and later: denied, with a message naming Explore and saying Read still works.
  - The count resets on every new user prompt and whenever the main thread dispatches an agent.
  - Subagents are never counted or blocked. `Read`, `Edit`, `Write` and MCP tools are never touched.
  - Fail-open: any error lets the call through.
- **`scripts/model-router.js`** pins subagent models: Explore runs on Haiku at effort `medium`, or `high` when the prompt says "very thorough". Plan runs on Opus, the built-in Bash agent on Sonnet. An explicit `model:` on the dispatch still wins. If you keep an agent registry at `~/.claude/agents/registry.json` (`{ "entries": [{ "name", "model_tier" }] }`), custom agents get their `model_tier` too; without one they keep their normal model.

Needs `node` on your PATH.

## Install

```
/plugin install haiku-search --marketplace Ars-Paulina/claude-mods
```

## Kill switch: `SEARCH_DELEGATE_MODE`

| Value | Effect |
|---|---|
| `block` (default) | Nudge at 3, deny at 6 |
| `nudge` | Nudge from 3 on, never deny |
| `off` | No counting, no output |

Set it in your shell before you start `claude` (`SEARCH_DELEGATE_MODE=nudge claude`) or under `env` in `~/.claude/settings.json`. To turn off the router too, disable the plugin with `/plugin`.

## Self-check

```bash
bash scripts/search-delegate.test.sh
```
