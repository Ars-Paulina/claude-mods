// FR-1 done-claim detection on a reply's text. Pure: no engine access.
// A claim = a phrase from data/claim-phrases.json as whole words, not negated by a word just before
// it, in a reply that does not end in a question.

export type PhraseData = { phrases: string[]; negators: string[] }
export type Detector = { phrases: { p: string; re: RegExp }[]; negators: Set<string> }
export type Claim = { claim: boolean; phrases: string[]; files: string[]; shas: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function makeDetector(d: PhraseData): Detector {
  // Longest first, so "all tests pass" is reported over "tests pass".
  const phrases = [...d.phrases].sort((a, b) => b.length - a.length).map(p => ({ p, re: new RegExp(`(^|[^\\w'])${esc(p).replace(/ /g, '\\s+')}(?![\\w'])`, 'gi') }))
  return { phrases, negators: new Set(d.negators.map(n => n.toLowerCase())) }
}

// How many words before a phrase a negator still counts ("not all tests pass", "haven't yet pushed").
const NEG_WINDOW = 3

function negated(det: Detector, text: string, at: number): boolean {
  // Look back in the same sentence only.
  const before = text.slice(0, at).split(/[.!?\n;:]/).pop() ?? ''
  const words = before.toLowerCase().match(/[a-z']+/g) ?? []
  return words.slice(-NEG_WINDOW).some(w => det.negators.has(w))
}

// A reply that opens by reporting a blocked, waiting or in-progress state (red/yellow/hourglass
// status mark, or a lead word such as "Stop", "Blocked", "Need you") is a status report, not a
// done-claim, even when it names finished sub-steps with done-words.
const STATUS_LEAD = /^(?:🔴|🟡|⏳|(?:stop|blocked|checkpoint|needs? you|waiting|awaiting|on hold|paused)\b)/iu

export function statusReply(text: string): boolean {
  return STATUS_LEAD.test(text.replace(/^[^\p{L}\p{Extended_Pictographic}]+/u, ''))
}

// A reply that IS machine output (a JSON object or array, bare or as one fenced block, before an
// optional footer such as `⟦AB12:345⟧` or `[10:42 PM]`) is a side output: memory ops, a session
// summary, a score. Words inside its strings are data, not claims.
const FOOTER = /(?:\s*(?:⟦[^⟧]*⟧|\[\d{1,2}:\d{2}\s*[AaPp]\.?[Mm]\.?\]))+\s*$/u

export function machineOutput(text: string): boolean {
  const body = text.replace(FOOTER, '').trim()
  const json = (body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/) ?? [null, body])[1]!
  if (!/^[{[]/.test(json)) return false
  try { JSON.parse(json); return true } catch { return false }
}

// Under a yellow "need you" lead, a headline sentence that itself states finished work ("🟡 Written
// and committed. One step left is yours.") is still a claim: the lead asks for the next step, the
// headline reports the done one.
function headlineClaim(det: Detector, body: string): boolean {
  if (!/^[^\p{L}]*🟡/u.test(body)) return false
  const head = body.replace(/^[^\p{L}\p{N}]+/u, '').split(/(?<=[.!?])\s|\n/)[0]!
  return detectClaim(det, head).phrases.length > 0
}

export function detectClaim(det: Detector, text: string): Claim {
  const body = text.trim()
  const out: Claim = { claim: false, phrases: [], files: [], shas: [] }
  if (!body || /\?\s*$/.test(body) || machineOutput(body)) return out
  const taken: [number, number][] = []
  for (const { p, re } of det.phrases) {
    re.lastIndex = 0
    for (let m; (m = re.exec(body)); ) {
      const start = m.index + m[1]!.length
      const end = m.index + m[0].length
      if (taken.some(([a, b]) => start < b && end > a)) continue
      taken.push([start, end])
      if (!negated(det, body, start) && !out.phrases.includes(p)) out.phrases.push(p)
    }
  }
  out.claim = out.phrases.length > 0 && (!statusReply(body) || headlineClaim(det, body))
  out.files = [...new Set(body.match(/(?<![\w/.-])(?:[\w.-]+\/)*[\w-]+\.[A-Za-z][\w]{0,5}(?![\w/])/g) ?? [])]
    .filter(f => !/^\d+(\.\d+)+$/.test(f) && !/^(e\.g|i\.e|etc)\./i.test(f))
  out.shas = [...new Set(body.match(/\b[0-9a-f]{7,40}\b/g) ?? [])].filter(s => /\d/.test(s) && /[a-f]/.test(s))
  return out
}
