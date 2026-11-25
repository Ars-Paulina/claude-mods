# auto-proceed

When a reply ends by offering a safe next step, this mod tells Claude to do it instead of waiting for you to type "go".

It hooks the end of a turn (`classic.Stop`) and reads the last reply. It steps in only when all of these hold:

- the reply ends with an explicit offer (`say "commit" and I'll run it`, `Shall I continue?`) or a menu with a `←` pick
- the reply is not a question or a choice for you, and not a step only you can do (a key press, `/login`, a step on your phone)
- `AskUserQuestion` was not used this turn
- no risk word near the end (money, delete, merge, deploy, prod, push, secret, …)
- it has not already nudged 3 times in a row

Anything else ends the turn as usual. On an error it does nothing.

## What it does not do

A line like `👉 You: open a new pane and type node --version` is left alone, even when Claude could have done the step itself. The word "type", "say" or "reply" is not enough: the reply must offer to do something (`… and I'll …`). An earlier version fired on the word alone and started work nobody asked for.

## Settings

| Option | Values | Default |
|---|---|---|
| `mode` | `on` keeps going, `warn` only shows a toast and a log line, `off` runs nothing | `on` |

Sessions listed in a running run record under `~/.claude/state/oversee/` are skipped: their overseer decides.

Do not run this next to a settings Stop hook that does the same job. If another Stop hook already blocks, this mod stays out of the way.

## Test

```
claude plugin test plugins/auto-proceed
```
