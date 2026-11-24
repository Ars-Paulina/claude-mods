export type StatuslineRows = { row1: string; row2: string }

declare module 'claude-code' {
  interface PluginState {
    statusline: { view: StatuslineRows | null }
  }
}
