#!/usr/bin/env bash
# Compatibility shim. The real hook is the typed Node entry point
# `ftown-harness hook notify`; this file only locates it and execs it. No jq,
# curl, session lookup or network logic lives here.
set -u

harness="${FTOWN_HARNESS:-}"
if [ -z "$harness" ] && [ -n "${HOME:-}" ] && [ -x "${HOME}/.ftown/bin/ftown-harness" ]; then
  harness="${HOME}/.ftown/bin/ftown-harness"
fi
if [ -z "$harness" ]; then
  harness="$(command -v ftown-harness 2>/dev/null || true)"
fi
# A hook must never block its agent; a missing harness is an inert no-op.
if [ -z "$harness" ]; then
  exit 0
fi

exec "$harness" hook notify "$@"
