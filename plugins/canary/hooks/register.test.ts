import { test, expect, mock } from 'claude-code/testing'

import { classify, score, DEFAULTS, type State } from './canary'

const ID = 'sess-1'

function engine(on: any, store: Record<string, unknown> = {}, toasts: string[] = []) {
  mock.store(on, store)
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($: any, e: any) => {
    toasts.push(String(e.text ?? e))

    return { value: undefined }
  })
  on('session.id', () => ({ value: ID }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [] }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
}

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
const turn = (answer: string, isAborted = false) => ({ answer, durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' }) as never
const compose = ($: any) => $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] })
const pair = async ($: any) => /⟦([0-9A-F]{4}):(\d{3})⟧/.exec((await compose($)).sections.map((x: any) => x.text).join('\n'))?.[0]
const PROSE = 'Here is a full reply with plenty of prose in it, long enough to count.'

const base: State = { token: 'AB12', payload: 345, window: [], misses: 0, alerted: false, plantedAt: 0, touchedAt: 0 }

test('classify: anchored footer, wrong value, wrong token, decay, skip, stale grace', async () => {
  expect(classify(`${PROSE}\n⟦AB12:345⟧`, base, 40)).toBe('HEALTHY')
  expect(classify(`${PROSE}\n⟦AB12:999⟧`, base, 40)).toBe('CONFABULATION')
  expect(classify(`${PROSE}\n⟦FFFF:345⟧`, base, 40)).toBe('WRONG-TOKEN')
  expect(classify(`⟦AB12:345⟧ mentioned mid reply. ${PROSE}`, base, 40)).toBe('DECAY')
  expect(classify('ok', base, 40)).toBe('SKIP')
  expect(classify('```\n' + 'x'.repeat(500) + '\n```\nok', base, 40)).toBe('SKIP')
  const rotated = { ...base, prevToken: 'CD34', prevPayload: 111 }
  expect(classify(`${PROSE}\n⟦CD34:111⟧`, rotated, 40)).toBe('STALE-HEALTHY')
  expect(classify(`${PROSE}\n⟦CD34:222⟧`, rotated, 40)).toBe('CONFABULATION')
})

test('score: alerts once on a full window over the miss rate, re-arms after recovery', async () => {
  const lim = { ...DEFAULTS, window: 5 }
  let s = base
  const alerts: boolean[] = []
  for (let i = 0; i < 5; i++) {
    const r = score(s, PROSE, lim)
    s = r.state
    alerts.push(r.alertNow)
  }
  expect(alerts).toEqual([false, false, false, false, true]) // waits for a FULL window
  expect(s.misses).toBe(5)
  expect(score(s, PROSE, lim).alertNow).toBe(false) // already alerted: no repeat
  for (let i = 0; i < 2; i++) s = score(s, `${PROSE}\n⟦AB12:345⟧`, lim).state
  expect(s.alerted).toBe(false) // 3/5 < 0.8 re-arms
  expect(score(s, 'ok', lim).state).toBe(s) // low-signal turn leaves state alone
})

test('plant: directive goes into the system prompt with the stored pair', async ($, on) => {
  const store: Record<string, unknown> = { [`canary:${ID}`]: { ...base } }
  engine(on, store)
  await start($)
  const r = await compose($)
  const text = r.sections.map((s: any) => s.text).join('\n')
  expect(text).toContain('⟦AB12:345⟧') // resume reuses the pair, no rotation
})

test('fresh session gets a random pair that a restart of the same session keeps', async ($, on) => {
  engine(on)
  await start($)
  const first = await pair($)
  expect(first).toBeTruthy()
  await start($) // resume / compact / clear: same session id
  expect(await pair($)).toBe(first)
})

test('check: misses at turn end raise a toast and an alert section on the next request', async ($, on) => {
  const toasts: string[] = []
  const store: Record<string, unknown> = { [`canary:${ID}`]: { ...base } }
  engine(on, store, toasts)
  await start($)
  for (let i = 0; i < 10; i++) await $.turn.complete(turn(PROSE))
  expect(toasts.length).toBe(1)
  const r = await compose($)
  expect(r.sections.map((s: any) => s.id)).toContain('canary:alert')
  const again = await compose($)
  expect(again.sections.map((s: any) => s.id)).not.toContain('canary:alert') // shown once
})

test('check: aborted and subagent turns are not scored', async ($, on) => {
  const store: Record<string, unknown> = { [`canary:${ID}`]: { ...base } }
  engine(on, store)
  await start($)
  for (let i = 0; i < 9; i++) await $.turn.complete(turn(PROSE))
  await $.turn.complete(turn(PROSE, true))
  await $.turn.complete({ ...(turn(PROSE) as object), agentId: 'sub-1' } as never)
  let ids = (await compose($)).sections.map((x: any) => x.id)
  expect(ids).not.toContain('canary:alert') // window still 9 of 10
  await $.turn.complete(turn(PROSE))
  const r = await compose($)
  expect(r.sections.find((x: any) => x.id === 'canary:alert')?.text).toContain('in 10 of the last 10')
})

test('fail open: a store that throws never breaks start, compose or turn end', async ($, on) => {
  on('store.get', () => {
    throw new Error('disk gone')
  })
  on('store.set', () => {
    throw new Error('disk gone')
  })
  on('store.keys', () => ({ value: [] }))
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: ID }))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('prompt.compose', () => ({ sections: [{ id: 'x', text: 'base', scope: 'session' }] }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await start($)
  const r = await compose($)
  expect(r.sections[0].id).toBe('x')
  await $.turn.complete(turn(PROSE))
})

test('kill switch: enabled off adds nothing to the system prompt', { options: { enabled: false } }, async ($, on) => {
  engine(on)
  await start($)
  const r = await compose($)
  expect(r.sections).toEqual([])
})
