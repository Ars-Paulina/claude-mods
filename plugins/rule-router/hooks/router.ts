import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

// The matching, dedup, budget and audit log all live in the bundled
// scripts/rule-router.py, unchanged from the settings hook it replaces. This module
// only moves the prompt-side trigger onto prompt.submit, so the rules ride as hidden
// context (e.context) instead of a UserPromptSubmit hook's additionalContext.

// python3, then python. Probed once per module load; the next prompt probes again on failure.
let python: string[] | null = null
async function findPython($: EngineInterface): Promise<string[]> {
  if (python) return python
  for (const argv of [['python3'], ['python']]) {
    try {
      const run = await $.process.run([...argv, '-c', 'import fcntl'])
      if (run.exitCode === 0) return (python = argv)
    } catch {
      // not installed under this name: try the next
    }
  }
  throw new Error('python3 with fcntl not found')
}

// Background-task results are harness text, not the person's words: they fired
// rules nobody asked about (2026-11-18). The settings hook had to strip them from
// the prompt with a regex; here the engine says where a prompt came from.
export function shouldScan(e: Pick<PromptSubmitInput, 'text' | 'origin' | 'isMeta'>): boolean {
  return e.text.trim() !== '' && !e.isMeta && e.origin?.kind !== 'task-notification'
}

// The router's additionalContext for this prompt, or null when nothing new matched.
export async function rulesFor($: EngineInterface, text: string): Promise<string | null> {
  const argv = [...(await findPython($)), `${$.plugin.root}/scripts/rule-router.py`]
  const run = await $.process.run(argv, {
    stdin: JSON.stringify({ prompt: text, session_id: await $.session.id() }),
    timeoutMs: 5000,
  })
  const out = run.stdout.trim()
  if (!out) return null
  const context = JSON.parse(out)?.hookSpecificOutput?.additionalContext
  return typeof context === 'string' && context !== '' ? context : null
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    if (!shouldScan(e)) return next(e)
    const rules = await rulesFor($, e.text)
    return next(rules ? { ...e, context: [...(e.context ?? []), rules] } : e)
    // Fail open, as the settings hook did: a broken router never holds up a prompt.
  }).catch(($, e, next) => next(e))
}
