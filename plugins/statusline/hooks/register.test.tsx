import { expect, mock, test } from 'claude-code/testing'

const SID = '0008955e-f588-4945-b84f-29874397c95f'
const PROPS = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} } as never

// A main repo, a worktree of it, the colour config, a stale usage cache and a graft stats file.
const FILES: Record<string, string> = {
  '/h/P/shop/.git/HEAD': 'ref: refs/heads/main\n',
  '/h/P/shop.wt/.git': 'gitdir: /h/P/shop/.git/worktrees/wt\n',
  '/h/P/shop/.git/worktrees/wt/HEAD': 'ref: refs/heads/oversee/x\n',
  '/h/P/shop/.git/worktrees/wt/commondir': '../..\n',
  '/h/.claude/config/project-colors.json': JSON.stringify({ shop: { fg: 'colour196', money: true } }),
  '/h/.claude/hooks/statusline-refresh.js': '// refresh',
  '/h/.claude/cache/usage-limits.json': JSON.stringify({ git_dirty: true, last_user_ts: '2026-11-24T15:00:00Z', last_assistant_ts: '2026-11-24T15:01:00Z', _timestamp: 1 }),
  '/h/P/shop/graft/.cache/stats.json': JSON.stringify({ nodeCount: 7, edgeCount: 9 }),
}

function world(on: any, cwd: string, writes: Record<string, string>, ran: string[][], surfaces: string[] = ['terminal']) {
  mock.env(on, { HOME: '/h' })
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: cwd }))
  on('session.model', () => ({ value: 'Sonnet 5' }))
  on('session.id', () => ({ value: SID }))
  on('session.turns', () => ({ value: 5 }))
  on('session.surfaces', () => ({ value: surfaces }))
  on('session.version', () => ({ value: { version: '2.1.331' } }))
  on('session.info', () => ({ value: { transcriptPath: '/h/.claude/projects/x/t.jsonl' } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200000, percent: 50 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 33, resetsAt: '2026-11-24T20:00:00Z' }],
    },
  }))
  on('fs.exists', (_: any, e: any) => ({ value: e.path in FILES }))
  on('fs.read', (_: any, e: any) => ({ value: FILES[e.path] }))
  on('fs.write', (_: any, e: any) => { writes[e.path] = e.text; return { value: undefined } })
  on('process.run', (_: any, e: any) => { ran.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '' } } })
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', ($: any, e: any) => { const { Box } = $.ui.resolve(e); return <Box key="beneath" /> })
}

async function drawn($: any, on: any, cwd: string, init?: { surfaces?: string[] }) {
  const writes: Record<string, string> = {}
  const ran: string[][] = []
  world(on, cwd, writes, ran, init?.surfaces)
  const time = mock.clock(on, { now: 0 })
  await $.session.start({ cwd, surface: 'terminal', isInteractive: true })
  await time.advance(1)
  const ui = await $.ui.mount({ plugin: 'statusline', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return { text, writes, ran }
}

test('draws context, limits, model, branch with dirty star, transcript, graft, project name', async ($, on) => {
  const { text } = await drawn($, on, '/h/P/shop')
  expect(text).toContain('Ctx ██████░░░░ 60%')
  expect(text).toContain('5h ███░░░░░░░ 33%')
  expect(text).toContain('Sonnet 5 │ 0008955e │ shop │ main* │ T:5')
  expect(text).toContain('/h/.claude/projects/x/t.jsonl')
  expect(text).toContain('7 nodes / 9 edges · ✓ synced')
  expect(text).toContain('⚠ ')
})

test('worktree: branch comes from the worktree HEAD, project colour from the main repo', async ($, on) => {
  const { text } = await drawn($, on, '/h/P/shop.wt')
  expect(text).toContain('oversee/x*')
  expect(text).toContain('#ff0000')
})

test('writes the hermes snapshot, the rate-limit file and the context bridge with the old keys', async ($, on) => {
  const { writes } = await drawn($, on, '/h/P/shop')
  const snap = JSON.parse(writes[`/h/.claude/hermes/statusline/${SID}.json`]!)
  expect(Object.keys(snap).sort()).toEqual(['captured_at', 'payload', 'rendered', 'session_id'])
  expect(/Ctx\D*(\d+)\s*%/.exec(snap.rendered)![1]).toBe('60')
  const limits = JSON.parse(writes[`/h/.claude/cache/rate-limits/${SID}.json`]!)
  expect(limits.five_hour).toEqual({ used_percentage: 33, resets_at: 1_795_550_400 })
  expect(limits.seven_day).toBe(null)
  expect(limits.session_id).toBe(SID)
  const bridge = JSON.parse(writes[`/tmp/claude-ctx-${SID}.json`]!)
  expect(bridge.remaining_percentage).toBe(50)
  expect(bridge.used_pct).toBe(60)
})

test('kicks the usage-limits refresh script when its cache is stale', async ($, on) => {
  const { ran } = await drawn($, on, '/h/P/shop')
  expect(ran).toEqual([['node', '/h/.claude/hooks/statusline-refresh.js', '2.1.331', '/h/P/shop', '/h/.claude/projects/x/t.jsonl']])
})

test('legacyFiles off: only the snapshot is written, no refresh', { options: { legacyFiles: false } }, async ($, on) => {
  const { writes, ran } = await drawn($, on, '/h/P/shop')
  expect(Object.keys(writes)).toEqual([`/h/.claude/hermes/statusline/${SID}.json`])
  expect(ran).toEqual([])
})

test('snapshotDir empty: no snapshot file', { options: { snapshotDir: '' } }, async ($, on) => {
  const { writes } = await drawn($, on, '/h/P/shop')
  expect(Object.keys(writes).some(p => p.includes('hermes'))).toBe(false)
})

test('headless run (no surface) draws and writes nothing', async ($, on) => {
  const { writes, ran } = await drawn($, on, '/h/P/shop', { surfaces: [] })
  expect(writes).toEqual({})
  expect(ran).toEqual([])
})

test('kill switch: enabled off draws nothing', { options: { enabled: false } }, async ($, on) => {
  const { text, writes } = await drawn($, on, '/h/P/shop')
  expect(text.includes('Ctx')).toBe(false)
  expect(writes).toEqual({})
})
