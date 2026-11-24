#!/usr/bin/env node
// Lists and flips plugins, skills and MCP servers for ONE project.
//   node toggle.mjs list <projectDir>
//   node toggle.mjs set <projectDir> <plugin|skill|mcp> <name> <on|off>
// Every write is project-scoped: <projectDir>/.claude/settings.local.json, or this
// project's own entry in ~/.claude.json. User-scope files are never written.
import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync, readdirSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'

const HOME = process.env.TOGGLES_HOME || homedir()
const CLAUDE_JSON = join(HOME, '.claude.json')

const readJson = (p, fallback = {}) => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback)

// Temp file (unique per process) + rename, so a reader never sees half a file.
function writeJsonAtomic(p, obj) {
  const text = JSON.stringify(obj, null, 2) + '\n'
  const tmp = `${p}.toggles-${process.pid}-${Date.now()}.tmp`
  try {
    writeFileSync(tmp, text, { mode: 0o600 })
    renameSync(tmp, p)
  } finally {
    rmSync(tmp, { force: true })
  }
}

// Read-modify-write under a lock directory, so two sessions toggling at once
// can't drop each other's change. A lock older than 10 s is a crashed writer's.
function updateJson(p, change) {
  const lock = `${p}.toggles-lock`
  const deadline = Date.now() + 5000
  for (;;) {
    try { mkdirSync(lock); break } catch (err) {
      if (err.code !== 'EEXIST') throw err
      try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { rmSync(lock, { recursive: true, force: true }); continue } } catch {}
      if (Date.now() > deadline) throw new Error(`${p} is locked by another toggle (remove ${lock} if no toggle is running)`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
  }
  try {
    const obj = readJson(p)
    change(obj)
    writeJsonAtomic(p, obj)
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

const localSettingsPath = dir => join(dir, '.claude', 'settings.local.json')

function description(md) {
  const m = /^description:\s*(.*)$/m.exec(md.split(/^---$/m)[1] ?? '')
  return (m?.[1] ?? '').replace(/^["']|["']$/g, '').slice(0, 120)
}

// Later sources win, as Claude Code merges them: user < project < local.
const merged = (dir, key) => ({
  ...readJson(join(HOME, '.claude', 'settings.json'))[key],
  ...readJson(join(dir, '.claude', 'settings.json'))[key],
  ...readJson(localSettingsPath(dir))[key],
})

function listPlugins(dir) {
  const out = execFileSync('claude', ['plugin', 'list', '--json'], { cwd: dir, encoding: 'utf8' })
  const enabled = merged(dir, 'enabledPlugins')
  const rows = new Map()
  // Installs scoped to other projects show up too; only this project's and global ones count.
  for (const p of JSON.parse(out)) {
    if (p.projectPath && p.projectPath !== dir) continue
    let desc = ''
    try { desc = readJson(join(p.installPath, '.claude-plugin', 'plugin.json')).description ?? '' } catch {}
    const on = enabled[p.id] ?? p.enabled
    rows.set(p.id, { kind: 'plugin', name: p.id, state: on ? 'on' : 'off', description: desc.slice(0, 120) })
  }
  return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function listSkills(dir) {
  const overrides = merged(dir, 'skillOverrides')
  const seen = new Map()
  for (const root of [join(HOME, '.claude', 'skills'), join(dir, '.claude', 'skills')]) {
    if (!existsSync(root)) continue
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const md = join(root, e.name, 'SKILL.md')
      if (!existsSync(md)) continue
      // skillOverrides keys on the directory name, not frontmatter `name`.
      seen.set(e.name, { kind: 'skill', name: e.name, state: overrides[e.name] ?? 'on', description: description(readFileSync(md, 'utf8')) })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function listMcps(dir) {
  const cj = readJson(CLAUDE_JSON)
  const proj = cj.projects?.[dir] ?? {}
  const local = readJson(localSettingsPath(dir))
  const offUser = new Set(proj.disabledMcpServers ?? [])
  const offJson = new Set([...(proj.disabledMcpjsonServers ?? []), ...(local.disabledMcpjsonServers ?? [])])
  const rows = []
  for (const name of Object.keys({ ...cj.mcpServers, ...proj.mcpServers }))
    rows.push({ kind: 'mcp', name, state: offUser.has(name) ? 'off' : 'on', description: 'user/local server' })
  for (const name of Object.keys(readJson(join(dir, '.mcp.json')).mcpServers ?? {}))
    rows.push({ kind: 'mcp', name, state: offJson.has(name) ? 'off' : 'on', description: '.mcp.json server', mcpjson: true })
  return rows
}

const SKILL_STATES = ['on', 'name-only', 'user-invocable-only', 'off']

function setSkill(dir, name, value) {
  if (!SKILL_STATES.includes(value)) throw new Error(`skill state must be one of ${SKILL_STATES.join(', ')}`)
  updateJson(localSettingsPath(dir), s => {
    s.skillOverrides = { ...s.skillOverrides, [name]: value }
  })
}

function setMcp(dir, name, on) {
  const isJson = name in (readJson(join(dir, '.mcp.json')).mcpServers ?? {})
  const flip = (list = []) => (on ? list.filter(n => n !== name) : [...new Set([...list, name])])
  if (isJson) {
    // .mcp.json servers are switched in the project's own local settings file.
    updateJson(localSettingsPath(dir), s => {
      s.disabledMcpjsonServers = flip(s.disabledMcpjsonServers)
      if (on && s.enabledMcpjsonServers && !s.enableAllProjectMcpServers)
        s.enabledMcpjsonServers = [...new Set([...s.enabledMcpjsonServers, name])]
    })
    return
  }
  // ~/.claude.json is shared by every session: back up, then change only this
  // project's entry under the lock. ponytail: Claude Code itself doesn't take this
  // lock, so a write it makes in the same instant can still win.
  copyFileSync(CLAUDE_JSON, `${CLAUDE_JSON}.toggles-bak`)
  updateJson(CLAUDE_JSON, cj => {
    if (!cj.projects?.[dir]) throw new Error(`no entry for ${dir} in ~/.claude.json`)
    cj.projects[dir].disabledMcpServers = flip(cj.projects[dir].disabledMcpServers)
  })
}

function setPlugin(dir, name, on) {
  execFileSync('claude', ['plugin', on ? 'enable' : 'disable', name, '--scope', 'local'], { cwd: dir, encoding: 'utf8' })
}

const [cmd, dir, kind, name, value] = process.argv.slice(2)
try {
  if (cmd === 'list') {
    console.log(JSON.stringify({ plugins: listPlugins(dir), skills: listSkills(dir), mcps: listMcps(dir) }))
  } else if (cmd === 'set') {
    if (kind === 'skill') setSkill(dir, name, value)
    else ({ plugin: setPlugin, mcp: setMcp })[kind](dir, name, value === 'on')
    console.log(JSON.stringify({ ok: true }))
  } else {
    throw new Error('usage: toggle.mjs list <dir> | set <dir> <kind> <name> <on|off>')
  }
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message ?? err) }))
  process.exit(1)
}
