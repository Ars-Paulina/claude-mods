"""Shared helpers for the M0 prep scripts.

Transcripts are read ONLY through ~/.claude/bin/fsearch (it masks secrets).
Nothing here opens a .jsonl; we only list/stat files to find session ids.
"""
import glob, os, re, subprocess, json, collections

HOME = os.path.expanduser('~')
FSEARCH = os.path.join(HOME, '.claude', 'bin', 'fsearch')
CANARY_LOG = os.path.join(HOME, '.claude', 'logs', 'canary-check.log')
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)            # m0-prep/
DATA = os.path.join(ROOT, 'data')       # gitignored: real session pointers/text
SEED = 20261124

ROW = re.compile(r'^\s*(\d+) (user|assistant|tool|result|\w+): ?(.*)$')


def run_fsearch_show(sid, tools=True, width=4000):
    """Return list of (lineno, role, text) from fsearch --show. Masked by fsearch."""
    cmd = [FSEARCH, '--show', sid, '--width', str(width)]
    if tools:
        cmd.append('--tools')
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('fsearch failed rc=%s for %s' % (r.returncode, sid))
    rows = []
    for ln in r.stdout.splitlines()[1:]:
        m = ROW.match(ln)
        if m:
            rows.append((int(m.group(1)), m.group(2), m.group(3)))
    return rows


def transcript_index():
    """session id -> (path, mtime, size). Metadata only, content never read."""
    idx = {}
    for p in glob.glob(os.path.join(HOME, '.claude', 'projects', '*', '*.jsonl')):
        try:
            st = os.stat(p)
        except OSError:
            continue
        idx[os.path.basename(p)[:-6]] = (p, st.st_mtime, st.st_size)
    return idx


def canary_stats():
    """session -> {'alerts': n, 'misses': n, 'alert_lines': [(ts, window, reason)]}"""
    out = collections.defaultdict(lambda: {'alerts': 0, 'misses': 0, 'alert_events': []})
    for ln in open(CANARY_LOG):
        m = re.search(r'session=(\S+)', ln)
        if not m:
            continue
        d = out[m.group(1)]
        if ' ALERT ' in ln:
            d['alerts'] += 1
            w = re.search(r'ALERT \((\w+)\) (\d+/\d+)', ln)
            d['alert_events'].append({'ts': ln.split()[0], 'reason': w.group(1) if w else '?',
                                      'window': w.group(2) if w else '?',
                                      'stop_event': '[stop-event]' in ln})
        else:
            d['misses'] += 1
    return out


def project_of(path):
    return os.path.basename(os.path.dirname(path))


def decode_project(name):
    """'-home-pedro-Projects-foo-bar' -> existing dir path, or None. Greedy walk on the FS."""
    toks = name.lstrip('-').split('-')

    def walk(base, i):
        if i == len(toks):
            return base
        for j in range(len(toks), i, -1):
            for sep in ('-', '_', '.'):
                cand = sep.join(toks[i:j])
                p = os.path.join(base, cand)
                if os.path.isdir(p):
                    r = walk(p, j)
                    if r:
                        return r
        return None
    return walk('/', 0)


def git(repo, *args, timeout=20):
    r = subprocess.run(['git', '-C', repo] + list(args), capture_output=True, text=True, timeout=timeout)
    return r.returncode, r.stdout.strip()


# --- claim vocabulary (shared by sheet + fixture mining) -------------------
CLAIM_RE = re.compile(
    r"\b(done|fixed|tested|tests? pass(?:ed|ing)?|passing|all green|works now|working now|shipped|"
    r"committed|pushed|merged|deployed|complete[d]?|verified|resolved|implemented|finished)\b", re.I)
NEG_CLAIM_RE = re.compile(r"\b(not (?:yet )?(?:done|fixed|tested|verified|committed|pushed)|haven't|hasn't|"
                          r"didn't|couldn't|can't|failed|failing|still|todo|next)\b", re.I)
COMMIT_OUT = re.compile(r'\[([\w./-]+) ([0-9a-f]{7,40})\]')
SHA = re.compile(r'\b[0-9a-f]{7,40}\b')
TEST_CMD = re.compile(r'\b(pytest|vitest|jest|pnpm (?:run )?(?:test|lint|build|typecheck)|npm (?:run )?test|'
                      r'cargo test|go test|make test|tsc|eslint|biome|playwright test|node --test)\b')


def save_json(name, obj):
    os.makedirs(DATA, exist_ok=True)
    with open(os.path.join(DATA, name), 'w') as f:
        json.dump(obj, f, indent=1, sort_keys=True)


def load_json(name):
    with open(os.path.join(DATA, name)) as f:
        return json.load(f)


# --- per-session feature extraction (from fsearch rows) --------------------
CMD_RE = re.compile(r'"command":\s*"((?:[^"\\]|\\.)*)')
CONT_RE = re.compile(r'^(This session is being continued|<system-reminder>.*compact)', re.I)


def tool_name(text):
    return text.split(' ', 1)[0]


def tool_cmd(text):
    m = CMD_RE.search(text)
    return m.group(1).replace('\\n', '; ') if m else ''


def pair_results(rows):
    """Yield (tool_row, result_text) pairing each tool row with the next result row."""
    out, pending = [], None
    for ln, role, text in rows:
        if role == 'tool':
            if pending:
                out.append((pending, ''))
            pending = (ln, text)
        elif role == 'result' and pending:
            out.append((pending, text))
            pending = None
    if pending:
        out.append((pending, ''))
    return out


def extract(rows):
    f = {'claims': [], 'commits': [], 'pushes': [], 'edits': [], 'tests': [], 'cmd_counts': {},
         'compactions': 0, 'rows': len(rows)}
    cmds = collections.Counter()
    for (ln, text), res in pair_results(rows):
        name, cmd = tool_name(text), tool_cmd(text)
        if name in ('Edit', 'Write', 'MultiEdit', 'NotebookEdit'):
            f['edits'].append(ln)
        if name == 'Bash':
            cmds[cmd[:160]] += 1
            if re.search(r'\bgit\b[^;&|]*\bcommit\b', cmd):
                m = COMMIT_OUT.search(res)
                f['commits'].append({'line': ln, 'sha': m.group(2) if m else None,
                                     'branch': m.group(1) if m else None,
                                     'ok': not res.startswith('Exit code')})
            if re.search(r'\bgit\b[^;&|]*\bpush\b', cmd):
                ok = bool(re.search(r'->|Everything up-to-date|\[new branch\]', res)) and not res.startswith('Exit code')
                f['pushes'].append({'line': ln, 'ok': ok})
            if TEST_CMD.search(cmd):
                f['tests'].append({'line': ln, 'err': bool(re.search(r'\b(FAIL|failed|Error|exit code [1-9])', res))})
    for ln, role, text in rows:
        if role == 'user' and CONT_RE.search(text):
            f['compactions'] += 1
        if role == 'assistant' and len(text) > 20:
            kws = sorted({m.group(1).lower() for m in CLAIM_RE.finditer(text)})
            if kws and not NEG_CLAIM_RE.search(text[:200]):
                f['claims'].append({'line': ln, 'kw': kws})
    f['loop_cmds'] = sorted([(c, n) for c, n in cmds.items() if n >= 3 and c], key=lambda x: -x[1])[:3]
    f['last_edit'] = max(f['edits']) if f['edits'] else None
    f['last_test'] = max((t['line'] for t in f['tests']), default=None)
    f['tests_after_last_edit'] = (f['last_test'] is not None and (f['last_edit'] is None or f['last_test'] > f['last_edit']))
    return f
