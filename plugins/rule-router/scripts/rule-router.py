#!/usr/bin/env python3
# RULE_ROUTER_VERSION=2.0.0
"""
Rule Router — keyword-triggered rule injector.
Replaces CARL (retired 2026-06-10 -> ~/.carl/_legacy/v2-retired-2026-06-10/).

UserPromptSubmit hook. Scans ~/.claude/rules-recall/*.md (YAML frontmatter:
name, keywords, priority), word-boundary-matches keywords against the prompt,
injects matched rule bodies ONCE per session (delta-dedup via
~/.claude/cache/rule-router/{session_id}.json). Fail-open: any error -> exit 0.

v2 (plan `rule-router-silent-drop-fix`, Execution Revision 4) replaces the v1
budget path, which dropped whole files while logging them as delivered:

  * Every pending rule is classified exactly once into `delivered` / `dropped` /
    `undeliverable`. The three sets are pairwise disjoint and their union is the
    pending set — nothing is silently lost.
  * The ceiling is `len()` CHARACTERS of the FULLY RENDERED additionalContext,
    wrapper and withheld summary included (v1 summed body bytes only, so the
    wrapper and its footer were emitted outside the accounting).
  * `dropped` names go to `state["deferred"]` and sort first on the next turn,
    so the low-priority families stop starving.
  * The v2 invocation-log record carries all three arrays unsliced. `matched`
    now means DELIVERED, not MATCHED — the log's meaning changed at this commit,
    so pre-v2 rows and v2 rows are not directly comparable.

GUARANTEE BOUNDARY: `delivered`/`matched` means the router committed a whole
section as selected for emission. It does NOT mean stdout reached the hook
runner or that Claude consumed it — the hook protocol has no acknowledgement.
Claude Code's debug log is the separate delivery-confirmation surface.

SHARED-LOG CAVEAT: `invocations.jsonl` has many writers across ~/.claude, and
only rule-router.py / rule-router-reset.py take `invocations.jsonl.lock`. The
serialization below holds for router-vs-router and router-vs-reset only.
"""
import fcntl
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timedelta
from pathlib import Path

RECALL_DIR = Path(os.environ.get("GSD_RULES_RECALL_DIR") or (Path.home() / ".claude" / "rules-recall"))
# ponytail: test-isolation override only (delta-dedup state is disposable, unlike
# RECALL_DIR/CLAUDE.md which must stay real for keyword-match content to be meaningful).
# rule-router-reset.py and scripts/context-budget.cjs resolve the same root.
STATE_DIR = Path(os.environ.get("CLAUDE_RULE_ROUTER_STATE_DIR") or (Path.home() / ".claude" / "cache" / "rule-router"))
OUTPUT_CAP = 9500  # CHARACTERS of the fully rendered additionalContext (wrapper + summary included)
STALE_HOURS = 48
LOCK_TIMEOUT_S = 1.0   # never approach the registered 5s hook timeout
LOCK_SLEEP_S = 0.05
_LOG_DIR = os.environ.get("CLAUDE_LOG_DIR") or str(Path.home() / ".claude" / "logs")
INVOCATION_LOG = Path(_LOG_DIR) / "invocations.jsonl"
LOG_LOCK = Path(_LOG_DIR) / "invocations.jsonl.lock"
TAIL_WINDOW = 65536  # bytes of log tail inspected for a torn final line

WRAPPER_OPEN = '<recall-rules source="rule-router">\n'
WRAPPER_CLOSE = "\n</recall-rules>\n"

# test-only crash injection; exactly these three commit boundaries
_FAILPOINTS = ("state_saved", "log_fsynced", "journal_cleared")
FAILPOINT = os.environ.get("CLAUDE_RULE_ROUTER_FAILPOINT") or ""
LOG_FAILPOINT = os.environ.get("CLAUDE_RULE_ROUTER_LOG_FAILPOINT") or ""


class LockTimeout(Exception):
    pass


class StateCorrupt(Exception):
    pass


def _failpoint(name):
    """Hard-exit at a commit boundary so tests can prove crash recovery.
    os._exit skips finally blocks — the kernel releases the flock, exactly as a
    real kill would."""
    if FAILPOINT == name and name in _FAILPOINTS:
        sys.stderr.write(f"[rule-router] FAILPOINT {name}\n")
        sys.stderr.flush()
        os._exit(70)


# --------------------------------------------------------------------------
# durable primitives
# --------------------------------------------------------------------------
def _write_all(fd, data):
    view = memoryview(data)
    while view:
        n = os.write(fd, view)
        if n <= 0:
            raise OSError("short write")
        view = view[n:]


def atomic_write_json(path, obj):
    """Same-directory temp file -> fsync -> os.replace -> fsync(dir).
    The directory fsync is what makes this power-loss safe, not merely
    process-crash safe."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / f".{path.name}.{os.getpid()}.tmp"
    data = json.dumps(obj, indent=2).encode("utf-8")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        _write_all(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp, path)
    dfd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)


class FileLock:
    """Linux advisory lock, bounded nonblocking retry. flock is inode-scoped —
    the lock FILE is never unlinked, because deleting the pathname would let one
    session become two independently lockable inodes."""

    def __init__(self, path, timeout=LOCK_TIMEOUT_S):
        self.path = Path(path)
        self.timeout = timeout
        self.fd = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    os.close(self.fd)
                    self.fd = None
                    raise LockTimeout(str(self.path))
                time.sleep(min(LOCK_SLEEP_S, remaining))

    def __exit__(self, *exc):
        if self.fd is not None:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
                self.fd = None
        return False


def _repair_log_tail_locked():
    """Caller holds LOG_LOCK. A torn FINAL line (a crash mid-append) is
    truncated back to its line start. A malformed NON-tail line is an audit
    violation — reported loudly, never silently skipped or rewritten."""
    try:
        size = INVOCATION_LOG.stat().st_size
    except FileNotFoundError:
        return
    if size == 0:
        return
    start = max(0, size - TAIL_WINDOW)
    with INVOCATION_LOG.open("rb") as fh:
        fh.seek(start)
        window = fh.read()
    end = len(window)
    while end > 0 and window[end - 1:end] == b"\n":
        end -= 1
    if end == 0:
        return
    nl = window.rfind(b"\n", 0, end)
    if nl == -1 and start > 0:
        # No newline anywhere in the window: `start` is a position 64 KB into a
        # line we never proved is a line start. Truncating there would eat valid
        # records belonging to the ~10 other writers of this shared log.
        sys.stderr.write(
            "[rule-router] AUDIT: final line of invocations.jsonl exceeds the "
            f"{TAIL_WINDOW}B tail window — not truncating at an unproven boundary\n"
        )
        return
    line_start = nl + 1
    try:
        json.loads(window[line_start:end].decode("utf-8"))
    except Exception:
        abs_start = start + line_start
        with INVOCATION_LOG.open("r+b") as fh:
            fh.truncate(abs_start)
            fh.flush()
            os.fsync(fh.fileno())
        sys.stderr.write("[rule-router] repaired torn tail line in invocations.jsonl\n")
        return
    # tail is clean; surface (never silently skip) any malformed earlier line in the window
    for raw in window[:line_start].split(b"\n")[1:]:
        if not raw.strip():
            continue
        try:
            json.loads(raw.decode("utf-8"))
        except Exception:
            sys.stderr.write(
                "[rule-router] AUDIT: malformed non-tail line in invocations.jsonl "
                "— dropped-rule accounting is unverified until it is resolved\n"
            )
            return


def log_append(record):
    """One checked O_APPEND write of one complete UTF-8 JSON line, fsynced,
    under the shared-log lock. On error the write is truncated back to its
    starting offset so no half record survives; the caller leaves the pending
    event journalled for normal recovery."""
    INVOCATION_LOG.parent.mkdir(parents=True, exist_ok=True)
    with FileLock(LOG_LOCK):
        _repair_log_tail_locked()
        data = (json.dumps(record) + "\n").encode("utf-8")
        fd = os.open(INVOCATION_LOG, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        try:
            start = os.lseek(fd, 0, os.SEEK_END)
            try:
                if LOG_FAILPOINT == "short_write":
                    os.write(fd, data[: max(1, len(data) // 2)])
                    raise OSError("injected short write")
                _write_all(fd, data)
                os.fsync(fd)
            except Exception:
                os.ftruncate(fd, start)
                os.fsync(fd)
                raise
        finally:
            os.close(fd)


def log_has_event(event_id):
    needle = f'"{event_id}"'
    try:
        with INVOCATION_LOG.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if needle in line:
                    try:
                        if json.loads(line).get("event_id") == event_id:
                            return True
                    except Exception:
                        continue
    except FileNotFoundError:
        return False
    return False


# --------------------------------------------------------------------------
# rule corpus
# --------------------------------------------------------------------------
def parse_frontmatter(text):
    """Tiny hand-rolled YAML frontmatter parser: name, priority, keywords list."""
    meta = {"name": None, "priority": 100, "keywords": []}
    if not text.startswith("---"):
        return meta, text
    end = text.find("\n---", 3)
    if end == -1:
        return meta, text
    body = text[end + 4:].lstrip("\n")
    current_list = None
    for line in text[3:end].splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") and current_list is not None:
            current_list.append(stripped[2:].strip().strip("'\""))
            continue
        if ":" in stripped:
            key, _, val = stripped.partition(":")
            key, val = key.strip(), val.strip()
            if key == "keywords":
                if val.startswith("[") and val.endswith("]"):
                    meta["keywords"] = [
                        v.strip().strip("'\"") for v in val[1:-1].split(",") if v.strip()
                    ]
                    current_list = None
                else:
                    current_list = meta["keywords"]
            else:
                current_list = None
                if key == "name" and val:
                    meta["name"] = val.strip("'\"")
                elif key == "priority":
                    try:
                        meta["priority"] = int(val)
                    except ValueError:
                        pass
    return meta, body


def keyword_matches(prompt_lower, keyword):
    """Word-boundary match; \\b only where the keyword edge is a word char."""
    kw = keyword.lower()
    if not kw:
        return False
    pattern = re.escape(kw)
    prefix = r"\b" if (kw[:1].isalnum() or kw[:1] == "_") else ""
    suffix = r"\b" if (kw[-1:].isalnum() or kw[-1:] == "_") else ""
    return re.search(prefix + pattern + suffix, prompt_lower) is not None


def scan_rules(prompt_lower):
    matched = []  # (priority, name, body, matched_keywords)
    for rule_file in sorted(RECALL_DIR.glob("*.md")):
        try:
            meta, body = parse_frontmatter(rule_file.read_text(encoding="utf-8"))
        except Exception as e:
            # fail-open but LOUD: a silently skipped file = that rule never fires again
            print(f"[rule-router] skipped {rule_file.name}: {e}", file=sys.stderr)
            continue
        name = meta["name"] or rule_file.stem
        hits = [kw for kw in meta["keywords"] if keyword_matches(prompt_lower, kw)]
        # FACT_* triggers are single common words ("default", "next", "public"):
        # one hit is noise, two distinct hits means the topic is really on the table.
        if hits and rule_file.stem.startswith("fact-") and len(hits) < 2:
            continue
        if hits:
            matched.append((meta["priority"], name, body.strip(), hits))
    return matched


# --------------------------------------------------------------------------
# rendering + selection
# --------------------------------------------------------------------------
def render_context(sections, withheld_count):
    """The ONLY function allowed to construct the wrapper or the summary.
    Pure: same inputs -> same string. Selection sizes candidates through this,
    so nothing is ever appended to an already-selected render."""
    out = WRAPPER_OPEN + "\n\n".join(sections)
    if withheld_count:
        out += f"\n\n[rule-router] withheld: {withheld_count} rule(s); see invocation log"
    return out + WRAPPER_CLOSE


def classify(delta, prior_deferred):
    """Partition pending rules into delivered / dropped / undeliverable.

    Bounded look-ahead, never remove-last reflow: a candidate is accepted only
    if the render containing it PLUS every still-unclassified candidate counted
    as withheld fits. At the last candidate that provisional count is exact, so
    no post-selection footer append is ever needed — and an oversized first
    candidate frees its capacity for the normal sections behind it."""
    undeliverable = []
    candidates = []
    for priority, name, body, hits in delta:
        section = f"[{name}] matched: {', '.join(hits)}\n{body}"
        # undeliverable == cannot fit ALONE, wrapper only, no summary
        if len(render_context([section], 0)) > OUTPUT_CAP:
            undeliverable.append(name)
        else:
            candidates.append((priority, name, section))

    # previously deferred rules sort first — this is what ends the starvation
    candidates.sort(key=lambda c: (0 if c[1] in prior_deferred else 1, c[0], c[1]))

    selected, delivered, dropped = [], [], []
    total = len(candidates)
    for i, (_priority, name, section) in enumerate(candidates):
        unclassified_ahead = total - i - 1
        withheld = len(dropped) + len(undeliverable) + unclassified_ahead
        if len(render_context(selected + [section], withheld)) <= OUTPUT_CAP:
            selected.append(section)
            delivered.append(name)
        else:
            dropped.append(name)

    no_summary = False
    if not selected and candidates:
        # Progress fallback: two near-cap singletons cannot coexist with even the
        # bounded summary. Deliver the first in fairness order WITHOUT a summary;
        # the rest are dropped (never undeliverable) and lead the next turn.
        _priority, name, section = candidates[0]
        selected, delivered = [section], [name]
        dropped = [c[1] for c in candidates[1:]]
        no_summary = True

    withheld_count = 0 if no_summary else len(dropped) + len(undeliverable)
    return selected, delivered, dropped, undeliverable, withheld_count


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------
def state_path(session_id):
    return STATE_DIR / f"{session_id}.json"


def load_state(session_id):
    path = state_path(session_id)
    if not path.exists():
        return {"injected": [], "deferred": [], "last_activity": None}
    try:
        st = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        raise StateCorrupt(str(e))
    if not isinstance(st, dict):
        raise StateCorrupt("state file is not a JSON object")
    return st


def cleanup_stale():
    """Expire STATE only. Never unlink a `.lock`: flock is inode-scoped, so
    deleting the pathname can leave one session with two independently lockable
    inodes. Empty persistent lock files are harmless."""
    try:
        threshold = datetime.now() - timedelta(hours=STALE_HOURS)
        for f in STATE_DIR.glob("*.json"):
            if f.suffix != ".json":
                continue
            try:
                last = json.loads(f.read_text(encoding="utf-8")).get("last_activity")
                if not last or datetime.fromisoformat(last) < threshold:
                    f.unlink()
            except Exception:
                pass
    except Exception:
        pass


def recover_pending_event(session_id, state):
    """Replay a journalled event before anything else. Crash after the state
    save becomes a recoverable audit event; crash after the log fsync cannot
    duplicate it."""
    pending = state.get("pending_event")
    if not isinstance(pending, dict):
        return state
    event_id = pending.get("event_id")
    if isinstance(event_id, str) and event_id and not log_has_event(event_id):
        log_append(pending)
    cleared = {k: v for k, v in state.items() if k != "pending_event"}
    atomic_write_json(state_path(session_id), cleared)
    return cleared


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------
def commit(session_id, state, delivered, dropped, undeliverable, pending_names):
    epoch = state.get("epoch")
    if not isinstance(epoch, str) or not epoch:
        epoch = uuid.uuid4().hex
    seq = state.get("event_seq")
    if not isinstance(seq, int):
        seq = 0
    seq += 1

    prior_deferred = set(state.get("deferred", []) or [])
    new_state = {
        "injected": sorted(set(state.get("injected", []) or []) | set(delivered)),
        "deferred": sorted((prior_deferred - set(delivered) - set(undeliverable)) | set(dropped)),
        "epoch": epoch,
        "event_seq": seq,
        "last_activity": datetime.now().isoformat(),
    }

    record = {
        "ts": datetime.now().astimezone().isoformat(),
        "channel": "rule-router",
        "v": 2,
        "outcome": "complete",
        "event_id": f"{epoch}:{seq}",
        "epoch": epoch,
        "matched": list(delivered),
        "count": len(delivered),
        "dropped": list(dropped),
        "dropped_count": len(dropped),
        "undeliverable": list(undeliverable),
        "undeliverable_count": len(undeliverable),
        "session": str(session_id)[:200],
    }

    # lossless-accounting invariant, asserted before the record is durable
    m, d, u = set(delivered), set(dropped), set(undeliverable)
    if not (m.isdisjoint(d) and m.isdisjoint(u) and d.isdisjoint(u)):
        raise RuntimeError("classification sets are not pairwise disjoint")
    if m | d | u != set(pending_names):
        raise RuntimeError("classification does not conserve the pending set")

    path = state_path(session_id)
    atomic_write_json(path, dict(new_state, pending_event=record))
    _failpoint("state_saved")
    log_append(record)
    _failpoint("log_fsynced")
    atomic_write_json(path, new_state)
    _failpoint("journal_cleared")
    return record


def route(text, session_id, hook_event_name):
    """Shared match -> lock -> commit -> render pipeline. Callers (UserPromptSubmit's
    main() and PostToolUse's rule-router-read-scan.py) differ only in where `text`
    comes from and what hookEventName they must echo back. Returns the hook JSON
    dict to print, or None for every no-op path (no match, dedup delta empty,
    lock timeout, corrupt state, commit failure)."""
    if not text or not session_id or not RECALL_DIR.is_dir():
        return None

    matched = scan_rules(text.lower())
    if not matched:
        return None

    STATE_DIR.mkdir(parents=True, exist_ok=True)
    try:
        lock = FileLock(STATE_DIR / f"{session_id}.lock").__enter__()
    except LockTimeout:
        # Not a clean budget result: an unresolved router failure, logged as its
        # own narrow outcome with no delivery claim attached.
        print(f"[rule-router] lock timeout after {LOCK_TIMEOUT_S}s — no rules "
              f"delivered or withheld this turn", file=sys.stderr)
        try:
            log_append({
                "ts": datetime.now().astimezone().isoformat(),
                "channel": "rule-router",
                "v": 2,
                "outcome": "lock_timeout",
                "session": str(session_id)[:200],
                "observed_matches": [m[1] for m in matched],
            })
        except Exception as e:
            print(f"[rule-router] lock-timeout row not logged: {e}", file=sys.stderr)
        return None

    try:
        try:
            state = load_state(session_id)
        except StateCorrupt as e:
            # Never an empty-state fallback: that would silently re-inject
            # everything and overwrite the evidence.
            print(f"[rule-router] state corrupt, preserved for manual recovery "
                  f"({e}) — no context emitted", file=sys.stderr)
            return None

        state = recover_pending_event(session_id, state)

        injected = set(state.get("injected", []) or [])
        delta = [m for m in matched if m[1] not in injected]
        if not delta:
            return None  # no-op turn: no state change, no sequence number, no record

        pending_names = [m[1] for m in delta]
        sections, delivered, dropped, undeliverable, withheld = classify(
            delta, set(state.get("deferred", []) or [])
        )

        try:
            commit(session_id, state, delivered, dropped, undeliverable, pending_names)
        except (OSError, LockTimeout) as e:
            print(f"[rule-router] telemetry commit failed ({e}) — event journalled, "
                  f"no context emitted", file=sys.stderr)
            return None

        cleanup_stale()
        context = render_context(sections, withheld)
        print(
            f"[rule-router] delivered: {', '.join(delivered) or '-'}"
            f" | dropped: {', '.join(dropped) or '-'}"
            f" | undeliverable: {', '.join(undeliverable) or '-'}",
            file=sys.stderr,
        )
        return {
            "hookSpecificOutput": {
                "hookEventName": hook_event_name,
                "additionalContext": context,
            }
        }
    finally:
        lock.__exit__(None, None, None)


def main():
    input_data = json.load(sys.stdin)
    prompt = (
        input_data.get("prompt", "")
        or input_data.get("userInput", "")
        or input_data.get("message", "")
        or input_data.get("input", "")
    )
    session_id = input_data.get("sessionId", "") or input_data.get("session_id", "")
    # Match on what Pedro typed, not on harness text riding in the same field:
    # background-task results and reminders carried words like "security" or
    # "subagent" and fired rules nobody asked about (2026-11-18).
    prompt = re.sub(
        r"<(task-notification|system-reminder|agent-message)\b.*?</\1>", " ", prompt, flags=re.S
    )
    result = route(prompt, session_id, "UserPromptSubmit")
    if result is not None:
        print(json.dumps(result))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        print(f"[rule-router] fatal: {e}", file=sys.stderr)
        sys.exit(0)  # fail-open (loud): never break the prompt pipeline
