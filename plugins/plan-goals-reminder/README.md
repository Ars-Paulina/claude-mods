# plan-goals-reminder

Keeps the model on its plan. Finds this session's plan in `~/.claude/plans/` (frontmatter `session_uuid` equals the session id) and re-sends about five lines: current goal, next unchecked task, how many items are Parked.

## What it does

- **Every prompt** (`prompt.submit`): adds the reminder as extra context. Your prompt text is not changed. Slash commands get none.
- **After every compaction** (`session.compact`): queues the same reminder for the next request, so the plan survives the summary. The old hook only fired at session start and every 10th tool call.
- Fail-open: any error means no reminder, and the prompt or compaction goes through. Both hooks carry a `.catch` that passes the call on.
- Normal plans only (`## Goals` with `- [ ]` boxes). GSD `PLAN.md` files are not read.

Mod-only gain over the old hook: the compaction re-inject. The per-prompt reminder is a small gain (it replaces the old every-10th-tool-call throttle, so it costs a few lines per prompt).

## Kill switches

- Plugin setting `enabled` off: registers nothing.
- Env `GOALS_MODE=off`: no reminder (same as the old hook).

## Self-check

```bash
claude plugin test plugins/plan-goals-reminder
```
