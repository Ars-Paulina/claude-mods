export type Item = { uuid: string; label: string; pos: number; queued?: true }

declare module 'claude-code' {
  interface PluginState {
    'prompt-index': { items: Shaped<Item[]>; counter: number; maybeMore: boolean }
  }
}
