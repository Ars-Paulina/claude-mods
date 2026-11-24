import { expect, test } from 'claude-code/testing'

test('Bash call reaches the tool with npm rewritten to pnpm', async ($: any, on: any) => {
  const seen: string[] = []
  on('session.cwd', () => ({ value: '/home/pedro/Projects/x' }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', { tool: 'Bash' }, (_: any, e: any) => { seen.push(e.command); return { result: 'ok' } })
  await $.tool.call({ tool: 'Bash', command: 'npm ci && echo "npm i"' })
  expect(seen).toEqual(['pnpm install --frozen-lockfile && echo "npm i"'])
})
