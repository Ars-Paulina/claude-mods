import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Kind, Lists } from '../types'

const PANE = 'toggles'
const lists = atom({ plugin: 'toggles', key: 'lists' } as const, null)
const tab = atom({ plugin: 'toggles', key: 'tab' } as const, 'plugin')
const pending = atom({ plugin: 'toggles', key: 'pending' } as const, null)
const busy = atom({ plugin: 'toggles', key: 'busy' } as const, null)
const query = atom({ plugin: 'toggles', key: 'query' } as const, '')
const expanded = atom({ plugin: 'toggles', key: 'expanded' } as const, null)
const changes = atom({ plugin: 'toggles', key: 'changes' } as const, [])

const TABS: { kind: Kind; label: string; key: keyof Lists }[] = [
  { kind: 'plugin', label: 'Plugins', key: 'plugins' },
  { kind: 'skill', label: 'Skills', key: 'skills' },
  { kind: 'mcp', label: 'MCPs', key: 'mcps' },
]

// Skills have four states (skillOverrides); plugins and MCPs only on/off.
const CHOICES: Record<Kind, { value: string; label: string }[]> = {
  skill: [
    { value: 'on', label: 'On' },
    { value: 'name-only', label: 'Name' },
    { value: 'user-invocable-only', label: 'User' },
    { value: 'off', label: 'Off' },
  ],
  plugin: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
  mcp: [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }],
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'toggles',
      description: 'Turn plugins, skills and MCP servers on or off for this project',
    })

    return next(e)
  })

  on('command.run', { command: 'toggles' }, async $ => {
    // `columns` sizes the sidebar; the engine docks it only in fullscreen at 110+ columns.
    await $.ui.open({ id: PANE, title: 'Toggles', focus: true, columns: 60 })
    void refresh($)

    return { text: 'Toggles pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Button, Text } = els
    // Mobile has no Input: no search box there.
    const Input = 'Input' in els ? els.Input : undefined
    const data = await read($, lists)
    const current = await read($, tab)
    const confirm = await read($, pending)
    const working = await read($, busy)
    const raw = await read($, query)
    const search = raw.toLowerCase()
    const open = await read($, expanded)
    const unsaved = await read($, changes)
    const careful = await loadCareful($)
    const width = Math.max(20, e.props.bodyColumns - 4)

    const rows = (data ? data[TABS.find(t => t.kind === current)!.key] : [])
      .filter(i => !search || `${i.name} ${i.description}`.toLowerCase().includes(search))
      .sort((a, b) => rank(a.state) - rank(b.state) || a.name.localeCompare(b.name))

    return (
      <Box flexDirection="column">
        <Box>
          {TABS.map((t, n) => {
            const all = data?.[t.key] ?? []
            const active = all.filter(i => i.state !== 'off').length
            const label = data ? `${t.label} ${active}/${all.length}` : t.label
            return (
              <Button
                key={`tab-${t.kind}`}
                hotkey={String(n + 1)}
                label={t.kind === current ? `[${label}]` : label}
                onPress={() => update($, tab, () => t.kind)}
              />
            )
          })}
        </Box>
        {e.props.placement === 'inline' && (
          <Text color="yellow">
            {e.viewport?.isFullscreen === false
              ? 'Above the prompt because fullscreen is off (sidebar needs fullscreen).'
              : `Above the prompt because the terminal is ${e.viewport?.columns ?? '?'} columns; sidebar needs 110+.`}
          </Text>
        )}
        {Input && <Input
          key="search"
          label="Search: "
          placeholder="type to filter"
          value={raw}
          onInput={(v: string) => update($, query, () => v)}
          onSubmit={(v: string) => update($, query, () => v)}
        />}
        {unsaved.length > 0 && (
          <Box>
            <Button
              key="apply"
              label={`⟳ Apply ${unsaved.length} change${unsaved.length === 1 ? '' : 's'} (reload)`}
              onPress={() => apply($)}
            />
          </Box>
        )}
        {working && <Text color="yellow">⏳ {working}</Text>}
        {!data && <Text dimColor>Loading…</Text>}
        {data && rows.length === 0 && <Text dimColor>Nothing matches “{raw}”.</Text>}
        {rows.map(item => {
          const id = `${item.kind}:${item.name}`
          const chip = CHIPS[item.state] ?? { text: item.state, color: 'white' }
          return (
            <Box key={id} flexDirection="column" marginTop={1}>
              <Box>
                <Text color={chip.color} bold>{chip.text.padEnd(7)}</Text>
                <Button
                  key={`row-${id}`}
                  label={item.name}
                  onPress={() => update($, expanded, cur => (cur === id ? null : id))}
                />
              </Box>
              {item.description && <Text dimColor>{'       '}{cut(item.description, width - 7)}</Text>}
              {open === id && (
                <Box marginLeft={7}>
                  {CHOICES[item.kind].map(c => (
                    <Button
                      key={`${id}=${c.value}`}
                      label={c.value === item.state ? `[${c.label}]` : c.label}
                      onPress={async () => {
                        await press($, item, c.value, careful)
                        if ((await read($, pending)) !== id) await update($, expanded, () => null)
                      }}
                    />
                  ))}
                </Box>
              )}
              {confirm === id && <Text color="yellow">{'       '}Careful: press Off again to turn it off.</Text>}
            </Box>
          )
        })}
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>● On  ◐ Name only  ◆ You only  ○ Off   · toggles v0.2</Text>
          <Text dimColor>Press a name to change it, then Apply to reload. This project only.</Text>
        </Box>
      </Box>
    )
  })
}

const CHIPS: Record<string, { text: string; color: string }> = {
  on: { text: '● ON', color: 'green' },
  'name-only': { text: '◐ NAME', color: 'cyan' },
  'user-invocable-only': { text: '◆ USER', color: 'magenta' },
  off: { text: '○ OFF', color: 'gray' },
}

// Group order in the list; unknown states sort last.
const STATE_ORDER = ['on', 'name-only', 'user-invocable-only', 'off']
const rank = (s: string) => (STATE_ORDER.indexOf(s) + 5) % 5

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

type Engine = EngineInterface

async function helper($: Engine, args: string[]) {
  const { stdout } = await $.process.run(['node', `${$.plugin.root}/bin/toggle.mjs`, ...args], {
    timeoutMs: 60_000,
  })
  return JSON.parse(stdout)
}

async function refresh($: Engine) {
  const dir = (await $.process.run(['pwd'])).stdout.trim()
  const data: Lists = await helper($, ['list', dir])
  // The mod never lists itself, so it can't switch its own panel off.
  data.plugins = data.plugins.filter(p => !p.name.startsWith('toggles@'))
  await update($, lists, () => data)
}

async function loadCareful($: Engine): Promise<string[]> {
  try {
    return JSON.parse(await $.fs.read(`${$.plugin.root}/careful.json`))
  } catch {
    return []
  }
}

async function press($: Engine, item: Item, target: string, careful: string[]) {
  if (target === item.state) return
  const id = `${item.kind}:${item.name}`
  const isCareful = careful.some(c => item.name === c || item.name.startsWith(`${c}@`))

  if (target === 'off' && isCareful && (await read($, pending)) !== id) {
    await update($, pending, () => id)
    return
  }
  await update($, pending, () => null)
  await update($, busy, () => `Setting ${item.name} to ${target}…`)

  try {
    const dir = (await $.process.run(['pwd'])).stdout.trim()
    const result = await helper($, ['set', dir, item.kind, item.name, target])
    if (!result.ok) throw new Error(result.error)

    // Saved now; loaded when the person presses Apply, so several changes cost one reload.
    await update($, changes, list => [...list.filter(c => c.id !== id), { id, kind: item.kind }])
    await refresh($)
  } catch (err) {
    $.ui.toast(`Could not switch ${item.name}: ${String(err)}`)
  } finally {
    await update($, busy, () => null)
  }
}

async function apply($: Engine) {
  const list = await read($, changes)
  if (list.length === 0) return
  const commands = new Set(list.map(c => (c.kind === 'skill' ? 'reload-skills' : 'reload-plugins')))
  for (const command of commands) {
    await update($, busy, () => `Running /${command}…`)
    try {
      await $.command.run({ command, args: '' })
    } catch (err) {
      $.ui.toast(`Changes saved. Type /${command} to load them (${String(err)})`)
    }
  }
  if (list.some(c => c.kind === 'mcp')) $.ui.toast("MCP changes: if tools don't change, run /mcp or restart")
  await update($, changes, () => [])
  await update($, busy, () => null)
}
