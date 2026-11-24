// Credential-shape detection and masking, ported from ~/.claude/hooks/prompt-secret-screen.js.
// Same patterns, same hex context gate, same standalone high-entropy rule.

export type Hit = { label: string; value: string }

// Strong-signal credential shapes. hex32/hex64 are context-gated below (noisy alone).
const PATTERNS: [string, RegExp][] = [
  ['openai_key', /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/],
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
// hex32/hex64 alone are noisy (checksums, SHAs): only screened when a secret keyword sits nearby.
const CONTEXT_RE = /secret|token|key|cron|jwt|passwd|password|bearer|env\s+add/i

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
  const seen = new Set<string>()
  const add = (label: string, value: string) => {
    const key = `${label}:${value}`
    if (value && !seen.has(key)) {
      seen.add(key)
      hits.push({ label, value })
    }
  }
  const scan = (list: [string, RegExp][]) => {
    for (const [label, re] of list) for (const m of text.matchAll(new RegExp(re.source, 'g'))) add(label, m[0])
  }
  scan(PATTERNS)
  if (CONTEXT_RE.test(text)) scan(HEX)
  if (!hits.length && isStandalone(text.trim())) add('standalone-high-entropy', text.trim())
  return hits
}

// Every hit's bytes replaced by a label. Longest first, so a value that contains another is masked whole.
export function mask(text: string, hits: Hit[]): string {
  let out = text
  for (const h of [...hits].sort((a, b) => b.value.length - a.value.length)) {
    out = out.split(h.value).join(`[secret masked: ${h.label}]`)
  }
  return out
}
