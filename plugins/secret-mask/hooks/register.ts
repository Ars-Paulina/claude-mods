import type { Register } from 'claude-code'
import { buildFingerprints, EMPTY_FP, maskString, type Fingerprints, type Hit } from './mask'

// Doors masked: every row the model reads that the person did not type. Left out: prompt and queue
// (the person's own typing; prompt-secret-screen only warns, see README).

const WITHHELD = '[MASKED: secret-mask failed on this row, content withheld]'
const NOTICE = 'secret-mask: secret value(s) in this tool output were replaced with [MASKED:…]. ' +
  'Never try to print, decode or unmask them; check secrets by length or presence only.'
const FAILED = 'secret-mask failed and is withholding rows; check `claude --debug`'
const DROPPED = (kind: string) => `[MASKED: a ${kind} block held a secret and was removed]`

type Block = { type: string; [k: string]: unknown }

// Fingerprint files change when bin/devrun runs, so the folder is listed per row and only a
// changed file is read again. ponytail: one $.fs.list per row, add a timer if it ever shows up.
const cache = new Map<string, { mtimeMs: number; rows: unknown }>()
let built: { key: string; fp: Fingerprints } = { key: '', fp: EMPTY_FP }

async function fingerprints($: any): Promise<Fingerprints> {
  const dir = (await $.env.get('SECRET_MASK_FP_DIR')) || `${await $.env.get('HOME')}/.cache/secret-mask`
  let entries: { name: string; kind: string; mtimeMs: number }[]
  try { entries = await $.fs.list(dir) } catch { return EMPTY_FP } // no folder: devrun never ran
  const files = entries.filter((f) => f.kind === 'file' && f.name.endsWith('.json'))
  const key = files.map((f) => `${f.name}:${f.mtimeMs}`).sort().join('|')
  if (key === built.key) return built.fp
  const all: unknown[] = []
  for (const f of files) {
    const path = `${dir}/${f.name}`
    let hit = cache.get(path)
    if (!hit || hit.mtimeMs !== f.mtimeMs) {
      // One bad file must not disable the rest, as in the hook.
      try { hit = { mtimeMs: f.mtimeMs, rows: JSON.parse(await $.fs.read(path)) } } catch { hit = { mtimeMs: f.mtimeMs, rows: null } }
      cache.set(path, hit)
    }
    all.push(hit.rows)
  }
  built = { key, fp: buildFingerprints(all) }
  return built.fp
}

const isOff = async ($: any) => ((await $.env.get('SECRET_MASK')) ?? 'on').toLowerCase() === 'off'

/** Deep copy of any JSON value with every string masked (the hook's maskDeep). Images and base64 payloads are kept. */
async function maskDeep(v: unknown, fp: Fingerprints, hits: Hit[]): Promise<unknown> {
  if (typeof v === 'string') { const r = await maskString(v, fp); hits.push(...r.hits); return r.text }
  if (Array.isArray(v)) { const out = []; for (const x of v) out.push(await maskDeep(x, fp, hits)); return out }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (o.type === 'image' || o.type === 'base64') return v // masking would destroy the bytes
    const out: Record<string, unknown> = Object.create(null) // keeps a "__proto__" key as data
    for (const [k, x] of Object.entries(o)) out[k] = await maskDeep(x, fp, hits)
    return out
  }
  return v
}

/** True when a block's text (a document's text source, a search_result's content, ...) holds a secret. */
async function holdsSecret(b: Block, fp: Fingerprints): Promise<boolean> {
  const h: Hit[] = []
  await maskDeep(b.type === 'document' ? (b.source as { type?: string; data?: unknown })?.type === 'text' ? (b.source as any).data : '' : b, fp, h)
  return h.length > 0
}

/**
 * Top-level blocks of a row. Only text and tool_result content can be rewritten: the engine pins
 * every other kind (tool_use, thinking, unknown blocks such as a top-level search_result) and puts
 * it back as raised, so those pass through (README: known gaps).
 */
async function maskBlocks(blocks: Block[], fp: Fingerprints, hits: Hit[]): Promise<Block[]> {
  const out: Block[] = []
  for (const b of blocks) {
    if (b.type === 'text' && typeof b.text === 'string') {
      const r = await maskString(b.text, fp)
      hits.push(...r.hits)
      out.push({ ...b, text: r.text })
    } else if (b.type === 'tool_result') {
      out.push({ ...b, content: await maskToolContent(b.content, fp, hits) })
    } else {
      out.push(b)
    }
  }
  return out
}

/** A tool_result's content: string, or blocks (text, image, document, search_result, ...). */
async function maskToolContent(c: unknown, fp: Fingerprints, hits: Hit[]): Promise<unknown> {
  const before = hits.length
  let out: unknown = c
  if (typeof c === 'string') {
    const r = await maskString(c, fp)
    hits.push(...r.hits)
    out = r.text
  } else if (Array.isArray(c)) {
    const arr: Block[] = []
    for (const b of c as Block[]) {
      if (b?.type === 'text' && typeof b.text === 'string') {
        const r = await maskString(b.text, fp)
        hits.push(...r.hits)
        arr.push({ ...b, text: r.text })
      } else if (b?.type !== 'image' && (await holdsSecret(b, fp))) {
        // A changed document or search_result is not kept by the engine, so swap it for a text line.
        hits.push({ label: `dropped_${b.type}` })
        arr.push({ type: 'text', text: DROPPED(b.type) })
      } else {
        arr.push(b)
      }
    }
    out = arr
  }
  if (hits.length === before) return c
  return typeof out === 'string' ? `${out}\n\n${NOTICE}` : [...(out as Block[]), { type: 'text', text: NOTICE }]
}

/** Fail-closed stand-in: every rewritable text replaced by one placeholder (pinned blocks the engine puts back anyway). */
export function withheld(e: any): any {
  const inner = (c: unknown): Block[] => !Array.isArray(c) ? [{ type: 'text', text: WITHHELD }]
    : (c as Block[]).map((b) => (b?.type === 'image' ? b : { type: 'text', text: WITHHELD }))
  const blank = (c: unknown): Block[] => !Array.isArray(c) ? [{ type: 'text', text: WITHHELD }]
    : (c as Block[]).map((b) => b?.type === 'text' ? { ...b, text: WITHHELD } : b?.type === 'tool_result' ? { ...b, content: inner(b.content) } : b)
  return { ...e, message: { ...e.message, content: blank(e.message?.content) } }
}

export const register: Register = (on) => {
  // A persistent failure blanks every row; say so once instead of failing silently.
  let warned = false

  // Transcript copy: the tool's structured record (toolUseResult) is what core stores beside the
  // tool_result, and only a tool.call answer replaces it. Core re-maps our { result } for the model.
  on('tool.call', async ($, e, next) => {
    const r: any = await next(e)
    if (!r || r.deny !== undefined || r.isError || r.result == null || (r.result as any).isImage) return r
    if (await isOff($)) return r
    const hits: Hit[] = []
    const result = await maskDeep(r.result, await fingerprints($), hits)
    if (!hits.length) return r
    return { result, context: [...(r.context ?? []), NOTICE] }
  }).catch(async ($, _e, _next) => {
    if (!warned) { warned = true; try { await $.ui.toast(FAILED) } catch { /* the withhold still stands */ } }
    return { deny: 'secret-mask failed while checking this result for secrets, so it was withheld' }
  })

  // Model copy: every stored row, including the doors tool.call never sees.
  on('session.append', { door: ['tool-result', 'tool-message', 'hook-context', 'attachment', 'delivery', 'note', 'compaction', 'notice', 'command', 'response'] }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    const fp = await fingerprints($)
    const hits: Hit[] = []
    const c: unknown = e.message.content
    let content: Block[]
    if (typeof c === 'string') {
      const r = await maskString(c, fp)
      hits.push(...r.hits)
      content = [{ type: 'text', text: r.text }]
    } else {
      content = await maskBlocks(c as Block[], fp, hits)
    }
    if (!hits.length) return next(e)
    return next({ ...e, message: { ...e.message, content } })
  }).catch(async ($, e, next) => {
    if (!warned) { warned = true; try { await $.ui.toast(FAILED) } catch { /* the withhold still stands */ } }
    return next.called ? next(e) : next(withheld(e))
  })
}
