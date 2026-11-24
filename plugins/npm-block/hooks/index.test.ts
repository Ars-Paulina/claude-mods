import { expect, test } from 'claude-code/testing'

import { rewrite } from './index'

const CWD = '/home/pedro/Projects/Cucina-Nostra/cucina-pos'
const DROPPIN = '/home/pedro/Projects/Cucina-Nostra/cucina-inventory-droppin'

test('rewrites npm command words to pnpm', async () => {
  expect(rewrite('npm i', CWD)).toBe('pnpm i')
  expect(rewrite('npm install left-pad', CWD)).toBe('pnpm install left-pad')
  expect(rewrite('cd x && npm run build', CWD)).toBe('cd x && pnpm run build')
  expect(rewrite('/usr/bin/npm i', CWD)).toBe('/usr/bin/pnpm i')
  expect(rewrite('FOO=1 npm test', CWD)).toBe('FOO=1 pnpm test')
  expect(rewrite('sudo npm i -g x', CWD)).toBe('sudo pnpm i -g x')
  expect(rewrite('echo $(npm bin)', CWD)).toBe('echo $(pnpm bin)')
  expect(rewrite('(npm run build)', CWD)).toBe('(pnpm run build)')
  expect(rewrite('npm', CWD)).toBe('pnpm')
  expect(rewrite('npm ci', CWD)).toBe('pnpm install --frozen-lockfile')
  expect(rewrite('npm i && npm test | tee out', CWD)).toBe('pnpm i && pnpm test | tee out')
})

test('leaves pnpm, npx and npm as plain text alone', async () => {
  for (const cmd of [
    'pnpm i', 'pnpm run build', 'npx vitest',
    'git commit -m "move npm to pnpm"',
    'gh pr create --title "Switch from npm to pnpm"',
    'grep -n npm package.json', "echo 'npm install'", 'ls node_modules/npm',
    'echo "a; npm i"',
  ]) expect(rewrite(cmd, CWD)).toBeUndefined()
})

test('droppin and conteo keep npm', async () => {
  expect(rewrite('npm i', DROPPIN)).toBeUndefined()
  expect(rewrite('cd ~/Projects/Cucina-Nostra/cucina-inventory-conteo && npm ci', CWD)).toBeUndefined()
})
