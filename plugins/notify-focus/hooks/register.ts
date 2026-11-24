import type { Register } from 'claude-code'
import { GLYPH, bodyOf, clickScript, isAttended, isDup, statusText, titleOf, whereAmI, type Event, type Where } from './notify'

type Ctx = { w: Where; home: string }
type Run = { exitCode: number; stdout: string }

// One entry per pane (or session outside tmux/herdr): the last glyph notified and when.
const last = new Map<string, { glyph: string; ts: number }>()

async function ctx($: any): Promise<Ctx> {
  const w = whereAmI({
    tmuxPane: await $.env.get('TMUX_PANE'),
    tmux: await $.env.get('TMUX'),
    herdrEnv: await $.env.get('HERDR_ENV'),
    herdrPane: await $.env.get('HERDR_PANE_ID'),
    herdrTab: await $.env.get('HERDR_TAB_ID'),
  })
  return { w, home: (await $.env.get('HOME')) ?? '' }
}

// Every shell-out is best effort: a missing tmux or script never breaks a turn.
const run = ($: any, argv: string[]): Promise<Run | undefined> =>
  $.process.run(argv, { timeoutMs: 3000 }).catch(() => undefined)

// The project label the tmux border shows, with the branch refreshed every prompt.
async function label($: any, c: Ctx, cwd: string): Promise<string> {
  const r = await run($, ['bash', `${c.home}/.claude/scripts/resolve-project-color.sh`, cwd])
  return r?.exitCode === 0 ? (r.stdout.trim().split('|')[0] ?? '') : ''
}

async function onEvent($: any, ev: Event, e: any) {
  const c = await ctx($)
  const cwd: string = e.cwd || ''
  const key = c.w.kind === 'plain' ? String(e.session_id ?? 'nopane') : c.w.pane
  $.ui.status(statusText(ev))

  if (c.w.kind === 'tmux') await run($, ['tmux', 'set', '-p', '-t', c.w.pane, '@agent_state', GLYPH[ev]])

  if (ev === 'UserPromptSubmit') {
    last.delete(key) // back to working: the next stop or question notifies again
    if (c.w.kind === 'tmux') {
      const name = await label($, c, cwd)
      const br = await run($, ['git', '-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'])
      const branch = br?.exitCode === 0 ? br.stdout.trim() : ''
      if (name) await run($, ['tmux', 'set', '-p', '-t', c.w.pane, '@proj_label', (branch ? `${name} [${branch}]` : name).replace(/#/g, '')])
    }
    return
  }

  if (ev === 'Notification') $.ui.toast(String(e.message ?? 'needs input').slice(0, 200))

  // done only nudges the desktop when nobody is at the tmux client
  if (ev === 'Stop' && c.w.kind === 'tmux') {
    const act = await run($, ['tmux', 'display', '-p', '-t', c.w.pane, '#{client_activity}'])
    if (act?.exitCode === 0 && isAttended(act.stdout.trim(), Math.floor(Date.now() / 1000))) return
  }

  const now = await $.clock.now()
  if (isDup(last.get(key), GLYPH[ev], now)) return
  last.set(key, { glyph: GLYPH[ev], ts: now })

  const name = (await label($, c, cwd)) || cwd.split('/').filter(Boolean).pop() || 'claude'
  const script = clickScript(c.w, {
    title: titleOf(ev, name),
    body: bodyOf(c.w, cwd),
    key: name,
    sid: String(e.session_id ?? ''),
    log: `${c.home}/.claude/logs/notify-focus.log`,
    raise: `${c.home}/.claude/scripts/herdr-raise.sh`,
  })
  // setsid -f detaches the click waiter so it outlives this hook; it waits up to 30 minutes.
  await run($, ['setsid', '-f', 'bash', '-c', script])
}

// Observers only: they never block or rewrite anything, so a failure just skips the notice.
async function watch($: any, ev: Event, e: any) {
  try {
    await onEvent($, ev, e)
  } catch (err) {
    $.ui.log(`notify-focus: ${ev} failed: ${String(err)}`)
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  on('classic.UserPromptSubmit', async ($, e, next) => (await watch($, 'UserPromptSubmit', e), next(e))).catch(($, e, next) => next(e))
  on('classic.Notification', async ($, e, next) => (await watch($, 'Notification', e), next(e))).catch(($, e, next) => next(e))
  on('classic.Stop', async ($, e, next) => (await watch($, 'Stop', e), next(e))).catch(($, e, next) => next(e))
}
