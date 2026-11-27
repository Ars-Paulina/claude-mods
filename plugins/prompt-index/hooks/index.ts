import type { Item } from '../types'

const tag = (text: string, name: string) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim()

// One line for the list: a slash command as "/name args", anything else its first non-empty line.
export function label(text: string, door?: string): string {
  const name = tag(text, 'command-name')
  if (name || door === 'command') {
    const cmd = name ?? text.trim()
    const args = tag(text, 'command-args') ?? ''
    const full = `${cmd.startsWith('/') ? cmd : `/${cmd}`} ${args}`.trim()

    return (full.split('\n')[0] ?? '').trim()
  }

  return (text.split('\n').find(l => l.trim() !== '') ?? '').trim()
}

// Backfill rows carry no origin, so engine-made user rows are told apart by their text.
const NOISE = [
  /^<task-notification>/,
  /^<system-reminder>/,
  /^<local-command-/,
  /^<bash-(input|stdout|stderr)>/,
  /^Base directory for this skill:/,
  /^Caveat: /,
  /^\[Request interrupted/,
  /^This session is being continued from a previous conversation/,
]

export function isTyped(text: string): boolean {
  const t = text.trim()
  if (t === '') return false
  if (/^<command-(name|message)>/.test(t)) return true

  return !NOISE.some(re => re.test(t))
}

// Backfill wins on a shared uuid; order by pos (backfill negative, live from 1).
export function rebuild(backfill: Item[], live: Item[]): Item[] {
  const seen = new Set(backfill.map(i => i.uuid))

  return [...backfill, ...live.filter(i => !seen.has(i.uuid))].sort((a, b) => a.pos - b.pos)
}

// A prompt the person typed while Claude was busy: prompt.submit carries the running turn's id only then.
export function isBusyTyped(e: { text: string; turnId?: string; isMeta?: true; command?: unknown; origin: { kind: string } }): boolean {
  return !!e.turnId && !e.isMeta && !e.command && (e.origin.kind === 'composer' || e.origin.kind === 'bridge') && isTyped(e.text)
}

// A busy-typed prompt is listed at once under a throwaway uuid (queued). The queue hands them over in order: one that
// Claude folds into its running turn never gets a row of its own, one that waits comes back later as a normal row.
// So a normal row takes the oldest queued row with its label, and whatever queued before that one was folded (settled).
// With no match the queue was empty, so everything queued is settled.
// ponytail: a folded prompt typed again word for word as the very next prompt shows once. Needs queue-record ids to tell apart.
export function addLive(list: Item[], row: Item, queued: boolean): Item[] {
  if (queued) return [...list, { ...row, queued: true }]
  const at = list.findIndex(i => i.queued && i.label === row.label)
  const settled = list.map((i, n) => (i.queued && (at < 0 || n < at) ? { uuid: i.uuid, label: i.label, pos: i.pos } : i))

  return at < 0 ? [...settled, row] : settled.map((i, n) => (n === at ? { uuid: row.uuid, label: row.label, pos: i.pos } : i))
}

export function fit(text: string, cols: number): string {
  const max = Math.max(1, cols)

  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
