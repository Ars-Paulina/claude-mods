# toggles

A pane to turn plugins, skills and MCP servers on or off for the current project only.

## Install

```
/plugin install toggles --marketplace Ars-Paulina/claude-mods
```

Needs `node` on your PATH.

## Use

Type `/toggles`. Tabs for Plugins, Skills and MCPs, with search. Every change is project-scoped: it writes `<project>/.claude/settings.local.json` or this project's entry in `~/.claude.json`, never your user-wide settings. Names listed in `careful.json` ask for a second press before they turn off.
