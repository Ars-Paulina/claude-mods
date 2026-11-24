#!/usr/bin/env bash
# Self-check for search-delegate.js. Run: bash scripts/search-delegate.test.sh
H="$(dirname "$0")/search-delegate.js"; fail=0
S="selftest-$$"; P="p1"
trap 'rm -f ~/.claude/cache/search-delegate/selftest-$$*.json' EXIT

ev() { # tool, input-json, [extra fields]
  echo "{\"session_id\":\"$S\",\"prompt_id\":\"$P\",\"tool_name\":\"$1\",\"tool_input\":$2${3:+,$3}}" | node "$H"
}
grep_() { ev Grep '{"pattern":"x"}' "$@"; }
is() { # got, regex-or-empty, label
  if [ -z "$2" ]; then [ -z "$1" ] && echo "ok   $3" || { echo "FAIL $3: $1"; fail=1; }
  else echo "$1" | grep -q -- "$2" && echo "ok   $3" || { echo "FAIL $3: $1"; fail=1; }; fi
}

is "$(grep_)" "" "1st search passes"
is "$(grep_)" "" "2nd search passes"
is "$(grep_)" "additionalContext.*Explore" "3rd search nudges"
grep_ >/dev/null; grep_ >/dev/null
is "$(grep_)" '"permissionDecision":"deny".*Read still allowed' "6th search denied"
is "$(ev Agent '{"subagent_type":"Explore","prompt":"find x"}')" "" "Agent call passes silently"
is "$(grep_)" "" "after Agent: count reset"

P="p2"
for i in 1 2 3 4 5 6 7; do out=$(grep_ '"agent_id":"a1"'); done
is "$out" "" "subagent (agent_id) never counted or denied"
is "$(grep_)" "" "new prompt_id = fresh count"
grep_ >/dev/null
is "$(ev Bash '{"command":"cd /tmp && grep -rn foo ."}')" "additionalContext" "Bash grep counted (3rd)"
is "$(ev Bash '{"command":"git status"}')" "" "Bash git status not counted"
is "$(ev Bash '{"command":"ps aux | grep node"}')" "" "Bash pipe filter (| grep) not counted"
is "$(ev Bash '{"command":"echo grep; ls"}')" "" "Bash grep as an argument not counted"

# Chained forms count (fresh prompt so each lands at count 3 = nudge).
for cmd in 'X=/tmp; grep -rn foo $X' 'cat f; grep foo f' 'D=/a E=/b; rg foo' 'LC_ALL=C grep foo f' 'ls\nfind . -name x' 'git log || find . -name x'; do
  P="chain-$RANDOM"; grep_ >/dev/null; grep_ >/dev/null
  is "$(ev Bash "{\"command\":\"$cmd\"}")" "additionalContext" "Bash chained counted: $cmd"
done
# grep -n on a known file = targeted read (CLAUDE.md grep-then-Read), not a search; dirs/-r/missing still count.
for cmd in "grep -n isSearch $H" "rg -n foo $H | head -3" "grep -n x $H $H"; do
  P="known-$RANDOM"; grep_ >/dev/null; grep_ >/dev/null
  is "$(ev Bash "{\"command\":\"$cmd\"}")" "" "Bash known-file grep not counted: $cmd"
done
for cmd in "grep -rn foo $(dirname "$H")" "grep -n foo $(dirname "$H")" "grep -n foo $H /no/such/file" "grep -n foo"; do
  P="known-$RANDOM"; grep_ >/dev/null; grep_ >/dev/null
  is "$(ev Bash "{\"command\":\"$cmd\"}")" "additionalContext" "Bash search still counted: $cmd"
done
P="p2b"; for i in 1 2 3; do grep_ >/dev/null; done
ev Bash '{"command":"rg foo"}' >/dev/null; ev Glob '{"pattern":"*"}' >/dev/null
is "$(SEARCH_DELEGATE_MODE=nudge grep_)" "additionalContext" "mode nudge at 6 -> nudge not deny"
is "$(SEARCH_DELEGATE_MODE=off grep_)" "" "mode off -> silent"
is "$(ev Read '{"file_path":"/x"}')" "" "Read never touched"
is "$(echo 'not json' | node "$H"; echo "rc=$?")" "^rc=0$" "malformed input -> pass, exit 0"

# Latency: 20 runs, p95 < 50 ms.
P="lat"; ts=()
# Payloads without prompt_id: only the UserPromptSubmit hook marks a new prompt.
S="selftest-$$-noid"
np() { echo "{\"session_id\":\"$S\",\"tool_name\":\"Grep\",\"tool_input\":{\"pattern\":\"x\"}}" | node "$H"; }
for i in 1 2 3 4 5; do np >/dev/null; done
is "$(np)" '"permissionDecision":"deny"' "no prompt_id: 6th search still denied"
is "$(echo "{\"session_id\":\"$S\",\"hook_event_name\":\"UserPromptSubmit\",\"prompt\":\"next\"}" | node "$H")" "" "UserPromptSubmit prints nothing"
is "$(np)" "" "no prompt_id: new user prompt = fresh count"

for i in $(seq 20); do a=$(date +%s%N); grep_ >/dev/null; ts+=($(( ($(date +%s%N)-a)/1000000 ))); done
p95=$(printf '%s\n' "${ts[@]}" | sort -n | sed -n 19p)
[ "$p95" -lt 50 ] && echo "ok   latency p95 ${p95}ms" || { echo "FAIL latency p95 ${p95}ms"; fail=1; }
exit $fail
