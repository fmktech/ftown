#!/bin/sh
# Start the ftown bridge in solo mode inside the box (runs as root; no network needed).
set -eu
. "$(dirname "$0")/env.sh"

mkdir -p "$CHAOS_RUN/agents" "$CHAOS_RUN/scripts" "$CHAOS_OUT" "$CHAOS_TMUX_TMPDIR" "$CHAOS_DATA_DIR/solo/bin" /work
chown ftown:ftown "$CHAOS_RUN" "$CHAOS_RUN/agents" "$CHAOS_RUN/scripts" "$CHAOS_TMUX_TMPDIR" /work
chmod 0700 "$CHAOS_TMUX_TMPDIR"

# Seed the pinned hub binary + archive-digest sidecar (hub-manager cache hit, no download).
for f in "$CHAOS_HUB_SEED"/*; do
  [ -e "$CHAOS_DATA_DIR/solo/bin/$(basename "$f")" ] || cp -p "$f" "$CHAOS_DATA_DIR/solo/bin/"
done
chown -R ftown:ftown "$CHAOS_DATA_DIR"
chmod 0700 "$CHAOS_DATA_DIR" "$CHAOS_DATA_DIR/solo"

# Workdir repo: one commit on main, bare origin. Created once; reused on restart.
if [ ! -d /work/repo/.git ]; then
  as_ftown sh -eu -c '
    git init -q --bare -b main /work/origin.git
    git init -q -b main /work/repo
    cd /work/repo
    git config user.name chaos; git config user.email chaos@localhost
    echo "chaos workdir" > README.md
    git add README.md
    GIT_AUTHOR_DATE=2000-01-01T00:00:00Z GIT_COMMITTER_DATE=2000-01-01T00:00:00Z git commit -q -m init
    git remote add origin /work/origin.git
    git push -q origin main'
fi

if [ -f "$CHAOS_BRIDGE_PID" ] && kill -0 "$(cat "$CHAOS_BRIDGE_PID")" 2>/dev/null; then
  echo "up: bridge already running (pid $(cat "$CHAOS_BRIDGE_PID"))" >&2
  exit 1
fi

touch "$CHAOS_BRIDGE_LOG"; chown ftown:ftown "$CHAOS_BRIDGE_LOG"
(CHAOS_EXEC=exec; as_ftown sh -c 'cd "$HOME" && exec node /opt/ftown/bridge/dist/ftown-cli.js start --solo --data-dir "$FTOWN_DATA_DIR" --port '"$CHAOS_PORT") \
  >>"$CHAOS_BRIDGE_LOG" 2>&1 </dev/null &
echo $! > "$CHAOS_BRIDGE_PID"
sleep 0.2
# The recorded pid must be the bridge (node) itself, so kill -9 hits the bridge.
grep -q "ftown-cli.js" "/proc/$(cat "$CHAOS_BRIDGE_PID")/cmdline" 2>/dev/null || { echo "up: pid file is not the bridge" >&2; tail -n 40 "$CHAOS_BRIDGE_LOG" >&2; exit 1; }

# Ready = the local API answers `sessions list`. Bounded: 300 x 0.2s = 60s.
i=0
while [ $i -lt 300 ]; do
  if ! kill -0 "$(cat "$CHAOS_BRIDGE_PID")" 2>/dev/null; then
    echo "up: bridge exited during start" >&2; tail -n 40 "$CHAOS_BRIDGE_LOG" >&2; exit 1
  fi
  if as_ftown ftown sessions list >/dev/null 2>&1; then
    echo "up: bridge ready (pid $(cat "$CHAOS_BRIDGE_PID"), $((i / 5)).$((i % 5 * 2))s)"
    exit 0
  fi
  sleep 0.2; i=$((i + 1))
done
echo "up: bridge not ready after 60s" >&2; tail -n 40 "$CHAOS_BRIDGE_LOG" >&2
exit 1
