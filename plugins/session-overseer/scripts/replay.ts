// Golden-transcript replay (FR-19): run the observer over a hand-written event list and diff the
// rows it logs against the expected ones. Exit 0 = same, 1 = differs or the file is broken.
// `--stamp` on a pass writes Claude Code's major.minor to <state dir>/tested-version, which the mod
// compares against on every turn (grey when they differ or nothing is stamped).
//
//   node scripts/replay.ts [golden.json] [--stamp] [--cc-version 2.1.331] [--state-dir DIR] [--print]

import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Observer } from '../hooks/observer.ts'
import type { Row } from '../hooks/observer.ts'
import { majorMinor } from '../hooks/blind.ts'
import { PLUGIN, args, loadDeps } from './lib.ts'

const HELP = `usage: node scripts/replay.ts [golden.json] [--stamp] [--cc-version X.Y.Z] [--state-dir DIR] [--print]
  golden.json   default: test/fixtures/golden-transcript.json
  --stamp       on a pass, write major.minor of the Claude Code version to <state dir>/tested-version
  --cc-version  version to stamp (default: \`claude --version\`)
  --state-dir   default: $OVERSEER_STATE_DIR or ~/.claude/state/overseer
  --print       print the rows the replay produced (to write a new golden file by hand)`

export type GoldenEvent =
  | { type: 'prompt'; text: string }
  | { type: 'tool'; tool: string; input: Record<string, unknown>; isError?: boolean; output?: string }
  | { type: 'turn'; answer: string; rawTools?: number; compactions?: number }

/** Canned git answers keyed by the argv joined with spaces; anything else exits 128 (unknown). */
export type CannedGit = Record<string, { exitCode: number; stdout: string }>

export type Golden = { cc_version: string; contract: Observer['contract']; git?: CannedGit; events: GoldenEvent[]; expected: Row[] }

/** The rows (timing rows left out) the observer logs for these events. */
export async function replayEvents(g: Pick<Golden, 'cc_version' | 'contract' | 'events' | 'git'>, obs = new Observer({ ...loadDeps(), git: async (argv: string[]) => g.git?.[argv.join(' ')] ?? { exitCode: 128, stdout: '' } })): Promise<Row[]> {
  obs.contract = g.contract
  const tested = majorMinor(g.cc_version)
  const rows: Row[] = []
  let n = 0
  for (const e of g.events) {
    if (e.type === 'prompt') rows.push(...obs.prompt(e.text, '2026-01-01T00:00:00.000Z', `m${++n}`).rows)
    else if (e.type === 'tool') rows.push(...obs.tool(e.tool, e.input, { isError: e.isError === true, output: e.output ?? '' }))
    else if (e.type === 'turn') rows.push(...(await obs.turn(e.answer, { cwd: '/repo', ccVersion: g.cc_version, tested, rawTools: e.rawTools, compactions: e.compactions })))
    else throw new Error(`unknown event type ${(e as { type: string }).type}`)
  }
  return rows.filter(r => r.signal !== 'timing')
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
  let got: Row[]
  try {
    got = await replayEvents(g)
  } catch (err) {
    console.error(`replay: ${(err as Error).message}`)
    return 1
  }
  if (flags.print) console.log(JSON.stringify(got, null, 2))
  const diff = diffRows(got, g.expected)
  if (diff.length) {
    console.error(`replay: ${diff.length} row(s) differ\n${diff.join('\n')}`)
    return 1
  }
  console.log(`replay: ok (${got.length} rows)`)
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
