import { test, expect } from 'claude-code/testing'

import { apply, card, clean, isFresh, isOld, normalize, KEEP_MS, MAX_PENDING } from './note'
import { MAX_STORED } from './haiku'

test('apply numbers plain strings, squashes newlines, keeps since while state holds', async () => {
  const a = apply(null, { pending: ['a', 'b'] as never, lastPrompt: '\n\nhi\nthere ' }, 100)
  expect(a.pending).toEqual([
    { n: 1, text: 'a' },
    { n: 2, text: 'b' },
  ])
  expect(a.nextN).toBe(3)
  expect(a.lastPrompt).toBe('hi there')
  expect(a.since).toBe(100)
  const b = apply(a, { topic: 'x' }, 200)
  expect(b.since).toBe(100)
  const c = apply(b, { state: 'working' }, 300)
  expect(c.since).toBe(300)
})

test('apply stores up to 12 items and never hands a number out twice', async () => {
  const many = Array.from({ length: 15 }, (_, i) => `item ${i + 1}`)
  const a = apply(null, { pending: many as never }, 0)
  expect(a.pending.length).toBe(MAX_STORED)
  expect(a.nextN).toBe(16)
  const b = apply(a, { pending: [{ n: 15, text: 'item 15' }] }, 0)
  expect(b.nextN).toBe(16) // 16 stays the next number even though the list shrank
})

test('a card saved with plain-string pending is read as numbered items', async () => {
  const old = normalize({ pending: ['finish', 'ship'] as never })!
  expect(old.pending).toEqual([
    { n: 1, text: 'finish' },
    { n: 2, text: 'ship' },
  ])
  expect(old.cardTurn).toBe('')
  expect(isFresh(old)).toBe(false)
})

test('card: empty note is null, full note has light, minutes, numbered items, next', async () => {
  expect(card(null, 0)).toBe(null)
  expect(card(apply(null, {}, 0), 0)).toBe(null)

  const n = apply(null, { topic: 'Build card', stage: 'building', pending: ['a', 'b'] as never, next: 'try it' }, 0)
  const c = card(n, 12 * 60000)!
  expect(c.header).toBe('🟡 Your turn · building · 12m')
  expect(c.color).toBe('warning')
  expect(c.items).toEqual(['1. a', '2. b'])
  expect(c.more).toBe(0)
  expect(c.next).toBe('try it')
  expect(card({ ...n, state: 'working' }, 0)!.header).toBe('🟢 Claude working · building · just now')
})

test('card shows 5 items and counts the rest', async () => {
  const n = apply(null, { pending: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as never }, 0)
  const c = card(n, 0)!
  expect(c.items.length).toBe(MAX_PENDING)
  expect(c.more).toBe(2)
})

test('card says stale, with the failure count, until a call finishes for the latest turn', async () => {
  const failed = apply(null, { topic: 't', cardTurn: 't2', freshTurn: 't1', staleSince: 60000, failCount: 2 }, 0)
  expect(card(failed, 4 * 60000)!.header).toBe('🟡 Your turn · 4m · stale 3m ×2')
  const ok = apply(failed, { freshTurn: 't2', staleSince: 0, failCount: 0 }, 0)
  expect(isFresh(ok)).toBe(true)
  expect(card(ok, 0)!.header).toBe('🟡 Your turn · just now')
})

test('card falls back: last prompt as topic, first pending as next', async () => {
  const c = card(apply(null, { firstPrompt: 'build a login', lastPrompt: 'fix login', pending: ['run tests'] as never }, 0), 0)!
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

test('a stored vague goal counts as missing and is not shown', async () => {
  const n = apply(null, { seed: 'x', firstPrompt: 'resume work', goal: "Unknown. This session's original purpose isn't shown to me." }, 0)
  expect(card(n, 0)!.goal).toBe('resume work')
})
