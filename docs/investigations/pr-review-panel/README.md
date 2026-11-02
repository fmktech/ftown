# PR review panel manual smoke

This is an isolated, deterministic Playwright smoke for the PR review panel. It exercises the real session CLI, browser-to-bridge encryption and preview, with a fail-closed `gh` fixture supplying one PR's metadata and diff. It checks desktop and mobile navigation, hostile text rendering, panel transitions, and preservation of the terminal and preview where applicable. Screenshots and traces are retained by Playwright. The GraphQL status fixture returns unavailable rather than inventing a check result.

**This is a manual smoke, not part of the default CI suite.** The spec lives here deliberately; copy it into `e2e/tests` only in a disposable sandbox. It does not test real GitHub, authority revocation, delayed responses or every size/chunk limit. Its browser network check and fake-process log do not by themselves prove process-level network isolation.

## Isolation and prerequisites

Use a fresh, disposable Linux development sandbox and the repository's [E2E setup and cleanup instructions](../../../e2e/README.md). Install or provide its documented dependencies, built UI and bridge, Chromium, `certutil`, and the Docker infrastructure in that sandbox. Do not use a production or shared database, an existing user's services, a real browser profile, or real GitHub credentials. Block outbound access to GitHub at the sandbox boundary. The fake `gh` makes no network calls and rejects every request except its fixture metadata, diff and sanitized status query, but egress blocking gives an independent guarantee.

Before any infrastructure or service startup, inspect the effective Docker context and Compose selectors and ensure the infrastructure is task-owned. Verify ports 443, 8000 and 5432 are free for the isolated infrastructure, and 3000, 8080, 8443 and 8444 are free for task-owned services; do not stop another process to make room. Confirm the canonical E2E scratch homes, browser home, PID records and all effective database/deployment selectors match the local test setup in `e2e/scripts/start-services.sh`. The script has preflight guards, but those do not replace checking ownership before running infrastructure or database setup. Never point the test at a remote or shared database.

From the disposable checkout's `e2e` directory, source the environment **once** for the run; it creates ephemeral secrets. Verify the database selector and PostgreSQL overrides before any setup that writes data:

```sh
export E2E_DIR="$PWD"
set -a
. ./env.sh
set +a
node <<'JS'
const assert = require('node:assert/strict');
const db = new URL(process.env.DATABASE_URL);
assert.ok(['postgres:', 'postgresql:'].includes(db.protocol));
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(db.hostname));
assert.equal(db.port || '5432', '5432');
assert.equal(db.pathname, '/ftown');
assert.equal(db.username, 'ftown');
assert.equal(db.search, ''); assert.equal(db.hash, '');
for (const [key, expected] of [['PGPORT', '5432'], ['PGDATABASE', 'ftown'], ['PGUSER', 'ftown']])
  if (process.env[key] !== undefined) assert.equal(process.env[key], expected);
if (process.env.PGHOST !== undefined) assert.ok(['localhost', '127.0.0.1', '::1'].includes(process.env.PGHOST));
for (const key of ['PGHOSTADDR', 'PGOPTIONS', 'PGSERVICE', 'PGSERVICEFILE']) assert.ok(!process.env[key]);
assert.equal(process.env.FTOWN_PUBLIC_URL, 'https://localhost:8444');
assert.equal(process.env.FTOWN_MCP_PUBLIC_URL, 'https://localhost:8443');
assert.equal(process.env.NEXT_PUBLIC_CENTRIFUGO_URL, 'ws://localhost:8000/connection/websocket');
JS
```

After confirming the checks and isolated resource ownership, prepare infrastructure, browser trust and the throwaway database as described in the E2E README. For an already provisioned sandbox with dependencies and browser installed:

```sh
npm run infra:up
node scripts/setup-browser-trust.mjs
npm run setup-db
( cd ../ui && npm run build )
( cd ../bridge && npm run build )
```

## Run

Install the fixture in a task-owned temporary directory **before** starting the bridge. The bridge process and test process must inherit the same `PATH` and log variable. Use no real GitHub credentials:

```sh
PR_REVIEW_FAKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pr-review-gh.XXXXXXXX")"
export FTOWN_PR_REVIEW_FAKE_GH_LOG="$PR_REVIEW_FAKE_DIR/invocations.log"
: > "$FTOWN_PR_REVIEW_FAKE_GH_LOG"
chmod 600 "$FTOWN_PR_REVIEW_FAKE_GH_LOG"
cp ../docs/investigations/pr-review-panel/fake-gh.cjs "$PR_REVIEW_FAKE_DIR/gh"
chmod 700 "$PR_REVIEW_FAKE_DIR/gh"
test ! -e tests/pr-review-smoke.spec.ts
cp ../docs/investigations/pr-review-panel/pr-review-smoke.spec.ts tests/pr-review-smoke.spec.ts
PR_REVIEW_ORIGINAL_PATH="$PATH"
export PATH="$PR_REVIEW_FAKE_DIR:$PATH"
unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN
command -v gh
bash scripts/start-services.sh
export E2E_USER_EMAIL="$(cat .run-email)"
npx playwright test --project=chromium --workers=1 tests/pr-review-smoke.spec.ts
```

Confirm `command -v gh` resolves to the task-owned `gh`, and verify the bridge inherited the fixture PATH and `FTOWN_PR_REVIEW_FAKE_GH_LOG`; the sandbox PATH must still contain a compatible `node` for its shebang. The spec requires the log and checks for `metadata` and `diff` categories. Inspect it before cleanup: a `rejected` category signals an unexpected `gh` invocation. It contains only categories, never request bodies or credentials. The test creates and cleans its own sessions; Playwright results and screenshots are in `e2e/test-results` and its report.

## Cleanup

After the browser exits, inspect the log and run the existing guarded teardown **only for this task's verified services and disposable database**:

```sh
cat "$FTOWN_PR_REVIEW_FAKE_GH_LOG"
bash scripts/stop-services.sh
npm run infra:down
export PATH="$PR_REVIEW_ORIGINAL_PATH"
rm tests/pr-review-smoke.spec.ts
rm "$PR_REVIEW_FAKE_DIR/gh" "$PR_REVIEW_FAKE_DIR/invocations.log"
rmdir "$PR_REVIEW_FAKE_DIR"
unset FTOWN_PR_REVIEW_FAKE_GH_LOG PR_REVIEW_FAKE_DIR PR_REVIEW_ORIGINAL_PATH
```

Confirm the recorded task-owned processes, database volumes and sandbox are stopped or removed. If a teardown ownership guard fails, preserve the affected resources for inspection rather than killing unrelated processes or deleting shared data.
