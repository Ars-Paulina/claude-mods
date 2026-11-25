// FR-19 blind detection. Pure: no engine access.
// Grey when a turn that used tools gave the mod 0 parsed tool events, when no tested version is
// stamped yet, or when Claude Code's major.minor differs from the stamped one (a patch bump stays).

export type BlindReason = 'no_events' | 'unstamped' | 'version'

export const majorMinor = (v: string) => /^(\d+)\.(\d+)/.exec(v.trim())?.slice(1, 3).join('.') ?? ''

export function blindReason(x: { toolTurn: boolean; parsedEvents: number; ccVersion: string; tested: string | null }): BlindReason | null {
  if (x.toolTurn && x.parsedEvents === 0) return 'no_events'
  if (!x.tested || !majorMinor(x.tested)) return 'unstamped'
  if (majorMinor(x.ccVersion) !== majorMinor(x.tested)) return 'version'
  return null
}
