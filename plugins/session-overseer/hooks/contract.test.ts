import { expect, test } from 'claude-code/testing'

import { hasChecks, isFresh, taskType } from './contract.ts'
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
