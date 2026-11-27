# prompt-index

A pane listing every prompt you sent in this session. Pick one and press Enter to scroll the chat back to it.

## Install

```
/plugin install prompt-index --marketplace Ars-Paulina/claude-mods
```

## Use

Type `/prompts` to open the pane. Arrow keys move, Enter jumps, Esc goes back to typing (the pane stays open). New prompts appear while it is open. Prompts typed while Claude is busy are listed too; one that Claude folds into its running turn has no row to jump to (you get a toast), and is not restored after a resume. A folded prompt typed again word for word as the very next prompt shows once. Very long sessions may show "Older prompts may not be reachable" when the list hits its size cap.
