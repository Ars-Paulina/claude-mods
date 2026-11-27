import type { Register } from 'claude-code'

import { pickPlan, summarize } from './index'

const HEAD = 1500

// The reminder for this session's plan, or null: no plan, no Goals, kill switch, anything wrong.
async function reminder($: any): Promise<string | null> {
  try {
    if (String((await $.env.get('GOALS_MODE')) || '').toLowerCase() === 'off') return null
    const dir = `${(await $.env.get('HOME')) || ''}/.claude/plans`
    const uuid = await $.session.id()
    const files = []
    for (const f of await $.fs.list(dir)) {
      if (f.kind !== 'file' || !f.name.endsWith('.md')) continue
      try {
        files.push({ name: f.name, mtimeMs: f.mtimeMs, head: String(await $.fs.read(`${dir}/${f.name}`, { length: HEAD })) })
      } catch (_) {
        continue
      }
    }
    const name = pickPlan(files, uuid)

    return name ? summarize(String(await $.fs.read(`${dir}/${name}`)), name) : null
  } catch (_) {
    return null
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  // Every prompt: add the reminder as context, the prompt text stays as typed.
  // Fail-open on purpose (a reminder never blocks a prompt): the .catch passes the prompt on unchanged.
  on('prompt.submit', async ($, e, next) => {
    const msg = e.command ? null : await reminder($)

    return next(msg ? { ...e, context: [...(e.context ?? []), msg] } : e)
  }).catch(($, e, next) => next(e))

  // Fail-open too: a compaction is never blocked by a broken reminder.
  // After a compaction the plan state is re-sent with the next request, before the next prompt.
  on('session.compact', async ($, e, next) => {
    const res = await next(e)
    if (!e.agentId && !res.skip) {
      const msg = await reminder($)
      if (msg) {
        try {
          await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: msg }] } })
        } catch (err) {
          $.ui.log(`plan-goals-reminder: re-inject failed: ${String(err)}`, { to: 'debug' })
        }
      }
    }

    return res
  }).catch(($, e, next) => next(e))
}
