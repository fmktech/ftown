// Root-only isolated browser verification; no bridge, DB or external calls.
// PATH=/Users/fkesheh/.nvm/versions/node/v24.22.1/bin:$PATH node --experimental-strip-types docs/investigations/session-inbox-smoke.ts
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd();
const esbuild = createRequire(resolve(root, "bridge/package.json"))("esbuild");
const uiRequire = createRequire(resolve(root, "ui/package.json"));
const postcss = uiRequire("postcss"), tailwind = uiRequire("@tailwindcss/postcss");
const { chromium } = createRequire(resolve(root, "e2e/package.json"))("@playwright/test");
const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { SessionInbox } from './src/components/SessionInbox';
window.__calls=0; window.__mode='fail'; window.__opened='';
function App(){const [open,setOpen]=React.useState(false),[version,setVersion]=React.useState(1),[offline,setOffline]=React.useState(false);
 window.__replace=()=>setVersion(2); window.__offline=setOffline;
 const entry={session:{id:'s',bridgeId:'b',name:'Review deployment',status:'running',createdAt:'2026-01-01',updatedAt:'2026-01-01'},bridgeName:'Laptop',notice:{type:'agent_needs_input',title:version===1?'Review requested':'New request',message:version===1?'Full request\\n'+'LongReference'.repeat(45):'Newer message',receivedAt:version},...(offline?{replyDisabledReason:'Reconnect this computer before replying.'}:{})};
 return <div><aside style={{width:260}}><SessionInbox entries={[entry]} collapsed={false} open={open} onOpen={()=>setOpen(true)} onClose={()=>setOpen(false)} onOpenSession={id=>{window.__opened=id;setOpen(false)}} onDismiss={async()=>{throw new Error('Could not dismiss this message. Try again.')}} onReply={async()=>{window.__calls++;if(window.__mode==='fail')throw new Error('Reply may have been queued. Check the session before sending again.')}}/></aside><main>Terminal workspace</main></div>;
} createRoot(document.getElementById('root')).render(<App/>);
`;
const built = await esbuild.build({ stdin: { contents: fixture, sourcefile: 'fixture.tsx', resolveDir: resolve(root, 'ui'), loader: 'tsx' }, jsx: 'automatic', bundle: true, write: false, format: 'iife', platform: 'browser', tsconfig: resolve(root, 'ui/tsconfig.json'), define: { 'process.env.NODE_ENV': '"production"' } });
const css = await postcss([tailwind()]).process(await readFile(resolve(root, 'ui/src/app/globals.css'), 'utf8'), { from: resolve(root, 'ui/src/app/globals.css') });
const html = `<!doctype html><html><head><style>${css.css}\nbody{margin:0;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-mono)}main{padding:20px}</style></head><body><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const server = createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(html);}); await new Promise(done=>server.listen(0,'127.0.0.1',done)); const address=server.address(); let browser;
try { browser=await chromium.launch({headless:true}); await mkdir('/tmp/ftown-session-inbox',{recursive:true});
 for(const [name,viewport] of [['desktop',{width:1280,height:900}],['mobile',{width:320,height:844}]]) {
  const context=await browser.newContext({viewport}); await context.route('**/*',route=>route.request().url().startsWith(`http://127.0.0.1:${address.port}/`)?route.continue():route.abort()); const page=await context.newPage(); page.on('pageerror',error=>console.error(`${name} page error`,error));
  try { await page.goto(`http://127.0.0.1:${address.port}/`); const trigger=page.getByRole('button',{name:'Inbox, 1 message'}); await trigger.focus(); await trigger.click(); const dialog=page.getByRole('dialog',{name:'Inbox'}); await dialog.waitFor();
   if(await dialog.locator('p.whitespace-pre-wrap').textContent()!=='Full request\n'+'LongReference'.repeat(45))throw new Error(`${name}: full notice missing`);
   if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)||await dialog.evaluate(el=>el.scrollWidth>el.clientWidth))throw new Error(`${name}: overflow`);
   for(const button of await dialog.getByRole('button').all()){const box=await button.boundingBox();if(!box||box.height<44)throw new Error(`${name}: button target too small`);}
   await page.screenshot({path:`/tmp/ftown-session-inbox/${name}.png`,fullPage:true});
   const reply=dialog.getByLabel('Reply to Review deployment'); await reply.fill('unsent draft'); await dialog.getByRole('button',{name:'Send reply'}).click(); await dialog.getByRole('alert').waitFor();
   if(await reply.inputValue()!=='unsent draft'||await page.evaluate(()=>window.__calls)!==1)throw new Error(`${name}: failed draft/retry behavior`);
   await page.evaluate(()=>window.__replace()); await dialog.getByText('Newer message').waitFor();
   if(await reply.inputValue()!==''||await dialog.getByRole('alert').count())throw new Error(`${name}: old state leaked to new notice`);
   await page.evaluate(()=>window.__offline(true)); await page.getByText('Reconnect this computer before replying.').waitFor(); if(!await dialog.getByRole('button',{name:'Send reply'}).isDisabled())throw new Error(`${name}: offline reply enabled`);
   await dialog.getByRole('button',{name:'Dismiss'}).click(); await dialog.getByRole('alert').waitFor(); if(!(await dialog.getByRole('alert').textContent()).includes('Could not dismiss'))throw new Error(`${name}: dismissal failure missing`);
   await page.keyboard.press('Escape'); await dialog.waitFor({state:'hidden'}); if(!await trigger.evaluate(el=>el===document.activeElement))throw new Error(`${name}: focus not restored`);
   await trigger.click(); await dialog.getByRole('button',{name:'Open session'}).click(); if(await page.evaluate(()=>window.__opened)!=='s')throw new Error(`${name}: open session failed`);
   console.log(`${name}: full text, layout, reply failure, replacement, offline, dismissal and focus checks passed`);
  } catch(error){await page.screenshot({path:`/tmp/ftown-session-inbox/${name}-failure.png`,fullPage:true}).catch(()=>{});throw error;} finally {await context.close();}
 }
} finally {try{if(browser)await browser.close();}finally{await new Promise(done=>server.close(done));}}
