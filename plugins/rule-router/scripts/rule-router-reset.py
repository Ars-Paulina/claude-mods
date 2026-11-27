#!/usr/bin/env python3
"""
Rule Router reset — SessionStart (matcher: compact) companion.
After compaction, prior <recall-rules> injections are gone from context, so this
session must be allowed to re-inject.

It does NOT delete the state file: it persists a NEW uuid epoch with empty
injected/deferred sets. Deleting would discard an unrecovered `pending_event`
journal (losing an audit event) and would let context-budget.cjs read
pre-compaction drops as current withholding.

Same ownership boundary as rule-router.py — it honours
CLAUDE_RULE_ROUTER_STATE_DIR, takes the identical bounded per-session lock, and
recovers any pending event before resetting. Fail-open: any error -> exit 0.
"""
import importlib.util
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path

# Shared durable primitives (lock, atomic save, journal recovery) come from the
# router so the two programs cannot drift apart. Guarded: this runs at import
# time, OUTSIDE main()'s handler, so an unguarded failure here would couple a
# broken router into a hard failure of this SessionStart hook too.
_ROUTER = Path(__file__).resolve().with_name("rule-router.py")
try:
    _spec = importlib.util.spec_from_file_location("rule_router", _ROUTER)
    rr = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(rr)
except Exception as _e:  # pragma: no cover - only reachable if the router is broken
    print(f"[rule-router-reset] cannot load {_ROUTER}: {_e} — no reset performed",
          file=sys.stderr)
    sys.exit(0)


def main():
    input_data = json.load(sys.stdin)
    session_id = input_data.get("sessionId", "") or input_data.get("session_id", "")
    if not session_id:
        sys.exit(0)

    rr.STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        lock = rr.FileLock(rr.STATE_DIR / f"{session_id}.lock").__enter__()
    except rr.LockTimeout:
        print(f"[rule-router-reset] lock timeout after {rr.LOCK_TIMEOUT_S}s — "
              f"no reset performed for {session_id}", file=sys.stderr)
        sys.exit(0)

    try:
        try:
            state = rr.load_state(session_id)
        except rr.StateCorrupt as e:
            print(f"[rule-router-reset] state corrupt, preserved for manual recovery "
                  f"({e}) — no reset performed", file=sys.stderr)
            sys.exit(0)

        rr.recover_pending_event(session_id, state)

        rr.atomic_write_json(rr.state_path(session_id), {
            "injected": [],
            "deferred": [],
            "epoch": uuid.uuid4().hex,
            "event_seq": 0,
            "last_activity": datetime.now().isoformat(),
        })
        print(f"[rule-router-reset] new epoch for {session_id}", file=sys.stderr)
    finally:
        lock.__exit__(None, None, None)
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[rule-router-reset] fatal: {e}", file=sys.stderr)
        sys.exit(0)
