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
# Run a command as user ftown with the bridge's environment (env -i: nothing leaks in).
# With CHAOS_EXEC=exec the calling (sub)shell is replaced, so a backgrounded call's $! is the command's pid.
as_ftown() {
  ${CHAOS_EXEC:-} setpriv --reuid=1000 --regid=1000 --init-groups -- env -i \
    HOME="$CHAOS_HOME" USER=ftown LOGNAME=ftown SHELL=/bin/zsh LANG=C.UTF-8 TERM=xterm-256color \
    PATH="/opt/chaos-bin:/home/ftown/.ftown/bin:/usr/local/bin:/usr/bin:/bin" \
    FTOWN_DATA_DIR="$CHAOS_DATA_DIR" TMUX_TMPDIR="$CHAOS_TMUX_TMPDIR" \
    FTOWN_SOLO_PANEL_DIR="$CHAOS_PANEL_DIR" \
    "$@"
}
