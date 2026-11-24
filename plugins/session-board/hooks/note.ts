import type { Note, State } from '../types'

export type { Note, State }

export const MAX_PENDING = 5
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000

const blank: Note = {
  state: 'your-turn',
  goal: '',
  topic: '',
  stage: '',
  pending: [],
  next: '',
  firstPrompt: '',
  seed: '',
  firstAnswer: '',
  lastAnswer: '',
  autoTries: 0,
  autoAt: 0,
  isTopicAuto: false,
  lastPrompt: '',
  since: 0,
  updatedAt: 0,
}

// Cards saved by older versions lack newer fields; fill them so checks never compare undefined.
export const normalize = (n: Partial<Note> | null | undefined): Note | null => (n ? { ...blank, ...n } : null)

// Card rows must stay one line, with no markup: pasted prompts carry newlines and <tags>.
export const clean = (v: unknown) => String(v ?? '').replace(/<\/?[a-zA-Z_][^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
const oneLine = (v: unknown, max: number) => clean(v).slice(0, max)

// Merge a patch into the old note; `since` moves only when the state changes.
export const apply = (old: Note | null | undefined, patch: Partial<Note>, now: number): Note => {
  const prev = normalize(old) ?? { ...blank, since: now }
  const merged = { ...prev, ...patch, updatedAt: now }
  merged.since = merged.state === prev.state && old ? prev.since : now
  merged.pending = (merged.pending ?? []).map(s => oneLine(s, 80)).filter(Boolean).slice(0, MAX_PENDING)
  merged.goal = oneLine(merged.goal, 100)
  merged.topic = oneLine(merged.topic, 80)
  merged.stage = oneLine(merged.stage, 20)
  merged.next = oneLine(merged.next, 100)
  merged.firstPrompt = oneLine(merged.firstPrompt, 100)
  merged.seed = oneLine(merged.seed, 1500)
  merged.firstAnswer = oneLine(merged.firstAnswer, 1500)
  merged.lastAnswer = oneLine(merged.lastAnswer, 1500)
  merged.lastPrompt = oneLine(merged.lastPrompt, 80)

  return merged
}

const LIGHT: Record<State, { light: string; label: string; color: 'success' | 'warning' | 'error' }> = {
  working: { light: '🟢', label: 'Claude working', color: 'success' },
  'your-turn': { light: '🟡', label: 'Your turn', color: 'warning' },
  blocked: { light: '🔴', label: 'Blocked', color: 'error' },
}

export type Card = {
  color: 'success' | 'warning' | 'error'
  header: string
  goal: string
  isGoalGuess: boolean
  now: string
  isNowGuess: boolean
  items: string[]
  next: string
}

// What the card shows; null means "nothing yet", drawn as a single calm line.
export const card = (raw: Note | null, now: number): Card | null => {
  const n = normalize(raw)
  if (!n || (!real(n.goal) && !n.firstPrompt && !real(n.topic) && !n.lastPrompt && n.pending.length === 0)) return null

  const look = LIGHT[n.state] ?? LIGHT['your-turn']
  const mins = Math.max(0, Math.floor((now - n.since) / 60000))
  const header = [`${look.light} ${look.label}`, n.stage, mins ? `${mins}m` : 'just now'].filter(Boolean).join(' · ')

  return {
    color: look.color,
    header,
    goal: real(n.goal) || n.firstPrompt,
    isGoalGuess: !real(n.goal),
    now: real(n.topic) || n.lastPrompt,
    isNowGuess: !real(n.topic),
    items: n.pending,
    next: n.next || n.pending[0] || '',
  }
}

// Reads the summarizer's two lines: "GOAL: ..." and "NOW: ...".
// A line that admits it does not know is worse than no line: drop it and try again later.
const VAGUE = /\b(unknown|unclear|not (shown|available|provided|known)|no (details|information|context)|can'?t tell)\b/i

const pick = (text: string, label: string, max: number) => {
  const v = clean(new RegExp(`${label}:\\s*(.+)`, 'i').exec(text)?.[1]).slice(0, max)

  return VAGUE.test(v) ? '' : v
}

// Cards saved before the vague filter existed may still hold an "Unknown" line.
export const real = (v: string) => (VAGUE.test(v) ? '' : v)

export const parseSummary = (text: string) => ({ goal: pick(text, 'GOAL', 100), now: pick(text, 'NOW', 80) })

export const MAX_TRIES = 3
export const NOW_EVERY_MS = 10 * 60 * 1000

// Ask when the goal is still missing (a few tries) or Claude's silence left Now stale.
export const shouldAsk = (raw: Note, now: number) => {
  const n = normalize(raw)!

  return (
    (!real(n.goal) && n.autoTries < MAX_TRIES) ||
    ((n.isTopicAuto || !real(n.topic)) && now - n.autoAt >= NOW_EVERY_MS)
  )
}

export const isOld = (n: Note, now: number) => now - n.updatedAt > KEEP_MS
