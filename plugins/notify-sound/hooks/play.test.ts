import { expect, test } from 'claude-code/testing'

import { GAIN, paplayArgv, route } from './play'

test('route: linux and wsl use paplay, macos and unknown use the engine player', async () => {
  expect(route('linux')).toBe('paplay')
  expect(route('wsl')).toBe('paplay')
  expect(route('macos')).toBe('audio')
  expect(route(undefined)).toBe('audio')
})

test('paplayArgv keeps the old hook command: app name, 20% volume, file last', async () => {
  expect(GAIN).toBe(0.2)
  expect(paplayArgv('/p/x.wav')).toEqual(['paplay', '--property=application.name=ClaudeCodeNotify', '--volume=13107', '/p/x.wav'])
})
