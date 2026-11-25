import type { EngineInterface as Engine, Register } from 'claude-code'

import { REASON, shouldProceed } from './index'

// Sessions an oversee run drives get their continues from the overseer, not from here.
// Live run record: ~/.claude/state/oversee/<run-id>.json (overseer_session + workers[].session).
async function isOverseen($: Engine, sid: string): Promise<boolean> {
  const dir = `${await $.env.get('HOME')}/.claude/state/oversee`
  if (!sid || !(await $.fs.exists(dir))) return false
  for (const entry of await $.fs.list(dir)) {
    const { name } = entry
    if (!name.endsWith('.json')) continue
    try {
      const run = JSON.parse(await $.fs.read(`${dir}/${name}`))
      if (run.status !== 'running') continue
      if (run.overseer_session === sid || (run.workers ?? []).some((w: any) => w?.session === sid)) return true
    } catch {
      // unreadable run record: not this session's problem
    }
  }

  return false
}

export const register: Register = (on, options) => {
  const mode = String(options.mode ?? 'on')
  if (mode === 'off') return

  // ponytail: both live in memory, so a plugin reload mid-turn forgets them. Read the transcript instead if that ever bites.
  let askedUser = false
  let chain = 0

  on('prompt.submit', ($, e, next) => {
    askedUser = false

    return next(e)
  })

  on('tool.call', { tool: 'AskUserQuestion' }, ($, e, next) => {
    if ((e as { agentId?: string }).agentId === undefined) askedUser = true

    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    // Settings Stop hooks run beneath; if one of them already blocks, its reason stands.
    const below = await next(e)
    if (below.block) return below
    if (!e.stop_hook_active) chain = 0
    const { fire, why } = shouldProceed({ text: e.last_assistant_message ?? '', askedUser, chain })
    if (!fire || (await isOverseen($, e.session_id))) return below
    $.ui.log(`auto-proceed: ${mode === 'on' ? 'continued' : 'would have continued'} (${why})`)
    if (mode !== 'on') {
      $.ui.toast('auto-proceed (warn): would have continued')

      return below
    }
    chain += 1

    return { ...below, block: REASON }
    // Fail open: any error leaves the turn to end as it would have.
  }).catch(($, e, next) => next(e))
}
