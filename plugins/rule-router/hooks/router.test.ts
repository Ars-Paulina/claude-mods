import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { shouldScan } from './router'

const RULES = '<recall-rules source="rule-router">\n[R] matched: hook\nbody\n</recall-rules>\n'

// The world beneath the plugin: a session id and a python that answers like rule-router.py.
function world(on: On, routerOut: string | Error) {
  const seen: string[] = []
  // core beneath: the prompt enters with whatever context reached it
  on('prompt.submit', ($, e) => ({ text: e.text, context: e.context }) as never)
  on('session.id', () => ({ value: 'S1' }) as never)
  on('process.run', ($, e) => {
    if (e.argv.includes('-c')) return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    seen.push(String(e.init?.stdin ?? ''))
    if (routerOut instanceof Error) throw routerOut
    return { value: { exitCode: 0, stdout: routerOut, stderr: '' } } as never
  })
  return seen
}

const hookOut = (context: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } })

test('matched rules ride as hidden context; the typed text is untouched', async ($, on) => {
  const seen = world(on, hookOut(RULES))
  const r = await $.prompt.submit({ text: 'fix the hook' } as never)
  expect(r.text).toBe('fix the hook')
  expect(r.context).toEqual([RULES])
  expect(JSON.parse(seen[0]!)).toEqual({ prompt: 'fix the hook', session_id: 'S1' })
})

test('no match (empty stdout) adds no context', async ($, on) => {
  world(on, '')
  const r = await $.prompt.submit({ text: 'hello' } as never)
  expect(r.context ?? []).toEqual([])
})

test('a router that throws fails open: the prompt still enters, no context', async ($, on) => {
  world(on, new Error('boom'))
  const r = await $.prompt.submit({ text: 'fix the hook' } as never)
  expect(r.text).toBe('fix the hook')
  expect(r.context ?? []).toEqual([])
})

test('garbage stdout fails open too', async ($, on) => {
  world(on, 'not json')
  const r = await $.prompt.submit({ text: 'fix the hook' } as never)
  expect(r.text).toBe('fix the hook')
  expect(r.context ?? []).toEqual([])
})

test('background-task notifications and meta prompts are not scanned', async () => {
  expect(shouldScan({ text: 'security', origin: { kind: 'task-notification' } })).toBe(false)
  expect(shouldScan({ text: 'security', origin: { kind: 'composer' }, isMeta: true })).toBe(false)
  expect(shouldScan({ text: '   ', origin: { kind: 'composer' } })).toBe(false)
  expect(shouldScan({ text: 'security', origin: { kind: 'composer' } })).toBe(true)
})
