// Score replayed sessions against the person's labels (S3.4a): per failure class and stratum,
// "caught k of n" with a Clopper-Pearson 90% interval, plus false positives.
//
//   node scripts/score-replay.ts --labels labels.csv --replay <dir from replay-history.ts>
//
// labels.csv: session_id,stratum,...,label where label is `;`-joined ok|false_done|loop|stale.
// A session is "caught" for a class when its replay has a row of one of the class's signals with
// would != none. A class whose signals cannot be replayed is reported `unreplayable`, never 0.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { args, clopperPearson, readJsonl, round } from './lib.ts'
import { parseCsv } from './replay-history.ts'

export const CLASS_SIGNALS: Record<string, string[]> = {
  false_done: ['claim', 'claim_vs_git'],
  loop: ['loop'],
  stale: ['stale', 'compaction', 'pin_violation'],
}

// Fewer labelled positives than this: the recall is reported but marked, never used as a pass.
export const MIN_POSITIVES = 5

type Cell = { k: number; n: number; interval90: { lo: number; hi: number }; fp: number; negatives: number; fp_rate: number | null; status: 'measured' | 'insufficient data' }

function cell(pos: boolean[], neg: boolean[]): Cell {
  const k = pos.filter(Boolean).length
  const fp = neg.filter(Boolean).length
  return { k, n: pos.length, interval90: clopperPearson(k, pos.length), fp, negatives: neg.length, fp_rate: neg.length ? round(fp / neg.length) : null, status: pos.length < MIN_POSITIVES ? 'insufficient data' : 'measured' }
}

export function scoreReplay(labels: Record<string, string>[], replayDir: string) {
  const replayed: { sid: string; stratum: string; classes: Set<string>; caught: Set<string>; replayable: Record<string, unknown> }[] = []
  const unreplayed: string[] = []
  for (const l of labels) {
    const sid = l.session_id ?? ''
    const file = join(replayDir, `${sid}.jsonl`)
    if (!sid || !existsSync(file)) { unreplayed.push(sid); continue }
    const [header, ...rows] = readJsonl(file)
    const caught = new Set<string>()
    for (const [cls, signals] of Object.entries(CLASS_SIGNALS)) {
      if (rows.some(r => signals.includes(r.signal) && r.would !== 'none')) caught.add(cls)
    }
    replayed.push({ sid, stratum: l.stratum || 'none', classes: new Set((l.label ?? '').split(';').map(s => s.trim()).filter(Boolean)), caught, replayable: header?.replayable ?? {} })
  }
  const classes: Record<string, unknown> = {}
  for (const [cls, signals] of Object.entries(CLASS_SIGNALS)) {
    const anyReplayable = replayed.some(r => signals.some(s => r.replayable[s] === true || r.replayable[s] === 'partial'))
    if (!anyReplayable) { classes[cls] = { result: 'unreplayable' }; continue }
    const one = (rs: typeof replayed) => cell(rs.filter(r => r.classes.has(cls)).map(r => r.caught.has(cls)), rs.filter(r => !r.classes.has(cls)).map(r => r.caught.has(cls)))
    const byStratum: Record<string, Cell> = {}
    for (const st of [...new Set(replayed.map(r => r.stratum))].sort()) byStratum[st] = one(replayed.filter(r => r.stratum === st))
    classes[cls] = { all: one(replayed), by_stratum: byStratum, signals }
  }
  return { labeled: labels.length, replayed: replayed.length, replayed_share: labels.length ? round(replayed.length / labels.length) : null, unreplayed, classes }
}

function main(argv: string[]): number {
  const { flags } = args(argv)
  if (typeof flags.labels !== 'string' || typeof flags.replay !== 'string') {
    console.log('usage: node scripts/score-replay.ts --labels labels.csv --replay <dir>')
    return flags.help ? 0 : 2
  }
  console.log(JSON.stringify(scoreReplay(parseCsv(readFileSync(flags.labels, 'utf8')), flags.replay), null, 2))
  return 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
