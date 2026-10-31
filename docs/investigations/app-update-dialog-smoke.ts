// Root-only isolated browser check. From task checkout with Node 24.22.1:
// PATH=/Users/fkesheh/.nvm/versions/node/v24.22.1/bin:$PATH node --experimental-strip-types docs/investigations/app-update-dialog-smoke.ts
// Requires installed bridge/ui/e2e dependencies and Chromium. Ephemeral loopback only;
// mocked fetch, no production services, bridge, database, or external requests.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd();
const bridgeRequire = createRequire(resolve(root, "bridge/package.json"));
const uiRequire = createRequire(resolve(root, "ui/package.json"));
const e2eRequire = createRequire(resolve(root, "e2e/package.json"));
const esbuild = bridgeRequire("esbuild"), postcss = uiRequire("postcss"), tailwind = uiRequire("@tailwindcss/postcss");
const { chromium } = e2eRequire("@playwright/test");
const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AppUpdateNotice } from './src/components/AppUpdateNotice';
window.__latest='new-one'; window.__fetchCount=0; window.__reloads=0;
let release; const first = new Promise(resolve => { release=resolve; }); window.__releaseUpdate=release;
window.fetch=async () => { window.__fetchCount++; await first; return {ok:true,json:async()=>({buildId:window.__latest})}; };
function App(){return <><header id="toolbar"><button id="prior">Prior control</button></header><AppUpdateNotice buildId="old" reload={() => window.__reloads++}/><main id="terminal">Terminal workspace</main></>};
createRoot(document.getElementById('root')).render(<App/>);
`;
const built = await esbuild.build({ stdin: { contents: fixture, sourcefile: "visual-fixture.tsx", resolveDir: resolve(root, "ui"), loader: "tsx" }, jsx: "automatic", bundle: true, write: false, format: "iife", platform: "browser", tsconfig: resolve(root, "ui/tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' } });
const css = await postcss([tailwind()]).process(await readFile(resolve(root, "ui/src/app/globals.css"), "utf8"), { from: resolve(root, "ui/src/app/globals.css") });
const html = `<!doctype html><html><head><style>${css.css}\nbody{margin:0;background:var(--bg-base);color:var(--text-primary);font-family:var(--font-mono)}header{height:48px;padding:4px 12px}main{height:500px;border:1px solid var(--border-muted);padding:12px}#prior{min-height:40px}</style></head><body><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); });
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("/tmp/ftown-app-update-dialog", { recursive: true });
  for (const [name, viewport] of [["desktop", { width: 1280, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport });
    await context.route('**/*', route => route.request().url().startsWith(`http://127.0.0.1:${address.port}/`) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => console.error(`${name} page error:`, error));
    try {
      await page.goto(`http://127.0.0.1:${address.port}/`);
      const prior = page.locator('#prior'); await prior.focus();
      await page.evaluate(() => {
        const custom = document.createElement('div'); custom.id = 'existing-modal'; custom.setAttribute('role', 'dialog'); custom.setAttribute('aria-modal', 'true');
        const button = document.createElement('button'); button.id = 'existing-control'; button.textContent = 'Existing modal control'; custom.append(button); document.body.append(custom); button.focus();
        const hidden = document.createElement('div'); hidden.hidden = true; hidden.setAttribute('role', 'alertdialog'); hidden.setAttribute('aria-modal', 'true'); document.body.append(hidden);
      });
      const toolbar = await page.locator('#toolbar').boundingBox(), terminal = await page.locator('#terminal').boundingBox();
      await page.waitForFunction(() => typeof window.__releaseUpdate === 'function' && window.__fetchCount > 0);
      await page.evaluate(() => window.__releaseUpdate());
      const pending = page.locator('dialog'); await pending.waitFor({ state: 'attached' });
      if (await pending.evaluate(el => el.open) || !await page.locator('#existing-control').evaluate(el => el === document.activeElement)) throw new Error(`${name}: update interrupted an existing custom modal`);
      await page.evaluate(() => { document.querySelector('#existing-modal').remove(); document.querySelector('#prior').focus(); });
      const dialog = page.getByRole('dialog', { name: 'App update available' }); await dialog.waitFor({ state: 'visible' });
      if (!await dialog.getAttribute('aria-describedby') || !(await dialog.textContent()).includes('A new version is ready.')) throw new Error(`${name}: accessible dialog description missing`);
      const later = dialog.getByRole('button', { name: 'Later', exact: true }), reload = dialog.getByRole('button', { name: 'Reload', exact: true });
      if (!await later.evaluate(el => el === document.activeElement)) throw new Error(`${name}: initial focus is not Later`);
      for (const button of [later, reload]) { const box = await button.boundingBox(); if (!box || box.height < 44) throw new Error(`${name}: action target too small`); }
      await page.keyboard.press('Tab'); if (!await reload.evaluate(el => el === document.activeElement)) throw new Error(`${name}: Tab did not move to Reload`);
      await page.keyboard.press('Shift+Tab'); if (!await later.evaluate(el => el === document.activeElement)) throw new Error(`${name}: reverse Tab did not return to Later`);
      if (JSON.stringify(toolbar) !== JSON.stringify(await page.locator('#toolbar').boundingBox()) || JSON.stringify(terminal) !== JSON.stringify(await page.locator('#terminal').boundingBox())) throw new Error(`${name}: modal changed dashboard layout`);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`${name}: horizontal overflow`);
      await page.screenshot({ path: `/tmp/ftown-app-update-dialog/${name}.png`, fullPage: true });
      await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
      if (!await prior.evaluate(el => el === document.activeElement) || await page.evaluate(() => window.__reloads) !== 0) throw new Error(`${name}: Escape did not restore focus or reloaded`);
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(() => window.__fetchCount >= 2);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      if (await dialog.count()) throw new Error(`${name}: dismissed build reappeared`);
      await page.evaluate(() => { window.__latest = 'new-two'; document.dispatchEvent(new Event('visibilitychange')); });
      await dialog.waitFor({ state: 'visible' });
      const bounds = await dialog.boundingBox(); if (!bounds || bounds.x <= 1 || bounds.y <= 1) throw new Error(`${name}: no safe backdrop point`);
      await page.mouse.click(1, 1); await dialog.waitFor({ state: 'hidden' });
      if (!await prior.evaluate(el => el === document.activeElement) || await page.evaluate(() => window.__reloads) !== 0) throw new Error(`${name}: backdrop did not restore focus or reloaded`);
      if (await page.evaluate(() => sessionStorage.getItem('ftown:app-update-later')) !== 'new-two') throw new Error(`${name}: backdrop did not suppress build`);
      await page.evaluate(() => { window.__latest = 'new-three'; document.dispatchEvent(new Event('visibilitychange')); });
      await dialog.waitFor({ state: 'visible' }); await reload.click();
      if (await page.evaluate(() => window.__reloads) !== 1) throw new Error(`${name}: Reload did not invoke reload exactly once`);
      console.log(`${name}: native modal, focus, dismissal, suppression, reload and layout checks passed`);
    } catch (error) {
      await page.screenshot({ path: `/tmp/ftown-app-update-dialog/${name}-failure.png`, fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally {
  try { if (browser) await browser.close(); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); }
}
