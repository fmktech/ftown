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
# host = localhost so neon() targets https://localhost/sql -> the neon-http-shim.
export DATABASE_URL="postgresql://ftown:ftown@localhost/ftown" # gitleaks:allow
# Trust the shim's self-signed cert (honoured by Node global fetch / undici).
export NODE_EXTRA_CA_CERTS="${E2E_DIR}/certs/cert.pem"

# MCP uses real TLS termination with the same isolated localhost certificate.
# Values are generated once in the parent run environment, never printed/files.
export FTOWN_MCP_PUBLIC_URL="https://localhost:8443"
export FTOWN_PUBLIC_URL="https://localhost:8444"
export FTOWN_MCP_APPROVAL_SECRET="${FTOWN_MCP_APPROVAL_SECRET:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')}"
export FTOWN_MCP_KEY_ENCRYPTION_SECRET="${FTOWN_MCP_KEY_ENCRYPTION_SECRET:-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')}"
export FTOWN_MCP_KEY_ENCRYPTION_KEY_ID="e2e-ephemeral-v1"
export E2E_SECOND_BRIDGE_HOME="${E2E_SECOND_BRIDGE_HOME:-${E2E_DIR}/.bridge-home-2}"
export E2E_MCP_USER_EMAIL="${E2E_MCP_USER_EMAIL:-e2e-mcp+$(date +%s)-${BASHPID:-$$}@ftown.test}"
export E2E_MCP_USER_PASSWORD="${E2E_MCP_USER_PASSWORD:-e2e-password-123}"
export E2E_MCP_BRIDGE_HOME="${E2E_MCP_BRIDGE_HOME:-${E2E_DIR}/.mcp-bridge-home}"
export E2E_MCP_SECOND_BRIDGE_HOME="${E2E_MCP_SECOND_BRIDGE_HOME:-${E2E_DIR}/.mcp-bridge-home-2}"
# Only Playwright's browser child uses this HOME and its XDG descendants.
# The trust setup/config reject relative paths or any location except this one.
export E2E_BROWSER_HOME="${E2E_BROWSER_HOME:-${E2E_DIR}/.browser-home}"
