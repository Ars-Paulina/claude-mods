// FR-3 loops (threshold 3, OQ-3). Pure: no engine access.
// loop       = same command + same failure-output hash 3 times with no file edit between.
// edit burst = same file edited back to an earlier state (revert), or the same diff 3 times.

export const LOOP_THRESHOLD = 3

export type LoopState = {
  run?: { key: string; n: number }
  files: Record<string, { diffs: Record<string, number>; states: string[] }>
}

export const newLoopState = (): LoopState => ({ files: {} })

/** A finished Bash call. Returns 'loop' when the same failure reaches the threshold. */
export function onBash(s: LoopState, command: string, failed: boolean, outputHash: string): 'loop' | null {
  if (!failed) { s.run = undefined; return null }
  const key = `${command}\u0000${outputHash}`
  s.run = s.run?.key === key ? { key, n: s.run.n + 1 } : { key, n: 1 }
  return s.run.n === LOOP_THRESHOLD ? 'loop' : null
}

/**
 * A file edit. `diff` names the change (old->new for Edit, content for Write); `before`/`after`
 * name the file's state around it (for Edit: hashes of old_string/new_string). Any edit ends a
 * command loop run.
 */
export function onEdit(s: LoopState, file: string, diff: string, before: string, after: string): 'edit_burst' | null {
  s.run = undefined
  const f = (s.files[file] ??= { diffs: {}, states: [] })
  f.diffs[diff] = (f.diffs[diff] ?? 0) + 1
  const revert = before !== after && f.states.includes(after)
  f.states.push(before)
  return f.diffs[diff] === LOOP_THRESHOLD || revert ? 'edit_burst' : null
}
