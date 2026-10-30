// Root-only visual check. From the task worktree, with Node 24.22.1:
// PATH=/Users/fkesheh/.nvm/versions/node/v24.22.1/bin:$PATH node --experimental-strip-types docs/investigations/pr-ci-status/visual-smoke.ts
// Requires installed bridge/ui/e2e dependencies and Playwright Chromium. Uses an ephemeral
// localhost server, mocked RPC, no bridge, production services, database or GitHub.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd();
const bridgeRequire = createRequire(resolve(root, "bridge/package.json"));
const uiRequire = createRequire(resolve(root, "ui/package.json"));
const e2eRequire = createRequire(resolve(root, "e2e/package.json"));
const esbuild = bridgeRequire("esbuild");
const postcss = uiRequire("postcss");
const tailwind = uiRequire("@tailwindcss/postcss");
const { chromium } = e2eRequire("@playwright/test");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { SessionList } from './src/components/SessionList';
import { PullRequestLink } from './src/components/PullRequestLink';
import { PullRequestStatusProvider } from './src/components/PullRequestStatusProvider';
const now = new Date().toISOString();
const states = ['merged','failed','passed','merged','closed','unknown','in_progress'];
const names = ['A very long selected orchestrator session name for geometry validation','Failed','Passed','Merged','Closed','No checks','Running'];
const sessions = states.map((state, i) => ({ id:'s'+i, name: names[i] + ' session', status:'running', bridgeId:'bridge', createdAt: now, updatedAt: now, pullRequestUrl:'https://github.com/Example/Project/pull/'+(i===0?161:i+1) }));
sessions.push({ id:'child', name:'Nested child', status:'running', bridgeId:'bridge', createdAt:now, updatedAt:now, parentSessionId:'s0', pullRequestUrl:'https://github.com/Example/Project/pull/8' });
const send = command => new Promise(resolve => { window.__deliverStatus = () => resolve({requestId: command.requestId, success:true, data:{bridgeId:'bridge',nextRefreshAt:new Date(Date.now()+60000).toISOString(),statuses:sessions.map((s,i)=>({url:s.pullRequestUrl,state:states[i] ?? 'in_progress',checkedAt:now,stale:i===2, ...(i===5?{reason:'no_checks'}:i===0||i===2?{reason:'unavailable'}:{})}))}}); });
window.__selectionCount = 0;
function App(){const [selected,setSelected]=React.useState('s0');return <PullRequestStatusProvider send={send} sessions={sessions} readyBridgeIds={['bridge']} connected><main><aside><SessionList sessions={sessions} bridges={[{clientId:'c',bridgeId:'bridge',hostname:'Demo bridge',connectedAt:now}]} bridgeOrder={['bridge']} selectedSessionId={selected} onSelectSession={id => { window.__selectionCount++; setSelected(id); }} onStopSession={() => {}} onRemoveSession={() => {}} /></aside><section><p id="selection">Selected: {selected || 'none'}</p><PullRequestLink url={sessions[0].pullRequestUrl}/></section></main></PullRequestStatusProvider>};
createRoot(document.getElementById('root')).render(<App/>);
`;
const built = await esbuild.build({ stdin: { contents: fixture, sourcefile: "visual-fixture.tsx", resolveDir: resolve(root, "ui"), loader: "tsx" }, jsx: "automatic", bundle: true, write: false, format: "iife", platform: "browser", tsconfig: resolve(root, "ui/tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' } });
const css = await postcss([tailwind()]).process(await readFile(resolve(root, "ui/src/app/globals.css"), "utf8"), { from: resolve(root, "ui/src/app/globals.css") });
const html = `<!doctype html><html><head><style>${css.css}\nbody{margin:0;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-mono)}main{display:flex}aside{width:260px;max-width:100vw;background:var(--bg-surface)}section{padding:20px}@media(max-width:767px){main{display:block}aside{width:100%}}</style></head><body><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); });
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("/tmp/ftown-pr-ci-visual", { recursive: true });
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["desktop-min", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await context.route("https://github.com/**", route => route.fulfill({ status: 200, body: "Fixture navigation" }));
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => { pageErrors.push(error.message); console.error(`${name} page error:`, error); });
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      if (name === 'desktop-min') await page.locator('aside').evaluate(element => { element.style.width = '210px'; });
      const header = page.locator('section').getByRole('link', { name: /^PR #161 in Example\/Project(?=[:;])/ });
      await header.waitFor({ state: 'visible' });
      if (await header.getAttribute('aria-label') !== 'PR #161 in Example/Project: https://github.com/Example/Project/pull/161') throw new Error(`${name}: initial header is not neutral`);
      await page.waitForFunction(() => typeof window.__deliverStatus === 'function');
      await page.evaluate(() => window.__deliverStatus());
      const merged = page.locator('[data-session-row="s0"] [data-pull-request-badge]:visible');
      await page.waitForFunction(() => document.querySelector('[data-session-row="s0"] [data-pull-request-badge]')?.getAttribute('aria-label')?.includes('Merged'));
      const label = await merged.getAttribute('aria-label');
      if (await merged.textContent() !== '#161' || !label?.includes('Merged') || !label.includes('Checked') || await merged.getAttribute('title') !== label || await merged.locator('svg[aria-hidden="true"]').count() !== 1 || !(await merged.evaluate(el => el.firstElementChild?.tagName.toLowerCase() === 'svg'))) throw new Error(`${name}: compact merged badge or accessible status incorrect`);
      if (await header.getAttribute('href') !== 'https://github.com/Example/Project/pull/161' || !(await header.getAttribute('aria-label')).includes('Merged')) throw new Error(`${name}: header PR identity or status changed incorrectly`);
    } catch (error) {
      await page.screenshot({ path: `/tmp/ftown-pr-ci-visual/${name}-failure.png`, fullPage: true }).catch(() => {});
      console.error(`${name}: fixture failed; page errors:`, pageErrors);
      throw error;
    }
    await page.screenshot({ path: `/tmp/ftown-pr-ci-visual/${name}.png`, fullPage: true });
    const row = page.locator('[data-session-row="s0"]');
    const badge = row.locator('[data-pull-request-badge]');
    const placeholder = row.locator('[data-pull-request-placeholder]');
    const bb = await badge.boundingBox(), pb = await placeholder.boundingBox();
    const nameBox = await row.getByText('A very long selected orchestrator session name for geometry validation session', { exact: true }).boundingBox();
    if (!nameBox || nameBox.width < 30) throw new Error(`${name}: selected session name lacks usable width; name=${JSON.stringify(nameBox)}`);
    if (!bb || !pb || Math.abs(bb.width - pb.width) > 1) throw new Error(`${name}: placeholder differs in width`);
    if (bb.width > 90) throw new Error(`${name}: three-digit merged badge exceeds 90px; width=${bb.width}`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: horizontal page overflow`);
    const menu = row.getByRole('button', { name: 'Session actions', exact: true });
    const mb = await menu.boundingBox();
    if (!mb || (bb.x < mb.x + mb.width && bb.x + bb.width > mb.x && bb.y < mb.y + mb.height && bb.y + bb.height > mb.y)) throw new Error(`${name}: badge overlaps actions; badge=${JSON.stringify(bb)}, action=${JSON.stringify(mb)}`);
    const expand = row.getByRole('button', { name: 'Expand children', exact: true });
    await expand.waitFor({ state: 'visible' });
    const eb = await expand.boundingBox();
    if (!eb || (bb.x < eb.x + eb.width && bb.x + bb.width > eb.x && bb.y < eb.y + eb.height && bb.y + bb.height > eb.y)) throw new Error(`${name}: badge overlaps expand control; badge=${JSON.stringify(bb)}, expand=${JSON.stringify(eb)}`);
    await expand.click();
    await row.getByRole('button', { name: 'Collapse children', exact: true }).waitFor({ state: 'visible' });
    const child = page.locator('[data-session-row="child"]');
    await child.waitFor({ state: 'visible' });
    const childBadge = await child.locator('[data-pull-request-badge]').boundingBox();
    const childMenu = await child.getByRole('button', { name: 'Session actions', exact: true }).boundingBox();
    const childRow = await child.boundingBox();
    if (!childBadge || !childMenu || !childRow || childBadge.x < childRow.x || childBadge.x + childBadge.width > childRow.x + childRow.width || (childBadge.x < childMenu.x + childMenu.width && childBadge.x + childBadge.width > childMenu.x && childBadge.y < childMenu.y + childMenu.height && childBadge.y + childBadge.height > childMenu.y)) throw new Error(`${name}: nested badge geometry invalid; badge=${JSON.stringify(childBadge)}, menu=${JSON.stringify(childMenu)}, row=${JSON.stringify(childRow)}`);
    await row.getByRole('button', { name: 'Collapse children', exact: true }).click();
    await expand.waitFor({ state: 'visible' });
    if (await page.locator('[data-session-row="child"]').count()) throw new Error(`${name}: child remains visible after collapse`);
    await badge.focus(); if (!await badge.evaluate(el => el === document.activeElement)) throw new Error(`${name}: badge cannot receive keyboard focus`);
    const selectionCount = await page.evaluate(() => window.__selectionCount);
    const popup = page.waitForEvent('popup'); await badge.click(); const opened = await popup; await opened.close();
    if (await page.evaluate(() => window.__selectionCount) !== selectionCount || await page.locator('#selection').textContent() !== 'Selected: s0') throw new Error(`${name}: badge click selected row`);
    try {
      await menu.click();
      await page.getByRole('menu', { name: 'Session actions', exact: true }).waitFor({ state: 'visible' });
    } catch (error) {
      const expanded = await menu.getAttribute('aria-expanded').catch(() => null);
      const menuCount = await page.locator('[role="menu"]').count();
      const namedMenuCount = await page.getByRole('menu', { name: 'Session actions', exact: true }).count();
      await page.screenshot({ path: `/tmp/ftown-pr-ci-visual/${name}-menu-failure.png`, fullPage: true }).catch(() => {});
      console.error(`${name}: menu failure; aria-expanded=${expanded}, menu count=${menuCount}, named menu count=${namedMenuCount}`);
      throw error;
    }
    console.log(`${name}: screenshot saved; placeholder, overflow, focus, link and menu checks passed`);
    await context.close();
  }
} finally {
  try { if (browser) await browser.close(); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); }
}
