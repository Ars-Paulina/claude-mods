// Parity check: the old settings hook's detect() against this mod's detect() + mask(), on every
// probe from the two independent reviews. Fake secrets only, built at run time.
//
//   node --no-warnings plugins/prompt-secret-screen/scripts/parity.mjs [path/to/old/prompt-secret-screen.js]
//
// Exit 0 = for every probe the mod catches at least what the old hook caught (labels), except the
// listed, intended false-positive fixes, and no secret listed for a probe is left raw after mask().
// Needs Node 22.18+ (runs detect.ts by type stripping). The old hook runs with HOME pointed at a
// temp folder, so its log line never touches the real ~/.claude.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { detect, mask } from '../hooks/detect.ts'

const OLD = process.argv[2] ?? join(homedir(), '.claude', 'hooks', 'prompt-secret-screen.js')
if (!existsSync(OLD)) {
  console.log(`SKIP: old hook not found at ${OLD}`)
  process.exit(0)
}

const PAT = 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2)
const OPENAI = 'sk-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2'
const PROJ = 'sk-' + 'proj-' + 'Ab12Cd34Ef56Gh78Ij90Kl12'
const JWT = ['ey' + 'JhbGciOiJIUzI1NiJ9', 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.')
const HEX32 = '0123456789abcdef'.repeat(2)
const HEX64 = HEX32.repeat(2)
const PG = 'postgres://app:' + 'hunter2pw' + '@db.example.com:5432/app'
const TG = '123456789:' + 'AAH' + 'x9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf5Ed4Cb'.slice(0, 32)  // 35 chars after the colon
const SB = 'sb_secret_' + 'Ab12Cd34Ef56Gh78Ij90'
const AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP'
const STANDALONE = 'Qm9vT3Jx7Lp2Zk8Wn4Vt6Hs1'
const [JH, JP, JS] = JWT.split('.')
const LONG_JWT = [JH, JP + 'Ab9_'.repeat(5000), JS].join('.')
const LONG_SIG_JWT = [JH, JP, JS + 'Zq7-'.repeat(500)].join('.')

// [name, prompt, secrets that must not survive mask(), expectation]
// expectation: 'superset' (default) or a reason string = intended difference (old hit is a false positive).
const PROBES = [
  ['plain PAT', `deploy with ${PAT}`, [PAT]],
  ['multiline PAT + OpenAI', `a\n${PAT}\nb ${OPENAI}`, [PAT, OPENAI]],
  ['zero-width inside PAT (both miss)', `x ghp_​${PAT.slice(4)}`, []],
  ['full-width prefix (both miss)', `x ｇｈｐ_${PAT.slice(4)}`, []],
  ['NBSP-wrapped PAT', `x ${PAT} y`, [PAT]],
  ['JSON key + pg URL', `{"k":"${OPENAI}","db":"${PG}"}`, [OPENAI, PG]],
  ['JWT in code fence', '```\n' + JWT + '\n```', [JWT]],
  ['slash-command line with PAT', `/deploy --token ${PAT}`, [PAT]],
  ['URL-encoded pg (both miss)', 'postgres%3A%2F%2Fapp%3Ahunter2pw%40db', []],
  ['hex32 next to secret', `the cron secret is ${HEX32}`, [HEX32]],
  ['hex32 next to keyboard', `my keyboard checksum is ${HEX32}`, [], 'keyboard is not a secret word'],
  ['git SHA40 + token', `token commit ${'a1b2c3d4e5'.repeat(4)}`, []],
  ['UUID + token', 'token 123e4567-e89b-12d3-a456-426614174000', []],
  ['standalone high-entropy', STANDALONE, [STANDALONE]],
  ['standalone with newline', `${STANDALONE}\n`, [STANDALONE]],
  ['file name standalone (documented FP, both mask)', 'release-v2.3.1-build4567-final.tar', []],
  ['base64 PNG data URI', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', []],
  ['telegram bot', `bot ${TG}`, [TG]],
  ['supabase secret', `key ${SB}`, [SB]],
  ['AKIA inside a word', `xAKIA${'ABCDEFGHIJKLMNOP'}y`, []],
  ['AWS key id', `aws ${AKIA}`, [AKIA]],
  ['sk- in a slug', 'merge branch fix/task-queue-retry-on-failure please', [], 'task-queue is a branch name'],
  ['sk- in a file name', 'rename desk-booking-calendar-widget.tsx', [], 'desk-booking is a file name'],
  ['the-task-<30 chars> in a sentence', `rename the-task-${'abcdefghij'.repeat(3)} now`, [], 'lowercase slug, not a key'],
  ['pg pw with @ and / (both miss)', 'postgres://app:p@ss/w@db/app', []],
  ['same PAT twice', `${PAT} and ${PAT}`, [PAT]],
  ['PAT plus its prefix', `${PAT} and ${PAT.slice(0, 20)}`, [PAT]],
  ['hex path + token budget', `read /tmp/claude-1000/bundled-skills/2.1.331/${HEX32}/plugin-authoring/reference.md, check the token budget`, [], 'cache folder name in a file path'],
  ['OPENAI_API_KEY=sk-', `OPENAI_API_KEY=${OPENAI}`, [OPENAI]],
  ['Authorization Bearer jwt', `Authorization: Bearer ${JWT}`, [JWT]],
  ['#access_token=jwt', `https://app.test/cb#access_token=${JWT}`, [JWT]],
  ['second copy far from keyword', `token: ${HEX32}\n${'x'.repeat(60)}\nretry with ${HEX32} please`, [HEX32]],
  ['second copy in URL path', `token: ${HEX32} then open https://x.test/${HEX32}/`, [HEX32]],
  ['camelCase accessToken', `{"accessToken": "${HEX32}"}`, [HEX32]],
  ['camelCase apiKey hex64', `const apiKey = "${HEX64}"`, [HEX64]],
  ['clientSecret', `clientSecret: ${HEX32}`, [HEX32]],
  ['flat apikey=', `set apikey=${HEX32} in prod`, [HEX32]],
  ['upper SECRETKEY=', `use SECRETKEY=${HEX32} now`, [HEX32]],
  ['ID_TOKEN_<jwt>', `export ID_TOKEN_${JWT} done`, [JWT]],
  ['--key-<sk-proj>', `run tool --key-${PROJ} now`, [PROJ]],
  ['OPENAI<sk-proj> glued', `paste OPENAI${PROJ} here`, [PROJ]],
  ['cron hex in URL path', `curl https://app.example.com/api/cron/${HEX32}?token=1`, [HEX32]],
  ['KEY=<hex32>/ (one slash, not a path)', `KEY=${HEX32}/`, [HEX32]],
  ['token <hex32>/<hex32>', `token ${HEX32}/${HEX64.slice(0, 32).split('').reverse().join('')}`, [HEX32]],
  ['secret word inside the path token', `cd /srv/api/token/${HEX32}/x`, [HEX32]],
  ['JWT with a 20 KB payload', `Bearer ${LONG_JWT}`, [LONG_JWT, LONG_JWT.slice(-40)]],
  ['JWT with a 2 KB signature', `Bearer ${LONG_SIG_JWT} done`, [LONG_SIG_JWT.slice(-40)]],
  ['telegram glued to OpenAI key', `1234567:${'Ab3'.repeat(11)}sk-Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf`, ['Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Jh1Gf', 'Ab3'.repeat(11)]],
]

const home = mkdtempSync(join(tmpdir(), 'pss-parity-'))
function oldLabels(prompt) {
  const env = { ...process.env, HOME: home, USERPROFILE: home }
  delete env.ECOSYSTEM_SECRET_SCREEN
  const r = spawnSync(process.execPath, [OLD], { input: JSON.stringify({ prompt, session_id: 'parity' }), env, encoding: 'utf8', maxBuffer: 1 << 26 })
  if (r.status !== 0) {
    // A broken old hook must fail this check, never pass it by finding nothing.
    console.log(`FAIL old hook exited ${r.status ?? r.signal}: ${(r.stderr || '').trim().slice(0, 200)}`)
    process.exit(1)
  }
  if (!r.stdout.trim()) return []
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext
  return ctx.match(/\[([^\]]*)\]/)[1].split(', ')
}

let failed = 0
for (const [name, prompt, secrets, intended] of PROBES) {
  const old = oldLabels(prompt)
  const hits = detect(prompt)
  const mine = [...new Set(hits.map(h => h.label))]
  const out = mask(prompt, hits)
  const problems = []
  // A probe with secrets is a known positive: the old hook staying silent means it is broken or
  // not the hook this check is for (parity.mjs /dev/null), so the check fails closed.
  if (secrets.length && !old.length && !name.includes('(both miss)')) problems.push('old hook found nothing on a known positive')
  if (!intended) {
    const missing = old.filter(l => !mine.includes(l))
    if (missing.length) problems.push(`old caught [${missing}] the mod missed`)
  } else if (mine.length) {
    problems.push(`intended no-hit but mod found [${mine}]`)
  }
  const leaked = secrets.filter(s => out.includes(s))
  if (leaked.length) problems.push(`${leaked.length} secret(s) left raw after mask()`)
  const status = problems.length ? 'FAIL' : 'ok  '
  if (problems.length) failed++
  console.log(`${status} ${name.padEnd(48)} old=[${old}] mod=[${mine}]${intended ? ` (intended: ${intended})` : ''}${problems.length ? ' :: ' + problems.join('; ') : ''}`)
}
rmSync(home, { recursive: true, force: true })
console.log(`${PROBES.length - failed}/${PROBES.length} probes ok`)
process.exit(failed ? 1 : 0)
