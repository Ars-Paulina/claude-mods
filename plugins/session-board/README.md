# session-board

One calm card above the prompt: what this session is about, whose turn it is, what is pending and the next step.

## Install

```
/plugin install session-board --marketplace Ars-Paulina/claude-mods
```

## Use

The card fills itself: after each turn a small model call, in the background, rewrites the goal, the current step and the numbered pending list from Claude's reply. The light and the Next line come straight from the reply's `👉` line. If that call fails, the card keeps its last content and says `stale` in its header. Claude can also update the card directly with the `set` tool the plugin registers.

Prompts and replies are screened for secrets before anything is stored or sent to the small model.

Settings in `/plugin`: "Show the session card" (off switch), "Card model", and "Let the card model keep the pending list".

`hooks/detect.ts` is a byte-identical copy of `plugins/prompt-secret-screen/hooks/detect.ts` (commit 0ef6100); CI fails if the two differ.
