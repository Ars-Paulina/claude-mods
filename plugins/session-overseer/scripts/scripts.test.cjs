'use strict'
// node --test 'plugins/session-overseer/scripts/*.test.cjs'
// Local scripts, the classic command hooks, real-git checks and the public-repo data scan.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')

const PLUGIN = path.join(__dirname, '..')
const FIX = path.join(PLUGIN, 'test', 'fixtures')
const SID = '00000000-0000-0000-0000-000000000000'
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-scripts-'))
const node = (args, env = {}) => spawnSync('node', args, { encoding: 'utf8', env: { ...process.env, ...env } })
const lines = p => fs.readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l))

// ---- classic command hooks (scripts/classic.cjs) ----

const { handle } = require('./classic.cjs')

test('[EDGE-8] one compaction (SessionStart compact twice within 5 s, PostCompact not wired) -> count 1', () => {
  const dir = tmp()
  const env = { OVERSEER_STATE_DIR: dir }
  assert.equal(handle('compact', { session_id: SID, source: 'compact' }, env, 1_000_000), 'compaction')
  assert.equal(handle('compact', { session_id: SID, source: 'compact' }, env, 1_003_000), 'dedupe')
  const rows = lines(path.join(dir, 'log', `${SID}.jsonl`))
  assert.deepEqual(rows.map(r => [r.signal, r.detail.count]), [['compaction', 1]])
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')).compactions, 1)
  // A later one counts.
  assert.equal(handle('compact', { session_id: SID, source: 'compact' }, env, 1_010_000), 'compaction')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `${SID}.json`), 'utf8')).compactions, 2)
  // hooks.json: SessionStart matcher compact is the one compaction source; PostCompact is not hooked.
  const hooks = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'))
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'compact')
  assert.equal(hooks.hooks.PostCompact, undefined)
})

test('classic tool hook: one byte per main-loop call; bails on checker, OFF, subagent', () => {
  const dir = tmp()
  const env = { OVERSEER_STATE_DIR: dir }
  handle('tool', { session_id: SID }, env)
  handle('tool', { session_id: SID }, env)
  handle('tool', { session_id: SID, agent_id: 'a1' }, env)
  handle('tool', { session_id: SID }, { ...env, OVERSEER_CHECKER: '1' })
  const count = path.join(dir, 'raw', `${SID}.count`)
  assert.equal(fs.statSync(count).size, 2)
  assert.equal(fs.statSync(count).mode & 0o777, 0o600)
  fs.writeFileSync(path.join(dir, 'OFF'), '')
  assert.equal(handle('tool', { session_id: SID }, env), 'bail')
  assert.equal(handle('compact', { session_id: SID, source: 'compact' }, env), 'bail')
})

test('classic.cjs as a process: prints nothing, exits 0 even on garbage input', () => {
  const r = spawnSync('node', [path.join(__dirname, 'classic.cjs'), 'compact'], { input: 'not json', encoding: 'utf8', env: { ...process.env, OVERSEER_STATE_DIR: tmp() } })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

// ---- claims vs git on a real temp repo ----

test('gitcheck on a temp repo: present -> match, absent -> missing, sha checked', async () => {
  const repo = tmp()
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' })
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('commit', '-qm', 'a')
  const sha = git('rev-parse', '--short', 'HEAD').trim()
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n')
  const { gitCheck } = await import('../hooks/gitcheck.ts')
  const run = async (argv, cwd) => {
    const r = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' })
    return { exitCode: r.status ?? 1, stdout: r.stdout }
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const since = new Date(Date.now() - 3_600_000).toISOString()
  const hit = await gitCheck(run, sleep, repo, { files: ['a.txt', 'b.txt'], shas: [sha] }, since, [path.join(repo, 'b.txt')], 5_000)
  assert.equal(hit.status, 'match')
  assert.deepEqual(hit.unauthored, ['a.txt'])
  const miss = await gitCheck(run, sleep, repo, { files: ['c.txt'], shas: ['deadbee1'] }, since, [], 5_000)
  assert.deepEqual([miss.status, miss.files['c.txt'], miss.shas.deadbee1], ['missing', 'missing', 'missing'])
})

// ---- done-claim fixture scoring ----

test('[GREEN-1] detector with the shipped phrase list scores >= 0.90 on the synthetic fixture (>=30 pos, >=30 neg)', () => {
  const rows = lines(path.join(FIX, 'synthetic-claims.jsonl'))
  assert.ok(rows.filter(r => r.label === 'pos').length >= 30)
  assert.ok(rows.filter(r => r.label === 'neg').length >= 30)
  const r = node([path.join(__dirname, 'score-fixture.ts'), path.join(FIX, 'synthetic-claims.jsonl'), '--gate', '0.9'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(JSON.parse(r.stdout).overall.accuracy >= 0.9)
})

test('score-fixture: pointer rows resolved through the reader; a wrong sha is reported, not scored', () => {
  const dir = tmp()
  const data = path.join(dir, 'fs.json')
  fs.writeFileSync(data, JSON.stringify({ [SID]: [[10, 'assistant', 'All tests pass, shipped.'], [11, 'assistant', 'Should I push?']] }))
  const sha = t => createHash('sha256').update(t).digest('hex')
  const fixture = path.join(dir, 'f.jsonl')
  fs.writeFileSync(fixture, [
    { id: 'c1', session_id: SID, line: 10, sha: sha('All tests pass, shipped.'), label: 'pos', task_type: 'code', split: 'holdout' },
    { id: 'c2', session_id: SID, line: 11, sha: sha('Should I push?'), label: 'neg', task_type: 'code', split: 'holdout' },
    { id: 'c3', session_id: SID, line: 11, sha: sha('something else'), label: 'neg', task_type: 'code', split: 'holdout' },
  ].map(r => JSON.stringify(r)).join('\n'))
  const r = node([path.join(__dirname, 'score-fixture.ts'), fixture], { FSEARCH_BIN: path.join(FIX, 'fake-fsearch.cjs'), FAKE_FSEARCH_DATA: data })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual([out.overall.n, out.overall.correct, out.sha_mismatch], [2, 2, ['c3']])
  assert.equal(out.per_task_type.code.result, 'insufficient data')
})

// ---- golden replay ----

test('replay: golden transcript passes; --help runs under Node type stripping', () => {
  assert.equal(node([path.join(__dirname, 'replay.ts')]).status, 0)
  const h = node([path.join(__dirname, 'replay.ts'), '--help'])
  assert.equal(h.status, 0)
  assert.match(h.stdout, /usage: node scripts\/replay.ts/)
})

test('[RED-3] corrupted golden transcript -> exit 1 (broken JSON, or an expected row changed)', () => {
  const dir = tmp()
  const broken = path.join(dir, 'broken.json')
  fs.writeFileSync(broken, '{"events": [')
  assert.equal(node([path.join(__dirname, 'replay.ts'), broken]).status, 1)
  const g = JSON.parse(fs.readFileSync(path.join(FIX, 'golden-transcript.json'), 'utf8'))
  g.expected[1].would = 'none'
  const changed = path.join(dir, 'changed.json')
  fs.writeFileSync(changed, JSON.stringify(g))
  assert.equal(node([path.join(__dirname, 'replay.ts'), changed]).status, 1)
})

test('golden covers loop, pin, stale, approval, claim block', () => {
  const g = JSON.parse(fs.readFileSync(path.join(FIX, 'golden-transcript.json'), 'utf8'))
  const signals = new Set(g.expected.map(r => r.signal))
  for (const s of ['loop', 'pin_violation', 'stale', 'approval', 'claim']) assert.ok(signals.has(s), s)
  assert.ok(g.expected.some(r => r.signal === 'claim' && r.would === 'block'))
})

test('replay --stamp writes major.minor to tested-version (0600)', () => {
  const dir = tmp()
  const r = node([path.join(__dirname, 'replay.ts'), '--stamp', '--cc-version', '2.1.331', '--state-dir', dir])
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.readFileSync(path.join(dir, 'tested-version'), 'utf8'), '2.1\n')
  assert.equal(fs.statSync(path.join(dir, 'tested-version')).mode & 0o777, 0o600)
  // A failing replay never stamps.
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, '{')
  const dir2 = tmp()
  node([path.join(__dirname, 'replay.ts'), bad, '--stamp', '--cc-version', '2.1.331', '--state-dir', dir2])
  assert.ok(!fs.existsSync(path.join(dir2, 'tested-version')))
})

// ---- history replay + scoring (fake reader) ----

function fakeSessions(dir) {
  const E = '.' + 'env'
  const data = {
    [SID]: [
      [1, 'user', 'Fix the parser please.'],
      [2, 'tool', 'Bash {"command": "pnpm test"}'],
      [3, 'result', 'Exit code 1\nFAIL x'],
      [4, 'tool', 'Bash {"command": "pnpm test"}'],
      [5, 'result', 'Exit code 1\nFAIL x'],
      [6, 'tool', 'Bash {"command": "pnpm test"}'],
      [7, 'result', 'Exit code 1\nFAIL x'],
      [8, 'tool', `Read {"file_path": "/r/${E}"}`],
      [9, 'result', '(masked)'],
      [10, 'tool', 'Edit {"file_path": "/r/a.ts", "old_string": "a", "new_string": "b"}'],
      [11, 'result', 'ok'],
      [12, 'assistant', 'All tests pass, done.'],
    ],
    '11111111-1111-1111-1111-111111111111': [
      [1, 'user', 'What does this function do?'],
      [2, 'assistant', 'It parses dates; here is how.'],
    ],
  }
  const file = path.join(dir, 'fs.json')
  fs.writeFileSync(file, JSON.stringify(data))
  return file
}

test('replay-history: reader rows -> pointer-only rows per session; score-replay: caught k of n per class', () => {
  const dir = tmp()
  const data = fakeSessions(dir)
  const labels = path.join(dir, 'labels.csv')
  fs.writeFileSync(labels, [
    'session_id,stratum,suggested,label,canary_real_decay,old_hooks_fired,evidence_pointer,notes',
    `${SID},git-heavy,,false_done;loop,,,"L12","a, quoted note"`,
    '11111111-1111-1111-1111-111111111111,no-canary,,ok,,,,',
    '22222222-2222-2222-2222-222222222222,no-canary,,ok,,,,',
  ].join('\n') + '\n')
  const out = path.join(dir, 'replay')
  const env = { FSEARCH_BIN: path.join(FIX, 'fake-fsearch.cjs'), FAKE_FSEARCH_DATA: data }
  const r = node([path.join(__dirname, 'replay-history.ts'), labels, '--out', out], env)
  assert.equal(r.status, 0, r.stderr)
  const summary = JSON.parse(r.stdout)
  assert.deepEqual([summary.sessions, summary.replayed, summary.failed.length], [3, 2, 1])
  const [header, ...rows] = lines(path.join(out, `${SID}.jsonl`))
  assert.equal(header.replayable.claim_vs_git, false)
  assert.deepEqual(rows.map(x => [x.signal, x.line]), [['approval', 1], ['loop', 6], ['pin_violation', 8], ['claim', 12]])
  // Pointers only: no transcript text in the output.
  assert.ok(!fs.readFileSync(path.join(out, `${SID}.jsonl`), 'utf8').includes('Fix the parser'))

  const s = node([path.join(__dirname, 'score-replay.ts'), '--labels', labels, '--replay', out])
  assert.equal(s.status, 0, s.stderr)
  const score = JSON.parse(s.stdout)
  assert.deepEqual(score.unreplayed, ['22222222-2222-2222-2222-222222222222'])
  assert.deepEqual([score.classes.loop.all.k, score.classes.loop.all.n, score.classes.loop.all.fp], [1, 1, 0])
  assert.deepEqual([score.classes.false_done.all.k, score.classes.false_done.all.n], [1, 1])
  assert.equal(score.classes.false_done.by_stratum['git-heavy'].k, 1)
  assert.deepEqual([score.classes.stale.all.n, score.classes.stale.all.fp], [0, 1])
})

// ---- data files stay in step ----

test('data/pins.json: the shipped patterns give the [EDGE-5] answers', async () => {
  const { compilePins, pinViolations } = await import('../hooks/pins.ts')
  const pins = compilePins(JSON.parse(fs.readFileSync(path.join(PLUGIN, 'data', 'pins.json'), 'utf8')).rules)
  const E = '.' + 'env'
  assert.equal(JSON.parse(fs.readFileSync(path.join(PLUGIN, 'data', 'pins.json'), 'utf8')).rules.length, 10)
  for (const [tool, input] of [['Bash', { command: 'pnpm i' }], ['Bash', { command: `cat ${E}.example` }], ['Read', { file_path: `/x/${E}.local` }]]) assert.deepEqual(pinViolations(pins, tool, input), [])
  for (const [tool, input] of [['Bash', { command: 'npm i' }], ['Bash', { command: `cat ${E}` }], ['Bash', { command: `source ./${E}` }], ['Read', { file_path: `/x/${E}` }]]) assert.equal(pinViolations(pins, tool, input).length, 1)
})

// ---- public repo: no real data (S2.9) ----

const UUID = new RegExp('\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b', 'gi')
const HOME_PATH = new RegExp('/ho' + 'me/')
const NAME = new RegExp('\\b' + 'ped' + 'ro' + '\\b', 'i')
// Synthetic ids used by tests and fixtures: all one repeated digit.
const SYNTHETIC = /^([0-9])\1{7}-\1{4}-\1{4}-\1{4}-\1{12}$/

function scan(root) {
  const hits = []
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      const rel = path.relative(root, p)
      // Generated by `claude plugin` and gitignored: never committed, so not scanned.
      if (e.isDirectory()) { if (rel !== path.join('.claude-plugin', 'types') && e.name !== 'node_modules') walk(p); continue }
      const text = fs.readFileSync(p, 'utf8')
      for (const u of text.match(UUID) ?? []) if (!SYNTHETIC.test(u)) hits.push(`${rel}: uuid ${u}`)
      if (HOME_PATH.test(text)) hits.push(`${rel}: home path`)
      if (NAME.test(text)) hits.push(`${rel}: personal name`)
    }
  }
  walk(root)
  return hits
}

test('[S2.9] no real data anywhere in the plugin folder (uuids, home paths, personal name)', () => {
  assert.deepEqual(scan(PLUGIN), [])
})

test('[S2.9] the scan catches a planted home path and a real-looking uuid', () => {
  const copy = tmp()
  fs.cpSync(PLUGIN, copy, { recursive: true, filter: src => !src.includes(`${path.sep}.claude-plugin${path.sep}types`) })
  fs.writeFileSync(path.join(copy, 'planted.txt'), `see /ho${'me'}/x/notes and ${'3f2a1b4c-0d9e'}-${'4f8a-b7c6-1234567890ab'}`)
  const hits = scan(copy)
  assert.ok(hits.includes('planted.txt: home path'), hits.join('\n'))
  assert.ok(hits.some(h => h.startsWith('planted.txt: uuid')), hits.join('\n'))
})
