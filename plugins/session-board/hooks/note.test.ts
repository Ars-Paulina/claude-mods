import { test, expect } from 'claude-code/testing'

import { apply, card, clean, isOld, parseSummary, shouldAsk, KEEP_MS, MAX_PENDING, MAX_TRIES, NOW_EVERY_MS } from './note'

test('apply caps pending, squashes newlines, keeps since while state holds', async () => {
  const a = apply(null, { pending: ['1', '2', '3', '4', '5', '6'], lastPrompt: '\n\nhi\nthere ' }, 100)
  expect(a.pending.length).toBe(MAX_PENDING)
  expect(a.lastPrompt).toBe('hi there')
  expect(a.since).toBe(100)
  const b = apply(a, { topic: 'x' }, 200)
  expect(b.since).toBe(100)
  const c = apply(b, { state: 'working' }, 300)
  expect(c.since).toBe(300)
})

test('card: empty note is null, full note has light, minutes, next', async () => {
  expect(card(null, 0)).toBe(null)
  expect(card(apply(null, {}, 0), 0)).toBe(null)

  const n = apply(null, { topic: 'Build card', stage: 'building', pending: ['a', 'b'], next: 'try it' }, 0)
  const c = card(n, 12 * 60000)!
  expect(c.header).toBe('🟡 Your turn · building · 12m')
  expect(c.color).toBe('warning')
  expect(c.items).toEqual(['a', 'b'])
  expect(c.next).toBe('try it')
  expect(card({ ...n, state: 'working' }, 0)!.header).toBe('🟢 Claude working · building · just now')
})

test('card falls back: last prompt as topic, first pending as next', async () => {
  const c = card(apply(null, { firstPrompt: 'build a login', lastPrompt: 'fix login', pending: ['run tests'] }, 0), 0)!
  expect(c.goal).toBe('build a login')
  expect(c.isGoalGuess).toBe(true)
  expect(c.now).toBe('fix login')
  expect(c.isNowGuess).toBe(true)
  expect(c.next).toBe('run tests')
})

test('isOld after 30 days', async () => {
  const n = apply(null, {}, 0)
  expect(isOld(n, KEEP_MS + 1)).toBe(true)
  expect(isOld(n, 1000)).toBe(false)
})

test('clean strips paste tags so the card never shows markup', async () => {
  expect(clean('\n\n<pasted_content id="1">\nRelayed text\n</pasted_content id="1">')).toBe('Relayed text')
  expect(clean('a < b and c > d')).toBe('a < b and c > d')
})

test('parseSummary reads GOAL and NOW lines', async () => {
  expect(parseSummary('GOAL: Ship the Acme app\nNOW: Add a bash permission rule')).toEqual({
    goal: 'Ship the Acme app',
    now: 'Add a bash permission rule',
  })
  expect(parseSummary('nonsense')).toEqual({ goal: '', now: '' })
})

test('parseSummary drops answers that admit not knowing', async () => {
  const r = parseSummary("GOAL: Unknown. This session's original purpose isn't shown to me.\nNOW: Resuming paused session. No details available")
  expect(r).toEqual({ goal: '', now: '' })
})

test('shouldAsk: retries a missing goal, refreshes an auto Now every 10 min, leaves Claude alone', async () => {
  const n = apply(null, { seed: 'x' }, 0)
  expect(shouldAsk(n, 0)).toBe(true)
  expect(shouldAsk({ ...n, autoTries: MAX_TRIES, topic: 't', isTopicAuto: true, autoAt: 0 }, 1000)).toBe(false)
  expect(shouldAsk({ ...n, goal: 'g', topic: 't', isTopicAuto: true, autoAt: 0 }, NOW_EVERY_MS)).toBe(true)
  expect(shouldAsk({ ...n, goal: 'g', topic: 't', isTopicAuto: false, autoAt: 0 }, NOW_EVERY_MS * 9)).toBe(false)
})

test('a stored vague goal counts as missing and is not shown', async () => {
  const n = apply(null, { seed: 'x', firstPrompt: 'resume work', goal: "Unknown. This session's original purpose isn't shown to me." }, 0)
  expect(shouldAsk({ ...n, autoTries: 1 }, 0)).toBe(true)
  expect(card(n, 0)!.goal).toBe('resume work')
})
