import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const CWD = '/h/P/app'
const NOW = 1_000_000_000
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 200,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}
const STATE_MD = '---\nstatus: executing\n---\n**Current focus:** Phase 07 — x\n'

type World = {
  agents?: { id: string; status: string }[]
  porcelain?: string | null // null = not a repo
  upstream?: boolean
  pr?: boolean
  gsd?: boolean
  contextAge?: number // ms; absent = no phases dir
  handoff?: boolean // gsd-handoff in $.command.list()
  agentsFail?: boolean
}

// The world beneath the plugin: cwd, a drawing surface, agents, git, gh and .planning.
function world(on: On, w: World) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }) as never)
  on('turn.complete', ($, e) => ({ text: e.text }) as never)
  on('session.surfaces', () => ({ value: ['terminal'] }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="beneath" />
  })
  on('command.list', () => ({
    value: w.handoff ? [{ name: 'gsd-handoff', description: 'd', source: 'user' }] : [],
  }) as never)
  on('agent.list', () => {
    if (w.agentsFail) throw new Error('agent list down')
    return {
    value: (w.agents ?? []).map(a => ({ ...a, description: 'd', type: 'general-purpose' })),
  } as never })
  on('fs.exists', ($, e) => {
    const p = e.path
    const yes = (p.endsWith('STATE.md') && w.gsd) || (p.endsWith('/phases') && w.contextAge !== undefined)
    return { value: Boolean(yes) } as never
  })
  on('fs.read', () => ({ value: STATE_MD }) as never)
  on('fs.list', ($, e) => {
    if (e.path.endsWith('/phases')) return { value: [{ name: '07-x', kind: 'dir', size: 0, mtimeMs: 0 }] } as never
    return { value: [{ name: '07-CONTEXT.md', kind: 'file', size: 1, mtimeMs: NOW - (w.contextAge ?? 0) }] } as never
  })
  on('process.run', ($, e) => {
    const [bin, sub] = e.argv
    const out = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '' } }) as never
    if (bin === 'git' && sub === 'status') return w.porcelain === null ? out(128) : out(0, w.porcelain ?? '')
    if (bin === 'git' && sub === 'rev-list') return w.upstream ? out(0, '2\n') : out(128)
    if (bin === 'gh') {
      return w.pr ? out(0, JSON.stringify({ number: 41, statusCheckRollup: [{ conclusion: 'SUCCESS' }] })) : out(1)
    }
    return out(127)
  })
}

async function start($: Engine, on: On) {
  const time = mock.clock(on, { now: NOW })
  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await time.advance(1)
  return time
}

async function drawn($: Engine): Promise<string> {
  const ui = await $.ui.mount({ plugin: 'flow-board', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}

test('full board line, and the band beneath still drawn', async ($, on) => {
  world(on, { agents: [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'completed' }],
    porcelain: ' M a\n?? b\n M c\n', upstream: true, pr: true, gsd: true })
  await start($, on)
  const text = await drawn($)
  expect(text).toContain('bg: 1 running · git: 3 dirty, 2 ahead · PR #41 ✓ · GSD: P07 executing · clear ✗')
  expect(text).toContain('beneath')
  expect(text).not.toContain('Hand off')
})

test('not a repo, no gh, no upstream: those parts are omitted', async ($, on) => {
  world(on, { porcelain: null })
  await start($, on)
  const text = await drawn($)
  expect(text).toContain('clear ✓')
  expect(text).not.toContain('git:')
  expect(text).not.toContain('PR #')
})

test('a running agent quiet for 10+ min gets ⚠', async ($, on) => {
  world(on, { agents: [{ id: 'a1', status: 'running' }], porcelain: '' })
  const time = await start($, on)
  await time.advance(12 * 60_000)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', text: '' } as never)
  await time.advance(1)
  expect(await drawn($)).toContain('bg: 1 running (1 quiet 12m ⚠)')
})

test('/park toasts the verdict', async ($, on) => {
  world(on, { agents: [{ id: 'a1', status: 'running' }, { id: 'a2', status: 'waiting' }], porcelain: ' M a\n M b\n M c\n' })
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } as never })
  await start($, on)
  await $.command.run({ command: 'park', args: '' } as never)
  expect(toasts).toContain('✗ 2 agents running · 3 uncommitted')
})

test('/park on a clean idle session says safe', async ($, on) => {
  world(on, { porcelain: '' })
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } as never })
  await start($, on)
  await $.command.run({ command: 'park', args: '' } as never)
  expect(toasts).toContain('✓ safe to /clear')
})

test('fresh context offers the handoff; Run launches it once and hides', async ($, on) => {
  world(on, { porcelain: '', contextAge: 60_000, handoff: true })
  const runs: string[] = []
  on('command.run', { command: 'gsd-handoff' }, ($, e) => { runs.push(e.args); return {} })
  await start($, on)
  expect(await drawn($)).toContain('Hand off phase 07 unattended?')
  const ui = await $.ui.mount({ plugin: 'flow-board', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.drawn()
  await $.ui.press({ plugin: 'flow-board', key: 'run' })
  await ui.unmount()
  expect(runs).toEqual(['07'])
  expect(await drawn($)).not.toContain('Hand off')
})

test('stale context offers nothing', async ($, on) => {
  world(on, { porcelain: '', contextAge: 6 * 60_000 })
  await start($, on)
  expect(await drawn($)).not.toContain('Hand off')
})

test('Run fills the prompt box when gsd-handoff is not a listed command', async ($, on) => {
  world(on, { porcelain: '', contextAge: 60_000 })
  const sent: unknown[] = []
  on('prompt.fill', ($, e) => { sent.push(e); return { isFilled: true } as never })
  await start($, on)
  const ui = await $.ui.mount({ plugin: 'flow-board', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.drawn()
  await $.ui.press({ plugin: 'flow-board', key: 'run' })
  await ui.unmount()
  expect(sent).toContainEqual(expect.objectContaining({ text: '/gsd-handoff 07' }))
})

test('a rejected run toasts and never fills the prompt box', async ($, on) => {
  world(on, { porcelain: '', contextAge: 60_000, handoff: true })
  on('command.run', { command: 'gsd-handoff' }, () => { throw new Error('boom') })
  const sent: unknown[] = []
  const toasts: string[] = []
  on('prompt.fill', ($, e) => { sent.push(e); return { isFilled: true } as never })
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } as never })
  const time = await start($, on)
  const ui = await $.ui.mount({ plugin: 'flow-board', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  await ui.drawn()
  await $.ui.press({ plugin: 'flow-board', key: 'run' })
  await ui.unmount()
  await time.advance(1)
  expect(sent).toEqual([])
  expect(toasts.some(t => t.startsWith('gsd-handoff 07 failed'))).toBe(true)
})

test('/park never says safe when the agent check failed', async ($, on) => {
  world(on, { porcelain: '', agentsFail: true })
  const toasts: string[] = []
  on('ui.toast', ($, e) => { toasts.push(e.text); return { value: undefined } as never })
  await start($, on)
  await $.command.run({ command: 'park', args: '' } as never)
  expect(toasts).toContain('✗ agents unknown')
})
