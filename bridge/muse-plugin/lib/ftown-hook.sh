#!/bin/sh
# ftown shared Muse hook helper (POSIX sh — invoked by the per-event hook
# wrappers with argv, never symlinked). It is a compatibility shim only: the
# real hook is the typed Node entry point `ftown-harness hook <kind>`. No jq,
# curl, session lookup, POST or mail logic lives here.
#
# Usage: ftown-hook.sh session-start|user-prompt-submit|pre-tool-use|post-tool-use|stop
#        (hook JSON payload on stdin)

set -u

case "${1:-}" in
  session-start)        EVENT='SessionStart'; KIND='muse-session-start' ;;
  user-prompt-submit)   EVENT='UserPromptSubmit'; KIND='muse-user-prompt-submit' ;;
  pre-tool-use)         EVENT='PreToolUse'; KIND='muse-pre-tool-use' ;;
  # Success and failure both mean the tool call is finished and the turn goes
  # on; PostToolUse classifies as thinking, postToolUseFailure would go idle.
  post-tool-use)        EVENT='PostToolUse'; KIND='muse-post-tool-use' ;;
  stop)                 EVENT='Stop'; KIND='muse-stop' ;;
  *) exit 0 ;;
esac

# Inert unless spawned by ftown.
[ -n "${FTOWN_SESSION_ID:-}" ] || exit 0

# A stale install must never block its agent: report the drop on stderr and
# exit 0. Stderr is visible in the harness hook log; the event is simply lost.
stale() {
  printf '%s\n' "ftown muse hook: $1 ($EVENT event not delivered)" >&2
}

harness="${FTOWN_HARNESS:-}"
if [ -z "$harness" ] && [ -n "${HOME:-}" ] && [ -x "${HOME}/.ftown/bin/ftown-harness" ]; then
  harness="${HOME}/.ftown/bin/ftown-harness"
fi
if [ -z "$harness" ]; then
  harness="$(command -v ftown-harness 2>/dev/null || true)"
fi

if [ -z "$harness" ] || [ ! -x "$harness" ]; then
  stale 'ftown-harness is missing'
  exit 0
fi
# Older ftown-harness builds have no 'hook' command; their CLI would print an
# "unknown command" error and exit non-zero. Probe first so an old install
# still exits 0 and leaves a clear, visible reason in the hook log.
if ! "$harness" hook --help >/dev/null 2>&1; then
  stale "installed ftown-harness has no 'hook' command; upgrade ftown"
  exit 0
fi

exec "$harness" hook "$KIND"
