#!/usr/bin/env python3
"""
Rule Router — Read-scan sibling. PostToolUse/Read hook.

rule-router.py only fires on UserPromptSubmit (literal typed prompt text), so
autonomous sessions (e.g. /goal loops) that read UI-relevant .planning/*.md
files without ever typing a UI keyword get zero rules-recall injection. This
scans Read'd .planning/*.md content through the exact same scan_rules/dedup/
commit pipeline via rule-router.route(), reusing all its crash-safety and
per-session dedup guarantees instead of reimplementing them.

Escape hatch: RULE_ROUTER_READ_SCAN_MODE=off
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

MODE = os.environ.get("RULE_ROUTER_READ_SCAN_MODE", "")
SCOPE_SUFFIX = "/.planning"  # only Read calls under a .planning/ dir are scanned
SIZE_CAP = 50_000  # chars of file content scanned; skip anything larger

_spec = importlib.util.spec_from_file_location(
    "rule_router", Path(__file__).parent / "rule-router.py"
)
rule_router = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rule_router)


def _in_scope(file_path):
    if not file_path.endswith(".md"):
        return False
    p = file_path.replace("\\", "/")
    return SCOPE_SUFFIX in p


def _extract_content(tool_response):
    if isinstance(tool_response, str):
        return tool_response
    if isinstance(tool_response, dict):
        c = tool_response.get("content")
        if isinstance(c, list):
            return "\n".join(b if isinstance(b, str) else b.get("text", "") for b in c)
        if c is not None:
            return str(c)
    return ""


def main():
    if MODE == "off":
        sys.exit(0)

    input_data = json.load(sys.stdin)
    if input_data.get("tool_name") != "Read":
        sys.exit(0)

    file_path = (input_data.get("tool_input") or {}).get("file_path", "")
    if not file_path or not _in_scope(file_path):
        sys.exit(0)

    content = _extract_content(input_data.get("tool_response"))
    if not content or len(content) > SIZE_CAP:
        sys.exit(0)

    session_id = input_data.get("sessionId", "") or input_data.get("session_id", "")
    result = rule_router.route(content, session_id, "PostToolUse")
    if result is not None:
        print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[rule-router-read-scan] fatal: {e}", file=sys.stderr)
        sys.exit(0)  # fail-open: never break the Read tool pipeline
