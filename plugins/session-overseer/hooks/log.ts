// Calls the store bridge (scripts/store.cjs). The mod's $.fs has no append and no file mode, so
// every disk write goes through one node child with the payload on stdin. Awaited, with a short
// timeout; the bridge stamps each row's `ms` from `t0` (handler start), so `ms` includes the spawn.

import type { EngineInterface as Engine } from 'claude-code'
import type { Row } from './observer.ts'

export const STORE_TIMEOUT_MS = 2_000

export type Paths = { home: string; stateDir: string; maskJs: string; root: string }

export async function paths($: Engine): Promise<Paths | null> {
  const home = (await $.env.get('HOME')) ?? ''
  if (!home) return null
  const stateDir = (await $.env.get('OVERSEER_STATE_DIR')) || `${home}/.claude/state/overseer`
  const maskJs = (await $.env.get('OVERSEER_MASK_JS')) || `${home}/.claude/hooks/secret-mask.js`
  return { home, stateDir, maskJs, root: $.plugin.root }
}

export type Op =
  | { op: 'log'; row: Row }
  | { op: 'approval'; rec: { message_id: string; ts: string; exact_text: string; scope: null } }
  | { op: 'state'; patch: Record<string, unknown> }
  | { op: 'prune'; days: number }

export async function store($: Engine, p: Paths, sid: string, t0: number, ops: Op[]): Promise<boolean> {
  if (!ops.length) return true
  const r = await $.process.run(['node', `${p.root}/scripts/store.cjs`], {
    stdin: JSON.stringify({ stateDir: p.stateDir, maskJs: p.maskJs, sid, t0, ops }),
    timeoutMs: STORE_TIMEOUT_MS,
  })
  return r.exitCode === 0
}
