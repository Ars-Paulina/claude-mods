import { expect, test } from 'claude-code/testing'

import { bar, clockText, CTX_RE, ctxBridgeDoc, graftText, isSafeId, normalizedUsed, rateLimitDoc, renderRows, snapshotDoc, toEpochSec } from './format'

const info = {
  model: 'Sonnet 5', sessionId: '0008955e-f588-4945-b84f-29874397c95f', project: 'shop', branch: 'main',
  turns: 5, contextPercent: 50, cwd: '/p/shop', transcript: '/t/x.jsonl', isDirty: true, sentAt: 0, receivedAt: 0,
  rateLimits: [
    { kind: 'five_hour', percentUsed: 33.2, resetsAt: '2026-11-24T20:00:00Z' },
    { kind: 'seven_day', percentUsed: 81 },
    { kind: 'spend_limit', percentUsed: 1 },
  ],
}

test('bar is clamped to ten cells', () => {
  expect(bar(0)).toBe('░'.repeat(10))
  expect(bar(45)).toBe('████░░░░░░')
  expect(bar(250)).toBe('█'.repeat(10))
})

test('context fill is normalised like the old renderer (50% raw -> 60% used)', () => {
  expect(normalizedUsed(50)).toBe(60)
  expect(normalizedUsed(0)).toBe(0)
  expect(normalizedUsed(95)).toBe(100)
})

test('rows hold the same segments, branch carries the dirty star', () => {
  const rows = renderRows(info)
  expect(rows.row1.includes('Ctx ██████░░░░ 60%')).toBe(true)
  expect(rows.row1.includes('5h ███░░░░░░░ 33%')).toBe(true)
  expect(rows.row1.includes('7d ████████░░ 81%')).toBe(true)
  expect(rows.row1.includes('spend')).toBe(false)
  expect(rows.row2).toBe('Sonnet 5 │ 0008955e │ shop │ main* │ T:5')
  expect(rows.row3).toBe('/t/x.jsonl')
  expect(clockText(0)).toBe('?')
})

test('missing data degrades, never throws', () => {
  const bare = renderRows({ model: 'X' })
  expect(bare.row2).toBe('X')
  expect(bare.row1.includes('Ctx')).toBe(false)
  expect(renderRows({ contextPercent: 99 }).row1.startsWith('💀 Ctx')).toBe(true)
})

test('hermes snapshot keeps the keys and a Ctx N% a reader can regex out', () => {
  const doc = snapshotDoc(info, renderRows(info), 1_700_000_000_000)
  expect(Number(CTX_RE.exec(doc.rendered)![1])).toBe(60)
  expect(doc.session_id).toBe(info.sessionId)
  expect(doc.captured_at).toBe(1_700_000_000)
  expect(doc.payload.rate_limits['five_hour']!.used_percentage).toBe(33.2)
  expect(doc.payload.transcript_path).toBe('/t/x.jsonl')
})

test('rate-limit file: supervisor keys, resets_at in epoch seconds, null window stays null', () => {
  const doc = rateLimitDoc(info, 5000)!
  expect(Object.keys(doc).sort()).toEqual(['cwd', 'five_hour', 'session_id', 'seven_day', 'transcript', 'written_at'])
  expect(doc.written_at).toBe(5000)
  expect(doc.five_hour).toEqual({ used_percentage: 33.2, resets_at: 1_795_550_400 })
  expect(doc.seven_day).toEqual({ used_percentage: 81, resets_at: null })
  expect(rateLimitDoc({ ...info, rateLimits: [] }, 1)).toBe(null)
})

test('context bridge: gsd-context-monitor keys, timestamp in seconds', () => {
  expect(ctxBridgeDoc(info, 1_700_000_123_999)).toEqual({
    session_id: info.sessionId, remaining_percentage: 50, used_pct: 60, timestamp: 1_700_000_123,
  })
  expect(ctxBridgeDoc({ ...info, contextPercent: undefined }, 1)).toBe(null)
})

test('session id guard refuses path tricks', () => {
  expect(isSafeId(info.sessionId)).toBe(true)
  expect(isSafeId('../x')).toBe(false)
  expect(isSafeId('')).toBe(false)
  expect(toEpochSec('nope')).toBe(null)
  expect(toEpochSec(1_795_550_400)).toBe(1_795_550_400)
})

test('graft segment follows graft: nodes/edges and freshness', () => {
  expect(graftText('{"nodeCount":10,"edgeCount":20}')).toBe('10 nodes / 20 edges · ✓ synced')
  expect(graftText('{"nodeCount":10,"edgeCount":20,"dirty":true,"staleCount":3}')).toBe('10 nodes / 20 edges · ⚠ 3 stale')
  expect(graftText('{"nodeCount":0}')).toBe('')
  expect(graftText(null)).toBe('')
  expect(graftText('not json')).toBe('')
})
