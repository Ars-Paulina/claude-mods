// FR-2 claims vs git. Git presence proves a change exists, not who made it: authorship is the
// files this session edited through its own tool calls (FR-12 input). Takes a command runner so
// the mod passes $.process.run and scripts pass child_process.

export type Runner = (argv: string[], cwd: string) => Promise<{ exitCode: number; stdout: string }>
/** The mod passes $.clock.sleep (mods have no setTimeout); scripts pass a setTimeout promise. */
export type Sleep = (ms: number) => Promise<unknown>
export type GitResult = { status: 'match' | 'missing' | 'unknown'; files: Record<string, 'match' | 'missing'>; shas: Record<string, 'match' | 'missing'>; unauthored: string[] }

export const GIT_TIMEOUT_MS = 250

async function check(run: Runner, cwd: string, files: string[], shas: string[], since: string, authored: string[], race: { lost: boolean }): Promise<GitResult> {
  // After the race is lost, stop: no more git calls in the background.
  const git = async (argv: string[]) => {
    if (race.lost) throw new Error('timed out')
    return run(argv, cwd)
  }
  const changed = new Set<string>()
  // -z: paths come raw (no quoting of spaces or non-ASCII); a rename entry is followed by its old path.
  const status = await git(['git', 'status', '--porcelain', '-z', '--untracked-files=all'])
  if (status.exitCode !== 0) throw new Error('git status failed')
  const parts = status.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    changed.add(entry.slice(3))
    if (entry[0] === 'R' || entry[0] === 'C') i++
  }
  const log = await git(['git', '-c', 'core.quotePath=false', 'log', `--since=${since}`, '--name-only', '--format='])
  for (const line of log.stdout.split('\n')) if (line.trim()) changed.add(line.trim())

  const out: GitResult = { status: 'match', files: {}, shas: {}, unauthored: [] }
  for (const f of files) {
    const hit = [...changed].some(c => c === f || c.endsWith('/' + f))
    out.files[f] = hit ? 'match' : 'missing'
    if (hit && !authored.some(a => a === f || a.endsWith('/' + f))) out.unauthored.push(f)
  }
  for (const s of shas) out.shas[s] = (await git(['git', 'cat-file', '-e', `${s}^{commit}`])).exitCode === 0 ? 'match' : 'missing'
  if ([...Object.values(out.files), ...Object.values(out.shas)].includes('missing')) out.status = 'missing'
  return out
}

/** Hard timeout: past GIT_TIMEOUT_MS (or any git error) the result is 'unknown', never a guess. */
export async function gitCheck(run: Runner, sleep: Sleep, cwd: string, claim: { files: string[]; shas: string[] }, since: string, authored: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitResult> {
  const unknown = (): GitResult => ({ status: 'unknown', files: {}, shas: {}, unauthored: [] })
  const race = { lost: false }
  return Promise.race([
    check(run, cwd, claim.files, claim.shas, since, authored, race).catch(unknown),
    sleep(timeoutMs).then(() => { race.lost = true; return unknown() }),
  ])
}
