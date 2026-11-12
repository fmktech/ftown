import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, lstat, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, type Page } from "@playwright/test";
import { bridgeApiFetch } from "./bridge-api";
import { BRIDGE_HOME, E2E_DIR, UI_BASE_URL } from "./config";

const execute = promisify(execFile);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * Errors of an evaluation that raced the preview iframe's OWN lifecycle: the dashboard replaces or re-navigates that iframe
 * whenever the file changes or the user refreshes, so the frame is detached, its execution context destroyed, or the element
 * the locator resolved belongs to the document being replaced. They mean "the preview document is not there yet".
 */
const PREVIEW_FRAME_NOT_READY = [
  /Frame was detached/i,
  /frame got detached/i,
  /Execution context was destroyed/i,
  /Cannot find context with specified id/i,
  /Element is not attached to the DOM/i,
  /Target closed/i,
];

/**
 * For expect.poll / toPass callbacks: evaluate `fn` on the <body> of the preview document of `fileName`
 * (iframe[title="Preview: <fileName>"]). When the evaluation races the iframe being swapped or navigated
 * (PREVIEW_FRAME_NOT_READY), return `notReady` so the poll simply retries; pick a value the poll's matcher never accepts
 * (NaN for numeric comparisons, null for equality). Any other error fails the test, and so does a closed PAGE (a
 * "Target closed" for the page itself is not a frame swap).
 *
 * Playwright serializes the callback's source, so references to outer variables inside `fn` do not exist in the
 * page (ReferenceError). Pass every value the callback needs as `arg`; the callback receives it as its second
 * parameter.
 */
export async function inPreviewFrame<R, N>(page: Page, fileName: string, fn: (body: Element, arg: string) => R, notReady: N, arg?: string): Promise<R | N> {
  try {
    const body = page.frameLocator(`iframe[title="Preview: ${fileName}"]`).locator("body");
    return await (arg === undefined ? body.evaluate(fn as (element: Element) => R) : body.evaluate(fn, arg)) as R;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!page.isClosed() && PREVIEW_FRAME_NOT_READY.some(pattern => pattern.test(message))) return notReady;
    throw error;
  }
}

export interface CliOutput { code: number; stdout: string; stderr: string }
export interface PreviewReadObservation { state: string; previewId: string; transport: "cloud" | "local"; offset?: number }
export interface PreviewTransportObservation {
  reads: PreviewReadObservation[];
  encryptedCloudPublications: number;
  encryptedLocalRequests: number;
  leaked: boolean;
  markers: Set<string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function kindFor(fileName: string): "html" | "markdown" {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  throw new Error(`Unsupported preview file kind: ${fileName}`);
}
function assertPreviewShape(preview: unknown, expectedNames: readonly string[], sessionId: string): string {
  if (!record(preview) || typeof preview.id !== "string" || !UUID_RE.test(preview.id) || !Array.isArray(preview.files)) throw new Error("Preview registration fixture response is invalid");
  const files = preview.files as unknown[];
  if (files.length !== expectedNames.length) throw new Error("Preview registration files length mismatch");
  for (let i = 0; i < expectedNames.length; i++) {
    const file = files[i];
    if (!record(file) || typeof file.id !== "string" || !UUID_RE.test(file.id) || typeof file.fileName !== "string" || typeof file.kind !== "string") throw new Error("Preview registration file entry is invalid");
    if (file.fileName !== expectedNames[i]) throw new Error("Preview registration file order or name mismatch");
    if (file.kind !== kindFor(expectedNames[i])) throw new Error("Preview registration file kind mismatch");
  }
  return preview.id;
}
function assertPreviewBody(body: unknown, sessionId: string, expectedNames: readonly string[], directory: string): string {
  for (const name of expectedNames) assertSanitized(body, join(directory, name));
  if (!record(body) || !record(body.session) || body.session.id !== sessionId) throw new Error("Preview registration fixture response is invalid");
  if (!record(body.session.preview)) throw new Error("Preview registration fixture response is invalid");
  return assertPreviewShape(body.session.preview, expectedNames, sessionId);
}

export async function createPreviewFixture() {
  assert.ok(["localhost", "127.0.0.1"].includes(new URL(UI_BASE_URL).hostname), "preview fixtures require the local test UI");
  assert.equal(resolve(BRIDGE_HOME), resolve(E2E_DIR, ".bridge-home"));
  const home = await lstat(BRIDGE_HOME);
  assert.ok(home.isDirectory() && !home.isSymbolicLink());
  const db = new URL(process.env.DATABASE_URL ?? "");
  assert.ok(["postgres:", "postgresql:"].includes(db.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(db.hostname));
  assert.equal(db.port || "5432", "5432"); assert.equal(db.pathname, "/ftown"); assert.equal(db.username, "ftown");
  assert.equal(db.search, ""); assert.equal(db.hash, "");
  const owned = await mkdtemp(join(BRIDGE_HOME, "preview-acceptance-"));
  const directory = join(owned, "session");
  const outside = join(owned, "outside");
  await mkdir(directory); await mkdir(outside);
  const sessions = new Set<string>();
  return {
    directory, outside,
    async create(name: string, options?: { shellType: "codex"; command: string }): Promise<string> {
      const response = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: options?.shellType ?? "shell", ...(options ? { command: options.command } : {}), name, workingDir: directory } });
      expect(response.status).toBe(201);
      if (!record(response.body) || !record(response.body.session) || typeof response.body.session.id !== "string") throw new Error("Created session fixture missing id");
      sessions.add(response.body.session.id);
      return response.body.session.id;
    },
    async cli(sessionId: string, args: string[]): Promise<CliOutput> {
      try {
        const result = await execute(process.execPath, [join(E2E_DIR, "..", "bridge/dist/ftown-cli.js"), "sessions", ...args], {
          cwd: directory, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
          env: { ...process.env, HOME: BRIDGE_HOME, USERPROFILE: BRIDGE_HOME, FTOWN_SESSION_ID: sessionId },
        });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        if (!record(error) || typeof error.code !== "number") throw new Error("Session CLI fixture failed to execute");
        return { code: error.code, stdout: typeof error.stdout === "string" ? error.stdout : "", stderr: typeof error.stderr === "string" ? error.stderr : "" };
      }
    },
    async register(sessionId: string, fileName: string): Promise<string> {
      const result = await this.cli(sessionId, ["preview", fileName]);
      expect(result.code).toBe(0);
      const body: unknown = JSON.parse(result.stdout);
      return assertPreviewBody(body, sessionId, [fileName], directory);
    },
    async registerMultiple(sessionId: string, fileNames: string[]): Promise<string> {
      if (fileNames.length < 1) throw new Error("registerMultiple requires at least one file");
      const result = await this.cli(sessionId, ["preview", ...fileNames]);
      expect(result.code).toBe(0);
      const body: unknown = JSON.parse(result.stdout);
      return assertPreviewBody(body, sessionId, fileNames, directory);
    },
    async cleanup(): Promise<void> {
      const results = await Promise.allSettled([...sessions].map(async (id) => {
        const response = await bridgeApiFetch("DELETE", `/api/sessions/${id}`);
        if (response.status !== 200 && response.status !== 404) throw new Error("Owned preview session cleanup failed");
      }));
      await rm(owned, { recursive: true, force: true });
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Preview fixture cleanup failed");
    },
  };
}

export async function atomicHtml(path: string, html: string): Promise<void> {
  const next = `${path}.next`;
  await writeFile(next, html, "utf8");
  await rename(next, path);
}

export function assertSanitized(value: unknown, fullFilePath: string): void {
  const wire = JSON.stringify(value);
  expect(wire.includes('"previewSource"')).toBe(false);
  expect(wire.includes(fullFilePath)).toBe(false);
}

export function sessionRecord(value: unknown): Record<string, unknown> {
  if (!record(value) || !record(value.session)) throw new Error("Expected a session response");
  return value.session;
}

export function previewHtml(marker: string, version: number, chunked = false): string {
  const probe = `${UI_BASE_URL}/__e2e-preview-probe/`;
  const prefix = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src * data: 'unsafe-inline'"><base href="${probe}"><style>body{background:#fff;color:#111;font:16px system-ui;margin:16px}button{min-height:44px;padding:10px}#unicode{max-height:32px;overflow:hidden}</style></head><body><h1>${marker} version ${version}</h1><button id="counter">Count: 0</button><img id="data-image" alt="Inline data image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='green'/%3E%3C/svg%3E"><p id="security" data-parent="pending" data-storage="pending" data-fetch="pending"></p><nav><a id="external-link" href="https://preview.example.test/target?fixture=1" target="_top">External target</a> <a id="long-link" href="https://preview.example.test/${'a'.repeat(1800)}">Long target</a> <a id="relative-link" href="/__e2e-preview-probe/relative">Relative target</a> <a id="javascript-link" href="javascript:document.body.dataset.previewJavascript=1">JavaScript target</a> <a id="data-link" href="data:text/html,unexpected">Data target</a> <a id="file-link" href="file:///tmp/preview-forbidden">File target</a> <a id="hash-link" href="#inside" target="_top">Jump inside</a></nav><span id="inside">Inside</span><p id="unicode">`;
  const text = chunked ? "x".repeat(98_303 - Buffer.byteLength(prefix)) + "😀 boundary ✓" : "Inline preview ✓";
  return prefix + text + `</p><img alt="Blocked network image" src="${probe}image"><script src="${probe}script"></script><script>
let count=0;document.getElementById('counter').onclick=()=>{document.getElementById('counter').textContent='Count: '+(++count)};
const dynamic=document.createElement('a');dynamic.id='dynamic-link';dynamic.href='https://preview.example.test/dynamic';dynamic.textContent='Dynamic target';document.body.appendChild(dynamic);
const report=document.getElementById('security');
try{parent.document.body.dataset.previewEscaped='yes';report.dataset.parent='allowed'}catch{report.dataset.parent='blocked'}
try{localStorage.setItem('preview-fixture','yes');report.dataset.storage='allowed'}catch{report.dataset.storage='blocked'}
document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove();
fetch('${probe}fetch').then(()=>{report.dataset.fetch='allowed'},()=>{report.dataset.fetch='blocked'});
</script></body></html>`;
}

export function previewMarkdown(marker: string): string {
  return `# ${marker} Notes\n\n| Name | Value |\n| --- | --- |\n| alpha | ${marker}-cell |\n\n[View a.html](a.html)\n`;
}

export function previewSimpleHtml(marker: string, version: number): string {
  return `<!doctype html><html><head><title>${marker} v${version}</title></head><body><h1>${marker} version ${version}</h1><p>Simple HTML</p></body></html>`;
}

/** Passive crypto observation keeps real authentication and every native result intact. */
export async function observePreviewTransport(page: Page, localPort: number): Promise<PreviewTransportObservation> {
  const observation: PreviewTransportObservation = { reads: [], encryptedCloudPublications: 0, encryptedLocalRequests: 0, leaked: false, markers: new Set() };
  const inspect = (text: string) => { if ([...observation.markers].some((marker) => text.includes(marker))) observation.leaked = true; };
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/connection/websocket")) return;
    socket.on("framereceived", (frame) => {
      const text = typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8");
      inspect(text);
      if (text.includes('"ftown_encrypted"')) observation.encryptedCloudPublications++;
    });
    socket.on("framesent", (frame) => inspect(typeof frame.payload === "string" ? frame.payload : frame.payload.toString("utf8")));
  });
  page.on("request", (request) => {
    if (request.url() !== `http://127.0.0.1:${localPort}/api/security/envelope` || request.method() !== "POST") return;
    const text = request.postData() ?? ""; inspect(text);
    try { const value: unknown = JSON.parse(text); if (record(value) && value.type === "ftown_encrypted" && value.purpose === "application") observation.encryptedLocalRequests++; }
    catch { /* The UI's normal error path remains responsible for malformed transport. */ }
  });
  await page.exposeFunction("__recordSessionPreviewRead", (entry: PreviewReadObservation) => {
    if (observation.reads.length < 500) observation.reads.push(entry);
  });
  await page.addInitScript(() => {
    const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    Object.defineProperty(crypto.subtle, "decrypt", { configurable: true, value: async (...args: Parameters<SubtleCrypto["decrypt"]>) => {
      const result = await decrypt(...args);
      try {
        const algorithm = args[0];
        if (typeof algorithm === "string" || algorithm.name !== "AES-GCM") return result;
        const header: unknown = JSON.parse(new TextDecoder().decode((algorithm as AesGcmParams).additionalData));
        if (!Array.isArray(header) || header[0] !== "ftown/e2ee/v1" || typeof header[7] !== "string") return result;
        const app: unknown = JSON.parse(new TextDecoder().decode(result));
        if (!object(app) || !object(app.data) || !object(app.data.response) || !object(app.data.response.data)) return result;
        const value = app.data.response.data;
        if (typeof value.state !== "string" || typeof value.previewId !== "string") return result;
        const binding = globalThis as typeof globalThis & { __recordSessionPreviewRead: (entry: { state: string; previewId: string; transport: "local" | "cloud"; offset?: number }) => Promise<void> };
        await binding.__recordSessionPreviewRead({ state: value.state, previewId: value.previewId,
          transport: header[7].startsWith("local-http:") ? "local" : "cloud", ...(typeof value.offset === "number" ? { offset: value.offset } : {}) });
      } catch { /* Observing cannot alter successful native decryption. */ }
      return result;
    } });
  });
  return observation;
}
