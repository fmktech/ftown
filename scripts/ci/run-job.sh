#!/usr/bin/env bash
set -euo pipefail
umask 022
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd "$root"
job=${1:-}
case "$job" in e2e|release-artifacts|gitleaks|bridge-version|centrifugo) ;; *) echo "Invalid CI job" >&2; exit 2;; esac
source scripts/ci/setup-runtime.sh
case "$job" in
  release-artifacts)
    case ${NPM_VERSION:-} in 11|latest) ;; *) echo "Invalid npm version" >&2; exit 2;; esac
    npm install -g "npm@$NPM_VERSION"
    ( cd bridge; npm ci; npm run build; node --test ../scripts/release/*.test.mjs )
    ;;
  gitleaks)
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    curl --fail --location --retry 3 --connect-timeout 15 --max-time 180 https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz -o "$tmp/gitleaks.tar.gz"
    tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
    "$tmp/gitleaks" git --redact -v
    ;;
  bridge-version)
    [[ ${BASE:-} =~ ^[0-9a-f]{40}$ && ${HEAD:-} =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid base or head SHA" >&2; exit 2; }
    changes=$(node scripts/release/package-changes.mjs "$BASE" "$HEAD")
    echo "$changes"
    if [[ $(printf '%s' "$changes" | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(String(JSON.parse(s).packageChanged)))') == true ]]; then
      base_version=$(git show "$BASE:bridge/package.json" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')
      head_version=$(node -p 'require("./bridge/package.json").version')
      lock_version=$(node -p 'require("./bridge/package-lock.json").packages[""].version')
      echo "base bridge version: $base_version"; echo "head bridge version: $head_version"
      [[ "$base_version" != "$head_version" ]] || { echo "::error::This PR changes bridge package/build inputs but does not bump bridge/package.json version." >&2; exit 1; }
      [[ "$head_version" == "$lock_version" ]] || { echo "::error::bridge/package-lock.json root version does not match bridge/package.json" >&2; exit 1; }
    fi
    ;;
  centrifugo) bash scripts/ci/validate-centrifugo.sh ;;
  e2e)
    node --test scripts/ci/boat-runner.test.mjs
    # Reject all inherited endpoint, credential and test-selector overrides before sourcing fixtures.
    for name in DATABASE_URL MIGRATION_DATABASE_URL PGHOST PGPORT PGUSER PGDATABASE PGPASSWORD PGOPTIONS PGSERVICE PGSERVICEFILE FTOWN_PUBLIC_URL FTOWN_MCP_PUBLIC_URL NEXT_PUBLIC_CENTRIFUGO_URL FTOWN_DATA_DIR FTOWN_MCP_CONFIG_JSON E2E_DIR E2E_BROWSER_HOME E2E_SECOND_BRIDGE_HOME E2E_MCP_BRIDGE_HOME E2E_MCP_SECOND_BRIDGE_HOME E2E_USER_EMAIL E2E_MCP_USER_EMAIL E2E_MCP_USER_PASSWORD NODE_EXTRA_CA_CERTS AUTH_SECRET CENTRIFUGO_API_KEY CENTRIFUGO_TOKEN_SECRET; do
      if printenv "$name" >/dev/null; then echo "Inherited override $name rejected" >&2; exit 1; fi
    done
    export E2E_DIR="$root/e2e"
    set -a; source "$E2E_DIR/env.sh"; set +a
    [[ $DATABASE_URL == postgresql://ftown:ftown@localhost/ftown && $FTOWN_PUBLIC_URL == https://localhost:8444 && $FTOWN_MCP_PUBLIC_URL == https://localhost:8443 && $NEXT_PUBLIC_CENTRIFUGO_URL == ws://localhost:8000/connection/websocket ]] || { echo "Unsafe test endpoint" >&2; exit 1; }
    node <<'JS'
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const dir = process.env.E2E_DIR;
if (path.resolve(dir) !== fs.realpathSync(dir)) throw Error('Noncanonical e2e directory');
for (const [key, leaf] of [['E2E_BROWSER_HOME','.browser-home'], ['E2E_SECOND_BRIDGE_HOME','.bridge-home-2'], ['E2E_MCP_BRIDGE_HOME','.mcp-bridge-home'], ['E2E_MCP_SECOND_BRIDGE_HOME','.mcp-bridge-home-2']]) {
  if (process.env[key] !== path.join(dir, leaf)) throw Error('Invalid scratch home');
}
for (const leaf of ['.bridge-home','.bridge-home-2','.mcp-bridge-home','.mcp-bridge-home-2','.browser-home']) {
  const p = path.join(dir, leaf);
  if (fs.existsSync(p) && (!fs.lstatSync(p).isDirectory() || fs.lstatSync(p).isSymbolicLink())) throw Error('Unsafe scratch home');
}
for (const name of ['ui','bridge','bridge-2','mcp-bridge','mcp-bridge-2','mcp','mcp-tls']) {
  if (fs.existsSync(path.join(dir, `.${name}.pid`))) throw Error('Existing PID record');
}
Promise.all([5432,8000,3000,8080,8443,8444].map(port => new Promise((ok, fail) => {
  const server = net.createServer();
  server.once('error', error => { console.error(`CI port ${port} bind failed: ${error.code || 'unknown'}`); fail(error); });
  server.listen(port, '127.0.0.1', () => server.close(error => error ? fail(error) : ok()));
}))).catch(() => { process.exitCode = 1; });
JS
    sudo "$(command -v node)" <<'JS'
const net = require('node:net');
const server = net.createServer();
server.once('error', error => { console.error(`CI port 443 bind failed: ${error.code || 'unknown'}`); process.exitCode = 1; });
server.listen(443, '127.0.0.1', () => server.close(error => { if (error) { console.error(`CI port 443 close failed: ${error.code || 'unknown'}`); process.exitCode = 1; } }));
JS
    infra_started=0; trust_started=0; services_started=0
    cleanup() {
      status=$?; trap - EXIT
      if (( status != 0 && infra_started )); then
        { docker compose -f "$E2E_DIR/docker-compose.yml" ps -a || true; docker inspect --format '{{json .State.Health}}' e2e-centrifugo-1 || true; docker compose -f "$E2E_DIR/docker-compose.yml" logs centrifugo neon-http-shim postgres || true; } > "$E2E_DIR/ci-infra.log" 2>&1
      fi
      if (( services_started )); then bash "$E2E_DIR/scripts/stop-services.sh" || { ((status != 0)) || status=1; }
      elif (( trust_started )); then node "$E2E_DIR/scripts/setup-browser-trust.mjs" --cleanup || { ((status != 0)) || status=1; }; fi
      if (( infra_started )); then (cd "$E2E_DIR" && docker compose down -v) || { ((status != 0)) || status=1; }; fi
      exit "$status"
    }
    trap cleanup EXIT
    sudo apt-get update
    sudo apt-get install -y zsh tmux libnss3-tools
    zsh -c 'autoload -Uz compaudit; compaudit' 2>/dev/null | xargs -r sudo chmod -R g-w,o-w || true
    zsh -c 'autoload -Uz compaudit; compaudit' || true
    bash "$E2E_DIR/scripts/gen-certs.sh"
    node --test "$E2E_DIR/scripts/setup-browser-trust.test.mjs"
    trust_started=1; node "$E2E_DIR/scripts/setup-browser-trust.mjs"
    infra_started=1; (cd "$E2E_DIR" && docker compose up -d --build --wait && docker compose ps)
    (cd "$E2E_DIR" && npm ci && node scripts/setup-db.mjs)
    (cd ui && npm ci && npm test && node --test ../e2e/scripts/ci-fixtures.test.mjs && npm run build)
    (cd bridge && npm ci && npm run build && npm test && node --test ../scripts/release/*.test.mjs)
    MIGRATION_DATABASE_URL="$DATABASE_URL" timeout 120s node e2e/scripts/rate-limit-db.ts
    E2E_USER_EMAIL="e2e-db-pending+${GITHUB_RUN_ID:-0}-${GITHUB_RUN_ATTEMPT:-0}@ftown.test" node e2e/scripts/pending-approvals-db.ts
    timeout 120s node bridge/scripts/centrifugo-security-smoke.mjs
    (cd "$E2E_DIR" && npx playwright install --with-deps chromium)
    services_started=1; bash "$E2E_DIR/scripts/start-services.sh"
    timeout 120s node e2e/scripts/mcp-body-parser-smoke.ts
    export E2E_USER_EMAIL; E2E_USER_EMAIL=$(cat "$E2E_DIR/.run-email")
    (cd "$E2E_DIR" && npx playwright test)
    ;;
esac
