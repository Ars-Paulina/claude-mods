// Credential-shape detection and masking, ported from ~/.claude/hooks/prompt-secret-screen.js.
// Same credential kinds; the deliberate differences are commented at PATTERNS and KEYWORD_RE.

// One distinct value per label (for the log), with every place it was matched (for masking).
export type Hit = { label: string; value: string; ranges: [number, number][] }

// Strong-signal credential shapes. hex32/hex64 are context-gated below (noisy alone).
// Differences from the old hook, each because a false positive now rewrites the prompt:
// - openai_key: the part after `sk-` must hold a digit and an uppercase letter (isKeyLike), so
//   "task-queue-retry" and "desk-booking-widget" are not keys; real keys are random base62.
// - jwt: found by findJwts below, not by a regex here. The old regex was quadratic on runs of
//   "eyJ" (300 KB took 28 s, past the hook budget).
const PATTERNS: [string, RegExp][] = [
  ['openai_key', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['telegram_bot', /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/],
  ['google_oauth_secret', /GOCSPX-[A-Za-z0-9_-]{20,}/],
  ['supabase_secret_key', /sb_secret_[A-Za-z0-9]{16,}/],
  ['supabase_pat', /sbp_[a-f0-9]{40,}/],
  ['github_pat', /gh[posru]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{50,}/],
  ['aws_akid', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack_token', /xox[baprs]-[A-Za-z0-9-]{10,}/],
  ['pg_conn_with_pw', /postgres(?:ql)?:\/\/[^:@/\s]+:[^@/\s]{3,}@[^\s"']+/],
]
const HEX: [string, RegExp][] = [['hex64', /\b[a-f0-9]{64}\b/], ['hex32', /\b[a-f0-9]{32}\b/]]
const isKeyLike = (match: string) => {
  const body = match.replace(/^sk-(?:proj-)?/, '')
  return /\d/.test(body) && /[A-Z]/.test(body)
}

// hex32/hex64 alone are noisy (checksums, SHAs, cache folder names). Screened only when a secret
// word stands within NEAR characters, and never as a segment of a file path.
// A keyword may be glued to a name before it (accessToken, apiKey, SECRETKEY, API_KEY) but not
// run on into a lowercase word after it ("keyboard", "tokenizer", "secretary").
const KEYWORD_RE = /secret|token|key|cron|jwt|passwd|password|bearer|env\s+add/gi
const NEAR = 40

function hasKeyword(window: string): boolean {
  for (const m of window.matchAll(KEYWORD_RE)) {
    let after = m.index + m[0].length
    if (window[after] === 's') after++
    if (!/[a-z]/.test(window[after] ?? '')) return true
  }
  return false
}

// A folder name in a file path (/tmp/x/<hex>/y) is not a secret. "Token" here = the run between
// spaces or quotes. A token counts as a file path only when it looks like one: it starts with
// /, ~/, ./ or ../, or holds 2+ slashes; it is no URL (https://app/api/cron/<hex> is how cron
// secrets travel); and no secret word sits in it (KEY=<hex>/, /api/token/<hex>).
// Matches come in order, so each token is measured once (a 1 MB path stays linear).
const STOP = /[\s"'`<>()]/
function pathChecker(text: string) {
  let token = { a: -1, b: -1, isPath: false }
  return (start: number, end: number): boolean => {
    if (text[start - 1] !== '/' && text[end] !== '/') return false
    if (start < token.a || start >= token.b) {
      let a = start
      let b = end
      while (a > 0 && !STOP.test(text[a - 1]!)) a--
      while (b < text.length && !STOP.test(text[b]!)) b++
      const t = text.slice(a, b)
      const looksLikePath = /^(?:~|\.{1,2})?\//.test(t) || (t.match(/\//g)?.length ?? 0) >= 2
      token = { a, b, isPath: looksLikePath && !t.includes('://') && !hasKeyword(t) }
    }
    return token.isPath
  }
}

// JWT: header.payload.signature, each base64url, the header starting "eyJ" (base64 of '{"').
// A short fixed prefix finds a start; the match then runs to the end of its run of base64url and
// dot characters, so a long header (x5c certificate chain), payload or signature is masked whole.
// After each start the scan jumps past that run, so overlapping starts cost nothing (linear on
// any input).
const JWT_START = /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8}/g
const JWT_FULL = /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/
const JWT_CHAR = /[A-Za-z0-9_.-]/
function findJwts(text: string, add: (label: string, value: string, start: number) => void) {
  JWT_START.lastIndex = 0
  for (let m = JWT_START.exec(text); m; m = JWT_START.exec(text)) {
    let end = m.index + m[0].length
    while (end < text.length && JWT_CHAR.test(text[end]!)) end++
    const run = text.slice(m.index, end)
    if (JWT_FULL.test(run)) add('jwt', run.replace(/[.]+$/, ''), m.index)
    JWT_START.lastIndex = end
  }
}

// Shannon entropy in bits per character.
export function entropy(s: string): number {
  if (!s.length) return 0
  const freq: Record<string, number> = {}
  for (const ch of s) freq[ch] = (freq[ch] ?? 0) + 1
  let h = 0
  for (const k in freq) {
    const p = (freq[k] ?? 0) / s.length
    h -= p * Math.log2(p)
  }
  return h
}

// Whole prompt is one opaque token (a bare secret pasted alone).
function isStandalone(t: string): boolean {
  return (
    t.length >= 20 &&
    t.length <= 64 &&
    !/\s/.test(t) &&
    /^[A-Za-z0-9+/_=.-]+$/.test(t) &&
    !t.includes('/') &&
    !/^[a-f0-9]+$/i.test(t) &&
    !/^[A-Za-z]+$/.test(t) &&
    entropy(t) > 3.5
  )
}

export function detect(text: string): Hit[] {
  const hits: Hit[] = []
  const byKey = new Map<string, Hit>()
  const add = (label: string, value: string, start: number) => {
    if (!value) return
    const key = `${label}:${value}`
    let hit = byKey.get(key)
    if (!hit) {
      hit = { label, value, ranges: [] }
      byKey.set(key, hit)
      hits.push(hit)
    }
    hit.ranges.push([start, start + value.length])
  }
  const scan = (list: [string, RegExp][], keep: (start: number, end: number, value: string) => boolean = () => true) => {
    for (const [label, re] of list) {
      for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
        if (keep(m.index, m.index + m[0].length, m[0])) add(label, m[0], m.index)
      }
    }
  }
  scan(PATTERNS, (start, end, value) => !value.startsWith('sk-') || isKeyLike(value))
  findJwts(text, add)
  const isPathSegment = pathChecker(text)
  scan(HEX, (start, end) => !isPathSegment(start, end) && hasKeyword(text.slice(Math.max(0, start - NEAR), end + NEAR)))
  const t = text.trim()
  if (!hits.length && isStandalone(t)) add('standalone-high-entropy', t, text.indexOf(t))
  // Once a value is known to be a secret, every copy of it is masked, even a copy that would not
  // pass a gate alone (a hex far from its keyword, or in a path).
  for (const hit of hits) {
    const known = new Set(hit.ranges.map(([s]) => s))
    for (let i = text.indexOf(hit.value); i !== -1; i = text.indexOf(hit.value, i + 1)) {
      if (!known.has(i)) hit.ranges.push([i, i + hit.value.length])
    }
  }
  return hits
}

// Masks every matched place. Overlapping or touching ranges are merged first, so two hits that
// share characters are masked as one span and no tail of either is left showing.
export function mask(text: string, hits: Hit[]): string {
  const spans = hits
    .flatMap(h => h.ranges.map(([start, end]) => ({ start, end, label: h.label })))
    .sort((a, b) => a.start - b.start || b.end - a.end)
  const merged: { start: number; end: number; labels: string[] }[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end)
      if (!last.labels.includes(s.label)) last.labels.push(s.label)
    } else {
      merged.push({ start: s.start, end: s.end, labels: [s.label] })
    }
  }
  let out = ''
  let at = 0
  for (const m of merged) {
    out += `${text.slice(at, m.start)}[secret masked: ${m.labels.join('+')}]`
    at = m.end
  }
  return out + text.slice(at)
}
