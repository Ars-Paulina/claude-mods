'use strict'
// node --test 'plugins/session-overseer/scripts/*.test.cjs'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

const STORE = path.join(__dirname, 'store.cjs')
// Built at run time so no scanner sees one literal token.
const TOKEN = 'ghp_' + 'A1b2'.repeat(9)

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-store-'))
}

function stubMasker(dir, body) {
  const file = path.join(dir, 'mask-stub.cjs')
  fs.writeFileSync(file, body)
  return file
}
const MASK_OK = "module.exports = { maskString: t => ({ text: t.replace(/ghp_[A-Za-z0-9]{36}/g, '[MASKED:github_token]'), hits: [] }) }"
const MASK_THROWS = "module.exports = { maskString: () => { throw new Error('mask broke') } }"

function store(payload) {
  return spawnSync('node', [STORE], { input: JSON.stringify(payload), encoding: 'utf8' })
}
const mode = p => fs.statSync(p).mode & 0o777
const lines = p => fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l))

test('log + state + approval: dirs 0700, files 0600, masked text stored', () => {
  const home = tmp()
  const stateDir = path.join(home, '.claude', 'state', 'overseer')
  const maskJs = stubMasker(home, MASK_OK)
  const sid = '00000000-0000-0000-0000-000000000000'
  const r = store({
    stateDir, maskJs, sid, t0: Date.now() - 5, ops: [
      { op: 'log', row: { event: 'tool.call', signal: 'timing', would: 'none', detail: { seq: 1 } } },
      { op: 'approval', rec: { message_id: 'm1', ts: '2026-01-01T00:00:00.000Z', exact_text: `use ${TOKEN} now`, scope: null } },
      { op: 'state', patch: { dot: 'green' } },
    ],
  })
  assert.equal(r.status, 0, r.stderr)
  for (const d of [stateDir, path.join(stateDir, 'log'), path.join(stateDir, 'approvals')]) assert.equal(mode(d), 0o700, d)
  for (const f of [path.join(stateDir, 'log', `${sid}.jsonl`), path.join(stateDir, 'approvals', `${sid}.jsonl`), path.join(stateDir, `${sid}.json`)]) assert.equal(mode(f), 0o600, f)
  const [row] = lines(path.join(stateDir, 'log', `${sid}.jsonl`))
  assert.equal(row.sid, sid)
  assert.equal(typeof row.ms, 'number')
  assert.ok(row.ms >= 5)
  const [rec] = lines(path.join(stateDir, 'approvals', `${sid}.jsonl`))
  assert.equal(rec.exact_text, 'use [MASKED:github_token] now')
  assert.ok(!fs.readFileSync(path.join(stateDir, 'approvals', `${sid}.jsonl`), 'utf8').includes(TOKEN))
  assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, `${sid}.json`), 'utf8')).dot, 'green')
})

test('[EDGE-3] masker throws or is missing: nothing stored, blind row logged', () => {
  for (const maskJs of [stubMasker(tmp(), MASK_THROWS), '/nonexistent/mask.cjs']) {
    const stateDir = path.join(tmp(), 'state')
    const r = store({ stateDir, maskJs, sid: 's1', ops: [{ op: 'approval', rec: { message_id: 'm1', exact_text: `key ${TOKEN}`, scope: null } }] })
    assert.equal(r.status, 0, r.stderr)
    assert.ok(!fs.existsSync(path.join(stateDir, 'approvals', 's1.jsonl')))
    const [row] = lines(path.join(stateDir, 'log', 's1.jsonl'))
    assert.deepEqual([row.signal, row.detail.reason], ['blind', 'masker'])
  }
})

test('approval text is capped at 4 KB after masking', () => {
  const dir = tmp()
  const stateDir = path.join(dir, 'state')
  store({ stateDir, maskJs: stubMasker(dir, MASK_OK), sid: 's1', ops: [{ op: 'approval', rec: { message_id: 'm1', exact_text: 'é'.repeat(5000), scope: null } }] })
  const [rec] = lines(path.join(stateDir, 'approvals', 's1.jsonl'))
  assert.ok(Buffer.byteLength(rec.exact_text, 'utf8') <= 4096)
  assert.ok(!rec.exact_text.includes('�'))
})

test('20 concurrent appends: every line parses', async () => {
  const stateDir = path.join(tmp(), 'state')
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((resolve, reject) => {
    const c = spawn('node', [STORE])
    c.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    c.stdin.end(JSON.stringify({ stateDir, sid: 's1', ops: [{ op: 'log', row: { event: 'tool.call', signal: 'timing', would: 'none', detail: { i, pad: 'x'.repeat(2000) } } }] }))
  })))
  const rows = lines(path.join(stateDir, 'log', 's1.jsonl'))
  assert.equal(rows.length, 20)
  assert.deepEqual(rows.map(r => r.detail.i).sort((a, b) => a - b), Array.from({ length: 20 }, (_, i) => i))
})

test('prune drops approval files older than 60 days only', () => {
  const stateDir = path.join(tmp(), 'state')
  const adir = path.join(stateDir, 'approvals')
  fs.mkdirSync(adir, { recursive: true })
  fs.writeFileSync(path.join(adir, 'old.jsonl'), '{}\n')
  fs.writeFileSync(path.join(adir, 'new.jsonl'), '{}\n')
  const old = (Date.now() - 61 * 86_400_000) / 1000
  fs.utimesSync(path.join(adir, 'old.jsonl'), old, old)
  assert.equal(store({ stateDir, sid: 's1', ops: [{ op: 'prune', days: 60 }] }).status, 0)
  assert.deepEqual(fs.readdirSync(adir), ['new.jsonl'])
})

test('bad input is refused: relative state dir, unsafe session id', () => {
  assert.equal(store({ stateDir: 'rel', sid: 's1', ops: [] }).status, 1)
  assert.equal(store({ stateDir: tmp(), sid: '../x', ops: [] }).status, 1)
})
