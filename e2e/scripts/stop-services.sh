#!/usr/bin/env bash
# Kill ONLY the exact PIDs recorded by start-services.sh. Never pkill/killall.
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
for(const [name,homeName]of [['bridge','.bridge-home'],['bridge-2','.bridge-home-2'],['mcp-bridge','.mcp-bridge-home'],['mcp-bridge-2','.mcp-bridge-home-2']]){
  const pidFile=join(dir,`.${name}.pid`),home=join(dir,homeName),pointerFile=join(home,'.ftown/bridge.json');
  if(!existsSync(pidFile)||!existsSync(pointerFile))continue;
  try{
    const pid=Number(readFileSync(pidFile,'utf8').trim());if(!Number.isSafeInteger(pid)||pid<1)throw Error('invalid pid');
    try{process.kill(pid,0);}catch{const sessions=join(home,'.ftown/data/sessions');if(existsSync(sessions)&&readdirSync(sessions).length)throw Error('session state requires verification');continue;}
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
for name in mcp mcp-tls mcp-bridge-2 mcp-bridge bridge-2 bridge ui; do
  f="$E2E_DIR/.$name.pid"
  if [ -f "$f" ]; then
    pid="$(cat "$f")"
    if ! [[ "$pid" =~ ^[1-9][0-9]*$ ]]; then echo "[stop] invalid $name PID record; preserving it"; cleanup_status=1; continue; fi
    if kill -0 "$pid" 2>/dev/null; then
      if ! node - "$pid" "$name" "$REPO" <<'JS'
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');const [pid,name,repo]=process.argv.slice(2);
try{
 const args=process.platform==='linux'?fs.readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0'):cp.execFileSync('ps',['-p',pid,'-o','command='],{encoding:'utf8'}).trim().split(' ');
 const expected=name==='ui'?path.join(repo,'ui/node_modules/next/dist/bin/next'):name==='mcp'?path.join(repo,'bridge/dist/mcp-cli.js'):name==='mcp-tls'?path.join(repo,'e2e/scripts/mcp-tls-proxy.mjs'):path.join(repo,'bridge/dist/index.js');
 const titledUi=process.platform==='linux'&&name==='ui'&&args.join(' ').includes('next-server')&&fs.realpathSync(`/proc/${pid}/cwd`)===path.join(repo,'ui');
 if(!args.includes(expected)&&!titledUi)throw Error('unowned process');
 if(process.platform==='linux'&&name.includes('bridge')){
  const homes={bridge:'.bridge-home','bridge-2':'.bridge-home-2','mcp-bridge':'.mcp-bridge-home','mcp-bridge-2':'.mcp-bridge-home-2'};
  const vars=fs.readFileSync(`/proc/${pid}/environ`,'utf8').split('\0');if(!vars.includes(`HOME=${path.join(repo,'e2e',homes[name])}`))throw Error('unowned home');
 }
}catch{process.exitCode=1;}
JS
      then echo "[stop] $name PID identity mismatch; preserving process and record"; cleanup_status=1; continue; fi
      echo "[stop] killing $name pid $pid"
      kill "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$f"
  fi
done
# The caller must stop/await Playwright before this teardown. Trust cleanup is
# independently guarded and never touches the runner's real HOME/NSS database.
node "$E2E_DIR/scripts/setup-browser-trust.mjs" --cleanup || cleanup_status=1
# Scratch paths are literal children of this checkout, never caller-provided HOME.
if [ "$cleanup_status" -eq 0 ]; then
node <<'JS' || cleanup_status=1
const fs=require('node:fs'),path=require('node:path');const dir=process.env.E2E_DIR;
if(path.resolve(dir)!==fs.realpathSync(dir))throw Error('Noncanonical test directory');
for(const [name,pid]of [['.bridge-home','bridge'],['.bridge-home-2','bridge-2'],['.mcp-bridge-home','mcp-bridge'],['.mcp-bridge-home-2','mcp-bridge-2']]){
 const home=path.join(dir,name);if(fs.existsSync(path.join(dir,`.${pid}.pid`)))throw Error('Bridge PID record remains');
 if(fs.existsSync(home)){if(fs.lstatSync(home).isSymbolicLink()||!fs.lstatSync(home).isDirectory())throw Error('Unsafe test home');fs.rmSync(home,{recursive:true,force:true});}
}
for(const file of ['.run-email','.run-mcp-email'])fs.rmSync(path.join(dir,file),{force:true});
JS
else echo "[stop] preserving scratch homes for root verification after cleanup failure"; fi
echo "[stop] done (docker infra left running; use 'docker compose down -v' in e2e/ to remove)"
exit "$cleanup_status"
