# direct-transport e2e

Playwright suite exercising the WebRTC direct data plane vs. the Centrifugo
fallback (see `docs/plans/direct-transport-contract.md`), against a real UI,
bridge, and Centrifugo.

- **Test A** — direct path: terminal works while the session's `terminal:<sid>`
  Centrifugo channel has NO subscriber (R3).
- **Test B** — WebRTC disabled ⇒ Centrifugo fallback: terminal works AND
  `terminal:<sid>` HAS a subscriber (R2).

## Layout

- `docker-compose.yml` — postgres + `neon-http-shim` (:443) + centrifugo (:8000).
- `neon-http-shim/` — tiny HTTPS server speaking the Neon HTTP query protocol so
  the UI's `@neondatabase/serverless` `neon()` driver reaches plain Postgres
  **without any change to `ui/src`** (the driver forces `https://<host>/sql`).
- `centrifugo.config.json` — copy of `centrifugo/config.json` + `allow_publish_for_client`
  on every namespace (matching `config.prod.json`; the dev config omits it and
  breaks client-side `terminal:*` publishes — see repo findings).
- `env.sh` — shared dev env (CI-local placeholders; nothing sensitive).
- `scripts/` — `gen-certs.sh`, `setup-db.mjs`, `start-services.sh`, `stop-services.sh`.
- `helpers/`, `tests/` — Playwright config, page-flow + Centrifugo helpers, the spec.

## Run locally

The TLS browser checks use Linux Chromium with `certutil` from Ubuntu/Debian's
`libnss3-tools` package. Use the isolated Linux development sandbox for these
checks on other operating systems. The parent Node process keeps its normal
HOME and Playwright executable cache; only the browser child receives the
dedicated HOME and XDG directories below.

```bash
cd e2e
sudo apt-get install -y libnss3-tools
npm ci
set -a
export E2E_DIR="$PWD"
source env.sh                   # generate ephemeral secrets once in this shell
set +a
npm run infra:up          # gen certs + docker compose up --wait (needs :443 :8000 :5432 free)
node scripts/setup-browser-trust.mjs
npm run setup-db          # create users + login_attempts tables
( cd ../ui && npm ci && npm run build )       # NEXT_PUBLIC_* is build-time inlined
( cd ../bridge && npm ci && npm run build )
npx playwright install chromium
bash scripts/start-services.sh   # starts UI (next start) + bridge (scratch HOME); records PIDs
export E2E_USER_EMAIL="$(cat .run-email)"
export E2E_MCP_USER_EMAIL="$(cat .run-mcp-email)"
npx playwright test
```

The command above runs both Chromium projects with at most two workers. The
`chromium` project serializes shared-account and shared-bridge tests; the
`chromium-isolated` project runs account-trust, device-display-names and
pending-approvals with independently owned accounts and bridge homes. The trust
and pending-approval specs each use one scenario with desktop and mobile
interactions. Consolidation removes repeated ceremonies only when every distinct
security, persistence, transport, responsive and error assertion has a surviving
owner; the [trust coverage map](../docs/investigations/e2e-consolidation/trust-review.md)
and [suite coverage map](../docs/investigations/e2e-consolidation/suite-review.md)
record those decisions. New specs stay in the shared lane by default. Add a spec
to the isolated allowlist only after reviewing its account, bridge, session, filesystem and service ownership
and verifying safe overlap in a full run.

UI actions have a 15-second timeout to bound blocked interactions. This is
separate from the 15-second default assertion timeout and the overall test timeout;
individual scenarios and assertions may use their existing explicit budgets. The
performance target is a complete CI job under 300 seconds, excluding queue time;
confirm it with whole-job measurement rather than Playwright timing alone.

After the setup above, these commands select the intended coverage:

```bash
npx playwright test                              # both projects, full suite
npx playwright test --workers=1                  # both projects, serial diagnostic
npx playwright test --project=chromium-isolated # isolated account scenarios only
npx playwright test --project=chromium-isolated tests/account-trust.spec.ts tests/pending-approvals.spec.ts
```

`--project=chromium` runs only the shared lane; it no longer includes
`account-trust.spec.ts` or `pending-approvals.spec.ts`. For historical commands
that include either file with that filter, omit the project filter or select
`--project=chromium-isolated` instead. The root coordinator owns the service
lifecycle and executes browser runs; use the setup and cleanup steps on this
page. Each repeated full run needs a fresh task-local database and environment
because virgin bridge pairing consumes a real per-IP quota.

The original account uses `e2e/.bridge-home` and `.bridge-home-2`. MCP account
migration uses a separate run-scoped `E2E_MCP_USER_EMAIL`, recorded in
`.run-mcp-email`, and `E2E_MCP_USER_PASSWORD` (default `e2e-password-123`). Its
`E2E_MCP_BRIDGE_HOME` and `E2E_MCP_SECOND_BRIDGE_HOME` must be the exact absolute
`e2e/.mcp-bridge-home` and `.mcp-bridge-home-2` paths. These two bridges start with
auth-only bootstrap credentials, then the MCP test explicitly migrates only this
account. The shared original account and grants remain unchanged. The gateway
registry authorizes both immutable account UUIDs, each with only its two exact
bridge IDs. All four bridges use isolated HOME and data directories; the real
`~/.ftown` is never used. Preflight rejects unexpected homes, selectors, PID
records or occupied application ports before any reset or service startup.

The root-only database acceptance harness runs independently in a temporary
schema on the same isolated PostgreSQL. After resource preflight and sourcing
the run environment, invoke once from the repository root on Node24.22.1+:
`node e2e/scripts/check-account-trust-db.mjs`. It loads the real stores, verifies
populated migration0007 twice, signed CAS/owner/tamper checks, concurrent enrollment
capacity and pairing guards, and drops only its owned schema in finally. It logs
no fixture rows or secrets. It does not replace the browser checks.

`E2E_BROWSER_HOME` must be exactly the canonical absolute
`$E2E_DIR/.browser-home`. Setup and Playwright reject other or relative locations.
The browser uses that HOME plus `.local/share`, `.config` and `.cache` XDG
descendants. The setup script validates the generated localhost certificate's
validity, self-signature and localhost/127.0.0.1 SANs, then imports only that exact
certificate with peer trust `P,,` in the modern
`.local/share/pki/nssdb` database. It verifies the exported fingerprint and only
updates its fixed nickname on repeat setup. A legacy `.pki/nssdb` or symlinked
path is rejected; no system/user certificate store is changed. Chromium's
[Linux certificate documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/linux/cert_management.md)
describes the modern store and self-signed peer trust. No certificate-error bypass
is needed for the TLS endpoints.

## Cleanup

```bash
# Run after Playwright/browser shutdown; also removes the guarded browser HOME.
bash scripts/stop-services.sh   # removes sessions using encrypted local clients, then exact recorded PIDs
npm run infra:down              # docker compose down -v (drops the throwaway postgres)
rm -rf certs *.log
```

Teardown removes all four guarded scratch homes, run-email files and browser
trust home after successful cleanup. Dedicated MCP PIDs are `.mcp-bridge.pid`
and `.mcp-bridge-2.pid`; logs are `mcp-bridge.log` and `mcp-bridge-2.log`.
Failed session/process identity verification preserves the scratch homes and
returns failure for root inspection. The two registered DB accounts remain in
the throwaway PostgreSQL; `infra:down` removes them with the volume.

## Note on the direct path (Test A) behind a full-tunnel VPN

Test A requires a real WebRTC DataChannel between headless Chromium and the
bridge's `node-datachannel`. On a host behind a **full-tunnel VPN** (e.g. a
`utun*` point-to-point interface as the default route), Chromium offers only the
VPN interface's non-hairpinning host candidate, so ICE never validates a pair and
the client silently falls back — making Test A fail locally. This is an
environment artifact, not a product/test bug: node-datachannel P2P over loopback
and the full signaling exchange both work. CI (single interface, no VPN) and any
non-VPN host connect normally.

The service startup script runs explicit `ftown setup` in its disposable bridge
HOME before starting the bridge. Setup and readiness never target the real HOME.
