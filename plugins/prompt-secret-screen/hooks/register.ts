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

// Longer text is refused, not scanned: scan time must stay far inside the hook budget, because a
// screen that overruns it with no time left for .catch would let the prompt through unscreened.
// About 250k tokens, past any context window, so no real prompt is lost.
export const MAX_SCAN = 1_000_000
const TOO_LONG = `prompt-secret-screen: this text is over ${MAX_SCAN} characters, too long to screen for secrets, so it was not sent. Split it, or turn the mod off with /plugin.`

// What the .catch handlers do when a hook throws or outruns its budget (next.error.kind 'throw'
// or 'timeout'): where next was already called, replay its settled (masked) answer; else refuse.
// Fail closed, except a slash command line on prompt.submit (no rewrite happens there) and
// /plugin itself, so a broken screen can still be turned off.
type Caught = { called: boolean; error?: { kind: string } }
export function onPromptFail<E extends { command?: unknown }, R>(e: E, next: ((e: E) => R) & Caught): R | { drop: string } {
  return next.called || e.command ? next(e) : { drop: `prompt-secret-screen failed (${next.error?.kind ?? 'error'}), so the prompt was not sent. Try again, or turn the mod off with /plugin.` }
}
export function onCommandFail<E extends { command: string }, R>(e: E, next: ((e: E) => R) & Caught): R | { text: string } {
  return next.called || e.command === 'plugin' ? next(e) : { text: `prompt-secret-screen failed (${next.error?.kind ?? 'error'}), so /${e.command} did not run.` }
}

const labels = (hits: Hit[]) => [...new Set(hits.map(h => h.label))].join(', ')

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('prompt.submit', async ($, e, next) => {
    // A slash command's line takes no rewrite here; its arguments are masked at command.run below.
    if (e.command || (await isOff($))) return next(e)
    if (e.text.length > MAX_SCAN) return { drop: TOO_LONG }
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
  }).catch(($, e, next) => onPromptFail(e, next))

  on('command.run', async ($, e, next) => {
    if (await isOff($)) return next(e)
    if (e.args.length > MAX_SCAN && e.command !== 'plugin') return { text: TOO_LONG }
    const hits = detect(e.args)
    if (!hits.length) return next(e)
    await record($, hits)
    $.ui.toast(`Masked ${hits.length} secret(s) in /${e.command} arguments [${labels(hits)}].`)
    return next({ ...e, args: mask(e.args, hits) })
  }).catch(($, e, next) => onCommandFail(e, next))
}
