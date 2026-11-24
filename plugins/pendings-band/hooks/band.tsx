import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PendingsBandRow, PendingsBandView } from '../types'

const view = atom({ plugin: 'pendings-band', key: 'view' } as const, null)
const isOpen = atom({ plugin: 'pendings-band', key: 'isOpen' } as const, false)

// python3 on Linux/macOS, the py launcher on Windows. Throws when none starts.
async function findPython($: EngineInterface): Promise<string[]> {
  for (const argv of [['python3'], ['python'], ['py', '-3']]) {
    try {
      const run = await $.process.run([...argv, '-c', 'import sys; assert sys.version_info >= (3, 9)'])
      if (run.exitCode === 0) return argv
    } catch {
      // not installed under this name: try the next
    }
  }
  throw new Error('Python 3.9+ not found (python3, python or py -3)')
}

// Longest whole-segment match: "~/a/b" matches ~/a/b and ~/a/b/c, never ~/a/b-x.
export function projectFor(cwd: string, map: string, home: string): string | null {
  let best: { length: number; project: string } | null = null
  for (const pair of map.split(';')) {
    const [rawDir, project] = pair.split('=').map(s => s.trim())
    if (!rawDir || !project) continue
    const dir = rawDir.replace(/^~(?=\/|$)/, home).replace(/\/+$/, '')
    const isInside = cwd === dir || cwd.startsWith(dir + '/')
    if (isInside && (!best || dir.length > best.length)) best = { length: dir.length, project }
  }
  return best?.project ?? null
}

function cut(text: string, width: number): string {
  return text.length > width ? text.slice(0, Math.max(width - 1, 1)) + '…' : text
}

export async function load($: EngineInterface, projectsMap: string): Promise<PendingsBandView> {
  const home = (await $.env.get('HOME')) ?? ''
  const cwd = await $.session.cwd()
  const project = projectFor(cwd, projectsMap, home)
  const ledgerPath = `${home}/.claude/goal-ledger/outcomes.json`
  if (!(await $.fs.exists(ledgerPath))) return { project, rows: [], others: 0, isMissing: true }
  try {
    const ledger = JSON.parse(String(await $.fs.read(ledgerPath)))
    const open: { id: string; projects: string[] }[] = ledger.outcomes.filter(
      (o: { status: string }) => o.status === 'open')
    const goals = `${$.plugin.root}/scripts/goals.py`
    const python = open.length ? await findPython($) : []
    // ponytail: one python start per open outcome per turn; a `--project` batch
    // command in goals.py would make it one call.
    const results = await Promise.all(open.map(async o => {
      const run = await $.process.run(
        [...python, goals, 'pendings-next', '--outcome', o.id],
        { cwd })
      if (run.exitCode !== 0) {
        const reason = (run.stderr || run.stdout).trim().split('\n').pop()
        throw new Error(`${o.id} exit ${run.exitCode}: ${reason}`)
      }
      return { outcome: o, next: JSON.parse(run.stdout).next as { id: string; description: string } | null }
    }))

    const rows: PendingsBandRow[] = []
    let others = 0
    for (const { outcome, next } of results) {
      if (!next) continue
      if (project && outcome.projects.includes(project)) {
        rows.push({ outcome: outcome.id, id: next.id, description: next.description })
      } else {
        others += 1
      }
    }
    return { project, rows: rows.slice(0, 3), others }
  } catch (err) {
    return { project, rows: [], others: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

async function refresh($: EngineInterface, projectsMap: string): Promise<void> {
  // A `claude -p` run draws nothing: skip the ledger reads there.
  if ((await $.session.surfaces()).length === 0) return
  const next = await load($, projectsMap)
  await update($, view, () => next)
}

export const register: Register = (on, options) => {
  const isEnabled = options.enabled !== false
  const projectsMap = String(options.projects ?? '')

  if (!isEnabled) return

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, view, () => null)
    $.clock.after(0, () => refresh($, projectsMap))
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    $.clock.after(0, () => refresh($, projectsMap))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, view)
    if (current === null || e.props.hasSurvey) return next(e)

    // Stack over any band beneath us (flow-board), so load order doesn't hide either.
    const below = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const stack = (own: NonNullable<typeof below>) => below ? <Box flexDirection="column">{own}{below}</Box> : own
    const width = e.props.bodyColumns || 80
    const more = current.others ? ` · +${current.others} other outcomes ready` : ''

    if (current.error) {
      return stack(<Box><Text color="red">{cut(`⚠ ledger read failed: ${current.error}`, width)}</Text></Box>)
    }
    if (current.isMissing) {
      return stack(<Box><Text dimColor>{cut('no goal ledger yet · see the pendings-band README to start one', width)}</Text></Box>)
    }
    if (current.rows.length === 0) {
      const note = current.project ? 'no ready pendings' : 'no ready pendings (folder not mapped)'
      return stack(<Box><Text dimColor>{cut(note + more, width)}</Text></Box>)
    }

    const isExpanded = await read($, isOpen)
    const line = (r: PendingsBandRow) => `▶ ${r.outcome}/${r.id}: ${r.description}`
    const rest = current.rows.slice(1)
    const toggle = rest.length
      ? [<Button key="toggle" label={isExpanded ? 'less' : `+${rest.length}`} onPress={() => update($, isOpen, o => !o)} />]
      : []
    const extra = isExpanded ? rest.map(r => <Text key={`${r.outcome}/${r.id}`} dimColor>{cut(line(r), width)}</Text>) : []

    return stack(
      <Box flexDirection="column">
        <Box>
          <Text>{cut(line(current.rows[0]!) + more, width - 10)} </Text>
          {toggle}
        </Box>
        {extra}
      </Box>
    )
  })
}
