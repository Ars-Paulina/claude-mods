#!/usr/bin/env python3
"""Build the stratified ~40-session M0 sample (PM §5, C-1).

Strata (fixed seed, one session = one stratum, <=3 per project folder per stratum):
  A  canary-fired     15  sessions with >=1 canary ALERT line in ~/.claude/logs/canary-check.log
  B  canary-silent    15  sessions the canary watched (log lines) but never alerted
  C  git-heavy-done   10  drawn from a random pool, scored by git-commit results x done-claims
Output: data/sessions.json  (pointers + metadata only; no transcript text)
"""
import os, sys, time, random, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

N = {'A': 15, 'B': 15, 'C': 10}
CAP_PER_PROJECT = 3
POOL_C = 1200
MIN_SIZE, MAX_SIZE = 40_000, 4_000_000
MAX_AGE_DAYS = 150


def spread(cands, n, rng, cap=CAP_PER_PROJECT):
    """Round-robin over projects after a seeded shuffle, so no folder dominates."""
    rng.shuffle(cands)
    byproj = collections.defaultdict(list)
    for c in cands:
        byproj[c['project']].append(c)
    keys = sorted(byproj)
    rng.shuffle(keys)
    out, rounds = [], 0
    while len(out) < n and rounds < cap:
        for k in keys:
            if rounds < len(byproj[k]) and len(out) < n:
                out.append(byproj[k][rounds])
        rounds += 1
    return out


def main():
    rng = random.Random(C.SEED)
    idx, can = C.transcript_index(), C.canary_stats()
    now = time.time()
    ok = {s: v for s, v in idx.items()
          if MIN_SIZE <= v[2] <= MAX_SIZE and now - v[1] > 3 * 3600 and now - v[1] < MAX_AGE_DAYS * 86400
          and C.project_of(v[0]) != '-home-pedro'}  # '-home-pedro' = scratch/headless home sessions
    meta = lambda s: {'id': s, 'project': C.project_of(idx[s][0]), 'mtime': int(idx[s][1]), 'size': idx[s][2]}
    A = [meta(s) for s in ok if can.get(s, {}).get('alerts', 0) > 0]
    B = [meta(s) for s in ok if s in can and can[s]['alerts'] == 0 and can[s]['misses'] >= 3]
    rest = [s for s in ok if s not in {a['id'] for a in A} | {b['id'] for b in B}]
    rng.shuffle(rest)
    print('pools: A=%d B=%d rest=%d' % (len(A), len(B), len(rest)), file=sys.stderr)
    chosen = {'A': spread(A, N['A'], rng), 'B': spread(B, N['B'], rng)}
    taken = {c['id'] for v in chosen.values() for c in v}
    pool = [meta(s) for s in rest if s not in taken][:POOL_C]
    scored = []
    for m in pool:
        try:
            f = C.extract(C.run_fsearch_show(m['id']))
        except Exception as e:
            continue
        good_commits = sum(1 for c in f['commits'] if c['ok'])
        if good_commits >= 2 and len(f["claims"]) >= 1:
            m['score'] = good_commits * len(f['claims'])
            scored.append(m)
    scored.sort(key=lambda m: -m['score'])
    chosen['C'] = spread(scored[:40], N['C'], rng, cap=2)
    out = []
    for stratum in 'ABC':
        for m in sorted(chosen[stratum], key=lambda m: m['mtime']):
            m['stratum'] = stratum
            m['canary_alerts'] = can.get(m['id'], {}).get('alerts', 0)
            m['canary_misses'] = can.get(m['id'], {}).get('misses', 0)
            m.pop('score', None)
            out.append(m)
    C.save_json('sessions.json', {'seed': C.SEED, 'strata': N, 'cap_per_project': CAP_PER_PROJECT,
                                  'pool_sizes': {'A': len(A), 'B': len(B), 'C_scored': len(scored)},
                                  'sessions': out})
    print('sessions:', len(out), {k: len(v) for k, v in chosen.items()}, file=sys.stderr)


if __name__ == '__main__':
    main()
