#!/usr/bin/env bash
# Disposable Linux capture only. This script owns its marker and Compose project.
set -euo pipefail
umask 077

fail() { printf "[capture] %s\n" "$*" >&2; exit 1; }
[[ "$(uname -s)" == Linux ]] || fail "Linux is required"
[[ "${FTOWN_CAPTURE_ISOLATED:-}" == 1 ]] || fail "set FTOWN_CAPTURE_ISOLATED=1 only in a disposable sandbox"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ "$REPO" == /home/user/ftown && "$(realpath "$REPO")" == "$REPO" ]] || fail "checkout must be canonical /home/user/ftown"
[[ "$(hostname)" == demo-workstation ]] || fail "actual hostname must be demo-workstation"
[[ ! -e /home/user/demo-workspace && ! -L /home/user/demo-workspace ]] || fail "demo workspace already exists"
for tool in node npm npx docker zsh tmux certutil openssl ffmpeg ffprobe ss codex; do
  command -v "$tool" >/dev/null || fail "missing prerequisite: $tool"
done
node -e 'const [a,b,c]=process.versions.node.split(".").map(Number);if(a!==24||b<22||(b===22&&c<1))process.exit(1)' || fail "Node 24.22.1 or newer within major version 24 is required"
[[ "$(codex --version)" == "codex-cli 0.164.0" ]] || fail "Codex CLI 0.164.0 is required"

# Reject inherited selectors even when empty. Only the two capture controls are allowed.
while IFS= read -r name; do
  case "$name" in
    FTOWN_CAPTURE_ISOLATED|FTOWN_CAPTURE_DIR|FTOWN_CAPTURE_OPENAI_KEY_FILE) ;;
    OPENAI*|ANTHROPIC*|OPENROUTER*|AI_GATEWAY*|CODEX*|CLAUDE*|AZURE_OPENAI*|GOOGLE_API_KEY|GEMINI*|DEEPSEEK*|GROQ*|XAI*|MISTRAL*|FIREWORKS*|TOGETHER*|ZAI*|KIMI*|PROVIDER*|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|http_proxy|https_proxy|all_proxy|DATABASE*|DB_*|*_DATABASE_URL|*_DB_URL|DIRECT_URL|SHADOW_*|POSTGRES*|PG*|MIGRAT*|PRISMA*|NEON*|SUPABASE*|DOCKER*|COMPOSE*|E2E_*|FTOWN_*|CENTRIFUGO*|NEXT_PUBLIC_*|NEXTAUTH*|AUTH_*|VERCEL*|DEPLOY*|PUBLIC_URL|API_URL|REGISTRATION_ENABLED|NODE_ENV|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NPM_CONFIG_*|npm_config_*|PLAYWRIGHT_*|PORT|HOST|HOSTNAME_OVERRIDE)
      fail "inherited selector $name is not allowed" ;;
  esac
done < <(compgen -e)

export E2E_DIR="$REPO/e2e"
[[ "$(realpath "$E2E_DIR")" == "$E2E_DIR" ]] || fail "noncanonical E2E directory"
shopt -s nullglob
for dir in "$REPO" "$REPO/ui" "$REPO/bridge" "$E2E_DIR"; do
  for file in "$dir"/.env*; do
    case "$file" in *.example|*.sample|*.template) continue ;; esac
    fail "environment file present: $file"
  done
done
shopt -u nullglob
for name in .capture-run.lock .bridge-home .bridge-home-2 .mcp-bridge-home .mcp-bridge-home-2 .browser-home .run-email .run-mcp-email certs .ui.pid .bridge.pid .bridge-2.pid .mcp-bridge.pid .mcp-bridge-2.pid .mcp.pid .mcp-tls.pid ui.log bridge.log bridge-2.log mcp-bridge.log mcp-bridge-2.log mcp.log mcp-tls.log; do
  [[ ! -e "$E2E_DIR/$name" && ! -L "$E2E_DIR/$name" ]] || fail "pre-existing E2E resource: $name"
done

: "${FTOWN_CAPTURE_DIR:?FTOWN_CAPTURE_DIR must be an absolute canonical staging directory}"
export FTOWN_CAPTURE_DIR
export FTOWN_CAPTURE_OPENAI_KEY_FILE="${FTOWN_CAPTURE_OPENAI_KEY_FILE:-}"
node <<'JS' || fail "provider key file must be canonical, private, owned, nonempty and outside checkout and staging"
const fs=require('node:fs'),path=require('node:path');
const p=process.env.FTOWN_CAPTURE_OPENAI_KEY_FILE,repo=path.dirname(process.env.E2E_DIR),out=process.env.FTOWN_CAPTURE_DIR;
if(!p||!path.isAbsolute(p)||path.resolve(p)!==p||p===repo||p.startsWith(repo+'/')||p===out||p.startsWith(out+'/'))process.exit(1);
const s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||fs.realpathSync(p)!==p||s.uid!==process.getuid()||(s.mode&0o7777)!==0o600||s.size<1||s.size>16384)process.exit(1);
JS
node <<'JS' || fail "staging directory must be canonical, empty or new, outside checkout, with an existing canonical parent"
const fs=require("node:fs"),path=require("node:path");
const p=process.env.FTOWN_CAPTURE_DIR,repo=path.dirname(process.env.E2E_DIR);
if(!path.isAbsolute(p)||path.resolve(p)!==p||p==="/"||p===repo||p.startsWith(repo+"/"))process.exit(1);
let part="/";for(const s of p.split("/").filter(Boolean)){part=path.join(part,s);try{if(fs.lstatSync(part).isSymbolicLink())process.exit(1)}catch(e){if(e.code!=="ENOENT")throw e;}}
const parent=path.dirname(p);if(fs.realpathSync(parent)!==parent)process.exit(1);
try { const st=fs.lstatSync(p);if(!st.isDirectory()||fs.realpathSync(p)!==p||fs.readdirSync(p).length)process.exit(1); } catch(e) { if(e.code!=="ENOENT")throw e; }
JS
[[ "$(docker context show)" == default ]] || fail "Docker context must be default"
[[ "$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" == unix:///var/run/docker.sock ]] || fail "Docker default context must use the local socket"
docker info >/dev/null || fail "local Docker daemon unavailable"
containers="$(docker ps -aq)" || fail "could not inspect Docker containers"
[[ -z "$containers" ]] || fail "pre-existing Docker containers are not allowed"
PROJECT="ftown-capture-$$"
for kind in container network volume; do
  case "$kind" in
    container) existing="$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")" ;;
    network) existing="$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")" ;;
    volume) existing="$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ;;
  esac
  [[ -z "$existing" ]] || fail "Compose project already owns a $kind"
done
node <<'JS' || fail "one or more required ports are unavailable"
const net=require("node:net");
const {execFileSync}=require("node:child_process");
(async()=>{
  // Unprivileged Linux users cannot bind :443. Inspect all TCP listeners
  // instead, including wildcard and IPv6 addresses; reject malformed output.
  const rows=execFileSync("ss",["-H","-ltn"],{encoding:"utf8",timeout:10000});
  for(const row of rows.split("\n").filter(line=>line.trim())){
    const fields=row.trim().split(/\s+/);
    const match=fields[3]?.match(/:(\d+)$/);
    if(fields.length<5||fields[0]!=="LISTEN"||!match)throw Error("invalid ss output");
    if(Number(match[1])===443)throw Error("port 443 is in use");
  }
  for(const port of [5432,8000,3000,8080,8443,8444])for(const host of ["0.0.0.0","::"]){await new Promise((resolve,reject)=>{const s=net.createServer();s.once("error",reject);s.listen({port,host,ipv6Only:host==="::",exclusive:true},()=>s.close(e=>e?reject(e):resolve()));});}
})().catch(()=>process.exit(1));
JS

# Trap precedes the first owned mutation. Stage markers are written before each
# potentially partial operation, so cleanup also covers failed startup.
LOCK="$E2E_DIR/.capture-run.lock"
owned=0; certs=0; trust=0; compose=0; services=0
cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT INT TERM
  set +e
  if (( owned )); then
    if (( services )); then
      bash "$E2E_DIR/scripts/stop-services.sh" || cleanup_failed=1
    elif (( trust )); then
      node "$E2E_DIR/scripts/setup-browser-trust.mjs" --cleanup || cleanup_failed=1
    fi
    if (( compose )); then
      (cd "$E2E_DIR" && docker --context default compose -p "$PROJECT" down -v) || cleanup_failed=1
    fi
    if (( certs )); then
      if [[ -d "$E2E_DIR/certs" && ! -L "$E2E_DIR/certs" ]]; then rm -rf -- "$E2E_DIR/certs" || cleanup_failed=1
      elif [[ -e "$E2E_DIR/certs" || -L "$E2E_DIR/certs" ]]; then cleanup_failed=1; fi
    fi
    for name in ui.log bridge.log bridge-2.log mcp-bridge.log mcp-bridge-2.log mcp.log mcp-tls.log; do
      if [[ -L "$E2E_DIR/$name" || ( -e "$E2E_DIR/$name" && ! -f "$E2E_DIR/$name" ) ]]; then cleanup_failed=1
      elif [[ -f "$E2E_DIR/$name" ]]; then rm -- "$E2E_DIR/$name" || cleanup_failed=1; fi
    done
    if (( cleanup_failed )); then
      printf "[capture] cleanup failed; preserving marker %s for inspection\n" "$LOCK" >&2
    elif [[ -d "$LOCK" && ! -L "$LOCK" && "$(cat "$LOCK/project")" == "$PROJECT" && "$(cat "$LOCK/pid")" == "$$" ]]; then
      rm -rf -- "$LOCK" || cleanup_failed=1
    else
      printf "[capture] run marker identity changed; preserving it\n" >&2
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed )); then
    printf "[capture] cleanup failed (primary status %s)\n" "$status" >&2
    (( status != 0 )) || status=1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir "$LOCK" || fail "another capture owns the run marker"
owned=1
printf "%s\n" "$PROJECT" > "$LOCK/project"
printf "%s\n" "$$" > "$LOCK/pid"
if [[ ! -d "$FTOWN_CAPTURE_DIR" ]]; then mkdir -- "$FTOWN_CAPTURE_DIR"; fi

set -a
# shellcheck source=e2e/env.sh
source "$E2E_DIR/env.sh"
set +a
export BRIDGE_HOME="$E2E_DIR/.bridge-home"
node <<'JS' || fail "generated local selectors or scratch homes differ from the capture contract"
const assert=require("node:assert/strict"),path=require("node:path"),fs=require("node:fs"),e=process.env,d=e.E2E_DIR;
assert.equal(fs.realpathSync(d),d);assert.equal(e.DATABASE_URL,"postgresql://ftown:ftown@localhost/ftown");
for(const [k,v] of Object.entries({FTOWN_PUBLIC_URL:"https://localhost:8444",FTOWN_MCP_PUBLIC_URL:"https://localhost:8443",NEXT_PUBLIC_CENTRIFUGO_URL:"ws://localhost:8000/connection/websocket",NODE_EXTRA_CA_CERTS:path.join(d,"certs/cert.pem"),BRIDGE_HOME:path.join(d,".bridge-home"),E2E_SECOND_BRIDGE_HOME:path.join(d,".bridge-home-2"),E2E_MCP_BRIDGE_HOME:path.join(d,".mcp-bridge-home"),E2E_MCP_SECOND_BRIDGE_HOME:path.join(d,".mcp-bridge-home-2"),E2E_BROWSER_HOME:path.join(d,".browser-home")}))assert.equal(e[k],v);
for(const k of Object.keys(e))if(k.startsWith("PG")||k.startsWith("POSTGRES")||k.startsWith("MIGRAT"))throw Error("unexpected database selector");
JS

printf "[capture] installing dependencies and Chromium\n"
(cd "$E2E_DIR" && npm ci)
(cd "$REPO/ui" && npm ci)
(cd "$REPO/bridge" && npm ci)
(cd "$E2E_DIR" && npx playwright install chromium)
printf 'certificates\n' > "$LOCK/stage"; certs=1
bash "$E2E_DIR/scripts/gen-certs.sh"
printf 'browser-trust\n' > "$LOCK/stage"; trust=1
node "$E2E_DIR/scripts/setup-browser-trust.mjs"
printf 'compose\n' > "$LOCK/stage"; compose=1
(cd "$E2E_DIR" && docker --context default compose -p "$PROJECT" up -d --build --wait)
printf 'schema\n' > "$LOCK/stage"
(cd "$E2E_DIR" && node scripts/setup-db.mjs)
printf 'build\n' > "$LOCK/stage"
(cd "$REPO/ui" && npm run build)
(cd "$REPO/bridge" && npm run build)
printf 'services\n' > "$LOCK/stage"; services=1
bash "$E2E_DIR/scripts/start-services.sh"
E2E_USER_EMAIL="$(cat "$E2E_DIR/.run-email")"
E2E_MCP_USER_EMAIL="$(cat "$E2E_DIR/.run-mcp-email")"
export E2E_USER_EMAIL E2E_MCP_USER_EMAIL
printf 'capture\n' > "$LOCK/stage"
(cd "$E2E_DIR" && npx playwright test --config capture/playwright.config.ts)
printf "[capture] capture complete; staging retained at %s\n" "$FTOWN_CAPTURE_DIR"
