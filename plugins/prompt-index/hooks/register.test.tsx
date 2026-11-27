import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'prompt-index',
  component: 'Pane',
  requestId: 'prompt-index',
  surface: 'terminal',
  props: { title: 'Prompts', isFocused: true, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

const user = (text: string) => ({ type: 'user', role: 'user', content: [{ type: 'text', text }] }) as any

function engine(on: any, opts: { rows?: unknown[]; registered?: string[]; toasts?: string[] } = {}) {
  on('command.register', (_: any, e: any) => {
    opts.registered?.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.messages', () => ({ value: opts.rows ?? [] }))
  on('ui.toast', (_: any, e: any) => {
    opts.toasts?.push(e.text)
    return { value: undefined }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
}

const start = ($: any) => $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
const send = ($: any, uuid: string, text: string, door = 'prompt', kind = 'composer') =>
  $.session.append({ message: user(text), door, origin: { kind }, uuid })
const buttons = async (ui: any) => (await ui.findAll({ type: 'Button' })).map((b: any) => b.props?.label ?? b.text)

test('a typed prompt shows as row 1', async ($, on) => {
  engine(on)
  await start($)
  await send($, 'u1', 'pane')
  const ui = await $.ui.mount(PANE as any)
  expect(await buttons(ui)).toEqual(['1  pane'])
  await ui.unmount()
})

test('backfill comes first, a live prompt sent before backfill still sorts last, a second start keeps the list', async ($, on) => {
  const rows = [
    { role: 'user', text: 'old one', uuid: 'b1', toolUses: [] },
    { role: 'user', text: '<task-notification>x</task-notification>', uuid: 'n1', toolUses: [] },
    { role: 'assistant', text: 'reply', uuid: 'a1', toolUses: [] },
    { role: 'user', text: 'old two', uuid: 'b2', toolUses: [] },
  ]
  engine(on, { rows })
  await send($, 'u1', 'new')
  await start($)
  await send($, 'b2', 'old two')
  const ui = await $.ui.mount(PANE as any)
  expect(await buttons(ui)).toEqual(['1  old one', '2  old two', '3  new'])
  await ui.unmount()
  await start($)
  const ui2 = await $.ui.mount(PANE as any)
  expect(await buttons(ui2)).toEqual(['1  old one', '2  old two', '3  new'])
  await ui2.unmount()
})

test('queue door: engine text and task notifications add no row', async ($, on) => {
  engine(on)
  await start($)
  await send($, 'q1', '<task-notification>done</task-notification>', 'queue', 'engine')
  await send($, 't1', 'note', 'prompt', 'task-notification')
  const ui = await $.ui.mount(PANE as any)
  expect(await buttons(ui)).toEqual([])
  await ui.unmount()
})

test('a prompt typed while busy is listed once; if it comes back as a normal row it keeps its slot', async ($, on) => {
  engine(on)
  await start($)
  await send($, 'u1', 'first')
  await send($, 'q1', 'folded', 'queue', 'engine')
  await send($, 'q2', 'folded', 'queue', 'engine') // remove record, same text
  await send($, 'q3', 'later', 'queue', 'engine')
  await send($, 'q4', 'later', 'queue', 'engine')
  await send($, 'u2', 'later') // the dequeued one becomes a normal turn
  const ui = await $.ui.mount(PANE as any)
  expect(await buttons(ui)).toEqual(['1  first', '2  folded', '3  later'])
  await ui.unmount()
})

test('a full 4096-row read shows the older-prompts line', async ($, on) => {
  const rows = Array.from({ length: 4096 }, (_, i) => ({ role: 'assistant', text: 'x', uuid: `r${i}`, toolUses: [] }))
  engine(on, { rows })
  await start($)
  const ui = await $.ui.mount(PANE as any)
  expect((await ui.find({ type: 'Text', text: /Older prompts/ }))?.text).toBe('Older prompts may not be reachable')
  await ui.unmount()
})

// The kit has no hook for a transcript-row $.ui.scroll, so the call fails here; that still proves
// press -> scroll -> failure -> toast. The real { deny } branch is checked live.
test('a failed jump shows a toast with the reason', async ($, on) => {
  const toasts: string[] = []
  engine(on, { toasts })
  await start($)
  await send($, 'u1', 'pane')
  const ui = await $.ui.mount(PANE as any)
  await ui.press({ key: 'u1' })
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/^Can't jump: .+/)
  await ui.unmount()
})

test('kill switch: enabled false registers nothing and lists nothing', { options: { enabled: false } }, async ($, on) => {
  const registered: string[] = []
  engine(on, { registered })
  await start($)
  await send($, 'u1', 'pane')
  expect(registered).toEqual([])
  const ui = await $.ui.mount(PANE as any)
  expect(await buttons(ui)).toEqual([])
  await ui.unmount()
})
