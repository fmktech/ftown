#!/usr/bin/env bash
set -euo pipefail
umask 022
CENTRIFUGO_IMAGE=ftown-centrifugo:ci
CENTRIFUGO_UPSTREAM=centrifugo/centrifugo:v6.10.2@sha256:34b84f823515927266ce3abfb840fd9e0acabb58805e7e896f5de731217a627d
set -euo pipefail
node scripts/check-centrifugo-config.mjs
node --test scripts/check-centrifugo-config.test.mjs scripts/deploy/centrifugo-remote.test.mjs

set -euo pipefail
for config in centrifugo/config.json centrifugo/config.fly.json centrifugo/config.prod.json e2e/centrifugo.config.json; do
  if ! output=$(docker run --rm \
    -e CENTRIFUGO_CLIENT_TOKEN_HMAC_SECRET_KEY=ci-only-secret-at-least-32-characters \
    -v "$PWD:/cfg:ro" "$CENTRIFUGO_UPSTREAM" \
    centrifugo checkconfig -c "/cfg/$config" 2>&1); then
    printf '%s\n' "$output"
    exit 1
  fi
  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -Eiq 'unknown|unrecognized|unsupported'; then
    echo "ERROR: config validation warned about an unknown option: $config" >&2
    exit 1
  fi
done

set -euo pipefail
docker build --pull=false \
  -f centrifugo/Dockerfile.fly \
  -t "$CENTRIFUGO_IMAGE" \
  centrifugo

set -euo pipefail
container=ftown-centrifugo-ci
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker run -d --name "$container" \
  -e CENTRIFUGO_TOKEN_HMAC_SECRET_KEY=ci-only-secret-at-least-32-characters \
  -p 127.0.0.1:18000:8000 \
  "$CENTRIFUGO_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 30); do
  status="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18000/ || true)"
  if [ "$status" != "000" ]; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  docker logs "$container"
  exit 1
fi

for path in / /api /health; do
  status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:18000$path")"
  test "$status" = 404
done

test "$(docker exec "$container" wget -qO- http://127.0.0.1:9000/health)" = '{}'

python3 - <<'PY'
import base64
import os
import socket

def handshake(origin):
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        "GET /connection/websocket HTTP/1.1\r\n"
        "Host: 127.0.0.1:18000\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        f"Origin: {origin}\r\n\r\n"
    )
    with socket.create_connection(("127.0.0.1", 18000), timeout=5) as sock:
        sock.sendall(request.encode())
        return sock.recv(256).split(b"\r\n", 1)[0]

allowed = handshake("https://ftown.ia.br")
if b" 101 " not in allowed:
    raise SystemExit(f"Allowed WebSocket origin failed: {allowed!r}")

denied = handshake("https://attacker.example")
if b" 101 " in denied:
    raise SystemExit(f"Untrusted WebSocket origin was accepted: {denied!r}")
PY
