// node tests/toggle.test.mjs — flips write only this project's keys, in a fake HOME.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'toggles-'))
const proj = join(home, 'proj')
const other = join(home, 'other')
mkdirSync(join(proj, '.claude'), { recursive: true })
mkdirSync(join(home, '.claude'), { recursive: true })
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ skillOverrides: { a: 'off' } }))
writeFileSync(join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { jsonsrv: {} } }))
writeFileSync(join(home, '.claude.json'), JSON.stringify({
  mcpServers: { usersrv: {} },
  projects: { [proj]: {}, [other]: { disabledMcpServers: ['x'] } },
}))

const run = (...a) => execFileSync('node', [new URL('../bin/toggle.mjs', import.meta.url).pathname, ...a], {
  env: { ...process.env, TOGGLES_HOME: home }, encoding: 'utf8',
})
const json = p => JSON.parse(readFileSync(p, 'utf8'))

run('set', proj, 'skill', 'a', 'on')
run('set', proj, 'mcp', 'usersrv', 'off')
run('set', proj, 'mcp', 'jsonsrv', 'off')

const local = json(join(proj, '.claude', 'settings.local.json'))
assert.equal(local.skillOverrides.a, 'on')
assert.deepEqual(local.disabledMcpjsonServers, ['jsonsrv'])
assert.equal(json(join(home, '.claude', 'settings.json')).skillOverrides.a, 'off', 'user scope untouched')

const cj = json(join(home, '.claude.json'))
assert.deepEqual(cj.projects[proj].disabledMcpServers, ['usersrv'])
assert.deepEqual(cj.projects[other], { disabledMcpServers: ['x'] }, 'other project untouched')

run('set', proj, 'mcp', 'usersrv', 'on')
assert.deepEqual(json(join(home, '.claude.json')).projects[proj].disabledMcpServers, [])
run('set', proj, 'skill', 'a', 'user-invocable-only')
assert.equal(json(join(proj, '.claude', 'settings.local.json')).skillOverrides.a, 'user-invocable-only')
assert.throws(() => run('set', proj, 'skill', 'a', 'bogus'), 'unknown skill state refused')
console.log('ok')
