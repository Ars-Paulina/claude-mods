// Credential-shape detection and masking, ported from ~/.claude/hooks/prompt-secret-screen.js.
// Same patterns, same hex context gate, same standalone high-entropy rule.

// One distinct value per label (for the log), with every place it was matched (for masking).
export type Hit = { label: string; value: string; ranges: [number, number][] }

// Strong-signal credential shapes. hex32/hex64 are context-gated below (noisy alone).
// Differences from the old hook: `sk-` and `eyJ` must not follow a word character, so
// "task-queue-..." is not an OpenAI key, and a run of "eyJeyJ..." has one start, not
// thousands (the old JWT regex was quadratic there: 300 KB took 28 s).
const PATTERNS: [string, RegExp][] = [
  ['openai_key', /(?<![A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['jwt', /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/],
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
// hex32/hex64 alone are noisy (checksums, SHAs, cache folder names). Screened only when a secret
// word stands within NEAR characters, as a whole word ("API_KEY" yes, "keyboard" no), and never
// as a path segment (a '/' right before or after it).
const KEYWORD_RE = /(?<![A-Za-z])(?:secret|token|key|cron|jwt|passwd|password|bearer)s?(?![A-Za-z])|env\s+add/i
const NEAR = 40

function isNearKeyword(text: string, start: number, end: number): boolean {
  if (text[start - 1] === '/' || text[end] === '/') return false
  return KEYWORD_RE.test(text.slice(Math.max(0, start - NEAR), end + NEAR))
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
  const scan = (list: [string, RegExp][], keep: (start: number, end: number) => boolean = () => true) => {
    for (const [label, re] of list) {
      for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
        if (keep(m.index, m.index + m[0].length)) add(label, m[0], m.index)
      }
    }
  }
  scan(PATTERNS)
  scan(HEX, (start, end) => isNearKeyword(text, start, end))
  const t = text.trim()
  if (!hits.length && isStandalone(t)) add('standalone-high-entropy', t, text.indexOf(t))
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
