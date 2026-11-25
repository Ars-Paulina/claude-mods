#!/usr/bin/env node
'use strict'
// The mod's one disk writer (the mod's $.fs has no append or file mode). Payload comes on stdin as
// JSON, never argv, so prompt text never shows in /proc/<pid>/cmdline and big pastes never hit E2BIG.
//
//   { stateDir, maskJs, sid, t0, ops: [ {op:'log', row} | {op:'approval', rec} | {op:'state', patch} | {op:'prune', days} ] }
//
// Dirs 0700, files 0600, state via tmp+rename. Approval text is masked with the same masker the
// transcript reader uses; masker missing or throwing -> no text is written, a `blind` row is logged.

const fs = require('node:fs')
const path = require('node:path')

const APPROVAL_CAP = 4096

function dir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 })
  fs.chmodSync(p, 0o700)
  return p
}

function append(file, obj) {
  // One write call per line with O_APPEND: concurrent writers interleave whole lines.
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

function capBytes(text, max) {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= max) return text
  return buf.subarray(0, max).toString('utf8').replace(/�$/, '')
}

function loadMasker(maskJs) {
  try {
    const m = require(maskJs)
    return typeof m.maskString === 'function' ? m.maskString : null
  } catch {
    return null
  }
}

function run(p, now = Date.now()) {
  if (!p || typeof p.stateDir !== 'string' || !path.isAbsolute(p.stateDir)) throw new Error('stateDir must be absolute')
  if (typeof p.sid !== 'string' || !/^[\w-]{1,128}$/.test(p.sid)) throw new Error('bad sid')
  const root = dir(p.stateDir)
  const ts = new Date(now).toISOString()
  const ms = typeof p.t0 === 'number' ? Math.max(0, now - p.t0) : null
  const logRow = row => append(path.join(dir(path.join(root, 'log')), `${p.sid}.jsonl`), { ts: row.ts ?? ts, sid: p.sid, event: row.event, signal: row.signal, would: row.would, detail: row.detail ?? {}, ms: row.ms ?? ms })
  let masker
  for (const o of p.ops ?? []) {
    if (o.op === 'log') logRow(o.row)
    else if (o.op === 'approval') {
      if (masker === undefined) masker = p.maskJs ? loadMasker(p.maskJs) : null
      let text = null
      try {
        if (masker) text = masker(String(o.rec.exact_text)).text
      } catch {
        text = null
      }
      if (typeof text !== 'string') {
        logRow({ event: 'prompt.submit', signal: 'blind', would: 'none', detail: { reason: 'masker' } })
        continue
      }
      append(path.join(dir(path.join(root, 'approvals')), `${p.sid}.jsonl`), { message_id: o.rec.message_id, ts: o.rec.ts ?? ts, exact_text: capBytes(text, APPROVAL_CAP), scope: o.rec.scope ?? null })
    } else if (o.op === 'state') {
      const file = path.join(root, `${p.sid}.json`)
      let cur = {}
      try { cur = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first write */ }
      const next = { ...cur, ...o.patch, updated: ts }
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } else if (o.op === 'prune') {
      const adir = path.join(root, 'approvals')
      const cutoff = now - (o.days ?? 60) * 86_400_000
      for (const name of fs.existsSync(adir) ? fs.readdirSync(adir) : []) {
        const f = path.join(adir, name)
        if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f)
      }
    } else throw new Error(`unknown op ${o.op}`)
  }
}

module.exports = { run, APPROVAL_CAP }

if (require.main === module) {
  let input = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', c => { input += c })
  process.stdin.on('end', () => {
    try {
      run(JSON.parse(input))
      process.stdout.write('{"ok":true}\n')
    } catch (err) {
      process.stderr.write(`store: ${err && err.message}\n`)
      process.exitCode = 1
    }
  })
}
