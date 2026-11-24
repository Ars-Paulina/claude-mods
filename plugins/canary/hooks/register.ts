import type { Register } from 'claude-code'

import { alertText, directive, limits, REASONS, score, TTL_MS, type State } from './canary'

// Canary heartbeat as a mod: the directive rides in the system prompt (prompt.compose) instead of a
// SessionStart context block, and each reply is scored at turn end from the answer itself instead of
// re-reading the transcript file on the next prompt.

let id = ''
let state: State | null = null
let pendingAlert = '' // shown to the model on the next request, then cleared

function rand(n: number): number {
  const a = new Uint32Array(1)
  crypto.getRandomValues(a)

  return (a[0] ?? 0) % n
}

function fresh(now: number): State {
  const token = rand(0x10000).toString(16).toUpperCase().padStart(4, '0') // e.g. "9F3A"

  return { token, payload: 100 + rand(900), window: [], misses: 0, alerted: false, plantedAt: now, touchedAt: now }
}

async function save($: any) {
  if (!id || !state) return
  state.touchedAt = await $.clock.now()
  await $.store.set(`canary:${id}`, state)
}

// Drops other sessions' state untouched for 14 days so the store stays small.
async function prune($: any) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('canary:') || key === `canary:${id}`) continue
    const old = (await $.store.get(key)) as State | undefined
    if (!old || now - Number(old.touchedAt ?? 0) > TTL_MS) await $.store.delete(key)
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  const lim = limits(options)

  // Plant: same session id (resume, compact, clear) reuses the stored pair, so the token never rotates.
  on('session.start', async ($, e, next) => {
    try {
      id = await $.session.id()
      const now = await $.clock.now()
      const saved = (await $.store.get(`canary:${id}`)) as State | undefined
      state = saved && saved.token ? { ...saved } : fresh(now)
      await save($)
      $.ui.log(`canary: ${saved ? 'reused' : 'planted'} ⟦${state.token}:${state.payload}⟧`)
      await prune($)
    } catch (err) {
      $.ui.log(`canary: start failed: ${String(err)}`) // fail open: never break session start
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!state || e.traits?.includes('teammate')) return r // main loop only, like the SessionStart hook

    const sections = [...r.sections, { id: 'canary:directive', text: directive(state), scope: 'session' as const }]
    if (pendingAlert) {
      sections.push({ id: 'canary:alert', text: pendingAlert, scope: 'session' as const })
      pendingAlert = ''
    }

    return { ...r, sections }
  }).catch(($, e, next) => next(e))

  // Check: score the reply the turn just produced.
  on('turn.complete', async ($, e, next) => {
    const answer = 'answer' in e ? String(e.answer ?? '') : ''
    // Main loop only (subagent turns carry agentId). Interrupted, refused or failed turns never got to
    // their footer, so they carry no opinion.
    const isScored = e.agentId === undefined && e.reason === 'answer'
    if (state && answer.trim() && isScored) {
      const r = score(state, answer, lim)
      state = r.state
      if (r.result !== 'SKIP') {
        await save($).catch(() => {})
        const healthy = r.result === 'HEALTHY' || r.result === 'STALE-HEALTHY'
        if (!healthy) $.ui.log(`canary: miss (${r.result}) window=${state.misses}/${state.window.length}`)
        if (r.alertNow) {
          const reason = REASONS[r.result] ?? 'dropped'
          pendingAlert = alertText(state, reason)
          $.ui.toast(`Canary: heartbeat ${reason} in ${state.misses}/${state.window.length} replies. Consider /progress-report.`)
          $.ui.log(`canary: ALERT (${reason}) ${state.misses}/${state.window.length}`)
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))
}
