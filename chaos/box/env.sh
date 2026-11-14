# Sourced by up.sh/down.sh/smoke: the environment the bridge and the ftown CLI run with.
CHAOS_DATA_DIR=/data
CHAOS_HOME=/home/ftown
CHAOS_RUN=/run/chaos
CHAOS_OUT=$CHAOS_RUN/out
CHAOS_PORT=8040
CHAOS_BRIDGE_PID=$CHAOS_RUN/bridge.pid
CHAOS_BRIDGE_LOG=$CHAOS_OUT/side-bridge.log
CHAOS_TMUX_TMPDIR=$CHAOS_RUN/tmux
CHAOS_PANEL_DIR=/opt/chaos-seed/panel
CHAOS_HUB_SEED=/opt/chaos-seed/hub
CHAOS_HOOK_SCRIPT=/opt/ftown/bridge/hooks/notify.sh
# Run a command as user ftown with the bridge's environment (env -i: nothing leaks in).
# With CHAOS_EXEC=exec the calling (sub)shell is replaced, so a backgrounded call's $! is the command's pid.
as_ftown() {
  ${CHAOS_EXEC:-} setpriv --reuid=1000 --regid=1000 --init-groups -- env -i \
    HOME="$CHAOS_HOME" USER=ftown LOGNAME=ftown SHELL=/bin/zsh LANG=C.UTF-8 TERM=xterm-256color \
    PATH="/opt/chaos-bin:/home/ftown/.ftown/bin:/usr/local/bin:/usr/bin:/bin" \
    FTOWN_DATA_DIR="$CHAOS_DATA_DIR" TMUX_TMPDIR="$CHAOS_TMUX_TMPDIR" \
    FTOWN_SOLO_PANEL_DIR="$CHAOS_PANEL_DIR" CHAOS_HOOK_SCRIPT="$CHAOS_HOOK_SCRIPT" \
    "$@"
}
# A pid is the live bridge only if it is not a zombie/dead (state Z or X; kill -0 succeeds on
# zombies) and its cmdline is `… ftown-cli.js start …`.
bridge_alive() {
  [ -n "${1:-}" ] && [ -r "/proc/$1/stat" ] || return 1
  st=$(sed 's/^.*) //' "/proc/$1/stat" | cut -d' ' -f1)
  case "$st" in Z|X|'') return 1 ;; esac
  tr '\0' ' ' < "/proc/$1/cmdline" 2>/dev/null | grep -q 'ftown-cli\.js start'
}
# Pid from the pid file when it is the live bridge; otherwise empty (and a stale/foreign file is removed).
live_bridge_pid() {
  [ -f "$CHAOS_BRIDGE_PID" ] || return 0
  p=$(cat "$CHAOS_BRIDGE_PID" 2>/dev/null || true)
  if bridge_alive "$p"; then echo "$p"; else rm -f "$CHAOS_BRIDGE_PID"; fi
}
