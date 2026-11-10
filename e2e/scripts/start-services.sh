#!/usr/bin/env bash
# Start the UI (production `next start`), the TLS terminator and the two shared
# test bridges, recording their PIDs so teardown kills ONLY those exact
# processes (never pkill/killall). Each bridge runs with HOME, data dir and tmux
# socket directory overridden to scratch paths, with every inherited FTOWN_* and
# TMUX* variable dropped, so it NEVER touches the real ~/.ftown or tmux server.
#
# The bridges start UNPAIRED: each prints a /pair#req=… link and a 6-digit code
# into its log and waits (10 min) for approval. The suite's shared account A is
# created, and both bridges are paired to it, by the Playwright `setup` project
# (tests/account.setup.ts) through the real /login and /pair pages.
#
# Writes PID files: e2e/.ui.pid, .tls.pid, .bridge.pid, .bridge-2.pid
#        tmux dirs: e2e/.bridge.tmux, .bridge-2.tmux ; logs: e2e/ui.log, tls.log, bridge.log, bridge-2.log
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
E2E_DIR="$REPO/e2e"
export E2E_DIR
set -a; source "$E2E_DIR/env.sh"; set +a

BRIDGE_HOME="$E2E_DIR/.bridge-home"
export BRIDGE_HOME
# Validate resource ownership before removing homes, writing records or starting services.
node <<'JS'
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
(async()=>{
  const dir=process.env.E2E_DIR;
  assert.equal(path.resolve(dir),fs.realpathSync(dir));
  const homes=[['BRIDGE_HOME','.bridge-home'],['E2E_SECOND_BRIDGE_HOME','.bridge-home-2']];
  for(const [key,name]of homes){const home=process.env[key];assert.equal(home,path.join(dir,name));if(fs.existsSync(home)){assert.ok(fs.lstatSync(home).isDirectory());assert.ok(!fs.lstatSync(home).isSymbolicLink());}}
  const db=new URL(process.env.DATABASE_URL);assert.ok(['postgres:','postgresql:'].includes(db.protocol));assert.ok(['localhost','127.0.0.1','[::1]'].includes(db.hostname));assert.equal(db.port||'5432','5432');assert.equal(db.pathname,'/ftown');assert.equal(db.username,'ftown');assert.equal(db.search,'');assert.equal(db.hash,'');
  for(const [key,value]of [['PGPORT','5432'],['PGDATABASE','ftown'],['PGUSER','ftown']])if(process.env[key]!==undefined)assert.equal(process.env[key],value);
  if(process.env.PGHOST!==undefined)assert.ok(['localhost','127.0.0.1','::1'].includes(process.env.PGHOST));
  for(const key of ['PGOPTIONS','PGSERVICE','PGSERVICEFILE'])assert.ok(!process.env[key]);
  const ui=Number(process.env.E2E_UI_PORT),tls=Number(process.env.E2E_TLS_PORT);
  assert.ok(Number.isInteger(ui)&&ui>1024&&Number.isInteger(tls)&&tls>1024&&ui!==tls);
  // The one public origin: the TLS terminator (CI) or the UI itself on loopback http.
  assert.ok([`https://localhost:${tls}`,`http://localhost:${ui}`].includes(process.env.FTOWN_PUBLIC_URL));
  assert.equal(process.env.NEXT_PUBLIC_FTOWN_PUBLIC_URL,process.env.FTOWN_PUBLIC_URL);
  // Open registration with creation budgets far above the suite's needs (every test source shares the global key).
  assert.equal(process.env.REGISTRATION_ENABLED,'true');
  assert.ok(process.env.FTOWN_BOOTSTRAP_SECRET===undefined);
  for(const key of ['FTOWN_ACCOUNT_CREATE_PER_IP_HOUR','FTOWN_ACCOUNT_CREATE_GLOBAL_DAY'])assert.ok(/^[0-9]+$/.test(process.env[key]??'')&&Number(process.env[key])>=10000);
  assert.equal(process.env.NEXT_PUBLIC_CENTRIFUGO_URL,'ws://localhost:8000/connection/websocket');
  for(const name of ['ui','bridge','bridge-2','tls'])assert.ok(!fs.existsSync(path.join(dir,`.${name}.pid`)));
  await Promise.all([ui,tls].map(port=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(port,'127.0.0.1',()=>server.close(error=>error?reject(error):resolve()));})));
})().catch(()=>{console.error(`[start] preflight failed: verify exact test homes, DB selectors, public URL, PID ownership and ports ${process.env.E2E_UI_PORT}/${process.env.E2E_TLS_PORT}.`);process.exitCode=1;});
JS
rm -f "$E2E_DIR/.run-email"

# Ephemeral test-only VAPID keys stay in this process environment, never logs/files.
# The browser spec uses a fake PushManager and synthetic worker delivery, never vendors.
read -r VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY < <(cd "$REPO/ui" && node -e 'const k=require("web-push").generateVAPIDKeys();process.stdout.write(k.publicKey+" "+k.privateKey+"\n")')
export VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY
export VAPID_SUBJECT="mailto:e2e@ftown.test"

# TLS endpoint for the UI; all ports/processes belong to this run.
node "$E2E_DIR/scripts/tls-proxy.mjs" > "$E2E_DIR/tls.log" 2>&1 &
echo $! > "$E2E_DIR/.tls.pid"

# --- UI (next start, prod) ---
( cd "$REPO/ui" && exec node "$REPO/ui/node_modules/next/dist/bin/next" start -p "$E2E_UI_PORT" ) > "$E2E_DIR/ui.log" 2>&1 &
echo $! > "$E2E_DIR/.ui.pid"
echo "[start] ui pid $(cat "$E2E_DIR/.ui.pid") on :$E2E_UI_PORT (public origin $FTOWN_PUBLIC_URL)"

echo "[start] waiting for UI ..."
for i in $(seq 1 60); do
  if node -e "fetch(process.env.FTOWN_PUBLIC_URL+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "[start] UI up"; break
  fi
  sleep 1
  [ "$i" = 60 ] && { echo "[start] UI failed to start"; tail -30 "$E2E_DIR/ui.log"; exit 1; }
done

# --- shared bridges: scratch HOME + data dir + private tmux socket dir, inherited FTOWN_*/TMUX* dropped ---
# Replaces the CURRENT shell with <cmd>: call it only in a subshell — `( run_isolated … )` in the
# foreground, or `run_isolated … &` (whose subshell becomes the command itself, so `$!` is its PID).
run_isolated() { # <home> <tmux dir> <cmd...>
  local home="$1" tmuxdir="$2"; shift 2
  for name in $(compgen -e); do
    case "$name" in FTOWN_*|TMUX|TMUX_PANE|TMUX_TMPDIR) unset "$name" ;; esac
  done
  cd "$home"
  export HOME="$home" USERPROFILE="$home" FTOWN_DATA_DIR="$home/.ftown/data" TMUX_TMPDIR="$tmuxdir"
  exec "$@"
}
start_bridge() { # <home> <pid name>
  local home="$1" name="$2" tmuxdir
  case "$home" in "$E2E_DIR"/.bridge-home*) ;; *) echo "[start] bridge home must be inside this task's E2E directory"; exit 1 ;; esac
  rm -rf "$home"; mkdir -p "$home"
  # Sessions spawn `/bin/zsh -l` with HOME=$home. On Ubuntu the global
  # /etc/zsh/zshrc runs compinit unless skip_global_compinit is set, and runner
  # images ship group-writable completion dirs, so compinit would block on an
  # interactive "insecure directories" prompt and the terminal never reaches a
  # prompt. ~/.zshenv is sourced BEFORE /etc/zsh/zshrc, so the knob wins. The
  # ~/.zshrc suppresses zsh-newuser-install and keeps completion working without
  # the security audit (-u = allow insecure dirs). The bridge appends its PATH
  # export to .zshenv on startup — appending to this file is fine.
  printf 'skip_global_compinit=1\n' > "$home/.zshenv"
  printf 'autoload -Uz compinit\ncompinit -u\n' > "$home/.zshrc"
  # Short on purpose: tmux puts its socket at <dir>/tmux-<uid>/ftown and socket paths are length-limited.
  tmuxdir="$(mktemp -d /tmp/ftpk-XXXXXX)"
  echo "$tmuxdir" > "$E2E_DIR/.$name.tmux"
  ( run_isolated "$home" "$tmuxdir" node "$REPO/bridge/dist/ftown-cli.js" setup > /dev/null )
  run_isolated "$home" "$tmuxdir" node "$REPO/bridge/dist/index.js" --api-url "$FTOWN_PUBLIC_URL" > "$E2E_DIR/$name.log" 2>&1 &
  # $! is the bridge itself (the background subshell exec'ed node): teardown/restart signal exactly this PID.
  echo $! > "$E2E_DIR/.$name.pid"
  echo "[start] $name pid $(cat "$E2E_DIR/.$name.pid") (HOME=$home)"
}
start_bridge "$BRIDGE_HOME" bridge
start_bridge "$E2E_SECOND_BRIDGE_HOME" bridge-2

for name in bridge bridge-2; do
  for i in $(seq 1 40); do
    if grep -q '/pair#req=' "$E2E_DIR/$name.log" 2>/dev/null; then echo "[start] $name printed its pairing link"; break; fi
    if ! kill -0 "$(cat "$E2E_DIR/.$name.pid")" 2>/dev/null; then echo "[start] $name exited"; tail -40 "$E2E_DIR/$name.log"; exit 1; fi
    sleep 1
    [ "$i" = 40 ] && { echo "[start] $name never printed a pairing link"; tail -40 "$E2E_DIR/$name.log"; exit 1; }
  done
done
echo "[start] ready (account creation + bridge pairing run in the Playwright 'setup' project within 10 minutes)"
