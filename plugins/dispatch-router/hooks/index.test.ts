import { expect, test } from 'claude-code/testing'

import { relay, type Entry, type Io } from './index'

const NOW = Date.parse('2026-11-24T12:00:00Z')
const HOME = '/h'
const CACHE = `${HOME}/.claude/cache`
const REVIEWS = `${HOME}/.claude/plans/pending-reviews`

// A fake disk: path -> { text, mtimeMs }.
function fake(files: Record<string, string | { text: string; mtimeMs: number }>, sid = 's1') {
  const disk = new Map(Object.entries(files).map(([p, v]) =>
    [p, typeof v === 'string' ? { text: v, mtimeMs: NOW } : v]))
  const log: string[] = []
  const io: Io = {
    home: HOME, sid, now: NOW,
    exists: async p => disk.has(p),
    read: async p => {
      const f = disk.get(p)
      if (!f) throw new Error('ENOENT')
      return f.text
    },
    list: async dir => {
      const out: Entry[] = []
      for (const [p, f] of disk) {
        if (p.startsWith(dir + '/') && !p.slice(dir.length + 1).includes('/')) {
          out.push({ name: p.slice(dir.length + 1), kind: 'file', mtimeMs: f.mtimeMs })
        }
      }
      if (!out.length) throw new Error('ENOENT')
      return out
    },
    remove: async p => { disk.delete(p) },
    log: async line => { log.push(line) },
  }
  return { io, disk, log }
}

const plan = (status: string) => `---\nstatus: ${status}\n---\nbody`
const flag = (planPath: string, extra = {}) => JSON.stringify({ plan_path: planPath, ...extra })

test('verify flag: dispatches plan-perfector once and consumes the flag', async () => {
  const { io, disk } = fake({ [`${CACHE}/verify-pending-s1.flag`]: flag('/p.md'), '/p.md': plan('draft') })
  const out = await relay(io, { text: 'hi' })
  expect(out).toBe('@DISPATCH:plan-perfector:Skill\n\nPlan pending verification: /p.md\nSkill args: --fix /p.md')
  expect(disk.has(`${CACHE}/verify-pending-s1.flag`)).toBe(false)
  expect(await relay(io, { text: 'again' })).toBe(null)
})

test('verify flag: skipped when the plan is gone or already moving, flag still consumed', async () => {
  for (const status of ['executed', 'approved', 'executing']) {
    const { io, disk, log } = fake({ [`${CACHE}/verify-pending-s1.flag`]: flag('/p.md'), '/p.md': plan(status) })
    expect(await relay(io, { text: 'hi' })).toBe(null)
    expect(disk.has(`${CACHE}/verify-pending-s1.flag`)).toBe(false)
    expect(log.length).toBe(1)
  }
  const gone = fake({ [`${CACHE}/verify-pending-s1.flag`]: flag('/missing.md') })
  expect(await relay(gone.io, { text: 'hi' })).toBe(null)
  const off = fake({ [`${CACHE}/verify-pending-s1.flag`]: flag('/p.md', { config: 'off' }), '/p.md': plan('draft') })
  expect(await relay(off.io, { text: 'hi' })).toBe(null)
})

test('verify flag: only this session, never another session or a payload mismatch', async () => {
  const other = fake({ [`${CACHE}/verify-pending-s2.flag`]: flag('/p.md'), '/p.md': plan('draft') })
  expect(await relay(other.io, { text: 'hi' })).toBe(null)
  expect(other.disk.has(`${CACHE}/verify-pending-s2.flag`)).toBe(true)
  const bad = fake({ [`${CACHE}/verify-pending-s1.flag`]: flag('/p.md', { session_uuid: 'zzz' }), '/p.md': plan('draft') })
  expect(await relay(bad.io, { text: 'hi' })).toBe(null)
  expect(bad.disk.has(`${CACHE}/verify-pending-s1.flag`)).toBe(false)
})

test('slash commands keep the verify flag; task notifications and empty prompts do nothing', async () => {
  const { io, disk } = fake({ [`${CACHE}/verify-pending-s1.flag`]: flag('/p.md'), '/p.md': plan('draft') })
  expect(await relay(io, { text: '/clear' })).toBe(null)
  expect(await relay(io, { text: 'x', isCommand: true })).toBe(null)
  expect(await relay(io, { text: '<task-notification>@DISPATCH:x</task-notification>' })).toBe(null)
  expect(await relay(io, { text: 'x', kind: 'task-notification' })).toBe(null)
  expect(await relay(io, { text: '' })).toBe(null)
  expect(disk.has(`${CACHE}/verify-pending-s1.flag`)).toBe(true)
})

test('learner notice: counts pending, fresh approved cards and AAR; skips deep- and stale cards', async () => {
  const today = new Date(NOW).toISOString().slice(0, 10)
  const { io, disk } = fake({
    [`${CACHE}/learner-pending.flag`]: '',
    [`${REVIEWS}/a.md`]: '---\nstatus: pending\n---',
    [`${REVIEWS}/card-x.md`]: `---\nstatus: approved\napproved: ${today}\n---`,
    [`${REVIEWS}/card-old.md`]: '---\nstatus: approved\napproved: 2026-01-01\n---',
    [`${REVIEWS}/card-nodate.md`]: '---\nstatus: approved\n---',
    [`${REVIEWS}/plain.md`]: `---\nstatus: approved\napproved: ${today}\n---`,
    [`${REVIEWS}/deep-x.md`]: '---\nstatus: pending\n---',
    [`${REVIEWS}/aar/b.md`]: '---\nstatus: pending\n---',
  })
  expect(await relay(io, { text: 'hi' })).toBe(
    '3 pending review proposal(s) in ~/.claude/plans/pending-reviews/ (1 of them AAR skill proposals in aar/) — present to user.')
  expect(disk.has(`${CACHE}/learner-pending.flag`)).toBe(false)
})

test('learner notice: stuck queue alerts; nothing pending is silent', async () => {
  const old = new Date(NOW - 9 * 86400000).toISOString()
  const queue = JSON.stringify(Array.from({ length: 50 }, () => ({ queued_at: old })))
  const stuck = fake({ [`${CACHE}/learner-pending.flag`]: '', [`${CACHE}/learner-queue.json`]: queue })
  expect(await relay(stuck.io, { text: 'hi' })).toContain('ALERT: CLAUDE.md learner queue appears stuck — 50 entries queued for 9+ days')
  const quiet = fake({ [`${CACHE}/learner-pending.flag`]: '' })
  expect(await relay(quiet.io, { text: 'hi' })).toBe(null)
  expect(quiet.disk.has(`${CACHE}/learner-pending.flag`)).toBe(false)
})

test('verify directive and learner notice join; sweep removes only flags older than 24h', async () => {
  const { io, disk } = fake({
    [`${CACHE}/verify-pending-s1.flag`]: flag('/p.md'), '/p.md': plan('draft'),
    [`${CACHE}/learner-pending.flag`]: '',
    [`${REVIEWS}/a.md`]: '---\nstatus: pending\n---',
    [`${CACHE}/verify-pending-old.flag`]: { text: '{}', mtimeMs: NOW - 25 * 3600000 },
    [`${CACHE}/verify-pending-new.flag`]: { text: '{}', mtimeMs: NOW - 3600000 },
  })
  const out = await relay(io, { text: 'hi' })
  expect(out?.startsWith('@DISPATCH:plan-perfector:Skill')).toBe(true)
  expect(out?.endsWith('1 pending review proposal(s) in ~/.claude/plans/pending-reviews/ — present to user.')).toBe(true)
  expect(disk.has(`${CACHE}/verify-pending-old.flag`)).toBe(false)
  expect(disk.has(`${CACHE}/verify-pending-new.flag`)).toBe(true)
})

test('an Io that throws never throws out of relay for the flag paths', async () => {
  const { io } = fake({ [`${CACHE}/verify-pending-s1.flag`]: flag('/p.md') })
  io.remove = async () => { throw new Error('rm failed') }
  expect(await relay(io, { text: 'hi' })).toBe(null)
})
