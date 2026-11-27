// Pure helpers for the compact-briefing mod: no I/O, so the test can run them alone.

export const PROGRESS_RE = /^session-progress-.*\.md$/

// Same slug Claude Code project dirs and the handoff writer use.
export const slugify = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-')

// Session key from a transcript path: file name without .jsonl, word chars and dashes only.
export const sessionKey = (transcriptPath: unknown): string =>
  String(transcriptPath ?? '').split('/').pop()!.replace(/\.jsonl$/, '').replace(/[^\w-]/g, '')

export const isFresh = (mtimeMs: number, now: number, maxMin: number): boolean => (now - mtimeMs) / 60000 <= maxMin

// Cut to maxBytes of UTF-8 without splitting a character, then point at the source file.
export function capBytes(output: string, maxBytes: number, source: string): string {
  let bytes = 0
  let end = 0
  for (const ch of output) {
    const n = ch.codePointAt(0)! < 0x80 ? 1 : ch.codePointAt(0)! < 0x800 ? 2 : ch.codePointAt(0)! < 0x10000 ? 3 : 4
    if (bytes + n > maxBytes) return `${output.slice(0, end)}\n...[truncated, see ${source}]`
    bytes += n
    end += ch.length
  }
  return output
}

export type Entry = { name: string; mtimeMs: number }

// The freshest session-progress-*.md, or null when none is within the window.
export function newestProgress(entries: readonly Entry[], now: number, maxAgeMin: number): Entry | null {
  const files = entries.filter(e => PROGRESS_RE.test(e.name))
  if (files.length === 0) return null
  const top = files.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))

  return isFresh(top.mtimeMs, now, maxAgeMin) ? top : null
}

// Last "## " section of a progress report, under a header naming the file and its time.
export function progressBriefing(name: string, path: string, content: string, maxBytes: number): string | null {
  const lines = content.split('\n')
  let last = -1
  lines.forEach((l, i) => { if (/^## /.test(l)) last = i })
  if (last === -1) return null

  const ts = (lines[last] ?? '').match(/^##\s+(\d{1,2}:\d{2})/)
  const header = ts
    ? `## Recovered session briefing (from ${name}, written ${ts[1]})`
    : `## Recovered session briefing (from ${name})`

  return capBytes(`${header}\n\n${lines.slice(last).join('\n')}`, maxBytes, path)
}

// /clear fallback: the handoff snapshot, with the "verify before repeating" guard text.
export function handoffBriefing(path: string, content: string, maxBytes: number): string | null {
  if (!content.trim()) return null

  const out = `## Recovered session handoff (post-/clear, from ${path.split('/').pop()})\n\n` +
    'UNVERIFIED snapshot: "Last assistant output" is copied verbatim from the previous session and may hold wrong claims ' +
    '("done", "fixed", "turned off"). Before repeating any claim, check it in files or git this turn; mark unchecked ones `unverified`.\n' +
    "Open your first reply with 3 lines: what we did last time / what's pending / suggested next step.\n\n" + content

  return capBytes(out, maxBytes, path)
}

export const compactCountLine = (n: number): string | null =>
  n < 2 ? null : `[compact-count] This session has compacted ${n} times. At the next task boundary: ` +
    'write a handoff (/plan-handoff or /pause), tell Pedro to start a fresh session, and take no new task here.'

// Joins the pieces that exist, in order.
export const join = (...parts: (string | null | undefined)[]): string | null => {
  const kept = parts.filter((p): p is string => !!p)

  return kept.length ? kept.join('\n\n') : null
}
