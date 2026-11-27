# notify-sound

Plays a short tone when Claude asks you a question (`AskUserQuestion`). Port of the
`~/.claude/hooks/notify-sound.js` command hook.

## What changed vs the hook

- Hook: a Node process started on every question, which spawned a detached `paplay`.
- Mod: one function hook inside the engine, no Node process. The tone ships in the mod (`sounds/notify-tone.wav`).
- macOS and other hosts: `$.audio.play({ asset })` at gain 0.2 (same 20% level as the hook).
- **Linux / WSL: `paplay` through `$.process.run`.** The engine types say `$.audio.play` has no player on Linux, so
  relying on it alone would go silent on this laptop. The route is picked from `$.session.info().platform`.
  The sound is started without awaiting it, so the question dialog never waits on it.
- Kill switch: the `enabled` setting (default on).

## Honest gain

The mod-only gain (`$.audio.play`, no spawned process) is real only off Linux. On Linux the mod still saves the
per-question Node start, but a `paplay` process is still run. Not verified in a live session: whether
`$.audio.play` does play on this Linux box. If it does, drop the `paplay` branch in `hooks/register.ts`.

## Test

`claude plugin test plugins/notify-sound` (route choice, paplay command, and that an `AskUserQuestion` call requests a sound and goes on).
