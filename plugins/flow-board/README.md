# flow-board

One line above the prompt: background agents running, git dirty/ahead state, PR checks, GSD phase state (when the project uses GSD) and whether a plain `/clear` is safe right now.

## Install

```
/plugin install flow-board --marketplace Ars-Paulina/claude-mods
```

## Use

- The line updates on its own after each turn.
- `/park` checks whether `/clear` is safe now (no agents still running, no uncommitted files). It writes nothing.
- In a GSD project, a Run button offers the next phase handoff. Without GSD that part never shows.

Turn it off with the "Show the flow board" setting in `/plugin`.
