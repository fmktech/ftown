// ROOT EXECUTION ONLY, after start-services.sh. Uses the existing task-owned TLS
// gateway; never starts a service or sends requests outside canonical localhost.
// From the repository root: node e2e/scripts/mcp-body-parser-smoke.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
assert.equal(process.env.FTOWN_MCP_PUBLIC_URL, "https://localhost:8443");
assert.equal(process.env.FTOWN_PUBLIC_URL, "https://localhost:8444");
if (process.env.E2E_DIR !== undefined) assert.equal(resolve(process.env.E2E_DIR), resolve(repo, "e2e"));
const origin = "https://localhost:8443";
const ca = readFileSync(resolve(repo, "e2e/certs/cert.pem"));
interface Response { status: number; body: string }

function send(path: string, encoding?: string, frame?: Buffer, trailing?: Buffer): Promise<Response | { transportError: string }> {
  return new Promise((resolveResponse, reject) => {
    let sent = false;
    let result: Response | { transportError: string } | undefined;
    const finish = () => { if (sent && result) resolveResponse(result); };
    const fail = (error: Error & { code?: string }) => {
      if (trailing && ["ECONNRESET", "EPIPE"].includes(error.code ?? "")) {
        result = { transportError: error.code! }; finish();
      } else reject(error);
    };
    const outgoing = request(new URL(path, origin), {
      method: frame ? "POST" : "GET", ca, signal: AbortSignal.timeout(15_000),
      headers: { "X-Forwarded-Proto": "https", ...(encoding ? { "Content-Type": "application/json", "Content-Encoding": encoding } : {}) },
    }, (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("error", fail);
      incoming.on("end", () => {
        result = { status: incoming.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") };
        finish();
      });
    });
    outgoing.on("error", fail);
    if (frame && trailing) {
      // A completed compressed frame precedes a later HTTP chunk. This is an
      // application regression derived from GHSA-27r3-jxmh-p828, not a claimed
      // byte-for-byte upstream reproducer. Do not resolve before trailing bytes
      // are sent, even if the app has already replied to the valid frame.
      outgoing.write(frame, () => {
        setTimeout(() => { outgoing.end(trailing); sent = true; finish(); }, 25);
      });
    } else {
      outgoing.end(frame); sent = true; finish();
    }
  });
}

async function healthy(): Promise<void> {
  const response = await send("/healthz");
  assert.ok("status" in response);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true });
}

const body = Buffer.from(JSON.stringify({ assertion: "e2e-invalid-assertion" }));
await healthy();
for (const [encoding, compress] of [
  ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
] as const) {
  const frame = compress(body);
  const valid = await send("/consent/details", encoding, frame);
  assert.ok("status" in valid);
  assert.equal(valid.status, 400);
  // This semantic response proves the real JSON parser delivered assertion to
  // the consent handler; an unauthenticated /mcp request would stop before it.
  assert.deepEqual(JSON.parse(valid.body), { error: "Invalid or expired consent request" });
  for (const trailing of [Buffer.from("trailing-garbage"), Buffer.from([0x00, 0xff, 0x00, 0xff])]) {
    const malformed = await send("/consent/details", encoding, frame, trailing);
    if ("status" in malformed) assert.equal(malformed.status, 400);
    // The advisory concerns process disruption. A parser rejection or closed
    // request is acceptable only while a subsequent real health request works.
    await healthy();
  }
}
console.log("PASS: real MCP consent parser accepts compressed JSON, rejects invalid consent, and survives delayed trailing gzip/deflate/br bytes.");
