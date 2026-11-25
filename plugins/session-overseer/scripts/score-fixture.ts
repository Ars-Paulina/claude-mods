// Score the done-claim detector on a claim fixture (FR-1, C-2).
//
//   node scripts/score-fixture.ts <fixture.jsonl> [--split dev|holdout] [--phrases data/claim-phrases.json] [--gate 0.9]
//
// Each row is {id, label: pos|neg, task_type, split} plus either "text" (synthetic fixtures) or a
// pointer {session_id, line, sha}: the text is read through the masking transcript reader
// (FSEARCH_BIN, default `fsearch` on PATH) and must hash to `sha` (sha256 of the trimmed masked
// text), else the row is reported as `sha_mismatch` and left out. Prints JSON; with --gate, exits
// 1 when overall accuracy, or any task type with >=5 rows, is below the gate.

import { detectClaim } from '../hooks/claims.ts'
import { args, clopperPearson, lineText, loadDeps, readJsonl, round, sha256 } from './lib.ts'

const MIN_TYPE_ROWS = 5

type Row = { id: string; label: 'pos' | 'neg'; task_type?: string; split?: string; text?: string; session_id?: string; line?: number; sha?: string; holdout_source?: string }

function acc(rows: { ok: boolean }[]) {
  const k = rows.filter(r => r.ok).length
  return { n: rows.length, correct: k, accuracy: rows.length ? round(k / rows.length) : null, interval90: clopperPearson(k, rows.length) }
}

export function score(rows: Row[], phrasesPath?: string) {
  const { detector } = loadDeps(phrasesPath)
  const scored: { id: string; label: string; type: string; got: string; ok: boolean }[] = []
  const shaMismatch: string[] = []
  const unresolved: string[] = []
  const disputed: string[] = []
  for (const r of rows) {
    // Holdout answer key = majority of the blind labellers (M0 merge_holdout.py --agents, written into
    // `label`); a row with no majority carries holdout_source "disputed" and is left out of scoring.
    if (r.holdout_source === 'disputed') { disputed.push(r.id); continue }
    let text = r.text
    if (text === undefined) {
      const t = r.session_id && r.line ? lineText(r.session_id, r.line) : null
      if (t === null) { unresolved.push(r.id); continue }
      if (r.sha && sha256(t) !== r.sha) { shaMismatch.push(r.id); continue }
      text = t
    }
    const got = detectClaim(detector, text).claim ? 'pos' : 'neg'
    scored.push({ id: r.id, label: r.label, type: r.task_type ?? 'unknown', got, ok: got === r.label })
  }
  const perType: Record<string, unknown> = {}
  for (const type of [...new Set(scored.map(s => s.type))].sort()) {
    const rs = scored.filter(s => s.type === type)
    perType[type] = rs.length < MIN_TYPE_ROWS ? { n: rs.length, result: 'insufficient data' } : acc(rs)
  }
  const perLabel: Record<string, unknown> = {}
  for (const label of ['pos', 'neg']) {
    const tp = scored.filter(s => s.got === label && s.label === label).length
    const predicted = scored.filter(s => s.got === label).length
    const actual = scored.filter(s => s.label === label).length
    perLabel[label] = { precision: predicted ? round(tp / predicted) : null, recall: actual ? round(tp / actual) : null }
  }
  return {
    overall: acc(scored),
    per_task_type: perType,
    per_label: perLabel,
    wrong: scored.filter(s => !s.ok).map(s => s.id),
    sha_mismatch: shaMismatch,
    unresolved,
    disputed,
  }
}

function main(argv: string[]): number {
  const { pos, flags } = args(argv)
  if (!pos[0] || flags.help) {
    console.log('usage: node scripts/score-fixture.ts <fixture.jsonl> [--split dev|holdout] [--phrases FILE] [--gate 0.9]')
    return pos[0] ? 0 : 2
  }
  let rows = readJsonl(pos[0]) as Row[]
  if (typeof flags.split === 'string') rows = rows.filter(r => r.split === flags.split)
  const out = score(rows, typeof flags.phrases === 'string' ? flags.phrases : undefined)
  console.log(JSON.stringify(out, null, 2))
  if (typeof flags.gate === 'string') {
    const gate = Number(flags.gate)
    const types = Object.values(out.per_task_type) as { accuracy?: number | null }[]
    if ((out.overall.accuracy ?? 0) < gate || types.some(t => typeof t.accuracy === 'number' && t.accuracy < gate)) return 1
  }
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
