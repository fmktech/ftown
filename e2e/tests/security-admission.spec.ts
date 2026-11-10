import { expect, request as apiRequest } from "@playwright/test";
import { randomBytes, webcrypto } from "node:crypto";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { request as plainRequest } from "node:http";
import { request as tlsRequest } from "node:https";
import { test } from "../helpers/fixtures";
import { login } from "../helpers/app";
import { E2E_DIR, UI_BASE_URL } from "../helpers/config";
import { BOOTSTRAP_SECRET, readRunAccount, RP_ID } from "../helpers/passkey";
import { ledgerLib, proofLib, serverLedger, signProof } from "../helpers/ledger-admin";

/**
 * Admission surface of the unauthenticated routes: body caps, malformed input,
 * closed registration, nonce/proof abuse and per-source rate limits. Every test
 * owns a fresh synthetic x-real-ip (trusted in this test deployment) so its
 * rate-limit budget is its own and never starves other specs.
 */

const LEDGER_BODY_MAX = 2_621_440; // ui/src/lib/ledger-limits.ts
const PAIR_BODY_MAX = 300 * 1024; // ui/src/app/api/pair/[requestId]/route.ts
const ABSENT_ID = () => randomBytes(32).toString("base64url"); // 43 chars

function source(): string {
  return `2001:db8:ad:${randomBytes(10).toString("hex").match(/.{4}/g)!.join(":")}`;
}

/** Native HTTP so chunked cases really omit Content-Length. */
function raw(method: string, path: string, body: string | Buffer, options: { chunked?: boolean; ip?: string; contentType?: string } = {}): Promise<number> {
  const bytes = Buffer.from(body);
  return new Promise((resolve, reject) => {
    // The run origin is http://localhost locally and https://localhost:8444 (fixture certificate, NODE_EXTRA_CA_CERTS) in CI.
    const httpRequest = new URL(UI_BASE_URL).protocol === "https:" ? tlsRequest : plainRequest;
    const request = httpRequest(new URL(path, UI_BASE_URL), {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: {
        "Content-Type": options.contentType ?? "application/json",
        "x-real-ip": options.ip ?? source(),
        ...(!options.chunked ? { "Content-Length": String(bytes.length) } : {}),
      },
    }, (response) => {
      answered = response.statusCode ?? 0;
      response.on("error", () => resolve(answered ?? 0));
      response.resume();
      response.on("end", () => resolve(answered ?? 0));
    });
    // A server that answers early (e.g. 413 before reading the whole body) may close the connection while the
    // body is still being sent; through the TLS terminator that surfaces as EPIPE/ECONNRESET after the answer.
    let answered: number | null = null;
    request.on("error", error => { if (answered !== null) resolve(answered); else reject(error); });
    if (options.chunked) {
      for (let offset = 0; offset < bytes.length; offset += 65_536) request.write(bytes.subarray(offset, offset + 65_536));
      request.end();
    } else request.end(bytes);
  });
}

async function call(method: string, path: string, ip: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  const context = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": ip } });
  try {
    const response = await context.fetch(path, { method, ...(body === undefined ? {} : { data: body }) });
    let parsed: Record<string, unknown> = {};
    try { parsed = await response.json() as Record<string, unknown>; } catch { /* empty */ }
    return { status: response.status(), body: parsed, headers: response.headers() };
  } finally { await context.dispose(); }
}

/** JSON body of exactly `bytes` bytes. */
function sized(bytes: number): string {
  const prefix = '{"ledger":"';
  const suffix = '"}';
  return prefix + "x".repeat(bytes - prefix.length - suffix.length) + suffix;
}

test.describe("POST /api/account/ledger admission", () => {
  test("enforces the 2.5 MB body cap on declared and streamed bodies", async () => {
    const ip = source();
    for (const chunked of [false, true]) {
      expect(await raw("POST", "/api/account/ledger", sized(LEDGER_BODY_MAX), { chunked, ip })).not.toBe(413);
      expect(await raw("POST", "/api/account/ledger", sized(LEDGER_BODY_MAX + 1), { chunked, ip })).toBe(413);
    }
  });

  test("rejects malformed and non-object JSON as client errors", async () => {
    const ip = source();
    for (const body of ["", "{", "null", "[]", '"text"', "{}", '{"unrelated":1}']) {
      expect(await raw("POST", "/api/account/ledger", body, { ip }), `body ${JSON.stringify(body)}`).toBe(400);
    }
    expect(await raw("POST", "/api/account/ledger", '{"ledger":{}}', { ip, contentType: "text/plain" })).toBe(400);
    expect(await raw("POST", "/api/account/ledger", JSON.stringify({ ledger: {}, bootstrap: 5 }), { ip })).toBe(400);
    expect(await raw("POST", "/api/account/ledger", JSON.stringify({ ledger: {}, bootstrap: "b".repeat(257) }), { ip })).toBe(400);
  });

  test("an unparseable ledger is refused and leaves the account ledger untouched", async () => {
    const ip = source();
    const before = (await serverLedger()).checkpoint.head;
    for (const ledger of ["x", 7, {}, { genesis: null, transitions: [] }]) {
      const result = await call("POST", "/api/account/ledger", ip, { ledger });
      expect([403, 409], JSON.stringify(ledger)).toContain(result.status);
      expect(result.body.decision).toBeUndefined();
    }
    expect((await serverLedger()).checkpoint.head).toBe(before);
  });

  test("account creation is closed: a fresh, validly signed genesis is refused even with the bootstrap secret", async () => {
    const ip = source();
    const account = readRunAccount();
    const origin = new URL(account.origin).origin;
    const before = await serverLedger();
    const [{ createSoftPasskey }, lib] = await Promise.all([
      import(pathToFileURL(join(E2E_DIR, "..", "bridge", "dist", "security", "ledger", "testing.js")).href) as Promise<typeof import("../../bridge/src/security/ledger/testing")>,
      ledgerLib(),
    ]);
    const passkey = await createSoftPasskey({ rpId: RP_ID, origin });
    const payload = {
      type: "ftown_account_genesis" as const, version: 2 as const, rpId: RP_ID, origins: [origin],
      handle: randomBytes(32).toString("base64url"), createdAt: Date.now(),
      authority: { credentialId: passkey.credentialId, publicKey: passkey.publicKey, label: "e2e-intruder", addedAt: Date.now() },
    };
    const ledger = { genesis: { payload, signature: await passkey.sign(await lib.ledgerChallenge(payload)) }, transitions: [] };
    // The genesis is well formed: it verifies with the shared verifier.
    expect((await lib.verifyLedger(ledger)).accountId).not.toBe(account.accountId);
    for (const body of [{ ledger }, { ledger, bootstrap: BOOTSTRAP_SECRET }]) {
      const result = await call("POST", "/api/account/ledger", ip, body);
      expect(result.status).toBe(403);
      expect(result.body.error).toBe("registration_closed");
    }
    const intruderId = await lib.accountIdOf(payload);
    expect((await call("GET", `/api/account/ledger?accountId=${intruderId}`, ip)).status).toBe(404);
    expect((await serverLedger()).checkpoint.head).toBe(before.checkpoint.head);
  });

  test("write budget is 30/min per source and answers 429 with Retry-After", async () => {
    const ip = source();
    const statuses: number[] = [];
    for (let index = 0; index < 30; index += 1) statuses.push((await call("POST", "/api/account/ledger", ip, {})).status);
    expect(statuses.every(status => status === 400)).toBe(true);
    const limited = await call("POST", "/api/account/ledger", ip, {});
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    // another source is unaffected
    expect((await call("POST", "/api/account/ledger", source(), {})).status).toBe(400);
  });
});

test.describe("GET /api/account/ledger admission", () => {
  test("requires exactly one well-formed query parameter", async () => {
    const ip = source();
    const id = ABSENT_ID();
    expect((await call("GET", "/api/account/ledger", ip)).status).toBe(400);
    expect((await call("GET", `/api/account/ledger?accountId=${id}&handle=${id}`, ip)).status).toBe(400);
    expect((await call("GET", `/api/account/ledger?accountId=${id.slice(1)}`, ip)).status).toBe(400);
    expect((await call("GET", `/api/account/ledger?handle=${id}x`, ip)).status).toBe(400);
    expect((await call("GET", `/api/account/ledger?accountId=${"!".repeat(43)}`, ip)).status).toBe(400);
  });

  test("an unknown well-formed id or handle is 404 and the known account is readable", async () => {
    const ip = source();
    expect((await call("GET", `/api/account/ledger?accountId=${ABSENT_ID()}`, ip)).status).toBe(404);
    expect((await call("GET", `/api/account/ledger?handle=${ABSENT_ID()}`, ip)).status).toBe(404);
    const known = await call("GET", `/api/account/ledger?accountId=${readRunAccount().accountId}`, ip);
    expect(known.status).toBe(200);
    expect(known.headers["cache-control"]).toContain("no-store");
  });

  test("read budget is 120/min per source (scope ledger-read)", async () => {
    const ip = source();
    const context = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": ip } });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 120; index += 1) statuses.push((await context.get(`/api/account/ledger?accountId=${ABSENT_ID()}`)).status());
      expect(statuses.every(status => status === 404)).toBe(true);
      const limited = await context.get(`/api/account/ledger?accountId=${ABSENT_ID()}`);
      expect(limited.status()).toBe(429);
      expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
      // malformed requests are rejected before the limiter and do not consume budget
      expect((await context.get("/api/account/ledger")).status()).toBe(400);
    } finally { await context.dispose(); }
    expect((await call("GET", `/api/account/ledger?accountId=${ABSENT_ID()}`, source())).status).toBe(404);
  });
});

test.describe("POST /api/auth/nonce admission", () => {
  test("only the session and relay purposes are issued a nonce", async () => {
    const ip = source();
    for (const body of [{}, { purpose: "bridge" }, { purpose: 7 }, null, [], "session"]) {
      expect((await call("POST", "/api/auth/nonce", ip, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await raw("POST", "/api/auth/nonce", "{", { ip })).toBe(400);
    for (const purpose of ["session", "relay"]) {
      const issued = await call("POST", "/api/auth/nonce", ip, { purpose });
      expect(issued.status).toBe(200);
      expect(typeof issued.body.nonce).toBe("string");
    }
  });

  test("bodies above 256 bytes are refused", async () => {
    const ip = source();
    const padded = JSON.stringify({ purpose: "session", pad: "x".repeat(300) });
    expect(Buffer.byteLength(padded)).toBeGreaterThan(256);
    expect(await raw("POST", "/api/auth/nonce", padded, { ip })).toBe(400);
    expect(await raw("POST", "/api/auth/nonce", padded, { ip, chunked: true })).toBe(400);
  });

  test("nonce budget is 120/min per source", async () => {
    const ip = source();
    const context = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": ip } });
    try {
      for (let index = 0; index < 120; index += 1) {
        expect((await context.post("/api/auth/nonce", { data: { purpose: "session" } })).status()).toBe(200);
      }
      const limited = await context.post("/api/auth/nonce", { data: { purpose: "session" } });
      expect(limited.status()).toBe(429);
      expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
    } finally { await context.dispose(); }
  });
});

test.describe("POST /api/auth/relay-token admission", () => {
  const accountId = () => readRunAccount().accountId;

  /** A proof by a freshly generated key that no ledger lists. */
  async function strangerProof(overrides: { accountId?: string; purpose?: "relay" | "session"; audience?: string; kind?: "device" | "bridge" } = {}) {
    const keys = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return signProof(keys.privateKey, {
      accountId: overrides.accountId ?? accountId(),
      kind: overrides.kind ?? "device",
      keyId: randomBytes(32).toString("base64url"),
      purpose: overrides.purpose ?? "relay",
      ...(overrides.audience ? { audience: overrides.audience } : {}),
    });
  }

  test("malformed bodies and proofs are refused without a token", async () => {
    const ip = source();
    for (const body of ["", "{", "null", "[]", '"x"']) {
      expect(await raw("POST", "/api/auth/relay-token", body, { ip }), JSON.stringify(body)).toBe(400);
    }
    expect(await raw("POST", "/api/auth/relay-token", "{}", { ip, contentType: "text/plain" })).toBe(400);
    expect((await call("POST", "/api/auth/relay-token", ip, { proof: {}, head: 5 })).status).toBe(400);
    for (const proof of [undefined, null, "proof", {}, { accountId: "a" }]) {
      const result = await call("POST", "/api/auth/relay-token", ip, { proof, head: null });
      expect(result.status, JSON.stringify(proof)).toBe(401);
      expect(result.body.token).toBeUndefined();
    }
  });

  test("enforces the 16 KiB body cap on declared and streamed bodies", async () => {
    const ip = source();
    const overhead = Buffer.byteLength(JSON.stringify({ proof: "", head: null }));
    const body = (bytes: number) => JSON.stringify({ proof: "x".repeat(bytes - overhead), head: null });
    for (const chunked of [false, true]) {
      expect(await raw("POST", "/api/auth/relay-token", body(16_384), { ip, chunked })).toBe(401);
      expect(await raw("POST", "/api/auth/relay-token", body(16_385), { ip, chunked })).toBe(413);
    }
  });

  test("a proof by a key that is in no ledger is refused with nothing but 401", async () => {
    const ip = source();
    const proof = await strangerProof();
    const first = await call("POST", "/api/auth/relay-token", ip, { proof, head: null });
    expect(first.status).toBe(401);
    expect(first.body).toEqual({ error: "unauthorized" }); // no ledger, no token
    const unknownAccount = await call("POST", "/api/auth/relay-token", ip, { proof: await strangerProof({ accountId: ABSENT_ID() }), head: null });
    expect(unknownAccount.status).toBe(401);
    expect(unknownAccount.body).toEqual({ error: "unauthorized" });
  });

  test("a nonce is single-use: replaying the same proof is refused", async () => {
    const ip = source();
    const proof = await strangerProof({ kind: "bridge" });
    expect((await call("POST", "/api/auth/relay-token", ip, { proof, head: null })).status).toBe(401);
    const replay = await call("POST", "/api/auth/relay-token", ip, { proof, head: null });
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: "unauthorized" });
  });

  test("a session-purpose proof or a proof for another audience cannot mint a relay token", async () => {
    const ip = source();
    expect((await call("POST", "/api/auth/relay-token", ip, { proof: await strangerProof({ purpose: "session" }), head: null })).status).toBe(401);
    expect((await call("POST", "/api/auth/relay-token", ip, { proof: await strangerProof({ audience: "https://evil.example" }), head: null })).status).toBe(401);
    const lib = await proofLib();
    expect(typeof lib.signAuthProof).toBe("function");
  });

  test("per-source budget is 120/min and answers 429 with Retry-After", async () => {
    const ip = source();
    const context = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": ip } });
    try {
      for (let index = 0; index < 120; index += 1) {
        expect((await context.post("/api/auth/relay-token", { data: { proof: null } })).status()).toBe(401);
      }
      const limited = await context.post("/api/auth/relay-token", { data: { proof: null } });
      expect(limited.status()).toBe(429);
      expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
    } finally { await context.dispose(); }
  });
});

test.describe("/api/pair/:requestId admission", () => {
  test("bad ids are 400 on read, before any storage or per-request work", async () => {
    const ip = source();
    for (const bad of ["short", ABSENT_ID().slice(1), `${ABSENT_ID()}x`, "!".repeat(43)]) {
      expect((await call("GET", `/api/pair/${encodeURIComponent(bad)}`, ip)).status, bad).toBe(400);
    }
  });

  test("an unknown request id is a pending 404 and a mailbox is never created by reading", async () => {
    const ip = source();
    const id = ABSENT_ID();
    for (let index = 0; index < 2; index += 1) {
      const result = await call("GET", `/api/pair/${id}`, ip);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ status: "pending" });
    }
  });

  test("writing without a session is 401, whatever the id or body", async () => {
    const ip = source();
    expect((await call("PUT", `/api/pair/${ABSENT_ID()}`, ip, { sealed: "AAAA" })).status).toBe(401);
    expect((await call("PUT", "/api/pair/bad", ip, { sealed: "AAAA" })).status).toBe(401);
    expect(await raw("PUT", `/api/pair/${ABSENT_ID()}`, Buffer.alloc(PAIR_BODY_MAX + 1, 120), { ip })).toBe(401);
    expect((await call("GET", `/api/pair/${ABSENT_ID()}`, ip)).status).toBe(404); // nothing was stored
  });

  test("read budget is 120/min per source", async () => {
    const ip = source();
    const context = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": ip } });
    try {
      for (let index = 0; index < 120; index += 1) expect((await context.get(`/api/pair/${ABSENT_ID()}`)).status()).toBe(404);
      const limited = await context.get(`/api/pair/${ABSENT_ID()}`);
      expect(limited.status()).toBe(429);
      expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
      expect((await context.get("/api/pair/short")).status()).toBe(400);
    } finally { await context.dispose(); }
  });

  test("a signed-in browser's writes validate id, shape and size", async ({ page }) => {
    await login(page, { browserLabel: "e2e-admission" });
    const ip = source();
    const put = (id: string, data: unknown, rawBody?: Buffer) => page.request.put(`/api/pair/${id}`, {
      headers: { "x-real-ip": ip, ...(rawBody ? { "content-type": "application/json" } : {}) },
      ...(rawBody ? { data: rawBody } : { data }),
    });
    expect((await put("short", { sealed: "AAAA" })).status()).toBe(400);
    expect((await put(ABSENT_ID(), { nope: true })).status()).toBe(400);
    expect((await put(ABSENT_ID(), { sealed: 7 })).status()).toBe(400);
    const big = Buffer.from(JSON.stringify({ sealed: "x".repeat(PAIR_BODY_MAX) }));
    expect((await put(ABSENT_ID(), undefined, big)).status()).toBe(413);
  });
});
