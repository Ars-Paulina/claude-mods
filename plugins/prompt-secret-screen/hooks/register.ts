import type { EngineInterface as Engine, Register } from 'claude-code'

import { detect, mask } from './detect'
import type { Hit } from './detect'

const LOG = '.claude/logs/prompt-secret-detections.log'

// sha256[:12] fingerprint: the log never holds raw secret bytes.
async function fp(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
}

// Redacted rotate-queue record, same line format as the old hook. Never throws.
async function record($: Engine, hits: Hit[]): Promise<void> {
  try {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    if (!home) return
    const path = `${home}/${LOG}`
    const cats = (await Promise.all(hits.map(async h => `${h.label}:${await fp(h.value)}`))).join(',')
    const id = await $.session.id().catch(() => '?')
    const old = (await $.fs.exists(path)) ? await $.fs.read(path) : ''
    // ponytail: read+write, not atomic; two sessions logging in the same instant can lose a line.
    await $.fs.write(path, `${old}${new Date(await $.clock.now()).toISOString()} DETECT ${cats} session=${id}\n`)
  } catch (err) {
    $.ui.log(`prompt-secret-screen: log failed: ${String(err)}`)
  }
}

// Old hook's env kill switch, still honored: ECOSYSTEM_SECRET_SCREEN=off.
const isOff = async ($: Engine) => ((await $.env.get('ECOSYSTEM_SECRET_SCREEN')) ?? 'on').toLowerCase() === 'off'

const labels = (hits: Hit[]) => [...new Set(hits.map(h => h.label))].join(', ')

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('prompt.submit', async ($, e, next) => {
    // A slash command's line takes no rewrite here; its arguments are masked at command.run below.
    if (e.command || (await isOff($))) return next(e)
    const hits = detect(e.text)
    if (!hits.length) return next(e)
    await record($, hits)

    // A hidden prompt that starts its own turn takes no rewrite: warn only, as the old hook did.
    if (e.isMeta && !e.turnId) {
      return next({
        ...e,
        context: [...(e.context ?? []), `SECRET SCREEN: this hidden prompt holds credential-shaped value(s) [${labels(hits)}] that could not be masked. Treat them as compromised and rotate. Do not echo them.`],
      })
    }

    $.ui.toast(`Masked ${hits.length} secret(s) in your prompt [${labels(hits)}]. Still rotate it if it was live.`)
    return next({
      ...e,
      text: mask(e.text, hits),
      context: [
        ...(e.context ?? []),
        `SECRET SCREEN: ${hits.length} credential-shaped value(s) [${labels(hits)}] were masked before this prompt was stored or sent. A live value was still exposed outside this session (clipboard, screen): rotate it, and do not echo it. Ask for values through a temp file or the secrets manager, never in a prompt. Logged (redacted) to ~/${LOG}.`,
      ],
    })
  }).catch(($, e, next) =>
    // Fail closed for plain prompts (a secret must not slip through a broken screen); commands still run, so /plugin can turn this off.
    next.called || e.command ? next(e) : { drop: 'prompt-secret-screen failed, so the prompt was not sent. Try again, or turn the mod off with /plugin.' },
  )

  on('command.run', async ($, e, next) => {
    if (await isOff($)) return next(e)
    const hits = detect(e.args)
    if (!hits.length) return next(e)
    await record($, hits)
    $.ui.toast(`Masked ${hits.length} secret(s) in /${e.command} arguments [${labels(hits)}].`)
    return next({ ...e, args: mask(e.args, hits) })
  }).catch(($, e, next) =>
    // Fail closed, except /plugin, so a broken screen can still be turned off.
    next.called || e.command === 'plugin' ? next(e) : { text: `prompt-secret-screen failed, so /${e.command} did not run.` },
  )
}
