export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
export type Info = {
  model?: string; sessionId?: string; project?: string; branch?: string | null; turns?: number
  contextPercent?: number; rateLimits?: readonly RateLimit[]; sentAt?: number; receivedAt?: number; cwd?: string
}

// Pure text builders for the statusline mod: no engine, no I/O, so node can test them.

export const CTX_RE = /Ctx\D*(\d+)\s*%/

export function bar(pct: number): string {
  const filled = Math.max(0, Math.min(10, Math.floor(pct / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

// '2026-11-24T20:00:00Z' -> '@Tue 4p' in local time; '' when unreadable.
export function resetText(iso?: string): string {
  const d = new Date(iso ?? '')
  if (isNaN(d.getTime())) return ''
  const h = d.getHours() % 12 || 12
  const m = d.getMinutes()
  const time = m ? `${h}:${String(m).padStart(2, '0')}` : `${h}`
  return `@${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()]} ${time}${d.getHours() >= 12 ? 'p' : 'a'}`
}

export function clockText(ms?: number): string {
  if (!ms) return '?'
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() >= 12 ? 'p' : 'a'}`
}

export function limitText(label: string, limit?: RateLimit): string {
  if (!limit) return ''
  const pct = Math.round(limit.percentUsed)
  return [`${label} ${bar(pct)} ${pct}%`, resetText(limit.resetsAt)].filter(Boolean).join(' ')
}

// info: { model, sessionId, project, branch, turns, contextPercent, rateLimits, sentAt, receivedAt }
// Returns the two rows. Row 1 has "Ctx <bar> N%": a reader (hermes digest) matches CTX_RE on it.
export function renderRows(info: Info): { row1: string; row2: string } {
  const limits = info.rateLimits ?? []
  const row1 = [
    info.contextPercent == null ? '' : `${info.contextPercent >= 80 ? '💀 ' : ''}Ctx ${bar(info.contextPercent)} ${Math.round(info.contextPercent)}%`,
    limitText('5h', limits.find(l => l.kind === 'five_hour')),
    limitText('7d', limits.find(l => l.kind === 'seven_day')),
    `▲${clockText(info.sentAt)} ▼${clockText(info.receivedAt)}`,
  ].filter(Boolean).join(' │ ')
  const row2 = [
    info.model,
    info.sessionId ? info.sessionId.slice(0, 8) : '',
    info.project,
    info.branch,
    info.turns == null ? '' : `T:${info.turns}`,
  ].filter(Boolean).join(' │ ')
  return { row1, row2 }
}

// The file other tools read: same keys the old statusLine wrapper wrote
// ({ session_id, rendered, payload, captured_at }); payload carries the fields the mod can see.
export function snapshotDoc(info: Info, rows: { row1: string; row2: string }, nowMs: number) {
  return {
    session_id: info.sessionId,
    rendered: `${rows.row1}\n${rows.row2}`,
    payload: {
      session_id: info.sessionId,
      cwd: info.cwd,
      model: { display_name: info.model },
      context_window: { used_percentage: info.contextPercent ?? null },
      rate_limits: Object.fromEntries((info.rateLimits ?? []).map(l => [l.kind, { used_percentage: l.percentUsed, resets_at: l.resetsAt }])),
    },
    captured_at: nowMs / 1000,
  }
}

// ".git/HEAD" text -> branch name, or a 7-char hash when detached; null when unreadable.
export function branchFromHead(text?: unknown): string | null {
  const t = String(text ?? '').trim()
  if (!t) return null
  return t.startsWith('ref: refs/heads/') ? t.slice(16) : t.slice(0, 7)
}
