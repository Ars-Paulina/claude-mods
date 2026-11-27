import { test, expect, mock } from 'claude-code/testing'

const ID = 'sess-1'

// The engine beneath the plugin: a store in memory, a session id, tool registration, an empty band.
function engine(on: any, store: Record<string, unknown> = {}, registered: string[] = [], sid: () => string = () => ID, logs: string[] = []) {
  // A hand-made store, so a test can read what the plugin wrote (mock.store keeps its own copy).
  on('store.get', ($: any, e: any) => ({ value: store[e.key] }))
  on('store.set', ($: any, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))

    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(store) }))
  on('store.delete', ($: any, e: any) => {
    delete store[e.key]

    return { value: undefined }
  })
  mock.clock(on, { now: 1000 })
  on('ui.log', ($: any, e: any) => {
    logs.push(String(e.text))

    return { value: undefined }
  })
  on('session.id', () => ({ value: sid() }))
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
  expect(shown).toContain('☐ 1. polish')
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

// ---- the cheap model fills the card ----

// A fake credential built at run time so no scanner sees a literal token in this file.
const PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2)
const settle = (ms = 40) => new Promise(r => (globalThis as any).setTimeout(r, ms))
const turn = (answer: string, turnId = 't1', extra: object = {}) => ({ answer, durationMs: 1, isAborted: false, turnId, ...extra }) as never
const answered = (text: string): any => ({ value: { isAnswered: true, text, usage: { input_tokens: 11, output_tokens: 7 } } })
const core = (on: any) => {
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
}
const saved = (store: Record<string, unknown>, key = `note:${ID}`) => store[key] as any

test('card call: one cheap call fills Goal, Now and numbered pending, and the card is fresh', async ($, on) => {
  const asked: any[] = []
  const store: Record<string, unknown> = {}
  const logs: string[] = []
  engine(on, store, [], () => ID, logs)
  on('model.complete', ($: any, e: any) => {
    asked.push(e)

    return answered('GOAL_CHANGED: no\nGOAL: Ship the Acme app\nNOW: Add a bash permission rule\nPENDING:\n+ push the branch\n+ fix the hook')
  })
  core(on)
  await start($)
  await $.prompt.submit({ text: '<pasted_content id="1">Relayed text: build Acme</pasted_content id="1">' } as never).catch(() => {})
  await $.turn.complete(turn('🟢 Done.\n⏳ +push the branch · +fix the hook\n👉 Next (no reply needed): I run the tests'))
  await settle()

  const ui = await $.ui.mount({ plugin: 'session-board', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } as never })
  const shown = await texts(ui)
  expect(asked.length).toBe(1)
  expect(asked[0].model).toBe('claude-haiku-5-5')
  expect(asked[0].maxTokens).toBe(120)
  expect(asked[0].prompt).toContain('⏳ +push the branch')
  expect(shown).toContain('🎯 Goal: Ship the Acme app')
  expect(shown).toContain('🔧 Now: Add a bash permission rule')
  expect(shown).toContain('☐ 1. push the branch')
  expect(shown).toContain('☐ 2. fix the hook')
  expect(shown).toContain('👉 Next: I run the tests')
  const n = saved(store)
  expect(n.freshTurn).toBe('t1')
  expect(n.cardTurn).toBe('t1')
  expect(n.isPendingLive).toBe(false) // no full list seen yet: Claude is not told the card is live
  expect(n.lastSeen > 0).toBe(true)
  expect(logs.some(l => l.includes('card call claude-haiku-5-5 in=11 out=7'))).toBe(true) // every call is logged with its tokens
})

test('the turn never waits for the cheap call', async ($, on) => {
  let release: (v: unknown) => void = () => {}
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', () => new Promise(r => (release = r)) as never)
  core(on)
  await start($)
  await $.prompt.submit({ text: 'build Acme' } as never).catch(() => {})
  await $.turn.complete(turn('👉 Next (no reply needed): go on')) // resolves while the call still hangs
  expect(saved(store).cardTurn).toBe('t1')
  expect(saved(store).freshTurn).toBe('') // in flight: not fresh
  release(answered('GOAL: Ship Acme\nNOW: Going on\nPENDING:\n(none)'))
  await settle()
  expect(saved(store).freshTurn).toBe('t1')
})

test('a secret in the prompt or the reply reaches neither the store nor the cheap model', async ($, on) => {
  const asked: any[] = []
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', ($: any, e: any) => {
    asked.push(e)

    return answered('GOAL: Deploy\nNOW: Deploying\nPENDING:\n(none)')
  })
  core(on)
  await start($)
  await $.prompt.submit({ text: `deploy with ${PAT} please` } as never).catch(() => {})
  await $.turn.complete(turn(`I used ${PAT}.\n👉 Next (no reply needed): done`))
  await settle()

  expect(asked.length).toBe(1)
  expect(JSON.stringify(asked)).not.toContain(PAT)
  expect(JSON.stringify(store)).not.toContain(PAT)
  expect(JSON.stringify(store)).toContain('[secret masked: github_pat]')
})

// Not tested here: the secret screen itself throwing. The engine only passes strings to the hooks and loads
// the plugin as its own module instance, so a test cannot make detect() throw. Both handlers wrap safe() in
// try/catch and return before any save or model call.

test('a failed call keeps the card, marks it stale and counts; the next good call clears it and still reads the missed reply', async ($, on) => {
  const prompts: string[] = []
  const store: Record<string, unknown> = { [`note:${ID}`]: { state: 'your-turn', goal: 'Ship Acme', topic: 'Old step', pending: ['keep me'], firstPrompt: 'x', firstAnswer: 'y' } }
  const replies: any[] = [{ value: { isAnswered: false, reason: 'api-error' } }, answered('GOAL: Ship Acme\nNOW: New step\nPENDING:\n1. keep me\n+ missed item')]
  engine(on, store)
  on('model.complete', ($: any, e: any) => {
    prompts.push(e.prompt)

    return replies.shift()
  })
  core(on)
  await start($)
  await $.turn.complete(turn('⏳ +missed item', 't1'))
  await settle()
  let n = saved(store)
  expect(n.failCount).toBe(1)
  expect(n.staleSince > 0).toBe(true)
  expect(n.freshTurn).toBe('')
  expect(n.topic).toBe('Old step')
  expect(n.pending).toEqual([
    { n: 1, text: 'keep me' },
    { n: 2, text: 'missed item' }, // the delta is applied in code, so the list is right even though the call failed
  ])

  await $.turn.complete(turn('👉 Next (no reply needed): go on', 't2'))
  await settle()
  n = saved(store)
  expect(prompts[1]).toContain('2. missed item') // code already put the item on the card the model is shown
  expect(n.failCount).toBe(0)
  expect(n.staleSince).toBe(0)
  expect(n.freshTurn).toBe('t2')
  expect(n.pending).toEqual([
    { n: 1, text: 'keep me' },
    { n: 2, text: 'missed item' },
  ])
})

test('turns that end during a call are read together by one more call', async ($, on) => {
  const prompts: string[] = []
  let release: (v: unknown) => void = () => {}
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', ($: any, e: any) => {
    prompts.push(e.prompt)
    if (prompts.length === 1) return new Promise(r => (release = r)) as never

    return answered('GOAL: Ship Acme\nNOW: Third step\nPENDING:\n+ middle item')
  })
  core(on)
  await start($)
  await $.prompt.submit({ text: 'build Acme' } as never).catch(() => {})
  await $.turn.complete(turn('👉 Next (no reply needed): one', 't1'))
  await $.turn.complete(turn('⏳ +middle item\n👉 Next (no reply needed): two', 't2'))
  await $.turn.complete(turn('👉 Next (no reply needed): three', 't3'))
  release(answered('GOAL: Ship Acme\nNOW: First step\nPENDING:\n(none)'))
  await settle(80)

  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('1. middle item') // already applied in code
  expect(prompts[1]).toContain('three')
  expect(saved(store).freshTurn).toBe('t3')
  expect(saved(store).pending).toEqual([{ n: 1, text: 'middle item' }])
})

test('agent turns, aborted turns and hand-back prompts leave the card alone', async ($, on) => {
  const asked: any[] = []
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', ($: any, e: any) => {
    asked.push(e)

    return answered('GOAL: x\nNOW: y')
  })
  core(on)
  await start($)
  await $.prompt.submit({ text: 'build Acme' } as never).catch(() => {})
  await $.prompt.submit({ text: '[Subagent hand-back] The task finished' } as never).catch(() => {})
  await $.turn.complete(turn('👉 **You:** an agent wrote this', 'a1', { agentId: 'agent-7' }))
  await $.turn.complete(turn('👉 **You:** cut short', 'a2', { isAborted: true }))
  await settle()

  const n = saved(store)
  expect(asked.length).toBe(0)
  expect(n.lastPrompt).toBe('build Acme')
  expect(n.state).toBe('working')
  expect(n.cardTurn).toBe('')
  expect(n.lastAnswer).toBe('')
  expect(n.lastSeen > 0).toBe(true) // the heartbeat still moves
})

test('a reply with no ⏳ or 👉 makes no call and leaves freshness alone', async ($, on) => {
  const asked: any[] = []
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', ($: any, e: any) => {
    asked.push(e)

    return answered('GOAL: Ship Acme\nNOW: Step\nPENDING:\n(none)')
  })
  core(on)
  await start($)
  await $.prompt.submit({ text: 'build Acme' } as never).catch(() => {})
  await $.turn.complete(turn('👉 Next (no reply needed): one', 't1'))
  await settle()
  await $.turn.complete(turn('The answer to your side question is 42.', 't2'))
  await settle()

  const n = saved(store)
  expect(asked.length).toBe(1)
  expect(n.cardTurn).toBe('t1')
  expect(n.freshTurn).toBe('t1')
  expect(n.lastAnswer).toBe('The answer to your side question is 42.')
})

test('the light follows the 👉 line: You means blocked, Next means your turn', async ($, on) => {
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', () => answered('GOAL: Ship Acme\nNOW: Step\nPENDING:\n(none)'))
  core(on)
  await start($)
  await $.prompt.submit({ text: 'build Acme' } as never).catch(() => {})
  await $.turn.complete(turn('🟡 need you\n👉 **You:** pick 1 or 2', 't1'))
  expect(saved(store).state).toBe('blocked')
  expect(saved(store).next).toBe('pick 1 or 2')
  await $.prompt.submit({ text: '1' } as never).catch(() => {})
  expect(saved(store).state).toBe('working')
  await $.turn.complete(turn('🟢 done\n👉 Next (no reply needed): I keep going', 't2'))
  expect(saved(store).state).toBe('your-turn')
})

test('a full ⏳ list in the reply replaces the card list with Claude numbers; the model answer cannot change it', async ($, on) => {
  const store: Record<string, unknown> = { [`note:${ID}`]: { state: 'your-turn', goal: 'Ship Acme', pending: ['old a', 'old b'], firstPrompt: 'x', firstAnswer: 'y' } }
  engine(on, store)
  on('model.complete', () => answered('GOAL: Ship Acme\nNOW: Step\nPENDING:\n+ something the model made up'))
  core(on)
  await start($)
  await $.turn.complete(turn('⏳ **Pending:**\n1. push the branch\n4. fix the hook\n\n👉 Next (no reply needed): go', 't1'))
  await settle()

  const n = saved(store)
  expect(n.pending).toEqual([
    { n: 1, text: 'push the branch' },
    { n: 4, text: 'fix the hook' },
  ])
  expect(n.nextN).toBe(5)
  expect(n.isPendingLive).toBe(true)
})

test('/clear: a new session id starts a new card under its own key', async ($, on) => {
  let sid = ID
  const store: Record<string, unknown> = {}
  engine(on, store, [], () => sid)
  on('model.complete', () => answered('GOAL: First purpose\nNOW: Step\nPENDING:\n(none)'))
  core(on)
  await start($)
  await $.prompt.submit({ text: 'first conversation' } as never).catch(() => {})
  sid = 'sess-2'
  await $.prompt.submit({ text: 'second conversation' } as never).catch(() => {})

  expect(saved(store).lastPrompt).toBe('first conversation')
  expect(saved(store, 'note:sess-2').firstPrompt).toBe('second conversation')
  expect(saved(store, 'note:sess-2').goal).toBe('')
})

test('a card restored from disk is not fresh until a new call finishes', async ($, on) => {
  const store: Record<string, unknown> = { [`note:${ID}`]: { state: 'your-turn', goal: 'Ship Acme', pending: ['a'], cardTurn: 't9', freshTurn: 't9', isPendingLive: true } }
  engine(on, store)
  await start($)
  expect(saved(store).freshTurn).toBe('')
  expect(saved(store).pending).toEqual([{ n: 1, text: 'a' }])
})

test('haikuPending off: the model writes Goal and Now only, and pending is not live', { options: { haikuPending: false } }, async ($, on) => {
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', () => answered('GOAL: Ship Acme\nNOW: Step\nPENDING:\n+ an item'))
  core(on)
  await start($)
  await $.prompt.submit({ text: 'build Acme' } as never).catch(() => {})
  await $.turn.complete(turn('⏳ +an item\n👉 Next (no reply needed): go', 't1'))
  await settle()

  const n = saved(store)
  expect(n.goal).toBe('Ship Acme')
  expect(n.pending).toEqual([])
  expect(n.isPendingLive).toBe(false)
})

test('summarizer option picks the model; a model that will not answer leaves the card stale', { options: { summarizer: 'no-such-model' } }, async ($, on) => {
  const asked: string[] = []
  const store: Record<string, unknown> = {}
  engine(on, store)
  on('model.complete', ($: any, e: any) => {
    asked.push(e.model)

    return { value: { isAnswered: false, reason: 'api-error' } } as never
  })
  core(on)
  await start($)
  await $.prompt.submit({ text: 'build Acme' } as never).catch(() => {})
  await $.turn.complete(turn('👉 Next (no reply needed): go', 't1'))
  await settle()

  expect(asked).toEqual(['no-such-model'])
  expect(saved(store).failCount).toBe(1)
  expect(saved(store).freshTurn).toBe('')
})

test('a full list that arrives during a call is not undone by that call\'s older answer', async ($, on) => {
  let release: (v: unknown) => void = () => {}
  let calls = 0
  const store: Record<string, unknown> = { [`note:${ID}`]: { state: 'your-turn', goal: 'Ship Acme', pending: ['one', 'two'], firstPrompt: 'x', firstAnswer: 'y' } }
  engine(on, store)
  on('model.complete', () => {
    calls++
    if (calls === 1) return new Promise(r => (release = r)) as never

    return answered('GOAL: Ship Acme\nNOW: Later step\nPENDING:\n1. one\n2. two\n3. three\n4. four')
  })
  core(on)
  await start($)
  await $.turn.complete(turn('👉 Next (no reply needed): go', 't1'))
  await $.turn.complete(turn('⏳ **Pending:**\n1. one\n2. two\n3. three\n4. four\n\n👉 Next (no reply needed): go', 't2'))
  release(answered('GOAL: Ship Acme\nNOW: Old step\nPENDING:\n1. one\n2. two')) // written before items 3 and 4 existed
  await settle(80)

  const n = saved(store)
  expect(n.pending.map((i: any) => i.n)).toEqual([1, 2, 3, 4])
  expect(n.freshTurn).toBe('t2')
  expect(calls).toBe(2)
})

test('/clear during a call: the old conversation\'s answer never lands on the new card', async ($, on) => {
  let sid = ID
  let release: (v: unknown) => void = () => {}
  const store: Record<string, unknown> = {}
  engine(on, store, [], () => sid)
  on('model.complete', () => new Promise(r => (release = r)) as never)
  core(on)
  await start($)
  await $.prompt.submit({ text: 'first conversation' } as never).catch(() => {})
  await $.turn.complete(turn('👉 Next (no reply needed): go', 't1'))
  sid = 'sess-2'
  await $.prompt.submit({ text: 'second conversation' } as never).catch(() => {})
  release(answered('GOAL: The first purpose\nNOW: Old step\nPENDING:\n+ old item'))
  await settle()

  const n = saved(store, 'note:sess-2')
  expect(n.goal).toBe('')
  expect(n.pending).toEqual([])
  expect(n.failCount).toBe(0)
})

test('a delta line is applied in code: a wrong model answer cannot keep a closed item or drop an open one', async ($, on) => {
  const store: Record<string, unknown> = { [`note:${ID}`]: { state: 'your-turn', goal: 'Ship Acme', pending: ['one', 'two', 'three'], isPendingLive: true, firstPrompt: 'x', firstAnswer: 'y' } }
  engine(on, store)
  on('model.complete', () => answered('GOAL: Ship Acme\nNOW: Step\nPENDING:\n1. one\n2. two\n+ made up'))
  core(on)
  await start($)
  await $.turn.complete(turn('🟢 Done.\n⏳ +#4 four · +five · +#1 six · ✓#2 two is done\n👉 Next (no reply needed): go', 't1'))
  await settle()

  const n = saved(store)
  expect(n.pending).toEqual([
    { n: 1, text: 'one' },
    { n: 3, text: 'three' },
    { n: 4, text: 'four' },
    { n: 5, text: 'five' }, // no number given: code picks the next one
    { n: 6, text: 'six' }, // number 1 is taken: code picks the next one
  ])
  expect(n.nextN).toBe(7)
  expect(n.freshTurn).toBe('t1')
  expect(n.isPendingLive).toBe(true)
})

test('a close that matches nothing: the item stays, and the list stops being live so Claude sends a full one', async ($, on) => {
  const store: Record<string, unknown> = { [`note:${ID}`]: { state: 'your-turn', goal: 'Ship Acme', pending: ['call the bank about the loan', 'push the branch'], isPendingLive: true, firstPrompt: 'x', firstAnswer: 'y' } }
  engine(on, store)
  on('model.complete', () => answered('GOAL: Ship Acme\nNOW: Step'))
  core(on)
  await start($)
  await $.turn.complete(turn('⏳ +#3 new thing · ✓phoned the bank · ✓#9\n👉 Next (no reply needed): go', 't1'))
  await settle()

  expect(saved(store).pending.map((i: any) => i.n)).toEqual([1, 2, 3])
  expect(saved(store).isPendingLive).toBe(false)

  await $.turn.complete(turn('⏳ **Pending:**\n2. push the branch\n3. new thing\n\n👉 Next (no reply needed): go', 't2'))
  await settle()
  expect(saved(store).pending.map((i: any) => i.n)).toEqual([2, 3])
  expect(saved(store).isPendingLive).toBe(true)
})
