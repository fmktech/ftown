#!/usr/bin/env bash
# Kill ONLY the exact PIDs recorded by start-services.sh. Never pkill/killall.
set -uo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for name in mcp mcp-tls bridge-2 bridge ui; do
  f="$E2E_DIR/.$name.pid"
  if [ -f "$f" ]; then
    pid="$(cat "$f")"
    if kill -0 "$pid" 2>/dev/null; then
      echo "[stop] killing $name pid $pid"
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
done
# The caller must stop/await Playwright before this teardown. Trust cleanup is
# independently guarded and never touches the runner's real HOME/NSS database.
node "$E2E_DIR/scripts/setup-browser-trust.mjs" --cleanup || exit 1
echo "[stop] done (docker infra left running; use 'docker compose down -v' in e2e/ to remove)"
