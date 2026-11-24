import { expect, test } from 'claude-code/testing'

import { pickPlan, summarize } from './index'

const plan = `---
session_uuid: abc
---
# Plan
## Goals
- [x] first goal
- [ ] second goal
  - [ ] sub task one
  - [x] sub task two
## Parked
- (empty)
- idea one
- idea two
## Other
- [ ] not counted
`

test('summarize: current goal, next task, counts, parked', async () => {
  const s = summarize(plan, 'p.md') as string
  expect(s).toContain('p.md — 2/4 checked')
  expect(s).toContain('Current goal: second goal')
  expect(s).toContain('Next task: sub task one')
  expect(s).toContain('Parked: 2.')
})

test('summarize: null without Goals or checkboxes; all done says so', async () => {
  expect(summarize('# x\n## Parked\n- a', 'p.md')).toBe(null)
  expect(summarize('## Goals\nno boxes', 'p.md')).toBe(null)
  expect(summarize('## Goals\n- [x] a', 'p.md')).toContain('Current goal: all goals checked')
})

test('pickPlan: newest matching uuid, skips verification and agent files', async () => {
  const h = (u: string) => `---\nsession_uuid: ${u}\n---\n`
  const files = [
    { name: 'old.md', head: h('abc'), mtimeMs: 1 },
    { name: 'new.md', head: h('abc'), mtimeMs: 5 },
    { name: 'new.verification.md', head: h('abc'), mtimeMs: 9 },
    { name: 'x-agent-1.md', head: h('abc'), mtimeMs: 9 },
    { name: 'other.md', head: h('zzz'), mtimeMs: 9 },
    { name: 'nofront.md', head: 'session_uuid: abc', mtimeMs: 9 },
  ]
  expect(pickPlan(files, 'abc')).toBe('new.md')
  expect(pickPlan(files, 'nope')).toBe(null)
})
