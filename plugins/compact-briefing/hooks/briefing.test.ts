import { test, expect, mock } from 'claude-code/testing'

import { capBytes, compactCountLine, handoffBriefing, newestProgress, progressBriefing, sessionKey, slugify } from './briefing'

const REPORT = '# Report\n## 09:00 first\nold\n## 10:30 second\nnewest line\n'

test('progressBriefing keeps only the last section, with file name and time', async () => {
  const out = progressBriefing('session-progress-a.md', '/p/session-progress-a.md', REPORT, 8192)!
  expect(out.startsWith('## Recovered session briefing (from session-progress-a.md, written 10:30)')).toBe(true)
  expect(out).toContain('newest line')
  expect(out).not.toContain('old')
  expect(progressBriefing('x.md', '/x.md', 'no headings', 8192)).toBe(null)
})

test('newestProgress picks the freshest file and drops stale ones', async () => {
  const now = 10 * 60000
  const files = [{ name: 'session-progress-a.md', mtimeMs: 1 * 60000 }, { name: 'session-progress-b.md', mtimeMs: 9 * 60000 }, { name: 'notes.md', mtimeMs: now }]
  expect(newestProgress(files, now, 5)!.name).toBe('session-progress-b.md')
  expect(newestProgress(files, now, 0.5)).toBe(null)
  expect(newestProgress([], now, 5)).toBe(null)
})

test('capBytes cuts on a character boundary and points at the source', async () => {
  expect(capBytes('abc', 10, '/f')).toBe('abc')
  expect(capBytes('aéé', 3, '/f')).toBe('aé\n...[truncated, see /f]')
})

test('handoff briefing carries the unverified guard; blank content is none', async () => {
  const out = handoffBriefing('/c/session-state/x.md', 'last words', 8192)!
  expect(out).toContain('post-/clear, from x.md')
  expect(out).toContain('UNVERIFIED snapshot')
  expect(handoffBriefing('/c/x.md', '  \n', 8192)).toBe(null)
})

test('slug, session key and compact-count threshold', async () => {
  expect(slugify('/home/p/My App')).toBe('-home-p-My-App')
  expect(sessionKey('/t/abc-123.jsonl')).toBe('abc-123')
  expect(sessionKey('')).toBe('')
  expect(compactCountLine(1)).toBe(null)
  expect(compactCountLine(2)).toContain('compacted 2 times')
})

// The engine beneath the mod: a disk of three files, process.run answering by command.
function engine(on: any, disk: Record<string, { text: string; mtimeMs: number }>, opts: { boundaries?: number; digest?: string; throwList?: boolean } = {}) {
  const written: Record<string, string> = {}
  mock.env(on, { HOME: '/home/t' })
  on('ui.log', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))
  on('classic.PostCompact', () => ({}))
  on('fs.list', (_$: any, e: any) => {
    if (opts.throwList) throw new Error('boom')
    const dir = String(e.path).replace(/\/$/, '')

    return { value: Object.entries(disk).filter(([p]) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
      .map(([p, f]) => ({ name: p.slice(dir.length + 1), kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })) }
  })
  on('fs.read', (_$: any, e: any) => ({ value: disk[e.path]?.text ?? '' }))
  on('fs.stat', (_$: any, e: any) => {
    const f = disk[e.path]
    if (!f) throw new Error('ENOENT')

    return { value: { kind: 'file', size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
  })
  on('fs.write', (_$: any, e: any) => { written[e.path] = e.text; return { value: undefined } })
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv
    const out = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } })
    if (argv[0] === 'grep') return opts.boundaries ? out(String(opts.boundaries)) : out('', 1)
    if (argv.includes('digest')) return out(opts.digest ?? '')
    if (argv.includes('autonomous')) return out('0')

    return out('')
  })

  return written
}

const compact = ($: any, extra: Record<string, unknown> = {}) =>
  $.classic.SessionStart({ source: 'compact', cwd: '/proj', transcript_path: '/t/sess-1.jsonl', session_id: 's1', ...extra })

test('compact: injects digest first, then the last report section, then the count line', async ($, on) => {
  const now = Date.now()
  engine(on, { '/proj/session-progress-a.md': { text: REPORT, mtimeMs: now } }, { boundaries: 3, digest: 'DIGEST' })
  const r: any = await compact($)
  const text: string = r.additionalContext.join('\n')
  expect(text.indexOf('DIGEST')).toBe(0)
  expect(text.indexOf('newest line')).toBeGreaterThan(text.indexOf('DIGEST'))
  expect(text).toContain('compacted 3 times')
})

test('clear: falls back to the handoff file, no digest or count', async ($, on) => {
  const now = Date.now()
  engine(on, { '/home/t/.claude/cache/session-state/-proj.md': { text: 'handoff body', mtimeMs: now } }, { boundaries: 5, digest: 'DIGEST' })
  const r: any = await compact($, { source: 'clear' })
  const text: string = r.additionalContext.join('\n')
  expect(text).toContain('handoff body')
  expect(text).not.toContain('DIGEST')
  expect(text).not.toContain('compact-count')
})

test('startup and a broken disk both fail open: no context, no throw', async ($, on) => {
  engine(on, {}, { throwList: true })
  const startup: any = await compact($, { source: 'startup' })
  expect(startup.additionalContext ?? []).toEqual([])
  const broken: any = await compact($)
  expect(broken.additionalContext ?? []).toEqual([])
})
