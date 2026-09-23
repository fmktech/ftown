#!/bin/sh
# ftown shared Muse hook helper (POSIX sh — invoked by the per-event hook
# wrappers with argv, never symlinked).
# Usage: ftown-hook.sh session-start|stop   (hook JSON payload on stdin)
#
# SessionStart: POST the native session_id + cwd + ftown ids to bridge /hook
# (same route/shape as the pi/opencode hook posts).
# Stop: POST the hook, then drain the inbox; pending mail is emitted as
# hookSpecificOutput.additionalContext JSON (never a decision object).
#
# Always exits 0 and stays silent unless there is mail to deliver: hooks must
# be fast fire-and-forget (5s budget) and never break the agent session.

EVENT="${1:-}"
case "$EVENT" in
  session-start) HOOK_EVENT="SessionStart" ;;
  stop) HOOK_EVENT="Stop" ;;
  *) exit 0 ;;
esac

# Inert unless spawned by ftown.
[ -n "${FTOWN_SESSION_ID:-}" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
NATIVE_SID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
NATIVE_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)

# Endpoint candidates, mirroring the pi/opencode precedent: explicit env first,
# then the bridge pointer the current bridge rewrites on every startup (a
# resurrected session may hold a stale env port).
CANDIDATES=""
add_candidate() {
  case "$1" in ''|*[!0-9]*) return 0 ;; esac
  [ "$1" -gt 0 ] 2>/dev/null || return 0
  CANDIDATES="${CANDIDATES}$1 $2
"
}
ENV_PORT="${FTOWN_HOOK_PORT:-}"
ENV_TOKEN="${FTOWN_HOOK_TOKEN:-}"
add_candidate "$ENV_PORT" "$ENV_TOKEN"
BRIDGE_JSON="${HOME:-}/.ftown/bridge.json"
if [ -n "${HOME:-}" ] && [ -f "$BRIDGE_JSON" ]; then
  BPORT=$(jq -r '.port // empty' "$BRIDGE_JSON" 2>/dev/null)
  BTOKEN=$(jq -r '.token // empty' "$BRIDGE_JSON" 2>/dev/null)
  if [ -n "$BPORT" ] && { [ "$BPORT" != "$ENV_PORT" ] || [ "$BTOKEN" != "$ENV_TOKEN" ]; }; then
    add_candidate "$BPORT" "$BTOKEN"
  fi
fi
[ -n "$CANDIDATES" ] || exit 0

# POST the hook payload; first 2xx wins. Fire-and-forget: failures are silent.
post_hook() {
  _body="$1"
  while IFS=' ' read -r _port _token _rest; do
    [ -n "${_port:-}" ] || continue
    if [ -n "${_token:-}" ]; then
      _code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${_port}/hook" \
        -H 'Content-Type: application/json' -H "Authorization: Bearer ${_token}" \
        --connect-timeout 1 --max-time 2 -d "$_body" 2>/dev/null)
    else
      _code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${_port}/hook" \
        -H 'Content-Type: application/json' \
        --connect-timeout 1 --max-time 2 -d "$_body" 2>/dev/null)
    fi
    case "${_code:-}" in
      2*) return 0 ;;
    esac
  done <<CANDIDATES_EOF
$CANDIDATES
CANDIDATES_EOF
  return 1
}

PAYLOAD=$(jq -n -c \
  --arg sid "$FTOWN_SESSION_ID" \
  --arg ev "$HOOK_EVENT" \
  --arg nsid "${NATIVE_SID:-}" \
  --arg cwd "${NATIVE_CWD:-}" \
  '{ftown_session_id: $sid, ftown_session_source: "env", hook_event_name: $ev, session_id: $nsid, cwd: $cwd}' \
  2>/dev/null) || exit 0
[ -n "$PAYLOAD" ] || exit 0
post_hook "$PAYLOAD"

# Stop also drains the inbox. Single wait=0 drain (marks delivered), then the
# mail is printed as additionalContext — emission always succeeds, so no
# peek/mark two-step like the interactive opencode flow.
if [ "$HOOK_EVENT" = "Stop" ]; then
  SID_ENC=$(jq -n -r --arg s "$FTOWN_SESSION_ID" '$s | @uri' 2>/dev/null)
  [ -n "$SID_ENC" ] || exit 0
  _tmp=$(mktemp /tmp/ftown-muse-inbox.XXXXXX 2>/dev/null) || exit 0
  INBOX=""
  while IFS=' ' read -r _port _token _rest; do
    [ -n "${_port:-}" ] || continue
    if [ -n "${_token:-}" ]; then
      _code=$(curl -s -o "$_tmp" -w '%{http_code}' \
        "http://127.0.0.1:${_port}/api/sessions/${SID_ENC}/inbox?wait=0" \
        -H "Authorization: Bearer ${_token}" \
        --connect-timeout 1 --max-time 2 2>/dev/null)
    else
      _code=$(curl -s -o "$_tmp" -w '%{http_code}' \
        "http://127.0.0.1:${_port}/api/sessions/${SID_ENC}/inbox?wait=0" \
        --connect-timeout 1 --max-time 2 2>/dev/null)
    fi
    case "${_code:-}" in
      2*) INBOX=$(cat "$_tmp" 2>/dev/null); break ;;
    esac
  done <<CANDIDATES_EOF
$CANDIDATES
CANDIDATES_EOF
  rm -f "$_tmp"
  [ -n "$INBOX" ] || exit 0
  COUNT=$(printf '%s' "$INBOX" | jq -r '(.messages // []) | length' 2>/dev/null)
  if [ -n "$COUNT" ] && [ "$COUNT" -gt 0 ] 2>/dev/null; then
    printf '%s' "$INBOX" | jq -c \
      '{hookSpecificOutput: {hookEventName: "Stop", additionalContext: ("[ftown mail]\n" + ([(.messages // [])[] | "[\(.ts // "")] \(.fromName // .from // "external") (\(.type // "message")): \(.body // "")"] | join("\n")))}}' \
      2>/dev/null || exit 0
  fi
fi
exit 0
