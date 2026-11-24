import type { Register } from 'claude-code'
import { buildFingerprints, EMPTY_FP, maskString, type Fingerprints, type Hit } from './mask'

// Every door whose rows carry text the model reads and nobody typed. Left out: prompt, command and
// queue (the person's own typing, which prompt-secret-screen warns about) and response (the model's
// own words, built from rows already masked here).
const WITHHELD = '[MASKED: secret-mask failed on this row, content withheld]'
const NOTICE = 'secret-mask: secret value(s) in this tool output were replaced with [MASKED:…]. ' +
  'Never try to print, decode or unmask them; check secrets by length or presence only.'

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
      out.push(b) // images, documents, thinking, tool_use: not rewritable, kept as is
    }
  }
  return out
}

async function maskToolContent(c: unknown, fp: Fingerprints, hits: Hit[]): Promise<unknown> {
  const before = hits.length
  let out: unknown = c
  if (typeof c === 'string') {
    const r = await maskString(c, fp)
    hits.push(...r.hits)
    out = r.text
  } else if (Array.isArray(c)) {
    out = await maskBlocks(c as Block[], fp, hits)
  }
  if (hits.length === before) return c
  return typeof out === 'string' ? `${out}\n\n${NOTICE}` : [...(out as Block[]), { type: 'text', text: NOTICE }]
}

/** Fail-closed stand-in: every text the row carries replaced by one placeholder. */
export function withheld(e: any): any {
  const blank = (blocks: Block[]): Block[] => blocks.map((b) =>
    b.type === 'text' ? { ...b, text: WITHHELD }
      : b.type === 'tool_result' ? { ...b, content: typeof b.content === 'string' || !Array.isArray(b.content) ? WITHHELD : blank(b.content as Block[]) }
        : b)
  return { ...e, message: { ...e.message, content: blank(e.message?.content ?? []) } }
}

export const register: Register = (on) => {
  on('session.append', { door: ['tool-result', 'tool-message', 'hook-context', 'attachment', 'delivery', 'note', 'compaction', 'notice'] }, async ($, e, next) => {
    if (((await $.env.get('SECRET_MASK')) ?? 'on').toLowerCase() === 'off') return next(e)
    const fp = await fingerprints($)
    const hits: Hit[] = []
    const content = await maskBlocks(e.message.content as Block[], fp, hits)
    if (!hits.length) return next(e)
    return next({ ...e, message: { ...e.message, content } })
  }).catch(($, e, next) => (next.called ? next(e) : next(withheld(e))))
}
