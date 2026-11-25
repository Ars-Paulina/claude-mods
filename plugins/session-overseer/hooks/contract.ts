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

// A check command at command position only: each segment of the command line (split on ; && || |
// & newline and subshell parens) after leading VAR=value, env, time and timeout words. A tool name
// anywhere else (`cat vitest.config.ts`, `git log -- jest.config.js`) is not a check run.
const CHECK_HEAD = new RegExp('^(?:' + [
  String.raw`(pnpm|npm|yarn|bun)\s+(run\s+)?(test|lint|build|check|typecheck)\b`,
  String.raw`(pnpm\s+(exec|dlx)|npx|bunx)\s+(vitest|jest|tsc|eslint|playwright)\b`,
  String.raw`(\S*/)?(vitest|jest|pytest|tsc|eslint|ruff|mypy)(\s|$)`,
  String.raw`python3?\s+-m\s+(pytest|unittest|mypy)\b`,
  String.raw`make\s+(test|check|lint|build)\b`,
  String.raw`cargo\s+(test|build|clippy|check)\b`,
  String.raw`go\s+(test|build|vet)\b`,
  String.raw`node\s+--test\b`,
  String.raw`claude\s+plugin\s+(test|validate)\b`,
].join('|') + ')')
const LEAD = /^(?:(?:[A-Za-z_]\w*=\S*|env|time|timeout\s+\S+)\s+)*/

export const isCheckCommand = (command: string) =>
  command.split(/&&|\|\||[;|&\n()]/).some(seg => CHECK_HEAD.test(seg.trim().replace(LEAD, '')))

/**
 * Freshness: a recognized check command exited 0 after the last edit to the claimed files (all
 * edited files when the claim names none), in any turn since the contract.
 */
export function isFresh(runs: Run[], edits: Edit[], claimedFiles: string[]): boolean {
  const named = claimedFiles.length ? edits.filter(e => claimedFiles.some(f => e.file === f || e.file.endsWith('/' + f))) : edits
  const lastEdit = Math.max(-1, ...(named.length ? named : edits).map(e => e.seq))
  return runs.some(r => r.ok && r.seq > lastEdit && isCheckCommand(r.command))
}
