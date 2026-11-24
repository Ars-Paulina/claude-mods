import type { EngineInterface, Register } from 'claude-code'

import { relay, type Io } from './index'

// ponytail: Linux/macOS shell tools (rm, mkdir, >>): `$.fs` has no remove or append. Windows would need its own Io.
function ioFor($: EngineInterface, home: string, sid: string, now: number): Io {
  const run = async (argv: string[]) => {
    const r = await $.process.run(argv)
    if (r.exitCode !== 0) throw new Error(`${argv[0]} exit ${r.exitCode}`)
  }
  return {
    home, sid, now,
    exists: p => $.fs.exists(p),
    read: async p => String(await $.fs.read(p)),
    list: async d => (await $.fs.list(d)).map(e => ({ name: e.name, kind: e.kind, mtimeMs: e.mtimeMs })),
    remove: p => run(['rm', '-f', p]),
    log: line => run(['sh', '-c', 'mkdir -p "$(dirname "$2")" && printf "%s\\n" "$1" >> "$2"', 'sh', line, `${home}/.claude/logs/plan-verify.log`]),
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  // Fail closed for an injector means no injection: a thrown error lets the prompt through as typed, never blocks it.
  on('prompt.submit', async ($, e, next) => {
    const home = (await $.env.get('HOME')) ?? ''
    if (!home) return next(e)
    const io = ioFor($, home, await $.session.id(), await $.clock.now())
    const context = await relay(io, { text: e.text, kind: e.origin?.kind, isCommand: !!e.command })
    return next(context ? { ...e, context: [...(e.context ?? []), context] } : e)
  }).catch(($, e, next) => next(e))
}
