#!/usr/bin/env python3
"""Goal ledger: per-project goals and cross-project outcomes in ~/.claude/goal-ledger/.
Run `python3 goals.py --help` for the commands.
"""

import argparse
import errno
import hashlib
import json
import os
import re
import shutil
import sys
import time
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = 1
LEDGER_DIR = Path.home() / ".claude" / "goal-ledger"
LOCK_DIR = Path.home() / ".claude" / "cache"
RUN_DIR = Path.home() / ".claude" / "cache" / "goal-run"
PROJECTS_DIR = Path.home() / ".claude" / "projects"
LOCK_POLL_MS = 50
LOCK_CAP_MS = 5000
LOCK_ABANDON_MS = 3600000
PARK_AFTER_DAYS = 14
LIVE_SESSION_HOURS = 24

DASHBOARD_LOCK_NAME = "goals-dashboard.lock"
DASHBOARD_MANAGED_BY = "goals-dashboard"
SENT_BEGIN = "%%GOALS:BEGIN%%"
SENT_END = "%%GOALS:END%%"

_HELD: dict[str, str] = {}

_RACE_ERRNOS = frozenset({errno.ENOENT, errno.ENOTEMPTY, errno.EEXIST})


def _is_race(exc: OSError) -> bool:
    return exc.errno in _RACE_ERRNOS


_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _check_slug(slug: str) -> str:
    if not _SLUG_RE.fullmatch(slug):
        raise Abort(2, f"invalid slug: {slug!r}")
    return slug


class Abort(Exception):

    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


SLUG_MAX = 60
SLUG_HASH_CHARS = 8


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not slug:
        raise Abort(2, "project name produced an empty slug")
    if len(slug) <= SLUG_MAX:
        return slug
    digest = hashlib.sha256(slug.encode("utf-8")).hexdigest()[:SLUG_HASH_CHARS]
    return f"{slug[:SLUG_MAX].rstrip('-')}-{digest}"


def ledger_path(slug: str) -> Path:
    _check_slug(slug)
    return LEDGER_DIR / f"{slug}.json"


def lock_path(slug: str) -> Path:
    _check_slug(slug)
    return LOCK_DIR / f"goal-ledger-{slug}.lock"


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except (ProcessLookupError, OverflowError):
        return False
    except PermissionError:
        return True
    return True


def _new_owner_token() -> str:
    return f"{os.getpid()}-{os.urandom(4).hex()}"


def _try_grant(lock: Path) -> str | None:
    try:
        lock.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise Abort(4, f"lock directory unusable: {exc}")
    try:
        lock.mkdir()
    except FileExistsError:
        return None
    except OSError as exc:
        raise Abort(4, f"could not create lock: {exc}")
    token = _new_owner_token()
    try:
        (lock / "owner").write_text(token, encoding="utf-8")
    except OSError as exc:
        shutil.rmtree(lock, ignore_errors=True)
        raise Abort(4, f"could not claim lock: {exc}")
    return token


def _evict_if_dead(lock: Path) -> None:
    owner = lock / "owner"
    evict = False
    try:
        pid = int(owner.read_text(encoding="utf-8").strip().split("-", 1)[0])
    except (OSError, ValueError):
        pass
    else:
        evict = not _pid_alive(pid)
    if not evict:
        try:
            evict = (time.time() - lock.stat().st_mtime) * 1000 > LOCK_ABANDON_MS
        except OSError as exc:
            if _is_race(exc):
                return
            raise Abort(4, f"cannot stat lock: {exc}")
    if not evict:
        return
    grave_name = f"{lock.name}.dead-{_new_owner_token()}"
    try:
        lock.rename(lock.with_name(grave_name))
    except OSError as exc:
        if _is_race(exc):
            return
        raise Abort(4, f"cannot evict stale lock: {exc}")
    else:
        shutil.rmtree(lock.with_name(grave_name), ignore_errors=True)


@contextmanager
def _lock_at(lock: Path, key: str, label: str):
    if key in _HELD:
        raise Abort(2, f"{label}({key!r}) is not re-entrant")
    deadline = time.monotonic() + (LOCK_CAP_MS / 1000.0)
    while True:
        token = _try_grant(lock)
        if token:
            break
        _evict_if_dead(lock)
        if time.monotonic() >= deadline:
            raise Abort(3, f"lock timeout: another process holds {lock}")
        time.sleep(LOCK_POLL_MS / 1000.0)
    _HELD[key] = token
    try:
        yield
    finally:
        _HELD.pop(key, None)
        try:
            if (lock / "owner").read_text(encoding="utf-8").strip() == token:
                shutil.rmtree(lock, ignore_errors=True)
        except OSError:
            pass


@contextmanager
def ledger_lock(slug: str):
    with _lock_at(lock_path(slug), slug, "ledger_lock"):
        yield


@contextmanager
def dashboard_lock():
    with _lock_at(LOCK_DIR / DASHBOARD_LOCK_NAME, "dashboard", "dashboard_lock"):
        yield


def read_ledger(slug: str, project: str) -> dict:
    path = ledger_path(slug)
    if not path.exists():
        return {"schema": SCHEMA, "project": project, "updated": None, "goals": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise Abort(2, f"ledger unreadable ({exc}); refusing to repair it automatically")
    if not isinstance(data, dict) or "goals" not in data:
        raise Abort(2, "ledger is not a goal ledger object")
    try:
        schema = int(data.get("schema", 0))
    except (TypeError, ValueError):
        raise Abort(2, f"ledger schema is not a number: {data.get('schema')!r}")
    if schema > SCHEMA:
        raise Abort(2, f"ledger schema {schema} is newer than this script ({SCHEMA}); migrate first")
    return data


def _atomic_write(path, lock, key: str, data: dict, what: str = "ledger") -> None:
    token = _HELD.get(key)
    try:
        on_disk = (lock / "owner").read_text(encoding="utf-8").strip()
    except OSError:
        on_disk = None
    if token is None or on_disk != token:
        raise Abort(5, f"lock lost before write; {what} NOT modified")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise Abort(4, f"{what} directory unusable: {exc}")
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    try:
        try:
            tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        except (OSError, UnicodeEncodeError) as exc:
            raise Abort(4, f"{what} write failed: {exc}")
    finally:
        tmp.unlink(missing_ok=True)


def write_ledger(slug: str, data: dict) -> None:
    _atomic_write(ledger_path(slug), lock_path(slug), slug, data, what="ledger")


VALID_STATUS = {"open", "done", "dropped", "parked"}
VALID_LEVEL = {"goal", "subgoal"}
VALID_TAG = {"same", "new", "changed", "gone", "done"}

ORIGIN_EXTRACTED = "extracted"
ORIGIN_PLAN_PREFIX = "plan:"


def _origin_is_valid(value: object) -> bool:
    if not isinstance(value, str):
        return False
    if value == ORIGIN_EXTRACTED:
        return True
    return (value.startswith(ORIGIN_PLAN_PREFIX)
            and len(value) > len(ORIGIN_PLAN_PREFIX))


_NOT_LIVE = frozenset({"parked", "dropped", "done"})
_NOT_VISIBLE = frozenset({"parked", "dropped"})


def _is_live(goal: dict) -> bool:
    return goal.get("status") not in _NOT_LIVE


def _is_visible(goal: dict) -> bool:
    return goal.get("status") not in _NOT_VISIBLE


def new_goal_id(existing: list[dict]) -> str:
    taken = {goal.get("id") for goal in existing}
    seed_value = len(existing)
    while True:
        candidate = "g-%04x" % (seed_value & 0xFFFF)
        if candidate not in taken:
            return candidate
        seed_value += 1


_GOAL_STR_FIELDS = ("text", "status", "last_seen")


def _find(data: dict, goal_id: object, index: int) -> dict:
    for goal in data["goals"]:
        if goal.get("id") == goal_id:
            if any(not isinstance(goal.get(field), str) for field in _GOAL_STR_FIELDS) \
                    or not isinstance(goal.get("history"), list):
                raise Abort(2, f"decision[{index}]: ledger record for {goal_id!r} is malformed")
            return goal
    raise Abort(2, f"decision[{index}]: unknown goal id: {goal_id!r}")


def _check_ledger_shape(data: dict) -> None:
    if not isinstance(data, dict):
        raise Abort(2, "ledger is not an object")
    goals_list = data.get("goals")
    if not isinstance(goals_list, list):
        raise Abort(2, "ledger `goals` is not a list")
    for position, goal in enumerate(goals_list):
        if not isinstance(goal, dict):
            raise Abort(2, f"ledger goal[{position}] is not an object")
        if not isinstance(goal.get("id"), str):
            raise Abort(2, f"ledger goal[{position}] has a non-string id")


def _find_batch_cycle(edges: dict[int, int]) -> int | None:
    limit = len(edges) + 1
    for start in edges:
        node = start
        for _ in range(limit):
            nxt = edges.get(node)
            if nxt is None:
                break
            node = nxt
        else:
            return start
    return None


def _collapse_text(raw: str) -> str:
    return " ".join(raw.split())


def apply_decisions(data: dict, session: str, decisions: list[dict], now_iso: str) -> int:
    if not isinstance(session, str):
        raise Abort(2, "session must be a string")
    if not isinstance(now_iso, str):
        raise Abort(2, "now_iso must be a string")
    if not isinstance(decisions, list):
        raise Abort(2, "decisions is not a list")
    _check_ledger_shape(data)

    batch_ids: dict[str, int] = {}
    for i, decision in enumerate(decisions):
        if not isinstance(decision, dict) or decision.get("op") != "create":
            continue
        batch_id = decision.get("id")
        if batch_id is None:
            continue
        if not isinstance(batch_id, str) or not batch_id:
            raise Abort(2, f"decision[{i}]: create: id must be a non-empty string when present")
        if batch_id in batch_ids:
            raise Abort(2, f"decision[{i}]: create: id {batch_id!r} duplicates "
                           f"decision[{batch_ids[batch_id]}]'s id")
        if any(isinstance(g, dict) and g.get("id") == batch_id for g in data["goals"]):
            raise Abort(2, f"decision[{i}]: create: id {batch_id!r} collides with "
                           "an existing ledger goal id")
        batch_ids[batch_id] = i

    edges: dict[int, int] = {}

    staged: list[tuple] = []
    for i, decision in enumerate(decisions):
        if not isinstance(decision, dict):
            raise Abort(2, f"decision[{i}]: not an object: {decision!r}")
        op = decision.get("op")
        if op == "create":
            level = decision.get("level")
            if not isinstance(level, str) or level not in VALID_LEVEL:
                raise Abort(2, f"decision[{i}]: create: bad level {level!r}")
            parent = decision.get("parent")
            batch_parent_idx: int | None = None
            if level == "subgoal":
                if not parent:
                    raise Abort(2, f"decision[{i}]: create: subgoal requires a parent")
                if not isinstance(parent, str):
                    raise Abort(2, f"decision[{i}]: create: parent must be a string")
                if parent in batch_ids:
                    if batch_ids[parent] == i:
                        raise Abort(2, f"decision[{i}]: create: subgoal cannot "
                                       "name itself as its own parent")
                    batch_parent_idx = batch_ids[parent]
                    parent_decision = decisions[batch_parent_idx]
                    if parent_decision.get("level") != "goal":
                        raise Abort(2, f"decision[{i}]: create: subgoal's same-batch "
                                       f"parent {parent!r} is not a top-level goal "
                                       "(two levels only)")
                    edges[i] = batch_parent_idx
                else:
                    _find(data, parent, i)
            elif parent is not None:
                raise Abort(2, f"decision[{i}]: create: a goal must have parent null")
            raw_text = decision.get("text", "")
            if not isinstance(raw_text, str):
                raise Abort(2, f"decision[{i}]: create: text must be a string")
            text = _collapse_text(raw_text)
            if not text:
                raise Abort(2, f"decision[{i}]: create: empty text")
            if "origin" in decision and not _origin_is_valid(decision["origin"]):
                raise Abort(2, f"decision[{i}]: create: bad origin "
                               f"{_bounded_repr(str(decision['origin']))} (expected "
                               f"{ORIGIN_EXTRACTED!r} or {ORIGIN_PLAN_PREFIX + '<path>'!r})")
            staged.append(("create", decision, text, batch_parent_idx))
        elif op == "retext":
            goal = _find(data, decision.get("id"), i)
            raw_text = decision.get("text", "")
            if not isinstance(raw_text, str):
                raise Abort(2, f"decision[{i}]: retext: text must be a string")
            text = _collapse_text(raw_text)
            if not text:
                raise Abort(2, f"decision[{i}]: retext: empty text")
            staged.append(("retext", decision, goal, text))
        elif op == "status":
            goal = _find(data, decision.get("id"), i)
            status = decision.get("status")
            if not isinstance(status, str) or status not in VALID_STATUS:
                raise Abort(2, f"decision[{i}]: status: bad status {status!r}")
            staged.append(("status", decision, goal))
        elif op == "seen":
            goal = _find(data, decision.get("id"), i)
            staged.append(("seen", decision, goal))
        else:
            raise Abort(2, f"decision[{i}]: unknown op: {op!r}")

    cycle_idx = _find_batch_cycle(edges)
    if cycle_idx is not None:
        raise Abort(2, f"decision[{cycle_idx}]: create: same-batch parent "
                       "references form a cycle")

    assigned_ids: dict[int, str] = {}
    resolving: set[int] = set()

    def _apply_create(idx: int) -> str:
        nonlocal applied
        if idx in assigned_ids:
            return assigned_ids[idx]
        if idx in resolving:
            raise Abort(2, f"decision[{idx}]: create: internal error — same-batch "
                           "parent cycle survived validation")
        resolving.add(idx)
        _, decision, text, batch_parent_idx = staged[idx]
        if batch_parent_idx is not None:
            parent_id: str | None = _apply_create(batch_parent_idx)
        else:
            parent_id = decision.get("parent")
        new_id = new_goal_id(data["goals"])
        data["goals"].append({
            "id": new_id,
            "text": text,
            "level": decision["level"],
            "parent": parent_id,
            "status": "open",
            "owner_session": session,
            "origin": decision.get("origin", "extracted"),
            "created": now_iso,
            "last_seen": now_iso,
            "history": [],
        })
        assigned_ids[idx] = new_id
        resolving.discard(idx)
        applied += 1
        return new_id

    applied = 0
    for idx, entry in enumerate(staged):
        op = entry[0]
        if op == "create":
            _apply_create(idx)
            continue
        if op == "retext":
            decision, goal, new_text = entry[1], entry[2], entry[3]
            if new_text == goal["text"]:
                continue
            goal["history"].append({"ts": now_iso, "from": goal["text"], "to": new_text,
                                    "reason": "approved-change", "session": session})
            goal["text"] = new_text
        else:
            decision, goal = entry[1], entry[2]
            if op == "status":
                if decision["status"] == goal["status"]:
                    continue
                goal["history"].append({"ts": now_iso, "from": goal["status"],
                                        "to": decision["status"], "reason": "approved-change",
                                        "session": session})
                goal["status"] = decision["status"]
            elif op == "seen":
                if goal["last_seen"] == now_iso:
                    continue
                goal["last_seen"] = now_iso
        applied += 1
    data["updated"] = now_iso
    return applied


def _parse_iso(value: str) -> float:
    text = value[:-1] + "+00:00" if value.endswith("Z") else value
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def session_live(uuid: str, now_epoch: float) -> bool:
    if not isinstance(uuid, str) or not _SESSION_ID_RE.fullmatch(uuid):
        return False
    for candidate in PROJECTS_DIR.glob(f"*/{uuid}.jsonl"):
        try:
            age_hours = (now_epoch - candidate.stat().st_mtime) / 3600.0
        except OSError:
            continue
        if age_hours < LIVE_SESSION_HOURS:
            return True
    return False


def _owner_key(owner: object) -> str | None:
    return owner if isinstance(owner, str) else None


def autopark(data: dict, now_iso: str) -> list[str]:
    _check_ledger_shape(data)
    if not isinstance(now_iso, str):
        raise Abort(2, "now_iso must be a string")
    try:
        cutoff = _parse_iso(now_iso) - PARK_AFTER_DAYS * 86400
    except ValueError as exc:
        raise Abort(2, f"now_iso is not a valid ISO-8601 timestamp: {exc}")
    parked: list[str] = []
    for goal in data["goals"]:
        if goal.get("status") != "open":
            continue
        try:
            last_seen = _parse_iso(goal["last_seen"])
        except (KeyError, AttributeError, ValueError):
            continue
        if last_seen < cutoff:
            if isinstance(goal.get("history"), list):
                goal["history"].append({"ts": now_iso, "from": goal["status"],
                                        "to": "parked", "reason": "autopark-14d",
                                        "session": None})
            goal["status"] = "parked"
            parked.append(goal["id"])
    return parked


def cmd_load(project: str, session: str, read_only: bool = False) -> dict:
    if not isinstance(project, str) or not project:
        raise Abort(2, "project must be a non-empty string")
    if not isinstance(session, str) or not session:
        raise Abort(2, "session must be a non-empty string")
    slug = slugify(project)
    now_iso = _now_iso()
    now_epoch = time.time()
    with ledger_lock(slug):
        data = read_ledger(slug, project)
        parked = autopark(data, now_iso)
        if parked and not read_only:
            data["updated"] = now_iso
            write_ledger(slug, data)
    by_id = {g.get("id"): g for g in data["goals"] if isinstance(g, dict)}
    def _named(ids: list[str]) -> list[dict]:
        return [{"id": i,
                 "text": _render_line(by_id.get(i, {}).get("text", "(untitled goal)"))}
                for i in ids]

    parked_now = [] if read_only else _named(parked)
    would_park = _named(parked) if read_only else []
    live = [g for g in data["goals"] if _is_live(g)]
    owned = [g for g in live if g.get("owner_session") == session]
    completed = [g for g in data["goals"]
                 if g.get("owner_session") == session and g.get("status") == "done"]
    unowned_by_us = [g for g in live if g.get("owner_session") != session]
    live_by_owner: dict = {}
    for g in unowned_by_us:
        key = _owner_key(g.get("owner_session"))
        if key not in live_by_owner:
            live_by_owner[key] = session_live(g.get("owner_session"), now_epoch)
    claimable = [g for g in unowned_by_us
                 if not live_by_owner[_owner_key(g.get("owner_session"))]]
    others = len(unowned_by_us) - len(claimable)
    return {"schema": SCHEMA, "project": project, "slug": slug,
            "owned": owned, "completed": completed, "claimable": claimable,
            "others": others, "parked_now": parked_now, "would_park": would_park}


MAX_GOALS = 6
MAX_SUBGOALS = 12
MAX_PROPOSALS = MAX_GOALS + MAX_SUBGOALS
MAX_TEXT_LENGTH = 200_000
MAX_VALUE_LENGTH = 2000
MAX_JSON_DEPTH = 20
MAX_JSON_ARRAY_LENGTH = 1000

_OPEN_MARKER = "<<<GOAL_EXTRACTION>>>"
_END_MARKER = "<<<END>>>"
_CODE_FENCE_OPEN_RE = re.compile(r"^```[^\n]*\n")

_FIELD_NAMES = ("id", "level", "parent", "tag", "was", "text", "evidence", "origin")
_KNOWN_FIELDS = frozenset(_FIELD_NAMES)
_NULLABLE_FIELDS = frozenset({"parent", "was"})

_TOP_LEVEL_KNOWN_FIELDS = frozenset({"proposed"})

_BIDI_CONTROL_CHARS = frozenset(
    "‪‫‬‭‮"
    "⁦⁧⁨⁩"
    "‎‏؜"
)
_MAX_COMBINING_MARKS = 4
_ABORT_PREVIEW_CHARS = 120


def _has_disallowed_display_chars(value: str) -> bool:
    combining_run = 0
    for ch in value:
        if ch in _BIDI_CONTROL_CHARS:
            return True
        category = unicodedata.category(ch)
        if category in ("Cc", "Cs") and ch != "\t":
            return True
        if category in ("Mn", "Me"):
            combining_run += 1
            if combining_run > _MAX_COMBINING_MARKS:
                return True
        else:
            combining_run = 0
    return False


def _bounded_repr(text: str) -> str:
    shown = repr(text)
    if len(shown) > _ABORT_PREVIEW_CHARS:
        shown = shown[:_ABORT_PREVIEW_CHARS] + "...'"
    return shown


def _find_fence_close(body: str) -> int:
    in_string = False
    escaped = False
    i, n = 0, len(body)
    while i < n:
        ch = body[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            i += 1
            continue
        if ch == '"':
            in_string = True
        elif ch == "`" and body[i:i + 3] == "```":
            return i
        i += 1
    return -1


def _strip_code_fence(payload: str) -> str:
    stripped = payload.strip()
    open_match = _CODE_FENCE_OPEN_RE.match(stripped)
    if not open_match:
        return stripped
    body = stripped[open_match.end():]
    close_idx = _find_fence_close(body)
    if close_idx == -1:
        return stripped
    return body[:close_idx].strip()


class _DuplicateKeyTracker:

    def __init__(self) -> None:
        self.calls = 0
        self.found: tuple[int, str] | None = None

    def __call__(self, pairs: list[tuple[str, object]]) -> dict:
        index = self.calls
        self.calls += 1
        seen: dict = {}
        for key, value in pairs:
            if key in seen and self.found is None:
                self.found = (index, key)
            seen[key] = value
        return seen


def _check_json_depth(payload: str) -> None:
    depth = 0
    in_string = False
    escaped = False
    for ch in payload:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            depth += 1
            if depth > MAX_JSON_DEPTH:
                raise Abort(2, f"goal-extractor JSON nesting exceeds the maximum depth ({MAX_JSON_DEPTH})")
        elif ch in "}]":
            depth -= 1


def _check_json_bounds(value: object, path: str = "") -> None:
    if isinstance(value, list):
        if len(value) > MAX_JSON_ARRAY_LENGTH:
            where = f" at {path}" if path else ""
            raise Abort(2, f"goal-extractor JSON array exceeds the maximum length "
                           f"({MAX_JSON_ARRAY_LENGTH}){where}")
        for i, item in enumerate(value):
            _check_json_bounds(item, f"{path}[{i}]")
    elif isinstance(value, dict):
        for k, v in value.items():
            _check_json_bounds(v, f"{path}.{k}" if path else str(k))


def _validate_proposal(raw: dict, index: int) -> dict:
    for key in raw:
        if key not in _KNOWN_FIELDS:
            raise Abort(2, f"proposed[{index}] has an unrecognized field: {_bounded_repr(_render_line(key))}")
    for key in _FIELD_NAMES:
        if key not in raw:
            raise Abort(2, f"proposed[{index}] is missing a required field: {key!r} "
                           "(every field must be present explicitly; use `null` for "
                           "`parent`/`was` when they do not apply)")

    item: dict = {}
    for key in _FIELD_NAMES:
        value = raw[key]
        nullable = key in _NULLABLE_FIELDS
        if value is None:
            if not nullable:
                raise Abort(2, f"proposed[{index}].{key} must be a string, got null")
            item[key] = None
            continue
        if not isinstance(value, str):
            raise Abort(2, f"proposed[{index}].{key} must be a string"
                           f"{' or null' if nullable else ''}, got {type(value).__name__}")
        if len(value) > MAX_VALUE_LENGTH:
            raise Abort(2, f"proposed[{index}].{key} exceeds the maximum length ({MAX_VALUE_LENGTH} chars)")
        if _has_disallowed_display_chars(value):
            raise Abort(2, f"proposed[{index}].{key} contains a disallowed "
                           "control or display-override character")
        item[key] = value

    for key in ("id", "text", "level", "tag", "origin"):
        if not item[key]:
            raise Abort(2, f"proposed[{index}].{key} must not be empty")
    if not _origin_is_valid(item["origin"]):
        raise Abort(2, f"proposed[{index}] has an invalid origin "
                       f"(expected {ORIGIN_EXTRACTED!r} or "
                       f"{ORIGIN_PLAN_PREFIX + '<path>'!r}): {_bounded_repr(item['origin'])}")
    if item["tag"] not in VALID_TAG:
        raise Abort(2, f"proposed[{index}] has an invalid tag: {_bounded_repr(item['tag'])}")
    if item["level"] not in VALID_LEVEL:
        raise Abort(2, f"proposed[{index}] has an invalid level: {_bounded_repr(item['level'])}")
    if item["tag"] == "changed" and not item["was"]:
        raise Abort(2, f"proposed[{index}] tagged `changed` requires `was`: {_bounded_repr(item['id'])}")
    if item["level"] == "subgoal" and not item["parent"]:
        raise Abort(2, f"proposed[{index}] subgoal requires a parent: {_bounded_repr(item['text'])}")
    return item


def parse_extraction(text: str) -> list[dict]:
    if not isinstance(text, str):
        raise Abort(2, "goal-extractor output must be a string")
    if len(text) > MAX_TEXT_LENGTH:
        raise Abort(2, f"goal-extractor output exceeds the maximum length ({MAX_TEXT_LENGTH} chars)")

    open_idx = text.find(_OPEN_MARKER)
    end_idx = text.rfind(_END_MARKER)
    if open_idx == -1 or end_idx == -1:
        raise Abort(2, "goal-extractor returned no <<<GOAL_EXTRACTION>>> block")
    if end_idx < open_idx + len(_OPEN_MARKER):
        raise Abort(2, "goal-extractor markers are out of order "
                       "(<<<END>>> appears before <<<GOAL_EXTRACTION>>>)")
    block_content = text[open_idx + len(_OPEN_MARKER):end_idx]
    payload_text = _strip_code_fence(block_content)

    _check_json_depth(payload_text)
    dup_tracker = _DuplicateKeyTracker()
    try:
        payload = json.loads(payload_text, object_pairs_hook=dup_tracker)
    except json.JSONDecodeError as exc:
        if payload_text.startswith("```"):
            raise Abort(2, "goal-extractor block looks like it starts with a markdown "
                           "code fence that never closes, or doesn't wrap valid JSON "
                           "once stripped — check for a missing closing ``` or malformed "
                           "JSON inside the fence") from None
        raise Abort(2, f"goal-extractor block is not valid JSON: {exc}") from None

    if dup_tracker.found is not None:
        index, key = dup_tracker.found
        locator = "top-level object" if index == dup_tracker.calls - 1 else f"proposed[{index}]"
        raise Abort(2, f"goal-extractor JSON has a duplicate key in {locator}: {_bounded_repr(_render_line(key))}")

    if not isinstance(payload, dict):
        raise Abort(2, "goal-extractor JSON payload is not an object")
    for key in payload:
        if key not in _TOP_LEVEL_KNOWN_FIELDS:
            raise Abort(2, f"goal-extractor JSON payload has an unrecognized "
                           f"top-level field: {_bounded_repr(_render_line(key))}")

    _check_json_bounds(payload)

    proposed = payload.get("proposed")
    if not isinstance(proposed, list):
        raise Abort(2, "goal-extractor JSON payload has no `proposed` list")
    if len(proposed) > MAX_PROPOSALS:
        raise Abort(2, f"goal-extractor block proposes too many proposals (cap {MAX_PROPOSALS})")

    items: list[dict] = []
    for i, raw_item in enumerate(proposed):
        if not isinstance(raw_item, dict):
            raise Abort(2, f"proposed[{i}] is not an object")
        items.append(_validate_proposal(raw_item, i))
    if not items:
        raise Abort(2, "goal-extractor block contained no proposals")

    seen_ids: dict[str, int] = {}
    for i, item in enumerate(items):
        if item["id"] in seen_ids:
            raise Abort(2, f"proposed[{i}]: id {_bounded_repr(item['id'])} already "
                           f"used by proposed[{seen_ids[item['id']]}]")
        seen_ids[item["id"]] = i

    goal_count = sum(1 for item in items if item["level"] == "goal")
    subgoal_count = sum(1 for item in items if item["level"] == "subgoal")
    if goal_count > MAX_GOALS:
        raise Abort(2, f"goal-extractor block proposes too many top-level goals "
                       f"({goal_count} > {MAX_GOALS})")
    if subgoal_count > MAX_SUBGOALS:
        raise Abort(2, f"goal-extractor block proposes too many sub-goals "
                       f"({subgoal_count} > {MAX_SUBGOALS})")
    return items


_WHITESPACE_RUN_RE = re.compile(r"\s+")


def _render_line(value: object) -> str:
    text = str(value)
    kept = []
    combining_run = 0
    for ch in text:
        if ch in _BIDI_CONTROL_CHARS:
            continue
        category = unicodedata.category(ch)
        if category in ("Cc", "Cs") and not ch.isspace():
            continue
        if category in ("Mn", "Me"):
            combining_run += 1
            if combining_run > _MAX_COMBINING_MARKS:
                continue
        else:
            combining_run = 0
        kept.append(ch)
    return _WHITESPACE_RUN_RE.sub(" ", "".join(kept)).strip()


def render_markdown(data: dict) -> str:
    _check_ledger_shape(data)
    lines = [f"# Goals — {_render_line(data.get('project', 'unknown'))}", ""]
    live = [g for g in data["goals"] if _is_visible(g)]
    tops = [g for g in live if g.get("level") == "goal"]
    claimed: set = set()
    any_inferred = False
    for goal in tops:
        box = "x" if goal.get("status") == "done" else " "
        origin = goal.get("origin")
        is_plan = isinstance(origin, str) and origin.startswith("plan:")
        mark = "" if is_plan else "  (inferred)"
        any_inferred = any_inferred or not is_plan
        lines.append(f"- [{box}] {_render_line(goal.get('text', '(untitled goal)'))}{mark}")
        for sub in [g for g in live if g.get("parent") == goal["id"]]:
            claimed.add(sub.get("id"))
            sub_box = "x" if sub.get("status") == "done" else " "
            lines.append(f"  - [{sub_box}] {_render_line(sub.get('text', '(untitled goal)'))}")
    orphans = [g for g in live if g.get("level") == "subgoal" and g.get("id") not in claimed]
    if orphans:
        lines += ["", "## Unparented sub-goals"]
        for sub in orphans:
            sub_box = "x" if sub.get("status") == "done" else " "
            lines.append(f"- [{sub_box}] {_render_line(sub.get('text', '(untitled goal)'))}")
    unrecognized = [g for g in live if g.get("level") not in ("goal", "subgoal")]
    if unrecognized:
        lines += ["", "## Records with an unrecognized level (ledger may be malformed)"]
        for rec in unrecognized:
            lines.append(f"- {_render_line(rec.get('text', '(untitled goal)'))} "
                         f"(level: {_render_line(rec.get('level'))!r})")
    parked = len([g for g in data["goals"] if g.get("status") == "parked"])
    if parked:
        lines += ["", f"Parked: {parked} goal(s) untouched for over {PARK_AFTER_DAYS} days."]
    dropped = len([g for g in data["goals"] if g.get("status") == "dropped"])
    if dropped:
        lines += ["", f"Dropped: {dropped} goal(s) closed out at the approval gate."]
    if any_inferred:
        lines += ["", "(inferred) = this file cannot confirm the goal was explicitly planned "
                       "ahead of time; it does not mean the goal is uncertain or wrong."]
    lines += ["", "<!-- generated by goals.py from the ledger; do not edit by hand -->"]
    return "\n".join(lines) + "\n"


def _require_project(project: str) -> None:
    if not isinstance(project, str) or not project:
        raise Abort(2, "project must be a non-empty string")


def _bounded_read_text(path_str: str, what: str) -> str:
    path = Path(path_str)
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise Abort(2, f"cannot stat {what}: {exc}")
    if size > MAX_TEXT_LENGTH:
        raise Abort(2, f"{what} exceeds the maximum length ({MAX_TEXT_LENGTH} bytes on disk)")
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise Abort(2, f"cannot read {what}: {exc}")


def cmd_commit(project: str, session: str, decisions_path: str) -> dict:
    _require_project(project)
    slug = slugify(project)
    try:
        payload = json.loads(_bounded_read_text(decisions_path, "decision set"))
    except json.JSONDecodeError as exc:
        raise Abort(2, f"decision set unreadable: {exc}")
    if not isinstance(payload, dict):
        raise Abort(2, "decision set is not an object")
    decisions = payload.get("decisions")
    if not isinstance(decisions, list):
        raise Abort(2, "decision set has no `decisions` list")
    now_iso = _now_iso()
    with ledger_lock(slug):
        data = read_ledger(slug, project)
        applied = apply_decisions(data, session, decisions, now_iso)
        if applied:
            write_ledger(slug, data)
    return {"ok": True, "applied": applied, "ledger": str(ledger_path(slug))}


_VAULT_ENV = os.environ.get("GOALS_VAULT_PROJECTS", "").strip()
VAULT_PROJECTS = Path(_VAULT_ENV).expanduser() if _VAULT_ENV else None
_UUID8_RE = re.compile(r"^[0-9a-f]{8}$")
_H2_TIME_RE = re.compile(r"^## \d{2}:\d{2} — ", re.MULTILINE)
_FM_SESSION_RE = re.compile(r"^session_uuid:\s*(\S+)", re.MULTILINE)
_RESUME_FIELDS = ("Pick up at", "Active blocker", "Reopen first", "First command", "Branch")


def _ledger_fingerprint() -> dict:
    out = {}
    try:
        for p in LEDGER_DIR.glob("*.json"):
            try:
                out[p.name] = p.stat().st_mtime_ns
            except OSError:
                out[p.name] = -1
    except OSError:
        pass
    return out


def _fmt_session(uuid: str, live: bool, last_seen: str) -> str:
    short = _render_line(uuid)[:8] if uuid else "unknown"
    return f"`{short}` {'**LIVE**' if live else 'dead'}"


def _handoff_card(project: str, uuid: str) -> list:
    if not uuid or len(uuid) < 8:
        return []
    short = uuid[:8]
    if VAULT_PROJECTS is None:
        return []
    folder = VAULT_PROJECTS / project / "progress"
    if not folder.is_dir():
        return []
    try:
        cands = sorted(folder.glob(f"*{short}*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        cands = []
    if not cands:
        try:
            others = sorted(folder.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
        except OSError:
            return []
        for p in others:
            try:
                txt = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            m = _FM_SESSION_RE.search(txt)
            if not m or not m.group(1).startswith(short):
                continue
            if len(_H2_TIME_RE.findall(txt)) != 1:
                continue
            cands = [p]
            break
    if not cands:
        return []
    try:
        text = cands[0].read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    idx = text.find("### Resume Here")
    if idx == -1:
        return []
    body = text[idx + len("### Resume Here"):]
    nxt = re.search(r"^#{2,3} ", body, re.MULTILINE)
    if nxt:
        body = body[:nxt.start()]
    lines = []
    for raw in body.splitlines():
        s = raw.strip()
        if not s.startswith("-"):
            continue
        for field in _RESUME_FIELDS:
            if f"**{field}:**" in s:
                lines.append(f"  {_render_line(s.lstrip('- '))}")
                break
    return lines[:6]


def _render_goal_line(goal: dict, live_of) -> str:
    status = goal.get("status")
    status_txt = _render_line(status) if isinstance(status, str) else "?"
    box = "[x]" if status_txt == "done" else "[ ]"
    text = _render_line(goal.get("text", "")) or "_(no text)_"
    owner = goal.get("owner_session")
    owner = owner if isinstance(owner, str) else ""
    bits = [f"- {box} {text} · `{status_txt}`"]
    if owner:
        bits.append(f"created by {_fmt_session(owner, live_of(owner), '')}")
    touched = sorted({h.get("session") for h in goal.get("history", [])
                      if isinstance(h, dict) and isinstance(h.get("session"), str)})
    touched = [t for t in touched if t != owner]
    if touched:
        bits.append("touched by " + ", ".join(_fmt_session(t, live_of(t), "") for t in touched))
    origin = goal.get("origin")
    if not (isinstance(origin, str) and origin.startswith("plan:")):
        bits.append("_(inferred)_")
    last = goal.get("last_seen")
    if isinstance(last, str) and last:
        bits.append(f"last seen {_render_line(last)}")
    return " · ".join(bits)


def _render_project_section(project: str, data: dict, live_of) -> list:
    goals = [g for g in data.get("goals", []) if isinstance(g, dict)]
    buckets = {"open": [], "done": [], "parked": [], "dropped": []}
    for g in goals:
        st = g.get("status")
        buckets.get(st if isinstance(st, str) and st in buckets else "open", buckets["open"]).append(g)

    out = [f"## {_render_line(project)}", ""]
    if not goals:
        out += ["_no live goals_", ""]
        return out

    for name in ("open", "done"):
        if buckets[name]:
            out.append(f"**{name.capitalize()}** ({len(buckets[name])})")
            out += [_render_goal_line(g, live_of) for g in buckets[name]]
            out.append("")
    for name in ("parked", "dropped"):
        if buckets[name]:
            out.append(f"### {name.capitalize()} ({len(buckets[name])})")
            out += [_render_goal_line(g, live_of) for g in buckets[name]]
            out.append("")

    owners = sorted({g.get("owner_session") for g in goals
                     if isinstance(g.get("owner_session"), str) and g.get("owner_session")})
    for uuid in owners:
        card = _handoff_card(project, uuid)
        head = f"**Session {_fmt_session(uuid, live_of(uuid), '')}**"
        out.append(head)
        out += card if card else ["  _no handoff recorded_"]
        out.append("")
    return out


def _projects_without_ledger() -> tuple:
    if VAULT_PROJECTS is None:
        return (0, 0)
    try:
        dirs = [p for p in VAULT_PROJECTS.iterdir()
                if p.is_dir() and not p.name.startswith(".")]
    except OSError:
        return (0, 0)
    try:
        slugs = {p.stem for p in LEDGER_DIR.glob("*.json")}
    except OSError:
        return (0, 0)
    return (sum(1 for p in dirs if slugify(p.name) not in slugs), len(dirs))


def _build_dashboard_region() -> tuple:
    now = time.time()
    _live_cache = {}

    def live_of(uuid):
        if uuid not in _live_cache:
            try:
                _live_cache[uuid] = session_live(uuid, now)
            except Abort:
                _live_cache[uuid] = False
        return _live_cache[uuid]

    sections, stats = [], {"projects": 0, "unreadable": 0,
                           "open": 0, "done": 0, "parked": 0, "dropped": 0}
    for path in sorted(LEDGER_DIR.glob("*.json")):
        slug = path.stem
        try:
            data = read_ledger(slug, slug)
            _check_ledger_shape(data)
        except Abort as exc:
            stats["unreadable"] += 1
            sections += [f"## {_render_line(slug)}", "",
                         f"_ledger unreadable: {_render_line(str(exc))}_", ""]
            continue
        project = data.get("project") or slug
        if not isinstance(project, str):
            project = slug
        stats["projects"] += 1
        for g in data.get("goals", []):
            if isinstance(g, dict):
                st = g.get("status")
                if isinstance(st, str) and st in stats:
                    stats[st] += 1
        sections += _render_project_section(project, data, live_of)

    live_sessions = sum(1 for v in _live_cache.values() if v)
    summary = (f"**{stats['projects']} projects** · {stats['open']} open · "
               f"{stats['done']} done · {stats['parked']} parked · "
               f"{stats['dropped']} dropped · {live_sessions} live "
               f"session{'' if live_sessions == 1 else 's'}")
    if stats["unreadable"]:
        summary += f" · {stats['unreadable']} unreadable ledger(s)"
    no_ledger, vault_total = _projects_without_ledger()
    stats["no_ledger"] = no_ledger
    if vault_total:
        summary += (f" · {no_ledger} of {vault_total} vault projects have no ledger "
                    f"(not shown)")

    preamble = [
        summary, "",
        "_Derived from the per-project goal ledgers. `created by` and `touched by` are what the",
        "ledger records — there is no assignment mechanism, so this is who last had hands on a",
        "goal, not who is on it now. A session that read a goal without changing it leaves no",
        "trace, so `touched by` is a floor. Handoff cards come from each report's `### Resume",
        "Here`; legacy multi-block day-files are not session-attributable and read `_no handoff",
        "recorded_` by design — never a guess._", "",
    ]
    return "\n".join(preamble + sections).rstrip() + "\n", stats


def cmd_dashboard(out_path: str) -> dict:
    out = Path(out_path)
    fingerprint_before = _ledger_fingerprint()
    region_body, stats = _build_dashboard_region()
    region = f"{SENT_BEGIN}\n\n{region_body}\n{SENT_END}"

    with dashboard_lock():
        if _ledger_fingerprint() != fingerprint_before:
            sys.stderr.write(
                "goals.py: NOTE-STALE-RENDER — a ledger changed during this render; "
                "write skipped (next run reconciles)\n")
            return {"ok": True, "skipped": "stale render", "written": None}

        cur = None
        cur_mtime_ns = 0
        if out.exists():
            try:
                cur_mtime_ns = out.stat().st_mtime_ns
                cur = out.read_text(encoding="utf-8")
            except OSError as exc:
                raise Abort(4, f"dashboard unreadable: {out} ({exc})")

        if cur is None:
            text = (f"---\ntype: dashboard\nmanaged_by: {DASHBOARD_MANAGED_BY}\n"
                    f"updated: {datetime.now().strftime('%Y-%m-%d')}\n---\n\n"
                    f"# Goals & To-Do\n\n"
                    f"Auto-derived from the per-project goal ledgers. Do not hand-edit inside the\n"
                    f"sentinels — edits there are overwritten on the next the report tool run.\n\n"
                    f"{region}\n")
        else:
            fm_match = re.match(r"^---\n(.*?)\n---\n", cur, re.DOTALL)
            managed = fm_match and re.search(
                rf"^managed_by:\s*{re.escape(DASHBOARD_MANAGED_BY)}\s*$",
                fm_match.group(1), re.MULTILINE)
            if not managed:
                raise Abort(4, f"refusing to overwrite unmanaged file "
                               f"(frontmatter managed_by != {DASHBOARD_MANAGED_BY}): {out}")
            b_hits = [m.start() for m in re.finditer(rf"^{re.escape(SENT_BEGIN)}$", cur, re.MULTILINE)]
            e_hits = [m.start() for m in re.finditer(rf"^{re.escape(SENT_END)}$", cur, re.MULTILINE)]
            if len(b_hits) > 1 or len(e_hits) > 1:
                raise Abort(4, f"ambiguous sentinels (multiple line-anchored occurrences) "
                               f"— refusing to write: {out}")
            if b_hits and e_hits and e_hits[0] > b_hits[0]:
                text = cur[:b_hits[0]] + region + cur[e_hits[0] + len(SENT_END):]
            elif not b_hits and not e_hits:
                # Both markers gone: keep every existing line, add a fresh region at the end.
                sys.stderr.write(f"goals.py: WARNING {out} lost its sentinels — "
                                 f"appending a fresh region, existing text kept\n")
                text = cur.rstrip() + "\n\n" + region + "\n"
            else:
                raise Abort(4, f"one sentinel is missing or out of order — refusing to "
                               f"write; fix the markers by hand: {out}")

        if cur is not None and text == cur:
            return {"ok": True, "skipped": "unchanged", "written": None, "stats": stats}

        try:
            out.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise Abort(4, f"dashboard output directory unusable: {exc}")
        tmp = out.with_name(f".{out.name}.tmp-{os.getpid()}")
        try:
            tmp.write_text(text, encoding="utf-8")
            if cur is not None and out.stat().st_mtime_ns != cur_mtime_ns:
                sys.stderr.write(f"goals.py: NOTE-CHANGED-UNDERFOOT — {out} changed since it "
                                 f"was read; write discarded (next run reconciles)\n")
                return {"ok": True, "skipped": "changed underfoot", "written": None}
            token = _HELD.get("dashboard")
            owner = (LOCK_DIR / DASHBOARD_LOCK_NAME / "owner")
            if not token or owner.read_text(encoding="utf-8").strip() != token:
                raise Abort(5, "lock lost before write; dashboard NOT modified")
            os.replace(tmp, out)
        except (OSError, UnicodeEncodeError) as exc:
            raise Abort(4, f"dashboard write failed: {exc}")
        finally:
            try:
                tmp.unlink()
            except OSError:
                pass

    return {"ok": True, "written": str(out), "stats": stats}


def cmd_render(project: str, out_path: str) -> dict:
    _require_project(project)
    slug = slugify(project)
    if not ledger_path(slug).exists():
        return {"ok": True, "skipped": "no ledger for this project", "rendered": None}
    data = read_ledger(slug, project)
    out = Path(out_path)
    try:
        out.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise Abort(4, f"render output directory unusable: {exc}")
    tmp = out.with_name(f".{out.name}.tmp-{os.getpid()}")
    try:
        try:
            tmp.write_text(render_markdown(data), encoding="utf-8")
            os.replace(tmp, out)
        except (OSError, UnicodeEncodeError) as exc:
            raise Abort(4, f"render write failed: {exc}")
    finally:
        tmp.unlink(missing_ok=True)
    return {"ok": True, "rendered": str(out)}


THIN_SESSION_CMD = "thin-session"
THIN_EVENT_COUNT_MAX = 5
THIN_ACTIVE_MSG_COUNT_MAX = 30


def is_thin_session(event_count: int, active_msg_count: int) -> bool:
    return event_count < THIN_EVENT_COUNT_MAX and active_msg_count < THIN_ACTIVE_MSG_COUNT_MAX


def cmd_thin_session(project: str, event_count: int, active_msg_count: int) -> dict:
    _require_project(project)
    slug = slugify(project)
    return {
        "ok": True,
        "project": slug,
        "event_count": event_count,
        "active_msg_count": active_msg_count,
        "thin": is_thin_session(event_count, active_msg_count),
    }


RUN_RECEIPT_MAX_ENTRIES = 20

_RECEIPT_SESSION_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")


def _read_receipt_entries(path: Path) -> list[dict]:
    try:
        raw = path.read_text(encoding="utf-8")
    except (OSError, ValueError):
        return []
    try:
        data = json.loads(raw)
    except ValueError:
        return []
    if not isinstance(data, dict):
        return []
    entries = data.get("entries")
    if not isinstance(entries, list):
        return []
    return [entry for entry in entries if isinstance(entry, dict)]


def _receipt_project(project: object) -> str | None:
    if not isinstance(project, str) or not project:
        return None
    try:
        return slugify(project)
    except Abort:
        return None


def _record_run(session: object, command: str, exit_code: int,
                project: object = None, effect: object = None,
                metrics: object = None) -> None:
    try:
        if not isinstance(session, str) or not _RECEIPT_SESSION_RE.fullmatch(session):
            raise ValueError(f"unusable session id {session!r}")
        RUN_DIR.mkdir(parents=True, exist_ok=True)
        path = RUN_DIR / (session + ".json")
        entries = _read_receipt_entries(path)
        entry = {
            "cmd": command,
            "exit": int(exit_code),
            "ts": _now_iso(),
            "project": _receipt_project(project),
            "effect": effect if type(effect) is int else None,
        }
        if isinstance(metrics, dict):
            entry["metrics"] = metrics
        entries.append(entry)
        payload = {"session": session, "entries": entries[-RUN_RECEIPT_MAX_ENTRIES:]}
        tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
        try:
            tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
    except Exception as exc:
        print(f"goals.py: run receipt not written: {exc}", file=sys.stderr)


NO_RECEIPT_COMMANDS = frozenset({
    "outcome-create", "outcome-list", "outcome-attach", "outcome-advance",
    "outcome-status", "outcome-note", "outcome-claim", "outcome-release",
    "pendings-ingest", "pendings-set", "pendings-next",
})


def main(argv: list[str] | None = None) -> int:
    global LEDGER_DIR, LOCK_DIR, RUN_DIR
    prev_ledger_dir, prev_lock_dir, prev_run_dir = LEDGER_DIR, LOCK_DIR, RUN_DIR
    LEDGER_DIR = Path(os.environ.get("GOALS_LEDGER_DIR", LEDGER_DIR))
    LOCK_DIR = Path(os.environ.get("GOALS_LOCK_DIR", LOCK_DIR))
    RUN_DIR = Path(os.environ.get("GOALS_RUN_DIR", RUN_DIR))
    try:
        parser = argparse.ArgumentParser(
            prog="goals.py", description="Read and write the report tool's per-project goal ledger.")
        subs = parser.add_subparsers(dest="command", required=True)

        p_load = subs.add_parser("load", help="load this session's owned/claimable open goals")
        p_load.add_argument("--project", required=True, help="project name (any string; slugified internally)")
        p_load.add_argument("--session", required=True, help="this session's id (any plain token)")
        p_load.add_argument("--read-only", action="store_true",
                             help="never write the ledger: skip the autopark persist and report "
                                  "the pending parks as `would_park` instead. Required on --dry-run.")

        p_commit = subs.add_parser("commit", help="apply a decision batch to the ledger")
        p_commit.add_argument("--project", required=True, help="project name (any string; slugified internally)")
        p_commit.add_argument("--session", required=True, help="this session's id (any plain token)")
        p_commit.add_argument("--decisions", required=True,
                               help="path to a JSON file: "
                                    '{"session": "...", "decisions": [{"op": "create|retext|status|seen", ...}]}')

        p_render = subs.add_parser("render", help="regenerate the derived markdown mirror")
        p_render.add_argument("--project", required=True, help="project name (any string; slugified internally)")
        p_render.add_argument("--out", required=True, help="path to write the rendered markdown file to")

        p_dashboard = subs.add_parser(
            "dashboard", help="regenerate the cross-project Goals & To-Do page")
        p_dashboard.add_argument("--out", required=True,
                                 help="path to the dashboard page (sentinel-spliced, not overwritten)")

        p_thin = subs.add_parser(
            THIN_SESSION_CMD,
            help="record that this run skipped the goal step as a thin session (no ledger write)")
        p_thin.add_argument("--project", required=True,
                            help="project name (any string; slugified internally)")
        p_thin.add_argument("--session", required=True, help="this session's id (any plain token)")
        p_thin.add_argument("--event-count", required=True, type=int,
                            help="the digest's `.event_count` for this session, passed through "
                                 "verbatim: recorded on the receipt and compared against the "
                                 "thin threshold")
        p_thin.add_argument("--active-msg-count", required=True, type=int,
                            help="the digest's `.active_msg_count` for this session, on exactly "
                                 "the same terms as --event-count")

        p_parse = subs.add_parser("parse-extraction", help="parse a goal-extractor agent's raw return block")
        p_parse.add_argument("--file", required=True,
                              help="path to a text file containing one <<<GOAL_EXTRACTION>>>...<<<END>>> block")
        p_parse.add_argument("--session", default=None,
                              help="this session's id; used ONLY to record a run receipt. Optional here "
                                   "(this subcommand needs no session to do its work), but the report tool "
                                   "must pass it.")
        p_parse.add_argument("--project", default=None,
                              help="project name; used ONLY to record a run receipt, on exactly the same "
                                   "terms as --session. Nothing in the parse reads it and the returned "
                                   "payload is identical with or without it. Optional here, but "
                                   "the report tool must pass it: without it the "
                                   "entry records no project, and a counts declaration checked against a "
                                   "project-less entry is rejected in Step 6.")

        p_oc = subs.add_parser("outcome-create",
                               help="create a cross-project outcome")
        p_oc.add_argument("--statement", required=True,
                          help="one user-visible sentence: what is true when this is done")
        p_oc.add_argument("--projects", required=True,
                          help="comma-separated project names this outcome spans")

        p_ol = subs.add_parser("outcome-list", help="list outcomes")
        p_ol.add_argument("--station", default=None,
                          help="filter: captured|specced|planned|executing|verifying|closed")
        p_ol.add_argument("--status", default=None,
                          help="filter: open|active|blocked|parked|done")

        p_oa = subs.add_parser("outcome-attach",
                               help="link a per-project goal to an outcome")
        p_oa.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_oa.add_argument("--project", required=True, help="project name")
        p_oa.add_argument("--goal", required=True, help="goal id, g-NNNN")

        p_oadv = subs.add_parser("outcome-advance",
                                 help="move an outcome to the next station")
        p_oadv.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_oadv.add_argument("--to", default=None,
                            help="target station; omit to step forward by one")
        p_oadv.add_argument("--reopen", action="store_true",
                            help="required to move an outcome backwards")

        p_ost = subs.add_parser("outcome-status", help="set an outcome's status")
        p_ost.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_ost.add_argument("--status", required=True,
                           help="open|active|blocked|parked|done")
        p_ost.add_argument("--wake", default=None,
                           help="required with --status parked: what reactivates it")

        p_onote = subs.add_parser(
            "outcome-note",
            help="append one free-text, timestamped entry to an outcome's history")
        p_onote.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_onote.add_argument("--text", required=True,
                             help="the note itself; one or more sentences")
        p_onote.add_argument("--event", default="note",
                             help="note (a person wrote it) or session-end (the "
                                  "session-end hook recorded where it stood)")

        p_ocl = subs.add_parser("outcome-claim",
                                help="claim an outcome for this session")
        p_ocl.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_ocl.add_argument("--session", required=True, help="this session's id")

        p_orl = subs.add_parser("outcome-release", help="release a claim")
        p_orl.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_orl.add_argument("--session", required=True, help="this session's id")
        p_orl.add_argument("--steal", action="store_true",
                           help="force-release another session's live claim "
                                "(recorded in the outcome's history)")

        p_pi = subs.add_parser(
            "pendings-ingest",
            help="read a spec's PENDINGS fence into an outcome")
        p_pi.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_pi.add_argument("--spec", required=True,
                          help="path to the spec file carrying the fenced block")

        p_ps = subs.add_parser(
            "pendings-set",
            help="set one row's status in the spec fence AND the ledger")
        p_ps.add_argument("--outcome", required=True, help="outcome-NNNN")
        p_ps.add_argument("--spec", required=True,
                          help="path to the spec file carrying the fenced block")
        p_ps.add_argument("--row", required=True, help="row id, PNN")
        p_ps.add_argument("--status", required=True,
                          help="open|active|blocked|done")

        p_pn = subs.add_parser("pendings-next",
                               help="print the single next unblocked pending")
        p_pn.add_argument("--outcome", required=True, help="outcome-NNNN")

        args = parser.parse_args(argv)

        receipt_session = (None if args.command in NO_RECEIPT_COMMANDS
                           else getattr(args, "session", None))
        receipt_project = getattr(args, "project", None)
        exit_code = 1
        receipt_effect = None
        receipt_metrics = None
        try:
            if args.command == "load":
                result = cmd_load(args.project, args.session, read_only=args.read_only)
            elif args.command == "commit":
                result = cmd_commit(args.project, args.session, args.decisions)
                receipt_effect = result["applied"]
            elif args.command == "render":
                result = cmd_render(args.project, args.out)
            elif args.command == "dashboard":
                result = cmd_dashboard(args.out)
            elif args.command == THIN_SESSION_CMD:
                result = cmd_thin_session(args.project, args.event_count, args.active_msg_count)
                receipt_metrics = {"event_count": args.event_count,
                                   "active_msg_count": args.active_msg_count}
            elif args.command == "outcome-create":
                import outcomes
                result = outcomes.cmd_outcome_create(args.statement, args.projects)
                receipt_effect = 1
            elif args.command == "outcome-list":
                import outcomes
                result = outcomes.cmd_outcome_list(args.station, args.status)
            elif args.command == "outcome-attach":
                import outcomes
                result = outcomes.cmd_outcome_attach(args.outcome, args.project,
                                                     args.goal)
                receipt_effect = 1
            elif args.command == "outcome-advance":
                import outcomes
                result = outcomes.cmd_outcome_advance(args.outcome, args.to,
                                                      args.reopen)
                receipt_effect = 1
            elif args.command == "outcome-status":
                import outcomes
                result = outcomes.cmd_outcome_status(args.outcome, args.status,
                                                     args.wake)
                receipt_effect = 1
            elif args.command == "outcome-note":
                import outcomes
                result = outcomes.cmd_outcome_note(args.outcome, args.text,
                                                   args.event)
                receipt_effect = 1
            elif args.command == "outcome-claim":
                import outcomes
                result = outcomes.cmd_outcome_claim(args.outcome, args.session)
                receipt_effect = 1
            elif args.command == "outcome-release":
                import outcomes
                result = outcomes.cmd_outcome_release(args.outcome, args.session,
                                                      steal=args.steal)
                receipt_effect = 1
            elif args.command == "pendings-ingest":
                import outcomes
                result = outcomes.cmd_pendings_ingest(args.outcome, args.spec)
                receipt_effect = result["ingested"]
            elif args.command == "pendings-set":
                import outcomes
                result = outcomes.cmd_pendings_set(args.outcome, args.spec,
                                                   args.row, args.status)
                receipt_effect = 1
            elif args.command == "pendings-next":
                import outcomes
                result = outcomes.cmd_pendings_next(args.outcome)
            else:
                result = {"proposed": parse_extraction(_bounded_read_text(args.file, "extractor output file"))}
                receipt_effect = len(result["proposed"])
            print(json.dumps(result, indent=2, ensure_ascii=False))
            exit_code = 0
            return 0
        except Abort as abort:
            exit_code = abort.code
            raise
        finally:
            if receipt_session is not None:
                _record_run(receipt_session, args.command, exit_code,
                            receipt_project, receipt_effect, receipt_metrics)
    finally:
        LEDGER_DIR, LOCK_DIR, RUN_DIR = prev_ledger_dir, prev_lock_dir, prev_run_dir


if __name__ == "__main__":
    sys.modules.setdefault("goals", sys.modules["__main__"])
    try:
        sys.exit(main())
    except Abort as abort:
        print(abort.message, file=sys.stderr)
        sys.exit(abort.code)
