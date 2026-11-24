// Keep npm in these repos (same exemption as the old npm-block.js hook).
const EXEMPT = /cucina-inventory-(droppin|conteo)/
// Command word npm: optional env assignments, sudo, a path. `npm ci` is captured so it can map to pnpm's frozen install.
const NPM = /^(\s*(?:\w+=\S*\s+)*(?:sudo\s+)?(?:\S*\/)?)npm(\s+ci)?(?=\s|$)/

// Same length as `s`, with everything inside quotes (and escaped chars) turned to 'x',
// so separators found in it are real and offsets still line up with the original.
function mask(s: string): string {
  let out = ''
  let q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (q) {
      if (c === '\\' && q === '"' && i + 1 < s.length) { out += 'xx'; i++; continue }
      out += c === q ? c : 'x'
      if (c === q) q = null
      continue
    }
    if (c === "'" || c === '"') { q = c; out += c; continue }
    if (c === '\\' && i + 1 < s.length) { out += 'xx'; i++; continue }
    out += c
  }
  return out
}

// Returns the command with every npm command word swapped for pnpm, or undefined when nothing to change.
// ponytail: swaps the command word only (and `npm ci`); flags pnpm lacks (`npm bin`) are left to fail loudly.
export function rewrite(command: string, cwd: string): string | undefined {
  if (!command || EXEMPT.test(cwd) || EXEMPT.test(command)) return undefined
  const masked = mask(command)
  const edits: { at: number; end: number; text: string }[] = []
  let at = 0
  for (const part of masked.split(/([;\n&|]|\$?\()/)) {
    const m = NPM.exec(part)
    if (m) {
      const start = at + m[1]!.length
      edits.push({ at: start, end: at + m[0].length, text: m[2] ? 'pnpm install --frozen-lockfile' : 'pnpm' })
    }
    at += part.length
  }
  if (!edits.length) return undefined
  let out = command
  for (const e of edits.reverse()) out = out.slice(0, e.at) + e.text + out.slice(e.end)

  return out
}
