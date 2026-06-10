#!/bin/bash
INPUT=$(cat)

PORT="${FTOWN_HOOK_PORT:-}"
SESSION_ID="${FTOWN_SESSION_ID:-}"
TOKEN="${FTOWN_HOOK_TOKEN:-}"
SOURCE=""

BRIDGE_JSON="${HOME}/.ftown/bridge.json"
REGISTRY="${HOME}/.ftown/session-registry.json"

if [ -z "$PORT" ] && [ -f "$BRIDGE_JSON" ]; then
  PORT=$(jq -r '.port // empty' "$BRIDGE_JSON" 2>/dev/null)
  if [ -z "$TOKEN" ]; then
    TOKEN=$(jq -r '.token // empty' "$BRIDGE_JSON" 2>/dev/null)
  fi
fi

if [ -n "$SESSION_ID" ]; then
  SOURCE="env"
elif [ -n "$INPUT" ]; then
  CONV=$(echo "$INPUT" | jq -r '.conversation_id // empty' 2>/dev/null)
  WS=$(echo "$INPUT" | jq -r '.workspace_roots[0] // empty' 2>/dev/null)
  if [ -f "$REGISTRY" ]; then
    if [ -n "$CONV" ]; then
      SESSION_ID=$(jq -r --arg c "$CONV" '.byConversation[$c] // empty' "$REGISTRY" 2>/dev/null)
      if [ -n "$SESSION_ID" ]; then
        SOURCE="conversation"
      fi
    fi
    if [ -z "$SESSION_ID" ] && [ -n "$WS" ]; then
      SESSION_ID=$(jq -r --arg w "$WS" '.byWorkspace[$w] // empty' "$REGISTRY" 2>/dev/null)
      if [ -n "$SESSION_ID" ]; then
        SOURCE="workspace"
      fi
    fi
  fi
fi

if [ -z "$PORT" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

PAYLOAD=$(echo "$INPUT" | jq -c --arg sid "$SESSION_ID" --arg src "$SOURCE" \
  '. + {ftown_session_id: $sid, ftown_session_source: $src}' 2>/dev/null)
if [ -z "$PAYLOAD" ]; then
  PAYLOAD=$(jq -nc --arg sid "$SESSION_ID" --arg src "$SOURCE" --arg ev "${HOOK_EVENT_NAME:-hook}" \
    '{ftown_session_id: $sid, ftown_session_source: $src, hook_event_name: $ev}')
fi

post_hook() {
  local port="$1" token="$2"
  local auth=()
  if [ -n "$token" ]; then
    auth=(-H "Authorization: Bearer ${token}")
  fi
  curl -sf -X POST "http://localhost:${port}/hook" \
    -H "Content-Type: application/json" \
    "${auth[@]}" \
    -d "$PAYLOAD" > /dev/null 2>&1
}

if ! post_hook "$PORT" "$TOKEN" && [ -f "$BRIDGE_JSON" ]; then
  # Env vars are stale inside tmux sessions that outlive their bridge; the
  # current bridge rewrites bridge.json with the live port/token on startup.
  BPORT=$(jq -r '.port // empty' "$BRIDGE_JSON" 2>/dev/null)
  BTOKEN=$(jq -r '.token // empty' "$BRIDGE_JSON" 2>/dev/null)
  if [ -n "$BPORT" ] && { [ "$BPORT" != "$PORT" ] || [ "$BTOKEN" != "$TOKEN" ]; }; then
    post_hook "$BPORT" "$BTOKEN"
  fi
fi
exit 0
