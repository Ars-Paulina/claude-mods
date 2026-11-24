export type RateLimit = { kind: string; percentUsed: number; resetsAt?: string }
export type Info = {
  transcript?: string; graft?: string; isDirty?: boolean; key?: string; color?: string; isMoney?: boolean
  model?: string; sessionId?: string; project?: string; branch?: string | null; turns?: number
  contextPercent?: number; rateLimits?: readonly RateLimit[]; sentAt?: number; receivedAt?: number; cwd?: string
}

// Pure text builders for the statusline mod: no engine, no I/O, so node can test them.

export const CTX_RE = /Ctx\D*(\d+)\s*%/

// The old renderer normalised fill to the usable window (auto-compact buffer 16.5%).
// `percent` is the raw fill ($.session.usage().context.percent), remaining = 100 - percent.
export function normalizedUsed(percent: number): number {
  const remaining = 100 - percent
  const usableRemaining = Math.max(0, ((remaining - 16.5) / (100 - 16.5)) * 100)
  return Math.max(0, Math.min(100, Math.round(100 - usableRemaining)))
}

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
function ctxText(used: number): string {
  return `${used >= 80 ? '💀 ' : ''}Ctx ${bar(used)} ${used}%`
}

export type Rows = { row1: string; row2: string; row3?: string; row4?: string; key?: string; color?: string; isMoney?: boolean }

export function renderRows(info: Info): Rows {
  const limits = info.rateLimits ?? []
  const row1 = [
    info.contextPercent == null ? '' : ctxText(normalizedUsed(info.contextPercent)),
    limitText('5h', limits.find(l => l.kind === 'five_hour')),
    limitText('7d', limits.find(l => l.kind === 'seven_day')),
    `▲${clockText(info.sentAt)} ▼${clockText(info.receivedAt)}`,
  ].filter(Boolean).join(' │ ')
  const row2 = [
    info.model,
    info.sessionId ? info.sessionId.slice(0, 8) : '',
    info.project,
    info.branch ? info.branch + (info.isDirty ? '*' : '') : '',
    info.turns == null ? '' : `T:${info.turns}`,
  ].filter(Boolean).join(' │ ')
  return { row1, row2, row3: info.transcript || undefined, row4: info.graft || undefined, key: info.key, color: info.color, isMoney: info.isMoney }
}

// The file other tools read: same keys the old statusLine wrapper wrote
// ({ session_id, rendered, payload, captured_at }); payload carries the fields the mod can see.
export function snapshotDoc(info: Info, rows: Rows, nowMs: number) {
  return {
    session_id: info.sessionId,
    rendered: [rows.row1, rows.row2, rows.row3, rows.row4].filter(Boolean).join('\n'),
    payload: {
      session_id: info.sessionId,
      cwd: info.cwd,
      model: { display_name: info.model },
      context_window: { used_percentage: info.contextPercent ?? null },
      transcript_path: info.transcript,
      rate_limits: Object.fromEntries((info.rateLimits ?? []).map(l => [l.kind, { used_percentage: l.percentUsed, resets_at: l.resetsAt }])),
    },
    captured_at: nowMs / 1000,
  }
}

// A session id is a file name: same guard the old renderer used before writing per-session files.
export function isSafeId(id?: string): boolean {
  return !!id && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
}

export function toEpochSec(value?: string | number): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  const ms = Number.isFinite(n) ? n * (n > 1e11 ? 0.001 : 1) * 1000 : Date.parse(value as string)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

// ~/.claude/cache/rate-limits/<sid>.json, read by the claude-run supervisor.
// Same keys as the old renderer; resets_at is epoch SECONDS. null when the session has no window.
export function rateLimitDoc(info: Info, nowMs: number) {
  const pick = (kind: string) => {
    const l = (info.rateLimits ?? []).find(x => x.kind === kind)
    return l ? { used_percentage: l.percentUsed, resets_at: toEpochSec(l.resetsAt) } : null
  }
  const five = pick('five_hour')
  const seven = pick('seven_day')
  if (!five && !seven) return null
  return { written_at: nowMs, session_id: info.sessionId, cwd: info.cwd, transcript: info.transcript ?? '', five_hour: five, seven_day: seven }
}

// /tmp/claude-ctx-<sid>.json, read by gsd-context-monitor (ignores it when timestamp is over 60s old).
export function ctxBridgeDoc(info: Info, nowMs: number) {
  if (info.contextPercent == null) return null
  return {
    session_id: info.sessionId,
    remaining_percentage: 100 - info.contextPercent,
    used_pct: normalizedUsed(info.contextPercent),
    timestamp: Math.floor(nowMs / 1000),
  }
}

// graft/.cache/stats.json -> "N nodes / M edges · freshness"; '' when graft has no stats.
export function graftText(text: string | null): string {
  try {
    const s = JSON.parse(text ?? '')
    if (!s || !(s.nodeCount > 0)) return ''
    const fresh = s.syncing ? 'syncing…' : s.dirty && s.staleCount > 0 ? `⚠ ${s.staleCount} stale` : s.dirty ? '⚠ stale' : '✓ synced'
    return `${s.nodeCount} nodes / ${s.edgeCount} edges · ${fresh}`
  } catch {
    return ''
  }
}

// usage-limits.json (written by the refresh script): turn clock and dirty flag.
export function isoToMs(iso?: string | null): number {
  const t = Date.parse(iso ?? '')
  return Number.isFinite(t) ? t : 0
}
