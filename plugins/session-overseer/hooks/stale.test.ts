import { expect, test } from 'claude-code/testing'

import { canaryCounts, newStaleState, onEvidencelessClaim } from './stale.ts'

// [EDGE-8] (SessionStart compact + PostCompact for one compaction -> count 1) is in scripts/scripts.test.cjs:
// the count is kept by the classic command hook scripts/classic.cjs.

test('evidence-less claim twice -> stale', () => {
  const s = newStaleState()
  expect(onEvidencelessClaim(s)).toBe(null)
  expect(onEvidencelessClaim(s)).toBe('stale')
})

test('canary log: ALERT and miss lines counted for this session only', () => {
  const sid = '00000000-0000-0000-0000-000000000000'
  const log = [`t miss (DECAY) window=1/1 session=${sid} [stop-event]`, `t ALERT session=${sid}`, 't miss (DECAY) session=other'].join('\n')
  expect(canaryCounts(log, sid)).toEqual({ alerts: 1, misses: 1 })
})
