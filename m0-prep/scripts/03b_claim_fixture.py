#!/usr/bin/env python3
"""Build data/claim-fixture.json from data/claim-picks.json (pointers + label).
Text is re-read through fsearch (masked) and trimmed to head+tail 300 chars (FR-21: minimal).
label 'pos' = the reply asserts work is done/fixed/tested/pushed/etc. (what FR-1 must catch)
label 'neg' = no completion claim: question to Pedro, in-progress, blocked/failed, info, side-task JSON.
Tags help M1 score hard cases separately. labeled_by is recorded: these are NOT Pedro labels.
"""
import os, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C


def main():
    picks = C.load_json('claim-picks.json')
    by_sess = {}
    for p in picks['picks']:
        by_sess.setdefault(p['session'], []).append(p)
    out = []
    for sid, ps in by_sess.items():
        rows = {ln: t for ln, r, t in C.run_fsearch_show(sid, tools=False) if r == 'assistant'}
        for p in ps:
            t = rows[p['line']].replace('\n', ' ')
            full_len = len(t)
            if full_len > 600:
                t = t[:300] + ' [...] ' + t[-300:]
            out.append({'id': '%s:%d' % (sid[:8], p['line']), 'session': sid, 'line': p['line'], 'label': p['label'],
                        'text': t, 'tags': sorted(filter(None, [
                            'ends_with_question' if re.search(r'\?\W*(⟦[^⟧]*⟧)?\W*(\[[^\]]*\])?\W*$', t[-60:]) else '',
                            'long_trimmed' if full_len > 600 else '',
                            'json_side_task' if t.lstrip().startswith(('{', '```')) else '',
                            'claim_word_but_neg' if p['label'] == 'neg' and C.CLAIM_RE.search(t) else '']))})
    out.sort(key=lambda x: (x['label'], x['id']))
    C.save_json('claim-fixture.json', {'labeled_by': picks['labeled_by'], 'cases': out})
    n = lambda l: sum(1 for x in out if x['label'] == l)
    print('claim fixture: pos=%d neg=%d' % (n('pos'), n('neg')), file=sys.stderr)


if __name__ == '__main__':
    main()
