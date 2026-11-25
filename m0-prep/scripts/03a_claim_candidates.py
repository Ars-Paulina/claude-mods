#!/usr/bin/env python3
"""Mine turn-final assistant replies (what the Stop hook sees as last_assistant_message) as claim-detector
candidates. Pool = the 40 sampled sessions + 70 more random sessions (seeded). Output data/claim-candidates.json.
A human/Claude review pass then writes data/claim-picks.json (pointers + label); 03b builds the fixture.
"""
import os, random, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

EXTRA = 70


def final_replies(rows):
    out = []
    for i, (ln, role, text) in enumerate(rows):
        if role != 'assistant' or len(text) < 25:
            continue
        nxt = next((r for r in rows[i + 1:] if r[1] in ('assistant', 'user')), None)
        if nxt is None or nxt[1] == 'user':
            out.append((ln, text))
    return out


def kind(text):
    tail = text[-400:] + ' ' + text[:300]
    q = text.rstrip().endswith('?')
    if C.CLAIM_RE.search(tail) and not q:
        return 'pos?'
    if not C.CLAIM_RE.search(text):
        return 'neg-plain'
    return 'neg-hard'      # claim words present but negated / question / planning


def main():
    rng = random.Random(C.SEED + 1)
    sess = [m['id'] for m in C.load_json('sessions.json')['sessions']]
    idx = C.transcript_index()
    now = time.time()
    others = [s for s, v in idx.items() if s not in sess and 30_000 < v[2] < 3_000_000 and now - v[1] > 3 * 3600
              and C.project_of(v[0]) != '-home-pedro']
    rng.shuffle(others)
    pool = sess + others[:EXTRA]
    cands = []
    for sid in pool:
        try:
            rows = C.run_fsearch_show(sid, tools=False)
        except Exception:
            continue
        fr = final_replies(rows)
        rng.shuffle(fr)
        for ln, text in fr[:6]:
            t = text.replace('\n', ' ')
            cands.append({'session': sid, 'line': ln, 'auto_kind': kind(text), 'len': len(text),
                          'text': t if len(t) <= 600 else t[:300] + ' [...] ' + t[-300:]})
    C.save_json('claim-candidates.json', cands)
    from collections import Counter
    print(len(cands), Counter(c['auto_kind'] for c in cands), file=sys.stderr)


if __name__ == '__main__':
    main()
