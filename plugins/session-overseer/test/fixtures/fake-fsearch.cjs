#!/usr/bin/env node
// Stand-in for the masking transcript reader in tests: prints canned `--show` output.
// Rows come from the JSON file named by FAKE_FSEARCH_DATA: { "<sid>": [[line, role, text], ...] }.
const fs = require('node:fs')
const argv = process.argv.slice(2)
const sid = argv[argv.indexOf('--show') + 1]
const lines = argv.includes('--lines') ? argv[argv.indexOf('--lines') + 1].split('-').map(Number) : null
const data = JSON.parse(fs.readFileSync(process.env.FAKE_FSEARCH_DATA, 'utf8'))
const rows = data[sid]
if (!rows) { process.stderr.write('no such session\n'); process.exit(2) }
const shown = rows.filter(([n]) => !lines || (n >= lines[0] && n <= (lines[1] ?? lines[0])))
process.stdout.write(`/x/${sid}.jsonl  (${rows.length} lines; ${shown.length} rows shown)\n`)
for (const [n, role, text] of shown) process.stdout.write(`${String(n).padStart(6)} ${role}: ${text}\n`)
