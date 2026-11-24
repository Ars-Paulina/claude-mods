import { test, expect, mock } from 'claude-code/testing'

const ID = 'sess-1'

// The engine beneath the plugin: a store in memory, a session id, tool registration, an empty band.
function engine(on: any, store: Record<string, unknown> = {}, registered: string[] = []) {
  mock.store(on, store)
  mock.clock(on)
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: ID }))
  on('tool.register', ($: any, e: any) => {
    registered.push(e.name)

    return { value: { tool: `mcp__session-board__${e.name}` } }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
}

const start = ($: any) => $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)

test('set fills the card: light, topic, checklist, next', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({
    tool: 'mcp__session-board__set',
    goal: 'Keep track of each session',
    topic: 'Build card',
    stage: 'building',
    pending: ['polish', 'trim'],
    next: 'look at it',
  } as never)

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const shown = await texts(ui)
  expect(shown[0]).toContain('🟡 Your turn · building')
  expect(shown).toContain('🎯 Goal: Keep track of each session')
  expect(shown).toContain('🔧 Now: Build card')
  expect(shown).toContain('☐ polish')
  expect(shown).toContain('👉 Next: look at it')
})

test('new session shows one calm line', async ($, on) => {
  engine(on)
  await start($)

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await texts(ui)).toEqual(['New session · Claude will fill this in'])
})

test('resume brings the saved card back', async ($, on) => {
  const saved = {
    state: 'your-turn', goal: '', firstPrompt: '', topic: 'Old work', stage: '', pending: ['finish'], next: '',
    lastPrompt: '', since: 0, updatedAt: 0,
  }
  engine(on, { [`note:${ID}`]: saved })
  await start($)

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const shown = await texts(ui)
  expect(shown).toContain('🔧 Now: Old work')
  expect(shown).toContain('👉 Next: finish')
})

test('headless runs draw and register nothing', async ($, on) => {
  const registered: string[] = []
  engine(on, {}, registered)
  await $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })

  expect(registered).toEqual([])
})

test('kill switch: enabled off draws nothing', { options: { enabled: false } }, async ($, on) => {
  engine(on)
  await start($)

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  expect(await texts(ui)).toEqual([])
})

test('first prompt becomes the goal until Claude sets one', async ($, on) => {
  engine(on)
  await start($)
  await $.prompt.submit({ text: 'build a small status card' } as never).catch(() => {})
  await $.prompt.submit({ text: 'now tidy the layout' } as never).catch(() => {})

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const shown = await texts(ui)
  expect(shown).toContain('🎯 Goal: build a small status card')
  expect(shown).toContain('🔧 Now: now tidy the layout')
})

test('auto goal: one cheap call fills Goal and Now when Claude never sets them', async ($, on) => {
  const asked: string[] = []
  engine(on)
  on('model.complete', ($: any, e: any) => {
    asked.push(e.model)

    return { value: { isAnswered: true, text: 'GOAL: Ship the Acme app\nNOW: Add a bash permission rule', usage: {} } } as never
  })
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await start($)
  await $.prompt.submit({ text: '<pasted_content id="1">Relayed text: build Acme</pasted_content id="1">' } as never).catch(() => {})
  const turn = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't1' } as never
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  await new Promise(r => (globalThis as any).setTimeout(r, 50)) // let the background call settle

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const shown = await texts(ui)
  expect(asked).toEqual(['claude-haiku-5-5'])
  expect(shown).toContain('🎯 Goal: Ship the Acme app')
  expect(shown).toContain('🔧 Now: Add a bash permission rule')
})

test('auto goal reads Claude replies and retries after a vague answer', async ($, on) => {
  const prompts: string[] = []
  const replies = ['GOAL: Unknown, not shown to me\nNOW: No details available', 'GOAL: Get Acme payments working\nNOW: Fixing the password check']
  engine(on)
  on('model.complete', ($: any, e: any) => {
    prompts.push(e.prompt)

    return { value: { isAnswered: true, text: replies.shift() ?? '', usage: {} } } as never
  })
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await start($)
  await $.prompt.submit({ text: '/resume abc12345' } as never).catch(() => {})
  const turn = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't' }) as never
  const settle = () => new Promise(r => (globalThis as any).setTimeout(r, 30))
  await $.turn.complete(turn('What we were doing: getting Acme payments working'))
  await settle()
  await $.turn.complete(turn('Fixed the password check'))
  await settle()

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const shown = await texts(ui)
  expect(prompts[0]).toContain('getting Acme payments working')
  expect(shown).toContain('🎯 Goal: Get Acme payments working')
  expect(shown).toContain('🔧 Now: Fixing the password check')
})

test('cards saved before seed existed still get a summary', async ($, on) => {
  const old = {
    state: 'your-turn', goal: '', topic: '', stage: '', pending: [], next: '',
    firstPrompt: '/resume abc12345', lastPrompt: 'yes, but hold off on step B',
    since: 0, updatedAt: 0,
  }
  engine(on, { 'note:sess-1': old })
  on('model.complete', () => ({ value: { isAnswered: true, text: 'GOAL: Finish the Acme migration\nNOW: Waiting for the PR to merge', usage: {} } }) as never)
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  await start($)
  await $.turn.complete({ answer: 'Holding step B until the PR merges', durationMs: 1, isAborted: false, turnId: 't' } as never)
  await new Promise(r => (globalThis as any).setTimeout(r, 30))

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const shown = await texts(ui)
  expect(shown).toContain('🎯 Goal: Finish the Acme migration')
  expect(shown).toContain('🔧 Now: Waiting for the PR to merge')
})
