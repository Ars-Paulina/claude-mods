# compact-briefing

After `/compact` or `/clear`, gives Claude back what it just lost. Port of the `compact-briefing-injector.js` hook.

## What it does

- **`/compact`**: injects the core-rules digest, then the last `## ` section of the newest `session-progress-*.md` in the project folder (if under 2 h old), then a `[compact-count]` nudge once the session has compacted twice or more (skipped in autonomous sessions).
- **`/clear`**: injects the newest progress section; if none is fresh, falls back to the session-handoff snapshot (`~/.claude/cache/session-state/<slug>.md`, under 12 h old) with its "UNVERIFIED, check before repeating" guard.
- **After any compaction (auto too)**: writes the two marker files `precompact-report-guard.js` turns into a post-compact report and a digest re-injection on the next prompt.
- Fail-open: any error injects nothing and never blocks the session.

Settings (env vars, same names as the hook): `BRIEFING_INJECT_MAX_AGE_MIN`, `BRIEFING_INJECT_MAX_BYTES`, `BRIEFING_CLEAR_MAX_AGE_MIN`, `PROGRESS_REPORT_POSTCOMPACT`, `PROGRESS_REPORT_POSTCOMPACT_FRESH_MIN`, `CORE_DIGEST_MODE`, `COMPACT_COUNT_MODE`. Kill switch: "Compact briefing" in `/plugin`.

## Mod-only gain: weak

Honest verdict: **no real gain over the hook.** The mod is a `classic.SessionStart` + `classic.PostCompact` hook, so it fires on exactly the same events and injects through the same `additionalContext` channel. What it adds:

- one `enabled` kill switch in `/plugin` (the hook has only env vars);
- the pure logic (cap, freshest file, section cut) is now unit-tested without spawning a process;
- file reads and the freshness scan go through `$.fs` (a small node child and `grep` still run for the digest and the compaction count).

What it does **not** do: `session.start` in a mod has no `source` (compact/clear) and cannot inject context, so a native `session.start` re-inject is not possible; the `classic.*` events are the only route. The mod also still reads Pedro's own `~/.claude/hooks/lib/{core-digest,autonomy,invocation-log}.js` through `scripts/home-libs.cjs`, and still feeds `~/.claude/hooks/precompact-report-guard.js`, so it is not standalone. Not worth cutting over unless the kill switch matters.

## Test

`claude plugin test plugins/compact-briefing` (8 tests: briefing cuts, freshness, byte cap, handoff guard, digest-first order, `/clear` fallback, fail-open on a throwing disk).
