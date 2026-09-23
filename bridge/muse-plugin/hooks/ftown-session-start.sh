#!/bin/sh
# ftown Muse SessionStart hook — thin wrapper; shared logic lives in
# lib/ftown-hook.sh (invoked with argv, never symlinked: duplicate hook
# sources are rejected by `muse plugins`).
# Inert (exit 0) unless spawned by ftown.
[ -n "${FTOWN_SESSION_ID:-}" ] || exit 0
HELPER=""
for _root in "${MUSE_PLUGIN_ROOT:-}" "${CLAUDE_PLUGIN_ROOT:-}" "${PLUGIN_ROOT:-}"; do
  if [ -n "$_root" ] && [ -f "$_root/lib/ftown-hook.sh" ]; then
    HELPER="$_root/lib/ftown-hook.sh"
    break
  fi
done
if [ -z "$HELPER" ]; then
  case "$0" in
    */*) _dir=$(dirname "$0") ;;
    *) _dir="." ;;
  esac
  if [ -f "$_dir/../lib/ftown-hook.sh" ]; then
    HELPER="$_dir/../lib/ftown-hook.sh"
  elif [ -f "lib/ftown-hook.sh" ]; then
    HELPER="lib/ftown-hook.sh"
  fi
fi
[ -n "$HELPER" ] || exit 0
exec sh "$HELPER" session-start
