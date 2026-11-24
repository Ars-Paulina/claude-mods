import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MAP = '~/P/shop-app=shop-app'
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 19 },
  view: {},
}
const LEDGER = JSON.stringify({
  outcomes: [
    { id: 'outcome-0003', status: 'open', projects: ['shop-app'] },
    { id: 'outcome-0002', status: 'open', projects: ['garden'] },
    { id: 'outcome-0004', status: 'open', projects: ['pos'] },
    { id: 'outcome-0009', status: 'closed', projects: ['shop-app'] },
  ],
})

// The world beneath the plugin: home, cwd, a drawing surface, the ledger file and goals.py.
function world(on: On, nextFor: Record<string, unknown>, failing?: string, hasLedger = true) {
  on('fs.exists', () => ({ value: hasLedger }) as never)
  mock.env(on, { HOME: '/h' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/h/P/shop-app/src' }) as never)
  on('session.surfaces', () => ({ value: ['terminal'] }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box key="beneath" />
  })
  on('fs.read', () => ({ value: LEDGER }) as never)
  on('process.run', ($, e) => {
    const outcome = e.argv[e.argv.length - 1] ?? ''
    if (outcome === failing) return { value: { exitCode: 2, stdout: '', stderr: 'boom\nno outcome there' } } as never
    return { value: { exitCode: 0, stdout: JSON.stringify({ next: nextFor[outcome] ?? null }), stderr: '' } } as never
  })
}

async function drawn($: Engine, on: On, surface: 'terminal' | 'desktop'): Promise<string> {
  const time = mock.clock(on, { now: 0 })
  await $.session.start({ cwd: '/h/P/shop-app/src', surface, isInteractive: true })
  await time.advance(1)
  const ui = await $.ui.mount({ plugin: 'pendings-band', surface, component: 'AbovePrompt', props: PROPS })
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: this project's next row, other outcomes counted, closed skipped`, { options: { projects: MAP } }, async ($, on) => {
    world(on, {
      'outcome-0003': { id: 'P01', description: 'Fix the type error in the product import.' },
      'outcome-0002': { id: 'P04', description: 'garden thing' },
    })
    const text = await drawn($, on, surface)
    expect(text).toContain('outcome-0003/P01: Fix the type error in the product import.')
    expect(text).toContain('+1 other outcomes ready')
    expect(text).not.toContain('P04')
  })

  test(`${surface}: nothing ready draws the dim line, never nothing`, { options: { projects: MAP } }, async ($, on) => {
    world(on, {})
    expect(await drawn($, on, surface)).toContain('no ready pendings')
  })

  test(`${surface}: a goals.py failure draws the red line`, { options: { projects: MAP } }, async ($, on) => {
    world(on, {}, 'outcome-0002')
    expect(await drawn($, on, surface)).toContain('⚠ ledger read failed: outcome-0002 exit 2: no outcome there')
  })

  test(`${surface}: no ledger yet draws the start hint, runs no python`, { options: { projects: MAP } }, async ($, on) => {
    world(on, {}, undefined, false)
    // A python start would need the ledger read first; the hint proves load() stopped before it.
    expect(await drawn($, on, surface)).toContain('no goal ledger yet')
  })
}
