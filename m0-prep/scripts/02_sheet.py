#!/usr/bin/env python3
"""Claimed-vs-git sheet, one row per sampled session (PM §5 M0).

data/claimed-vs-git.csv   pointers + counts + git facts. `label` and `pedro_notes` stay BLANK for Pedro
                          (ok / false done / loop / stale / old-hook-false-positive).
data/sheet-view.md        local reading aid with masked last-claim excerpts. Never committed (FR-21).
Columns starting hint_ are machine hints, not labels.

WRITE-ONCE: an existing claimed-vs-git.csv is kept (rebuilding re-reads live git/transcripts and drifts).
`--regen` rebuilds it, but never over a file that has any label/old_hook_false_positive/pedro_notes text;
that needs `--discard-labels` (destroys them). Refusals are printed loudly; exit stays 0.
"""
import csv, datetime, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

COLS = ['session_id', 'stratum', 'project_folder', 'repo_path', 'repo_found', 'started_utc', 'ended_utc',
        'rows', 'canary_alerts', 'canary_misses', 'compactions', 'claim_rows', 'last_claim_line',
        'claim_keywords', 'claimed_commit_calls_ok', 'claimed_push_calls_ok', 'shas_in_output',
        'git_window_commits', 'git_window_shas', 'git_branches', 'git_commits_on_remote',
        'tests_run', 'tests_after_last_edit', 'hint_loop_cmds', 'hint_claim_vs_git', 'view_cmd',
        'label', 'old_hook_false_positive', 'pedro_notes']


def birth(path):
    r = subprocess.run(['stat', '-c', '%W', path], capture_output=True, text=True)
    try:
        v = int(r.stdout.strip())
        return v if v > 0 else None
    except ValueError:
        return None


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def git_facts(repo, start, end):
    rc, out = C.git(repo, 'log', '--all', '--since=@%d' % start, '--until=@%d' % end, '--format=%h')
    shas = out.split() if rc == 0 and out else []
    branches, remote = set(), 0
    for s in shas[:12]:
        _, b = C.git(repo, 'branch', '-a', '--contains', s)
        for x in b.splitlines()[:4]:
            branches.add(x.strip('* ').strip())
        _, rb = C.git(repo, 'branch', '-r', '--contains', s)
        remote += 1 if rb else 0
    return shas, sorted(branches)[:6], remote


def main():
    out_csv = os.path.join(C.DATA, 'claimed-vs-git.csv')
    if not C.guard_write(out_csv, '--regen' in sys.argv, '--discard-labels' in sys.argv):
        return
    sess = C.load_json('sessions.json')['sessions']
    idx = C.transcript_index()
    rows_out, view = [], ['# Local reading aid (masked excerpts). DO NOT COMMIT.\n']
    for m in sess:
        sid = m['id']
        path = idx[sid][0]
        rows = C.run_fsearch_show(sid)
        f = C.extract(rows)
        end = int(idx[sid][1])
        start = birth(path) or end - 4 * 3600
        repo = C.decode_project(m['project'])
        is_git = bool(repo) and C.git(repo, 'rev-parse', '--git-dir')[0] == 0
        shas, branches, remote = git_facts(repo, start, end + 120) if is_git else ([], [], 0)
        kws = sorted({k for c in f['claims'] for k in c['kw']})
        commit_ok = sum(1 for c in f['commits'] if c['ok'])
        push_ok = sum(1 for p in f['pushes'] if p['ok'])
        hints = []
        tail = {k for c in f['claims'][-3:] for k in c['kw']}   # what the session ended up claiming
        if 'committed' in tail and is_git and not shas:
            hints.append('claims committed but 0 commits in git window')
        if 'pushed' in tail and shas and remote == 0:
            hints.append('claims pushed but no window commit on a remote ref')
        if tail & {'tested', 'passing', 'all green', 'verified', 'works now'} and f['edits'] and not f['tests_after_last_edit']:
            hints.append('claims done, no test/lint/build after last edit')
        if f['loop_cmds']:
            hints.append('same Bash cmd x3+')
        rec = {
            'session_id': sid, 'stratum': m['stratum'], 'project_folder': m['project'],
            'repo_path': repo or '', 'repo_found': int(is_git), 'started_utc': iso(start), 'ended_utc': iso(end),
            'rows': f['rows'], 'canary_alerts': m['canary_alerts'], 'canary_misses': m['canary_misses'],
            'compactions': f['compactions'], 'claim_rows': len(f['claims']),
            'last_claim_line': f['claims'][-1]['line'] if f['claims'] else '',
            'claim_keywords': ' '.join(kws), 'claimed_commit_calls_ok': commit_ok,
            'claimed_push_calls_ok': push_ok,
            'shas_in_output': ' '.join(c['sha'] for c in f['commits'] if c['sha'])[:120],
            'git_window_commits': len(shas), 'git_window_shas': ' '.join(shas[:6]),
            'git_branches': ' | '.join(branches), 'git_commits_on_remote': remote,
            'tests_run': len(f['tests']), 'tests_after_last_edit': int(f['tests_after_last_edit']),
            'hint_loop_cmds': ' ; '.join('%dx %s' % (n, c[:50]) for c, n in f['loop_cmds']),
            'hint_claim_vs_git': ' / '.join(hints),
            'view_cmd': '~/.claude/bin/fsearch --show %s --tail 40' % sid[:8], 'label': '', 'old_hook_false_positive': '', 'pedro_notes': ''}
        rows_out.append(rec)
        last = f['claims'][-1]['line'] if f['claims'] else None
        txt = next((t for ln, r, t in rows if ln == last), '')[:220].replace('\n', ' ')
        view.append('## %s  %s  %s\n- git window commits: %d, remote: %d, hints: %s\n- last claim L%s: %s\n' % (
            sid[:8], m['stratum'], m['project'], len(shas), remote, rec['hint_claim_vs_git'] or '-', last, txt))
    with open(out_csv, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows_out)
    open(os.path.join(C.DATA, 'sheet-view.md'), 'w').write('\n'.join(view))
    print('sheet rows:', len(rows_out), 'repo_found:', sum(r['repo_found'] for r in rows_out), file=sys.stderr)


if __name__ == '__main__':
    main()
