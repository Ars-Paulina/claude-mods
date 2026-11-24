#!/usr/bin/env node
// Bridge to Pedro's own ~/.claude/hooks/lib files, which the mod cannot import.
// Usage: home-libs.cjs digest | autonomous <session_id> | fire <name>
// Fail-open: any problem prints nothing (digest) or 0 (autonomous) and exits 0.
const path = require('path')
const lib = f => path.join(process.env.HOME || '', '.claude', 'hooks', 'lib', f)
const [cmd, arg] = process.argv.slice(2)
try {
  if (cmd === 'digest') process.stdout.write(require(lib('core-digest.js')).CORE_DIGEST || '')
  else if (cmd === 'autonomous') process.stdout.write(require(lib('autonomy')).isAutonomous(arg) ? '1' : '0')
  else if (cmd === 'fire') require(lib('invocation-log.js')).logHookFire(arg)
} catch (_) {
  if (cmd === 'autonomous') process.stdout.write('0')
}
