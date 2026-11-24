export type PendingsBandRow = { outcome: string; id: string; description: string }

export type PendingsBandView = {
  project: string | null
  rows: PendingsBandRow[]
  others: number
  error?: string
  isMissing?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'pendings-band': { view: PendingsBandView | null; isOpen: boolean }
  }
}
