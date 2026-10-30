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

export interface CliOutput { code: number; stdout: string; stderr: string }
export interface PreviewReadObservation { state: string; previewId: string; transport: "cloud" | "local"; offset?: number }
export interface PreviewTransportObservation {
  reads: PreviewReadObservation[];
  encryptedCloudPublications: number;
  encryptedLocalRequests: number;
  leaked: boolean;
  markers: Set<string>;
}

export async function createPreviewFixture() {
  assert.equal(UI_BASE_URL, "http://localhost:3000");
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
    async create(name: string): Promise<string> {
      const response = await bridgeApiFetch("POST", "/api/sessions", { body: { shellType: "shell", name, workingDir: directory } });
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
      assertSanitized(body, join(directory, fileName));
      if (!record(body) || !record(body.session) || body.session.id !== sessionId || !record(body.session.preview)
        || typeof body.session.preview.id !== "string" || body.session.preview.fileName !== fileName) throw new Error("Preview registration fixture response is invalid");
      return body.session.preview.id;
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
  const prefix = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src * data: 'unsafe-inline'"><base href="${probe}"><style>body{background:#fff;color:#111;font:16px system-ui;margin:16px}button{min-height:44px;padding:10px}#unicode{max-height:32px;overflow:hidden}</style></head><body><h1>${marker} version ${version}</h1><button id="counter">Count: 0</button><img id="data-image" alt="Inline data image" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='2' height='2'%3E%3Crect width='2' height='2' fill='green'/%3E%3C/svg%3E"><p id="security" data-parent="pending" data-storage="pending" data-fetch="pending"></p><p id="unicode">`;
  const text = chunked ? "x".repeat(98_303 - Buffer.byteLength(prefix)) + "😀 boundary ✓" : "Inline preview ✓";
  return prefix + text + `</p><img alt="Blocked network image" src="${probe}image"><script src="${probe}script"></script><script>
let count=0;document.getElementById('counter').onclick=()=>{document.getElementById('counter').textContent='Count: '+(++count)};
const report=document.getElementById('security');
try{parent.document.body.dataset.previewEscaped='yes';report.dataset.parent='allowed'}catch{report.dataset.parent='blocked'}
try{localStorage.setItem('preview-fixture','yes');report.dataset.storage='allowed'}catch{report.dataset.storage='blocked'}
document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.remove();
fetch('${probe}fetch').then(()=>{report.dataset.fetch='allowed'},()=>{report.dataset.fetch='blocked'});
</script></body></html>`;
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
