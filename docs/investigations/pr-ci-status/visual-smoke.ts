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
const states = ['in_progress','failed','passed','merged','closed','unknown','unknown'];
const names = ['Running','Failed','Passed','Merged','Closed','No checks','Unavailable'];
const sessions = states.map((state, i) => ({ id:'s'+i, name: names[i] + ' session', status:'running', bridgeId:'bridge', createdAt: now, updatedAt: now, pullRequestUrl:'https://github.com/Example/Project/pull/'+(i+1) }));
const send = async command => ({requestId: command.requestId, success:true, data:{bridgeId:'bridge',nextRefreshAt:new Date(Date.now()+60000).toISOString(),statuses:sessions.map((s,i)=>({url:s.pullRequestUrl,state:states[i],checkedAt:now,stale:i===2, ...(i===5?{reason:'no_checks'}:i===6||i===2?{reason:'unavailable'}:{})}))}});
function App(){const [selected,setSelected]=React.useState(null);return <PullRequestStatusProvider send={send} sessions={sessions} readyBridgeIds={['bridge']} connected><main><aside><SessionList sessions={sessions} bridges={[{clientId:'c',bridgeId:'bridge',hostname:'Demo bridge',connectedAt:now}]} bridgeOrder={['bridge']} selectedSessionId={selected} onSelectSession={setSelected} onStopSession={() => {}} onRemoveSession={() => {}} /></aside><section><p id="selection">Selected: {selected || 'none'}</p><PullRequestLink url={sessions[0].pullRequestUrl}/></section></main></PullRequestStatusProvider>};
createRoot(document.getElementById('root')).render(<App/>);
`;
const built = await esbuild.build({ stdin: { contents: fixture, sourcefile: "visual-fixture.tsx", resolveDir: resolve(root, "ui"), loader: "tsx" }, jsx: "automatic", bundle: true, write: false, format: "iife", platform: "browser", tsconfig: resolve(root, "ui/tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' } });
const css = await postcss([tailwind()]).process(await readFile(resolve(root, "ui/src/app/globals.css"), "utf8"), { from: resolve(root, "ui/src/app/globals.css") });
const html = `<!doctype html><html><head><style>${css.css}\nbody{margin:0;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-mono)}main{display:flex}aside{width:360px;max-width:100vw;background:var(--bg-surface)}section{padding:20px}@media(max-width:767px){main{display:block}aside{width:100%}}</style></head><body><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); });
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("/tmp/ftown-pr-ci-visual", { recursive: true });
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await context.route("https://github.com/**", route => route.fulfill({ status: 200, body: "Fixture navigation" }));
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => { pageErrors.push(error.message); console.error(`${name} page error:`, error); });
    try {
      await page.goto(`http://127.0.0.1:${address.port}`);
      const visibleBadge = page.locator('[data-pull-request-badge]:visible').filter({ hasText: "PR #1 · CI running" }).first();
      await visibleBadge.waitFor();
      if ((await visibleBadge.textContent()) !== "PR #1 · CI running") throw new Error(`${name}: unexpected badge text: ${await visibleBadge.textContent()}`);
    } catch (error) {
      await page.screenshot({ path: `/tmp/ftown-pr-ci-visual/${name}-failure.png`, fullPage: true }).catch(() => {});
      console.error(`${name}: fixture failed; page errors:`, pageErrors);
      throw error;
    }
    await page.screenshot({ path: `/tmp/ftown-pr-ci-visual/${name}.png`, fullPage: true });
    const badge = page.locator('[data-pull-request-badge]').first();
    const placeholder = page.locator('[data-pull-request-placeholder]').first();
    const bb = await badge.boundingBox(), pb = await placeholder.boundingBox();
    if (!bb || !pb || Math.abs(bb.width - pb.width) > 1) throw new Error(`${name}: placeholder differs in width`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: horizontal page overflow`);
    const menu = page.getByRole('button', { name: 'Session actions', exact: true }).first();
    const mb = await menu.boundingBox();
    if (!mb || (bb.x < mb.x + mb.width && bb.x + bb.width > mb.x && bb.y < mb.y + mb.height && bb.y + bb.height > mb.y)) throw new Error(`${name}: badge overlaps actions; badge=${JSON.stringify(bb)}, action=${JSON.stringify(mb)}`);
    await badge.focus(); if (!await badge.evaluate(el => el === document.activeElement)) throw new Error(`${name}: badge cannot receive keyboard focus`);
    const popup = page.waitForEvent('popup'); await badge.click(); const opened = await popup; await opened.close();
    if (await page.locator('#selection').textContent() !== 'Selected: none') throw new Error(`${name}: badge click selected row`);
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
