import type { Register } from 'claude-code'

import { rewrite } from './index'

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = rewrite(e.command, await $.session.cwd())
    if (command === undefined) return next(e)
    $.ui.toast('npm → pnpm')

    return next({ ...e, command })
  })
}
