// Same level the old hook used: paplay --volume=13107 of 65536 = 20%.
export const GAIN = 0.2
export const ASSET = 'sounds/notify-tone.wav'

// $.audio.play has no player on Linux/WSL (declared in the engine types), so those hosts
// keep the old paplay route; macOS and anything else use the engine's own player.
export function route(platform: string | undefined): 'paplay' | 'audio' {
  return platform === 'linux' || platform === 'wsl' ? 'paplay' : 'audio'
}

export const paplayArgv = (file: string): string[] => [
  'paplay',
  '--property=application.name=ClaudeCodeNotify',
  `--volume=${Math.round(GAIN * 65536)}`,
  file,
]
