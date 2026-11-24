import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FlowBoardState, FlowBoardView } from '../types'

const view = atom({ plugin: 'flow-board', key: 'view' } as const, null)
const pressed = atom({ plugin: 'flow-board', key: 'pressed' } as const, null)

const QUIET_MS = 10 * 60_000
const FRESH_MS = 5 * 60_000
const PR_TTL_MS = 2 * 60_000

// agentId -> last turn.complete (or first time we saw it running).
const lastTurn = new Map<string, number>()
let prCache: { cwd: string; at: number; value: FlowBoardState['pr'] } | null = null
let tick: { cancel: () => void } | null = null

function cut(text: string, width: number): string {
  return text.length > width ? text.slice(0, Math.max(width - 1, 1)) + '…' : text
}

export function parkVerdict(s: FlowBoardState): { ok: boolean; text: string } {
  const dirty = s.git?.dirty ?? 0
  const unknown = s.unknown ?? []
  if (s.busy === 0 && dirty === 0 && !unknown.length) return { ok: true, text: '✓ safe to /clear' }
  // A check that failed is never read as clean.
  const why = [
    ...unknown.map(u => `${u} unknown`),
    s.busy ? `${s.busy} agent${s.busy > 1 ? 's' : ''} running` : '',
    dirty ? `${dirty} uncommitted` : '',
  ].filter(Boolean)
  return { ok: false, text: `✗ ${why.join(' · ')}` }
}

export function formatBoard(s: FlowBoardState, width: number): string {
  const parts: string[] = []
  if (s.busy) parts.push(`bg: ${s.busy} running` + (s.quiet ? ` (${s.quiet} quiet ${s.quietMin}m ⚠)` : ''))
  if (s.git) {
    const ahead = s.git.ahead ? `, ${s.git.ahead} ahead` : ''
    parts.push(`git: ${s.git.dirty ? `${s.git.dirty} dirty` : 'clean'}${ahead}`)
  }
  if (s.pr) parts.push(`PR #${s.pr.number}${s.pr.checks ? ' ' + s.pr.checks : ''}`)
  if (s.gsd) parts.push(`GSD: ${s.gsd}`)
  parts.push(`clear ${parkVerdict(s).ok ? '✓' : '✗'}`)
  return cut(parts.join(' · '), width)
}

/** "P01 executing" from STATE.md: frontmatter `status:` plus the current-focus phase. */
export function gsdState(text: string): string | undefined {
  const status = /^status:\s*(\S+)/m.exec(text)?.[1]
  const phase = /Current focus:\**\s*Phase\s+(\w+)/i.exec(text)?.[1]
  if (!status) return undefined
  return phase ? `P${phase} ${status}` : status
}

export type PhaseEntry = { dir: string; name: string; mtimeMs: number }

// gsd-handoff takes ^[0-9]{1,2}$ only, so decimal phases (25.1) never offer the button.
/** NN of the newest NN-CONTEXT.md written in the last 5 min whose dir has no NN-*PLAN.md yet. */
export function freshContextPhase(entries: PhaseEntry[], now: number): string | null {
  let best: { nn: string; at: number } | null = null
  for (const e of entries) {
    const nn = /^(\d{1,2})-CONTEXT\.md$/.exec(e.name)?.[1]
    if (!nn || now - e.mtimeMs >= FRESH_MS) continue
    const planned = entries.some(o => o.dir === e.dir && o.name.startsWith(`${nn}-`) && o.name.endsWith('PLAN.md'))
    if (!planned && (!best || e.mtimeMs > best.at)) best = { nn, at: e.mtimeMs }
  }
  return best?.nn ?? null
}

export function checksMark(rollup: { conclusion?: string; state?: string }[]): '✓' | '✗' | '…' | '' {
  if (!rollup.length) return ''
  const words = rollup.map(c => (c.conclusion || c.state || '').toUpperCase())
  if (words.some(w => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(w))) return '✗'
  if (words.every(w => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(w))) return '✓'
  return '…'
}

// Each part swallows its own failure: a broken part draws nothing, never breaks the band.
async function part<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn() } catch { return undefined }
}

async function agentsPart($: EngineInterface, now: number) {
  const live = (await $.agent.list()).filter(a => ['running', 'pending', 'waiting'].includes(a.status))
  let quiet = 0
  let quietMin = 0
  for (const a of live) {
    if (!lastTurn.has(a.id)) lastTurn.set(a.id, now)
    const gap = now - (lastTurn.get(a.id) ?? now)
    if (a.status === 'running' && gap > QUIET_MS) {
      quiet += 1
      quietMin = Math.max(quietMin, Math.floor(gap / 60_000))
    }
  }
  return { busy: live.length, quiet, quietMin }
}

async function gitPart($: EngineInterface, cwd: string): Promise<FlowBoardState['git']> {
  const status = await $.process.run(['git', 'status', '--porcelain'], { cwd })
  if (status.exitCode !== 0) return undefined
  const dirty = status.stdout.split('\n').filter(Boolean).length
  const rev = await $.process.run(['git', 'rev-list', '--count', '@{u}..HEAD'], { cwd })
  const ahead = rev.exitCode === 0 ? Number(rev.stdout.trim()) || 0 : undefined
  return { dirty, ahead }
}

async function prPart($: EngineInterface, cwd: string, now: number): Promise<FlowBoardState['pr']> {
  if (prCache && prCache.cwd === cwd && now - prCache.at < PR_TTL_MS) return prCache.value
  const run = await $.process.run(['gh', 'pr', 'view', '--json', 'number,statusCheckRollup'], { cwd })
  let value: FlowBoardState['pr']
  if (run.exitCode === 0) {
    const pr = JSON.parse(run.stdout)
    value = { number: pr.number, checks: checksMark(pr.statusCheckRollup ?? []) }
  }
  prCache = { cwd, at: now, value }
  return value
}

async function gsdPart($: EngineInterface, cwd: string): Promise<string | undefined> {
  const path = `${cwd}/.planning/STATE.md`
  if (!(await $.fs.exists(path))) return undefined
  return gsdState(String(await $.fs.read(path)))
}

async function phasePart($: EngineInterface, cwd: string): Promise<string | null> {
  const root = `${cwd}/.planning/phases`
  if (!(await $.fs.exists(root))) return null
  const dirs = (await $.fs.list(root)).filter(d => d.kind === 'dir')
  const entries = (await Promise.all(dirs.map(async d =>
    (await $.fs.list(`${root}/${d.name}`)).map(f => ({ dir: d.name, name: f.name, mtimeMs: f.mtimeMs }))))).flat()
  return freshContextPhase(entries, await $.clock.now())
}

export async function collect($: EngineInterface): Promise<FlowBoardState> {
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const [agents, git, gsd] = await Promise.all([
    part(() => agentsPart($, now)),
    // undefined = not a repo (clean for /park); null = the check itself failed.
    gitPart($, cwd).catch(() => null),
    part(() => gsdPart($, cwd))])
  const pr = git ? await part(() => prPart($, cwd, now)) : undefined
  const unknown = agents ? [] : ['agents']
  if (git === null) unknown.push('git')
  return { busy: 0, quiet: 0, quietMin: 0, ...agents, git: git ?? undefined, pr, gsd, unknown }
}

async function refresh($: EngineInterface, withPhase: boolean): Promise<void> {
  // A `claude -p` run draws nothing: skip the reads there.
  if ((await $.session.surfaces()).length === 0) return
  const state = await collect($)
  const old = await read($, view)
  const phase = withPhase ? (await part(async () => phasePart($, await $.session.cwd()))) ?? null : old?.phase ?? null
  await update($, view, () => ({ state, phase }))
}

async function launchHandoff($: EngineInterface, nn: string): Promise<void> {
  await update($, pressed, () => nn)
  // Decide up front, never from a rejection: a run that rejects late may still be
  // queued, and a fill on top would let one Enter start a second supervisor.
  if ((await $.command.list()).some(c => c.name === 'gsd-handoff')) {
    void $.command.run({ command: 'gsd-handoff', args: nn })
      .catch(err => $.ui.toast(`gsd-handoff ${nn} failed: ${err instanceof Error ? err.message : String(err)}`))
    return
  }
  // prompt.submit refuses a text starting with '/' (host check), so the fallback
  // fills the prompt box and leaves the Enter to the person.
  await $.prompt.fill({ text: `/gsd-handoff ${nn}` })
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, view, () => null)
    await $.command.register({
      name: 'park',
      description: 'Is a plain /clear safe now? Checks agents and uncommitted files; writes nothing.',
      immediate: true,
    }).catch(() => {})
    lastTurn.clear()
    prCache = null
    tick?.cancel()
    tick = $.clock.every(30_000, () => void refresh($, true))
    $.clock.after(0, () => refresh($, true))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      lastTurn.set(e.agentId, await $.clock.now())
      return result
    }
    $.clock.after(0, () => refresh($, true))
    return result
  })

  on('command.run', { command: 'park' }, async $ => {
    $.ui.toast(parkVerdict(await collect($)).text)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, view)
    if (current === null || e.props.hasSurvey) return next(e)
    // pendings-band draws without calling next(), so keep whatever is beneath us.
    const below = await next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns || 80
    const board = <Text key="board" dimColor>{formatBoard(current.state, width)}</Text>
    const nn = current.phase
    const ask = nn && (await read($, pressed)) !== nn
      ? [<Box key="ask">
          <Text>{cut(`Hand off phase ${nn} unattended?`, width - 8)} </Text>
          <Button key="run" label="Run" onPress={() => launchHandoff($, nn)} />
        </Box>]
      : []

    return (
      <Box flexDirection="column">
        {board}
        {ask}
        {below ?? []}
      </Box>
    )
  })
}
