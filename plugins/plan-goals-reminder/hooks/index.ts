// Pure helpers: pick this session's plan, build the ~5-line reminder. No engine calls here.

export type PlanHead = { name: string; head: string; mtimeMs: number }

// The newest plan whose frontmatter session_uuid is `uuid`. Skips verification and agent plans.
export function pickPlan(files: readonly PlanHead[], uuid: string): string | null {
  let best: PlanHead | null = null
  for (const f of files) {
    if (!f.name.endsWith('.md') || f.name.includes('.verification.') || f.name.includes('-agent-')) continue
    if (!f.head.startsWith('---')) continue
    const m = f.head.match(/^session_uuid:\s*(\S+)/m)
    if (!m || m[1] !== uuid) continue
    if (!best || f.mtimeMs > best.mtimeMs) best = f
  }
  return best && best.name
}

function section(text: string, title: string): string | null {
  const m = text.match(new RegExp('^##[ \\t]+' + title + '\\b.*$', 'im'))
  if (!m || m.index === undefined) return null
  const rest = text.slice(m.index + m[0].length)
  const next = rest.search(/^##[ \t]/m)
  return next === -1 ? rest : rest.slice(0, next)
}

// The reminder text, or null when the plan has no Goals section or no checkboxes.
export function summarize(text: string, planName: string): string | null {
  const goals = section(text, 'Goals')
  if (goals === null) return null
  let goal: string | null = null
  let nextTask: string | null = null
  let done = 0
  let total = 0
  for (const line of goals.split('\n')) {
    const m = line.match(/^(\s*)- \[([ xX])\]\s+(.*)$/)
    if (!m) continue
    total++
    if (m[2] !== ' ') {
      done++
      continue
    }
    const indent = (m[1] ?? '').length
    if (!indent && !goal) goal = m[3] ?? ''
    if (indent && !nextTask) {
      nextTask = m[3] ?? ''
      if (!goal) goal = '(see plan)'
    }
  }
  if (!total) return null
  const parked = ((section(text, 'Parked') || '').match(/^[ \t]*[-*][ \t]+(?!\(empty)\S/gm) || []).length

  return (
    `[PLAN TRACKER] ${planName} — ${done}/${total} checked\n` +
    `Current goal: ${goal || 'all goals checked'}\n` +
    `Next task: ${nextTask || 'none — verify each \`done when:\`, then report'}\n` +
    `Parked: ${parked}. Off-plan idea -> append to ## Parked, stay on the task. ` +
    'Tick [x] only after its `done when:` ran; paste the evidence.'
  )
}
