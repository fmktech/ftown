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
npx playwright test
```

The bridge always runs with `HOME` overridden to `e2e/.bridge-home` — it never
touches the real `~/.ftown`.

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
bash scripts/stop-services.sh   # kills ONLY recorded UI/bridge/MCP/proxy PIDs
npm run infra:down              # docker compose down -v (drops the throwaway postgres)
rm -rf .bridge-home .bridge-home-2 certs .run-email *.log
```

The registered DB user is intentionally left behind (throwaway Postgres); `infra:down`
removes it with the volume.

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
