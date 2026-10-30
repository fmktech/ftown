#!/usr/bin/env bash
# Root-run only: retain CI's E2E preflight and cleanup while selecting focused specs.
set -euo pipefail
umask 022
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd -P)
cd "$root"
if (( $# != 1 )); then echo 'Usage: bash docs/investigations/update-dialog/linux-repro.sh preview|focused|push' >&2; exit 2; fi
case "$1" in preview|focused|push) mode=$1 ;; *) echo 'Invalid reproduction mode' >&2; exit 2 ;; esac
[[ $(uname -s) == Linux && $(uname -m) == x86_64 && $(node --version) == v24.22.1 ]] || { echo 'Linux x86_64 with Node v24.22.1 required' >&2; exit 1; }
# Only this temporary copy is written before the inherited resource preflight.
tmp=$(mktemp -d)
trap 'rm -rf -- "$tmp"' EXIT
node - "$root" "$tmp/run-job.sh" "$mode" <<'JS'
const fs = require('node:fs');
const [root, dest, mode] = process.argv.slice(2);
let source = fs.readFileSync(`${root}/scripts/ci/run-job.sh`, 'utf8');
const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) throw Error(`CI script changed or ambiguous: ${before}`);
  source = source.slice(0, first) + after + source.slice(first + before.length);
}
replaceOnce('root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)', `root=${shellQuote(root)}`);
replaceOnce('    node --test scripts/ci/boat-runner.test.mjs scripts/ci/bridge-version.test.mjs\n', '');
replaceOnce('    node --test "$E2E_DIR/scripts/setup-browser-trust.test.mjs"\n', '');
replaceOnce('    (cd ui && npm ci && npm test && node --test ../e2e/scripts/ci-fixtures.test.mjs && npm run build)', '    (cd ui && npm ci && npm run build)');
replaceOnce('    (cd bridge && npm ci && npm run build && npm test && node --test ../scripts/release/*.test.mjs)', '    (cd bridge && npm ci && npm run build)');
replaceOnce('    MIGRATION_DATABASE_URL="$DATABASE_URL" timeout 120s node e2e/scripts/rate-limit-db.ts\n', '');
replaceOnce('    E2E_USER_EMAIL="e2e-db-pending+${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}@ftown.test" node e2e/scripts/pending-approvals-db.ts\n', '');
replaceOnce('    timeout 120s node bridge/scripts/centrifugo-security-smoke.mjs\n', '');
replaceOnce('    timeout 120s node e2e/scripts/mcp-body-parser-smoke.ts\n', '');
const specs = mode === 'preview' ? 'tests/session-preview.spec.ts' : mode === 'push' ? 'tests/push-notifications.spec.ts --grep "real push API binds bridge owner and durably deduplicates idle cycles/questions without recipients"' : 'tests/bridge-updates.spec.ts tests/session-lifecycle.spec.ts tests/session-preview.spec.ts';
replaceOnce('    (cd "$E2E_DIR" && npx playwright test)', `    (cd "$E2E_DIR" && npx playwright test ${specs} --project=chromium --workers=1)`);
fs.writeFileSync(dest, source, { mode: 0o600, flag: 'wx' });
JS
bash "$tmp/run-job.sh" e2e
