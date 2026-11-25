import { expect, test } from 'claude-code/testing'

import { claimsCheckResult, hasChecks, isCheckCommand, isFresh, taskType } from './contract.ts'
import { makeDetector } from './claims.ts'
import { compilePins } from './pins.ts'
import { Observer } from './observer.ts'

const c = { ts: '2026-11-24T00:00:00.000Z', inGit: true, hasChecks: true }

test('[GREEN-3] edit in turn 2, test exit 0 in turn 3, claim in turn 4 -> fresh, no signal', async () => {
  const o = new Observer({ detector: makeDetector({ phrases: ['tests pass', 'done'], negators: [] }), pins: compilePins([]), git: async () => ({ exitCode: 0, stdout: '' }), sleep: () => new Promise(() => {}) })
  o.contract = c
  const x = { cwd: '/r', ccVersion: '2.1.331', tested: '2.1' }
  await o.turn('Looking.', x)
  o.tool('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, { isError: false, output: '' })
  await o.turn('Edited.', x)
  o.tool('Bash', { command: 'pnpm test' }, { isError: false, output: '12 passed' })
  await o.turn('Ran them.', x)
  const rows = await o.turn('Done, tests pass.', x)
  expect(rows.find(r => r.signal === 'claim')!.would).toBe('none')
  expect(rows.filter(r => r.would !== 'none')).toEqual([])
})

test('freshness: a run before the last edit, a failing run or a non-check command is not fresh', () => {
  expect(isFresh([{ seq: 1, command: 'pnpm test', ok: true }], [{ seq: 2, file: '/r/a.ts' }], [])).toBe(false)
  expect(isFresh([{ seq: 3, command: 'pnpm test', ok: false }], [{ seq: 2, file: '/r/a.ts' }], [])).toBe(false)
  expect(isFresh([{ seq: 3, command: 'ls', ok: true }], [{ seq: 2, file: '/r/a.ts' }], [])).toBe(false)
  // The claimed file's last edit is what counts.
  expect(isFresh([{ seq: 2, command: 'pytest -q', ok: true }], [{ seq: 1, file: '/r/a.py' }, { seq: 3, file: '/r/b.py' }], ['a.py'])).toBe(true)
})

test('task type: non-repo, read-only, code, docs', () => {
  expect(taskType({ ...c, inGit: false }, [{ seq: 1, file: 'x' }])).toBe('non-repo')
  expect(taskType(c, [])).toBe('read-only')
  expect(taskType(c, [{ seq: 1, file: 'x' }])).toBe('code')
  expect(taskType({ ...c, hasChecks: false }, [{ seq: 1, file: 'x' }])).toBe('docs')
})

test('hasChecks: package.json scripts, Makefile target, pyproject tool, other marker', () => {
  const none = { packageJson: null, makefile: null, pyproject: null, other: false }
  expect(hasChecks(none)).toBe(false)
  expect(hasChecks({ ...none, packageJson: '{"scripts":{"test:unit":"vitest"}}' })).toBe(true)
  expect(hasChecks({ ...none, packageJson: '{"scripts":{"dev":"vite"}}' })).toBe(false)
  expect(hasChecks({ ...none, packageJson: 'not json' })).toBe(false)
  expect(hasChecks({ ...none, makefile: 'build:\n\tgo build' })).toBe(true)
  expect(hasChecks({ ...none, pyproject: '[tool.pytest.ini_options]' })).toBe(true)
  expect(hasChecks({ ...none, other: true })).toBe(true)
})

test('check command at command position only: a tool name as an argument is not a test run', () => {
  for (const cmd of ['pnpm test', 'cd x && pnpm test 2>&1 | tail -3', 'CI=1 npx vitest run', './node_modules/.bin/tsc --noEmit -p .', 'timeout 60 pytest -q', 'python -m pytest', '(cd a; make test)']) expect(isCheckCommand(cmd)).toBe(true)
  for (const cmd of ['cat vitest.config.ts', 'ls tests/pytest', 'git log -- jest.config.js', 'grep -r eslint .', 'echo pnpm test', 'vim tsconfig.json']) expect(isCheckCommand(cmd)).toBe(false)
  // So reading a test config after an edit does not make a "tests pass" claim fresh.
  expect(isFresh([{ seq: 3, command: 'cat vitest.config.ts', ok: true }], [{ seq: 2, file: '/r/a.ts' }], [])).toBe(false)
})

test('no edits, repo with checks: "all tests pass" with no check run -> would block; with a passing run or a plain "done" -> none', async () => {
  const mk = () => {
    const o = new Observer({ detector: makeDetector({ phrases: ['all tests pass', 'done'], negators: [] }), pins: compilePins([]), git: async () => ({ exitCode: 0, stdout: '' }), sleep: () => new Promise(() => {}) })
    o.contract = c
    return o
  }
  const x = { cwd: '/r', ccVersion: '2.1.331', tested: '2.1' }
  let o = mk()
  o.tool('Bash', { command: 'date' }, { isError: false, output: '' })
  let claim = (await o.turn('All tests pass, done.', x)).find(r => r.signal === 'claim')!
  expect(claim.would).toBe('block')
  expect(claim.detail.task_type).toBe('read-only')
  expect(claim.detail.missing).toEqual(['test run'])
  o = mk()
  o.tool('Bash', { command: 'pnpm test' }, { isError: false, output: '3 passed' })
  expect((await o.turn('All tests pass, done.', x)).find(r => r.signal === 'claim')!.would).toBe('none')
  o = mk()
  o.tool('Bash', { command: 'date' }, { isError: false, output: '' })
  expect((await o.turn('Done.', x)).find(r => r.signal === 'claim')!.would).toBe('none')
  // A repo without checks keeps the old read-only rule.
  o = mk()
  o.contract = { ...c, hasChecks: false }
  o.tool('Bash', { command: 'date' }, { isError: false, output: '' })
  expect((await o.turn('All tests pass, done.', x)).find(r => r.signal === 'claim')!.would).toBe('none')
})

test('claimsCheckResult: check-result phrases only', () => {
  expect(claimsCheckResult(['all tests pass'])).toBe(true)
  expect(claimsCheckResult(['build passes'])).toBe(true)
  expect(claimsCheckResult(['all green'])).toBe(true)
  expect(claimsCheckResult(['done', 'fixed', 'committed'])).toBe(false)
})
