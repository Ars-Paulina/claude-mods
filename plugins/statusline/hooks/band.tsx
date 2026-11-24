import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { branchFromHead, renderRows, snapshotDoc } from './format'

import type { StatuslineRows } from '../types'
const view = atom({ plugin: 'statusline', key: 'view' } as const, null as StatuslineRows | null)

// Per-session state the heartbeat reuses between turns.
let sentAt = 0
let receivedAt = 0

async function readBranch($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    let head = `${cwd}/.git/HEAD`
    if (!(await $.fs.exists(head))) return null
    // A worktree's `.git` is a file pointing at the real git dir; here `.git/HEAD` then doesn't exist.
    return branchFromHead(String(await $.fs.read(head)))
  } catch {
    return null
  }
}

// ponytail: in a git worktree `.git` is a file, so the branch shows blank there; follow its
// `gitdir:` line when that matters.
async function snapshot($: EngineInterface, dir: string): Promise<void> {
  const cwd = await $.session.cwd()
  const [model, sessionId, turns, usage, branch] = await Promise.all([
    $.session.model(), $.session.id(), $.session.turns(), $.session.usage(), readBranch($, cwd),
  ])
  const info = {
    model, sessionId, turns, cwd, branch,
    project: cwd.split('/').filter(Boolean).pop() ?? '',
    contextPercent: usage.context.percent,
    rateLimits: usage.rateLimits,
    sentAt, receivedAt,
  }
  const rows = renderRows(info)
  await update($, view, () => rows)
  if (dir) await $.fs.write(`${dir}/${sessionId}.json`, JSON.stringify(snapshotDoc(info, rows, Date.now())))
}

async function refresh($: EngineInterface, dir: string): Promise<void> {
  try {
    // A `claude -p` run draws nothing and never rendered a statusline: skip.
    if ((await $.session.surfaces()).length === 0) return
    await snapshot($, dir)
  } catch (err) {
    // Display + capture are best effort; never break the session over a status row.
    $.ui.log(`statusline: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const raw = String(options.snapshotDir ?? '').trim()

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const home = (await $.env.get('HOME')) ?? ''
    const dir = raw.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
    sentAt = receivedAt = 0
    await update($, view, () => null)
    $.clock.after(0, () => refresh($, dir))
    // A reader treats a snapshot older than ~90s as "not live": keep it fresh while idle.
    $.clock.every(30_000, () => refresh($, dir))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result // a subagent's turn is not the session's
    receivedAt = Date.now()
    sentAt = receivedAt - e.durationMs
    const home = (await $.env.get('HOME')) ?? ''
    const dir = raw.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
    $.clock.after(0, () => refresh($, dir))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, view)
    if (rows === null || e.props.hasSurvey) return next(e)
    const below = await next(e) // stack over any band beneath us, so load order hides none
    const { Box, Text } = $.ui.resolve(e)
    const width = e.props.bodyColumns || 80
    const cut = (t: string) => (t.length > width ? t.slice(0, Math.max(width - 1, 1)) + '…' : t)
    const own = (
      <Box flexDirection="column">
        <Text>{cut(rows.row1)}</Text>
        <Text dimColor>{cut(rows.row2)}</Text>
      </Box>
    )
    return below ? <Box flexDirection="column">{own}{below}</Box> : own
  })
}
