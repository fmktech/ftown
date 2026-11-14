#!/bin/sh
# Stop the bridge started by up.sh: SIGTERM, then SIGKILL after 10s. Sessions (tmux) survive.
set -u
. "$(dirname "$0")/env.sh"
[ -f "$CHAOS_BRIDGE_PID" ] || { echo "down: no pid file"; exit 0; }
pid=$(cat "$CHAOS_BRIDGE_PID")
if kill -0 "$pid" 2>/dev/null; then
  kill -TERM "$pid"
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
  kill -0 "$pid" 2>/dev/null && kill -KILL "$pid"
fi
rm -f "$CHAOS_BRIDGE_PID"
echo "down: bridge $pid stopped"
