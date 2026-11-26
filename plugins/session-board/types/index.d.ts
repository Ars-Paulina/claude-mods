export type State = 'working' | 'your-turn' | 'blocked'

export type Item = { n: number; text: string }

export type Note = {
  state: State
  goal: string
  topic: string
  stage: string
  pending: Item[]
  nextN: number
  next: string
  firstPrompt: string
  seed: string
  firstAnswer: string
  lastAnswer: string
  autoTries: number
  autoAt: number
  isTopicAuto: boolean
  lastPrompt: string
  cardTurn: string
  freshTurn: string
  isPendingLive: boolean
  failCount: number
  staleSince: number
  lastSeen: number
  since: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': { note: Note | null; minute: number }
  }
}
