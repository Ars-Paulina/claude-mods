export type StatuslineRows = {
  row1: string
  row2: string
  row3?: string
  row4?: string
  /** Project name shown bold before row 1 */
  key?: string
  /** Project colour (hex or colour name) */
  color?: string
  /** Money repo: red warning sign before the name */
  isMoney?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    statusline: { view: StatuslineRows | null }
  }
}
