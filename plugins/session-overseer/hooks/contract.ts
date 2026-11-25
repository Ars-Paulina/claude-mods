// FR-1 contract: task type (frozen at the session's first prompt, Q8) and the freshness rule.
// Pure: no engine access.

export type TaskType = 'code' | 'docs' | 'read-only' | 'non-repo'
/** Repo facts read once, at the first prompt. */
export type Contract = { ts: string; inGit: boolean; hasChecks: boolean }

export type Run = { seq: number; command: string; ok: boolean }
export type Edit = { seq: number; file: string }

/** Task type at claim time: the frozen repo facts plus whether this session edited anything since. */
export function taskType(c: Contract, edits: Edit[]): TaskType {
  if (!c.inGit) return 'non-repo'
  if (!edits.length) return 'read-only'
  return c.hasChecks ? 'code' : 'docs'
}

/** Does this repo have a test/lint/build script? Inputs are file texts, null when absent. */
export function hasChecks(files: { packageJson: string | null; makefile: string | null; pyproject: string | null; other: boolean }): boolean {
  if (files.other) return true
  if (files.packageJson) {
    try {
      const scripts = JSON.parse(files.packageJson).scripts ?? {}
      if (Object.keys(scripts).some(k => /^(test|lint|build|check|typecheck)(:|$)/.test(k))) return true
    } catch { /* unparsable package.json: no scripts */ }
  }
  if (files.makefile && /^(test|check|lint|build)\s*:/m.test(files.makefile)) return true
  if (files.pyproject && /\[tool\.(pytest|ruff|mypy)/.test(files.pyproject)) return true
  return false
}

const CHECK_CMD = new RegExp([
  String.raw`\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|lint|build|check|typecheck)\b`,
  String.raw`\bpnpm\s+(exec|dlx)\s+(vitest|jest|tsc|eslint|playwright)\b`,
  String.raw`\b(vitest|jest|pytest|tsc|eslint|ruff|mypy)\b`,
  String.raw`\bpython3?\s+-m\s+(pytest|unittest)\b`,
  String.raw`\bmake\s+(test|check|lint|build)\b`,
  String.raw`\bcargo\s+(test|build|clippy|check)\b`,
  String.raw`\bgo\s+(test|build|vet)\b`,
  String.raw`\bnode\s+--test\b`,
  String.raw`\bclaude\s+plugin\s+(test|validate)\b`,
].join('|'))

export const isCheckCommand = (command: string) => CHECK_CMD.test(command)

/**
 * Freshness: a recognized check command exited 0 after the last edit to the claimed files (all
 * edited files when the claim names none), in any turn since the contract.
 */
export function isFresh(runs: Run[], edits: Edit[], claimedFiles: string[]): boolean {
  const named = claimedFiles.length ? edits.filter(e => claimedFiles.some(f => e.file === f || e.file.endsWith('/' + f))) : edits
  const lastEdit = Math.max(-1, ...(named.length ? named : edits).map(e => e.seq))
  return runs.some(r => r.ok && r.seq > lastEdit && isCheckCommand(r.command))
}
