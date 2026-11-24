import type { Register } from 'claude-code'

import { ASSET, GAIN, paplayArgv, route } from './play'

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    // Never block the question dialog: start the sound, do not await it.
    void (async () => {
      try {
        const { platform } = await $.session.info()
        if (route(platform) === 'paplay') await $.process.run(paplayArgv(`${$.plugin.root}/${ASSET}`))
        else await $.audio.play({ asset: ASSET }, { gain: GAIN })
      } catch {
        // best-effort: a missing player must never break the question
      }
    })()

    return next(e)
  })
}
