import type { Item, Note, State } from '../types'

import { clean, oneLine, real, MAX_STORED } from './haiku'

export type { Item, Note, State }
export { clean, real }

export const MAX_PENDING = 5 // rows the card draws; the rest hide behind "+N more"
export const KEEP_MS = 30 * 24 * 60 * 60 * 1000

const blank: Note = {
  state: 'your-turn',
  goal: '',
  topic: '',
  stage: '',
  pending: [],
  nextN: 1,
  next: '',
  firstPrompt: '',
  seed: '',
  firstAnswer: '',
  lastAnswer: '',
  autoTries: 0,
  autoAt: 0,
  isTopicAuto: false,
  lastPrompt: '',
  cardTurn: '',
  freshTurn: '',
  isPendingLive: false,
  failCount: 0,
  staleSince: 0,
  lastSeen: 0,
  since: 0,
  updatedAt: 0,
}

// Pending arrives as plain strings from the `set` tool and from cards saved by
// older versions: number those 1..k. Items that already carry a number keep it.
const toItems = (list: unknown): Item[] =>
  (Array.isArray(list) ? list : [])
    .map((v, i) => (v && typeof v === 'object' ? { n: Number((v as Item).n), text: oneLine((v as Item).text, 80) } : { n: i + 1, text: oneLine(v, 80) }))
    .filter(i => i.text !== '' && Number.isFinite(i.n))

// Cards saved by older versions lack newer fields; fill them so checks never compare undefined.
export const normalize = (n: Partial<Note> | null | undefined): Note | null => (n ? { ...blank, ...n, pending: toItems(n.pending) } : null)

// Merge a patch into the old note; `since` moves only when the state changes.
export const apply = (old: Note | null | undefined, patch: Partial<Note>, now: number): Note => {
  const prev = normalize(old) ?? { ...blank, since: now }
  const merged = { ...prev, ...patch, updatedAt: now }
  merged.since = merged.state === prev.state && old ? prev.since : now
  merged.pending = toItems(merged.pending).slice(-MAX_STORED)
  merged.nextN = Math.max(merged.nextN || 1, ...merged.pending.map(i => i.n + 1)) // a number is never handed out twice
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

// Fresh = the cheap model finished for the latest turn that asked it. A call in
// flight, a failed call or a card restored from disk is not fresh. The marker
// hook in ~/.claude reads these same two fields from the store file.
export const isFresh = (n: Note) => n.freshTurn !== '' && n.freshTurn === n.cardTurn

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
  more: number
  next: string
}

const mins = (from: number, now: number) => Math.max(0, Math.floor((now - from) / 60000))

// What the card shows; null means "nothing yet", drawn as a single calm line.
export const card = (raw: Note | null, now: number): Card | null => {
  const n = normalize(raw)
  if (!n || (!real(n.goal) && !n.firstPrompt && !real(n.topic) && !n.lastPrompt && n.pending.length === 0)) return null

  const look = LIGHT[n.state] ?? LIGHT['your-turn']
  const age = mins(n.since, now)
  // A failed update must be seen: an old card that looks current is the one thing worse than no card.
  const stale = n.staleSince > 0 && !isFresh(n) ? `stale ${mins(n.staleSince, now)}m${n.failCount > 1 ? ` ×${n.failCount}` : ''}` : ''
  const header = [`${look.light} ${look.label}`, n.stage, age ? `${age}m` : 'just now', stale].filter(Boolean).join(' · ')

  return {
    color: look.color,
    header,
    goal: real(n.goal) || n.firstPrompt,
    isGoalGuess: !real(n.goal),
    now: real(n.topic) || n.lastPrompt,
    isNowGuess: !real(n.topic),
    items: n.pending.slice(0, MAX_PENDING).map(i => `${i.n}. ${i.text}`),
    more: Math.max(0, n.pending.length - MAX_PENDING),
    next: n.next || n.pending[0]?.text || '',
  }
}

export const isOld = (n: Note, now: number) => now - n.updatedAt > KEEP_MS
