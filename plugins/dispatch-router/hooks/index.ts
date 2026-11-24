// Pure logic of dispatch-router: no `$`, everything outside goes through Io so the test can fake it.

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; mtimeMs: number }

export interface Io {
  /** Absolute path of the user's home. */
  home: string
  sid: string
  now: number
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  list(dir: string): Promise<Entry[]>
  /** rm -f: a missing file is fine. */
  remove(path: string): Promise<void>
  /** Append one line to a log file, creating its folder. */
  log(line: string): Promise<void>
}

export type Prompt = { text: string; kind?: string; isCommand?: boolean }

const VERIFY_FLAG_TTL_MS = 24 * 60 * 60 * 1000
const DAY_MS = 86400000

export function sessionKey(sid: string): string {
  return sid.replace(/[^\w-]/g, '') || 'unknown-session'
}

export const isSlashCommand = (text: string): boolean => /^\s*\/\S/.test(text)

// Background-agent output relayed back is never a human request.
export const isTaskNotification = (p: Prompt): boolean =>
  p.kind === 'task-notification' || /^\s*<task-notification>/i.test(p.text)

/** Plan frontmatter `status:` line. null: no status line. undefined: file missing. */
export async function planStatus(io: Io, planPath: string): Promise<string | null | undefined> {
  let content: string
  try {
    content = await io.read(planPath)
  } catch {
    return undefined
  }
  const fm = content.match(/^---\n([\s\S]*?)\n---/)
  const m = (fm?.[1] ?? content).match(/^status:\s*(\S+)/m)
  return m ? m[1] : null
}

async function logEvent(io: Io, event: string, planPath: string): Promise<void> {
  try {
    await io.log(`${new Date(io.now).toISOString()} [dispatch-router] ${event} | session=${io.sid} | plan=${planPath || '?'}`)
  } catch {
    // observability must never break the hook
  }
}

// A session that wrote a flag and never sent another prompt would leak it forever.
export async function sweepStaleFlags(io: Io): Promise<void> {
  const cache = `${io.home}/.claude/cache`
  let entries: Entry[]
  try {
    entries = await io.list(cache)
  } catch {
    return
  }
  for (const e of entries) {
    if (!/^verify-pending.*\.flag$/.test(e.name) || io.now - e.mtimeMs <= VERIFY_FLAG_TTL_MS) continue
    try {
      await io.remove(`${cache}/${e.name}`)
      await logEvent(io, `sweep: removed orphaned flag ${e.name}`, '')
    } catch {
      // vanished mid-sweep
    }
  }
}

const PENDING_RE = /^status:\s*pending(?=\s|$)/m
const APPROVED_RE = /^status:\s*approved(?=\s|$)/m

function isFresh(head: string, now: number): boolean {
  const m = head.match(/^approved:\s*(\d{4}-\d{2}-\d{2})/m)
  const day = m?.[1]
  return !!day && now - Date.parse(day) <= 30 * DAY_MS
}

async function countFiles(io: Io, dir: string, want: (name: string, head: string) => boolean): Promise<number> {
  let entries: Entry[]
  try {
    entries = await io.list(dir)
  } catch {
    return 0
  }
  let n = 0
  for (const e of entries) {
    if (!e.name.endsWith('.md')) continue
    try {
      const head = (await io.read(`${dir}/${e.name}`)).slice(0, 1024)
      if (want(e.name, head)) n += 1
    } catch {
      // unreadable: not counted
    }
  }
  return n
}

/** The learner flag: consumed once. Returns a notice, or null. */
export async function learnerNotice(io: Io): Promise<string | null> {
  const flag = `${io.home}/.claude/cache/learner-pending.flag`
  if (!(await io.exists(flag))) return null
  try {
    let queue: { queued_at: string }[] = []
    try {
      queue = JSON.parse(await io.read(`${io.home}/.claude/cache/learner-queue.json`))
    } catch {
      // empty or missing queue
    }
    // Circuit breaker: a full queue whose oldest entry is over 7 days old means the learner is stuck.
    if (queue.length >= 50) {
      const oldest = queue.reduce<{ queued_at: string } | null>(
        (min, e) => (!min || new Date(e.queued_at) < new Date(min.queued_at) ? e : min), null)
      const ageDays = oldest ? (io.now - new Date(oldest.queued_at).getTime()) / DAY_MS : 0
      if (ageDays > 7) {
        await io.remove(flag)
        return `ALERT: CLAUDE.md learner queue appears stuck — 50 entries queued for ${Math.round(ageDays)}+ days. ` +
          'The learner agent may be failing. Check ~/.claude/cache/learner-errors.log for diagnostics. ' +
          'To reset: delete ~/.claude/cache/learner-queue.json'
      }
    }

    const reviews = `${io.home}/.claude/plans/pending-reviews`
    // deep-* proposals are not learner edits. Automation cards also count while approved, for 30 days.
    let pending = await countFiles(io, reviews, (name, head) =>
      !name.startsWith('deep-') &&
      (PENDING_RE.test(head) || (name.startsWith('card-') && APPROVED_RE.test(head) && isFresh(head, io.now))))
    const aar = await countFiles(io, `${reviews}/aar`, (_n, head) => PENDING_RE.test(head))
    pending += aar

    await io.remove(flag)
    if (pending === 0) return null
    return `${pending} pending review proposal(s) in ~/.claude/plans/pending-reviews/${aar > 0 ? ` (${aar} of them AAR skill proposals in aar/)` : ''} — present to user.`
  } catch {
    await io.remove(flag).catch(() => {})
    return null
  }
}

const SKIP_STATUS: Record<string, string> = {
  executed: 'plan already executed (relay race — fast plan)',
  approved: 'plan already approved (same-turn verify)',
  executing: 'plan already executing (auto-handoff launched)',
}

/** This session's verify flag: consumed once. Returns the plan path to dispatch, or null. */
export async function verifyPlan(io: Io): Promise<string | null> {
  const flag = `${io.home}/.claude/cache/verify-pending-${sessionKey(io.sid)}.flag`
  if (!(await io.exists(flag))) return null
  try {
    const parsed = JSON.parse(await io.read(flag))
    await io.remove(flag)
    const planPath: string = (parsed && parsed.plan_path) || '(unknown)'
    if (parsed && parsed.session_uuid && String(parsed.session_uuid) !== String(io.sid)) {
      await logEvent(io, `skip: flag session_uuid mismatch (${parsed.session_uuid} != ${io.sid})`, planPath)
      return null
    }
    if (parsed && parsed.config === 'off') {
      await logEvent(io, 'skip: VERIFY_PLANS=off (flag consumed)', planPath)
      return null
    }
    // A flag can outlive its plan: skip when the plan is gone or already moving.
    const status = await planStatus(io, planPath)
    if (status === undefined) {
      await logEvent(io, 'skip: plan file missing/unreadable', planPath)
      return null
    }
    if (status && SKIP_STATUS[status]) {
      await logEvent(io, `skip: ${SKIP_STATUS[status]}`, planPath)
      return null
    }
    await logEvent(io, 'dispatch: plan-perfector', planPath)
    return planPath
  } catch {
    await io.remove(flag).catch(() => {})
    return null
  }
}

/** The context text to hand the model with this prompt, or null for none. */
export async function relay(io: Io, p: Prompt): Promise<string | null> {
  if (!p.text || isTaskNotification(p)) return null
  await sweepStaleFlags(io)
  const learner = await learnerNotice(io)
  // Slash commands skip the verify flag so it survives to the next plain prompt.
  if (!p.isCommand && !isSlashCommand(p.text)) {
    const plan = await verifyPlan(io)
    if (plan) {
      return `@DISPATCH:plan-perfector:Skill\n\nPlan pending verification: ${plan}\nSkill args: --fix ${plan}` +
        (learner ? `\n\n${learner}` : '')
    }
  }
  return learner
}
