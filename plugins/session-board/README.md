# session-board

One calm card above the prompt: what this session is about, whose turn it is, what is pending and the next step.

## Install

```
/plugin install session-board --marketplace Ars-Paulina/claude-mods
```

## Use

The card fills itself: after the first exchange a small model call writes the goal and current step, and it refreshes as the session moves on. Claude can also update it directly with the `set` tool the plugin registers. Turn it off with the "Show the session card" setting in `/plugin`.
