#!/usr/bin/env node
/**
 * model-router.js — PreToolUse hook (matcher: Agent|Task)
 * Built-in subagents inherit the main model unless pinned: Explore -> haiku, Plan -> opus,
 * Bash -> sonnet. Custom agents get model_tier from ~/.claude/agents/registry.json when it exists.
 * An explicit model: on the dispatch always wins. Fail-open: any error -> no change.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const REGISTRY_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE,
  ".claude",
  "agents",
  "registry.json"
);

const BUILTIN_TYPES = new Set(["Explore", "Plan", "Bash"]);
// Built-ins otherwise inherit the main model. Plan needs the strongest reasoning,
// Explore only reads and searches, so the cheapest model is enough.
const DEFAULT_BUILTIN_MODEL = "sonnet";
const BUILTIN_FLOOR = { Plan: "opus", Explore: "haiku" };

function builtinEffort(agentType, params) {
  if (agentType !== "Explore" || params.effort) return {};
  return { effort: /very thorough/i.test(params.prompt || "") ? "high" : "medium" };
}

function emitEmpty() {
  process.stdout.write(JSON.stringify({ updatedInput: {} }));
}

function emitModel(model, params, extra) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: Object.assign({}, params, extra, { model: model }) },
  }));
}

function run(input) {
  const toolName = input.tool_name || "";
  const params = input.tool_input || {};

  if (toolName !== "Task" && toolName !== "Agent") {
    emitEmpty();
    return;
  }

  if (params.model) {
    emitEmpty();
    return;
  }

  const agentType = params.subagent_type || "";
  if (!agentType) {
    emitEmpty();
    return;
  }

  if (BUILTIN_TYPES.has(agentType)) {
    emitModel(BUILTIN_FLOOR[agentType] || DEFAULT_BUILTIN_MODEL, params, builtinEffort(agentType, params));
    return;
  }

  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));
  } catch (_) {
    emitEmpty();
    return;
  }

  const entries = registry.entries || [];
  const entry = entries.find(e => e.name === agentType);

  if (!entry || entry.disabled || !entry.model_tier) {
    emitEmpty();
    return;
  }

  emitModel(entry.model_tier, params);
}

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  try {
    const raw = chunks.join("").trim();
    if (!raw) { emitEmpty(); process.exit(0); }
    const input = JSON.parse(raw);
    run(input);
  } catch (_) {
    emitEmpty();
  }
  process.exit(0);
});
process.stdin.on("error", () => { emitEmpty(); process.exit(0); });
process.stdin.resume();
