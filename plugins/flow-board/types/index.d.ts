export type FlowBoardState = {
  /** running + pending + waiting agents */
  busy: number
  /** running agents with no turn.complete for 10+ min, and the longest such gap */
  quiet: number
  quietMin: number
  /** absent outside a git repo */
  git?: { dirty: number; ahead?: number }
  /** absent when gh is missing or there is no PR */
  pr?: { number: number; checks: '✓' | '✗' | '…' | '' }
  /** absent without .planning/STATE.md */
  gsd?: string
  /** checks that failed ('agents', 'git'): /park never calls them clean */
  unknown?: string[]
}

export type FlowBoardView = { state: FlowBoardState; phase: string | null }

declare module 'claude-code' {
  interface PluginState {
    'flow-board': { view: FlowBoardView | null; pressed: string | null }
  }
}
