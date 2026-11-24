import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { apply, card, isOld, normalize, parseSummary, real, shouldAsk, type Note } from './note'

const TOOL = 'mcp__session-board__set'

const GUIDE =
  `Session board: keep this session's card current with ${TOOL}. Set goal once, early: the ` +
  "session's original purpose in one line (<=100 chars); change it only if the user changes the purpose. " +
  'Set topic (<=80 chars, what we are working on right now) and ' +
  'stage (planning|building|testing|finished) when they change, pending (<=5 short open items) ' +
  'when the list changes, and next (one short line: the single next action for the user) at the ' +
  'end of every turn where it changed. Set blocked: true when you cannot continue without the user. ' +
  'Skip the call when nothing changed.'

const note = atom({ plugin: 'session-board', key: 'note' } as const, null)
const minute = atom({ plugin: 'session-board', key: 'minute' } as const, 0)

type SetArgs = { goal?: string; topic?: string; stage?: string; pending?: string[]; next?: string; blocked?: boolean }

let id = ''

const SUMMARIZER = 'claude-haiku-5-5'

// Claude may never call the tool; then a cheap call writes Goal and Now from the prompts and replies.
let isAsking = false

async function autoGoal($: any) {
  if (isAsking) return // two turns ending together must not both ask
  isAsking = true
  try {
    await askGoal($)
  } finally {
    isAsking = false
  }
}

async function askGoal($: any) {
  const n = normalize(await read($, note))
  const now = await $.clock.now()
  const opening = n?.seed || n?.firstPrompt // cards saved by older versions have no seed
  if (!n || !opening || !shouldAsk(n, now)) return

  await save($, { autoTries: n.autoTries + 1, autoAt: now }) // counted even if the call fails
  const r = await $.model.complete({
    model: SUMMARIZER,
    system:
      'You label coding sessions for a reader who wants plain words. Plain words, no jargon, max 12 words per line. ' +
      "Use the assistant replies: they often explain what the session is really about. Never answer 'unknown'.",
    prompt:
      `First request:\n${opening}\n\nFirst assistant reply:\n${n.firstAnswer}\n\n` +
      `Latest request:\n${n.lastPrompt}\n\nLatest assistant reply:\n${n.lastAnswer}\n\n` +
      'Reply with exactly two lines:\nGOAL: <the original purpose of this session>\nNOW: <what is being worked on right now>',
    maxTokens: 80,
  })
  if (!r.isAnswered) {
    $.ui.log(`session-board: summary not answered: ${r.reason}`)

    return
  }

  const s = parseSummary(r.text)
  const fresh = await read($, note)
  const patch: Partial<Note> = {}
  if (s.goal && !real(fresh?.goal ?? '')) patch.goal = s.goal
  if (s.now && (fresh?.isTopicAuto || !real(fresh?.topic ?? ''))) Object.assign(patch, { topic: s.now, isTopicAuto: true })
  await save($, patch)
}

// Updates the live card and mirrors it to the store so --resume brings it back.
async function save($: any, patch: Partial<Note>) {
  if (!id) return

  const merged = apply(await read($, note), patch, await $.clock.now())
  await update($, note, () => merged)
  await $.store.set(`note:${id}`, merged).catch(() => {})
}

// Drops other sessions' cards untouched for 30 days so the store stays small.
async function prune($: any) {
  const now = await $.clock.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('note:') || key === `note:${id}`) continue
    const old = (await $.store.get(key)) as Note | undefined
    if (!old || isOld(old, now)) await $.store.delete(key)
  }
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return

  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) return next(e) // headless `claude -p` runs are scripts, not sessions

    try {
      id = await $.session.id()
      const saved = (await $.store.get(`note:${id}`)) as Note | undefined
      if (saved) await update($, note, () => normalize(saved))
      await $.tool.register({
        name: 'set',
        description: "Update this session's card: goal, topic, stage, pending (max 5), next, blocked.",
        inputSchema: {
          type: 'object',
          properties: {
            goal: { type: 'string', description: "The session's original purpose, one line" },
            topic: { type: 'string', description: 'What we are working on now' },
            stage: { type: 'string' },
            pending: { type: 'array', items: { type: 'string' } },
            next: { type: 'string' },
            blocked: { type: 'boolean' },
          },
        },
      })
      $.clock.every(60_000, () => {
        void $.clock.now().then(t => update($, minute, () => Math.floor(t / 60_000))).catch(() => {})
      })
      await prune($)
    } catch (err) {
      $.ui.log(`session-board: start failed: ${String(err)}`) // fail open, but say why
    }

    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const a = e as unknown as SetArgs
    const patch: Partial<Note> = {}
    if (typeof a.goal === 'string') patch.goal = a.goal
    if (typeof a.topic === 'string') Object.assign(patch, { topic: a.topic, isTopicAuto: false })
    if (typeof a.stage === 'string') patch.stage = a.stage
    if (Array.isArray(a.pending)) patch.pending = a.pending
    if (typeof a.next === 'string') patch.next = a.next
    if (a.blocked === true) patch.state = 'blocked'
    await save($, patch)

    return { result: 'ok' }
  }).catch(() => ({ result: 'card unavailable' }))

  on('prompt.submit', async ($, e, next) => {
    const first = (await read($, note))?.firstPrompt ? {} : { firstPrompt: e.text, seed: e.text } // first prompt stands in for the goal
    await save($, { state: 'working', lastPrompt: e.text, ...first }).catch(() => {})

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const current = await read($, note)
    const answer = 'answer' in e ? String(e.answer ?? '') : ''
    const replies = current?.firstAnswer ? { lastAnswer: answer } : { firstAnswer: answer, lastAnswer: answer }
    const state = current?.state === 'blocked' ? {} : { state: 'your-turn' as const }
    await save($, { ...state, ...replies }).catch(() => {})
    // In the background: the turn never waits on it; a failure says why instead of vanishing.
    void autoGoal($).catch(err => $.ui.log(`session-board: summary failed: ${String(err)}`))

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)

    return { sections: [...r.sections, { id: 'session-board:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !id) return next(e)

    await read($, minute) // redraw once a minute so the "12m" stays true
    const c = card(await read($, note), await $.clock.now())
    // Other bands (flow-board, pendings-band) share this spot: keep whatever is beneath us.
    const below = await next(e)
    const { Box, Text } = $.ui.resolve(e)

    if (!c) {
      return (
        <Box flexDirection="column">
          <Text dimColor>New session · Claude will fill this in</Text>
          {below ?? []}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="column" borderStyle="round" borderColor={c.color} paddingX={1}>
          <Text color={c.color} bold>
            {c.header}
          </Text>
          {c.goal !== '' && (
            <Text bold={!c.isGoalGuess} dimColor={c.isGoalGuess}>
              🎯 Goal: {c.goal}
            </Text>
          )}
          {c.now !== '' && <Text dimColor={c.isNowGuess}>🔧 Now: {c.now}</Text>}
          {c.items.map(item => (
            <Text>☐ {item}</Text>
          ))}
          {c.next !== '' && <Text color="suggestion">👉 Next: {c.next}</Text>}
        </Box>
        {below ?? []}
      </Box>
    )
  })
}
