#!/bin/bash
# ftown hook for the Grok CLI, installed to ~/.ftown/grok-hook.sh and
# registered for every grok hook event in ~/.grok/hooks/ftown.json.
# What it does:
#   1. Reads grok's hook payload (JSON on stdin) and POSTs it to the bridge
#      /hook route in ftown's snake_case wire format.
#   2. On Stop with reason "end_turn" it drains this session's ftown inbox
#      FIRST: when mail was delivered it prints
#      {"decision":"block","reason":"<mail>"} so grok continues the turn with
#      the mail (capped at 9,500 characters plus a re-read pointer, since grok
#      clips the reason at 10,000) and posts NOTHING, keeping the session busy;
#      with no mail it posts Stop. Stop "shutdown"/"channel_closed" (session
#      end) is ignored entirely; any other Stop reason just posts Stop.
#
# Inert (exit 0, no output) unless spawned by ftown (FTOWN_SESSION_ID set) and
# curl + jq are available. Always exits 0; stdout is written only for mail.
#
# Worst-case runtime (grok hook timeout is 10s): on Stop end_turn one inbox
# read through `ftown security proxy` with timeoutMs 2000 (2s plus CLI
# startup), then, only when no mail came back, the POST tries at most two
# endpoints (env port, bridge pointer), each curl bounded by --max-time 2
# (4s): about 6s plus CLI startup.
# Bridge reachability, auth, inbox read and mail text mirror
# bridge/muse-plugin/lib/ftown-hook.sh.

# Consume the whole payload first so grok never sees a broken pipe even when
# the hook turns out to be inert.
INPUT=$(cat 2>/dev/null)

# Inert unless spawned by ftown.
[ -n "${FTOWN_SESSION_ID:-}" ] || exit 0
command -v curl >/dev/null 2>&1 || exit 0
command -v jq >/dev/null 2>&1 || exit 0

# Valid JSON object with a non-empty string hook_event_name, else silent exit.
printf '%s' "$INPUT" | jq -e \
  'type == "object" and (.hook_event_name | type == "string" and length > 0)' \
  >/dev/null 2>&1 || exit 0

HOOK_EVENT=$(printf '%s' "$INPUT" | jq -r '.hook_event_name' 2>/dev/null) || exit 0
STOP_REASON=$(printf '%s' "$INPUT" | jq -r '.reason // empty | tostring' 2>/dev/null)
[ -n "$HOOK_EVENT" ] || exit 0

# Grok's two session-end reasons (every process exit fires an extra Stop with
# one of them) are not turn ends: no POST, no inbox read, no output.
if [ "$HOOK_EVENT" = "Stop" ]; then
  case "$STOP_REASON" in
    shutdown|channel_closed) exit 0 ;;
  esac
fi

# Endpoint candidates, mirroring the muse helper: explicit env first, then the
# bridge pointer the current bridge rewrites on every startup (a resurrected
# session may hold a stale env port).
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
[ -n "$CANDIDATES" ] || exit 0

# POST the hook payload; first 2xx wins. Fire-and-forget: failures are silent.
# The body goes on curl's stdin (printf is a builtin), never argv, so a large
# tool_input cannot exceed ARG_MAX.
post_hook() {
  _body="$1"
  while IFS=' ' read -r _port _token _rest; do
    [ -n "${_port:-}" ] || continue
    if [ -n "${_token:-}" ]; then
      _code=$(printf '%s' "$_body" | curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${_port}/hook" \
        -H 'Content-Type: application/json' -H "Authorization: Bearer ${_token}" \
        --connect-timeout 1 --max-time 2 --data-binary @- 2>/dev/null)
    else
      _code=$(printf '%s' "$_body" | curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${_port}/hook" \
        -H 'Content-Type: application/json' \
        --connect-timeout 1 --max-time 2 --data-binary @- 2>/dev/null)
    fi
    case "${_code:-}" in
      2*) return 0 ;;
    esac
  done <<CANDIDATES_EOF
$CANDIDATES
CANDIDATES_EOF
  return 1
}

# Build the wire body with jq straight from the payload. tool_* keys are kept
# only when present (tool_input stays a JSON value); session_id falls back to
# $GROK_SESSION_ID when the payload has none.
PAYLOAD=$(printf '%s' "$INPUT" | jq -c \
  --arg sid "$FTOWN_SESSION_ID" \
  --arg gsid "${GROK_SESSION_ID:-}" \
  '{
     ftown_session_id: $sid,
     ftown_session_source: "env",
     hook_event_name: .hook_event_name,
     session_id: (if (.session_id | type) == "string" and .session_id != "" then .session_id else $gsid end),
     cwd: (if (.cwd | type) == "string" then .cwd else "" end)
   }
   + (if .tool_name != null then {tool_name: .tool_name} else {} end)
   + (if .tool_input != null then {tool_input: .tool_input} else {} end)
   + (if .tool_use_id != null then {tool_use_id: .tool_use_id} else {} end)' \
  2>/dev/null) || exit 0
[ -n "$PAYLOAD" ] || exit 0

# Drain this session's inbox: single wait=0 read through `ftown security proxy`
# (marks delivered). On success sets MAIL_DECISION to the Stop "block" line
# and returns 0; returns 1 when no mail was delivered for any reason (empty
# inbox, CLI missing, proxy failure).
MAIL_DECISION=""
drain_mail() {
  _sid_enc=$(jq -n -r --arg s "$FTOWN_SESSION_ID" '$s | @uri' 2>/dev/null)
  [ -n "$_sid_enc" ] || return 1
  _cli=$(command -v ftown 2>/dev/null || true)
  [ -n "$_cli" ] || _cli="${HOME:-}/.ftown/bin/ftown"
  [ -x "$_cli" ] || return 1
  _request=$(jq -n -c --arg path "/api/sessions/${_sid_enc}/inbox?wait=0" '{method:"GET",path:$path,timeoutMs:2000}' 2>/dev/null) || return 1
  _inbox=$(printf '%s' "$_request" | "$_cli" security proxy 2>/dev/null | jq -c 'select(.status >= 200 and .status < 300) | .body' 2>/dev/null)
  [ -n "$_inbox" ] || return 1
  _count=$(printf '%s' "$_inbox" | jq -r '(.messages // []) | length' 2>/dev/null)
  [ -n "$_count" ] && [ "$_count" -gt 0 ] 2>/dev/null || return 1
  # Grok clips a block reason at 10,000 characters, and the drain has already
  # marked the mail delivered: cap the text at 9,500 characters (jq counts
  # codepoints, not bytes) and, when cut, end with a re-read pointer.
  MAIL_DECISION=$(printf '%s' "$_inbox" | jq -c \
    --arg pointer '[ftown mail truncated: run `ftown sessions inbox --all --peek` to read the full messages]' \
    '("[ftown mail]\n" + ([(.messages // [])[] | "[\(.ts // "")] \(.fromName // .from // "external") (\(.type // "message")): \(.body // "")"] | join("\n")))
     | (if length > 9500 then .[0:9500] + "\n" + $pointer else . end)
     | {decision: "block", reason: .}' \
    2>/dev/null) || return 1
  [ -n "$MAIL_DECISION" ]
}

# Turn-end ordering (contract A2.1): on a real turn end drain FIRST. When mail
# was delivered grok keeps working, so print the decision and post nothing
# (posting Stop would mark a busy session idle). Otherwise post Stop.
if [ "$HOOK_EVENT" = "Stop" ] && [ "$STOP_REASON" = "end_turn" ]; then
  if drain_mail; then
    printf '%s\n' "$MAIL_DECISION"
    exit 0
  fi
fi
post_hook "$PAYLOAD"
exit 0
