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

## Install

In a Claude Code terminal session:

```
/plugin install session-board --marketplace Ars-Paulina/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. Swap `session-board` for any mod name above. From a shell: `claude plugin install <mod> --marketplace Ars-Paulina/claude-mods`.

Tested on Linux. macOS should work; Windows is not tested.

## License

MIT
