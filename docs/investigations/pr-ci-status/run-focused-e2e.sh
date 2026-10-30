#!/usr/bin/env bash
# Root-only isolated Boat launcher; retains the CI job's safety checks and cleanup.
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)
cd "$root"
temp_runner=$(mktemp "$root/scripts/ci/.focused-e2e.XXXXXXXX.sh")
trap 'rm -f -- "$temp_runner"' EXIT
python3 - "$root/scripts/ci/run-job.sh" "$temp_runner" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
original = '    (cd "$E2E_DIR" && npx playwright test)'
focused = '    (cd "$E2E_DIR" && npx playwright test tests/session-tools.spec.ts tests/session-preview.spec.ts --project=chromium --workers=1)'
if source.count(original) != 1:
    raise SystemExit('Expected exactly one final Playwright command; refusing to run')
setup = '    (cd "$E2E_DIR" && npm ci && node scripts/setup-db.mjs)'
ready_setup = """    (cd "$E2E_DIR" && npm ci)
    # Compose health can observe the temporary init server before TCP is ready.
    (cd "$E2E_DIR" && timeout 60s node -e '
      const { Client } = require("pg");
      (async () => {
        const deadline = Date.now() + 59000;
        while (Date.now() < deadline) {
          const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 1000 });
          try { await client.connect(); await client.query("SELECT 1"); return; }
          catch { /* Wait for the final TCP server, not the init socket. */ }
          finally { await client.end().catch(() => {}); }
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        process.exitCode = 1;
      })().catch(() => { process.exitCode = 1; });
    ') || { echo "PostgreSQL TCP readiness failed within 60 seconds" >&2; exit 1; }
    (cd "$E2E_DIR" && node scripts/setup-db.mjs)"""
if source.count(setup) != 1:
    raise SystemExit('Expected exactly one database setup command; refusing to run')
Path(sys.argv[2]).write_text(source.replace(original, focused, 1).replace(setup, ready_setup, 1))
PY
bash "$temp_runner" e2e
