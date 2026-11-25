import { expect, test } from 'claude-code/testing'

import { compilePins, pinViolations } from './pins.ts'

// The two patterns shipped in data/pins.json (scripts.test.cjs checks they stay in step).
const DOT = '\\.' + 'env'
const pins = compilePins([
  { id: 'pnpm-only', text: '', command: '(^|[\\s;&|(])npm\\s' },
  { id: 'no-env-file', text: '', command: `(^|[\\s/=])${DOT}($|[\\s;&|)])`, file_path: `(^|[\\s/=])${DOT}($|[\\s;&|)])` },
])
const E = '.' + 'env'

test('[EDGE-5] no violation: pnpm i, cat <dotenv>.example, Read /x/<dotenv>.local', () => {
  expect(pinViolations(pins, 'Bash', { command: 'pnpm i' })).toEqual([])
  expect(pinViolations(pins, 'Bash', { command: `cat ${E}.example` })).toEqual([])
  expect(pinViolations(pins, 'Read', { file_path: `/x/${E}.local` })).toEqual([])
})

test('[EDGE-5] violation: npm i, cat <dotenv>, source ./<dotenv>, Read /x/<dotenv>', () => {
  expect(pinViolations(pins, 'Bash', { command: 'npm i' })).toEqual(['pnpm-only'])
  expect(pinViolations(pins, 'Bash', { command: `cat ${E}` })).toEqual(['no-env-file'])
  expect(pinViolations(pins, 'Bash', { command: `source ./${E}` })).toEqual(['no-env-file'])
  expect(pinViolations(pins, 'Read', { file_path: `/x/${E}` })).toEqual(['no-env-file'])
  expect(pinViolations(pins, 'Bash', { command: 'cd x && npm run build' })).toEqual(['pnpm-only'])
})
