# claude-mods

Small mods for [Claude Code](https://code.claude.com): extra panes, lines above the prompt, and hooks.

| Mod | What it does |
|---|---|
| [session-board](plugins/session-board) | A card above the prompt: the session's goal, whose turn it is, what is pending, the next step |
| [prompt-index](plugins/prompt-index) | `/prompts` pane listing your prompts; Enter scrolls the chat back to one |
| [toggles](plugins/toggles) | `/toggles` pane to turn plugins, skills and MCP servers on or off per project |
| [flow-board](plugins/flow-board) | A line with background agents, git state, PR checks, and whether `/clear` is safe; adds `/park` |
| [pendings-band](plugins/pendings-band) | A line with the next ready step for this project, from a local goal ledger (bundled `goals.py`) |
| [haiku-search](plugins/haiku-search) | Hands multi-step search to an Explore subagent on Haiku and pins subagent models |
| [npm-block](plugins/npm-block) | Rewrites `npm` to `pnpm` in Bash commands instead of blocking them |
| [secret-mask](plugins/secret-mask) | Masks secrets in tool results, hook context and attachments before the model or transcript sees them |
| [auto-proceed](plugins/auto-proceed) | When a reply ends by offering a safe next step ("say go and I'll run it"), tells Claude to do it instead of waiting |
| [session-overseer](plugins/session-overseer) | Log only: notes done-claims without a test run, claims git does not back, loops, compactions and pinned-rule breaks, and what it would have done. Takes no action |

## Install

In a Claude Code terminal session:

```
/plugin install session-board --marketplace Ars-Paulina/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. Swap `session-board` for any mod name above. From a shell: `claude plugin install <mod> --marketplace Ars-Paulina/claude-mods`.

Tested on Linux. macOS should work; Windows is not tested.

## Managed machines

If a managed-settings file exists (for example `/etc/claude-code/managed-settings.json`), Claude Code seats the built-in `cc-plugin-sec-default` plugin first. It skips some events for installed mods: `session.append` (so `secret-mask` misses hook, attachment and compaction rows; `prompt-index` is not affected, tested: it still lists every typed prompt) and `prompt.compose` (`session-board`). Claude Code prints a "hook was skipped" notice once per mod per session. Disabling the built-in plugin in settings does not change this (tested on 2.1.332).

## License

MIT
