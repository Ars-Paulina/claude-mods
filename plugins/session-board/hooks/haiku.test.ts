import { test, expect } from 'claude-code/testing'

import { applyDelta, buildPrompt, isAgentMsg, mergePending, parseCard, parseDelta, parseFullList, parseNext, shouldSkip, tail } from './haiku'

test('parseCard reads goal, now, the changed flag and the pending lines', async () => {
  const p = parseCard('GOAL_CHANGED: no\nGOAL: Ship the Acme app\nNOW: Add a bash permission rule\nPENDING:\n2. push the branch\n+ fix the hook\n')
  expect(p.isGoalChanged).toBe(false)
  expect(p.goal).toBe('Ship the Acme app')
  expect(p.now).toBe('Add a bash permission rule')
  expect(p.hasPending).toBe(true)
  expect(p.lines).toEqual([
    { n: 2, text: 'push the branch' },
    { n: null, text: 'fix the hook' },
  ])
  expect(parseCard('GOAL_CHANGED: yes\nGOAL: New purpose').isGoalChanged).toBe(true)
})

test('parseCard: junk has no pending block, vague lines are dropped, "(none)" is an empty list', async () => {
  const junk = parseCard('nonsense')
  expect(junk).toEqual({ isGoalChanged: false, goal: '', now: '', hasPending: false, lines: [] })
  const vague = parseCard("GOAL: Unknown. This session's original purpose isn't shown to me.\nNOW: No details available")
  expect(vague.goal).toBe('')
  expect(vague.now).toBe('')
  const none = parseCard('GOAL: g\nNOW: n\nPENDING:\n(none)')
  expect(none.hasPending).toBe(true)
  expect(none.lines).toEqual([])
})

test('mergePending: code hands out numbers; a closed number is never reused', async () => {
  const old = [
    { n: 1, text: 'write tests' },
    { n: 2, text: 'push the branch' },
  ]
  // 1 left out = closed; 2 kept; one new item
  const a = mergePending(old, 3, [
    { n: 2, text: 'push the branch' },
    { n: null, text: 'fix the hook' },
  ])
  expect(a.pending).toEqual([
    { n: 2, text: 'push the branch' },
    { n: 3, text: 'fix the hook' },
  ])
  expect(a.nextN).toBe(4)
  // everything closed, then a new item: it gets 4, not 1
  const b = mergePending(a.pending, a.nextN, [])
  const c = mergePending(b.pending, b.nextN, [{ n: null, text: 'later item' }])
  expect(c.pending).toEqual([{ n: 4, text: 'later item' }])
})

test('mergePending ignores a renumber attempt, keeps the card wording, drops duplicates', async () => {
  const old = [{ n: 5, text: 'push the branch' }]
  const r = mergePending(old, 6, [
    { n: 5, text: 'reworded by the model' }, // kept: number and the card's own text stay
    { n: 9, text: 'a number the card never had' }, // unknown number: a new item
    { n: 5, text: 'same number twice' }, // second use of 5: a new item
    { n: null, text: 'Push the branch' }, // same text as a kept item: not added again
  ])
  expect(r.pending).toEqual([
    { n: 5, text: 'push the branch' },
    { n: 6, text: 'a number the card never had' },
    { n: 7, text: 'same number twice' },
  ])
  // the model drops the number and writes the item back as new: it keeps its number
  expect(mergePending(old, 6, [{ n: null, text: 'Push the branch' }]).pending).toEqual(old)
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
test('parseDelta + applyDelta: code opens and closes items exactly; only an unmatched wording is left over', async () => {
  expect(parseDelta('🟢 Done.\n⏳ **Pending:**\n1. a\n2. b')).toBe(null)
  expect(parseDelta('no pending line')).toBe(null)
  const d = parseDelta('🟢 Done.\n⏳ +fix the hook · ✓#2 pushed the branch · ✓write tests for the parser · ✓3 PRs merged\n👉 Next (no reply needed): go')!
  expect(d).toEqual({ add: ['fix the hook'], closeN: [2], closeText: ['write tests for the parser', '3 PRs merged'] })

  const old = [
    { n: 1, text: 'write tests' },
    { n: 2, text: 'push the branch' },
    { n: 3, text: 'call the bank' },
  ]
  const r = applyDelta(old, 4, d)
  expect(r.pending).toEqual([
    { n: 3, text: 'call the bank' }, // "✓3 PRs merged" has no #: it is wording, not item 3
    { n: 4, text: 'fix the hook' },
  ])
  expect(r.nextN).toBe(5)
  expect(r.unresolved).toEqual(['3 PRs merged'])
  expect(applyDelta(old, 4, { add: [], closeN: [9], closeText: [] }).pending).toEqual(old) // a number not on the card closes nothing
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
