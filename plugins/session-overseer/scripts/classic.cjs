#!/usr/bin/env node
'use strict'
// Classic command hooks (hooks.json "hooks"), for the two inputs mod hooks cannot get:
//   classic.cjs compact  <- SessionStart matcher "compact": count one compaction (deduped within
//                           5 s per session) in the state file + one `compaction` log row.
//   classic.cjs tool     <- PostToolUse: append one byte to raw/<sid>.count, the second count of
//                           main-loop tool calls that blind detection (FR-19) compares against.
// Prints nothing and always exits 0: a classic hook's output would reach the session.
// Same bails as the mod: OVERSEER_CHECKER=1, the OFF file, subagent input (agent_id). And a session
// the mod never armed (state `armed`, written at its session.start / prompt.submit): with the
// plugin option `enabled: false` the mod registers nothing, so these hooks write nothing either.

const fs = require('node:fs')
const path = require('node:path')
const { run } = require('./store.cjs')

const DEDUPE_MS = 5_000

function stateDir(env) {
  return env.OVERSEER_STATE_DIR || (env.HOME ? path.join(env.HOME, '.claude', 'state', 'overseer') : null)
}

function handle(kind, input, env = process.env, now = Date.now()) {
  if (env.OVERSEER_CHECKER === '1') return 'bail'
  const dir = stateDir(env)
  if (!dir || !path.isAbsolute(dir)) return 'bail'
  if (fs.existsSync(path.join(dir, 'OFF'))) return 'bail'
  if (input.agent_id) return 'bail'
  const sid = input.session_id
  if (typeof sid !== 'string' || !/^[\w-]{1,128}$/.test(sid)) return 'bail'
  let state = {}
  try { state = JSON.parse(fs.readFileSync(path.join(dir, `${sid}.json`), 'utf8')) } catch { /* none yet */ }
  if (state.armed !== true) return 'bail'

  if (kind === 'tool') {
    const raw = path.join(dir, 'raw')
    fs.mkdirSync(raw, { recursive: true, mode: 0o700 })
    fs.chmodSync(raw, 0o700)
    fs.appendFileSync(path.join(raw, `${sid}.count`), '.', { mode: 0o600 })
    return 'counted'
  }
  if (kind === 'compact') {
    if (input.source !== undefined && input.source !== 'compact') return 'bail'
    if (env.OVERSEER_COMPACTION === '0') return 'bail'
    if (typeof state.last_compact_ms === 'number' && Math.abs(now - state.last_compact_ms) < DEDUPE_MS) return 'dedupe'
    const count = (Number(state.compactions) || 0) + 1
    run({
      stateDir: dir,
      sid,
      t0: now,
      ops: [
        { op: 'state', patch: { compactions: count, last_compact_ms: now } },
        { op: 'log', row: { event: 'classic.SessionStart', signal: 'compaction', would: 'warn', detail: { count } } },
      ],
    }, now)
    return 'compaction'
  }
  return 'bail'
}

module.exports = { handle, DEDUPE_MS }

if (require.main === module) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => { input += c })
  process.stdin.on('end', () => {
    try { handle(process.argv[2], JSON.parse(input || '{}')) } catch { /* fail open, silent */ }
    process.exitCode = 0
  })
}
