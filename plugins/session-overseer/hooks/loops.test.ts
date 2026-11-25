import { expect, test } from 'claude-code/testing'

import { newLoopState, onBash, onEdit } from './loops.ts'

test('[EDGE-4] 2 identical failures -> none; 3 -> loop', () => {
  const s = newLoopState()
  expect(onBash(s, 'pnpm test', true, 'h1')).toBe(null)
  expect(onBash(s, 'pnpm test', true, 'h1')).toBe(null)
  expect(onBash(s, 'pnpm test', true, 'h1')).toBe('loop')
})

test('[EDGE-4] fail/edit/fail x3 with differing output -> none', () => {
  const s = newLoopState()
  for (let i = 0; i < 3; i++) {
    expect(onBash(s, 'pnpm test', true, `h${i}`)).toBe(null)
    expect(onEdit(s, '/r/a.ts', `d${i}`, `b${i}`, `a${i}`)).toBe(null)
  }
})

test('[EDGE-4] 3 identical successes -> none; an edit between identical failures resets', () => {
  const s = newLoopState()
  for (let i = 0; i < 3; i++) expect(onBash(s, 'ls', false, 'h')).toBe(null)
  onBash(s, 'x', true, 'h')
  onBash(s, 'x', true, 'h')
  onEdit(s, '/r/a.ts', 'd', 'b', 'a')
  expect(onBash(s, 'x', true, 'h')).toBe(null)
})

test('edit burst: a revert to an earlier state, or the same diff 3 times', () => {
  const s = newLoopState()
  expect(onEdit(s, '/r/a.ts', 'A>B', 'A', 'B')).toBe(null)
  expect(onEdit(s, '/r/a.ts', 'B>A', 'B', 'A')).toBe('edit_burst')
  const t = newLoopState()
  expect(onEdit(t, '/r/b.ts', 'same', 'x1', 'y1')).toBe(null)
  expect(onEdit(t, '/r/b.ts', 'same', 'x2', 'y2')).toBe(null)
  expect(onEdit(t, '/r/b.ts', 'same', 'x3', 'y3')).toBe('edit_burst')
})
