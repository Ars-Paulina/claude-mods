#!/usr/bin/env python3
"""M0 prep self-check: asserts the deliverable counts. Exit 0 = all pass, 1 = a check failed.
Run: python3 m0-prep/scripts/selfcheck.py   (needs data/ built by build_all.sh; data/ is gitignored)
"""
import csv, json, os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

fails = []


def check(name, ok, detail=''):
    print('%s %s %s' % ('PASS' if ok else 'FAIL', name, detail))
    if not ok:
        fails.append(name)


def rows(name):
    with open(os.path.join(C.DATA, name)) as f:
        return list(csv.DictReader(f))


def main():
    if not os.path.isdir(C.DATA):
        print('FAIL data/ missing: run m0-prep/scripts/build_all.sh first')
        return 1
    s = C.load_json('sessions.json')['sessions']
    check('sessions 38..45', 38 <= len(s) <= 45, len(s))
    st = {k: sum(1 for x in s if x['stratum'] == k) for k in 'ABC'}
    check('strata A=15 B=15 C=10', st == {'A': 15, 'B': 15, 'C': 10}, st)
    check('sessions unique', len({x['id'] for x in s}) == len(s))
    sheet = rows('claimed-vs-git.csv')
    check('sheet: one row per session', {r['session_id'] for r in sheet} == {x['id'] for x in s}, len(sheet))
    check('sheet: label + pedro_notes blank', all(r['label'] == '' and r['pedro_notes'] == '' for r in sheet))
    cf = C.load_json('claim-fixture.json')['cases']
    pos, neg = [c for c in cf if c['label'] == 'pos'], [c for c in cf if c['label'] == 'neg']
    check('claim fixture pos>=30', len(pos) >= 30, len(pos))
    check('claim fixture neg>=30', len(neg) >= 30, len(neg))
    check('claim fixture ids unique', len({c['id'] for c in cf}) == len(cf))
    af = C.load_json('approval-fixture.json')['cases']
    check('approval fixtures>=10', len(af) >= 10, len(af))
    check('approval fixtures have both classes', {a['expected']['is_approval'] for a in af} == {True, False})
    cs = rows('canary-sample.csv')
    check('canary sample == 20', len(cs) == 20, len(cs))
    check('canary labels blank', all(r['label'] == '' and r['pedro_notes'] == '' for r in cs))
    dt = json.load(open(os.path.join(C.ROOT, 'duty-table.json')))
    check('duty table has 5 duties', len(dt['duties']) == 5, len(dt['duties']))
    # privacy: no obvious raw secret in any data file; no data file tracked by git
    pat = re.compile(r'(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|password=(?!\[MASKED))', re.I)
    hit = [f for f in os.listdir(C.DATA) if os.path.isfile(os.path.join(C.DATA, f)) and pat.search(open(os.path.join(C.DATA, f)).read())]
    check('no raw secret patterns in data/', not hit, hit)
    tracked = subprocess.run(['git', '-C', C.ROOT, 'ls-files', '--', 'data'], capture_output=True, text=True).stdout.strip()
    check('data/ not tracked by git (repo is public)', tracked == '', tracked[:80])
    print('SELFCHECK', 'OK' if not fails else 'FAILED: ' + ', '.join(fails))
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
