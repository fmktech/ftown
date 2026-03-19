#!/bin/bash
INPUT=$(cat)
PORT="${FTOWN_HOOK_PORT}"
SESSION_ID="${FTOWN_SESSION_ID}"
if [ -z "$PORT" ] || [ -z "$SESSION_ID" ]; then
  exit 0
fi
PAYLOAD=$(echo "$INPUT" | jq -c --arg sid "$SESSION_ID" '. + {ftown_session_id: $sid}')
curl -s -X POST "http://localhost:${PORT}/hook" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" > /dev/null 2>&1
exit 0
