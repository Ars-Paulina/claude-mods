export type State = 'working' | 'your-turn' | 'blocked'

export type Note = {
  state: State
  goal: string
  topic: string
  stage: string
  pending: string[]
  next: string
  firstPrompt: string
  seed: string
  firstAnswer: string
  lastAnswer: string
  autoTries: number
  autoAt: number
  isTopicAuto: boolean
  lastPrompt: string
  since: number
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-board': { note: Note | null; minute: number }
  }
}
