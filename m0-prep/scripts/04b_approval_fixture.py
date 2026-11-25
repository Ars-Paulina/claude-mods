#!/usr/bin/env python3
"""Build data/approval-fixture.json from data/approval-picks.json (C-8, PRD FR-14).
Rule under test: a message is an approval only if it names action + target, or is a bare yes/ok/go/approve
answering the question DIRECTLY before it (bound in `scope`); anything else is not an approval.
Text comes through fsearch (masked); the record shape mirrors the FR-14 approval record
{message_id, ts, exact_text, scope} + the expected classification.
"""
import os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C


def main():
    picks = C.load_json('approval-picks.json')
    by = {}
    for p in picks['picks']:
        by.setdefault(p['session'], []).append(p)
    out = []
    for sid, ps in by.items():
        rows = C.run_fsearch_show(sid, tools=False)
        for p in ps:
            i = next(k for k, r in enumerate(rows) if r[0] == p['line'] and r[1] == 'user')
            prev = next((r for r in reversed(rows[:i]) if r[1] == 'assistant'), None)
            ptxt = prev[2].replace('\n', ' ')[-170:] if prev else ''
            out.append({'id': '%s:%d' % (sid[:8], p['line']), 'session': sid, 'line': p['line'],
                        'message_id': None,            # filled by the real hook; transcript has none
                        'exact_text': rows[i][2][:200], 'prev_assistant_line': prev[0] if prev else None,
                        'prev_assistant_tail': ptxt, 'prev_ends_with_question': bool(re.search(r'\?', ptxt[-120:])),
                        'expected': {'is_approval': p['is_approval'], 'scope': p['binds_to'], 'reason': p['reason']}})
    out.sort(key=lambda x: (not x['expected']['is_approval'], x['id']))
    C.save_json('approval-fixture.json', {'labeled_by': picks['labeled_by'], 'cases': out})
    print('approval fixture:', len(out), 'approve=%d not=%d' % (
        sum(x['expected']['is_approval'] for x in out), sum(not x['expected']['is_approval'] for x in out)), file=sys.stderr)


if __name__ == '__main__':
    main()
