# notify-focus

Shows what each Claude Code pane is doing, and sends a desktop notification that jumps to the right pane when you click it.

## What it does

Three observers on the classic events (`classic.UserPromptSubmit`, `classic.Notification`, `classic.Stop`). They never block or change anything.

| Event | Glyph | Status line | Other |
|---|---|---|---|
| prompt submitted | ● working | `● working` | clears the dedup entry; in tmux refreshes the border label with the current git branch |
| needs input | ◐ | `◐ needs input` | in-app toast with the message, then a desktop notification |
| turn done | ✔ | `✔ done` | desktop notification, only when nobody used the tmux client in the last 60 s |

- **Per-pane state (the mod-only gain):** the glyph goes to the status line under the prompt with `$.ui.status`, and the Notification text also shows as an in-app `$.ui.toast`. Under tmux the glyph is still written to the `@agent_state` pane option, so the border keeps working.
- **Click to pane:** `notify-send` with a `default` action. A click focuses the exact tmux pane, the herdr pane (then raises the window), or the Tilix window outside both. A dead pane gets a "pane gone" notice. Every outcome is logged to `~/.claude/logs/notify-focus.log`.
- **Anti-fatigue:** needs-input always notifies. The same state for the same pane inside 2 minutes is skipped.
- The shell-outs go through `$.process.run` and `setsid -f`, so the click waiter (up to 30 min) outlives the hook.

## Honest note on the gain

The desktop notification and click-to-pane still need `notify-send`, `wmctrl`, `tmux`, and `herdr`: a mod cannot focus a window by itself. What the mod adds is the in-app status line and toast, a kill switch in `/plugin`, and a tested module in place of an untested script.

## Differences from the old hook

- Dedup lives in memory per session, not in `pane-notify-state.json`. It resets when the session restarts, which at worst gives one extra notification.
- No tmux server PID in the key: it is not needed without a shared file.
- The old hook also played no sound (a separate hook does); same here, a `suppress-sound` hint is sent.
- Needs `~/.claude/scripts/resolve-project-color.sh` and `herdr-raise.sh` for the project label and herdr raise. Without them the label falls back to the folder name.

## Install

```
/plugin install notify-focus --marketplace Ars-Paulina/claude-mods
```

Turn it off with "Show agent state and notify" in `/plugin`.

## Self-check

```bash
claude plugin test plugins/notify-focus
```
