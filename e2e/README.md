# ftown e2e

Playwright suite against a real UI (`next start`), real bridges, Centrifugo and
PostgreSQL: passkey account and sign-in, computer pairing and removal, browser
removal, the encrypted session/terminal data plane (WebRTC direct path vs. the
Centrifugo fallback, see `docs/plans/direct-transport-contract.md`), previews,
attention, mail, push, usage and the admission/IDOR guards.

## Layout

- `docker-compose.yml` — postgres + `neon-http-shim` (:443) + centrifugo (:8000).
- `neon-http-shim/` — tiny HTTPS server speaking the Neon HTTP query protocol so
  the UI's `@neondatabase/serverless` `neon()` driver reaches plain Postgres
  **without any change to `ui/src`** (the driver forces `https://<host>/sql`).
- `centrifugo.config.json` — copy of `centrifugo/config.json` + `allow_publish_for_client`
  on every namespace (matching `config.prod.json`; the dev config omits it and
  breaks client-side `terminal:*` publishes — see repo findings).
- `env.sh` — shared dev env (CI-local placeholders; nothing sensitive).
- `scripts/` — `gen-certs.sh`, `setup-db.mjs`, `start-services.sh`, `stop-services.sh`, `tls-proxy.mjs`.
- `helpers/` — `passkey.ts` (Chrome virtual authenticator, account creation, sign-in, /pair
  approval), `second-account.ts` (a real second account B), `ledger-admin.ts` (Node-side
  passkey signer, ledger reads, key proofs, creation chains), `ledger-bridge.ts`
  (test-owned unpaired bridges), `db.ts` (direct access to the throwaway fixture
  database, e.g. sealed-checkpoint tampering in `ledger-checkpoint.spec.ts`),
  `browser-proof.ts` (proofs signed in-page by a browser's own device key),
  app/Centrifugo/bridge-API helpers.
- `tests/account.setup.ts` — the `setup` project: creates the shared account A and pairs
  the two shared bridges to it. `tests/*.spec.ts` — the suite.

## Accounts A and B

The server holds many independent accounts. Anyone with a passkey can create
one on `/login` ("Create an account": account name, passkey label, browser
label; no setup secret) while `REGISTRATION_ENABLED=true`. `env.sh` raises the
account-creation budgets (`FTOWN_ACCOUNT_CREATE_PER_IP_HOUR`,
`FTOWN_ACCOUNT_CREATE_GLOBAL_DAY`) far above the suite's needs: every test
source is synthetic and the global key is shared by the whole run.

**Account A — the shared default.** Almost every spec uses it:

1. `scripts/start-services.sh` starts the UI and two UNPAIRED shared bridges
   (`.bridge-home`, `.bridge-home-2`); each prints a `/pair#req=…` link and a
   6-digit code into `bridge.log` / `bridge-2.log` and waits 10 minutes.
2. The Playwright `setup` project (`tests/account.setup.ts`, a dependency of the
   `chromium` project) creates account A through the real `/login` form with a
   Chrome virtual authenticator (CDP `WebAuthn.*`, ctap2, internal, resident
   key, UV), exports the passkey to `e2e/.run-account.json` (mode 0600,
   throwaway account) and approves both bridges on `/pair` by typing their codes.
   It is idempotent: a rerun against the same stack reuses the account.
3. Every spec signs its browser contexts in with that passkey ("the same synced
   passkey on another device": the credential is imported into the context's own
   virtual authenticator), i.e. passkey identify + "Add this browser". The
   `test` fixture (`helpers/fixtures.ts`) revokes every browser a test enrolled,
   so A's ledger stays under its 128-browser limit.

**Account B — a real second account, on demand.** `createSecondAccount(browser)`
(`helpers/second-account.ts`) creates an unrelated account through the same
`/login` form in its OWN browser context with its OWN virtual authenticator
(its own passkey) and first device; `pairBridge()` starts an isolated bridge
and pairs it to B through B's own `/pair` approval. Every credential B uses
(session, relay token, device key, bridge key, passkey) is B's own; nothing is
minted. `close()` stops only the bridge process it spawned and closes the
context. `tests/account-isolation.spec.ts` uses A and B to prove that B can
neither see nor touch anything of A (dashboard, HTTP routes, ledger, relay
subscribe/publish, browser binding). Throwaway accounts stay in the database.

Specs share account A and the bridges and run serially (`workers: 1`). A fresh
stack should start from an empty database (`node scripts/setup-db.mjs --reset`,
or `docker compose down -v`): `.run-account.json` must name an account the
server holds.

`setup-db.mjs` models a production upgrade: v1 base tables, then
`ui/migrations/0005…` each in its own transaction (like `ui/scripts/migrate.mjs`),
a second run of `0011` (idempotency), and a load of `ui/schema.sql` into a scratch
schema (fresh install).

## Run locally

All ports and the public origin come from `env.sh`; the defaults are the CI
values (UI :3000 behind the TLS terminator :8444, origin `https://localhost:8444`).
WebAuthn needs a secure context (`https://…` trusted by the browser, or
`http://localhost`), and the passkey, the server's proof audience
(`FTOWN_PUBLIC_URL`), the browser bundle (`NEXT_PUBLIC_FTOWN_PUBLIC_URL`, build
time!) and the bridges' `--api-url` must all use the same origin. On a machine
where :3000 is taken, or without Linux NSS trust for the fixture certificate:

```bash
cd e2e
export E2E_DIR="$PWD" E2E_UI_PORT=3001 E2E_PUBLIC_URL=http://localhost:3001
export COMPOSE_PROJECT_NAME=ftown-e2e-local          # optional: isolate from other checkouts
set -a; source env.sh; set +a                        # also drops inherited FTOWN_*/TMUX* variables
npm ci
npm run infra:up                                     # needs :443 :8000 :5432 free
node scripts/setup-db.mjs --reset
( cd ../ui && npm ci && npm run build )              # NEXT_PUBLIC_* are inlined: rebuild after changing the origin
( cd ../bridge && npm ci && npm run build )
npx playwright install chromium
bash scripts/start-services.sh                       # then run Playwright within 10 minutes (pairing links expire)
npx playwright test                                  # setup project first, then the suite
```

Centrifugo only allows the origins in `centrifugo.config.json`
(`http://localhost:3000-3002`, `https://localhost:8444`): pick the UI port from
those. With an `https://` origin on a non-Linux host the Playwright config pins
the fixture certificate's SPKI (`--ignore-certificate-errors-spki-list`) so the
page is a valid secure context; on Linux (CI) the browser trusts it through the
isolated NSS store set up by `scripts/setup-browser-trust.mjs` (needs
`libnss3-tools`; `E2E_BROWSER_HOME` must be exactly `$E2E_DIR/.browser-home`).

Every test bridge (shared or test-owned) runs with a scratch HOME and data dir, a
private tmux socket directory (`/tmp/ftpk-XXXXXX`, recorded next to its PID) and
no inherited `FTOWN_*`/`TMUX*` variables; the real `~/.ftown` and tmux server are
never used, and teardown kills only recorded PIDs and private tmux sockets.

## Cleanup

```bash
bash scripts/stop-services.sh   # removes sessions through each owned bridge, then exact recorded PIDs + private tmux servers
npm run infra:down              # docker compose down -v (drops the throwaway postgres and its account)
rm -rf certs *.log
```

Teardown also removes the scratch homes, `.isolated-bridges/` and
`.run-account.json`. A failed PID identity check preserves the homes and returns
failure for inspection.

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
