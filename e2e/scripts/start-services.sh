#!/usr/bin/env bash
# Start the UI (production `next start`) and a test bridge, recording their PIDs so
# teardown kills ONLY those exact processes (never pkill/killall). The bridge runs
# with HOME overridden to a scratch dir so it NEVER touches the real ~/.ftown.
#
# Exports/records: E2E_USER_EMAIL (run-scoped; bridge sub == dashboard user).
# Writes PID files: e2e/.ui.pid, e2e/.bridge.pid ; logs: e2e/ui.log, e2e/bridge.log
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$REPO/e2e"
export E2E_DIR
set -a; source "$E2E_DIR/env.sh"; set +a

BRIDGE_HOME="$E2E_DIR/.bridge-home"
export BRIDGE_HOME
: "${E2E_USER_EMAIL:=e2e+$(date +%s)@ftown.test}"
export E2E_USER_EMAIL
# Validate resource ownership before removing homes, writing records or starting services.
node <<'JS'
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
(async()=>{
  const dir=process.env.E2E_DIR;
  assert.equal(path.resolve(dir),fs.realpathSync(dir));
  const homes=[['BRIDGE_HOME','.bridge-home'],['E2E_SECOND_BRIDGE_HOME','.bridge-home-2'],['E2E_MCP_BRIDGE_HOME','.mcp-bridge-home'],['E2E_MCP_SECOND_BRIDGE_HOME','.mcp-bridge-home-2']];
  for(const [key,name]of homes){const home=process.env[key];assert.equal(home,path.join(dir,name));if(fs.existsSync(home)){assert.ok(fs.lstatSync(home).isDirectory());assert.ok(!fs.lstatSync(home).isSymbolicLink());}}
  assert.match(process.env.E2E_USER_EMAIL,/^e2e[^@]*@ftown\.test$/);
  assert.match(process.env.E2E_MCP_USER_EMAIL,/^e2e-mcp[^@]*@ftown\.test$/);
  assert.notEqual(process.env.E2E_USER_EMAIL,process.env.E2E_MCP_USER_EMAIL);
  assert.ok(process.env.E2E_MCP_USER_PASSWORD.length>=12);
  const db=new URL(process.env.DATABASE_URL);assert.ok(['postgres:','postgresql:'].includes(db.protocol));assert.ok(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.equal(db.port||'5432','5432');assert.equal(db.pathname,'/ftown');assert.equal(db.username,'ftown');assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const [key,value]of [['PGPORT','5432'],['PGDATABASE','ftown'],['PGUSER','ftown']])if(process.env[key]!==undefined)assert.equal(process.env[key],value);
  if(process.env.PGHOST!==undefined)assert.ok(['localhost','127.0.0.1','::1'].includes(process.env.PGHOST));
  for(const key of ['PGOPTIONS','PGSERVICE','PGSERVICEFILE'])assert.ok(!process.env[key]);
  assert.equal(process.env.FTOWN_PUBLIC_URL,'https://localhost:8444');assert.equal(process.env.FTOWN_MCP_PUBLIC_URL,'https://localhost:8443');assert.equal(process.env.NEXT_PUBLIC_CENTRIFUGO_URL,'ws://localhost:8000/connection/websocket');
  for(const name of ['ui','bridge','bridge-2','mcp-bridge','mcp-bridge-2','mcp','mcp-tls'])assert.ok(!fs.existsSync(path.join(dir,`.${name}.pid`)));
  await Promise.all([3000,8080,8443,8444].map(port=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(error=>error?reject(error):resolve()));})));
})().catch(()=>{console.error('[start] preflight failed: verify exact test homes, account/DB selectors, PID ownership and ports3000/8080/8443/8444.');process.exitCode=1;});
JS
rm -rf "$BRIDGE_HOME"; mkdir -p "$BRIDGE_HOME"

# Sessions spawn `/bin/zsh -l` with HOME=$BRIDGE_HOME. On Ubuntu the global
# /etc/zsh/zshrc runs compinit unless skip_global_compinit is set, and runner
# images ship group-writable completion dirs, so compinit would block on an
# interactive "insecure directories" prompt and the terminal never reaches a
# prompt. ~/.zshenv is sourced BEFORE /etc/zsh/zshrc, so the knob wins. The
# ~/.zshrc suppresses zsh-newuser-install and keeps completion working without
# the security audit (-u = allow insecure dirs). The bridge appends its PATH
# export to .zshenv on startup — appending to this file is fine.
printf 'skip_global_compinit=1\n' > "$BRIDGE_HOME/.zshenv"
printf 'autoload -Uz compinit\ncompinit -u\n' > "$BRIDGE_HOME/.zshrc"

echo "$E2E_USER_EMAIL" > "$E2E_DIR/.run-email"
echo "$E2E_MCP_USER_EMAIL" > "$E2E_DIR/.run-mcp-email"
echo "[start] run user: $E2E_USER_EMAIL"

# Ephemeral test-only VAPID keys stay in this process environment, never logs/files.
# The browser spec uses a fake PushManager and synthetic worker delivery, never vendors.
read -r VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY < <(cd "$REPO/ui" && node -e 'const k=require("web-push").generateVAPIDKeys();process.stdout.write(k.publicKey+" "+k.privateKey+"\n")')
export VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
export VAPID_SUBJECT="mailto:e2e@ftown.test"

# TLS endpoints for MCP and its consent UI; all ports/processes belong to this run.
node "$E2E_DIR/scripts/mcp-tls-proxy.mjs" > "$E2E_DIR/mcp-tls.log" 2>&1 &
echo $! > "$E2E_DIR/.mcp-tls.pid"

# --- UI (next start, prod) ---
( cd "$REPO/ui" && exec node "$REPO/ui/node_modules/next/dist/bin/next" start -p 3000 ) > "$E2E_DIR/ui.log" 2>&1 &
echo $! > "$E2E_DIR/.ui.pid"
echo "[start] ui pid $(cat "$E2E_DIR/.ui.pid")"

echo "[start] waiting for UI on :3000 ..."
for i in $(seq 1 60); do
  if node -e "fetch('http://localhost:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "[start] UI up"; break
  fi
  sleep 1
  [ "$i" = 60 ] && { echo "[start] UI failed to start"; tail -30 "$E2E_DIR/ui.log"; exit 1; }
done

# --- register the run user ---
node -e "fetch('http://localhost:3000/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({email:process.env.E2E_USER_EMAIL,password:'e2e-password-123'})}).then(r=>{if(!r.ok){console.error('[start] register failed',r.status);process.exit(1)}console.log('[start] register',r.status)}).catch(()=>{console.error('[start] registration unavailable');process.exit(1)})"
node -e "fetch('http://localhost:3000/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(10000),body:JSON.stringify({email:process.env.E2E_MCP_USER_EMAIL,password:process.env.E2E_MCP_USER_PASSWORD})}).then(r=>{if(!r.ok){console.error('[start] MCP fixture registration failed',r.status);process.exit(1)}console.log('[start] MCP fixture account registered')}).catch(()=>{console.error('[start] MCP fixture registration unavailable');process.exit(1)})"

# --- explicit setup and bridge (scratch HOME, dist build) ---
( cd "$BRIDGE_HOME" && HOME="$BRIDGE_HOME" USERPROFILE="$BRIDGE_HOME" FTOWN_DATA_DIR="$BRIDGE_HOME/.ftown/data" node "$REPO/bridge/dist/ftown-cli.js" setup )
BRIDGE_TOKEN="$(node -e "const jwt=require('$E2E_DIR/node_modules/jsonwebtoken');console.log(jwt.sign({sub:process.env.E2E_USER_EMAIL},process.env.CENTRIFUGO_TOKEN_SECRET,{audience:'ftown:bridge-bootstrap',expiresIn:'10m'}))")"
( cd "$BRIDGE_HOME" && HOME="$BRIDGE_HOME" USERPROFILE="$BRIDGE_HOME" FTOWN_DATA_DIR="$BRIDGE_HOME/.ftown/data" exec node "$REPO/bridge/dist/index.js" --token "$BRIDGE_TOKEN" --api-url http://localhost:3000 ) > "$E2E_DIR/bridge.log" 2>&1 &
echo $! > "$E2E_DIR/.bridge.pid"
echo "[start] bridge pid $(cat "$E2E_DIR/.bridge.pid") (HOME=$BRIDGE_HOME)"

# --- wait for bridge presence on bridges:presence#<email> ---
echo "[start] waiting for bridge presence ..."
for i in $(seq 1 40); do
  N=$(node -e "fetch('http://localhost:8000/api',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':process.env.CENTRIFUGO_API_KEY},body:JSON.stringify({method:'presence',params:{channel:'bridges:presence#'+process.env.E2E_USER_EMAIL}})}).then(r=>r.json()).then(j=>process.stdout.write(String(Object.keys(((j.result||{}).presence)||{}).length))).catch(()=>process.stdout.write('0'))" 2>/dev/null || echo 0)
  if [ "${N:-0}" -ge 1 ]; then echo "[start] bridge online (presence=$N)"; break; fi
  sleep 1
  [ "$i" = 40 ] && { echo "[start] bridge presence not detected"; tail -40 "$E2E_DIR/bridge.log"; exit 1; }
done
export BRIDGE_HOME
# A second independent instance exercises exact target/pin routing on one account.
case "$E2E_SECOND_BRIDGE_HOME" in "$E2E_DIR"/*) ;; *) echo "[start] second bridge home must be inside this task's E2E directory"; exit 1 ;; esac
rm -rf "$E2E_SECOND_BRIDGE_HOME"; mkdir -p "$E2E_SECOND_BRIDGE_HOME"
printf 'skip_global_compinit=1\n' > "$E2E_SECOND_BRIDGE_HOME/.zshenv"
printf 'autoload -Uz compinit\ncompinit -u\n' > "$E2E_SECOND_BRIDGE_HOME/.zshrc"
( cd "$E2E_SECOND_BRIDGE_HOME" && HOME="$E2E_SECOND_BRIDGE_HOME" USERPROFILE="$E2E_SECOND_BRIDGE_HOME" FTOWN_DATA_DIR="$E2E_SECOND_BRIDGE_HOME/.ftown/data" node "$REPO/bridge/dist/ftown-cli.js" setup )
( cd "$E2E_SECOND_BRIDGE_HOME" && HOME="$E2E_SECOND_BRIDGE_HOME" USERPROFILE="$E2E_SECOND_BRIDGE_HOME" FTOWN_DATA_DIR="$E2E_SECOND_BRIDGE_HOME/.ftown/data" exec node "$REPO/bridge/dist/index.js" --token "$BRIDGE_TOKEN" --api-url http://localhost:3000 ) > "$E2E_DIR/bridge-2.log" 2>&1 &
echo $! > "$E2E_DIR/.bridge-2.pid"
for i in $(seq 1 40); do
  N=$(node -e "fetch('http://localhost:8000/api',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':process.env.CENTRIFUGO_API_KEY},body:JSON.stringify({method:'presence',params:{channel:'bridges:presence#'+process.env.E2E_USER_EMAIL}})}).then(r=>r.json()).then(j=>process.stdout.write(String(Object.keys(((j.result||{}).presence)||{}).length))).catch(()=>process.stdout.write('0'))" 2>/dev/null || echo 0)
  if [ "${N:-0}" -ge 2 ]; then echo "[start] both bridges online"; break; fi
  sleep 1
  [ "$i" = 40 ] && { echo "[start] second bridge presence not detected"; exit 1; }
done
# MCP migration uses its own account and two legacy bridges; other specs keep
# their original account and local grants intact.
MCP_BRIDGE_TOKEN="$(node -e "const jwt=require('$E2E_DIR/node_modules/jsonwebtoken');process.stdout.write(jwt.sign({sub:process.env.E2E_MCP_USER_EMAIL},process.env.CENTRIFUGO_TOKEN_SECRET,{audience:'ftown:bridge-bootstrap',expiresIn:'10m'}))")"
for name in mcp-bridge mcp-bridge-2; do
  if [ "$name" = mcp-bridge ]; then fixture_home="$E2E_MCP_BRIDGE_HOME"; else fixture_home="$E2E_MCP_SECOND_BRIDGE_HOME"; fi
  rm -rf "$fixture_home"; mkdir -p "$fixture_home"
  printf 'skip_global_compinit=1\n' > "$fixture_home/.zshenv"
  printf 'autoload -Uz compinit\ncompinit -u\n' > "$fixture_home/.zshrc"
  ( cd "$fixture_home" && HOME="$fixture_home" USERPROFILE="$fixture_home" FTOWN_DATA_DIR="$fixture_home/.ftown/data" node "$REPO/bridge/dist/ftown-cli.js" setup )
  ( cd "$fixture_home" && HOME="$fixture_home" USERPROFILE="$fixture_home" FTOWN_DATA_DIR="$fixture_home/.ftown/data" exec node "$REPO/bridge/dist/index.js" --token "$MCP_BRIDGE_TOKEN" --api-url http://localhost:3000 ) > "$E2E_DIR/$name.log" 2>&1 &
  echo $! > "$E2E_DIR/.$name.pid"
done
unset MCP_BRIDGE_TOKEN BRIDGE_TOKEN
for i in $(seq 1 40); do
  N=$(node -e "fetch('http://localhost:8000/api',{method:'POST',headers:{'Content-Type':'application/json','X-API-Key':process.env.CENTRIFUGO_API_KEY},body:JSON.stringify({method:'presence',params:{channel:'bridges:presence#'+process.env.E2E_MCP_USER_EMAIL}})}).then(r=>r.json()).then(j=>process.stdout.write(String(Object.keys(((j.result||{}).presence)||{}).length))).catch(()=>process.stdout.write('0'))" 2>/dev/null || echo 0)
  if [ "${N:-0}" -ge 2 ]; then echo "[start] dedicated MCP bridges online"; break; fi
  sleep 1
  [ "$i" = 40 ] && { echo "[start] dedicated MCP bridge presence not detected"; exit 1; }
done
FTOWN_MCP_CONFIG_JSON="$(node "$E2E_DIR/scripts/mcp-test-config.mjs")"
export FTOWN_MCP_CONFIG_JSON
export CENTRIFUGO_URL="wss://localhost:8443/connection/websocket"
( cd "$REPO/bridge" && HOST=127.0.0.1 PORT=8080 exec node "$REPO/bridge/dist/mcp-cli.js" ) > "$E2E_DIR/mcp.log" 2>&1 &
echo $! > "$E2E_DIR/.mcp.pid"
for i in $(seq 1 40); do
  if node -e "fetch('https://localhost:8443/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then echo "[start] MCP TLS gateway ready"; break; fi
  sleep 1
  [ "$i" = 40 ] && { echo "[start] MCP failed to start"; exit 1; }
done
echo "[start] ready"
