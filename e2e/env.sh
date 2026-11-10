# Shared environment for the e2e run (local + CI). CI-local only, nothing
# sensitive — but realistic: getRequiredSecret rejects the shipped placeholder
# values, so e2e must exercise a real-shaped secret.
# Usage: `set -a; source e2e/env.sh; set +a` from the repo root, with E2E_DIR set.
: "${E2E_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

# Never inherit a REAL bridge's or tmux server's coordinates (e.g. when the run is
# started from inside an ftown session: FTOWN_DATA_DIR, FTOWN_BRIDGE_POINTER,
# FTOWN_HOOK_*, FTOWN_SESSION_ID, TMUX…). CLI children spawned by specs would
# otherwise resolve the production bridge instead of the test bridge.
# (Portable: bash and zsh.)
for __e2e_name in $(env | awk -F= '/^(FTOWN_[A-Za-z0-9_]*|TMUX|TMUX_PANE|TMUX_TMPDIR)=/ { print $1 }'); do
  unset "$__e2e_name"
done
unset __e2e_name

# Ports. The defaults are the CI values; override them locally when a port is
# taken (e.g. `E2E_UI_PORT=3001 E2E_PUBLIC_URL=http://localhost:3001`). Centrifugo
# only allows the origins listed in e2e/centrifugo.config.json
# (http://localhost:3000-3002 and https://localhost:8444), so pick the UI port /
# public URL among those.
export E2E_UI_PORT="${E2E_UI_PORT:-3000}"
export E2E_TLS_PORT="${E2E_TLS_PORT:-8444}"

export CENTRIFUGO_TOKEN_SECRET="e2e-centrifugo-token-secret-0123456789abcdef"
export CENTRIFUGO_API_KEY="e2e-centrifugo-api-key-0123456789abcdef"
export NEXT_PUBLIC_CENTRIFUGO_URL="ws://localhost:8000/connection/websocket"
export AUTH_SECRET="e2e-auth-secret-not-for-production" # gitleaks:allow
# Many independent accounts per server, each created in the browser with a
# passkey (no setup secret). Creation is open only while REGISTRATION_ENABLED is
# "true", and is rate-limited per client IP per hour and globally per day. The
# suite creates the shared account A, several second accounts B and throwaway
# genesis chains; locally and in CI the global key is shared by every run and
# test sources are synthetic, so both creation budgets are raised far above the
# suite's needs (the production defaults are 5/IP/hour and 200/day).
export REGISTRATION_ENABLED="true"
export FTOWN_ACCOUNT_CREATE_PER_IP_HOUR="100000"
export FTOWN_ACCOUNT_CREATE_GLOBAL_DAY="100000"
# Auth.js v5 does not trust the Host header under `next start` (prod) unless told to.
# Vercel sets this automatically; we set it for the local/CI prod run.
export AUTH_TRUST_HOST="true"
# Test-only: the local/CI UI is fronted by the E2E fixtures' synthetic x-real-ip
# source (see e2e/helpers/app.ts). Without this the UI would fail closed to the
# shared "unknown" bucket. Production deployments leave this unset.
export FTOWN_TRUSTED_PROXY="1"
# host = localhost so neon() targets https://localhost/sql -> the neon-http-shim.
export DATABASE_URL="postgresql://ftown:ftown@localhost/ftown" # gitleaks:allow
# Trust the shim's self-signed cert (honoured by Node global fetch / undici).
export NODE_EXTRA_CA_CERTS="${E2E_DIR}/certs/cert.pem"

# The ONE origin of the whole run: the browser loads it, the passkey (WebAuthn
# needs a secure context: https://… or http://localhost) is bound to it, the
# server checks device/bridge key proofs against it, and the bridges use it as
# --api-url (their pairing link and proof audience derive from it).
# CI: the UI behind the isolated localhost TLS terminator. Local override:
# E2E_PUBLIC_URL=http://localhost:<E2E_UI_PORT>.
export FTOWN_PUBLIC_URL="${E2E_PUBLIC_URL:-https://localhost:${E2E_TLS_PORT}}"
# Build-time inlined into the browser bundle: must match FTOWN_PUBLIC_URL.
export NEXT_PUBLIC_FTOWN_PUBLIC_URL="$FTOWN_PUBLIC_URL"
export NEXT_PUBLIC_FTOWN_RP_ID="localhost"
export UI_BASE_URL="$FTOWN_PUBLIC_URL"
export E2E_SECOND_BRIDGE_HOME="${E2E_SECOND_BRIDGE_HOME:-${E2E_DIR}/.bridge-home-2}"
# Only Playwright's browser child uses this HOME and its XDG descendants.
# The trust setup/config reject relative paths or any location except this one.
export E2E_BROWSER_HOME="${E2E_BROWSER_HOME:-${E2E_DIR}/.browser-home}"
