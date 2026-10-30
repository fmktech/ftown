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
focused = '    (cd "$E2E_DIR" && npx playwright test tests/session-tools.spec.ts --project=chromium --workers=1)'
if source.count(original) != 1:
    raise SystemExit('Expected exactly one final Playwright command; refusing to run')
Path(sys.argv[2]).write_text(source.replace(original, focused, 1))
PY
bash "$temp_runner" e2e
