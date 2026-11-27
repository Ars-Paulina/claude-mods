# session-board

One calm card above the prompt: what this session is about, whose turn it is, what is pending and the next step.

## Install

```
/plugin install session-board --marketplace Ars-Paulina/claude-mods
```

## Use

The card fills itself after each turn, from Claude's reply:

- **Goal and Now**: a small model call, in the background, writes these two lines. If it fails, the card keeps its last content and says `stale` in its header.
- **Pending**: kept by code, never by the model. A numbered `⏳` list in the reply replaces the card's list. Between full lists, a one-line change is applied exactly: `⏳ +#7 new item · ✓#3 done · ~#2 new wording` opens item 7, closes item 3 and rewords item 2 (it keeps its number). If a change does not fit the card, the card stops counting its list as live until the next full list.
- **Light and Next**: read from the reply's `👉` line. `👉 You:` means blocked.

Claude can also update the card directly with the `set` tool the plugin registers.

Prompts and replies are screened for secrets before anything is stored or sent to the small model.

Settings in `/plugin`: "Show the session card" (off switch), "Card model", and "Keep the pending list on the card".

`hooks/detect.ts` is a byte-identical copy of `plugins/prompt-secret-screen/hooks/detect.ts` (commit 0ef6100); CI fails if the two differ.
