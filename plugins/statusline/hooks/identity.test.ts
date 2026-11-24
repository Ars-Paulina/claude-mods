import { expect, test } from 'claude-code/testing'

import { cksum, fgToColor, gitInfo, resolveIdentity } from './identity'

const files = (map: Record<string, string>) => async (p: string): Promise<string | null> => map[p] ?? null

test('cksum matches POSIX cksum (checked against `printf shop | cksum`)', () => {
  expect(cksum('shop')).toBe(1153773587)
  expect(cksum('cucina-pos')).toBe(4275129207)
})

test('identity: exact key, then trailing-* rule, then money root, then palette', () => {
  const cfg = {
    _money_roots: ['/h/Projects/ADM'],
    'cucina-pos': { fg: 'colour40', money: true },
    'contabilidad*': { fg: 'colour196', money: true },
    quiet: { fg: 'colour45', money: false },
  }
  expect(resolveIdentity('Cucina-POS', '/h/p/Cucina-POS', cfg, '/h')).toEqual({ key: 'Cucina-POS', fg: 'colour40', money: true })
  expect(resolveIdentity('contabilidad-2025', '/x', cfg, '/h').fg).toBe('colour196')
  expect(resolveIdentity('other', '/h/Projects/ADM/other', cfg, '/h').money).toBe(true)
  expect(resolveIdentity('quiet', '/h/Projects/ADM/quiet', cfg, '/h').money).toBe(false)
  const fallback = resolveIdentity('shop', '/h/shop', cfg, '/h')
  expect(fallback.fg).toBe('colour147') // cksum('shop') % 6 = 5
})

test('256-colour index becomes hex; bright names become ink names', () => {
  expect(fgToColor('colour196')).toBe('#ff0000')
  expect(fgToColor('colour40')).toBe('#00d700')
  expect(fgToColor('231')).toBe('#ffffff')
  expect(fgToColor('brightred')).toBe('redBright')
  expect(fgToColor('green')).toBe('green')
})

test('plain repo: branch from .git/HEAD, found from a subfolder', async () => {
  const read = files({ '/p/shop/.git/HEAD': 'ref: refs/heads/feat/x\n' })
  expect(await gitInfo(read, '/p/shop/src/app')).toEqual({ branch: 'feat/x', root: '/p/shop', top: '/p/shop' })
  expect(await gitInfo(read, '/elsewhere')).toBe(null)
})

test('worktree: .git file points at the real git dir; branch from its HEAD, root = main repo', async () => {
  const read = files({
    '/p/shop.wt/.git': 'gitdir: /p/shop/.git/worktrees/wt\n',
    '/p/shop/.git/worktrees/wt/HEAD': 'ref: refs/heads/oversee/x\n',
    '/p/shop/.git/worktrees/wt/commondir': '../..\n',
  })
  expect(await gitInfo(read, '/p/shop.wt')).toEqual({ branch: 'oversee/x', root: '/p/shop', top: '/p/shop.wt' })
})

test('detached HEAD shows a short hash', async () => {
  const read = files({ '/r/.git/HEAD': '0123456789abcdef\n' })
  expect((await gitInfo(read, '/r'))!.branch).toBe('0123456')
})
