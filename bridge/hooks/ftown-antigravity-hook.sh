#!/usr/bin/env bash
# Compatibility shim for the installed antigravity hook. The real hook is the
# typed Node entry point `ftown-harness hook antigravity`; this file only locates
# it and execs it. No jq, curl, inbox read or network logic lives here.
set -u

# A stale install must never block its agent (a non-zero PreToolUse hook makes
# agy block the tool): report the drop once on stderr and exit 0. The event is
# simply lost. On a real install agy runs this via `sh -c ... 2>/dev/null || true`.
stale() {
  printf '%s\n' "ftown antigravity hook: $1 (antigravity event not delivered)" >&2
}

harness="${FTOWN_HARNESS:-}"
if [ -z "$harness" ] && [ -n "${HOME:-}" ] && [ -x "${HOME}/.ftown/bin/ftown-harness" ]; then
  harness="${HOME}/.ftown/bin/ftown-harness"
fi
if [ -z "$harness" ]; then
  harness="$(command -v ftown-harness 2>/dev/null || true)"
fi

if [ -z "$harness" ] || [ ! -x "$harness" ]; then
  stale "ftown-harness is missing"
  exit 0
fi
# Older ftown-harness builds have no 'hook' command; their CLI would print an
# "unknown command" error and exit non-zero. Probe first so an old install
# still exits 0 and leaves a clear, visible reason in the hook log.
if ! "$harness" hook --help >/dev/null 2>&1; then
  stale "installed ftown-harness has no 'hook' command; upgrade ftown"
  exit 0
fi

exec "$harness" hook antigravity "$@"
