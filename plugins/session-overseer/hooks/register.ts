import type { EngineInterface as Engine, Register } from 'claude-code'

import { makeDetector } from './claims.ts'
import type { PhraseData } from './claims.ts'
import { hasChecks } from './contract.ts'
import { compilePins } from './pins.ts'
import type { Pin } from './pins.ts'
import { canaryCounts } from './stale.ts'
import { Observer } from './observer.ts'
import type { Deps, Row } from './observer.ts'
import { paths, store } from './log.ts'
import type { Op, Paths } from './log.ts'

// Log-only collector (M1a). Every handler observes, logs what it WOULD have done, and passes the
// event on unchanged. Fail open: any error inside observe leaves the event untouched, sets the
// dot grey and logs `blind`. Bails before any write: OVERSEER_CHECKER=1 (the checker's own child
// session), the OFF file in the state dir, and every subagent event (agentId set).
//
// No classic.* mod hooks: under the security-default plugin they are skipped and each skip adds a
// visible notice to the session (event spike, README "Event map"). The classic inputs this mod
// needs (SessionStart compact, PostToolUse count) come from command hooks in hooks.json instead.

const CANARY_TAIL = 65_536

// ponytail: per-session state lives in module memory; a mod reload starts the session's counts over.
const sessions = new Map<string, Observer>()
const rawSeen = new Map<string, number>()
let deps: Promise<Deps> | null = null

function loadDeps($: Engine): Promise<Deps> {
  deps ??= (async () => {
    const root = $.plugin.root
    const phrases = JSON.parse(await $.fs.read(`${root}/data/claim-phrases.json`)) as PhraseData
    const pins = JSON.parse(await $.fs.read(`${root}/data/pins.json`)) as { rules: Pin[] }
    return {
      detector: makeDetector(phrases),
      pins: compilePins(pins.rules),
      git: async (argv: string[], cwd: string) => {
        const r = await $.process.run(argv, { cwd, timeoutMs: 1_000 })
        return { exitCode: r.exitCode, stdout: r.stdout }
      },
      sleep: (ms: number) => $.clock.sleep(ms),
    }
  })().catch(err => { deps = null; throw err })
  return deps
}

async function observer($: Engine, sid: string): Promise<Observer> {
  let o = sessions.get(sid)
  if (!o) sessions.set(sid, (o = new Observer(await loadDeps($))))
  return o
}

type Ctx = { p: Paths; sid: string; obs: Observer; now: number }

async function bails($: Engine, p: Paths, agentId: unknown): Promise<boolean> {
  if ((await $.env.get('OVERSEER_CHECKER')) === '1') return true
  if (agentId) return true
  return $.fs.exists(`${p.stateDir}/OFF`)
}

const rowsOp = (rows: Row[]): Op[] => rows.map(row => ({ op: 'log', row }))

/** Fail-open wrapper: never throws, never changes the event. */
export async function observe($: Engine, event: string, agentId: unknown, fn: (c: Ctx) => Promise<Op[]>): Promise<void> {
  try {
    if ((await $.env.get('OVERSEER_CHECKER')) === '1') return
    const p = await paths($)
    if (!p || (await bails($, p, agentId))) return
    const now = await $.clock.now()
    const sid = await $.session.id()
    let ops: Op[]
    try {
      if ((await $.env.get('OVERSEER_FAILTEST')) === '1') throw new Error('failtest')
      ops = await fn({ p, sid, obs: await observer($, sid), now })
    } catch (err) {
      const reason = String((err as Error)?.message) === 'failtest' ? 'failtest' : 'error'
      ops = [
        { op: 'state', patch: { dot: 'grey', blind_reason: reason } },
        { op: 'log', row: { event, signal: 'blind', would: 'none', detail: { reason } } },
      ]
    }
    await store($, p, sid, now, ops)
  } catch {
    // Fail open: the session goes on as if the mod were not there.
  }
}

async function readText($: Engine, path: string): Promise<string | null> {
  return (await $.fs.exists(path)) ? $.fs.read(path) : null
}

async function freezeContract($: Engine, obs: Observer, now: number): Promise<void> {
  if (obs.contract) return
  const cwd = await $.session.cwd()
  const top = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd, timeoutMs: 1_000 })
  const root = top.exitCode === 0 ? top.stdout.trim() : ''
  const ts = new Date(now).toISOString()
  if (!root) { obs.contract = { ts, inGit: false, hasChecks: false }; return }
  const other = (await Promise.all(['pytest.ini', 'tox.ini', 'Cargo.toml', 'go.mod'].map(f => $.fs.exists(`${root}/${f}`)))).some(Boolean)
  obs.contract = {
    ts,
    inGit: true,
    hasChecks: hasChecks({ packageJson: await readText($, `${root}/package.json`), makefile: await readText($, `${root}/Makefile`), pyproject: await readText($, `${root}/pyproject.toml`), other }),
  }
}

async function canaryTail($: Engine, home: string): Promise<string> {
  const path = (await $.env.get('OVERSEER_CANARY_LOG')) || `${home}/.claude/logs/canary-check.log`
  if (!(await $.fs.exists(path))) return ''
  const { size } = await $.fs.stat(path)
  const text = await $.fs.read(path, { offset: Math.max(0, size - CANARY_TAIL), length: CANARY_TAIL, as: 'text' } as never)
  return typeof text === 'string' ? text : ''
}

let promptSeq = 0

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('session.start', async ($, e, next) => {
    await observe($, 'session.start', undefined, async () => [{ op: 'prune', days: 60 }])
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed: hidden prompts (task notifications, agent hand-backs) are not.
    const origin = (e as { origin?: { kind?: string } }).origin?.kind
    if (!e.isMeta && origin !== 'task-notification' && origin !== 'peer') {
      await observe($, 'prompt.submit', undefined, async ({ obs, now }) => {
        await freezeContract($, obs, now)
        const ts = new Date(now).toISOString()
        const rec = obs.prompt(e.text, ts, `${now}-${++promptSeq}`)
        return rec ? [{ op: 'approval', rec }] : []
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    await observe($, 'tool.call', e.agentId, async ({ obs }) => {
      const res = r as { isError?: boolean; text?: string; result?: unknown }
      const output = typeof res.text === 'string' ? res.text : JSON.stringify(res.result ?? '')
      const { tool, ...input } = e as unknown as { tool: string } & Record<string, unknown>
      return rowsOp(obs.tool(tool, input, { isError: res.isError === true, output }))
    })
    return r
  })

  on('turn.complete', async ($, e, next) => {
    await observe($, 'turn.complete', e.agentId, async ({ p, sid, obs }) => {
      const cc = (await $.session.version()).version
      const tested = (await readText($, `${p.stateDir}/tested-version`))?.trim() ?? null
      const canary = canaryCounts(await canaryTail($, p.home), sid)
      // Written by the classic command hooks (scripts/classic.cjs): one byte per main-loop tool call,
      // and the deduped compaction count in the state file.
      const rawPath = `${p.stateDir}/raw/${sid}.count`
      const raw = (await $.fs.exists(rawPath)) ? (await $.fs.stat(rawPath)).size : null
      const rawTools = raw === null ? undefined : raw - (rawSeen.get(sid) ?? 0)
      if (raw !== null) rawSeen.set(sid, raw)
      const state = await readText($, `${p.stateDir}/${sid}.json`)
      const compactions = state ? Number(JSON.parse(state).compactions ?? 0) : undefined
      const rows = await obs.turn(e.answer, { cwd: await $.session.cwd(), ccVersion: cc, tested, canary, rawTools, compactions })
      return [
        ...rowsOp(rows),
        { op: 'state', patch: { dot: obs.dot(), blind_reason: obs.blind, cc_version: cc, counts: obs.counts, suspect: [] } },
      ]
    })
    return next(e)
  })
}
