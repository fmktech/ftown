#!/bin/bash
# ftown hook for the Google Antigravity CLI (agy); installed to
# ~/.ftown/antigravity-hook.sh and registered in ~/.gemini/config/hooks.json.
# Translates agy's camelCase hook payload (stdin) to the bridge /hook wire format and POSTs it.
# On a turn-end Stop it drains this session's ftown inbox FIRST: with mail it
# prints {"decision":"continue","reason":"<mail>"} and posts nothing (the agent
# keeps working); without mail it posts Stop. On terminationReason
# MAX_FORCED_INVOCATIONS / USER_CANCELED / ERROR it never drains, only posts Stop.
#
# Always exits 0, also on HUP/INT/TERM/PIPE (a non-zero or signalled PreToolUse
# hook makes agy BLOCK the tool), and writes nothing to stdout except that one
# Stop mail line (agy parses stdout as JSON). Inert unless FTOWN_SESSION_ID is
# set and curl + jq are available.
#
# Worst-case runtime: ~6s inside agy's 10s hook timeout. The POST tries at most
# 2 endpoint candidates x curl --max-time 2 (4s); on Stop the inbox read through
# `ftown security proxy` uses a 2s request timeout and happens before the POST,
# and when it delivers mail no POST follows.
#
# bash 3.2 compatible (macOS /bin/bash). No set -e on purpose; no temp files.
# The hook's working directory is agy's hooks.json folder, so pwd is never used.

BG_PID=""
# shellcheck disable=SC2329  # invoked through the trap below
on_signal() {
  [ -n "$BG_PID" ] && kill "$BG_PID" 2>/dev/null
  exit 0
}
trap 'exit 0' EXIT
trap on_signal HUP INT TERM PIPE

INPUT=$(cat)

[ -n "${FTOWN_SESSION_ID:-}" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Parse once; invalid JSON or a missing hookEventName ends the hook silently.
FIELDS=$(printf '%s' "$INPUT" | jq -c '
  if type == "object" and ((.hookEventName // "") | type) == "string" and (.hookEventName // "") != "" then
    {event: .hookEventName,
     first: (.invocationNum == 0),
     term: (.terminationReason | if type == "string" then . else "" end),
     conv: ((.conversationId // "") | if type == "string" then . else tostring end),
     cwd: ((.cwd // "") | if type == "string" then . else tostring end),
     tool: (if (.toolCall | type) == "object" then
              ({} + (if .toolCall.name != null then {tool_name: .toolCall.name} else {} end)
                  + (if (.toolCall.args | type) == "object" then {tool_input: .toolCall.args} else {} end)
                  + (if (.toolCall.id | type) == "string" then {tool_use_id: .toolCall.id} else {} end))
            else {} end)}
  else empty end' 2>/dev/null) || exit 0
INPUT=""
[ -n "$FIELDS" ] || exit 0

EVENT=$(printf '%s' "$FIELDS" | jq -r '.event' 2>/dev/null) || exit 0
case "$EVENT" in
  SessionStart|PreToolUse|PostToolUse|Stop) HOOK_EVENT="$EVENT" ;;
  PreInvocation)
    FIRST=$(printf '%s' "$FIELDS" | jq -r '.first' 2>/dev/null) || exit 0
    [ "$FIRST" = "true" ] || exit 0
    HOOK_EVENT="UserPromptSubmit"
    ;;
  *) exit 0 ;;
esac

# Endpoint candidates, mirroring the muse helper: explicit env first, then the
# bridge pointer the current bridge rewrites on every startup.
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
BRIDGE_JSON="${FTOWN_BRIDGE_POINTER:-${HOME:-}/.ftown/bridge.json}"
if [ -n "${HOME:-}" ] && [ -f "$BRIDGE_JSON" ]; then
  BPORT=$(jq -r '.port // empty' "$BRIDGE_JSON" 2>/dev/null)
  BTOKEN=$(jq -r '.token // empty' "$BRIDGE_JSON" 2>/dev/null)
  if [ -n "$BPORT" ] && { [ "$BPORT" != "$ENV_PORT" ] || [ "$BTOKEN" != "$ENV_TOKEN" ]; }; then
    add_candidate "$BPORT" "$BTOKEN"
  fi
fi

# One POST attempt, run in the background so a trapped signal interrupts the
# `wait` at once instead of after curl's timeout. Its stdout/stderr go to
# /dev/null so a curl left behind by a signal (it ends within its own 2s
# bound) never holds agy's hook pipes open. The body goes on curl's
# stdin (no ARG_MAX limit); the attempt succeeds only on a 2xx status.
post_once() {
  if [ -n "$3" ]; then
    printf '%s' "$1" | curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$2/hook" \
      -H 'Content-Type: application/json' -H "Authorization: Bearer $3" \
      --connect-timeout 1 --max-time 2 --data-binary @- 2>/dev/null
  else
    printf '%s' "$1" | curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$2/hook" \
      -H 'Content-Type: application/json' \
      --connect-timeout 1 --max-time 2 --data-binary @- 2>/dev/null
  fi | { IFS= read -r _code; case "${_code:-}" in 2*) exit 0 ;; esac; exit 1; }
}

# POST the hook payload; first 2xx wins. Fire-and-forget: failures are silent.
post_hook() {
  _body="$1"
  while IFS=' ' read -r _port _token _rest; do
    [ -n "${_port:-}" ] || continue
    post_once "$_body" "$_port" "${_token:-}" >/dev/null 2>&1 &
    BG_PID=$!
    wait "$BG_PID"
    _rc=$?
    BG_PID=""
    [ "$_rc" -eq 0 ] && return 0
  done <<CANDIDATES_EOF
$CANDIDATES
CANDIDATES_EOF
  return 1
}

PAYLOAD=$(printf '%s' "$FIELDS" | jq -c \
  --arg sid "$FTOWN_SESSION_ID" \
  --arg ev "$HOOK_EVENT" \
  --arg envconv "${ANTIGRAVITY_CONVERSATION_ID:-}" \
  '{ftown_session_id: $sid, ftown_session_source: "env", hook_event_name: $ev,
    session_id: (if .conv != "" then .conv else $envconv end), cwd: .cwd}
   + (if $ev == "PreToolUse" or $ev == "PostToolUse" then .tool else {} end)' \
  2>/dev/null) || exit 0
[ -n "$PAYLOAD" ] || exit 0

if [ "$HOOK_EVENT" != "Stop" ]; then
  post_hook "$PAYLOAD"
  exit 0
fi

# Stop: drain the inbox first (unless agy will not continue), exactly like the
# muse helper: a single wait=0 drain through the authenticated
# `ftown security proxy`, which marks the mail delivered.
drain_mail() {
  _term=$(printf '%s' "$FIELDS" | jq -r '.term' 2>/dev/null)
  case "$_term" in
    MAX_FORCED_INVOCATIONS|USER_CANCELED|ERROR) return 1 ;;
  esac
  _enc=$(jq -n -r --arg s "$FTOWN_SESSION_ID" '$s | @uri' 2>/dev/null)
  [ -n "$_enc" ] || return 1
  _cli=$(command -v ftown 2>/dev/null || true)
  [ -n "$_cli" ] || _cli="${HOME:-}/.ftown/bin/ftown"
  [ -x "$_cli" ] || return 1
  _req=$(jq -n -c --arg path "/api/sessions/${_enc}/inbox?wait=0" '{method:"GET",path:$path,timeoutMs:2000}' 2>/dev/null)
  [ -n "$_req" ] || return 1
  _inbox=$(printf '%s' "$_req" | "$_cli" security proxy 2>/dev/null | jq -c 'select(.status >= 200 and .status < 300) | .body' 2>/dev/null)
  [ -n "$_inbox" ] || return 1
  _count=$(printf '%s' "$_inbox" | jq -r '(.messages // []) | length' 2>/dev/null)
  [ -n "$_count" ] && [ "$_count" -gt 0 ] 2>/dev/null || return 1
  MAIL_OUT=$(printf '%s' "$_inbox" | jq -c \
    '{decision: "continue", reason: ("[ftown mail]\n" + ([(.messages // [])[] | "[\(.ts // "")] \(.fromName // .from // "external") (\(.type // "message")): \(.body // "")"] | join("\n")))}' \
    2>/dev/null)
  [ -n "$MAIL_OUT" ]
}

MAIL_OUT=""
if drain_mail; then
  # Mail delivered: the agent continues, so the session stays busy (no POST).
  # stderr is silenced so a reader that closed the pipe cannot see "Broken pipe".
  printf '%s\n' "$MAIL_OUT" 2>/dev/null
  exit 0
fi
post_hook "$PAYLOAD"
exit 0
