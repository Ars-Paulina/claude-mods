export type Kind = 'plugin' | 'skill' | 'mcp'
export type Item = { kind: Kind; name: string; state: string; description: string; mcpjson?: boolean }
export type Lists = { plugins: Item[]; skills: Item[]; mcps: Item[] }

declare module 'claude-code' {
  interface PluginState {
    toggles: {
      lists: Lists | null
      tab: Kind
      pending: string | null
      busy: string | null
      query: string
      expanded: string | null
      changes: { id: string; kind: Kind }[]
    }
  }
}
