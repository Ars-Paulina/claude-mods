#!/usr/bin/env python3
"""Cross-project outcomes and their pendings, stored in ~/.claude/goal-ledger/outcomes.json.
"""
import json
import os
import re
import subprocess
import time
from contextlib import contextmanager
from pathlib import Path
import goals

def _time_now() -> float:
    return time.time()
SCHEMA = 1
STATIONS = ('captured', 'specced', 'planned', 'executing', 'verifying', 'closed')
VALID_STATION = frozenset(STATIONS)
VALID_STATUS = frozenset({'open', 'active', 'blocked', 'parked', 'done'})
OUTCOMES_FILE = 'outcomes.json'
OUTCOMES_LOCK_NAME = 'goal-ledger--outcomes.lock'
_OUTCOME_ID_RE = re.compile('^outcome-(\\d{4,})$')
_HELD_KEY = '__outcomes__'

def outcomes_path() -> Path:
    return goals.LEDGER_DIR / OUTCOMES_FILE

def outcomes_lock_path() -> Path:
    return goals.LOCK_DIR / OUTCOMES_LOCK_NAME

@contextmanager
def outcomes_lock():
    with goals._lock_at(outcomes_lock_path(), _HELD_KEY, 'outcomes_lock'):
        yield

def _fresh() -> dict:
    return {'schema': SCHEMA, 'updated': goals._now_iso(), 'outcomes': []}

def read_outcomes() -> dict:
    path = outcomes_path()
    if not path.exists():
        return _fresh()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise goals.Abort(2, f'outcomes.json unreadable: {exc}')
    check_shape(data)
    return data

def write_outcomes(data: dict) -> None:
    check_shape(data)
    data['updated'] = goals._now_iso()
    goals._atomic_write(outcomes_path(), outcomes_lock_path(), _HELD_KEY, data, what='outcomes')

def new_outcome_id(existing: list) -> str:
    used = set()
    for rec in existing:
        if not isinstance(rec, dict):
            continue
        m = _OUTCOME_ID_RE.match(str(rec.get('id', '')))
        if m:
            used.add(int(m.group(1)))
    return f'outcome-{(max(used) + 1 if used else 1):04d}'

def check_shape(data: object) -> None:
    if not isinstance(data, dict):
        raise goals.Abort(2, 'outcomes.json must be a JSON object')
    if data.get('schema') != SCHEMA:
        raise goals.Abort(2, f'outcomes.json schema is {data.get('schema')!r}, expected {SCHEMA}')
    records = data.get('outcomes')
    if not isinstance(records, list):
        raise goals.Abort(2, 'outcomes must be a list')
    seen = set()
    for i, rec in enumerate(records):
        where = f'outcomes[{i}]'
        if not isinstance(rec, dict):
            raise goals.Abort(2, f'{where} must be an object')
        oid = rec.get('id')
        if not isinstance(oid, str) or not _OUTCOME_ID_RE.match(oid):
            raise goals.Abort(2, f'{where}.id {oid!r} is not outcome-NNNN')
        if oid in seen:
            raise goals.Abort(2, f'{where}.id {oid!r} is a duplicate id')
        seen.add(oid)
        statement = rec.get('statement')
        if not isinstance(statement, str) or not statement.strip():
            raise goals.Abort(2, f'{where}.statement must be a non-empty sentence')
        projects = rec.get('projects')
        if not isinstance(projects, list) or not projects or (not all((isinstance(p, str) and p.strip() for p in projects))):
            raise goals.Abort(2, f'{where}.projects must be a non-empty list of project names')
        if rec.get('station') not in VALID_STATION:
            raise goals.Abort(2, f'{where}.station {rec.get('station')!r} not in {sorted(VALID_STATION)}')
        if rec.get('status') not in VALID_STATUS:
            raise goals.Abort(2, f'{where}.status {rec.get('status')!r} not in {sorted(VALID_STATUS)}')
        for field in ('pendings', 'history'):
            if not isinstance(rec.get(field), list):
                raise goals.Abort(2, f'{where}.{field} must be a list')
        for j, row in enumerate(rec['pendings']):
            at = f'{where}.pendings[{j}]'
            if not isinstance(row, dict):
                raise goals.Abort(2, f'{at} must be an object')
            rid = row.get('id')
            if not isinstance(rid, str) or not rid.strip():
                raise goals.Abort(2, f'{at}.id {rid!r} must be a row id')
            if row.get('status') not in STORED_PENDING_STATUS:
                raise goals.Abort(2, f'{at} {rid}: status {row.get('status')!r} not in {sorted(STORED_PENDING_STATUS)}')
            if not isinstance(row.get('depends_on'), list):
                raise goals.Abort(2, f'{at} {rid}: depends_on must be a list')

def goal_outcome(goal: dict) -> str | None:
    value = goal.get('outcome')
    return value if isinstance(value, str) and _OUTCOME_ID_RE.match(value) else None

def set_goal_outcome(goal: dict, outcome_id: str) -> None:
    if not isinstance(outcome_id, str) or not _OUTCOME_ID_RE.match(outcome_id):
        raise goals.Abort(2, f'{outcome_id!r} is not an outcome id (outcome-NNNN)')
    goal['outcome'] = outcome_id

def find_outcome(data: dict, outcome_id: str) -> dict:
    for rec in data['outcomes']:
        if rec.get('id') == outcome_id:
            return rec
    raise goals.Abort(2, f'no such outcome: {outcome_id}')

def next_station(station: str) -> str | None:
    if station not in VALID_STATION:
        raise goals.Abort(2, f'unknown station {station!r}')
    i = STATIONS.index(station)
    return STATIONS[i + 1] if i + 1 < len(STATIONS) else None

def _split_projects(raw: str) -> list:
    items = [p.strip() for p in str(raw).split(',') if p.strip()]
    if not items:
        raise goals.Abort(2, '--projects needs at least one project name')
    return items

def assert_not_in_worktree() -> None:
    try:
        git_dir = subprocess.run(['git', 'rev-parse', '--absolute-git-dir'], capture_output=True, text=True, timeout=5)
        common = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], capture_output=True, text=True, timeout=5)
    except OSError:
        return
    except subprocess.SubprocessError as exc:
        raise goals.Abort(2, f'cannot determine whether this is a linked git worktree: git rev-parse failed in a way that answers nothing ({type(exc).__name__}: {exc}).\n  you are in : {os.getcwd()}\nRefusing the write rather than guessing. Re-run once git responds.')
    if git_dir.returncode != 0 or common.returncode != 0:
        return
    here = git_dir.stdout.strip()
    canonical = common.stdout.strip()
    if not here.startswith('/') or not canonical.startswith('/'):
        return
    if here == canonical:
        return
    main_tree = os.path.dirname(canonical.rstrip('/'))
    raise goals.Abort(2, f'refusing to write ledger state from a linked git worktree.\n  you are in : {os.getcwd()}\n  canonical  : {main_tree}\nA worktree reads the ledger and never writes pending state (spec 3.6). Run this from the canonical path above.')

def cmd_outcome_create(statement: str, projects: str) -> dict:
    assert_not_in_worktree()
    if not isinstance(statement, str) or not statement.strip():
        raise goals.Abort(2, '--statement must be a non-empty sentence')
    names = _split_projects(projects)
    now = goals._now_iso()
    with outcomes_lock():
        data = read_outcomes()
        rec = {'id': new_outcome_id(data['outcomes']), 'statement': statement.strip(), 'projects': names, 'station': 'captured', 'status': 'open', 'wake': None, 'claim': None, 'created': now, 'last_seen': now, 'pendings': [], 'history': []}
        data['outcomes'].append(rec)
        write_outcomes(data)
    return rec

def cmd_outcome_list(station: str | None=None, status: str | None=None) -> dict:
    if station is not None and station not in VALID_STATION:
        raise goals.Abort(2, f'unknown station {station!r}')
    if status is not None and status not in VALID_STATUS:
        raise goals.Abort(2, f'unknown status {status!r}')
    data = read_outcomes()
    rows = [r for r in data['outcomes'] if (station is None or r['station'] == station) and (status is None or r['status'] == status)]
    return {'outcomes': rows, 'count': len(rows)}

def cmd_outcome_attach(outcome_id: str, project: str, goal_id: str) -> dict:
    assert_not_in_worktree()
    with outcomes_lock():
        find_outcome(read_outcomes(), outcome_id)
    slug = goals.slugify(project)
    with goals.ledger_lock(slug):
        data = goals.read_ledger(slug, project)
        target = None
        for g in data['goals']:
            if g.get('id') == goal_id:
                target = g
                break
        if target is None:
            raise goals.Abort(2, f'no goal {goal_id} in project {project}')
        set_goal_outcome(target, outcome_id)
        data['updated'] = goals._now_iso()
        goals.write_ledger(slug, data)
    return {'outcome': outcome_id, 'project': project, 'goal': goal_id, 'attached': True}

def cmd_outcome_advance(outcome_id: str, to: str | None=None, reopen: bool=False) -> dict:
    assert_not_in_worktree()
    with outcomes_lock():
        data = read_outcomes()
        rec = find_outcome(data, outcome_id)
        current = rec['station']
        if to is None:
            target = next_station(current)
            if target is None:
                raise goals.Abort(2, f'{outcome_id} is at {current}; there is no station after it')
        else:
            if to not in VALID_STATION:
                raise goals.Abort(2, f'unknown station {to!r}')
            here, there = (STATIONS.index(current), STATIONS.index(to))
            if there == here + 1:
                pass
            elif there < here:
                if not reopen:
                    raise goals.Abort(2, f'{outcome_id} is at {current}; moving back to {to} needs --reopen')
            elif there == here:
                raise goals.Abort(2, f'{outcome_id} is already at {current}')
            else:
                raise goals.Abort(2, f'cannot skip from {current} to {to}; the next station is {STATIONS[here + 1]}')
            target = to
        now = goals._now_iso()
        rec['history'].append({'at': now, 'from': current, 'to': target, 'reopen': bool(reopen and to is not None)})
        rec['station'] = target
        rec['last_seen'] = now
        write_outcomes(data)
    return {'id': outcome_id, 'station': target, 'previous_station': current, 'next_station': next_station(target)}
VALID_NOTE_EVENT = frozenset({'note', 'session-end'})

def cmd_outcome_note(outcome_id: str, text: str, event: str='note') -> dict:
    assert_not_in_worktree()
    if not isinstance(text, str) or not text.strip():
        raise goals.Abort(2, 'text is empty')
    if event not in VALID_NOTE_EVENT:
        raise goals.Abort(2, f'unknown event {event!r}, expected one of {sorted(VALID_NOTE_EVENT)}')
    text = text.strip()
    with outcomes_lock():
        data = read_outcomes()
        rec = find_outcome(data, outcome_id)
        now = goals._now_iso()
        rec['history'].append({'at': now, 'event': event, 'text': text})
        rec['last_seen'] = now
        write_outcomes(data)
    return {'outcome': outcome_id, 'event': event, 'text': text, 'at': now}

def cmd_outcome_status(outcome_id: str, status: str, wake: str | None=None) -> dict:
    assert_not_in_worktree()
    if status not in VALID_STATUS:
        raise goals.Abort(2, f'unknown status {status!r}, expected one of {sorted(VALID_STATUS)}')
    if status == 'parked':
        if not isinstance(wake, str) or not wake.strip():
            raise goals.Abort(2, '--status parked requires --wake: the condition that reactivates this outcome. A park with no wake is how a deadline rots silently.')
    elif wake is not None and wake.strip():
        raise goals.Abort(2, '--wake is only meaningful with --status parked')
    with outcomes_lock():
        data = read_outcomes()
        rec = find_outcome(data, outcome_id)
        previous = rec['status']
        now = goals._now_iso()
        rec['status'] = status
        rec['wake'] = wake.strip() if status == 'parked' else None
        rec['last_seen'] = now
        rec['history'].append({'at': now, 'status_from': previous, 'status_to': status})
        write_outcomes(data)
    return {'id': outcome_id, 'status': status, 'previous_status': previous, 'wake': rec['wake']}
CLAIM_EXPIRY_MS = 14400000

def claim_is_live(claim, now_epoch: float) -> bool:
    if not isinstance(claim, dict):
        return False
    stamp = claim.get('heartbeat_at')
    if not isinstance(stamp, str):
        return False
    try:
        beat = goals._parse_iso(stamp)
    except Exception as exc:
        raise goals.Abort(2, f'claim.heartbeat_at {stamp!r} is not a readable timestamp ({exc}); this outcome cannot be judged held or free. Take it anyway with: outcome-release --outcome <id> --session <yours> --steal')
    return (now_epoch - beat) * 1000 <= CLAIM_EXPIRY_MS

def cmd_outcome_claim(outcome_id: str, session: str) -> dict:
    assert_not_in_worktree()
    if not isinstance(session, str) or not goals._SESSION_ID_RE.fullmatch(session):
        raise goals.Abort(2, f'{session!r} is not a usable session id')
    now_epoch = _time_now()
    with outcomes_lock():
        data = read_outcomes()
        rec = find_outcome(data, outcome_id)
        held = rec.get('claim') if isinstance(rec.get('claim'), dict) else None
        held_by = held.get('session_id') if held else None
        if claim_is_live(held, now_epoch) and held_by != session:
            raise goals.Abort(2, f'{outcome_id} is claimed by session {held_by} (heartbeat {held.get('heartbeat_at')}); it frees itself {CLAIM_EXPIRY_MS // 3600000}h after that heartbeat, or now with: outcome-release --outcome {outcome_id} --session {session} --steal')
        now = goals._now_iso()
        rec['claim'] = {'session_id': session, 'heartbeat_at': now}
        rec['last_seen'] = now
        if held is not None and held_by != session:
            rec['history'].append({'at': now, 'event': 'claim-taken', 'from': held_by, 'by': session})
        write_outcomes(data)
    return {'id': outcome_id, 'claimed': True, 'claim': rec['claim'], 'station': rec['station'], 'next_station': next_station(rec['station'])}

def cmd_outcome_release(outcome_id: str, session: str, steal: bool=False) -> dict:
    assert_not_in_worktree()
    if not isinstance(session, str) or not goals._SESSION_ID_RE.fullmatch(session):
        raise goals.Abort(2, f'{session!r} is not a usable session id')
    now_epoch = _time_now()
    with outcomes_lock():
        data = read_outcomes()
        rec = find_outcome(data, outcome_id)
        held = rec.get('claim') if isinstance(rec.get('claim'), dict) else None
        stole = False
        try:
            live = claim_is_live(held, now_epoch)
        except goals.Abort:
            if not steal:
                raise
            live = True
        held_by = held.get('session_id') if held else None
        if live and held_by != session:
            if not steal:
                raise goals.Abort(2, f'{outcome_id} is claimed by {held_by}, not by {session}; pass --steal to take it anyway')
            stole = True
        rec['claim'] = None
        rec['last_seen'] = goals._now_iso()
        if stole:
            event = 'claim-stolen'
        elif held is not None and held_by != session:
            event = 'claim-cleared'
        else:
            event = None
        if event:
            rec.setdefault('history', []).append({'at': rec['last_seen'], 'event': event, 'from': held_by, 'by': session})
        write_outcomes(data)
    return {'id': outcome_id, 'claimed': False, 'station': rec['station'], 'stolen_from': held_by if stole else None, 'stole': stole}
PEND_BEGIN = '%%PENDINGS:BEGIN%%'
PEND_END = '%%PENDINGS:END%%'
VALID_PENDING_STATUS = frozenset({'open', 'active', 'blocked', 'done'})
STORED_PENDING_STATUS = VALID_PENDING_STATUS | {'parked'}
_ROW_ID_RE = re.compile('^P\\d{2,}$')
_NO_DEPS = {'', '-', '—', '--', 'none', 'n/a'}

def _is_sentence(text: str) -> bool:
    t = text.strip()
    return t.endswith('.') and len(t.split()) >= 5

def _fence_span(text: str, what: str, code: int) -> tuple:
    b = [m.start() for m in re.finditer(f'^{re.escape(PEND_BEGIN)}$', text, re.MULTILINE)]
    e = [m.start() for m in re.finditer(f'^{re.escape(PEND_END)}$', text, re.MULTILINE)]
    if len(b) > 1 or len(e) > 1:
        raise goals.Abort(code, f'ambiguous pending sentinels in {what}: {len(b)} line-anchored {PEND_BEGIN} and {len(e)} {PEND_END}. Refusing to guess which fence is the real one - a wrong guess here rewrites the wrong region of a spec. Give the illustrative one a trailing annotation on BOTH its lines so it is no longer bare, or remove it.')
    if not b or not e or e[0] < b[0]:
        raise goals.Abort(code, f'no {PEND_BEGIN} ... {PEND_END} block found in {what}; every spec in this system carries one (spec 5.1). The sentinels must each be alone on their own line.')
    return (b[0], e[0])

def parse_pending_block(text: str) -> list:
    start, end = _fence_span(text, 'the spec text', 2)
    rows = []
    seen = set()
    for raw in text[start + len(PEND_BEGIN):end].splitlines():
        line = raw.strip()
        if not line:
            continue
        if not line.startswith('|'):
            raise goals.Abort(2, f"line inside the pendings fence is not a table row: {line!r}. The fence is regenerated from its rows, so a line that is not one would be deleted. Move prose outside the sentinels; give a row its leading '|'.")
        cells = [c.strip() for c in line.strip('|').split('|')]
        if cells[0] and (cells[0].lower() == 'id' or set(cells[0]) <= {'-', ':'}):
            continue
        if len(cells) != 4:
            raise goals.Abort(2, f"pending row must have exactly 4 cells (id | description | depends on | status), got {len(cells)}: {line!r}. Every '|' on the line is counted as a cell boundary, including one written '\\|' -- this parser does not honour that escape.")
        rid, desc, deps_raw, status = cells
        if not _ROW_ID_RE.match(rid):
            raise goals.Abort(2, f'row id {rid!r} is not PNN')
        if rid in seen:
            raise goals.Abort(2, f'duplicate row id {rid}')
        seen.add(rid)
        if not _is_sentence(desc):
            raise goals.Abort(2, f"{rid}: description must be a full sentence ending in '.', not a label -- got {desc!r}")
        if status not in VALID_PENDING_STATUS:
            raise goals.Abort(2, f'{rid}: status {status!r} not in {sorted(VALID_PENDING_STATUS)}')
        deps = [] if deps_raw.lower() in _NO_DEPS else [d.strip() for d in deps_raw.split(',') if d.strip()]
        rows.append({'id': rid, 'description': desc, 'depends_on': deps, 'status': status})
    if not rows:
        raise goals.Abort(2, 'the pendings block is empty')
    check_dependencies(rows)
    return rows

def render_pending_block(rows: list) -> str:
    out = [PEND_BEGIN, '', '| id | description | depends on | status |', '|---|---|---|---|']
    for r in rows:
        deps = ', '.join(r['depends_on']) if r['depends_on'] else '—'
        out.append(f'| {r['id']} | {r['description']} | {deps} | {r['status']} |')
    out += ['', PEND_END]
    return '\n'.join(out) + '\n'

def check_dependencies(rows: list) -> None:
    graph = {r['id']: list(r['depends_on']) for r in rows}
    status = {r['id']: r['status'] for r in rows}
    for rid, deps in graph.items():
        for dep in deps:
            if dep not in graph:
                raise goals.Abort(2, f'{rid} depends on {dep}, which is not a row in this block')
    WHITE, GREY, BLACK = (0, 1, 2)
    colour = dict.fromkeys(graph, WHITE)

    def visit(node, trail):
        if colour[node] == GREY:
            cycle = ' -> '.join(trail[trail.index(node):] + [node])
            raise goals.Abort(2, f'dependency cycle: {cycle}')
        if colour[node] == BLACK:
            return
        colour[node] = GREY
        for dep in graph[node]:
            visit(dep, trail + [node])
        colour[node] = BLACK
    for node in graph:
        visit(node, [])
    for rid, deps in graph.items():
        if status[rid] != 'done':
            continue
        unmet = [d for d in deps if status.get(d) != 'done']
        if unmet:
            raise goals.Abort(2, f'{rid} is marked done but depends on {', '.join(unmet)}, which {('is' if len(unmet) == 1 else 'are')} not done')

def unblocked(rows: list) -> list:
    done = {r['id'] for r in rows if r['status'] == 'done'}
    return [r for r in rows if r['status'] not in ('done', 'blocked', 'parked') and all((d in done for d in r['depends_on']))]

def next_pending(rows: list):
    ready = unblocked(rows)
    return ready[0] if ready else None

def _splice(text: str, block: str) -> str:
    start, end = _fence_span(text, 'the spec file being rewritten', 4)
    return text[:start] + block.rstrip('\n') + text[end + len(PEND_END):]

def cmd_pendings_ingest(outcome_id: str, spec_path: str) -> dict:
    assert_not_in_worktree()
    path = Path(spec_path)
    try:
        text = path.read_text(encoding='utf-8')
    except OSError as exc:
        raise goals.Abort(2, f'cannot read spec {spec_path}: {exc}')
    rows = parse_pending_block(text)
    rewritten = _splice(text, render_pending_block(rows))
    with outcomes_lock():
        data = read_outcomes()
        rec = find_outcome(data, outcome_id)
        rec['pendings'] = rows
        rec['last_seen'] = goals._now_iso()
        write_outcomes(data)
    tmp = path.with_name(f'.{path.name}.tmp-{os.getpid()}')
    try:
        tmp.write_text(rewritten, encoding='utf-8')
        os.replace(tmp, path)
    except OSError as exc:
        raise goals.Abort(4, f'cannot rewrite spec {spec_path}: {exc}')
    finally:
        tmp.unlink(missing_ok=True)
    return {'outcome': outcome_id, 'ingested': len(rows), 'spec': str(path), 'next': next_pending(rows), 'open': len([r for r in rows if r['status'] != 'done'])}

def cmd_pendings_set(outcome_id: str, spec_path: str, row_id: str, status: str) -> dict:
    assert_not_in_worktree()
    if status not in VALID_PENDING_STATUS:
        raise goals.Abort(2, f'status {status!r} not in {sorted(VALID_PENDING_STATUS)}')
    if not _ROW_ID_RE.match(row_id):
        raise goals.Abort(2, f'row id {row_id!r} is not PNN')
    path = Path(spec_path)
    try:
        original = path.read_text(encoding='utf-8')
    except OSError as exc:
        raise goals.Abort(2, f'cannot read spec {spec_path}: {exc}')
    start, end = _fence_span(original, 'the spec text', 2)
    head, fence, tail = (original[:start], original[start:end], original[end:])
    lines = fence.split('\n')
    hits = []
    for i, raw in enumerate(lines):
        line = raw.strip()
        if not line.startswith('|'):
            continue
        cells = [c.strip() for c in line.strip('|').split('|')]
        if len(cells) == 4 and cells[0] == row_id:
            hits.append((i, cells))
    if len(hits) != 1:
        raise goals.Abort(2, f'no row {row_id} in the fence' if not hits else f'{len(hits)} rows in the fence carry the id {row_id}')
    i, cells = hits[0]
    cells[3] = status
    lines[i] = '| ' + ' | '.join(cells) + ' |'
    try:
        path.write_text(head + '\n'.join(lines) + tail, encoding='utf-8')
    except OSError as exc:
        raise goals.Abort(4, f'cannot rewrite spec {spec_path}: {exc}')
    try:
        result = cmd_pendings_ingest(outcome_id, str(path))
    except goals.Abort as exc:
        if exc.code == 4:
            raise goals.Abort(4, f'the ledger committed {status} for {row_id} and the spec fence carries it, but the fence was not canonically re-rendered: {exc.message}. Do NOT hand-restore the spec; that would revert the fence under a committed ledger. Re-run: pendings-ingest --outcome {outcome_id} --spec {spec_path}')
        try:
            path.write_text(original, encoding='utf-8')
        except OSError as restore_exc:
            raise goals.Abort(4, f'{exc.message}; and the spec {spec_path} still carries the un-ingested edit because restoring it failed: {restore_exc}')
        raise
    return {**result, 'row': row_id, 'status': status}

def cmd_pendings_next(outcome_id: str) -> dict:
    data = read_outcomes()
    rec = find_outcome(data, outcome_id)
    rows = rec.get('pendings', [])
    done = len([r for r in rows if r['status'] == 'done'])
    ready = unblocked(rows) if rows else []
    return {'outcome': outcome_id, 'statement': rec['statement'], 'station': rec['station'], 'next_station': next_station(rec['station']), 'next': ready[0] if ready else None, 'blocked': len(rows) - len(ready) - done, 'done': done, 'total': len(rows)}
