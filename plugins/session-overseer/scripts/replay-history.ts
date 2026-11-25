// History replay (S3.4a): turn past sessions, read through the masking transcript reader, into
// events, run the same observer the mod runs, and write the rows per session.
//
//   node scripts/replay-history.ts <sample.json | labels.csv> --out <dir>
//
// Transcript rows come from `fsearch --show <sid> --tools` (FSEARCH_BIN, default `fsearch` on PATH):
// user -> prompt, tool -> tool call (its result is the next `result` row, in order), assistant ->
// end of turn. The reader prints no cwd, no timestamps and no exit codes, so:
//   - contract: in a repo; has checks = the session ran a recognized check command (lossy)
//   - failure = result text starting "Error:" or "Exit code <n>" with n > 0
//   - claim_vs_git, compaction and blind cannot be replayed (no repo window, no hook events)
// Output rows hold pointers only (transcript line + signal), never text.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { Observer } from '../hooks/observer.ts'
import type { Row } from '../hooks/observer.ts'
import { isCheckCommand } from '../hooks/contract.ts'
import { args, fsearchShow, loadDeps } from './lib.ts'
import type { FsRow } from './lib.ts'

export const REPLAYABLE = { claim: true, loop: true, pin_violation: true, approval: true, stale: 'partial', claim_vs_git: false, compaction: false, blind: false } as const

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ }
      else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(cell); cell = ''
      if (row.some(x => x !== '')) rows.push(row)
      row = []
    } else cell += c
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  const [head, ...body] = rows
  return (body ?? []).map(r => Object.fromEntries((head ?? []).map((h, i) => [h, r[i] ?? ''])))
}

export function sessionIds(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const ids = file.endsWith('.csv') ? parseCsv(text).map(r => r.session_id ?? '') : (JSON.parse(text) as { session_id: string }[]).map(r => r.session_id)
  return [...new Set(ids.filter(Boolean))]
}

const failed = (text: string) => /^Error:/.test(text) || /^Exit code [1-9]\d*/.test(text)
const notTyped = (text: string) => /^<(task-notification|agent-message|system-reminder|local-command|command-)/.test(text.trim())

/** One session's rows -> observer rows, each tagged with the transcript line it came from. */
export async function replayRows(rows: FsRow[], obs = new Observer(loadDeps())): Promise<(Row & { line: number })[]> {
  const out: (Row & { line: number })[] = []
  const tag = (line: number, rs: Row[]) => { for (const r of rs) if (r.signal !== 'timing') out.push({ ...r, line }) }
  const calls = rows.filter(r => r.role === 'tool').map(r => parseTool(r.text))
  obs.contract = { ts: '1970-01-01T00:00:00.000Z', inGit: true, hasChecks: calls.some(c => typeof c?.input.command === 'string' && isCheckCommand(c.input.command)) }
  const pending: { line: number; tool: string; input: Record<string, unknown> }[] = []
  const flush = () => { while (pending.length) { const p = pending.shift()!; tag(p.line, obs.tool(p.tool, p.input, { isError: false, output: '' })) } }
  let n = 0
  for (const r of rows) {
    if (r.role === 'user') {
      flush()
      if (!notTyped(r.text)) tag(r.line, obs.prompt(r.text, '1970-01-01T00:00:00.000Z', `L${r.line}-${++n}`).rows)
    } else if (r.role === 'tool') {
      const c = parseTool(r.text)
      if (c) pending.push({ line: r.line, ...c })
    } else if (r.role === 'result') {
      const p = pending.shift()
      if (p) tag(p.line, obs.tool(p.tool, p.input, { isError: failed(r.text), output: r.text }))
    } else if (r.role === 'assistant') {
      flush()
      tag(r.line, await obs.turn(r.text, { cwd: '/', ccVersion: '0.0', tested: '0.0' }))
    }
  }
  flush()
  return out
}

export function parseTool(text: string): { tool: string; input: Record<string, unknown> } | null {
  const m = /^(\S+)\s+(\{[\s\S]*\})\s*$/.exec(text.trim())
  if (!m) return null
  try { return { tool: m[1]!, input: JSON.parse(m[2]!) } } catch { return null }
}

async function main(argv: string[]): Promise<number> {
  const { pos, flags } = args(argv)
  if (!pos[0] || typeof flags.out !== 'string') {
    console.log('usage: node scripts/replay-history.ts <sample.json | labels.csv> --out <dir>')
    return flags.help ? 0 : 2
  }
  mkdirSync(flags.out, { recursive: true, mode: 0o700 })
  const ids = sessionIds(pos[0])
  let ok = 0
  const failedIds: string[] = []
  for (const sid of ids) {
    try {
      const rows = await replayRows(fsearchShow(sid, { tools: true }))
      const header = { sid, replayable: REPLAYABLE, transcript_rows: rows.length }
      writeFileSync(join(flags.out, `${sid}.jsonl`), [header, ...rows].map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 })
      ok++
    } catch (err) {
      failedIds.push(sid)
      console.error(`replay-history: ${sid}: ${(err as Error).message.split('\n')[0]}`)
    }
  }
  console.log(JSON.stringify({ sessions: ids.length, replayed: ok, failed: failedIds, replayable: REPLAYABLE }))
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
