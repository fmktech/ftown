#!/bin/sh
set -eu
# Existing Fly secrets keep working; an explicitly supplied v6 name wins.
if [ "${CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY+x}" != x ]; then
  CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY="${CENTRIFUGO_TOKEN_HMAC_SECRET_KEY:-}"
  export CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY
fi
if [ -z "$CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY" ]; then
  echo "Missing Centrifugo client token HMAC secret" >&2
  exit 1
fi
exec centrifugo "$@"
