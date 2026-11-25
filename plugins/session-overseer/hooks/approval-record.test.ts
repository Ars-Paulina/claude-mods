import { expect, test } from 'claude-code/testing'

import { approvalRecord } from './approval-record.ts'

// Built at run time so no scanner sees one literal token.
const TOKEN = 'ghp_' + 'A1b2'.repeat(9)

test('[EDGE-3] rating token r12 y is not recorded', () => {
  expect(approvalRecord('r12 y', 't', 'm1')).toBe(null)
  expect(approvalRecord('  r3 n ', 't', 'm1')).toBe(null)
  expect(approvalRecord('r12 yes', 't', 'm1')).not.toBe(null)
})

test('[EDGE-3] the bridge gets the raw text (it masks; masker stub cases are in scripts/store.test.cjs)', () => {
  const rec = approvalRecord(`use ${TOKEN} to push`, '2026-11-24T00:00:00.000Z', 'm1')!
  expect(rec).toEqual({ message_id: 'm1', ts: '2026-11-24T00:00:00.000Z', exact_text: `use ${TOKEN} to push`, scope: null })
})
