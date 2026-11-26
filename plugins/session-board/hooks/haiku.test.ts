import { test, expect } from 'claude-code/testing'

import { applyDelta, buildPrompt, isAgentMsg, parseCard, parseDelta, parseFullList, parseNext, shouldSkip, tail } from './haiku'

test('parseCard reads goal, now and the changed flag; vague lines and junk give nothing', async () => {
  expect(parseCard('GOAL_CHANGED: no\nGOAL: Ship the Acme app\nNOW: Add a bash permission rule')).toEqual({ isGoalChanged: false, goal: 'Ship the Acme app', now: 'Add a bash permission rule' })
  expect(parseCard('GOAL_CHANGED: yes\nGOAL: New purpose').isGoalChanged).toBe(true)
  expect(parseCard('nonsense')).toEqual({ isGoalChanged: false, goal: '', now: '' })
  expect(parseCard("GOAL: Unknown. This session's original purpose isn't shown to me.\nNOW: No details available")).toEqual({ isGoalChanged: false, goal: '', now: '' })
})

test('parseFullList reads a numbered ⏳ list with Claude numbers, and not a delta line', async () => {
  const reply = 'Done.\n\n⏳ **Pending:**\n1. OQ-4: find out why the hook is skipped.\n   It blocks the style change.\n3. Push the `fsearch-mine` branch\n\n[07:19 PM]'
  expect(parseFullList(reply)).toEqual([
    { n: 1, text: 'OQ-4: find out why the hook is skipped.' },
    { n: 3, text: 'Push the fsearch-mine branch' },
  ])
  expect(parseFullList('🟢 Done.\n⏳ +fix hook · ✓2 pushed branch\n👉 Next (no reply needed): tests')).toBe(null)
  expect(parseFullList('no list here\n1. a numbered step\n2. another')).toBe(null)
})

// This pins the delta grammar the Traffic Teacher style writes between full lists.
test('parseDelta reads opens and closes; a full list or prose is not a delta', async () => {
  expect(parseDelta('🟢 Done.\n⏳ **Pending:**\n1. a\n2. b')).toBe(null)
  expect(parseDelta('no pending line')).toBe(null)
  const d = parseDelta('🟢 Done.\n⏳ +#4 fix the hook · +no number · ✓#2 pushed the branch · ✓write tests for the parser · ✓3 PRs merged\n👉 Next (no reply needed): go')!
  expect(d).toEqual({
    add: [
      { n: 4, text: 'fix the hook' },
      { n: null, text: 'no number' },
    ],
    closeN: [2],
    closeText: ['write tests for the parser', '3 PRs merged'], // "✓3 PRs merged" has no #: wording, not item 3
  })
})

test('applyDelta: numbered opens and closes are exact; code picks a number only when Claude gives none or a taken one', async () => {
  const old = [
    { n: 1, text: 'write tests' },
    { n: 2, text: 'push the branch' },
    { n: 3, text: 'call the bank' },
  ]
  const r = applyDelta(old, 4, {
    add: [
      { n: 7, text: 'fix the hook' }, // Claude skipped ahead: its number is kept, so a later ✓#7 works
      { n: 3, text: 'number already on the card' },
      { n: null, text: 'no number' },
      { n: null, text: 'Call the bank' }, // already open: not added twice
    ],
    closeN: [2],
    closeText: ['write tests for the parser', 'something never on the card'],
  })
  expect(r.pending).toEqual([
    { n: 3, text: 'call the bank' },
    { n: 7, text: 'fix the hook' },
    { n: 8, text: 'number already on the card' },
    { n: 9, text: 'no number' },
  ])
  expect(r.nextN).toBe(10)
  expect(r.unresolved).toEqual(['something never on the card'])
  expect(applyDelta(old, 4, { add: [], closeN: [9], closeText: [] })).toEqual({ pending: old, nextN: 4, unresolved: ['#9'] })
})

test('applyDelta keeps at most 12 items', async () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ n: i + 1, text: `item ${i + 1}` }))
  const r = applyDelta(many, 13, { add: [{ n: 13, text: 'one more' }], closeN: [], closeText: [] })
  expect(r.pending.length).toBe(12)
  expect(r.pending[11]).toEqual({ n: 13, text: 'one more' })
})

// This table pins the Traffic Teacher 👉 grammar (~/.claude/output-styles/traffic-teacher.md).
// If the style changes how it writes the 👉 line, this test must change with it.
test('parseNext: 👉 You means blocked, any other 👉 means your turn, no 👉 means no change', async () => {
  expect(parseNext('🟡 need you\n👉 **You:** pick 1 or 2.')).toEqual({ state: 'blocked', next: 'pick 1 or 2.' })
  expect(parseNext('👉 You: press Shift+Tab')).toEqual({ state: 'blocked', next: 'press Shift+Tab' })
  expect(parseNext('🟢 done\n👉 Next (no reply needed): I run the tests')).toEqual({ state: 'your-turn', next: 'I run the tests' })
  expect(parseNext('👉 **You:** old one\ntext\n👉 Next (no reply needed): latest wins')!.next).toBe('latest wins')
  expect(parseNext('🟢 done, nothing else')).toBe(null)
  expect(parseNext('the 👉 emoji mid-line is not a next line')).toBe(null)
})

test('shouldSkip: no ⏳ or 👉 and a goal already set means no model call', async () => {
  expect(shouldSkip('plain answer', 'Ship Acme')).toBe(true)
  expect(shouldSkip('plain answer', '')).toBe(false)
  expect(shouldSkip('⏳ +new item', 'Ship Acme')).toBe(false)
  expect(shouldSkip('👉 Next (no reply needed): go on', 'Ship Acme')).toBe(false)
})

test('isAgentMsg spots hand-backs and harness notices, not the user', async () => {
  expect(isAgentMsg('[Subagent hand-back] The task finished')).toBe(true)
  expect(isAgentMsg('<system-reminder>\n[Subagent hand-back] wrapped in a tag')).toBe(true)
  expect(isAgentMsg('\n<task-notification>\n<task-id>x</task-id>')).toBe(true)
  expect(isAgentMsg('fix the login bug [Subagent hand-back] mentioned later')).toBe(false)
})

test('buildPrompt shows the numbered card, caps the request, keeps reply newlines', async () => {
  const b = buildPrompt({ goal: 'Ship Acme', now: '', pending: [{ n: 4, text: 'push' }], prompt: 'x'.repeat(5000), replies: ['line one\n⏳ +item'] })
  expect(b.prompt).toContain('GOAL: Ship Acme')
  expect(b.prompt).toContain('NOW: (none yet)')
  expect(b.prompt).toContain('4. push')
  expect(b.prompt).toContain('<reply>\nline one\n⏳ +item\n</reply>')
  expect(b.prompt.includes('x'.repeat(1501))).toBe(false)
  expect(tail('a'.repeat(3000)).length).toBe(2000)
})
