#!/bin/sh
# Stop the bridge started by up.sh: SIGTERM, then SIGKILL after 10s. Sessions (tmux) survive.
set -u
. "$(dirname "$0")/env.sh"
pid=$(live_bridge_pid)
[ -n "$pid" ] || { rm -f "$CHAOS_BRIDGE_PID"; echo "down: no live bridge"; exit 0; }
kill -TERM "$pid"
i=0
while bridge_alive "$pid" && [ $i -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
bridge_alive "$pid" && kill -KILL "$pid"
rm -f "$CHAOS_BRIDGE_PID"
echo "down: bridge $pid stopped"
