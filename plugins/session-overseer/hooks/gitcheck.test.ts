import { expect, test } from 'claude-code/testing'

import { gitCheck } from './gitcheck.ts'

// The test runner has timers; the mod's type set (types: []) does not declare them.
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

// A real temp git repo is used in scripts/scripts.test.cjs (the mod test kit runs no processes).
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function fakeGit(changed: string[], commits: string[]) {
  return async (argv: string[]) => {
    if (argv[1] === 'status') return { exitCode: 0, stdout: changed.map(f => ` M ${f}`).join('\n') }
    if (argv[1] === 'log') return { exitCode: 0, stdout: '' }
    if (argv[1] === 'cat-file') return { exitCode: commits.includes(argv[3]!.replace('^{commit}', '')) ? 0 : 1, stdout: '' }
    return { exitCode: 1, stdout: '' }
  }
}

test('present -> match, absent -> missing, authorship from own edits', async () => {
  const run = fakeGit(['src/a.ts', 'src/b.ts'], ['abc1234'])
  const ok = await gitCheck(run, sleep, '/r', { files: ['a.ts'], shas: ['abc1234'] }, '2026-11-24', ['/r/src/a.ts'])
  expect(ok.status).toBe('match')
  expect(ok.unauthored).toEqual([])
  const bad = await gitCheck(run, sleep, '/r', { files: ['c.ts', 'b.ts'], shas: ['def5678'] }, '2026-11-24', [])
  expect(bad.status).toBe('missing')
  expect(bad.files).toEqual({ 'c.ts': 'missing', 'b.ts': 'match' })
  expect(bad.unauthored).toEqual(['b.ts'])
})

test('slow git -> unknown in under 300 ms; git error -> unknown', async () => {
  const t0 = Date.now()
  const slow = await gitCheck(() => new Promise(() => {}), sleep, '/r', { files: ['a.ts'], shas: [] }, 'x', [])
  expect(slow.status).toBe('unknown')
  expect(Date.now() - t0).toBeLessThan(300)
  const err = await gitCheck(async () => ({ exitCode: 128, stdout: '' }), sleep, '/r', { files: ['a.ts'], shas: [] }, 'x', [])
  expect(err.status).toBe('unknown')
})
