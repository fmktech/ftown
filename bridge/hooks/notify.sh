#!/bin/bash
INPUT=$(cat)
PORT="${FTOWN_HOOK_PORT}"
SESSION_ID="${FTOWN_SESSION_ID}"
TOKEN="${FTOWN_HOOK_TOKEN}"
if [ -z "$PORT" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi
PAYLOAD=$(echo "$INPUT" | jq -c --arg sid "$SESSION_ID" '. + {ftown_session_id: $sid}')
AUTH_ARGS=()
if [ -n "$TOKEN" ]; then
  AUTH_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
fi
curl -s -X POST "http://localhost:${PORT}/hook" \
  -H "Content-Type: application/json" \
  "${AUTH_ARGS[@]}" \
  -d "$PAYLOAD" > /dev/null 2>&1
exit 0
