import { expect, test } from 'claude-code/testing'
import { maskString } from './mask'

// Secret-shaped strings are built at run time so no literal sits in the source.
const GH = 'ghp_' + 'a'.repeat(36)
const CANARY = 'Zq7-canary-' + 'Value_91x'
const CANARY2 = 'Kp4-second-' + 'Value_33y'
const API = 'n8nk3y-abc-' + '123456'

const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')
const fpJson = async (v: string, name: string) => JSON.stringify({ fingerprints: [{ name, sha256: await hex(v), len: v.length }] })

type Opts = { throwEnv?: boolean; off?: boolean; files?: { name: string; mtimeMs: number; text: string }[]; toasts?: string[]; toolResult?: unknown; toolAnswer?: unknown }

function engine(on: any, o: Opts = {}) {
  on('env.get', (_: any, e: any) => {
    if (o.throwEnv) throw new Error('boom')
    return { value: ({ HOME: '/h', SECRET_MASK: o.off ? 'off' : undefined } as any)[e.name] }
  })
  on('fs.list', () => ({ value: (o.files ?? []).map((f) => ({ name: f.name, kind: 'file', size: 1, mtimeMs: f.mtimeMs, isLink: false })) }))
  on('fs.read', (_: any, e: any) => ({ value: (o.files ?? []).find((f) => e.path.endsWith(f.name))?.text ?? '' }))
  on('ui.toast', (_: any, e: any) => { o.toasts?.push(e.text); return { value: undefined } })
  on('tool.call', () => o.toolAnswer ?? { result: o.toolResult ?? { stdout: 'hello', stderr: '', interrupted: false, isImage: false } })
}

const text = (t: string) => ({ type: 'text', text: t })
const tr = (content: unknown) => [{ type: 'tool_result', tool_use_id: 't1', content }]
const row = (door: string, content: unknown, type = 'user') =>
  ({ message: { type, role: 'user', isMeta: true, content }, door, origin: { kind: 'tool', tool: 'Bash' }, uuid: crypto.randomUUID() }) as any
const dump = (r: any) => JSON.stringify(r.message.content)

const DOORS = ['tool-result', 'tool-message', 'hook-context', 'attachment', 'delivery', 'note', 'compaction', 'notice', 'command'] as const

test('every door masks text blocks and string content', async ($, on) => {
  engine(on)
  for (const door of DOORS) {
    const a = await $.session.append(row(door, [text(`x ${GH}`)]))
    expect(dump(a)).not.toContain(GH)
    const b = await $.session.append(row(door, `x ${GH}`))
    expect(dump(b)).not.toContain(GH)
    expect(dump(b)).toContain('[MASKED:github_token]')
  }
})

test('response door: the model echoing a secret is masked too', async ($, on) => {
  engine(on)
  const r = await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [text(`here ${GH}`)] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'r1' } as any)
  expect(dump(r)).not.toContain(GH)
})

test('tool_result: string content masked, notice appended', async ($, on) => {
  engine(on)
  const r = await $.session.append(row('tool-result', tr(`token ${GH} ok`)))
  expect(dump(r)).not.toContain(GH)
  expect(dump(r)).toContain('Never try to print')
})

test('tool_result: text blocks masked, image kept', async ($, on) => {
  engine(on)
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }
  const r = await $.session.append(row('tool-result', tr([text(`N8N_API_KEY=${API}`), img])))
  expect(dump(r)).not.toContain(API)
  expect(dump(r)).toContain('iVBOR')
})

test('tool_result: search_result with a secret becomes a text line; clean one kept', async ($, on) => {
  engine(on)
  const bad = { type: 'search_result', source: 'https://x.test', title: 't', content: [text(`found ${GH}`)] }
  const good = { type: 'search_result', source: 'https://y.test', title: 'u', content: [text('fine')] }
  const r = await $.session.append(row('tool-result', tr([bad, good])))
  expect(dump(r)).not.toContain(GH)
  expect(dump(r)).toContain('search_result block held a secret')
})

test('tool_result: document with a secret in its text source is dropped', async ($, on) => {
  engine(on)
  const doc = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: `cfg ${GH}` } }
  const r = await $.session.append(row('tool-result', tr([doc])))
  expect(dump(r)).not.toContain(GH)
  expect(dump(r)).toContain('document block held a secret')
})

test('prompt door is left alone (person typed it)', async ($, on) => {
  engine(on)
  const r = await $.session.append({ ...row('prompt', [text(`mine ${GH}`)]), origin: { kind: 'composer' } })
  expect(dump(r)).toContain(GH)
})

test('clean row passes unchanged', async ($, on) => {
  engine(on)
  const clean = tr('commit 3f2a9c1d0b8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a')
  const r = await $.session.append(row('tool-result', clean))
  expect(dump(r)).toBe(JSON.stringify(clean))
})

test('SECRET_MASK=off turns both hooks off', async ($, on) => {
  engine(on, { off: true, toolResult: { stdout: GH, stderr: '' } })
  expect(dump(await $.session.append(row('tool-result', tr(GH))))).toContain(GH)
  expect(JSON.stringify(await $.tool.call({ tool: 'Bash', command: 'x' } as any))).toContain(GH)
})

test('exact layer: fingerprint masks a value with no known shape; mtime change reloads; corrupt file ignored', async ($, on) => {
  const files = [{ name: 'A.json', mtimeMs: 1, text: await fpJson(CANARY, 'CANARY') }, { name: 'bad.json', mtimeMs: 1, text: '{not json' }]
  engine(on, { files })
  const r1 = await $.session.append(row('tool-result', tr(`v ${CANARY} ${CANARY2}`)))
  expect(dump(r1)).toContain('[MASKED:CANARY]')
  expect(dump(r1)).toContain(CANARY2)
  files[0] = { name: 'A.json', mtimeMs: 2, text: await fpJson(CANARY2, 'SECOND') }
  const r2 = await $.session.append(row('tool-result', tr(`v ${CANARY2}`)))
  expect(dump(r2)).toContain('[MASKED:SECOND]')
})

test('tool.call: structured result (transcript toolUseResult) is masked', async ($, on) => {
  engine(on, { toolResult: { stdout: `pw ${GH}`, stderr: '', interrupted: false, isImage: false } })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
  expect(JSON.stringify(r)).not.toContain(GH)
  expect(Object.keys(r.result).join()).toBe('stdout,stderr,interrupted,isImage')
})

test('tool.call: clean result relayed as is', async ($, on) => {
  engine(on)
  const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
  expect(r.result.stdout).toBe('hello')
})

test('tool.call throw path: result withheld (deny)', async ($, on) => {
  engine(on, { throwEnv: true, toolResult: { stdout: GH, stderr: '' } })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
  expect(JSON.stringify(r)).not.toContain(GH)
})

test('tool.call: errored result with a secret is answered with its masked error text', async ($, on) => {
  engine(on, { toolAnswer: { isError: true, text: `Exit code 1\nfatal ${GH}`, result: `Exit code 1\nfatal ${GH}` } })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
  expect(JSON.stringify(r)).not.toContain(GH)
  expect(r.deny).toContain('Exit code 1')
})

test('tool.call: errored result whose text is truncated still masks the secret in result (M1)', async ($, on) => {
  engine(on, { toolAnswer: { isError: true, text: 'Exit code 1 (output truncated)', result: `Exit code 1\n${GH}` } })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
  expect(JSON.stringify(r)).not.toContain(GH)
  expect(r.deny).toContain('[MASKED:github_token]')
})

test('tool.call: errored result with no text still masks result (M2)', async ($, on) => {
  engine(on, { toolAnswer: { isError: true, result: `Exit code 1\n${GH}` } })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'x' } as any)
  expect(JSON.stringify(r)).not.toContain(GH)
  expect(r.deny).toContain('Exit code 1')
})

test('tool.call: text under a base64 key is still scanned (M3)', async ($, on) => {
  engine(on, { toolResult: { result: [{ type: 'x' }, { base64: `token ${GH}` }] } })
  const r: any = await $.tool.call({ tool: 'mcp__x__y' } as any)
  expect(JSON.stringify(r)).not.toContain(GH)
})

test('tool.call: PDF base64 over 2 MB is kept whole; other strings still masked', async ($, on) => {
  const big = 'JVBERi0x' + 'A'.repeat(2 * 1024 * 1024 + 16)
  engine(on, { toolResult: { type: 'pdf', file: { filePath: '/x.pdf', base64: big, originalSize: 1, note: `cfg ${GH}` } } })
  const r: any = await $.tool.call({ tool: 'Read', file_path: '/x.pdf' } as any)
  expect(r.result.file.base64 === big).toBe(true)
  expect(r.result.file.note).not.toContain(GH)
})

test('tool.call: page base64 with a key-shaped run is not rewritten', async ($, on) => {
  const akid = 'JVBERi0x/AKIA' + 'B'.repeat(16) + '/QUJD'
  engine(on, { toolResult: { type: 'parts', file: { filePath: '/x.pdf', originalSize: 1, count: 1, outputDir: '/o', parts: [{ base64: akid, page: 1 }] } } })
  const r: any = await $.tool.call({ tool: 'Read', file_path: '/x.pdf' } as any)
  expect(r.result.file.parts[0].base64).toBe(akid)
})

test('tool.call: repeated failure denies every call, says it already ran, one toast', async ($, on) => {
  const toasts: string[] = []
  engine(on, { throwEnv: true, toasts, toolResult: { stdout: GH, stderr: '' } })
  for (let i = 0; i < 3; i++) {
    const r: any = await $.tool.call({ tool: 'Bash', command: 'git push' } as any)
    expect(JSON.stringify(r)).not.toContain(GH)
    expect(r.deny).toContain('already ran')
  }
  expect(toasts.length).toBe(1)
})

test('throw path fails closed for block and string content; one toast for many rows', async ($, on) => {
  const toasts: string[] = []
  engine(on, { throwEnv: true, toasts })
  for (const content of [tr(`token ${GH}`), `ctx ${GH}`, [text(`a ${GH}`)], tr([text(`b ${GH}`), { type: 'search_result', source: 's', title: 't', content: [text(GH)] }])]) {
    const r = await $.session.append(row('hook-context', content))
    expect(dump(r)).not.toContain(GH)
    expect(dump(r)).toContain('content withheld')
  }
  expect(toasts.length).toBe(1)
})

test('engine: false positives untouched, ported layers fire', async () => {
  for (const s of ['id 69809e42-4591-4c5f-85f7-07e9b56699b6', 'max_tokens=4096000', 'password: z.string().min(8),', 'const apiKey = process.env.API_KEY;'])
    expect((await maskString(s)).text).toBe(s)
  expect((await maskString(`postgres://u:${'p4ss' + 'w0rd9'}@db.host.com:5432/x`)).text).toBe('postgres://u:[MASKED:url_password]@db.host.com:5432/x')
  expect((await maskString('a'.repeat(2 * 1024 * 1024 + 1))).text.startsWith('[MASKED:')).toBe(true)
})
