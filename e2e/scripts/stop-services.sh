#!/usr/bin/env bash
# Kill ONLY the exact PIDs recorded by start-services.sh. Never pkill/killall.
set -uo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for name in bridge ui; do
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
echo "[stop] done (docker infra left running; use 'docker compose down -v' in e2e/ to remove)"
