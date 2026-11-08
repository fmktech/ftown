# Shared environment for the e2e run (local + CI). CI-local only, nothing
# sensitive — but realistic: getRequiredSecret rejects the shipped placeholder
# values, so e2e must exercise a real-shaped secret.
# Usage: `set -a; source e2e/env.sh; set +a` from the repo root, with E2E_DIR set.
: "${E2E_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

export CENTRIFUGO_TOKEN_SECRET="e2e-centrifugo-token-secret-0123456789abcdef"
export CENTRIFUGO_API_KEY="e2e-centrifugo-api-key-0123456789abcdef"
export NEXT_PUBLIC_CENTRIFUGO_URL="ws://localhost:8000/connection/websocket"
export AUTH_SECRET="e2e-auth-secret-not-for-production" # gitleaks:allow
# The E2E suite creates a fresh run-scoped account against `next start`.
# Production registration is fail-closed unless this explicit test-only opt-in
# is present.
export REGISTRATION_ENABLED="true"
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

# The UI is served through the same isolated localhost certificate (TLS proxy).
export FTOWN_PUBLIC_URL="https://localhost:8444"
export E2E_SECOND_BRIDGE_HOME="${E2E_SECOND_BRIDGE_HOME:-${E2E_DIR}/.bridge-home-2}"
# Only Playwright's browser child uses this HOME and its XDG descendants.
# The trust setup/config reject relative paths or any location except this one.
export E2E_BROWSER_HOME="${E2E_BROWSER_HOME:-${E2E_DIR}/.browser-home}"
