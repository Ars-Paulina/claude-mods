import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The engine beneath the mod, faked: files the mod reads, git, the store bridge (captured, never
// run) and the core answers for each event. The test kit has no real fs or process.

const PHRASES = JSON.stringify({ phrases: ['done', 'all tests pass', 'tests pass', 'shipped', 'fixed'], negators: ['not', 'yet'] })
const PINS = JSON.stringify({ rules: [{ id: 'pnpm-only', text: 'pnpm only', command: '(^|[\\s;&|(])npm\\s' }] })

type Payload = { stateDir: string; sid: string; ops: { op: string; row?: any; patch?: any; rec?: any }[] }

function world(on: On, env: Record<string, string> = {}, files: Record<string, string> = {}, opts: { versionThrows?: boolean } = {}) {
  const stores: Payload[] = []
  const core: { event: string; e: unknown }[] = []
  const all: Record<string, string> = {
    '/h/.claude/state/overseer/tested-version': '2.1\n',
    ...files,
  }
  mock.env(on, { HOME: '/h', ...env })
  mock.clock(on, { now: Date.UTC(2026, 10, 24) })
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('session.version', () => {
    if (opts.versionThrows) throw new Error('boom')
    return { value: { version: '2.1.331', base: '2.1.331', builtAt: '' } } as never
  })
  on('fs.exists', ($, e: any) => ({ value: e.path in all || /\/data\/(claim-phrases|pins)\.json$/.test(e.path) }) as never)
  on('fs.stat', ($, e: any) => ({ value: { kind: 'file', size: (all[e.path] ?? '').length, mtimeMs: 0, isLink: false } }) as never)
  on('fs.read', ($, e: any) => {
    if (e.path.endsWith('/data/claim-phrases.json')) return { value: PHRASES } as never
    if (e.path.endsWith('/data/pins.json')) return { value: PINS } as never
    if (e.path in all) return { value: all[e.path] } as never
    throw new Error(`ENOENT ${e.path}`)
  })
  on('process.run', ($, e: any) => {
    const argv: string[] = e.argv
    if (argv[0] === 'node' && argv[1]!.endsWith('/scripts/store.cjs')) {
      stores.push(JSON.parse(e.init.stdin))
      return { value: { exitCode: 0, stdout: '{"ok":true}', stderr: '' } } as never
    }
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return { value: { exitCode: 0, stdout: '/repo\n', stderr: '' } } as never
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  for (const event of ['turn.complete', 'prompt.submit', 'session.start'] as const) {
    on(event, ($, e: any) => { core.push({ event, e }); return (event === 'turn.complete' ? { text: e.answer } : event === 'session.start' ? { cwd: '/repo' } : { text: e.text }) as never })
  }
  on('tool.call', ($, e: any) => { core.push({ event: 'tool.call', e }); return { ref: 1, result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' } as never })
  const ops = () => stores.flatMap(s => s.ops)
  const rows = () => ops().filter(o => o.op === 'log').map(o => o.row)
  return { stores, core, ops, rows }
}

const turn = (answer: string, extra: object = {}) => ({ answer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra }) as never

test('[RED-1] a throw inside turn.complete: event passes on unchanged, dot grey, blind logged', async ($, on) => {
  const w = world(on, {}, {}, { versionThrows: true })
  const e = turn('All tests pass, shipped.')
  const r: any = await $.turn.complete(e)
  expect(r.text).toBe('All tests pass, shipped.')
  expect(w.core.filter(c => c.event === 'turn.complete').map(c => c.e)).toEqual([e])
  expect(w.ops()).toContainEqual({ op: 'state', patch: { dot: 'grey', blind_reason: 'error' } })
  expect(w.rows().map(r => r.signal)).toEqual(['blind'])
})

test('[GREEN-2] every handled event returns what core returned (0 actions)', async ($, on) => {
  const w = world(on)
  expect(await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)).toEqual({ cwd: '/repo' })
  const p: any = await $.prompt.submit({ text: 'fix it' } as never)
  expect(p.text).toBe('fix it')
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).toEqual({ ref: 1, result: { stdout: 'ok', stderr: '', interrupted: false }, text: 'ok' })
  const t: any = await $.turn.complete(turn('Done.'))
  expect(t.text).toBe('Done.')
  expect(w.stores.length).toBeGreaterThan(0)
})

test('[EDGE-1] OVERSEER_CHECKER=1: the store is never called', async ($, on) => {
  const w = world(on, { OVERSEER_CHECKER: '1' })
  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm i' } as never)
  await $.turn.complete(turn('All tests pass.'))
  expect(w.stores).toEqual([])
})

test('[EDGE-2] OFF file present: the store is never called', async ($, on) => {
  const w = world(on, {}, { '/h/.claude/state/overseer/OFF': '' })
  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm i' } as never)
  await $.turn.complete(turn('All tests pass.'))
  expect(w.stores).toEqual([])
})

test('[EDGE-6] agentId set: the store is never called; agentId undefined: observed', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'Bash', command: 'npm i', agentId: 'a1' } as never)
  await $.turn.complete(turn('All tests pass.', { agentId: 'a1' }))
  expect(w.stores).toEqual([])
  await $.tool.call({ tool: 'Bash', command: 'npm i' } as never)
  expect(w.rows().map(r => r.signal)).toEqual(['pin_violation'])
})

test('[EDGE-7] OVERSEER_FAILTEST=1: observe throws, event unchanged, dot grey with reason failtest', async ($, on) => {
  const w = world(on, { OVERSEER_FAILTEST: '1' })
  const r: any = await $.turn.complete(turn('Done.'))
  expect(r.text).toBe('Done.')
  expect(w.ops()).toContainEqual({ op: 'state', patch: { dot: 'grey', blind_reason: 'failtest' } })
})

test('session.start: prunes approvals older than 60 days', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false } as never)
  expect(w.ops()).toEqual([{ op: 'prune', days: 60 }])
})

test('prompt.submit: approval record sent to the bridge; rating token and hidden prompt are not', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'yes, push branch x' } as never)
  await $.prompt.submit({ text: 'r12 y' } as never)
  await $.prompt.submit({ text: 'hidden', isMeta: true } as never)
  const recs = w.ops().filter(o => o.op === 'approval').map(o => o.rec)
  expect(recs.length).toBe(1)
  expect(recs[0].exact_text).toBe('yes, push branch x')
  expect(recs[0].scope).toBe(null)
})

test('tool.call: pinned-rule break logged as would warn; plain call logs a timing row', async ($, on) => {
  const w = world(on)
  await $.tool.call({ tool: 'Bash', command: 'npm i' } as never)
  await $.tool.call({ tool: 'Bash', command: 'pnpm i' } as never)
  expect(w.rows().map(r => [r.signal, r.would])).toEqual([['pin_violation', 'warn'], ['timing', 'none']])
})

test('blind: the classic PostToolUse count saw a tool call that tool.call never parsed -> no_events, grey', async ($, on) => {
  const w = world(on, {}, { '/h/.claude/state/overseer/raw/sess-1.count': '.' })
  await $.turn.complete(turn('ok'))
  expect(w.rows().map(r => [r.signal, r.detail.reason])).toEqual([['blind', 'no_events']])
  expect(w.ops().find(o => o.op === 'state')!.patch.dot).toBe('grey')
})

test('blind: counts match -> not blind; the next turn only counts new raw bytes', async ($, on) => {
  const w = world(on, {}, { '/h/.claude/state/overseer/raw/sess-1.count': '.' })
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete(turn('ok'))
  await $.turn.complete(turn('ok again'))
  expect(w.rows().filter(r => r.signal === 'blind')).toEqual([])
})

test('the compaction count kept by the classic hook reaches the stale signal', async ($, on) => {
  const w = world(on, {}, { '/repo/package.json': '{"scripts":{"test":"x"}}', '/h/.claude/state/overseer/sess-1.json': '{"compactions":2}' })
  await $.prompt.submit({ text: 'go' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(turn('Done.'))
  await $.turn.complete(turn('Done, shipped.'))
  const stale = w.rows().find(r => r.signal === 'stale')
  expect(stale.would).toBe('handoff')
  expect(stale.detail.compactions).toBe(2)
})

test('prompt.submit from a task notification or an agent hand-back is not recorded', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'note', origin: { kind: 'task-notification' } } as never)
  await $.prompt.submit({ text: 'report', origin: { kind: 'peer' } } as never)
  await $.prompt.submit({ text: 'typed', origin: { kind: 'sdk' } } as never)
  expect(w.ops().filter(o => o.op === 'approval').map(o => o.rec.exact_text)).toEqual(['typed'])
})

test('turn.complete: code repo, done-claim with no test run -> would block; state written', async ($, on) => {
  const w = world(on, {}, { '/repo/package.json': JSON.stringify({ scripts: { test: 'vitest' } }) })
  await $.prompt.submit({ text: 'fix the bug' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(turn('All tests pass, shipped.'))
  const claim = w.rows().find(r => r.signal === 'claim')
  expect(claim.would).toBe('block')
  expect(claim.detail.missing).toEqual(['test run'])
  expect(claim.detail.task_type).toBe('code')
  const state = w.ops().filter(o => o.op === 'state').pop()!.patch
  expect(state.dot).toBe('yellow')
  expect(state.cc_version).toBe('2.1.331')
})

test('turn.complete: no tested-version stamped -> grey, reason unstamped', async ($, on) => {
  const w = world(on, { OVERSEER_STATE_DIR: '/elsewhere' })
  await $.turn.complete(turn('hello'))
  expect(w.rows().map(r => [r.signal, r.detail.reason])).toEqual([['blind', 'unstamped']])
})
