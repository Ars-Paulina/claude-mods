// FR-4 stale-context inputs. Pure: no engine access.
// Compactions are counted by the classic SessionStart(compact) command hook (scripts/classic.cjs,
// deduped within 5 s); PostCompact is never counted. The observer reads that count each turn.

export type StaleState = { compactions: number; evidenceless: number }
export const newStaleState = (): StaleState => ({ compactions: 0, evidenceless: 0 })

/** A done-claim without evidence (not fresh / missing in git). Returns 'stale' on the second one. */
export function onEvidencelessClaim(s: StaleState): 'stale' | null {
  s.evidenceless++
  return s.evidenceless === 2 ? 'stale' : null
}

/** Count canary-log lines for one session: ALERT lines, and miss lines (one input, FR-4). */
export function canaryCounts(log: string, sid: string): { alerts: number; misses: number } {
  let alerts = 0
  let misses = 0
  const tag = `session=${sid}`
  for (const line of log.split('\n')) {
    if (!line.includes(tag)) continue
    if (/\bALERT\b/.test(line)) alerts++
    else if (/\bmiss\b/.test(line)) misses++
  }
  return { alerts, misses }
}
