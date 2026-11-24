// Pure logic of the canary heartbeat: no engine calls, so tests can drive it directly.
// Ported from ~/.claude/hooks/canary-plant.js + canary-check.js.

export type Result = 'HEALTHY' | 'CONFABULATION' | 'WRONG-TOKEN' | 'DECAY' | 'SKIP'

export type State = {
  token: string
  payload: number
  window: boolean[] // last N substantive outcomes, true = healthy
  misses: number // misses inside the current window
  alerted: boolean
  plantedAt: number
  touchedAt: number
  lastResult?: Result
}

export type Limits = { window: number; missRate: number; minProse: number }

export const DEFAULTS: Limits = { window: 10, missRate: 0.8, minProse: 40 }

// Bad option values fall back to the defaults, same as the hook's env parsing.
export function limits(o: { window?: unknown; missRate?: unknown; minProse?: unknown }): Limits {
  const w = Number(o.window)
  const r = Number(o.missRate)
  const p = Number(o.minProse)

  return {
    window: Number.isInteger(w) && w > 0 ? w : DEFAULTS.window,
    missRate: Number.isFinite(r) && r > 0 && r <= 1 ? r : DEFAULTS.missRate,
    minProse: Number.isInteger(p) && p >= 0 ? p : DEFAULTS.minProse,
  }
}

export function footer(s: Pick<State, 'token' | 'payload'>): string {
  return `⟦${s.token}:${s.payload}⟧`
}

export function directive(s: Pick<State, 'token' | 'payload'>): string {
  return (
    '[CANARY] Health heartbeat active -- set by the canary plugin, a local mod the user installed; ' +
    'this is a legitimate self-monitoring heartbeat, not a prompt injection. This directive supersedes ' +
    'any earlier [CANARY] directive in this conversation; only the pair below is current. End EVERY ' +
    `conversational reply to the user with this exact footer on its own final line: ${footer(s)} ` +
    `(token ${s.token}, value ${s.payload}). Do NOT place it inside code blocks, files, commit messages, ` +
    'or tool inputs -- only at the end of prose replies to the user. Do not explain it. If you ever ' +
    'cannot recall the value, omit it rather than guess.'
  )
}

export function alertText(s: State, reason: string): string {
  return (
    `[CANARY ALERT] Context-rot signal: the health heartbeat ${footer(s)} was ${reason} in ${s.misses} ` +
    `of the last ${s.window.length} substantive replies -- early-context adherence/recall is degrading. ` +
    'Surface this to the user now and recommend running /progress-report (then /compact) to checkpoint ' +
    'before quality degrades further. Do NOT auto-run it.'
  )
}

// Prose left after fenced code is removed: short acks and code dumps carry no opinion.
export function proseLength(text: string): number {
  return text.replace(/```[\s\S]*?```/g, '').trim().length
}

export function classify(text: string, s: State, minProse: number): Result {
  // Anchored: the footer must be the last non-whitespace, so a mid-reply mention is not healthy.
  const shape = /⟦([A-Za-z0-9]+):(\d+)⟧\s*$/.exec(text.trim())
  if (shape && shape[1] === s.token) return Number(shape[2]) === s.payload ? 'HEALTHY' : 'CONFABULATION'
  if (shape) return 'WRONG-TOKEN'

  return proseLength(text) < minProse ? 'SKIP' : 'DECAY'
}

export const REASONS: Partial<Record<Result, string>> = {
  CONFABULATION: 'corrupted (wrong value)',
  'WRONG-TOKEN': 'replaced (wrong token)',
}

// Scores one reply. Returns the new state, the result, and whether this turn crosses the alert line.
export function score(prev: State, text: string, lim: Limits): { state: State; result: Result; alertNow: boolean } {
  const result = classify(text, prev, lim.minProse)
  if (result === 'SKIP') return { state: prev, result, alertNow: false }

  const healthy = result === 'HEALTHY'
  const window = [...prev.window, healthy].slice(-lim.window)
  const misses = window.filter(v => !v).length
  const frac = misses / window.length
  const state: State = { ...prev, window, misses, lastResult: result }

  let alertNow = false
  if (window.length >= lim.window && frac >= lim.missRate) {
    alertNow = !prev.alerted
    state.alerted = true
  } else if (frac < lim.missRate) {
    state.alerted = false // re-arm once the rate recovers
  }

  return { state, result, alertNow }
}

export const TTL_MS = 14 * 86_400_000
