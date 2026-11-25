import { expect, test } from 'claude-code/testing'

import { blindReason, majorMinor } from './blind.ts'

const base = { toolTurn: false, parsedEvents: 0, ccVersion: '2.1.332', tested: '2.1' }

test('[EDGE-9] 0 parsed events on a tool turn -> grey', () => {
  expect(blindReason({ ...base, toolTurn: true, parsedEvents: 0 })).toBe('no_events')
  expect(blindReason({ ...base, toolTurn: true, parsedEvents: 2 })).toBe(null)
})

test('[EDGE-9] 2.1.331 -> 2.1.332 stays green; 2.1 -> 2.2 grey; nothing stamped -> unstamped', () => {
  expect(blindReason({ ...base, tested: majorMinor('2.1.331') })).toBe(null)
  expect(blindReason({ ...base, ccVersion: '2.2.0' })).toBe('version')
  expect(blindReason({ ...base, tested: null })).toBe('unstamped')
  expect(blindReason({ ...base, tested: 'garbage' })).toBe('unstamped')
})
