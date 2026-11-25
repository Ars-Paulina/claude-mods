#!/usr/bin/env python3
"""Canary precision sample: 20 of the canary ALERT events in ~/.claude/logs/canary-check.log (gap G1-2).
Spread over months, <=2 per session. Output data/canary-sample.csv, labels BLANK for Pedro:
  label = real-stale (the session was degrading around then) | false-alarm | unclear
WRITE-ONCE like 02_sheet.py: kept if present; --regen rebuilds; labeled file needs --discard-labels.
"""
import csv, collections, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common as C

N, PER_SESSION, PER_MONTH = 20, 2, 4
COLS = ['alert_id', 'ts_utc', 'session_id', 'project_folder', 'transcript_found', 'window_missed', 'reason',
        'stop_event', 'alerts_in_session', 'session_rows', 'compactions', 'view_cmd', 'label', 'pedro_notes']


def main():
    out_csv = os.path.join(C.DATA, 'canary-sample.csv')
    if not C.guard_write(out_csv, '--regen' in sys.argv, '--discard-labels' in sys.argv):
        return
    rng = random.Random(C.SEED + 3)
    idx = C.transcript_index()
    can = C.canary_stats()
    events = [(e['ts'], s, e) for s, d in can.items() for e in d['alert_events'] if s in idx]
    total_all = sum(len(d['alert_events']) for d in can.values())
    rng.shuffle(events)
    per_s, per_m, picked = collections.Counter(), collections.Counter(), []
    for ts, s, e in events:
        if len(picked) == N:
            break
        if per_s[s] >= PER_SESSION or per_m[ts[:7]] >= PER_MONTH:
            continue
        per_s[s] += 1
        per_m[ts[:7]] += 1
        picked.append((ts, s, e))
    picked.sort()
    rows = []
    for k, (ts, s, e) in enumerate(picked, 1):
        f = C.extract(C.run_fsearch_show(s))
        rows.append({'alert_id': 'CA%02d' % k, 'ts_utc': ts, 'session_id': s, 'project_folder': C.project_of(idx[s][0]),
                     'transcript_found': 1, 'window_missed': e['window'], 'reason': e['reason'],
                     'stop_event': int(e['stop_event']), 'alerts_in_session': can[s]['alerts'],
                     'session_rows': f['rows'], 'compactions': f['compactions'],
                     'view_cmd': '~/.claude/bin/fsearch --show %s --tail 60' % s[:8], 'label': '', 'pedro_notes': ''})
    with open(out_csv, 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=COLS)
        w.writeheader()
        w.writerows(rows)
    print('canary sample: %d of %d alert events (%d with transcript)' % (len(rows), total_all, len(events)), file=sys.stderr)


if __name__ == '__main__':
    main()
