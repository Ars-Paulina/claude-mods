import { expect, test, mock } from 'claude-code/testing'

const PLAN = '---\nsession_uuid: sess-1\n---\n## Goals\n- [ ] ship it\n  - [ ] write test\n'

function engine(on: any, opts: { throwList?: boolean; goalsOff?: boolean } = {}) {
  on('session.id', () => ({ value: 'sess-1' }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/h' : e.name === 'GOALS_MODE' && opts.goalsOff ? 'OFF' : undefined }))
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

async function submitted($: any, on: any, input: any) {
  const seen: any[] = []
  on('prompt.submit', ($: any, e: any) => {
    seen.push(e)

    return e
  })
  await $.prompt.submit({ wait: false, ...input } as never)

  return seen[0]
}

test('slash command gets no reminder', async ($, on) => {
  engine(on)
  const e = await submitted($, on, { text: '/review x', command: { name: 'review', args: 'x' } })
  expect(e.text).toBe('/review x')
  expect(e.context ?? []).toEqual([])
})

test('GOALS_MODE=off: no reminder on a prompt', async ($, on) => {
  engine(on, { goalsOff: true })
  const e = await submitted($, on, { text: 'hello' })
  expect(e.context ?? []).toEqual([])
})

function compaction(on: any) {
  const ms = mock.session(on)
  on('session.compact', (_$: any, e: any) => ({ messages: e.messages }))

  return ms
}

test('session.compact queues the reminder as a user row for the next request', async ($, on) => {
  engine(on)
  const ms = compaction(on)
  const res: any = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(Array.isArray(res.messages)).toBe(true)
  const rows = ms.appended()
  expect(rows.length).toBe(1)
  expect(rows[0]!.message.type).toBe('user')
  expect((rows[0]!.message.content[0] as any).text).toContain('Current goal: ship it')
})

test('session.compact: reminder failure fails open, compaction result stands', async ($, on) => {
  engine(on, { throwList: true })
  const ms = compaction(on)
  const res: any = await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(Array.isArray(res.messages)).toBe(true)
  expect(ms.appended()).toEqual([])
})

test('session.compact: GOALS_MODE=off queues nothing', async ($, on) => {
  engine(on, { goalsOff: true })
  const ms = compaction(on)
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hi', toolUses: [] }] } as never)
  expect(ms.appended()).toEqual([])
})
