import { expect, test } from 'claude-code/testing'

const OFFER = 'Step 2 done.\n\nShall I continue?'
const RUNS = '/home/u/.claude/state/oversee'

function engine(on: any, opts: { run?: object; below?: object; logs?: string[]; isListBroken?: boolean } = {}) {
  on('env.get', () => ({ value: '/home/u' }))
  on('fs.exists', (_: any, e: any) => ({ value: opts.run !== undefined && e.path === RUNS }))
  on('fs.list', () => {
    if (opts.isListBroken) throw new Error('disk gone')

    return { value: [{ name: 'r1.json' }, { name: 'notes.txt' }] }
  })
  on('fs.read', () => ({ value: JSON.stringify(opts.run) }))
  on('ui.log', (_: any, e: any) => { opts.logs?.push(String(e.text ?? e)); return { value: undefined } })
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ result: 'ok' }))
  on('classic.Stop', () => opts.below ?? {})
}

const stop = ($: any, text: string, active = false) =>
  $.classic.Stop({ session_id: 'sess-1', stop_hook_active: active, last_assistant_message: text })

test('an offer blocks the stop with the reason', async ($: any, on: any) => {
  engine(on)
  const r = await stop($, OFFER)
  expect(r.block).toMatch(/pre-approved soft continues/)
  expect(r.block).toMatch(/step addressed to the user/)
})

test('a plain ending and a step for the user pass through', async ($: any, on: any) => {
  engine(on)
  expect((await stop($, 'All done.')).block).toBeUndefined()
  expect((await stop($, '🟢 Saved.\n\n👉 **You:** to finish, type `/resume abc`.')).block).toBeUndefined()
})

test('chain: three nudges in a row, then the turn may end; a fresh stop starts over', async ($: any, on: any) => {
  engine(on)
  expect((await stop($, OFFER)).block).toBeTruthy()
  expect((await stop($, OFFER, true)).block).toBeTruthy()
  expect((await stop($, OFFER, true)).block).toBeTruthy()
  expect((await stop($, OFFER, true)).block).toBeUndefined()
  expect((await stop($, OFFER)).block).toBeTruthy()
})

test('AskUserQuestion this turn means no nudge, until the next prompt', async ($: any, on: any) => {
  engine(on)
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  expect((await stop($, OFFER)).block).toBeUndefined()
  await $.prompt.submit({ text: 'ok' })
  expect((await stop($, OFFER)).block).toBeTruthy()
})

test('a block from a settings Stop hook beneath stands as it is', async ($: any, on: any) => {
  engine(on, { below: { block: 'other hook says no' } })
  expect((await stop($, OFFER)).block).toBe('other hook says no')
})

test('a session in a running oversee run gets no nudge; a paused run or another session does', async ($: any, on: any) => {
  const run = { status: 'running', overseer_session: 'ovr-1', workers: [{ session: 'sess-1' }] }
  engine(on, { run })
  expect((await stop($, OFFER)).block).toBeUndefined()
  run.status = 'paused'
  expect((await stop($, OFFER)).block).toBeTruthy()
  run.status = 'running'
  run.workers = [{ session: 'someone-else' }]
  expect((await stop($, OFFER)).block).toBeTruthy()
})

test('fail open: an error while deciding lets the turn end', async ($: any, on: any) => {
  engine(on, { run: {}, isListBroken: true })
  expect((await stop($, OFFER)).block).toBeUndefined()
})

test('mode warn: logs and toasts, never blocks', { options: { mode: 'warn' } }, async ($: any, on: any) => {
  const logs: string[] = []
  engine(on, { logs })
  expect((await stop($, OFFER)).block).toBeUndefined()
  expect(logs.join('\n')).toMatch(/would have continued \(soft continue\)/)
})

test('mode off: nothing is hooked', { options: { mode: 'off' } }, async ($: any, on: any) => {
  engine(on)
  expect((await stop($, OFFER)).block).toBeUndefined()
})
