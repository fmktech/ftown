#!/usr/bin/env bash
# Generate a self-signed cert for `localhost` (+127.0.0.1) used by the neon-http-shim.
# The UI process trusts it via NODE_EXTRA_CA_CERTS (a self-signed leaf added to the
# CA store is trusted for its own SANs). Regenerated only if missing.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/certs"
mkdir -p "$DIR"
if [[ -f "$DIR/cert.pem" && -f "$DIR/key.pem" ]]; then
  echo "certs already present in $DIR"
  exit 0
fi
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -days 365 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
echo "generated self-signed cert in $DIR"
