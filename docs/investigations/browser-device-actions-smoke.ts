// Root-only mocked browser check. From the task checkout with Node 24.22.1:
// PATH=/Users/fkesheh/.nvm/versions/node/v24.22.1/bin:$PATH node --experimental-strip-types docs/investigations/browser-device-actions-smoke.ts
// Uses real access map/editor, mocked selected details and name/revoke actions.
// Ephemeral loopback only; no account, bridge, database or external network.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd();
const ciMode = process.argv.includes('--ci-height') ? 'height' : process.argv.includes('--ci-name') ? 'name' : null;
const esbuild = createRequire(resolve(root, "bridge/package.json"))("esbuild");
const uiRequire = createRequire(resolve(root, "ui/package.json"));
const postcss = uiRequire("postcss"), tailwind = uiRequire("@tailwindcss/postcss");
const { chromium } = createRequire(resolve(root, "e2e/package.json"))("@playwright/test");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SecurityAccessMap, accessBrowserLabel } from './src/components/SecurityAccessMap';
import { DeviceDisplayNameEditor } from './src/components/DeviceDisplayNameEditor';
window.__revokes=0; window.__fail=false;
function App(){
 const [names,setNames]=React.useState({}); const [selected,setSelected]=React.useState({kind:'browser',id:'a'}); const [confirm,setConfirm]=React.useState(false);
 const [offline,setOffline]=React.useState(false), [last,setLast]=React.useState(false), [error,setError]=React.useState(null);
 window.__setOffline=setOffline; window.__setLast=setLast;
 const base=[['a','Laptop'],['b','Phone'],['c','Tablet']];
 const browsers=base.map(([id,label])=>({id,label:names[id] ?? label,customLabel:!!names[id],current:id==='a',accessText:'Approved for your account',lockState:'secured',edge:'current'}));
 const label=accessBrowserLabel(browsers.find(n=>n.id===selected.id), browsers);
 const setName=async input => { if(window.__fail){setError('Save failed');return false;} setError(null);setNames(prev=>({...prev,[input.id]:input.name ?? undefined}));return true; };
 const details=<section aria-label="Selected access details"><button type="button" className="btn-danger inline-flex min-h-11 items-center gap-1 sm:min-h-8" title="Remove this browser’s access" aria-label={'Remove access for '+label} disabled={offline||last} onClick={()=>setConfirm(true)}><svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>Disconnect</button>{confirm&&<div role="group" aria-label="Confirm account device revocation"><p>Remove this browser from all shared computers?</p><button type="button" onClick={()=>{window.__revokes++;setConfirm(false)}}>Confirm remove access</button><button type="button" onClick={()=>setConfirm(false)}>Cancel</button></div>}</section>;
 return <SecurityAccessMap browsers={browsers} bridges={[{id:'computer',label:'Desk',accessText:'Shared with your approved browsers',connectionText:'Connected',lockState:'secured',edge:'current'}]} account={{statusText:'Verified',lockState:'secured'}} selected={selected} onSelect={node=>{setSelected(node);setConfirm(false)}} selectedDetails={details}
  renderBrowserName={(node,name)=><DeviceDisplayNameEditor key={'owner:'+node.id} variant="inline" target={{kind:'browser',id:node.id}} label={name} customName={names[node.id]} disabledReason={offline?'Reconnect and verify access before renaming.':undefined} saving={false} error={error} setName={setName}/>}/>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const built = await esbuild.build({ stdin: { contents: fixture, sourcefile: "visual-fixture.tsx", resolveDir: resolve(root, "ui"), loader: "tsx" }, jsx: "automatic", bundle: true, write: false, format: "iife", platform: "browser", tsconfig: resolve(root, "ui/tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' } });
const css = await postcss([tailwind()]).process(await readFile(resolve(root, "ui/src/app/globals.css"), "utf8"), { from: resolve(root, "ui/src/app/globals.css") });
const html = `<!doctype html><html><head><style>${css.css}\nbody{margin:0;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-mono)}#root{max-width:980px;margin:auto;padding:12px}</style></head><body><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); });
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address(); let browser;
try {
  browser = await chromium.launch({ headless: true }); await mkdir('/tmp/ftown-browser-device-actions', { recursive: true });
  for (const [name, viewport] of (ciMode ? [['desktop', { width: 1280, height: 900 }]] : [['desktop', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]])) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${address.port}/`) ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => console.error(`${name} page error:`, error));
    try {
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const card = page.locator('[data-access-card="browser:b"]');
      if (!ciMode) {
        const heights = await page.locator('[data-access-node]').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('data-access-node'), height: node.getBoundingClientRect().height })));
        if (heights.some(node => node.height < 44)) throw new Error(`${name}: selection node height below 44: ${JSON.stringify(heights)}`);
      }
      if (ciMode === 'height') {
        const heights = await page.locator('[data-access-node]').evaluateAll(nodes => nodes.map(node => ({ kind: node.getAttribute('data-access-kind'), id: node.getAttribute('data-access-node'), height: node.getBoundingClientRect().height })));
        await page.screenshot({ path: '/tmp/ftown-browser-device-actions/ci-height.png', fullPage: true });
        if (heights.some(node => node.height < 44)) throw new Error(`CI node height must be >=44: ${JSON.stringify(heights)}`);
        continue;
      }
      if (ciMode === 'name') {
        await card.getByRole('button', { name: 'Rename Phone' }).click();
        await card.getByLabel('Display name').fill('Browser'); await card.getByRole('button', { name: 'Save', exact: true }).click();
        await card.getByRole('button', { name: 'Rename Browser' }).waitFor({ state: 'visible' });
        const selection = card.locator('[data-access-node="b"]');
        const aria = await selection.getAttribute('aria-label');
        await page.screenshot({ path: '/tmp/ftown-browser-device-actions/ci-name.png', fullPage: true });
        if (!await card.getByText('Browser', { exact: true }).isVisible() || !aria?.startsWith('Browser Browser: Approved for your account')) throw new Error(`Renamed browser identity missing: aria=${JSON.stringify(aria)}, card=${JSON.stringify(await card.textContent())}`);
        continue;
      }
      const selector = card.getByRole('button', { name: /^Browser Phone:/ });
      const oldBox = await card.boundingBox(); const pencil = card.getByRole('button', { name: 'Rename Phone' });
      const nameBox = await card.getByText('Phone', { exact: true }).boundingBox(), pencilBox = await pencil.boundingBox();
      if (!nameBox || !pencilBox || pencilBox.x - (nameBox.x + nameBox.width) > 5) throw new Error(`${name}: pencil is not adjacent to name`);
      await pencil.click();
      const input = card.getByLabel('Display name'); if (!await input.evaluate(el => el === document.activeElement)) throw new Error(`${name}: editor lacks initial focus`);
      if (await selector.getAttribute('aria-pressed') !== 'false') throw new Error(`${name}: rename selected the card`);
      if (name === 'mobile') { const editBox = await card.boundingBox(); if (!oldBox || !editBox || editBox.width <= oldBox.width) throw new Error(`${name}: editing card did not expand`); }
      await page.screenshot({ path: `/tmp/ftown-browser-device-actions/${name}-editing.png`, fullPage: true });
      await input.fill('Work phone'); await input.press('Enter');
      const renamed = card.getByRole('button', { name: 'Rename Work phone' }); await renamed.waitFor({ state: 'visible' });
      if (!await card.getByText('Work phone', { exact: true }).isVisible() || !(await card.locator('[data-access-node="b"]').getAttribute('aria-label'))?.startsWith('Browser Work phone: Approved for your account')) throw new Error(`${name}: renamed card identity missing`);
      if (!await renamed.evaluate(el => el === document.activeElement)) throw new Error(`${name}: save did not restore pencil focus`);
      await card.getByRole('button', { name: /^Browser Work phone:/ }).click();
      const disconnect = card.getByRole('button', { name: 'Remove access for Work phone' });
      const red = await disconnect.evaluate(el => { const sample = document.createElement('span'); sample.style.color = 'var(--status-error)'; document.body.append(sample); const expected = getComputedStyle(sample).color; sample.remove(); const actual = getComputedStyle(el); return { color: actual.color, expected, border: actual.borderColor }; });
      if (await disconnect.isDisabled() || red.color !== red.expected || !/^rgba?\(255, 68, 102(?:,|\))/.test(red.border) || await disconnect.locator('svg[aria-hidden="true"]').count() !== 1) throw new Error(`${name}: enabled disconnect is not red with icon: ${JSON.stringify(red)}`);
      if (name === 'desktop') { const status = card.getByText('Approved for your account', { exact: true }); if (!(await status.isVisible()) || await status.evaluate(el => getComputedStyle(el).textOverflow) === 'ellipsis') throw new Error(`${name}: access status is not fully visible`); }
      await page.screenshot({ path: `/tmp/ftown-browser-device-actions/${name}-enabled.png`, fullPage: true });
      await disconnect.click(); if (await page.evaluate(() => window.__revokes) !== 0) throw new Error(`${name}: disconnect bypassed confirmation`);
      const confirm = card.getByRole('group', { name: 'Confirm account device revocation' }); await confirm.waitFor();
      await confirm.getByRole('button', { name: 'Cancel' }).click(); await confirm.waitFor({ state: 'hidden' }); if (await confirm.count()) throw new Error(`${name}: cancel did not close confirmation`);
      await disconnect.click(); await confirm.getByRole('button', { name: 'Confirm remove access' }).click();
      if (await page.evaluate(() => window.__revokes) !== 1) throw new Error(`${name}: mocked confirmation failed`);
      await renamed.click(); await card.getByRole('button', { name: 'Reset name' }).click();
      await card.getByRole('button', { name: 'Rename Phone' }).waitFor();
      await page.evaluate(() => { window.__fail=true; }); await card.getByRole('button', { name: 'Rename Phone' }).click();
      const retry = card.getByLabel('Display name'); await retry.fill('Unsaved name'); await retry.press('Enter');
      await card.getByText('Save failed').waitFor(); if (await retry.inputValue() !== 'Unsaved name') throw new Error(`${name}: failed draft was lost`);
      await retry.press('Escape'); if (!await card.getByRole('button', { name: 'Rename Phone' }).evaluate(el => el === document.activeElement)) throw new Error(`${name}: Escape did not restore focus`);
      await page.evaluate(() => window.__setOffline(true));
      await page.waitForFunction(() => document.querySelector('[data-access-card="browser:b"] button[aria-label="Remove access for Phone"]')?.disabled);
      if (!await card.getByRole('button', { name: 'Remove access for Phone' }).isDisabled() || !await card.getByRole('button', { name: 'Rename Phone' }).isDisabled()) throw new Error(`${name}: offline guards missing`);
      await page.evaluate(() => { window.__setOffline(false); window.__setLast(true); });
      await page.waitForFunction(() => !document.querySelector('[data-access-card="browser:b"] button[title="Reconnect and verify access before renaming."]'));
      if (!await card.getByRole('button', { name: 'Remove access for Phone' }).isDisabled()) throw new Error(`${name}: last-admin guard missing`);
      await page.evaluate(() => window.__setLast(false));
      await page.waitForFunction(() => !document.querySelector('[data-access-card="browser:b"] button[aria-label="Remove access for Phone"]').disabled);
      const nested = await page.locator('button button, button input').count(); if (nested) throw new Error(`${name}: nested interactive controls`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: horizontal overflow`);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const line=document.querySelector('[data-access-edge="browser:b"]'); const header=document.querySelector('[data-access-card="browser:b"] [data-access-node="b"]').parentElement;
        const canvas=line.closest('svg').parentElement.getBoundingClientRect(), box=header.getBoundingClientRect();
        const numbers=line.getAttribute('d').match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
        const horizontal=matchMedia('(min-width: 640px)').matches;
        return {x:numbers[0],y:numbers[1],expectedX:(horizontal?box.right:box.left+box.width/2)-canvas.left,expectedY:(horizontal?box.top+box.height/2:box.bottom)-canvas.top};
      });
      if (!Number.isFinite(geometry.x) || Math.abs(geometry.x-geometry.expectedX)>1 || Math.abs(geometry.y-geometry.expectedY)>1) throw new Error(`${name}: connector did not follow header: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: `/tmp/ftown-browser-device-actions/${name}.png`, fullPage: true });
      console.log(`${name}: editing, selection, confirmation, guards, connector and layout checks passed`);
    } catch (error) { await page.screenshot({ path: `/tmp/ftown-browser-device-actions/${name}-failure.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }
} finally { try { if (browser) await browser.close(); } finally { await new Promise(resolveClose => server.close(resolveClose)); } }
