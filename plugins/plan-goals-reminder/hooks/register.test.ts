import { expect, test, mock } from 'claude-code/testing'

const PLAN = '---\nsession_uuid: sess-1\n---\n## Goals\n- [ ] ship it\n  - [ ] write test\n'

function engine(on: any, opts: { throwList?: boolean } = {}) {
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('fs.list', () => {
    if (opts.throwList) throw new Error('boom')

    return { value: [{ name: 'a.md', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] }
  })
  on('fs.read', () => ({ value: PLAN }))
  on('ui.log', () => ({ value: undefined }))
}

test('prompt.submit adds the reminder as context, text untouched', async ($, on) => {
  engine(on)
  const seen: any[] = []
  on('prompt.submit', ($: any, e: any) => {
    seen.push(e)

    return e
  })
  await $.prompt.submit({ text: 'hello', wait: false } as never)
  expect(seen[0].text).toBe('hello')
  expect(seen[0].context[0]).toContain('Current goal: ship it')
})

test('throw path fails open: prompt still goes through, no context', async ($, on) => {
  engine(on, { throwList: true })
  const seen: any[] = []
  on('prompt.submit', ($: any, e: any) => {
    seen.push(e)

    return e
  })
  await $.prompt.submit({ text: 'hello', wait: false } as never)
  expect(seen[0].text).toBe('hello')
  expect(seen[0].context ?? []).toEqual([])
})
