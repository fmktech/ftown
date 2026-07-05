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

```bash
cd e2e
npm ci
npm run infra:up          # gen certs + docker compose up --wait (needs :443 :8000 :5432 free)
npm run setup-db          # create users + login_attempts tables
( cd ../ui && npm ci && npm run build )       # NEXT_PUBLIC_* is build-time inlined
( cd ../bridge && npm ci && npm run build )
npx playwright install chromium
bash scripts/start-services.sh   # starts UI (next start) + bridge (scratch HOME); records PIDs
set -a; E2E_DIR="$PWD" source env.sh; export E2E_USER_EMAIL="$(cat .run-email)"; set +a
npx playwright test
```

The bridge always runs with `HOME` overridden to `e2e/.bridge-home` — it never
touches the real `~/.ftown`.

## Cleanup

```bash
bash scripts/stop-services.sh   # kills ONLY the recorded UI + bridge PIDs (never pkill)
npm run infra:down              # docker compose down -v (drops the throwaway postgres)
rm -rf .bridge-home certs .run-email *.log
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
