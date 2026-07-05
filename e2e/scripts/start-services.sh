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

: "${E2E_USER_EMAIL:=e2e+$(date +%s)@ftown.test}"
export E2E_USER_EMAIL
echo "$E2E_USER_EMAIL" > "$E2E_DIR/.run-email"
echo "[start] run user: $E2E_USER_EMAIL"

# --- UI (next start, prod) ---
( cd "$REPO/ui" && exec node_modules/.bin/next start -p 3000 ) > "$E2E_DIR/ui.log" 2>&1 &
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
node -e "fetch('http://localhost:3000/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:process.env.E2E_USER_EMAIL,password:'e2e-password-123'})}).then(async r=>{if(r.status!==201&&r.status!==409){console.error('register failed',r.status,await r.text());process.exit(1)}console.log('[start] register',r.status)})"

# --- bridge (scratch HOME, dist build) ---
BRIDGE_TOKEN="$(node -e "const jwt=require('$E2E_DIR/node_modules/jsonwebtoken');console.log(jwt.sign({sub:process.env.E2E_USER_EMAIL},process.env.CENTRIFUGO_TOKEN_SECRET,{audience:'ftown:centrifugo',expiresIn:'24h'}))")"
( cd "$REPO/bridge" && HOME="$BRIDGE_HOME" exec node dist/index.js --token "$BRIDGE_TOKEN" --api-url http://localhost:3000 ) > "$E2E_DIR/bridge.log" 2>&1 &
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
echo "[start] ready"
