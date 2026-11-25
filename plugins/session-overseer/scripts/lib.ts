// Shared helpers for the local scripts (Node 24 type stripping; not loaded by the mod).

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeDetector } from '../hooks/claims.ts'
import type { PhraseData } from '../hooks/claims.ts'
import { compilePins } from '../hooks/pins.ts'
import type { Pin } from '../hooks/pins.ts'
import type { Deps } from '../hooks/observer.ts'

// Node 24.2+ sets import.meta.main; older @types/node does not declare it.
declare global { interface ImportMeta { main: boolean } }

export const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
export const readJsonl = (path: string): any[] => readFileSync(path, 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l))

export function loadDeps(phrasesPath = join(PLUGIN, 'data/claim-phrases.json'), pinsPath = join(PLUGIN, 'data/pins.json')): Deps {
  const phrases = JSON.parse(readFileSync(phrasesPath, 'utf8')) as PhraseData
  const pins = JSON.parse(readFileSync(pinsPath, 'utf8')) as { rules: Pin[] }
  return {
    detector: makeDetector(phrases),
    pins: compilePins(pins.rules),
    // Replays have no live repo: every git check comes back 'unknown'.
    git: async () => ({ exitCode: 128, stdout: '' }),
    sleep: (ms: number) => new Promise(r => setTimeout(r, ms)),
  }
}

/** Flags `--name value` and bare positionals. */
export function args(argv: string[]): { pos: string[]; flags: Record<string, string | true> } {
  const pos: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++ } else flags[a.slice(2)] = true
    } else pos.push(a)
  }
  return { pos, flags }
}

// ---- transcripts, only through the masking reader (FR-21) ----

export type FsRow = { line: number; role: string; text: string }

/**
 * `fsearch --show <sid> [--lines A-B] [--tools]`, parsed into rows. The reader masks secrets before
 * printing. One row per transcript line: `<line> <role>: <text>`; the first output line is a header.
 */
export function fsearchShow(sid: string, opts: { lines?: string; tools?: boolean } = {}): FsRow[] {
  const bin = process.env.FSEARCH_BIN || 'fsearch'
  const argv = ['--show', sid, '--width', '1000000']
  if (opts.lines) argv.push('--lines', opts.lines)
  if (opts.tools) argv.push('--tools')
  const out = execFileSync(bin, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  const rows: FsRow[] = []
  for (const l of out.split('\n')) {
    const m = /^\s*(\d+) ([a-z_-]+): ?(.*)$/.exec(l)
    if (m) rows.push({ line: Number(m[1]), role: m[2]!, text: m[3]! })
    else if (rows.length && l.trim()) rows[rows.length - 1]!.text += '\n' + l
  }
  return rows
}

/** The masked text of one transcript line, as the fixture's `sha` is taken over (trimmed). */
export function lineText(sid: string, line: number): string | null {
  const row = fsearchShow(sid, { lines: String(line) }).find(r => r.line === line)
  return row ? row.text.trim() : null
}

// ---- stats ----

function logBinomCoef(n: number, k: number): number {
  let s = 0
  for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i)
  return s
}

/** P(X <= k) for X ~ Binomial(n, p). */
function binomCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0
  if (k >= n) return 1
  if (p <= 0) return 1
  if (p >= 1) return 0
  let s = 0
  for (let i = 0; i <= k; i++) s += Math.exp(logBinomCoef(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p))
  return Math.min(1, s)
}

function bisect(f: (p: number) => number, target: number): number {
  // f decreasing in p.
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) > target) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Clopper-Pearson exact interval for k successes in n, at `level` (0.90 = 90%). */
export function clopperPearson(k: number, n: number, level = 0.9): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 1 }
  const a = (1 - level) / 2
  const lo = k === 0 ? 0 : bisect(p => binomCdf(k - 1, n, p), 1 - a) // P(X >= k) = a
  const hi = k === n ? 1 : bisect(p => binomCdf(k, n, p), a) // P(X <= k) = a
  return { lo: round(lo), hi: round(hi) }
}

export const round = (x: number) => Math.round(x * 10_000) / 10_000
