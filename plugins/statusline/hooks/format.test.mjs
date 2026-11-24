import assert from 'node:assert/strict'
import { bar, renderRows, snapshotDoc, branchFromHead, CTX_RE, clockText } from './format.ts'

assert.equal(bar(0), '░'.repeat(10))
assert.equal(bar(45), '████░░░░░░')
assert.equal(bar(250), '█'.repeat(10)) // clamped

const info = {
  model: 'Sonnet 5', sessionId: '0008955e-f588-4945-b84f-29874397c95f', project: 'shop', branch: 'main',
  turns: 5, contextPercent: 42.4, cwd: '/p/shop', sentAt: 0, receivedAt: 0,
  rateLimits: [{ kind: 'five_hour', percentUsed: 33.2 }, { kind: 'seven_day', percentUsed: 81 }, { kind: 'spend_limit', percentUsed: 1 }],
}
const rows = renderRows(info)
assert.match(rows.row1, /Ctx ████░░░░░░ 42%/)
assert.match(rows.row1, /5h ███░░░░░░░ 33%/)
assert.match(rows.row1, /7d ████████░░ 81%/)
assert.doesNotMatch(rows.row1, /spend/)
assert.equal(rows.row2, 'Sonnet 5 │ 0008955e │ shop │ main │ T:5')
assert.equal(clockText(0), '?')

// hermes digest reads ctx out of `rendered` with this regex
const doc = snapshotDoc(info, rows, 1_700_000_000_000)
assert.equal(Number(CTX_RE.exec(doc.rendered)[1]), 42)
assert.equal(doc.session_id, info.sessionId)
assert.equal(doc.captured_at, 1_700_000_000)
assert.equal(doc.payload.rate_limits.five_hour.used_percentage, 33.2)

// missing data degrades, never throws
const bare = renderRows({ model: 'X' })
assert.equal(bare.row2, 'X')
assert.doesNotMatch(bare.row1, /Ctx/)
assert.equal(renderRows({ contextPercent: 85 }).row1.startsWith('💀 Ctx'), true)

assert.equal(branchFromHead('ref: refs/heads/feat/x\n'), 'feat/x')
assert.equal(branchFromHead('0123456789abcdef'), '0123456')
assert.equal(branchFromHead(''), null)
console.log('ok')
