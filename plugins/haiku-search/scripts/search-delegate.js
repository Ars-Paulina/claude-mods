#!/usr/bin/env node
/**
 * search-delegate.js — PreToolUse hook (matcher: Grep|Glob|Bash|Agent|Task)
 * Counts searches the MAIN thread runs itself during one user prompt and pushes
 * the rest to Explore (which model-router.js pins to Haiku):
 *   1-2 pass, 3-5 nudge (additionalContext), 6+ deny. Agent/Task dispatch resets.
 * Subagents (agent_id set) are never counted. Read/Edit/Write/MCP never matched.
 * SEARCH_DELEGATE_MODE=off|nudge|block (default block; nudge never denies).
 * Fail-open: any error -> exit 0, no output.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");

const STATE_DIR = path.join(os.homedir(), ".claude", "cache", "search-delegate");
const NUDGE_AT = 3;
const DENY_AT = 6;
// Bash counts when any chained step (split on ; && || newline) is a search command,
// optionally behind VAR=value prefixes. Pipe stages are not split: `ps | grep x`
// filters output, it is not a file search.
// ponytail: plain split, ignores quoting; a `;` inside a quoted arg can over-split.
const SEARCH_STEP = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(grep|rg|find|fd|ag|ack)\s/;
// A non-recursive grep/rg whose every path operand is an existing regular file is a
// targeted read of a known file, not a search.
// ponytail: whitespace split; quoted patterns with spaces or option values (-m 5)
// look like non-file paths, so those stay counted (fails toward counting).
function knownFileGrep(step, cwd) {
  const m = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(grep|rg)\s+(.*)$/.exec(step.split("|")[0]);
  if (!m) return false;
  const toks = m[2].trim().split(/\s+/);
  if (toks.some((t) => /^-[a-zA-Z]*[rR]/.test(t) || t === "--recursive")) return false;
  const operands = toks.filter((t) => !t.startsWith("-"));
  const paths = toks.some((t) => t === "-e" || t === "-f") ? operands : operands.slice(1);
  if (!paths.length) return false;
  return paths.every((p) => {
    const f = path.resolve(cwd || process.cwd(), p.replace(/^["']|["']$/g, "").replace(/^~(?=\/)/, os.homedir()));
    try { return fs.statSync(f).isFile(); } catch (_) { return false; }
  });
}
const isBashSearch = (cmd, cwd) =>
  cmd.split(/;|&&|\|\||\n/).some((step) => SEARCH_STEP.test(step) && !knownFileGrep(step, cwd));

const NUDGE =
  "3+ searches this turn. Hand remaining search to Explore (runs on Haiku). Read known files directly.";
const DENY =
  "6+ searches this turn on the main thread. Dispatch an Explore agent for the remaining search " +
  "(runs on Haiku; say \"very thorough\" for a hard one). Read still allowed for known files. " +
  "Kill switch: SEARCH_DELEGATE_MODE=nudge or off.";

function isSearch(input) {
  const t = input.tool_name;
  if (t === "Grep" || t === "Glob") return true;
  if (t === "Bash") return isBashSearch(String((input.tool_input || {}).command || ""), input.cwd);
  return false;
}

function run(input, mode) {
  if (mode === "off" || input.agent_id || !input.session_id) return null;
  const file = path.join(STATE_DIR, path.basename(String(input.session_id)) + ".json");
  let st = {};
  try { st = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
  // New prompt = fresh count. The UserPromptSubmit hook is the sure boundary;
  // a changed prompt_id (when the payload has one) is a second signal.
  const isNewPrompt = input.hook_event_name === "UserPromptSubmit";
  if (isNewPrompt || typeof st.n !== "number" || st.prompt_id !== input.prompt_id) st = { prompt_id: input.prompt_id, n: 0, after_explore: false };
  if (isNewPrompt) {
    save(file, st);
    return null;
  }

  const t = input.tool_name;
  if (t === "Agent" || t === "Task") {
    st.n = 0;
    if ((input.tool_input || {}).subagent_type === "Explore") st.after_explore = true;
    save(file, st);
    return null;
  }
  if (!isSearch(input)) return null;

  st.n += 1;
  save(file, st);
  const verdict = st.n >= DENY_AT && mode !== "nudge" ? "deny" : st.n >= NUDGE_AT ? "nudge" : "pass";

  if (verdict === "deny") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY } };
  }
  if (verdict === "nudge") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: NUDGE } };
  }
  return null;
}

function save(file, st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st));
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  try {
    const out = run(JSON.parse(raw), (process.env.SEARCH_DELEGATE_MODE || "block").toLowerCase());
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (_) { /* fail-open */ }
  process.exit(0);
});
process.stdin.on("error", () => process.exit(0));
