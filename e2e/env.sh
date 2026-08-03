# Shared environment for the e2e run (local + CI). Values are the dev placeholders
# from centrifugo/config.json — CI-local only, nothing sensitive.
# Usage: `set -a; source e2e/env.sh; set +a` from the repo root, with E2E_DIR set.
: "${E2E_DIR:=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

export CENTRIFUGO_TOKEN_SECRET="your-centrifugo-token-secret-change-me"
export CENTRIFUGO_API_KEY="your-centrifugo-api-key-change-me"
export NEXT_PUBLIC_CENTRIFUGO_URL="ws://localhost:8000/connection/websocket"
export AUTH_SECRET="e2e-auth-secret-not-for-production" # gitleaks:allow
# The E2E suite creates a fresh run-scoped account against `next start`.
# Production registration is fail-closed unless this explicit test-only opt-in
# is present.
export REGISTRATION_ENABLED="true"
# Auth.js v5 does not trust the Host header under `next start` (prod) unless told to.
# Vercel sets this automatically; we set it for the local/CI prod run.
export AUTH_TRUST_HOST="true"
# host = localhost so neon() targets https://localhost/sql -> the neon-http-shim.
export DATABASE_URL="postgresql://ftown:ftown@localhost/ftown" # gitleaks:allow
# Trust the shim's self-signed cert (honoured by Node global fetch / undici).
export NODE_EXTRA_CA_CERTS="${E2E_DIR}/certs/cert.pem"
