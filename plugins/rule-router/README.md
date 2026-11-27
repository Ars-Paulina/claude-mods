# rule-router

Attaches short rules to your prompt when it mentions their keywords. Each rule is a Markdown file in `~/.claude/rules-recall/` with frontmatter:

```markdown
---
name: GUARD_ROUTES
keywords: [prod, commit, merge]
priority: 10
---
The rule text Claude should read when one of the keywords comes up.
```

## What it does

- **On every prompt** (`hooks/router.ts`, a `prompt.submit` hook): runs the bundled `scripts/rule-router.py` on the prompt text. Matched rules come back wrapped in `<recall-rules source="rule-router">` and ride with the prompt as hidden context (`e.context`): Claude reads them, the prompt on screen stays as typed.
  - Word-boundary keyword match; a `fact-*.md` rule needs two distinct keyword hits.
  - Each rule is sent once per session. A 9,500-character cap holds; rules that don't fit are deferred to the next prompt and sort first then.
  - Every turn that sends or defers rules writes one line to `~/.claude/logs/invocations.jsonl`.
  - Background-task notifications and other prompts the person did not type (`isMeta`) are not scanned.
  - Fails open: a missing Python, a crash or bad output lets the prompt through with no rules.
- **After a `Read` of a `.planning/**/*.md` file** (settings hook `PostToolUse`): the same scan over the file's text, so autonomous runs that never type a keyword still get the rules. Off with `RULE_ROUTER_READ_SCAN_MODE=off`.
- **After `/compact`** (settings hook `SessionStart`, matcher `compact`): starts a new dedup epoch, so rules lost with the old context can be sent again.

Needs `python3` (Linux or macOS: it locks files with `fcntl`).

## Environment

| Variable | Default |
|---|---|
| `GSD_RULES_RECALL_DIR` | `~/.claude/rules-recall` |
| `CLAUDE_RULE_ROUTER_STATE_DIR` | `~/.claude/cache/rule-router` |
| `CLAUDE_LOG_DIR` | `~/.claude/logs` |
| `RULE_ROUTER_READ_SCAN_MODE` | on; `off` turns the Read scan off |

## What the mod gains over the settings hook

The prompt side moved from a `UserPromptSubmit` settings hook to a `prompt.submit` function hook:

- **Origin instead of regex.** The settings hook stripped `<task-notification>`, `<system-reminder>` and `<agent-message>` blocks out of the prompt with a regex, because harness text in the same field fired rules nobody asked for. The mod reads `e.origin.kind` and `e.isMeta` from the engine and skips those prompts outright. The regex stays in the script as a second line for text pasted inside a typed prompt.
- **Hidden context through the engine's own field.** Rules go in `e.context`, the documented channel for text the model reads beside the prompt; no stdout JSON protocol to get wrong.
- **Not taken: `prompt.compose`.** Putting rules in a system-prompt section was looked at and left out: the system prompt is cached, so a section that changes per prompt would break the prompt cache every turn, and a once-per-session rule set already rides fine with the prompt that matched it.
- **No gain for the other two hooks.** The Read scan and the compact reset stay settings hooks inside the plugin (`hooks/hooks.json`), running the same scripts. A function-hook port would only re-wrap the same Python call.

The Python is unchanged from `~/.claude/hooks/` (same files, same state and log paths), so the mod and the old hook share dedup state and never double-send in one session.

## Install

```
/plugin install rule-router --marketplace Ars-Paulina/claude-mods
```

## Self-check

```bash
claude plugin test plugins/rule-router
```
