#!/usr/bin/env bash
# Kill ONLY the exact PIDs recorded by start-services.sh (and by test-owned
# isolated bridges under e2e/.isolated-bridges/). Never pkill/killall.
set -uo pipefail
E2E_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$E2E_DIR/.." && pwd)"
export E2E_DIR
cleanup_status=0
# Remove sessions through each owned bridge's encrypted OS-local client before
# shutdown: tmux-backed sessions intentionally survive an ordinary bridge exit.
node --input-type=module <<'JS' || cleanup_status=1
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir=process.env.E2E_DIR,repo=resolve(dir,'..');
const {apiResponse}=await import(pathToFileURL(join(repo,'bridge/dist/cli-client.js')).href);
let failed=false;
for(const [name,homeName]of [['bridge','.bridge-home'],['bridge-2','.bridge-home-2']]){
  const pidFile=join(dir,`.${name}.pid`),home=join(dir,homeName),pointerFile=join(home,'.ftown/bridge.json');
  if(!existsSync(pidFile)||!existsSync(pointerFile))continue;
  try{
    const pid=Number(readFileSync(pidFile,'utf8').trim());if(!Number.isSafeInteger(pid)||pid<1)throw Error('invalid pid');
    try{process.kill(pid,0);}catch{continue;}
    if(process.platform==='linux'&&!readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').includes(join(repo,'bridge/dist/index.js')))throw Error('pid mismatch');
    if(realpathSync(home)!==home||lstatSync(home).isSymbolicLink()||lstatSync(join(home,'.ftown')).isSymbolicLink()||lstatSync(pointerFile).isSymbolicLink())throw Error('home mismatch');
    const pointer=JSON.parse(readFileSync(pointerFile,'utf8'));
    if(pointer.dataDir&&resolve(pointer.dataDir)!==join(home,'.ftown/data'))throw Error('data directory mismatch');
    const listing=await apiResponse(pointer,'GET','/api/sessions',undefined,undefined,AbortSignal.timeout(5000));
    const sessions=listing.body?.sessions;
    if(listing.status!==200||!Array.isArray(sessions)||sessions.length>128)throw Error('invalid session list');
    for(let offset=0;offset<sessions.length;offset+=4)await Promise.all(sessions.slice(offset,offset+4).map(async session=>{
      if(typeof session.id!=='string'||! /^[A-Za-z0-9_-]{1,200}$/.test(session.id))throw Error('invalid session id');
      const response=await apiResponse(pointer,'DELETE',`/api/sessions/${session.id}`,undefined,undefined,AbortSignal.timeout(5000));
      if(![200,204,404].includes(response.status))throw Error('session removal failed');
    }));
    console.log(`[stop] ${name} sessions removed (${sessions.length})`);
  }catch{failed=true;console.error(`[stop] ${name} session cleanup failed; details suppressed.`);}
}
if(failed)process.exitCode=1;
JS

# Exact-PID identity check: the recorded PID must still run the expected entry point.
owned() { # <pid> <name>
  node - "$1" "$2" "$REPO" <<'JS'
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const [pid,name,repo]=process.argv.slice(2);
try{
 const command=process.platform==='linux'?fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0').join(' '):cp.execFileSync('ps',['-p',pid,'-o','command='],{encoding:'utf8'}).trim();
 const args=command.split(' ');
 const expected=name==='ui'?path.join(repo,'ui/node_modules/next/dist/bin/next'):name==='tls'?path.join(repo,'e2e/scripts/tls-proxy.mjs'):path.join(repo,'bridge/dist/index.js');
 // `next start` retitles its process to "next-server (vX)"; accept it only when its cwd is this checkout's ui/.
 const cwd=process.platform==='linux'?fs.realpathSync(`/proc/${pid}/cwd`):(()=>{try{return cp.execFileSync('lsof',['-a','-p',pid,'-d','cwd','-Fn'],{encoding:'utf8'}).split('\n').find(l=>l.startsWith('n'))?.slice(1);}catch{return undefined;}})();
 const titledUi=name==='ui'&&command.includes('next-server')&&cwd!==undefined&&fs.realpathSync(cwd)===fs.realpathSync(path.join(repo,'ui'));
 if(!args.includes(expected)&&!titledUi)throw Error('unowned process');
 if(process.platform==='linux'&&name.includes('bridge')&&!name.startsWith('isolated')){
  const homes={bridge:'.bridge-home','bridge-2':'.bridge-home-2'};
  const vars=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0');if(!vars.includes(`HOME=${path.join(repo,'e2e',homes[name])}`))throw Error('unowned home');
 }
}catch{process.exitCode=1;}
JS
}
stop_pid_file() { # <pid file> <name>
  local f="$1" name="$2" pid
  [ -f "$f" ] || return 0
  pid="$(cat "$f")"
  if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then echo "[stop] invalid $name PID record; preserving it"; cleanup_status=1; return 0; fi
  if kill -0 "$pid" 2>/dev/null; then
    if ! owned "$pid" "$name"; then echo "[stop] $name PID identity mismatch; preserving process and record"; cleanup_status=1; return 0; fi
    echo "[stop] killing $name pid $pid"
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}
# A bridge's private tmux server, addressed by its EXPLICIT socket path (never the default socket).
stop_tmux_dir() { # <file holding the tmux dir>
  local f="$1" dir sock
  [ -f "$f" ] || return 0
  dir="$(cat "$f")"
  case "$dir" in /tmp/ftpk-??????|/private/tmp/ftpk-??????) ;; *) echo "[stop] unexpected tmux dir record $f; preserving it"; cleanup_status=1; return 0 ;; esac
  sock="$dir/tmux-$(id -u)/ftown"
  if [ -S "$sock" ]; then tmux -S "$sock" kill-server 2>/dev/null || true; fi
  rm -rf "$dir"; rm -f "$f"
}

for name in tls bridge-2 bridge ui; do stop_pid_file "$E2E_DIR/.$name.pid" "$name"; done
for name in bridge-2 bridge; do stop_tmux_dir "$E2E_DIR/.$name.tmux"; done
# Test-owned isolated bridges left behind by an interrupted spec (normally each spec stops its own).
if [ -d "$E2E_DIR/.isolated-bridges" ]; then
  for home in "$E2E_DIR"/.isolated-bridges/*/; do
    [ -d "$home" ] || continue
    stop_pid_file "${home}pid" isolated-bridge
    stop_tmux_dir "${home}tmux"
  done
fi

# The caller must stop/await Playwright before this teardown. Trust cleanup is
# independently guarded and never touches the runner's real HOME/NSS database.
if [ "$(uname -s)" = "Linux" ]; then node "$E2E_DIR/scripts/setup-browser-trust.mjs" --cleanup || cleanup_status=1; fi
# Scratch paths are literal children of this checkout, never caller-provided HOME.
if [ "$cleanup_status" -eq 0 ]; then
node <<'JS' || cleanup_status=1
const fs=require('node:fs'),path=require('node:path');const dir=process.env.E2E_DIR;
if(path.resolve(dir)!==fs.realpathSync(dir))throw Error('Noncanonical test directory');
for(const [name,pid]of [['.bridge-home','bridge'],['.bridge-home-2','bridge-2']]){
 const home=path.join(dir,name);if(fs.existsSync(path.join(dir,`.${pid}.pid`)))throw Error('Bridge PID record remains');
 if(fs.existsSync(home)){if(fs.lstatSync(home).isSymbolicLink()||!fs.lstatSync(home).isDirectory())throw Error('Unsafe test home');fs.rmSync(home,{recursive:true,force:true});}
}
const isolated=path.join(dir,'.isolated-bridges');
if(fs.existsSync(isolated)){if(fs.lstatSync(isolated).isSymbolicLink())throw Error('Unsafe isolated bridge dir');fs.rmSync(isolated,{recursive:true,force:true});}
// The account lives in the throwaway database; its passkey record goes with this run.
for(const file of ['.run-email','.run-account.json'])fs.rmSync(path.join(dir,file),{force:true});
JS
else echo "[stop] preserving scratch homes for root verification after cleanup failure"; fi
echo "[stop] done (docker infra left running; use 'docker compose down -v' in e2e/ to remove)"
exit "$cleanup_status"
