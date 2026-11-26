import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { detect, mask } from './detect'
import { applyDelta, buildPrompt, isAgentMsg, parseCard, parseDelta, parseFullList, parseNext, real, shouldSkip, tail, BATCH_MAX, PROMPT_MAX } from './haiku'
import { apply, card, isOld, normalize, type Note } from './note'

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

// Set once from the plugin's options when it loads.
let summarizer = 'claude-haiku-5-5'
let isPendingOn = true
let timeoutMs = 30_000

// The raw prompt and reply ends live here only: memory, never the store.
let lastPrompt = ''
let queue: string[] = [] // reply ends the cheap model has not read yet, oldest first
let isAsking = false
let isAskAgain = false

const resetMemory = () => {
  lastPrompt = ''
  queue = []
}

// Secrets are masked before anything is kept, stored or sent. A throw here is
// the caller's cue to keep and send nothing.
const safe = (text: string) => mask(text, detect(text))

const enqueue = (text: string) => {
  queue.push(text)
  while (queue.length > 1 && queue.reduce((sum, q) => sum + q.length, 0) > BATCH_MAX) queue.shift()
}

// One call at a time; turns that end meanwhile are read together by one more call.
async function runCard($: any) {
  if (isAsking) {
    isAskAgain = true

    return
  }
  isAsking = true
  try {
    do {
      isAskAgain = false
      await askCard($)
    } while (isAskAgain)
  } finally {
    isAsking = false
  }
}

async function fail($: any, batch: string[], why: string) {
  $.ui.log(`session-board: card not updated: ${why}`)
  queue = [...batch, ...queue] // keep the replies for the retry
  const n = normalize(await read($, note))
  const now = await $.clock.now()
  await save($, { failCount: (n?.failCount ?? 0) + 1, staleSince: n?.staleSince || now })
}

// A cheap call rewrites Goal and Now from the replies it has not read yet.
// The pending list is never the model's: code keeps it (see onTurn).
async function askCard($: any) {
  const n = normalize(await read($, note))
  if (!n || queue.length === 0) return

  const sid = id
  const turn = n.cardTurn
  const batch = queue
  queue = []
  const { system, prompt } = buildPrompt({ goal: real(n.goal), now: real(n.topic), pending: n.pending, prompt: lastPrompt, replies: batch })

  let r: any
  try {
    r = await $.model.complete({ model: summarizer, system, prompt, maxTokens: 120, timeoutMs })
  } catch (err) {
    return id === sid ? fail($, batch, String(err)) : undefined
  }
  if (id !== sid) return // `/clear` happened meanwhile: this answer belongs to the old conversation
  if (!r.isAnswered) return fail($, batch, String(r.reason))

  $.ui.log(`session-board: card call ${summarizer} in=${r.usage?.input_tokens ?? '?'} out=${r.usage?.output_tokens ?? '?'}`, { to: 'debug' })

  const p = parseCard(r.text)
  const fresh = normalize(await read($, note))
  if (!fresh) return

  const patch: Partial<Note> = { failCount: 0, staleSince: 0, freshTurn: turn }
  if (p.goal && (!real(fresh.goal) || p.isGoalChanged)) patch.goal = p.goal
  if (p.now) Object.assign(patch, { topic: p.now, isTopicAuto: true })
  await save($, patch)
}

// Updates the live card and mirrors it to the store so --resume brings it back.
async function save($: any, patch: Partial<Note>) {
  if (!id) return

  const merged = apply(await read($, note), patch, await $.clock.now())
  await update($, note, () => merged)
  await $.store.set(`note:${id}`, merged).catch(() => {})
}

// A card read back from disk was written by an earlier process: show it, but it is not fresh.
async function restore($: any) {
  const saved = normalize((await $.store.get(`note:${id}`)) as Note | undefined)
  const restored = saved ? { ...saved, freshTurn: '' } : null
  await update($, note, () => restored)
  if (restored) await $.store.set(`note:${id}`, restored).catch(() => {})
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

async function onTurn($: any, e: any) {
  const now = await $.clock.now()
  // Agent turns and aborted turns are not the user's conversation: only the heartbeat moves.
  if (e.agentId || e.isAborted) return save($, { lastSeen: now })

  let answer: string
  try {
    answer = safe(String(e.answer ?? ''))
  } catch (err) {
    $.ui.log(`session-board: reply not read, secret screen failed: ${String(err)}`)

    return save($, { lastSeen: now })
  }

  const current = await read($, note)
  const patch: Partial<Note> = current?.firstAnswer ? { lastAnswer: answer } : { firstAnswer: answer, lastAnswer: answer }
  patch.lastSeen = now
  // The reply's own 👉 line sets the light; without one a blocked card stays blocked.
  const pointer = parseNext(answer)
  if (pointer) Object.assign(patch, pointer)
  else if (current?.state !== 'blocked') patch.state = 'your-turn'
  // The pending list: a full list replaces it, a delta line is applied exactly. No model involved.
  // A close that matches nothing means card and Claude disagree: the list is then not "live",
  // the marker hook goes quiet, and Claude's next reply carries a full list that repairs it.
  const list = isPendingOn ? parseFullList(answer) : null
  const delta = isPendingOn && !list ? parseDelta(answer) : null
  if (!isPendingOn) patch.isPendingLive = false
  if (list) Object.assign(patch, { pending: list, isPendingLive: true })
  if (delta) {
    const c = normalize(current)
    const r = applyDelta(c?.pending ?? [], c?.nextN ?? 1, delta)
    Object.assign(patch, { pending: r.pending, nextN: r.nextN })
    if (r.unresolved.length) patch.isPendingLive = false
  }

  const goal = current?.goal ?? ''
  if (shouldSkip(answer, goal)) return save($, patch) // nothing about open work: the card stays as fresh as it was

  enqueue(tail(answer))
  await save($, { ...patch, cardTurn: String(e.turnId ?? now) })
  // In the background: the turn never waits on it; a failure says why instead of vanishing.
  void runCard($).catch(err => $.ui.log(`session-board: card update failed: ${String(err)}`))
}

export const register: Register = (on, options) => {
  if (options.enabled === false) return
  if (typeof options.summarizer === 'string' && options.summarizer) summarizer = options.summarizer
  if (typeof options.haikuTimeoutMs === 'number' && options.haikuTimeoutMs > 0) timeoutMs = options.haikuTimeoutMs
  isPendingOn = options.haikuPending !== false
  resetMemory()

  on('session.start', async ($, e, next) => {
    if (!e.isInteractive) return next(e) // headless `claude -p` runs are scripts, not sessions

    try {
      id = await $.session.id()
      await restore($)
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
    if (Array.isArray(a.pending)) patch.pending = a.pending as never // plain strings: apply() numbers them
    if (typeof a.next === 'string') patch.next = a.next
    if (a.blocked === true) patch.state = 'blocked'
    await save($, patch)

    return { result: 'ok' }
  }).catch(() => ({ result: 'card unavailable' }))

  on('prompt.submit', async ($, e, next) => {
    if (!id || e.isMeta || isAgentMsg(e.text)) return next(e) // an agent's hand-back is not the user's prompt

    // `/clear` and an in-place resume go on under a new session id, with no session.start.
    const now = await $.session.id()
    if (now && now !== id) {
      id = now
      resetMemory()
      await restore($)
    }

    let text: string
    try {
      text = safe(e.text)
    } catch (err) {
      $.ui.log(`session-board: prompt not kept, secret screen failed: ${String(err)}`)

      return next(e)
    }
    lastPrompt = text.slice(0, PROMPT_MAX)
    const first = (await read($, note))?.firstPrompt ? {} : { firstPrompt: text, seed: text } // first prompt stands in for the goal
    await save($, { state: 'working', lastPrompt: text, ...first }).catch(() => {})

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await onTurn($, e).catch(err => $.ui.log(`session-board: turn not recorded: ${String(err)}`))

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
          {c.more > 0 && <Text dimColor>+{c.more} more</Text>}
          {c.next !== '' && <Text color="suggestion">👉 Next: {c.next}</Text>}
        </Box>
        {below ?? []}
      </Box>
    )
  })
}
