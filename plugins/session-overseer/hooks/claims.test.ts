import { expect, test } from 'claude-code/testing'

import { detectClaim, makeDetector } from './claims.ts'
import { compilePins } from './pins.ts'
import { Observer } from './observer.ts'

// [GREEN-1] (>=0.90 on test/fixtures/synthetic-claims.jsonl with the shipped phrase list) runs in
// scripts/scripts.test.cjs: the mod test kit has no file system to read the fixture from.

const det = makeDetector({ phrases: ['done', 'all tests pass', 'tests pass', 'shipped', 'fixed', 'committed'], negators: ['not', 'yet', "haven't", 'once'] })
const noGit = async () => ({ exitCode: 1, stdout: '' })
const sleep = () => new Promise(() => {})

test('[RED-2] "All tests pass, shipped." with no test command since the last edit -> would block, missing test run', async () => {
  const o = new Observer({ detector: det, pins: compilePins([]), git: noGit, sleep })
  o.contract = { ts: '2026-11-24T00:00:00.000Z', inGit: true, hasChecks: true }
  o.tool('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, { isError: false, output: '' })
  const rows = await o.turn('All tests pass, shipped.', { cwd: '/r', ccVersion: '2.1.331', tested: '2.1' })
  const claim = rows.find(r => r.signal === 'claim')!
  expect(claim.would).toBe('block')
  expect(claim.detail.missing).toEqual(['test run'])
})

test('claims: phrases, negation, questions, files and shas', () => {
  expect(detectClaim(det, 'Fixed the parser in `src/parse.ts`, committed 3b6f4d3.')).toEqual({ claim: true, phrases: ['committed', 'fixed'], files: ['src/parse.ts'], shas: ['3b6f4d3'] })
  expect(detectClaim(det, 'Not done yet, the tests still fail.').claim).toBe(false)
  expect(detectClaim(det, "I haven't committed anything.").claim).toBe(false)
  expect(detectClaim(det, 'Should I mark this done?').claim).toBe(false)
  expect(detectClaim(det, 'Once tests pass I will push.').claim).toBe(false)
  expect(detectClaim(det, 'The undone work is listed below.').claim).toBe(false)
  expect(detectClaim(det, 'Version 2.1.331 is installed.').files).toEqual([])
})

test('claims: a reply that opens with a blocked / waiting / in-progress status is not a claim', () => {
  for (const t of [
    '🔴 Blocked at step 3. Steps 1-2 done and committed.',
    '🟡 Need your OK before I push. The fix is done.',
    '⏳ Review started. Done so far: the lint step.',
    '**STOP — waiting for your go.** Fix A is done.',
    'Blocked: the deploy needs a login. Tests pass locally.',
    'Need you to run this command. Everything else is done.',
    '╔══╗ ║ CHECKPOINT: verification required ║ Step 1 done.',
  ]) expect(detectClaim(det, t).claim).toBe(false)
  // Phrases are still reported, so the log keeps what was said.
  expect(detectClaim(det, '🔴 Blocked. Step 1 done.').phrases).toEqual(['done'])
  // A green or plain lead keeps the claim; a status word later in the reply does not cancel it.
  expect(detectClaim(det, '🟢 Done. Tests pass, committed 3b6f4d3.').claim).toBe(true)
  expect(detectClaim(det, 'Fixed the bug. Next step is blocked on review.').claim).toBe(true)
  expect(detectClaim(det, 'Stopwatch feature shipped.').claim).toBe(true)
})

test('claims: a reply that is machine output (JSON, bare or fenced, footer allowed) is not a claim', () => {
  for (const t of [
    '{"ops":[{"action":"create","title":"Fix verified and committed"}]}',
    '```json\n{ "closing_state": "work complete and shipped" }\n```',
    '```json { "ops": [] } ``` ⟦AB12:345⟧',
    '[{"status":"done"}] [10:42 PM]',
  ]) expect(detectClaim(det, t).claim).toBe(false)
  // Not machine output: a markdown link or checklist, prose around a json block, broken JSON.
  expect(detectClaim(det, '[x] Parser fixed and committed.').claim).toBe(true)
  expect(detectClaim(det, '[the PR](https://x/1) is shipped.').claim).toBe(true)
  expect(detectClaim(det, '```json\n{"a":1}\n```\nCommitted 3b6f4d3.').claim).toBe(true)
  expect(detectClaim(det, '{ not json, but the fix is done').claim).toBe(true)
})

test('claims: a yellow lead whose headline states finished work stays a claim', () => {
  expect(detectClaim(det, '🟡 **Written and committed. One step left is yours.** Run the deploy.').claim).toBe(true)
  expect(detectClaim(det, '🟡 Need you — I built all of it and it is committed. Approve the push?\nDetails below.').claim).toBe(true)
  // Done-words only after the headline, a negated headline, or a red / blocked lead: still not a claim.
  expect(detectClaim(det, '🟡 Need your OK before I push. The fix is done.').claim).toBe(false)
  expect(detectClaim(det, '🟡 Not committed yet. Waiting on review.').claim).toBe(false)
  expect(detectClaim(det, '🔴 Blocked at step 3, steps 1-2 done and committed.').claim).toBe(false)
})

test('claims: a green lead whose headline reports a finished action in past form is a claim', () => {
  expect(detectClaim(det, '🟢 Report written. File: `notes/report.md`.').claim).toBe(true)
  expect(detectClaim(det, '🟢 **I wrote 5 tests for the parser. All 5 pass.** Details below.').claim).toBe(true)
  expect(detectClaim(det, '🟢 Goals extracted and saved. {"goals": 4}').claim).toBe(true)
  // A green lead with no past-form action in the headline (state, advice), a negated one, a past
  // form only after the headline, a question, or a past form under a non-green lead: not a claim.
  expect(detectClaim(det, '🟢 Run 42 underway, now on step 5: scan running.').claim).toBe(false)
  expect(detectClaim(det, '🟢 **The legacy secret goes in that field.** Not the one you pasted.').claim).toBe(false)
  expect(detectClaim(det, '🟢 Not edited yet, the review comes first.').claim).toBe(false)
  expect(detectClaim(det, '🟢 All clear. Earlier I edited the config.').claim).toBe(false)
  expect(detectClaim(det, '🟢 Report written. Want me to post it?').claim).toBe(false)
  expect(detectClaim(det, 'Report written to the scratch folder.').claim).toBe(false)
})
