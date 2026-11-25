// One session's observer: turns events into log rows. Pure (no engine access), so the mod's
// register.ts and the local replay scripts run exactly the same logic. Log only: every row says
// what the overseer WOULD have done; nothing here acts.

import { detectClaim } from './claims.ts'
import type { Detector } from './claims.ts'
import { isCheckCommand, isFresh, taskType } from './contract.ts'
import type { Contract, Edit, Run, TaskType } from './contract.ts'
import { gitCheck } from './gitcheck.ts'
import type { Runner, Sleep } from './gitcheck.ts'
import { newLoopState, onBash, onEdit } from './loops.ts'
import { pinViolations } from './pins.ts'
import type { CompiledPin } from './pins.ts'
import { newStaleState, onEvidencelessClaim } from './stale.ts'
import { blindReason } from './blind.ts'
import type { BlindReason } from './blind.ts'
import { approvalRecord } from './approval-record.ts'
import type { ApprovalRecord } from './approval-record.ts'

export type Signal = 'claim' | 'claim_vs_git' | 'loop' | 'compaction' | 'pin_violation' | 'stale' | 'blind' | 'approval' | 'timing'
export type Would = 'none' | 'warn' | 'block' | 'handoff'
/** One log row before the store adds `ts`, `sid` and `ms`. `detail` holds pointers and counts only. */
export type Row = { event: string; signal: Signal; would: Would; detail: Record<string, unknown> }
export type Dot = 'green' | 'yellow' | 'red' | 'grey'

export type Deps = { detector: Detector; pins: CompiledPin[]; git: Runner; sleep: Sleep }

// Short stable hash (FNV-1a) for output/diff identity. Not a secret fingerprint: never stored with text.
export function hash(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h >>> 0).toString(16).padStart(8, '0')
}


export class Observer {
  deps: Deps
  contract: Contract | null = null
  seq = 0
  runs: Run[] = []
  edits: Edit[] = []
  loops = newLoopState()
  stale = newStaleState()
  counts: Record<string, number> = {}
  // Per turn: tool calls this observer parsed, against the classic PostToolUse count (FR-19).
  parsedTools = 0
  turnRuns: Run[] = []
  worst: Would = 'none'
  blind: BlindReason | 'failtest' | null = null

  constructor(deps: Deps) {
    this.deps = deps
  }

  private add(rows: Row[], row: Row): void {
    rows.push(row)
    if (row.signal !== 'timing') this.counts[row.signal] = (this.counts[row.signal] ?? 0) + 1
    const rank: Would[] = ['none', 'warn', 'block', 'handoff']
    if (rank.indexOf(row.would) > rank.indexOf(this.worst)) this.worst = row.would
  }

  /** The person's prompt. Returns the approval record to store (text still unmasked: the store masks it). */
  prompt(text: string, ts: string, messageId: string): ApprovalRecord | null {
    return approvalRecord(text, ts, messageId)
  }

  /** A finished tool call on the main loop. */
  tool(tool: string, input: Record<string, unknown>, result: { isError: boolean; output: string }): Row[] {
    const rows: Row[] = []
    this.parsedTools++
    const seq = ++this.seq
    for (const id of pinViolations(this.deps.pins, tool, input)) this.add(rows, { event: 'tool.call', signal: 'pin_violation', would: 'warn', detail: { pin: id, tool, seq } })
    if (tool === 'Bash' && typeof input.command === 'string') {
      const run: Run = { seq, command: input.command, ok: !result.isError }
      this.runs.push(run)
      this.turnRuns.push(run)
      if (onBash(this.loops, input.command, result.isError, hash(result.output)) === 'loop') {
        this.add(rows, { event: 'tool.call', signal: 'loop', would: 'warn', detail: { kind: 'command', command_hash: hash(input.command), seq } })
      }
    } else if ((tool === 'Edit' || tool === 'Write') && typeof input.file_path === 'string' && !result.isError) {
      this.edits.push({ seq, file: input.file_path })
      const [before, after] = tool === 'Edit' ? [hash(String(input.old_string ?? '')), hash(String(input.new_string ?? ''))] : ['', hash(String(input.content ?? ''))]
      const diff = tool === 'Edit' ? `${before}>${after}` : `w${after}`
      if (onEdit(this.loops, input.file_path, diff, before || `w${this.edits.length}`, after) === 'edit_burst') {
        this.add(rows, { event: 'tool.call', signal: 'loop', would: 'warn', detail: { kind: 'edit', file_hash: hash(input.file_path), seq } })
      }
    }
    if (!rows.length) rows.push({ event: 'tool.call', signal: 'timing', would: 'none', detail: { tool, seq } })
    return rows
  }

  /**
   * The end of a main-loop turn: done-claim, claims vs git, blind check. `rawTools` = main-loop tool
   * calls the classic PostToolUse hook counted this turn; `compactions` = the count the classic
   * SessionStart(compact) hook keeps (scripts/classic.cjs).
   */
  async turn(answer: string, x: { cwd: string; ccVersion: string; tested: string | null; rawTools?: number; compactions?: number; canary?: { alerts: number; misses: number } }): Promise<Row[]> {
    const rows: Row[] = []
    const rawTools = x.rawTools ?? this.parsedTools
    if (x.compactions !== undefined) this.stale.compactions = x.compactions
    const claim = detectClaim(this.deps.detector, answer)
    if (claim.claim) {
      const type: TaskType = this.contract ? taskType(this.contract, this.edits) : 'non-repo'
      const detail: Record<string, unknown> = { task_type: type, phrases: claim.phrases, files: claim.files.length, shas: claim.shas.length, canary: x.canary ?? null }
      let would: Would = 'none'
      let evidenceless = false
      if (type === 'code') {
        if (!isFresh(this.runs, this.edits, claim.files)) {
          would = 'block'
          detail.missing = ['test run']
          evidenceless = true
        }
      } else if (type === 'read-only') {
        if (!this.turnRuns.length && rawTools === 0) { would = 'warn'; detail.missing = ['cited source'] }
      }
      if ((type === 'code' || type === 'docs') && (claim.files.length || claim.shas.length) && this.contract) {
        const authored = this.edits.map(e => e.file)
        const g = await gitCheck(this.deps.git, this.deps.sleep, x.cwd, claim, this.contract.ts, authored)
        const missing = [...Object.values(g.files), ...Object.values(g.shas)].filter(v => v === 'missing').length
        this.add(rows, { event: 'turn.complete', signal: 'claim_vs_git', would: g.status === 'missing' ? 'warn' : 'none', detail: { status: g.status, missing, unauthored: g.unauthored.length } })
        if (g.status === 'missing') {
          evidenceless = true
          if (would === 'none') would = 'warn'
        }
      }
      this.add(rows, { event: 'turn.complete', signal: 'claim', would, detail })
      if (evidenceless && onEvidencelessClaim(this.stale) === 'stale') this.add(rows, { event: 'turn.complete', signal: 'stale', would: 'handoff', detail: { evidenceless: this.stale.evidenceless, compactions: this.stale.compactions } })
    }
    const reason = blindReason({ toolTurn: rawTools > 0, parsedEvents: this.parsedTools, ccVersion: x.ccVersion, tested: x.tested })
    this.blind = reason
    if (reason) this.add(rows, { event: 'turn.complete', signal: 'blind', would: 'none', detail: { reason, raw_tools: rawTools, parsed_tools: this.parsedTools } })
    if (!rows.length) rows.push({ event: 'turn.complete', signal: 'timing', would: 'none', detail: { check_runs: this.turnRuns.filter(r => isCheckCommand(r.command)).length } })
    this.parsedTools = 0
    this.turnRuns = []
    return rows
  }

  dot(): Dot {
    if (this.blind) return 'grey'
    return this.worst === 'none' ? 'green' : 'yellow'
  }
}
