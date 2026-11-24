# dispatch-router

Hands the model two kinds of notices other background jobs left on disk, with your next prompt.

## What it does

One `prompt.submit` hook (`hooks/register.ts`, logic in `hooks/index.ts`). Before each prompt reaches the model it:

- **Plan verify relay.** If this session has `~/.claude/cache/verify-pending-<session>.flag`, it adds `@DISPATCH:plan-perfector:Skill` plus the plan path as hidden context, once, then deletes the flag. It skips (flag still consumed) when the plan file is gone, or its `status:` is `executed`, `approved` or `executing`, or the flag says `config: off`. Slash commands leave the flag for the next plain prompt.
- **Pending-review notice.** If `~/.claude/cache/learner-pending.flag` exists, it counts proposals in `~/.claude/plans/pending-reviews/` (`status: pending`, plus `card-*` files approved in the last 30 days, plus `aar/`; `deep-*` ignored), consumes the flag and adds "N pending review proposal(s)…". A queue of 50 entries older than 7 days gives a stuck-learner alert instead.
- **Sweep.** Deletes `verify-pending*.flag` files older than 24 hours.
- Relayed `<task-notification>` prompts (and `origin.kind: task-notification`) are never acted on.

It writes one line per verify decision to `~/.claude/logs/plan-verify.log`.

## Mod-only gain: weak

The context goes in `prompt.submit`'s own `context` field, so the model reads it without it being printed into the chat. The classic hook did the same through `additionalContext`. Real gains: the logic is unit-tested against a fake disk, and a kill switch sits in the config menu. Nothing else. Keep the old hook if you do not need those.

## Limits

- `$.fs` has no delete or append, so removing flags and appending to the log shell out to `rm`, `mkdir` and `printf >>`. Linux and macOS only.
- Fails safe: if the hook throws, the prompt goes through as typed, with no context added. It never blocks a prompt.

## Self-check

```bash
claude plugin test plugins/dispatch-router
```
