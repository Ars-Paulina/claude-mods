import { expect, test } from 'claude-code/testing'

const CACHE = '/h/.claude/cache'

// Engine stand-in: a tiny disk of flag files, and the prompt that reaches the model.
function engine(on: any, files: Record<string, string>, opts: { envThrows?: boolean } = {}) {
  const seen: any[] = []
  on('env.get', () => {
    if (opts.envThrows) throw new Error('env down')
    return { value: '/h' }
  })
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: Date.parse('2026-11-24T12:00:00Z') }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in files }))
  on('fs.read', (_: any, e: any) => ({ value: files[e.path] }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', (_: any, e: any) => {
    if (e.argv[0] === 'rm') delete files[e.argv[2]]
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('prompt.submit', (_: any, e: any) => {
    seen.push(e)
    return { text: e.text, context: e.context }
  })
  return seen
}

const submit = ($: any, text = 'hi') => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('a pending verify flag reaches the model as hidden context on the next prompt', async ($, on) => {
  const files = { [`${CACHE}/verify-pending-s1.flag`]: '{"plan_path":"/p.md"}', '/p.md': '---\nstatus: draft\n---' }
  const seen = engine(on, files)
  await submit($)
  expect(seen[0].text).toBe('hi')
  expect(seen[0].context[0]).toContain('@DISPATCH:plan-perfector:Skill')
  expect(`${CACHE}/verify-pending-s1.flag` in files).toBe(false)
})

test('a throw inside the hook fails closed: no context added, the prompt still goes through as typed', async ($, on) => {
  const files = { [`${CACHE}/verify-pending-s1.flag`]: '{"plan_path":"/p.md"}', '/p.md': '---\nstatus: draft\n---' }
  const seen = engine(on, files, { envThrows: true })
  await submit($)
  expect(seen[0].text).toBe('hi')
  expect(seen[0].context).toBeUndefined()
  expect(`${CACHE}/verify-pending-s1.flag` in files).toBe(true)
})
