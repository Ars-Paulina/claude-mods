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
