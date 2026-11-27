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

// The queue door raises a prompt typed while Claude is busy twice (enqueue, then remove) under throwaway uuids.
// A prompt that later arrives as a normal row takes the queued row's place and its real uuid, so the jump works.
// ponytail: matches on the label, so two identical prompts typed while busy show as one row. Key on queue-record ids if that bites.
export function addLive(list: Item[], row: Item, queued: boolean): Item[] {
  const at = list.findIndex(i => i.queued && i.label === row.label)
  if (queued) return at >= 0 ? list : [...list, { ...row, queued: true }]
  if (at < 0) return [...list, row]

  return list.map((i, n) => (n === at ? { uuid: row.uuid, label: row.label, pos: i.pos } : i))
}

export function fit(text: string, cols: number): string {
  const max = Math.max(1, cols)

  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
