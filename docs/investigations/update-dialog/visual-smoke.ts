// Root-only: PATH=/Users/fkesheh/.nvm/versions/node/v24.22.1/bin:$PATH node --experimental-strip-types docs/investigations/update-dialog/visual-smoke.ts
// Actual component with fixture props; ephemeral loopback server, no bridge or database.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
const root = process.cwd();
const esbuild = createRequire(resolve(root, "bridge/package.json"))("esbuild");
const uiRequire = createRequire(resolve(root, "ui/package.json"));
const postcss = uiRequire("postcss"), tailwind = uiRequire("@tailwindcss/postcss");
const { chromium } = createRequire(resolve(root, "e2e/package.json"))("@playwright/test");
const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BridgeUpdatesDialog} from './src/components/BridgeUpdatesDialog';
import {SessionHeaderActions} from './src/components/SessionHeaderActions';
const base = {schema:1,bridgeId:'demo',currentVersion:'0.19.61',latestVersion:'0.19.62',checkedAt:null,availability:'available',canUpdate:true,blockedReason:null,operation:null,manualCommand:'npx ftown@0.19.62 setup'};
const states = {
  unsupported:{...base,availability:'current',canUpdate:false,blockedReason:'unsupported_launch'},
  node:{...base,canUpdate:false,blockedReason:'node_incompatible',currentNodeVersion:'24.12.0',requiredNodeEngine:'^24.22.1'},
  eligible:base, loading:base, unknown:{...base,availability:'unknown',canUpdate:false},
};
window.__updates = 0; window.__checks = 0; window.__clipboard = ''; window.__preview = 0; window.__stop = 0; window.__relaunch = 0;
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText: async value => {window.__clipboard = value}}});
function App(){
  const [open,setOpen]=React.useState(false), [state,setState]=React.useState('unsupported');
  const [previewOpen,setPreviewOpen] = React.useState(false), [running,setRunning] = React.useState(true), [relaunchLabel,setRelaunchLabel] = React.useState('Rerun');
  window.__setState = setState; window.__setPreviewOpen = setPreviewOpen; window.__setRunning = setRunning; window.__setRelaunchLabel = setRelaunchLabel;
  const view = {status:states[state],loading:state==='loading',message:null,operation:null,complete:false};
  return <><header style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px",background:"var(--bg-surface)"}}><span>Session name</span><SessionHeaderActions hasPreview previewOpen={previewOpen} running={running} relaunchLabel={relaunchLabel} onPreview={()=>window.__preview++} onStop={()=>window.__stop++} onRelaunch={()=>window.__relaunch++}/></header><button id="opener" onClick={()=>setOpen(true)}>Open updates</button><BridgeUpdatesDialog open={open} name="Very long workstation name that should wrap cleanly across a narrow mobile dialog without clipping" view={view} onClose={()=>setOpen(false)} onCheck={()=>window.__checks++} onUpdate={()=>window.__updates++}/></>;
}
createRoot(document.getElementById('root')).render(<App/>);
`;
const built = await esbuild.build({ stdin: { contents: fixture, sourcefile: "update-fixture.tsx", resolveDir: resolve(root, "ui"), loader: "tsx" }, jsx: "automatic", bundle: true, write: false, format: "iife", platform: "browser", tsconfig: resolve(root, "ui/tsconfig.json"), define: { "process.env.NODE_ENV": '"production"' } });
const css = await postcss([tailwind()]).process(await readFile(resolve(root, "ui/src/app/globals.css"), "utf8"), { from: resolve(root, "ui/src/app/globals.css") });
const html = `<!doctype html><html><head><style>${css.css}</style></head><body><div id="root"></div><script>${built.outputFiles[0].text}</script></body></html>`;
const server = createServer((_request, response) => { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); });
await new Promise(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
const address = server.address();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  await mkdir("/tmp/ftown-update-dialog-visual", { recursive: true });
  for (const viewport of [{width:1280,height:800}, {width:390,height:844}, {width:320,height:640}]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    const opener = page.locator("#opener"), dialog = page.getByRole("dialog", {name:"Bridge updates"});
    await opener.click();
    await dialog.waitFor({state:"visible"});
    if (!await dialog.getByText("Up to date").isVisible() || !await dialog.getByText(/Automatic updates aren’t available/).isVisible()) throw new Error("unsupported/current state missing");
    if (await dialog.locator("details").evaluate(el => el.open)) throw new Error("details initially open");
    const metrics = await dialog.evaluate(el => {const box=el.getBoundingClientRect(); return {x:box.x,y:box.y,width:box.width,height:box.height,scroll:el.scrollWidth,client:el.clientWidth,font:getComputedStyle(el).fontFamily,body:getComputedStyle(document.body).fontFamily};});
    if (metrics.x < 0 || metrics.y < 0 || metrics.width > viewport.width || metrics.height > viewport.height - 30 || metrics.scroll > metrics.client || metrics.font === metrics.body || /mono/i.test(metrics.font.split(',')[0])) throw new Error(`invalid layout/font: ${JSON.stringify(metrics)}`);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("page overflows");
    await page.screenshot({path:`/tmp/ftown-update-dialog-visual/${viewport.width}-unsupported.png`});
    await dialog.getByText("Setup & runtime details").click();
    await dialog.getByRole("button", {name:"Copy command"}).click();
    if (await page.evaluate(() => window.__clipboard) !== "npx ftown@0.19.62 setup" || !await dialog.getByText("Copied.").isVisible()) throw new Error("copy failed");
    await page.evaluate(() => window.__setState('node'));
    await dialog.getByText(/Upgrade Node on this computer/).waitFor({state:"visible"});
    if (!await dialog.getByText(/Upgrade Node on this computer/).isVisible() || !await dialog.getByText("24.12.0").isVisible() || !await dialog.getByText("^24.22.1").isVisible()) throw new Error("Node warning missing");
    await page.screenshot({path:`/tmp/ftown-update-dialog-visual/${viewport.width}-node.png`});
    await page.evaluate(() => window.__setState('loading'));
    await dialog.getByText("Checking for updates").waitFor({state:"visible"});
    if (!await dialog.getByText("Checking for updates").isVisible() || !await dialog.getByRole("button", {name:"Check again"}).isDisabled() || await dialog.getByRole("button", {name:"Update and restart"}).count()) throw new Error("loading state invalid");
    await page.evaluate(() => window.__setState('unknown'));
    await dialog.getByText("Update status unavailable").waitFor({state:"visible"});
    if (!await dialog.getByText("Update status unavailable").isVisible()) throw new Error("unknown state missing");
    await page.evaluate(() => window.__setState('eligible'));
    await dialog.getByRole("button", {name:"Update and restart"}).click();
    await dialog.getByRole("button", {name:"Cancel", exact:true}).click();
    if (await page.evaluate(() => window.__updates) !== 0) throw new Error("cancel updated");
    await dialog.getByRole("button", {name:"Update and restart"}).click();
    await page.screenshot({path:`/tmp/ftown-update-dialog-visual/${viewport.width}-confirm.png`});
    await dialog.getByRole("button", {name:"Confirm update and restart"}).click();
    if (await page.evaluate(() => window.__updates) !== 1) throw new Error("confirmation callback missing");
    await page.keyboard.press("Escape");
    if (await dialog.count() || !await opener.evaluate(el => el === document.activeElement)) throw new Error("Escape/focus restoration failed");
    await opener.click();
    await page.mouse.click(2, 2);
    if (await dialog.count() || !await opener.evaluate(el => el === document.activeElement)) throw new Error("backdrop/focus restoration failed");
    const group = page.getByRole("group", {name:"Selected session actions"});
    const preview = group.getByRole("button", {name:"Open preview"}), stop = group.getByRole("button", {name:"Stop", exact:true}), relaunch = group.getByRole("button", {name:"Rerun"});
    for (const control of [preview, stop, relaunch]) {
      const box = await control.boundingBox(), expected = viewport.width >= 768 ? 32 : 44;
      if (!box || box.width !== expected || box.height !== expected || await control.evaluate(el => getComputedStyle(el).minHeight) !== `${expected}px` || await control.locator('svg[aria-hidden="true"]').count() !== 1 || (await control.textContent()).trim()) throw new Error(`invalid icon action geometry/content ${JSON.stringify(box)}`);
    }
    await preview.hover(); await page.getByRole("tooltip", {name:"Open preview"}).waitFor({state:"visible"});
    await stop.focus(); await page.getByRole("tooltip", {name:"Stop session"}).waitFor({state:"visible"});
    await page.screenshot({path:`/tmp/ftown-update-dialog-visual/${viewport.width}-header.png`});
    await preview.click(); await stop.click(); await relaunch.click();
    if (await page.evaluate(() => [window.__preview,window.__stop,window.__relaunch].join(',')) !== "1,1,1") throw new Error("header callbacks invalid");
    await page.evaluate(() => { window.__setPreviewOpen(true); window.__setRunning(false); window.__setRelaunchLabel('Retry'); });
    await group.getByRole("button", {name:"Retry"}).waitFor({state:"visible"});
    if (await preview.count() || await stop.count() || await group.getByRole("button", {name:"Retry"}).locator('svg[aria-hidden="true"]').count() !== 1) throw new Error("header conditional actions invalid");
    if (errors.length) throw new Error(`page errors: ${errors.join(', ')}`);
    await context.close();
    console.log(`${viewport.width}: layout, state, copy, confirmation, Escape and backdrop passed`);
  }
} finally {
  try { if (browser) await browser.close(); }
  finally { await new Promise(resolveClose => server.close(resolveClose)); }
}
