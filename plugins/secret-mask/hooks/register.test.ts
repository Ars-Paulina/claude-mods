import { expect, test } from 'claude-code/testing'
import { maskString } from './mask'

// Secret-shaped strings are built at run time so no literal sits in the source.
const GH = 'ghp_' + 'a'.repeat(36)
const CANARY = 'Zq7-canary-' + 'Value_91x'
const API = 'n8nk3y-abc-' + '123456'

const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('')

async function engine(on: any, opts: { throwEnv?: boolean; fp?: boolean } = {}) {
  const fpFile = JSON.stringify({ fingerprints: [{ name: 'CANARY', sha256: await hex(CANARY), len: CANARY.length }] })
  on('env.get', (_: any, e: any) => {
    if (opts.throwEnv) throw new Error('boom')
    return { value: ({ HOME: '/h', SECRET_MASK: undefined, SECRET_MASK_FP_DIR: undefined } as any)[e.name] }
  })
  on('fs.list', () => (opts.fp ? { value: [{ name: 'T.json', kind: 'file', size: 1, mtimeMs: 1, isLink: false }] } : { value: [] }))
  on('fs.read', () => ({ value: fpFile }))
}

const text = (t: string) => ({ type: 'text', text: t })
const row = (door: string, content: unknown[], type = 'user') =>
  ({ message: { type, role: 'user', isMeta: true, content }, door, origin: { kind: 'tool', tool: 'Bash' }, uuid: crypto.randomUUID() }) as any
const dump = (r: any) => JSON.stringify(r.message.content)

test('tool-result door: string content masked, notice appended', async ($, on) => {
  await engine(on)
  const r = await $.session.append(row('tool-result', [{ type: 'tool_result', tool_use_id: 't1', content: `token ${GH} ok` }]))
  expect(dump(r)).not.toContain(GH)
  expect(dump(r)).toContain('[MASKED:github_token]')
  expect(dump(r)).toContain('Never try to print')
})

test('tool-result door: block-array content masked, image kept', async ($, on) => {
  await engine(on)
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } }
  const r = await $.session.append(row('tool-result', [{ type: 'tool_result', tool_use_id: 't1', content: [text(`N8N_API_KEY=${API}`), img] }]))
  expect(dump(r)).not.toContain(API)
  expect(dump(r)).toContain('iVBOR')
})

test('hook-context door masked', async ($, on) => {
  await engine(on)
  const r = await $.session.append(row('hook-context', [text(`ctx ${GH}`)], 'attachment'))
  expect(dump(r)).not.toContain(GH)
})

test('attachment door masked', async ($, on) => {
  await engine(on)
  const r = await $.session.append(row('attachment', [text(`file says ${GH}`)], 'attachment'))
  expect(dump(r)).not.toContain(GH)
})

test('exact layer: devrun fingerprint masks a value with no known shape', async ($, on) => {
  await engine(on, { fp: true })
  const r = await $.session.append(row('tool-result', [{ type: 'tool_result', tool_use_id: 't1', content: `value is ${CANARY} ok` }]))
  expect(dump(r)).not.toContain(CANARY)
  expect(dump(r)).toContain('[MASKED:CANARY]')
})

test('clean row passes unchanged', async ($, on) => {
  await engine(on)
  const r = await $.session.append(row('tool-result', [{ type: 'tool_result', tool_use_id: 't1', content: 'commit 3f2a9c1d0b8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a' }]))
  expect(dump(r)).toBe(JSON.stringify([{ type: 'tool_result', tool_use_id: 't1', content: 'commit 3f2a9c1d0b8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a' }]))
})

test('prompt door is left alone (person typed it)', async ($, on) => {
  await engine(on)
  const r = await $.session.append({ ...row('prompt', [text(`mine ${GH}`)]), origin: { kind: 'composer' } })
  expect(dump(r)).toContain(GH)
})

test('throw path fails closed: content withheld, secret never stored', async ($, on) => {
  await engine(on, { throwEnv: true })
  const r = await $.session.append(row('tool-result', [{ type: 'tool_result', tool_use_id: 't1', content: `token ${GH}` }]))
  expect(dump(r)).not.toContain(GH)
  expect(dump(r)).toContain('content withheld')
})

test('engine: false positives untouched, ported layers fire', async () => {
  for (const s of ['id 69809e42-4591-4c5f-85f7-07e9b56699b6', 'max_tokens=4096000', 'password: z.string().min(8),', 'const apiKey = process.env.API_KEY;'])
    expect((await maskString(s)).text).toBe(s)
  expect((await maskString(`postgres://u:${'p4ss' + 'w0rd9'}@db.host.com:5432/x`)).text).toBe('postgres://u:[MASKED:url_password]@db.host.com:5432/x')
  expect((await maskString('a'.repeat(2 * 1024 * 1024 + 1))).text.startsWith('[MASKED:')).toBe(true)
})
