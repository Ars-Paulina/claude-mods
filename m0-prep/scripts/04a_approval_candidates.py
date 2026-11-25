#!/usr/bin/env python3
"""Mine short user replies + the assistant message right before them as approval-fixture candidates (C-8).
Output data/approval-candidates.json. A review pass writes data/approval-picks.json; 04b builds the fixture.
"""
import os, random, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

SHORT = 110
APPROVAL_WORDS = re.compile(r"^(y(es|ep|eah)?|ok(ay)?|go( ahead)?|do it|approved?|sure|yes please|proceed|push|merge|ship|sounds good|"
                            r"lgtm|fine|go for it|1|2|a|b|no|nope|wait|stop|hold|maybe)\b", re.I)


def main():
    rng = random.Random(C.SEED + 2)
    idx = C.transcript_index()
    sess = [m['id'] for m in C.load_json('sessions.json')['sessions']]
    now = time.time()
    others = [s for s, v in idx.items() if s not in sess and 30_000 < v[2] < 3_000_000 and now - v[1] > 3 * 3600
              and C.project_of(v[0]) != '-home-pedro']
    rng.shuffle(others)
    out = []
    for sid in sess + others[:60]:
        try:
            rows = C.run_fsearch_show(sid, tools=False)
        except Exception:
            continue
        for i, (ln, role, text) in enumerate(rows):
            if role != 'user' or len(text) > SHORT or text.startswith(('<', '[', '/')) or len(text) < 2:
                continue
            prev = next((r for r in reversed(rows[:i]) if r[1] == 'assistant'), None)
            out.append({'session': sid, 'line': ln, 'user': text, 'approvalish': bool(APPROVAL_WORDS.search(text.strip())),
                        'prev_line': prev[0] if prev else None,
                        'prev_tail': prev[2][-170:].replace('\n', ' ') if prev else '',
                        'prev_is_question': bool(prev and re.search(r'\?', prev[2][-300:]))})
    rng.shuffle(out)
    C.save_json('approval-candidates.json', out)
    print(len(out), 'approvalish:', sum(o['approvalish'] for o in out), file=sys.stderr)


if __name__ == '__main__':
    main()
