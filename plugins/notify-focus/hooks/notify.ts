// Pure logic of notify-focus: where this session runs, what to say, and the
// click-to-pane shell script. No `$` here, so the test runs it as plain values.

export type Where =
  | { kind: 'tmux'; pane: string }
  | { kind: 'herdr'; pane: string; tab: string }
  | { kind: 'plain' }

export type Event = 'UserPromptSubmit' | 'Notification' | 'Stop'

export const GLYPH: Record<Event, string> = { UserPromptSubmit: '●', Notification: '◐', Stop: '✔' }
export const LABEL: Record<Event, string> = { UserPromptSubmit: 'working', Notification: 'needs input', Stop: 'done' }

export const UNATTENDED_SECS = 60
export const CLICK_WAIT_SECS = 1800 // Cinnamon never closes an unclicked notification, so cap the waiter
export const DEDUP_MS = 120_000
const TITLE_TOKEN = 'tmux-claude-grid' // matches set-titles-string in ~/.tmux.conf

export type Env = { tmuxPane?: string; tmux?: string; herdrEnv?: string; herdrPane?: string; herdrTab?: string }

export function whereAmI(env: Env): Where {
  if (env.tmuxPane && env.tmux) return { kind: 'tmux', pane: env.tmuxPane }
  if (env.herdrEnv === '1' && env.herdrPane) return { kind: 'herdr', pane: env.herdrPane, tab: env.herdrTab ?? '' }
  return { kind: 'plain' }
}

/** The status-line text for an event: glyph and word. */
export function statusText(ev: Event): string {
  return `${GLYPH[ev]} ${LABEL[ev]}`
}

/** True when this event repeats the last one for the same pane inside the dedup window. */
export function isDup(prev: { glyph: string; ts: number } | undefined, glyph: string, now: number): boolean {
  return Boolean(prev && prev.glyph === glyph && now - prev.ts < DEDUP_MS)
}

/** Stop is skipped when the person was at the tmux client within the last minute. */
export function isAttended(clientActivity: string, nowSecs: number): boolean {
  const idle = nowSecs - parseInt(clientActivity, 10)
  return Number.isFinite(idle) && idle < UNATTENDED_SECS
}

export function titleOf(ev: Event, key: string): string {
  return ev === 'Stop' ? `${key}: done` : `${key}: needs input`
}

export function bodyOf(w: Where, cwd: string): string {
  return w.kind === 'tmux' ? `pane ${w.pane}` : w.kind === 'herdr' ? `herdr ${w.pane}` : cwd
}

/** Shell-quote one word. */
export function q(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

// The action key MUST be literally `default`: Cinnamon wires the notification body click to
// ActionInvoked only for that name. The waiter is capped with timeout(1) for the reason above.
// Every exit path logs, so a click that does nothing leaves a line in the log.
export function clickScript(w: Where, o: { title: string; body: string; key: string; sid: string; log: string; raise: string }): string {
  const L = q(o.log)
  const send = `act=$(timeout ${CLICK_WAIT_SECS} notify-send -a claude-code -h string:suppress-sound:true -A default=Focus -t 30000 ${q(o.title)} ${q(o.body)}); wrc=$?; `
  const tail = (what: string) =>
    `elif [ "$wrc" -ge 124 ]; then echo "$(date -Is) click-wait: expired unclicked after ${CLICK_WAIT_SECS}s (${what})" >> ${L}; ` +
    `else echo "$(date -Is) click-wait: closed without click rc=$wrc (${what})" >> ${L}; fi`
  const safe = (s: string) => s.replace(/[^\w:%-]/g, '')
  if (w.kind === 'tmux') {
    const p = q(w.pane)
    return send + `if [ "$act" = "default" ]; then ` +
      // `display -p -t <dead-pane>` exits 0 on tmux 3.4, so check list-panes output instead
      `if ! tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qx -- ${p}; then ` +
      `notify-send -a claude-code -t 8000 'pane gone' ${q(`${o.key} pane ${w.pane} no longer exists`)}; ` +
      `echo "$(date -Is) click: pane ${safe(w.pane)} GONE" >> ${L}; exit 0; fi; ` +
      `wmctrl -a ${q(TITLE_TOKEN)}; ` +
      `sess=$(tmux display -p -t ${p} '#{session_name}' 2>/dev/null); ` +
      `[ -n "$sess" ] && tmux switch-client -t "$sess" 2>/dev/null; ` +
      `win=$(tmux display -p -t ${p} '#{session_name}:#{window_index}' 2>/dev/null); ` +
      `[ -n "$win" ] && tmux select-window -t "$win"; ` +
      `tmux select-pane -t ${p} && tmux display-panes -d 800; rc=$?; ` +
      // rc is read BEFORE the echo: an inline $(date) would reset $? and mask a focus failure
      `echo "$(date -Is) click: focused ${safe(w.pane)} ($sess) rc=$rc" >> ${L}; ` + tail(`pane ${safe(w.pane)}`)
  }
  if (w.kind === 'herdr') {
    const p = q(w.pane)
    return send + `if [ "$act" = "default" ]; then ` +
      `if ! herdr pane get ${p} >/dev/null 2>&1; then ` +
      `notify-send -a claude-code -t 8000 'pane gone' ${q(`${o.key} herdr pane ${w.pane} no longer exists`)}; ` +
      `echo "$(date -Is) click: herdr pane ${safe(w.pane)} GONE" >> ${L}; exit 0; fi; ` +
      `herdr agent focus ${p} >/dev/null 2>&1 || herdr tab focus ${q(w.tab)} >/dev/null 2>&1; rc=$?; ` +
      `bash ${q(o.raise)} >/dev/null 2>&1 || echo "$(date -Is) click: herdr raise NO-WINDOW" >> ${L}; ` +
      `echo "$(date -Is) click: herdr focused ${safe(w.pane)} rc=$rc" >> ${L}; ` + tail(`herdr ${safe(w.pane)}`)
  }
  // plain Tilix: no per-pane focus API, so raise the window by WM_CLASS and let the glyph point to the split
  const sid = o.sid.replace(/[^\w-]/g, '') || 'nosid'
  return send + `if [ "$act" = "default" ]; then ` +
    `if wmctrl -x -a tilix.Tilix 2>/dev/null; then r=raised; ` +
    `elif tilix --focus-window 2>/dev/null; then r=raised-fallback; else r=NO-MATCH; fi; ` +
    `echo "$(date -Is) click: Tilix window $r (non-tmux ${sid})" >> ${L}; ` + tail(`non-tmux ${sid}`)
}
