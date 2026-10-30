// Root-only; from repository root with Node 24.22.1:
// PATH=/Users/fkesheh/.nvm/versions/node/v24.22.1/bin:$PATH node --experimental-strip-types docs/investigations/update-dialog/ci-repro.ts
// Actual components; ephemeral localhost server, no live bridge/database. Collects both assertions before exit.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd();
const esbuild = createRequire(resolve(root, "bridge/package.json"))("esbuild");
const uiRequire = createRequire(resolve(root, "ui/package.json"));
const postcss = uiRequire("postcss"), tailwind = uiRequire("@tailwindcss/postcss");
const { chromium, expect } = createRequire(resolve(root, "e2e/package.json"))("@playwright/test");
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BridgeUpdatesDialog} from './src/components/BridgeUpdatesDialog';
import {SessionHeaderActions} from './src/components/SessionHeaderActions';
function App(){const [open,setOpen]=React.useState(false);return <><header data-testid="terminal-header"><SessionHeaderActions hasPreview previewOpen={false} running relaunchLabel="Rerun" onPreview={()=>{}} onStop={()=>{}} onRelaunch={()=>{}}/></header><button id="open" onClick={()=>setOpen(true)}>Open</button><BridgeUpdatesDialog open={open} name="Fixture machine" view={{status:{schema:1,bridgeId:'a',currentVersion:'1.0.0',latestVersion:'1.1.0',checkedAt:null,availability:'available',canUpdate:true,blockedReason:null,operation:null,manualCommand:'npx ftown@1.1.0 setup'},loading:false,message:null,operation:null,complete:false}} onClose={()=>setOpen(false)} onCheck={()=>{}} onUpdate={()=>{}}/></>}
createRoot(document.getElementById('root')).render(<App/>);
`;
const built = await esbuild.build({ stdin: { contents: fixture, sourcefile: "ci-repro-fixture.tsx", resolveDir: resolve(root, "ui"), loader: "tsx" }, jsx: "automatic", bundle: true, write: false, format: "iife", platform: "browser", tsconfig: resolve(root, "ui/tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' } });
const css = await postcss([tailwind()]).process(await readFile(resolve(root, "ui/src/app/globals.css"), "utf8"), { from: resolve(root, "ui/src/app/globals.css") });
// Reuse the exact production selector expression, so the regression cannot drift.
const spec = await readFile(resolve(root, "e2e/tests/bridge-updates.spec.ts"), "utf8");
const selectorLine = spec.split("\n").find(line => line.trim().startsWith("const installedRow = "));
if (!selectorLine) throw new Error("Missing production installedRow selector");
const selectInstalledRow = new Function("dialog", "page", selectorLine.trim().replace(/^const installedRow = /, "return "));
const html = `<!doctype html><html><head><style>${css.css}</style></head><body><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); });
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
let browser, failures = 0;
try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1280, 900, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${address.port}`);
    const header = page.getByTestId("terminal-header");
    const actions = {};
    for (const action of ["Stop", "Rerun"]) {
      const button = header.getByRole("button", { name: action, exact: true });
      const expected = width < 768 ? "44px" : "32px";
      let cssAssertion = "passed";
      try { await expect(button).toHaveCSS("min-height", expected, {timeout:500}); }
      catch { cssAssertion = "failed"; failures++; }
      const box = await button.boundingBox();
      if (!box || box.height !== parseInt(expected) || box.width !== parseInt(expected)) { cssAssertion += "/invalid-box"; failures++; }
      actions[action] = { expected, cssAssertion, computed: await button.evaluate(el => ({ minHeight: getComputedStyle(el).minHeight, color: getComputedStyle(el).color })), box };
    }
    await page.locator("#open").click();
    const dialog = page.getByRole("dialog", { name: "Bridge updates" });
    await dialog.waitFor({state:"visible"});
    const installedRow = selectInstalledRow(dialog, page);
    const legacyRow = dialog.locator("dl > div").filter({ has: dialog.getByText("Installed", { exact: true }) });
    let ciAssertion = "passed";
    try { await expect(installedRow.locator("dd")).not.toHaveText("Unknown", {timeout:500}); }
    catch { ciAssertion = "failed"; failures++; }
    const installed = installedRow.locator("dd");
    if (await installed.count() !== 1 || await installed.textContent() !== "1.0.0" || await legacyRow.count() !== 0) { failures++; ciAssertion += "/control-failed"; }
    console.log(JSON.stringify({ width, ciAssertion, productionRowCount: await installedRow.count(), legacyRowCount: await legacyRow.count(), installed: await installed.count() ? await installed.textContent() : null, actions }));
    await context.close();
  }
} finally {
  try { if (browser) await browser.close(); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); }
}
if (failures) { console.error(`CI reproduction: ${failures} assertions failed`); process.exitCode = 1; }
else console.log("CI reproduction: all assertions passed");
