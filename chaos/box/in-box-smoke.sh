#!/bin/sh
# Runs inside the box as root (called by smoke.sh). Prints PASS/FAIL per step.
set -u
. /opt/chaos/box/env.sh
fails=0
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1"; fails=$((fails + 1)); }
step() { name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(eval(process.argv[1]))})" "$1"; }

ip -o addr; ip route
# --network none: the only address is on lo and there is no route at all.
step no-network sh -c '[ -z "$(ip -o addr | grep -v " lo ")" ] && [ -z "$(ip route; ip -6 route | grep -v "^::1 ")" ]'
t0=$(date +%s%N)
step up /opt/chaos/box/up.sh
echo "solo start: $(( ($(date +%s%N) - t0) / 1000000 )) ms"

echo 1 > /run/chaos/t0; echo '{}' > /run/chaos/ids.json
step run-chaos-layout as_ftown sh -c 'cat /run/chaos/t0 /run/chaos/ids.json >/dev/null && touch /run/chaos/agents/w && rm /run/chaos/agents/w'
step hook-script as_ftown sh -c 'command -v jq curl bash >/dev/null && cmp "$CHAOS_HOOK_SCRIPT" /home/ftown/.ftown/notify.sh'
cat > /run/chaos/scripts/sleeper.sh <<'S'
#!/bin/sh
echo "fake agent $FTOWN_SESSION_ID up"
exec sleep 100000
S
chmod 0755 /run/chaos/scripts/sleeper.sh

out=$(as_ftown ftown sessions create --shell claude --command /run/chaos/scripts/sleeper.sh --name root --workdir /work/repo 2>&1)
echo "$out"
rootid=$(printf '%s' "$out" | json 'j.id ?? j.session?.id ?? j.sessionId' 2>/dev/null || true)
step create-root test -n "$rootid"
out=$(as_ftown ftown sessions create --shell claude --command /run/chaos/scripts/sleeper.sh --name child1 --workdir /work/repo --parent-id "$rootid" 2>&1)
echo "$out"
childid=$(printf '%s' "$out" | json 'j.id ?? j.session?.id ?? j.sessionId' 2>/dev/null || true)
step create-child test -n "$childid"

out=$(as_ftown ftown harness mail send "$childid" --type task "CHAOS-M-1 from=external to=child1" 2>&1); rc=$?
echo "$out"
step mail-send test $rc -eq 0
sleep 1
echo "--- /data/sessions/$childid/inbox.jsonl"; cat "/data/sessions/$childid/inbox.jsonl" 2>&1
step mail-in-inbox grep -q 'CHAOS-M-1 from=external to=child1' "/data/sessions/$childid/inbox.jsonl"

# Agent mail read in the exact form the fake agent uses (global --json before the subcommand).
mr=$(as_ftown env FTOWN_SESSION_ID="$childid" ftown harness --json mail read 2>&1); echo "$mr"
step mail-read-json sh -c "printf '%s' \"\$1\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const j=JSON.parse(s);process.exit(j.sessionId===process.argv[1]&&j.messages.some(m=>m.body===\"CHAOS-M-1 from=external to=child1\"&&m.deliveredAt)?0:1)})' \"\$2\"" _ "$mr" "$childid"

# Real installed hook script, with port/token as the bridge injects them (from bridge.json here).
hp=$(jq -r .port /data/bridge.json); ht=$(jq -r .token /data/bridge.json)
pl='{"hook_event_name":"Stop","session_id":"'"$childid"'"}'
step hook-script-run as_ftown sh -c 'printf "%s" "$1" | FTOWN_SESSION_ID="$2" FTOWN_HOOK_PORT="$3" FTOWN_HOOK_TOKEN="$4" "$CHAOS_HOOK_SCRIPT"' _ "$pl" "$childid" "$hp" "$ht"
# Debug run: the same POST notify.sh makes, showing the HTTP status the bridge returns.
code=$(printf '%s' "$pl" | jq -c --arg sid "$childid" '. + {ftown_session_id: $sid, ftown_session_source: ""}' | curl -s -o /dev/null -w '%{http_code}' -X POST "http://localhost:$hp/hook" -H 'Content-Type: application/json' -H "Authorization: Bearer $ht" --data-binary @-)
echo "hook POST status: $code"
step hook-accepted-200 test "$code" = 200

tm=$(as_ftown tmux -L ftown ls 2>&1); echo "$tm"
step tmux-root sh -c "printf '%s' \"\$1\" | grep -q \"ftown-$rootid\"" _ "$tm"
step tmux-child sh -c "printf '%s' \"\$1\" | grep -q \"ftown-$childid\"" _ "$tm"

p1=$(cat "$CHAOS_BRIDGE_PID")
step up-noop-when-live sh -c '/opt/chaos/box/up.sh | grep -q "already running" && [ "$(cat "$1")" = "$2" ]' _ "$CHAOS_BRIDGE_PID" "$p1"
# Stale-pid path: kill -9 and leave the pid file in place.
kill -9 "$p1"; sleep 0.5
step bridge-killed sh -c '. /opt/chaos/box/env.sh; ! bridge_alive "$1"' _ "$p1"
t0=$(date +%s%N)
step up-after-stale-pid /opt/chaos/box/up.sh
echo "restart: $(( ($(date +%s%N) - t0) / 1000000 )) ms"
list=$(as_ftown ftown sessions list 2>&1); echo "$list"
for id in "$rootid" "$childid"; do
  st=$(printf '%s' "$list" | json "(Array.isArray(j)?j:(j.sessions??[])).find(s=>s.id==='$id')?.status" 2>/dev/null || true)
  step "listed-running-after-restart $id ($st)" test "$st" = running
done
sleep 2
step restarted-bridge-alive bridge_alive "$(cat "$CHAOS_BRIDGE_PID")"
step new-pid-after-stale test "$(cat "$CHAOS_BRIDGE_PID")" != "$p1"
step no-port-clash sh -c '! grep -q EADDRINUSE "$CHAOS_BRIDGE_LOG"'
/opt/chaos/box/down.sh
echo "--- bridge log tail"; tail -n 30 "$CHAOS_BRIDGE_LOG"
[ $fails -eq 0 ] && echo "SMOKE PASS" || echo "SMOKE FAIL ($fails)"
exit $fails
