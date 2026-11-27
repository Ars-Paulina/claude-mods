// Decides whether a finished reply is a stall Claude can finish itself. Pure: text in, verdict out.
//
// Fires only when ALL hold:
//   - the reply ends with an explicit offer ("say X and I'll…", "Shall I continue?") or a menu with a ← pick
//   - the reply is not a question or choice for the user, and not a step only the user can do
//   - no AskUserQuestion this turn, no risk word in the tail, fewer than MAX_CHAIN nudges in a row

const SOFT_RE = /shall i (continue|proceed)|want me to (continue|go on|proceed)|ready to (continue|proceed)\?|should i (continue|proceed)\?|reply \*\*go\*\*/i
// An offer has the whole shape "say/reply/type X and I'll…". The word alone on a 👉 You line is not one:
// "👉 You: when you're back, type X" and "it still needs your phone test reply" are steps for the user.
const SAY_RE = /\b(say|reply|type)\s+[`"*'“]{0,2}[\w ./-]{1,40}[`"*'”]{0,2}\s+(and i'?ll|to \w+|if you want)/i
const PICK_RE = /←/
const QUESTION_RE = /\breply with (a |the )?numbers?\b/i
const BLOCKED_CHOICE_RE = /blocked(?: on)?:[^\n]*\b(choice|answer|pick|decision|call|yes|mark|pedro|you|your)\b/i
const NO_REPLY_RE = /no reply needed/i
// A UI step only the user can do (mode toggle, key press, /login, a maintenance switch) is not a stall.
const OWNER_ONLY_RE = /shift\s*\+\s*tab|plan mode|\bctrl\s*\+|\besc\b|\/login\b|\.maint\b|maintenance window/i
const DONE_RE = /(no reply needed\)?:?\*{0,2}:?|👉 \*{0,2}you:?\*{0,2}:?)\s*nothing (left|until|to do|needed)/i
const RISK_RE = /🔴|money|delete|drop|merge|deploy|prod|migration|push|invoice|DGII|irreversible|secret|password/i
// "1." "2)" "- **1" "(a)" "b)", optionally behind a bullet or bold marker.
const OPTION_RE = /^\s*(?:[-*]\s+)?(?:\*\*\(?(?:\d|[a-h]\))|(?:\*\*)?(?:\d+[.)]|\(?[a-h]\)))/i

export const MAX_CHAIN = 3

export const REASON =
  'auto-proceed: the user pre-approved soft continues. Do the step you just offered (or the ← pick) yourself now. ' +
  'Never-alone items (money, production data, deletes, secrets, outbound messages, taste calls, facts only the user holds) still stop and ask. ' +
  'This approval never covers a question you asked the user, a step addressed to the user, or work the user did not ask for in this session: ' +
  'if your last reply was one of those, this is a misfire, so say so in one line and stop. Never tell the user they pre-approved it.'

function lastYouBlock(text: string): string | null {
  const i = text.lastIndexOf('👉')
  if (i < 0 || !/^👉\s*\*{0,2}you\b/i.test(text.slice(i))) return null

  return text.slice(i).split(/\n\s*\n/)[0] ?? null
}

function ownerOnlyStep(text: string): boolean {
  const block = lastYouBlock(text)

  return block !== null && OWNER_ONLY_RE.test(block)
}

// A line ending in "?" right above a ← option list is a question to the user, whatever the status light.
function questionMenu(text: string): boolean {
  const lines = text.trimEnd().split('\n').slice(-15)
  let end = -1
  for (let k = lines.length - 1; k >= 0; k--) {
    if (OPTION_RE.test(lines[k]!) && PICK_RE.test(lines[k]!)) {
      end = k
      break
    }
  }
  if (end < 0) return false
  let start = end
  while (start > 0 && OPTION_RE.test(lines[start - 1]!)) start--

  return lines
    .slice(0, start)
    .filter(l => l.trim())
    .slice(-1)
    .some(l => /\?\**\s*$/.test(l))
}

// The last 👉 You block offers a choice: a "?", an "or", a ← pick, or a list under it.
function asksChoice(text: string): boolean {
  const block = lastYouBlock(text)
  if (block === null) return false

  return (
    /\?|\bor\b|←/i.test(block) ||
    block
      .split('\n')
      .slice(1)
      .filter(l => OPTION_RE.test(l) || /^\s*[-*]\s+\*\*/.test(l)).length >= 2
  )
}

export type Verdict = { fire: boolean; why: string }

export function shouldProceed({ text, askedUser, chain }: { text: string; askedUser: boolean; chain: number }): Verdict {
  if (!text) return { fire: false, why: 'no text' }
  // The first status light decides, even behind a header.
  if (/^[^🟢🔴🟡]*🟡/u.test(text)) return { fire: false, why: 'need-you status' }
  const tail = text.slice(-600)
  if (QUESTION_RE.test(tail)) return { fire: false, why: 'question to the user' }
  if (!NO_REPLY_RE.test(tail) && (asksChoice(text) || BLOCKED_CHOICE_RE.test(tail))) return { fire: false, why: 'choice for the user' }
  if (!NO_REPLY_RE.test(tail) && questionMenu(text)) return { fire: false, why: 'question to the user' }
  if (!NO_REPLY_RE.test(tail) && ownerOnlyStep(text)) return { fire: false, why: 'step only the user can do' }
  const soft = SOFT_RE.test(tail) || SAY_RE.test(tail)
  const options = text
    .trimEnd()
    .split('\n')
    .slice(-15)
    .filter(l => OPTION_RE.test(l)).length
  const picked = options >= 2 && PICK_RE.test(tail)
  if (!soft && !picked) return { fire: false, why: 'no soft-continue' }
  if (DONE_RE.test(tail)) return { fire: false, why: 'nothing left' }
  if (options >= 2 && !picked) return { fire: false, why: 'option list' }
  if (askedUser) return { fire: false, why: 'AskUserQuestion this turn' }
  if (RISK_RE.test(tail)) return { fire: false, why: 'risk word' }
  if (chain >= MAX_CHAIN) return { fire: false, why: 'chain limit' }

  return { fire: true, why: picked ? 'recommended pick' : 'soft continue' }
}
