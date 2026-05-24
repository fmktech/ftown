#!/bin/bash
INPUT=$(cat)

PORT="${FTOWN_HOOK_PORT:-}"
SESSION_ID="${FTOWN_SESSION_ID:-}"
TOKEN="${FTOWN_HOOK_TOKEN:-}"

BRIDGE_JSON="${HOME}/.ftown/bridge.json"
REGISTRY="${HOME}/.ftown/session-registry.json"

if [ -z "$PORT" ] && [ -f "$BRIDGE_JSON" ]; then
  PORT=$(jq -r '.port // empty' "$BRIDGE_JSON" 2>/dev/null)
  if [ -z "$TOKEN" ]; then
    TOKEN=$(jq -r '.token // empty' "$BRIDGE_JSON" 2>/dev/null)
  fi
fi

if [ -z "$SESSION_ID" ] && [ -n "$INPUT" ]; then
  CONV=$(echo "$INPUT" | jq -r '.conversation_id // empty' 2>/dev/null)
  WS=$(echo "$INPUT" | jq -r '.workspace_roots[0] // empty' 2>/dev/null)
  if [ -f "$REGISTRY" ]; then
    if [ -n "$CONV" ]; then
      SESSION_ID=$(jq -r --arg c "$CONV" '.byConversation[$c] // empty' "$REGISTRY" 2>/dev/null)
    fi
    if [ -z "$SESSION_ID" ] && [ -n "$WS" ]; then
      SESSION_ID=$(jq -r --arg w "$WS" '.byWorkspace[$w] // empty' "$REGISTRY" 2>/dev/null)
    fi
  fi
fi

if [ -z "$PORT" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi

PAYLOAD=$(echo "$INPUT" | jq -c --arg sid "$SESSION_ID" '. + {ftown_session_id: $sid}' 2>/dev/null)
if [ -z "$PAYLOAD" ]; then
  PAYLOAD=$(jq -nc --arg sid "$SESSION_ID" --arg ev "${HOOK_EVENT_NAME:-hook}" \
    '{ftown_session_id: $sid, hook_event_name: $ev}')
fi

AUTH_ARGS=()
if [ -n "$TOKEN" ]; then
  AUTH_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
fi

curl -s -X POST "http://localhost:${PORT}/hook" \
  -H "Content-Type: application/json" \
  "${AUTH_ARGS[@]}" \
  -d "$PAYLOAD" > /dev/null 2>&1
exit 0
