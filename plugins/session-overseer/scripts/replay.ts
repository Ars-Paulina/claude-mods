// Golden-transcript replay (FR-19): feed a hand-written list of engine events through the mod's
// real handlers (hooks/register.ts), the classic command hooks (scripts/classic.cjs) and the store
// bridge (scripts/store.cjs), then diff the rows written to the log against the expected ones. A
// renamed event field or a changed bridge payload changes the rows, so the replay fails.
// Exit 0 = same, 1 = differs, an event was changed on its way through, or the file is broken.
// `--stamp` on a pass writes Claude Code's major.minor to <state dir>/tested-version, which the mod
// compares against on every turn (grey when they differ or nothing is stamped).
//
//   node scripts/replay.ts [golden.json] [--stamp] [--cc-version 2.1.331] [--state-dir DIR] [--print]

import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { register } from '../hooks/register.ts'
import type { Row } from '../hooks/observer.ts'
import { majorMinor } from '../hooks/blind.ts'
import { PLUGIN, args } from './lib.ts'

const require = createRequire(import.meta.url)
const { handle } = require('./classic.cjs') as { handle: (kind: string, input: object, env: object, now: number) => string }

const HELP = `usage: node scripts/replay.ts [golden.json] [--stamp] [--cc-version X.Y.Z] [--state-dir DIR] [--print]
  golden.json   default: test/fixtures/golden-transcript.json
  --stamp       on a pass, write major.minor of the Claude Code version to <state dir>/tested-version
  --cc-version  version to stamp (default: \`claude --version\`)
  --state-dir   default: $OVERSEER_STATE_DIR or ~/.claude/state/overseer
  --print       print the rows the replay produced (to write a new golden file by hand)`

/**
 * One engine event. `hook` events go through register.ts with the payload `e` exactly as the
 * engine sends it; a `tool.call` also fires the classic PostToolUse hook (as the engine does)
 * unless `classic: false`. `classic` events call scripts/classic.cjs with `input`.
 */
export type GoldenEvent =
  | { hook: 'session.start' | 'prompt.submit' | 'turn.complete'; e: Record<string, unknown> }
  | { hook: 'tool.call'; e: Record<string, unknown>; result: Record<string, unknown>; classic?: boolean }
  | { classic: 'tool' | 'compact'; input?: Record<string, unknown> }

/** Canned answers for the commands the mod runs, matched by the longest key the argv starts with. */
export type Canned = Record<string, { exitCode: number; stdout: string }>

export type Golden = { cc_version: string; files?: Record<string, string>; git?: Canned; events: GoldenEvent[]; expected: Row[] }

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>

let replays = 0

/** Run the events through the mod; returns the log rows (timing rows left out) and any problems. */
export async function replayEvents(g: Golden): Promise<{ rows: Row[]; problems: string[] }> {
  const home = mkdtempSync(join(tmpdir(), 'overseer-replay-'))
  const stateDir = join(home, 'state')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(stateDir, 'tested-version'), `${majorMinor(g.cc_version)}\n`)
  const maskJs = join(home, 'mask.cjs')
  writeFileSync(maskJs, 'module.exports = { maskString: t => ({ text: t, hits: [] }) }')
  const env: Record<string, string> = { HOME: home, OVERSEER_STATE_DIR: stateDir, OVERSEER_MASK_JS: maskJs, OVERSEER_CANARY_LOG: join(home, 'none.log') }
  const sid = `golden-${process.pid}-${++replays}`
  const files = g.files ?? {}
  let now = Date.UTC(2026, 0, 1)
  const problems: string[] = []

  const canned = (argv: string[]) => {
    const line = argv.join(' ')
    const key = Object.keys(g.git ?? {}).filter(k => line.startsWith(k)).sort((a, b) => b.length - a.length)[0]
    return key ? g.git![key]! : { exitCode: 128, stdout: '' }
  }
  const $ = {
    env: { get: async (k: string) => env[k] },
    clock: { now: async () => (now += 1_000), sleep: (ms: number) => new Promise(r => setTimeout(r, ms)) },
    session: { id: async () => sid, cwd: async () => '/repo', version: async () => ({ version: g.cc_version, base: g.cc_version, builtAt: '' }) },
    plugin: { root: PLUGIN },
    fs: {
      exists: async (p: string) => p in files || existsSync(p),
      read: async (p: string, o?: { offset?: number; length?: number }) => {
        const text = p in files ? files[p]! : readFileSync(p, 'utf8')
        return o?.offset !== undefined ? text.slice(o.offset, o.offset + (o.length ?? text.length)) : text
      },
      stat: async (p: string) => ({ kind: 'file', size: p in files ? files[p]!.length : statSync(p).size, mtimeMs: 0, isLink: false }),
    },
    process: {
      run: async (argv: string[], init: { stdin?: string } = {}) => {
        if (argv[0] === 'node') {
          const r = spawnSync('node', argv.slice(1), { input: init.stdin ?? '', encoding: 'utf8' })
          return { exitCode: r.status ?? 1, stdout: r.stdout, stderr: r.stderr }
        }
        return { ...canned(argv), stderr: '' }
      },
    },
  }

  const hooks: Record<string, Hook> = {}
  register(((event: string, a: unknown, b?: unknown) => { hooks[event] = (b ?? a) as Hook }) as never, { enabled: true } as never)

  let i = 0
  for (const ev of g.events) {
    i++
    if ('classic' in ev && !('hook' in ev)) {
      handle(ev.classic, { session_id: sid, ...(ev.input ?? {}) }, env, (now += 1_000))
      continue
    }
    const hook = hooks[ev.hook]
    if (!hook) throw new Error(`event ${i}: the mod has no ${ev.hook} hook`)
    // Core answer beneath the mod; it must see the event exactly as sent (0 actions).
    const core = ev.hook === 'tool.call' ? ev.result : { ok: true }
    let seen: unknown = undefined
    const out = await hook($, ev.e, async x => { seen = x; return core })
    if (!isDeepStrictEqual(seen, ev.e)) problems.push(`event ${i} (${ev.hook}): the mod changed the event it passed on`)
    if (!isDeepStrictEqual(out, core)) problems.push(`event ${i} (${ev.hook}): the mod changed the result`)
    if (ev.hook === 'tool.call' && ev.classic !== false) handle('tool', { session_id: sid }, env, (now += 1_000))
  }

  const log = join(stateDir, 'log', `${sid}.jsonl`)
  const rows = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).map(r => ({ event: r.event, signal: r.signal, would: r.would, detail: r.detail }) as Row)
    : []
  rmSync(home, { recursive: true, force: true })
  return { rows: rows.filter(r => r.signal !== 'timing'), problems }
}

const stable = (x: unknown) => JSON.stringify(x, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v))

export function diffRows(got: Row[], want: Row[]): string[] {
  const out: string[] = []
  for (let i = 0; i < Math.max(got.length, want.length); i++) {
    if (stable(got[i]) !== stable(want[i])) out.push(`row ${i}: got ${stable(got[i])} want ${stable(want[i])}`)
  }
  return out
}

async function main(argv: string[]): Promise<number> {
  const { pos, flags } = args(argv)
  if (flags.help) { console.log(HELP); return 0 }
  const file = pos[0] ?? join(PLUGIN, 'test/fixtures/golden-transcript.json')
  let g: Golden
  try {
    g = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(g.events) || !Array.isArray(g.expected) || typeof g.cc_version !== 'string') throw new Error('missing events, expected or cc_version')
  } catch (err) {
    console.error(`replay: broken golden file ${file}: ${(err as Error).message}`)
    return 1
  }
  let got: Awaited<ReturnType<typeof replayEvents>>
  try {
    got = await replayEvents(g)
  } catch (err) {
    console.error(`replay: ${(err as Error).message}`)
    return 1
  }
  if (flags.print) console.log(JSON.stringify(got.rows, null, 2))
  const diff = [...got.problems, ...diffRows(got.rows, g.expected)]
  if (diff.length) {
    console.error(`replay: ${diff.length} problem(s)\n${diff.join('\n')}`)
    return 1
  }
  console.log(`replay: ok (${got.rows.length} rows)`)
  if (flags.stamp) {
    const version = typeof flags['cc-version'] === 'string' ? flags['cc-version'] : execFileSync('claude', ['--version'], { encoding: 'utf8' })
    const mm = majorMinor(version)
    if (!mm) { console.error(`replay: cannot read a version from "${version.trim()}"`); return 1 }
    const dir = typeof flags['state-dir'] === 'string' ? flags['state-dir'] : process.env.OVERSEER_STATE_DIR || join(process.env.HOME ?? '', '.claude/state/overseer')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(dir, 'tested-version'), `${mm}\n`, { mode: 0o600 })
    chmodSync(join(dir, 'tested-version'), 0o600)
    console.log(`replay: stamped tested-version ${mm}`)
  }
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
