// FR-5 pinned rules: the ones with a pattern are checked on the full Bash command string and on
// Read/Edit/Write file_path. Pure: no engine access.

export type Pin = { id: string; text: string; command?: string; file_path?: string }
export type CompiledPin = { id: string; command?: RegExp; file_path?: RegExp }

export function compilePins(rules: Pin[]): CompiledPin[] {
  return rules
    .filter(r => r.command || r.file_path)
    .map(r => ({ id: r.id, command: r.command ? new RegExp(r.command) : undefined, file_path: r.file_path ? new RegExp(r.file_path) : undefined }))
}

/** Ids of pinned rules this tool call breaks. */
export function pinViolations(pins: CompiledPin[], tool: string, input: { command?: unknown; file_path?: unknown }): string[] {
  const out: string[] = []
  for (const p of pins) {
    if (tool === 'Bash' && p.command && typeof input.command === 'string' && p.command.test(input.command)) out.push(p.id)
    else if ((tool === 'Read' || tool === 'Edit' || tool === 'Write') && p.file_path && typeof input.file_path === 'string' && p.file_path.test(input.file_path)) out.push(p.id)
  }
  return out
}
