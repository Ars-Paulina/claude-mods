import { expect, test } from 'claude-code/testing'

import { checksMark, formatBoard, freshContextPhase, gsdState, parkVerdict } from './board'

const IDLE = { busy: 0, quiet: 0, quietMin: 0 }

test('formatBoard: full line, parts in order', () => {
  const line = formatBoard({
    busy: 2, quiet: 1, quietMin: 12,
    git: { dirty: 3, ahead: 2 },
    pr: { number: 41, checks: '✓' },
    gsd: 'P07 executing',
  }, 200)
  expect(line).toBe('bg: 2 running (1 quiet 12m ⚠) · git: 3 dirty, 2 ahead · PR #41 ✓ · GSD: P07 executing · clear ✗')
})

test('formatBoard: missing parts are omitted, never placeholders', () => {
  expect(formatBoard(IDLE, 80)).toBe('clear ✓')
  expect(formatBoard({ ...IDLE, git: { dirty: 0 } }, 80)).toBe('git: clean · clear ✓')
  expect(formatBoard({ ...IDLE, busy: 1, git: { dirty: 0 } }, 80)).toBe('bg: 1 running · git: clean · clear ✗')
})

test('formatBoard: cut to width', () => {
  const line = formatBoard({ ...IDLE, git: { dirty: 3, ahead: 2 }, gsd: 'P07 executing' }, 20)
  expect(line).toHaveLength(20)
  expect(line).toEndWith('…')
})

test('parkVerdict', () => {
  expect(parkVerdict(IDLE)).toEqual({ ok: true, text: '✓ safe to /clear' })
  expect(parkVerdict({ ...IDLE, git: { dirty: 0, ahead: 4 } }).ok).toBe(true)
  expect(parkVerdict({ ...IDLE, busy: 2, git: { dirty: 3 } }).text).toBe('✗ 2 agents running · 3 uncommitted')
  expect(parkVerdict({ ...IDLE, busy: 1 }).text).toBe('✗ 1 agent running')
  expect(parkVerdict({ ...IDLE, unknown: ['git'] })).toEqual({ ok: false, text: '✗ git unknown' })
})

test('freshContextPhase: fresh, unplanned, two-digit phases only', () => {
  const now = 1_000_000_000
  const min = 60_000
  expect(freshContextPhase([{ dir: '07-x', name: '07-CONTEXT.md', mtimeMs: now - min }], now)).toBe('07')
  // stale
  expect(freshContextPhase([{ dir: '07-x', name: '07-CONTEXT.md', mtimeMs: now - 5 * min }], now)).toBe(null)
  // already planned
  expect(freshContextPhase([
    { dir: '07-x', name: '07-CONTEXT.md', mtimeMs: now - min },
    { dir: '07-x', name: '07-01-PLAN.md', mtimeMs: now },
  ], now)).toBe(null)
  // a plan in another dir does not count; newest fresh context wins
  expect(freshContextPhase([
    { dir: '07-x', name: '07-CONTEXT.md', mtimeMs: now - 3 * min },
    { dir: '08-y', name: '08-CONTEXT.md', mtimeMs: now - min },
    { dir: '09-z', name: '08-01-PLAN.md', mtimeMs: now },
  ], now)).toBe('08')
  // gsd-handoff takes ^[0-9]{1,2}$: decimal phases are skipped
  expect(freshContextPhase([{ dir: '25.1-h', name: '25.1-CONTEXT.md', mtimeMs: now }], now)).toBe(null)
})

test('gsdState from STATE.md', () => {
  const text = '---\nstatus: executing\nstopped_at: x\n---\n\n**Current focus:** Phase 01 — setup\n'
  expect(gsdState(text)).toBe('P01 executing')
  expect(gsdState('---\nstatus: ready_to_plan\n---\n')).toBe('ready_to_plan')
  expect(gsdState('# nothing')).toBe(undefined)
})

test('checksMark', () => {
  expect(checksMark([])).toBe('')
  expect(checksMark([{ conclusion: 'SUCCESS' }, { state: 'SUCCESS' }, { conclusion: 'SKIPPED' }])).toBe('✓')
  expect(checksMark([{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }])).toBe('✗')
  expect(checksMark([{ conclusion: '' }, { state: 'PENDING' }])).toBe('…')
})
