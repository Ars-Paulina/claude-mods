import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StatuslineRows } from '../types'
import { ctxBridgeDoc, graftText, isoToMs, isSafeId, rateLimitDoc, renderRows, snapshotDoc } from './format'
import { fgToColor, gitInfo, resolveIdentity } from './identity'

const view = atom({ plugin: 'statusline', key: 'view' } as const, null as StatuslineRows | null)

type Paths = { home: string; claudeDir: string; snapshotDir: string; isLegacy: boolean; tmp: string }

// Turn clock fallback when the usage-limits cache has none yet.
let sentAt = 0
let receivedAt = 0

const expand = (p: string, home: string) => p.trim().replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')

// File text, or null when missing/unreadable (a directory reads as null too).
async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
  } catch {
    return null
  }
}

function parse(text: string | null): any {
  try {
    return text === null ? null : JSON.parse(text)
  } catch {
    return null
  }
}

// One failed write never blocks the others: each reader (hermes, supervisor, context monitor) is separate.
// ponytail: $.fs.write is not atomic (no rename); a reader can catch a half-written file for a moment.
async function put($: EngineInterface, path: string, doc: unknown): Promise<void> {
  try {
    await $.fs.write(path, JSON.stringify(doc))
  } catch (err) {
    $.ui.log(`statusline: write ${path}: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

// Old renderer spawned statusline-refresh.js (git dirty flag, turn clock) at most every 2 minutes.
async function kickRefresh($: EngineInterface, paths: Paths, cache: any, cwd: string, transcript: string): Promise<void> {
  const script = `${paths.claudeDir}/hooks/statusline-refresh.js`
  if (!(await $.fs.exists(script))) return
  const now = Date.now()
  const lock = parseInt((await readText($, `${paths.claudeDir}/cache/refresh.lock`)) ?? '', 10)
  if (!isNaN(lock) && now - lock < 120_000) return
  if (cache?._timestamp && Math.floor(now / 1000) - cache._timestamp < 120) return
  const { version } = await $.session.version()
  await $.process.run(['node', script, version ?? 'unknown', cwd, transcript], { timeoutMs: 20_000 })
}

async function snapshot($: EngineInterface, paths: Paths): Promise<void> {
  const cwd = await $.session.cwd()
  const [model, sessionId, turns, usage, session] = await Promise.all([
    $.session.model(), $.session.id(), $.session.turns(), $.session.usage(), $.session.info(),
  ])
  const git = await gitInfo(p => readText($, p), cwd)
  const root = git?.root ?? cwd
  const identity = resolveIdentity(root.split('/').filter(Boolean).pop() ?? '', root,
    parse(await readText($, `${paths.claudeDir}/config/project-colors.json`)), paths.home)
  const cache = parse(await readText($, `${paths.claudeDir}/cache/usage-limits.json`)) ?? {}

  const info = {
    model, sessionId, turns, cwd, branch: git?.branch ?? null,
    project: cwd.split('/').filter(Boolean).pop() ?? '',
    contextPercent: usage.context.percent,
    rateLimits: usage.rateLimits,
    sentAt: isoToMs(cache.last_user_ts) || sentAt,
    receivedAt: isoToMs(cache.last_assistant_ts) || receivedAt,
    isDirty: cache.git_dirty === true,
    transcript: session.transcriptPath,
    graft: graftText(await readText($, `${git?.top ?? cwd}/graft/.cache/stats.json`)),
    key: identity.key, color: fgToColor(identity.fg), isMoney: identity.money,
  }
  const rows = renderRows(info)
  await update($, view, () => rows)

  const now = Date.now()
  if (paths.snapshotDir && isSafeId(sessionId)) await put($, `${paths.snapshotDir}/${sessionId}.json`, snapshotDoc(info, rows, now))
  if (!paths.isLegacy) return
  const limits = rateLimitDoc(info, now)
  if (limits && isSafeId(sessionId)) await put($, `${paths.claudeDir}/cache/rate-limits/${sessionId}.json`, limits)
  const bridge = ctxBridgeDoc(info, now)
  if (bridge && isSafeId(sessionId)) await put($, `${paths.tmp}/claude-ctx-${sessionId}.json`, bridge)
  await kickRefresh($, paths, cache, cwd, session.transcriptPath)
}

async function refresh($: EngineInterface, paths: Paths): Promise<void> {
  try {
    // A `claude -p` run draws nothing and never had a status line: skip.
    if ((await $.session.surfaces()).length === 0) return
    await snapshot($, paths)
  } catch (err) {
    // Display + capture are best effort; never break the session over a status row.
    $.ui.log(`statusline: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

async function pathsOf($: EngineInterface, options: Record<string, unknown>): Promise<Paths> {
  const home = (await $.env.get('HOME')) ?? ''
  return {
    home,
    claudeDir: expand(String(options.claudeDir ?? '~/.claude'), home),
    snapshotDir: expand(String(options.snapshotDir ?? '~/.claude/hermes/statusline'), home),
    isLegacy: options.legacyFiles !== false,
    tmp: ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, ''),
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const paths = await pathsOf($, options)
    sentAt = receivedAt = 0
    await update($, view, () => null)
    $.clock.after(0, () => refresh($, paths))
    // Readers treat a snapshot older than ~90s as "not live"; the context monitor drops metrics over 60s.
    $.clock.every(30_000, () => refresh($, paths))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result // a subagent's turn is not the session's
    receivedAt = Date.now()
    sentAt = receivedAt - e.durationMs
    const paths = await pathsOf($, options)
    $.clock.after(0, () => refresh($, paths))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, view)
    if (rows === null || e.props.hasSurvey) return next(e)
    const below = await next(e) // stack over any band beneath us, so load order hides none
    const { Box, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns || 80
    const cut = (t: string, room = width) => (t.length > room ? t.slice(0, Math.max(room - 1, 1)) + '…' : t)
    const lead = `${rows.isMoney ? '⚠ ' : ''}${rows.key ? rows.key + ' ' : ''}`
    const own = (
      <Box flexDirection="column">
        <Text>
          {rows.isMoney ? <Text bold color="redBright">⚠ </Text> : null}
          {rows.key ? <Text bold color={rows.color}>{rows.key} </Text> : null}
          {cut(rows.row1, width - lead.length)}
        </Text>
        <Text color={rows.color}>{cut(rows.row2)}</Text>
        {rows.row3 ? <Text dimColor>{cut(rows.row3)}</Text> : null}
        {rows.row4 ? <Text dimColor>{cut(rows.row4)}</Text> : null}
      </Box>
    )
    return below ? <Box flexDirection="column">{own}{below}</Box> : own
  })
}
