import { test, expect, mock } from 'claude-code/testing'
import { clickScript, isAttended, isDup, q, statusText, titleOf, whereAmI } from './notify'

test('pure: where, status, dedup, attended, quoting', () => {
  expect(whereAmI({ tmuxPane: '%3', tmux: '/tmp/t,1,0' })).toEqual({ kind: 'tmux', pane: '%3' })
  expect(whereAmI({ herdrEnv: '1', herdrPane: 'p1', herdrTab: 't1' })).toEqual({ kind: 'herdr', pane: 'p1', tab: 't1' })
  expect(whereAmI({ tmuxPane: '%3' }).kind).toBe('plain') // pane without $TMUX is not tmux
  expect(statusText('Notification')).toBe('◐ needs input')
  expect(titleOf('Stop', 'app')).toBe('app: done')
  expect(isDup({ glyph: '✔', ts: 1000 }, '✔', 1000 + 119_999)).toBe(true)
  expect(isDup({ glyph: '✔', ts: 1000 }, '✔', 1000 + 120_000)).toBe(false)
  expect(isDup({ glyph: '◐', ts: 1000 }, '✔', 1001)).toBe(false)
  expect(isAttended('990', 1000)).toBe(true)
  expect(isAttended('900', 1000)).toBe(false)
  expect(isAttended('', 1000)).toBe(false)
  expect(q("a'b")).toBe(`'a'\\''b'`)
  const base = { title: 't', body: 'b', key: 'k', sid: 's', log: '/l', raise: '/r' }
  expect(clickScript({ kind: 'tmux', pane: '%3' }, base)).toContain('tmux select-pane')
  expect(clickScript({ kind: 'herdr', pane: 'p1', tab: 't1' }, base)).toContain('herdr agent focus')
  expect(clickScript({ kind: 'plain' }, base)).toContain('wmctrl -x -a tilix.Tilix')
})

// What the engine answers beneath the mod: the classic events and the screen calls.
const shown: string[] = []
function beneath(on: any) {
  for (const ev of ['classic.Stop', 'classic.Notification', 'classic.UserPromptSubmit'] as const) on(ev, () => ({}))
  on('ui.log', () => ({ value: undefined }))
  on('ui.status', (_$: any, e: any) => (shown.push(`status:${e.text}`), { value: undefined }) as never)
  on('ui.toast', (_$: any, e: any) => (shown.push(`toast:${e.text}`), { value: undefined }) as never)
}

// The world beneath the mod: tmux env, a clock, and every process call recorded.
function world(on: any, env: Record<string, string>, calls: string[][], attendedAt = '0') {
  mock.env(on, env)
  mock.clock(on)
  beneath(on)
  on('process.run', (_$: any, e: any) => {
    calls.push([...e.argv])
    const out = e.argv[0] === 'tmux' && e.argv[1] === 'display' ? attendedAt : ''
    return { value: { exitCode: 0, stdout: out, stderr: '' } } as never
  })
}
const TMUX = { TMUX_PANE: '%3', TMUX: '/tmp/t,1,0', HOME: '/h' }
const spawned = (calls: string[][]) => calls.filter(c => c[0] === 'setsid')

test('Stop in tmux sets the border glyph and detaches one click notification; a repeat is deduped', async ($, on) => {
  const calls: string[][] = []
  world(on, TMUX, calls)
  await $.classic.Stop({ cwd: '/h/app', session_id: 's1' } as never)
  expect(calls.some(c => c[0] === 'tmux' && c.includes('@agent_state') && c.includes('✔'))).toBe(true)
  expect(spawned(calls).length).toBe(1)
  expect(spawned(calls)[0]!.join(' ')).toContain('tmux select-pane')
  await $.classic.Stop({ cwd: '/h/app', session_id: 's1' } as never)
  expect(spawned(calls).length).toBe(1) // dedup window
})

test('a new prompt clears dedup so the next stop notifies again', async ($, on) => {
  const calls: string[][] = []
  world(on, { ...TMUX, TMUX_PANE: '%7' }, calls)
  await $.classic.Stop({ cwd: '/h/app', session_id: 's2' } as never)
  await $.classic.UserPromptSubmit({ cwd: '/h/app', session_id: 's2', prompt: 'go' } as never)
  await $.classic.Stop({ cwd: '/h/app', session_id: 's2' } as never)
  expect(spawned(calls).length).toBe(2)
  expect(calls.some(c => c.includes('@agent_state') && c.includes('●'))).toBe(true)
})

test('Stop while the person is at the tmux client sends no desktop notification', async ($, on) => {
  const calls: string[][] = []
  world(on, { ...TMUX, TMUX_PANE: '%9' }, calls, String(Math.floor(Date.now() / 1000)))
  await $.classic.Stop({ cwd: '/h/app', session_id: 's3' } as never)
  expect(spawned(calls).length).toBe(0)
  expect(calls.some(c => c.includes('@agent_state') && c.includes('✔'))).toBe(true) // glyph still set
})

test('Notification always notifies, outside tmux too', async ($, on) => {
  const calls: string[][] = []
  world(on, { HOME: '/h' }, calls)
  await $.classic.Notification({ cwd: '/h/app', session_id: 's4', message: 'permission?', notification_type: 'x' } as never)
  expect(spawned(calls).length).toBe(1)
  expect(spawned(calls)[0]!.join(' ')).toContain('tilix.Tilix')
  expect(shown).toContain('status:◐ needs input')
  expect(shown).toContain('toast:permission?')
})

test('throw path: a failing shell-out never breaks the turn (fails open)', async ($, on) => {
  mock.env(on, TMUX)
  mock.clock(on)
  beneath(on)
  on('process.run', () => {
    throw new Error('spawn down')
  })
  await $.classic.Stop({ cwd: '/h/app', session_id: 's5' } as never) // resolves, no deny
})
