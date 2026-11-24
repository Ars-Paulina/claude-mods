import type { EngineInterface, Register } from 'claude-code'

import { capBytes, compactCountLine, handoffBriefing, isFresh, join, newestProgress, progressBriefing, sessionKey, slugify } from './briefing'

type Engine = EngineInterface

const int = (v: string | undefined, d: number): number => {
  const n = parseInt(v ?? '', 10)

  return Number.isFinite(n) ? n : d
}

const cacheDir = async ($: Engine): Promise<string> => `${(await $.env.get('HOME')) ?? ''}/.claude/cache`

// Runs the bridge to Pedro's own hook libs; '' when it prints nothing or fails.
async function homeLib($: Engine, ...args: string[]): Promise<string> {
  try {
    const run = await $.process.run(['node', `${$.plugin.root}/scripts/home-libs.cjs`, ...args], { timeoutMs: 4000 })

    return run.exitCode === 0 ? run.stdout : ''
  } catch (_) {
    return ''
  }
}

const readText = async ($: Engine, path: string): Promise<string | null> => {
  try {
    return String(await $.fs.read(path))
  } catch (_) {
    return null
  }
}

async function progress($: Engine, cwd: string, maxAgeMin: number, maxBytes: number): Promise<string | null> {
  try {
    const top = newestProgress(await $.fs.list(cwd), Date.now(), maxAgeMin)
    if (!top) return null
    const path = `${cwd}/${top.name}`
    const content = await readText($, path)

    return content === null ? null : progressBriefing(top.name, path, content, maxBytes)
  } catch (_) {
    return null
  }
}

async function handoff($: Engine, cwd: string, maxAgeMin: number, maxBytes: number): Promise<string | null> {
  try {
    const path = `${await cacheDir($)}/session-state/${slugify(cwd)}.md`
    const st = await $.fs.stat(path)
    if (!isFresh(st.mtimeMs, Date.now(), maxAgeMin)) return null
    const content = await readText($, path)

    return content === null ? null : handoffBriefing(path, content, maxBytes)
  } catch (_) {
    return null
  }
}

// Flag precompact-report-guard turns into a post-compact report on the next prompt.
async function writeReportMarker($: Engine, cwd: string, transcriptPath: string, key: string): Promise<void> {
  if (((await $.env.get('PROGRESS_REPORT_POSTCOMPACT')) ?? 'on').toLowerCase() !== 'on') return
  const freshMin = int(await $.env.get('PROGRESS_REPORT_POSTCOMPACT_FRESH_MIN'), 10)
  const now = Date.now()
  // A report written moments ago already covers this compaction.
  const entries = await $.fs.list(cwd).catch(() => [])
  if (newestProgress(entries, now, freshMin)) return

  await $.fs.write(`${await cacheDir($)}/postcompact-report-pending-${key}.flag`,
    JSON.stringify({ cwd, transcript_path: transcriptPath, ctime: now, emits: 0 }))
}

const deliveredFlag = async ($: Engine, key: string): Promise<string> => `${await cacheDir($)}/digest-delivered-${key}.flag`

// Auto-compaction fires no SessionStart, so the digest is queued for the guard to relay.
async function writeDigestMarker($: Engine, cwd: string, key: string): Promise<void> {
  if (((await $.env.get('CORE_DIGEST_MODE')) ?? '').toLowerCase() === 'off') return
  // SessionStart(compact) just delivered it: PostCompact fires right after on a manual /compact.
  const delivered = await $.fs.stat(await deliveredFlag($, key)).catch(() => null)
  if (delivered && Date.now() - delivered.mtimeMs < 60000) return
  if (!(await homeLib($, 'digest'))) return

  await $.fs.write(`${await cacheDir($)}/postcompact-digest-pending-${key}.flag`, JSON.stringify({ cwd, ctime: Date.now() }))
}

async function compactCount($: Engine, transcriptPath: string, sessionId: string): Promise<string | null> {
  if (((await $.env.get('COMPACT_COUNT_MODE')) ?? '').toLowerCase() === 'off') return null
  if (!transcriptPath) return null
  const run = await $.process.run(['grep', '-c', '"compact_boundary"', transcriptPath], { timeoutMs: 4000 })
  const line = compactCountLine(run.exitCode === 0 ? parseInt(run.stdout, 10) || 0 : 0) // grep exits 1 on zero matches
  if (!line) return null
  // An unattended run ends with its own recap: telling it to stop would stall it.
  if ((await homeLib($, 'autonomous', sessionId)).trim() === '1') return null
  await homeLib($, 'fire', 'compact-count')

  return line
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('classic.SessionStart', async ($, e, next) => {
    const beneath = await next(e)
    // Fail-open: a briefing is a nicety, a broken one must never block the session.
    try {
      if (e.source !== 'compact' && e.source !== 'clear') return beneath
      const cwd = String(e.cwd ?? '')
      if (!cwd) return beneath
      const maxAge = int(await $.env.get('BRIEFING_INJECT_MAX_AGE_MIN'), 120)
      const maxBytes = int(await $.env.get('BRIEFING_INJECT_MAX_BYTES'), 8192)
      const clearMaxAge = int(await $.env.get('BRIEFING_CLEAR_MAX_AGE_MIN'), 720)
      const tp = String(e.transcript_path ?? '')
      const key = sessionKey(tp)

      if (e.source === 'compact' && key) await writeReportMarker($, cwd, tp, key).catch(() => {})

      // Progress report first; on /clear alone, fall back to the handoff snapshot.
      let briefing = await progress($, cwd, maxAge, maxBytes)
      if (briefing === null && e.source === 'clear') briefing = await handoff($, cwd, clearMaxAge, maxBytes)

      // The digest goes first and after the cap, so a long briefing can never cut it.
      let digest: string | null = null
      if (e.source === 'compact' && ((await $.env.get('CORE_DIGEST_MODE')) ?? '').toLowerCase() !== 'off') {
        digest = (await homeLib($, 'digest')) || null
        if (digest && key) await $.fs.write(await deliveredFlag($, key), String(Date.now())).catch(() => {})
      }
      const count = e.source === 'compact' ? await compactCount($, tp, String(e.session_id ?? '')).catch(() => null) : null

      const text = join(digest, briefing, count)
      if (text === null) return beneath

      return { ...beneath, additionalContext: [...(beneath.additionalContext ?? []), text] }
    } catch (_) {
      return beneath
    }
  }).catch(($, e, next) => next(e)) // fail-open on purpose: a briefing must never block a session

  // PostCompact stdout is inert: only the markers matter, for auto and manual compaction alike.
  on('classic.PostCompact', async ($, e, next) => {
    try {
      const key = sessionKey(e.transcript_path)
      if (key) {
        const cwd = String(e.cwd ?? '')
        await writeReportMarker($, cwd, String(e.transcript_path), key)
        await writeDigestMarker($, cwd, key)
      }
    } catch (_) { /* fail-open */ }

    return next(e)
  }).catch(($, e, next) => next(e)) // fail-open: markers are best-effort
}
