import { expect, test } from 'claude-code/testing'

import { addLive, fit, isBusyTyped, isTyped, label, rebuild } from './index'

test('label: slash command as /name args, first line only', async () => {
  expect(label('/review i want a mod\nmore', 'command')).toBe('/review i want a mod')
  expect(label('<command-message>prompts</command-message>\n<command-name>/prompts</command-name>\n<command-args>x y</command-args>')).toBe('/prompts x y')
  expect(label('\n\nfirst line\nsecond')).toBe('first line')
})

test('isTyped drops engine rows, keeps typed prompts and commands', async () => {
  expect(isTyped('<task-notification>done</task-notification>')).toBe(false)
  expect(isTyped('<system-reminder>x</system-reminder>')).toBe(false)
  expect(isTyped('Base directory for this skill: /x')).toBe(false)
  expect(isTyped('')).toBe(false)
  expect(isTyped('pane')).toBe(true)
  expect(isTyped('<command-name>/prompts</command-name>')).toBe(true)
})

test('rebuild: shared uuid keeps the backfill entry, live sorts after backfill', async () => {
  const back = [{ uuid: 'a', label: 'old', pos: -2 }, { uuid: 'b', label: 'old b', pos: -1 }]
  const live = [{ uuid: 'c', label: 'new', pos: 1 }, { uuid: 'b', label: 'dup', pos: 2 }]
  expect(rebuild(back, live).map(i => i.label)).toEqual(['old', 'old b', 'new'])
  expect(rebuild(back, rebuild(back, live).filter(i => i.pos > 0))).toEqual(rebuild(back, live))
})

test('fit cuts to the width with an ellipsis', async () => {
  const s = fit('a'.repeat(200), 40)
  expect(s.length).toBe(40)
  expect(s.endsWith('…')).toBe(true)
  expect(fit('short', 40)).toBe('short')
})

const it = (uuid: string, label: string, pos: number, queued?: true) => (queued ? { uuid, label, pos, queued } : { uuid, label, pos })

test('isBusyTyped: only a person-typed prompt sent over a running turn', async () => {
  const e = { text: 'hi', turnId: 't1', origin: { kind: 'composer' } }
  expect(isBusyTyped(e)).toBe(true)
  expect(isBusyTyped({ ...e, origin: { kind: 'bridge' } })).toBe(true)
  expect(isBusyTyped({ ...e, turnId: undefined })).toBe(false) // idle prompt
  expect(isBusyTyped({ ...e, origin: { kind: 'plugin' } })).toBe(false)
  expect(isBusyTyped({ ...e, isMeta: true })).toBe(false)
  expect(isBusyTyped({ ...e, command: { name: 'x' } })).toBe(false)
  expect(isBusyTyped({ ...e, text: '<task-notification>x</task-notification>' })).toBe(false)
})

test('addLive: two identical busy-typed prompts are two rows', async () => {
  const two = addLive(addLive([], it('queued-1', 'same', 1), true), it('queued-2', 'same', 2), true)
  expect(two).toEqual([it('queued-1', 'same', 1, true), it('queued-2', 'same', 2, true)])
})

test('addLive: a normal row takes the oldest queued row with its label; earlier queued rows were folded and settle', async () => {
  const q = [it('queued-1', 'a', 1, true), it('queued-2', 'b', 2, true), it('queued-3', 'b', 3, true)]
  // b waits its turn: a was folded (settles, keeps its row), the first b gets the real uuid, the second b stays queued
  expect(addLive(q, it('u9', 'b', 4), false)).toEqual([it('queued-1', 'a', 1), it('u9', 'b', 2), it('queued-3', 'b', 3, true)])
  // the head matches: nothing settles
  expect(addLive(q, it('u9', 'a', 4), false)).toEqual([it('u9', 'a', 1), it('queued-2', 'b', 2, true), it('queued-3', 'b', 3, true)])
})

test('addLive: a normal row with no queued twin appends and settles everything queued', async () => {
  const q = [it('queued-1', 'a', 1, true)]
  expect(addLive(q, it('u9', 'idle', 2), false)).toEqual([it('queued-1', 'a', 1), it('u9', 'idle', 2)])
  expect(addLive([], it('u9', 'idle', 1), false)).toEqual([it('u9', 'idle', 1)])
})
