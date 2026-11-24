import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { detect, mask } from './detect'
import { MAX_SCAN, onCommandFail, onPromptFail } from './register'

// Fake credentials built at run time so no scanner sees a literal token in this file.
const PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2)
const OPENAI = 'sk-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'
const PROJ = 'sk-' + 'proj-' + 'Ab12Cd34Ef56Gh78Ij90Kl12'
const JWT = ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.')
const HEX32 = '0123456789abcdef'.repeat(2)
const HEX64 = HEX32.repeat(2)
const masks = (text: string) => mask(text, detect(text))

// The engine beneath the plugin: it records what reached core, i.e. what a session stores and sends.
function world(on: On, env: Record<string, string> = { HOME: '/h' }, hasCore = true) {
  const core: { text: string; context: readonly string[] }[] = []
  const args: string[] = []
  const writes: { path: string; text: string }[] = []
  const toasts: string[] = []
  mock.env(on, env)
  mock.clock(on, { now: 0 })
  on('session.id', () => ({ value: 'sess-1' }) as never)
  on('ui.toast', ($, e) => { toasts.push(String(e.text)); return { value: undefined } as never })
  on('ui.log', () => ({ value: undefined }) as never)
  on('fs.exists', () => ({ value: false }) as never)
  on('fs.write', ($, e: any) => { writes.push({ path: e.path, text: e.text }); return { value: undefined } as never })
  if (hasCore) on('prompt.submit', ($, e) => { core.push({ text: e.text, context: e.context ?? [] }); return { text: e.text, context: e.context } })
  if (hasCore) on('command.run', ($, e) => { args.push(e.args); return { text: 'ran' } })
  return { core, args, writes, toasts }
}

test('secret is masked before it reaches core (stored + sent)', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: `deploy with ${PAT} and ${OPENAI} please` } as never)
  expect(w.core.length).toBe(1)
  const stored = w.core[0]!.text
  expect(stored).toBe('deploy with [secret masked: github_pat] and [secret masked: openai_key] please')
  expect(stored).not.toContain(PAT)
  expect(stored).not.toContain(OPENAI)
  expect(w.core[0]!.context.join('\n')).toContain('were masked before this prompt was stored')
  expect(w.toasts.join('\n')).toContain('Masked 2 secret(s)')
  // Redacted log: fingerprints only, never the raw bytes.
  expect(w.writes.length).toBe(1)
  expect(w.writes[0]!.path).toBe('/h/.claude/logs/prompt-secret-detections.log')
  expect(w.writes[0]!.text).toMatch(/DETECT openai_key:[0-9a-f]{12},github_pat:[0-9a-f]{12} session=sess-1\n$/)
  expect(w.writes[0]!.text).not.toContain(PAT)
})

test('non-secret prompt passes untouched, no log, no context', async ($, on) => {
  const w = world(on)
  const text = 'fix the bug in commit 3b6f4d3 and rerun the tests'
  await $.prompt.submit({ text } as never)
  expect(w.core[0]!.text).toBe(text)
  expect(w.core[0]!.context).toEqual([])
  expect(w.writes).toEqual([])
})

test('hex is masked only next to a secret keyword', async ($, on) => {
  const w = world(on)
  const hex = 'a'.repeat(16) + '0123456789abcdef'
  await $.prompt.submit({ text: `checksum ${hex}` } as never)
  await $.prompt.submit({ text: `the cron secret is ${hex}` } as never)
  expect(w.core[0]!.text).toBe(`checksum ${hex}`)
  expect(w.core[1]!.text).toBe('the cron secret is [secret masked: hex32]')
})

test('a bare high-entropy paste is masked whole', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: 'Qm9vT3Jx7Lp2Zk8Wn4Vt6Hs1' } as never)
  expect(w.core[0]!.text).toBe('[secret masked: standalone-high-entropy]')
})

test('slash command arguments are masked at command.run', async ($, on) => {
  const w = world(on)
  await $.command.run({ command: 'deploy', args: `--token ${PAT}` } as never)
  expect(w.args).toEqual(['--token [secret masked: github_pat]'])
})

test('kill switch: enabled off leaves the prompt as typed', { options: { enabled: false } }, async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: `key ${PAT}` } as never)
  expect(w.core[0]!.text).toBe(`key ${PAT}`)
})

test('ECOSYSTEM_SECRET_SCREEN=off leaves the prompt as typed', async ($, on) => {
  const w = world(on, { HOME: '/h', ECOSYSTEM_SECRET_SCREEN: 'off' })
  await $.prompt.submit({ text: `key ${PAT}` } as never)
  expect(w.core[0]!.text).toBe(`key ${PAT}`)
})

test('screen failing before next drops the prompt, never sends it raw', async ($, on) => {
  const w = world(on)
  on('ui.toast', () => { throw new Error('boom') })
  const r: any = await $.prompt.submit({ text: `key ${PAT}` } as never).catch((err: unknown) => ({ err }))
  expect(JSON.stringify(r)).not.toContain(PAT)
  expect(w.core.map(c => c.text).join('\n')).not.toContain(PAT)
})

for (const kind of ['prompt', 'command'] as const) {
  test(`${kind}: failure beneath, after next, never sends the raw secret down`, async ($, on) => {
    const seen: string[] = []
    world(on, undefined, false)
    on('prompt.submit', ($, e) => { seen.push(e.text); throw new Error('beneath') })
    on('command.run', ($, e) => { seen.push(e.args); throw new Error('beneath') })
    if (kind === 'prompt') await $.prompt.submit({ text: `key ${PAT}` } as never).catch(() => {})
    else await $.command.run({ command: 'deploy', args: `--token ${PAT}` } as never).catch(() => {})
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.join('\n')).not.toContain(PAT)
  })
}

test('false positives fixed: slugs with sk-, hex path segments, keyboard', async ($, on) => {
  const w = world(on)
  const hex = '0123456789abcdef'.repeat(2)
  const prompts = [
    'merge branch fix/task-queue-retry-on-failure please',
    'rename desk-booking-calendar-widget.tsx',
    `read /tmp/x/2.1.331/${hex}/plugin-authoring/reference.md, check the token budget`,
    `my keyboard checksum is ${hex}`,
    `the token cache is in /cache/${hex}/data`,
  ]
  for (const text of prompts) await $.prompt.submit({ text } as never)
  expect(w.core.map(c => c.text)).toEqual(prompts)
  expect(w.writes).toEqual([])
})

test('real ones still caught: API_KEY= hex, sk- after a space or quote', async ($, on) => {
  const w = world(on)
  const hex = '0123456789abcdef'.repeat(2)
  await $.prompt.submit({ text: `API_KEY=${hex}` } as never)
  await $.prompt.submit({ text: `key "${OPENAI}"` } as never)
  expect(w.core.map(c => c.text)).toEqual(['API_KEY=[secret masked: hex32]', 'key "[secret masked: openai_key]"'])
})

test('mask: overlapping hits are masked as one span, no tail left', () => {
  const text = 'aa SECRETONE-SECRETTWO bb'
  const out = mask(text, [
    { label: 'x', value: 'SECRETONE-SE', ranges: [[3, 15]] },
    { label: 'y', value: 'E-SECRETTWO', ranges: [[11, 22]] },
  ])
  expect(out).toBe('aa [secret masked: x+y] bb')
})

test('worst-case input stays far inside the 10 s hook budget (no regex blow-up)', async ($, on) => {
  const w = world(on)
  const inputs = ['eyJ'.repeat(100_000), 'sk-'.repeat(200_000), 'postgres://a:' + 'b'.repeat(500_000), `token ${'a1'.repeat(300_000)}`]
  const t0 = Date.now()
  for (const text of inputs) detect(text)
  expect(Date.now() - t0).toBeLessThan(1_000)
  // And through the hook: a big prompt with a secret at the end is still masked, not dropped or sent raw.
  await $.prompt.submit({ text: 'eyJ'.repeat(100_000) + ` ${PAT}` } as never)
  expect(w.core[0]!.text.endsWith(' [secret masked: github_pat]')).toBe(true)
})

test('slash command line on prompt.submit passes on, never dropped', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: `/deploy --token ${PAT}`, command: { name: 'deploy', args: `--token ${PAT}` } } as never)
  expect(w.core.length).toBe(1)
})

test('hidden prompt starting its own turn: text unchanged (engine allows no rewrite), warning added', async ($, on) => {
  const w = world(on)
  await $.prompt.submit({ text: `note ${PAT}`, isMeta: true } as never)
  expect(w.core[0]!.text).toBe(`note ${PAT}`)
  expect(w.core[0]!.context.join('\n')).toContain('could not be masked')
})

test('review 2: every copy of a detected secret is masked, even one that fails the gate alone', () => {
  const far = `token: ${HEX32}\n${'x'.repeat(60)}\nretry with ${HEX32} please`
  expect(masks(far)).toBe(`token: [secret masked: hex32]\n${'x'.repeat(60)}\nretry with [secret masked: hex32] please`)
  const path = `token: ${HEX32} then open https://x.test/${HEX32}/`
  expect(masks(path)).not.toContain(HEX32)
})

test('review 2: keyword glued to a name still gates hex (camelCase, flat, upper)', () => {
  for (const text of [`{"accessToken": "${HEX32}"}`, `const apiKey = "${HEX64}"`, `clientSecret: ${HEX32}`, `set apikey=${HEX32} in prod`, `use SECRETKEY=${HEX32} now`]) {
    expect(masks(text)).not.toContain(HEX32)
  }
  // ...but not a keyword running on into a lowercase word.
  expect(masks(`my keyboard checksum is ${HEX32}`)).toContain(HEX32)
  expect(masks(`the tokenizer hash ${HEX32}`)).toContain(HEX32)
})

test('review 2: glued sk- and eyJ keys are caught again', () => {
  for (const [text, raw] of [[`export ID_TOKEN_${JWT} done`, JWT], [`run tool --key-${PROJ} now`, PROJ], [`paste OPENAI${PROJ} here`, PROJ]] as const) {
    expect(masks(text)).not.toContain(raw)
    expect(masks(text)).not.toContain(raw.slice(-12))
  }
})

test('review 2: hex in a URL path is masked; a file path folder is not', () => {
  expect(masks(`curl https://app.example.com/api/cron/${HEX32}?token=1`)).not.toContain(HEX32)
  expect(masks(`the token cache is in /cache/${HEX32}/data`)).toContain(HEX32)
})

test('review 2: telegram token glued to an OpenAI key leaves no tail', () => {
  const tg = '1234567:' + 'Ab3'.repeat(11) + 'sk'
  const text = `${tg}-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf`
  const out = masks(text)
  expect(out.startsWith('[secret masked:')).toBe(true)
  expect(out).not.toContain('Zx9Yw8')
  expect(out).not.toContain('Ab3Ab3')
})

test('review 2: timeout or throw in .catch: refuse before next, replay masked answer after', () => {
  const answered = { text: 'masked' }
  const fresh = Object.assign(() => answered, { called: false, error: { kind: 'timeout' } })
  const replay = Object.assign(() => answered, { called: true, error: { kind: 'timeout' } })
  expect(onPromptFail({ text: 'x' } as { text: string; command?: unknown }, fresh)).toEqual({ drop: expect.stringContaining('(timeout)') })
  expect(onPromptFail({ text: 'x' } as { text: string; command?: unknown }, replay)).toBe(answered)
  expect(onPromptFail({ text: '/x', command: { name: 'x' } }, fresh)).toBe(answered)
  expect(onCommandFail({ command: 'deploy' }, fresh)).toEqual({ text: expect.stringContaining('(timeout)') })
  expect(onCommandFail({ command: 'plugin' }, fresh)).toBe(answered)
  expect(onCommandFail({ command: 'deploy' }, Object.assign(() => answered, { called: false, error: { kind: 'throw' } }))).toEqual({ text: expect.stringContaining('(throw)') })
})

test('review 2: text over MAX_SCAN is refused, never scanned or sent', async ($, on) => {
  const w = world(on)
  const r: any = await $.prompt.submit({ text: 'a '.repeat(MAX_SCAN / 2 + 1) + PAT } as never).catch((err: unknown) => ({ err: String(err) }))
  expect(w.core).toEqual([])
  expect(JSON.stringify(r)).not.toContain(PAT)
})

test('review 2: 1 MB adversarial inputs each scan + mask in under 1 s', () => {
  const M = 1_000_000
  const inputs = ['_eyJ'.repeat(M / 4), '-eyJ'.repeat(M / 4), ('_eyJ'.repeat(120) + '.' + 'B'.repeat(16000)).repeat(M / 16481),
    ('/x/' + 'a'.repeat(32)).repeat(M / 35) + ' token', ('token ' + 'b'.repeat(32) + ' ').repeat(M / 39), ('ghp_' + 'A1'.repeat(18) + '-').repeat(M / 41)]
  for (const text of inputs) {
    const t0 = Date.now()
    masks(text)
    expect(Date.now() - t0).toBeLessThan(1_000)
  }
})
