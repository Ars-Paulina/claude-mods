import { expect, test } from 'claude-code/testing'

const Q = { question: 'Pick?', header: 'Pick', options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }], multiSelect: false }

// The old hook ran paplay on every AskUserQuestion; the mod must still ask for a sound, and never block the question.
test('AskUserQuestion triggers a sound request and the call goes on', async ($, on) => {
  const played: string[] = []
  on('session.info', () => ({ value: { platform: 'linux' } }) as never)
  on('process.run', ($, e) => {
    played.push(e.argv[0] ?? '')
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('tool.call', () => ({ result: 'ok' }) as never)
  on('audio.play', () => {
    played.push('audio')
    return { value: undefined } as never
  })
  const out = await $.tool.call({ tool: 'AskUserQuestion', questions: [Q] })
  for (let i = 0; i < 50; i++) await Promise.resolve() // let the unawaited sound call settle
  expect(out.deny).toBeUndefined()
  expect(played.length).toBe(1)
})
