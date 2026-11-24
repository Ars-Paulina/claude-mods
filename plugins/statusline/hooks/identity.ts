// Project identity: same rules as the old resolve-project-color.sh, in pure functions.

// POSIX `cksum` of a string (not zlib CRC32): picks the palette colour of an unmapped project.
export function cksum(text: string): number {
  const bytes = [...new TextEncoder().encode(text)]
  let n = bytes.length
  while (n > 0) { bytes.push(n & 255); n = Math.floor(n / 256) }
  let crc = 0
  for (const b of bytes) {
    crc ^= b << 24
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1
    crc >>>= 0
  }
  return ~crc >>> 0
}

const PALETTE = ['colour129', 'colour118', 'colour45', 'colour209', 'colour228', 'colour147']

export type ColorConfig = Record<string, unknown> & { _money_roots?: string[] }
export type Identity = { key: string; fg: string; money: boolean }

// config: parsed project-colors.json (null = no config: palette only, money off)
export function resolveIdentity(key: string, root: string, config: ColorConfig | null, home: string): Identity {
  const lk = key.toLowerCase()
  const entries = Object.keys(config ?? {}).filter(k => !k.startsWith('_'))
  const hitKey = entries.find(k => k.toLowerCase() === lk)
    ?? entries.find(k => k.endsWith('*') && lk.startsWith(k.slice(0, -1).toLowerCase()))
  const hit = hitKey ? (config as ColorConfig)[hitKey] : null
  const lroot = root.toLowerCase()
  const underMoneyRoot = (config?._money_roots ?? []).some(r => {
    const abs = r.replace(/^~(?=\/|$)/, home).toLowerCase().replace(/\/+$/, '')
    return lroot === abs || lroot.startsWith(abs + '/')
  })
  const obj = hit && typeof hit === 'object' ? (hit as { fg?: string; money?: boolean }) : null
  const money = obj && 'money' in obj ? obj.money === true : underMoneyRoot
  return { key, fg: obj?.fg || PALETTE[cksum(key) % 6]!, money }
}

// tmux colour name or 256-colour index -> a colour the UI accepts (hex, or an ink name).
export function fgToColor(fg: string): string | undefined {
  const m = /^(?:colou?r)?(\d{1,3})$/.exec(fg)
  if (m) return xterm256(Number(m[1]))
  const bright = /^bright(.+)$/.exec(fg)
  return bright ? `${bright[1]}Bright` : fg || undefined
}

const BASE16 = ['#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff']

export function xterm256(i: number): string | undefined {
  if (i < 0 || i > 255) return undefined
  if (i < 16) return BASE16[i]
  const hex = (v: number) => v.toString(16).padStart(2, '0')
  if (i >= 232) { const g = 8 + (i - 232) * 10; return `#${hex(g)}${hex(g)}${hex(g)}` }
  const c = i - 16
  const level = (n: number) => (n === 0 ? 0 : 55 + n * 40)
  return `#${hex(level(Math.floor(c / 36)))}${hex(level(Math.floor(c / 6) % 6))}${hex(level(c % 6))}`
}

// Reads `.git/HEAD` for a plain repo, or follows a worktree's `.git` file (`gitdir: <path>`) to its
// own HEAD and `commondir` to the main repo. `read` returns a file's text or null.
// Walks up from `cwd` to the repo top. root = the MAIN repo's top folder (worktrees share it).
export async function gitInfo(read: (path: string) => Promise<string | null>, cwd: string):
    Promise<{ branch: string | null; root: string; top: string } | null> {
  let dir = cwd.replace(/\/+$/, '') || '/'
  for (let depth = 0; depth < 12; depth++) {
    const head = await read(`${dir}/.git/HEAD`)
    if (head !== null) return { branch: branchOf(head), root: dir, top: dir }
    const pointer = await read(`${dir}/.git`)
    const m = pointer === null ? null : /^gitdir:\s*(.+)$/m.exec(pointer)
    if (m) {
      const gitdir = abs(m[1]!.trim(), dir)
      const wtHead = await read(`${gitdir}/HEAD`)
      const common = await read(`${gitdir}/commondir`)
      const commonDir = common === null ? gitdir : abs(common.trim(), gitdir)
      return { branch: wtHead === null ? null : branchOf(wtHead), root: parent(commonDir), top: dir }
    }
    if (dir === '/') return null
    dir = parent(dir)
  }
  return null
}

function abs(p: string, base: string): string {
  const parts = (p.startsWith('/') ? p : `${base}/${p}`).split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '..') out.pop()
    else if (part && part !== '.') out.push(part)
  }
  return '/' + out.join('/')
}

function parent(p: string): string {
  return p.replace(/\/[^/]*$/, '') || '/'
}

function branchOf(head: string): string | null {
  const t = head.trim()
  if (!t) return null
  return t.startsWith('ref: refs/heads/') ? t.slice(16) : t.slice(0, 7)
}
