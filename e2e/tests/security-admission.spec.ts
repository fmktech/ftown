import { test, expect, request as apiRequest, type APIRequestContext } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { makeUser, registerUser } from "../helpers/app";
import { UI_BASE_URL } from "../helpers/config";

const BODY_LIMIT = 16_384;
const BRIDGE_ROUTES = ["/api/auth/bridge", "/api/auth/bridge/refresh"] as const;

function source(): string {
  return `2001:db8:${randomBytes(12).toString("hex").match(/.{4}/g)!.join(":")}`;
}

async function client(ip = source()): Promise<APIRequestContext> {
  return apiRequest.newContext({
    baseURL: UI_BASE_URL,
    extraHTTPHeaders: { "x-real-ip": ip, Origin: UI_BASE_URL },
  });
}

async function signIn(context: APIRequestContext, email: string, password: string): Promise<URL> {
  const csrfResponse = await context.get("/api/auth/csrf");
  expect(csrfResponse.status()).toBe(200);
  const csrf = await csrfResponse.json() as { csrfToken?: unknown };
  expect(typeof csrf.csrfToken).toBe("string");
  if (typeof csrf.csrfToken !== "string") throw new Error("CSRF fixture token missing");
  const response = await context.post("/api/auth/callback/credentials", {
    headers: { "X-Auth-Return-Redirect": "1" },
    form: { csrfToken: csrf.csrfToken, email, password, callbackUrl: `${UI_BASE_URL}/dashboard` },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(200);
  const result = await response.json() as { url?: unknown };
  expect(typeof result.url).toBe("string");
  if (typeof result.url !== "string") throw new Error("Auth callback redirect missing");
  const redirect = new URL(result.url);
  expect(redirect.origin).toBe(UI_BASE_URL);
  return redirect;
}

/** Native HTTP ensures streaming cases really omit Content-Length. */
function rawPost(path: string, body: string, options: { chunked?: boolean; cookie?: string; ip?: string; contentType?: string } = {}): Promise<number> {
  const bytes = Buffer.from(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, UI_BASE_URL), {
      method: "POST",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": options.contentType ?? "application/json",
        "x-real-ip": options.ip ?? source(),
        ...(options.cookie ? { Cookie: options.cookie } : {}),
        ...(!options.chunked ? { "Content-Length": String(bytes.length) } : {}),
      },
    }, (response) => {
      response.on("error", reject);
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    });
    request.on("error", reject);
    if (options.chunked) {
      for (let offset = 0; offset < bytes.length; offset += 1024) request.write(bytes.subarray(offset, offset + 1024));
      request.end();
    } else request.end(bytes);
  });
}

function sizedCredentialBody(path: typeof BRIDGE_ROUTES[number], byteLength: number): string {
  const credential = path.endsWith("/refresh") ? "refreshToken" : "token";
  const fields = { [credential]: "", bridgeId: "e2e-size-boundary", hostname: "e2e-security" };
  const remaining = byteLength - Buffer.byteLength(JSON.stringify(fields));
  if (remaining < 1) throw new Error("Body boundary fixture is too small");
  fields[credential] = "é".repeat(Math.floor(remaining / 2)) + "x".repeat(remaining % 2);
  const body = JSON.stringify(fields);
  expect(Buffer.byteLength(body)).toBe(byteLength);
  return body;
}

test.beforeAll(() => {
  expect(UI_BASE_URL).toBe("http://localhost:3000");
  const database = new URL(process.env.DATABASE_URL ?? "");
  expect(["postgres:", "postgresql:"]).toContain(database.protocol);
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(database.hostname);
  expect(database.port || "5432").toBe("5432");
  expect(database.pathname).toBe("/ftown");
  expect(database.username).toBe("ftown");
  expect(database.search).toBe("");
  expect(database.hash).toBe("");
  expect(process.env.REGISTRATION_ENABLED).toBe("true");
});

for (const path of BRIDGE_ROUTES) {
  test(`${path} enforces its byte boundary before inspecting credentials`, async () => {
    for (const chunked of [false, true]) {
      expect(await rawPost(path, sizedCredentialBody(path, BODY_LIMIT), { chunked })).toBe(401);
      expect(await rawPost(path, sizedCredentialBody(path, BODY_LIMIT + 1), { chunked })).toBe(413);
    }
  });

  test(`${path} rejects malformed and non-object JSON as client errors`, async () => {
    for (const body of ["", "{", "null", "[]", '"text"']) {
      expect(await rawPost(path, body)).toBe(400);
    }
    expect(await rawPost(path, "{}", { contentType: "text/plain" })).toBe(400);
  });
}

test("anonymous device revocation remains auth-first even for oversized bodies", async () => {
  expect(await rawPost("/api/bridges/devices/revoke", "x".repeat(BODY_LIMIT + 1))).toBe(401);
});

test("authenticated revocation and registration retain explicit body caps", async () => {
  const user = makeUser("e2e-security-body");
  await registerUser(user.email, user.password);
  const context = await client();
  try {
    expect((await signIn(context, user.email, user.password)).searchParams.has("error")).toBe(false);
    const state = await context.storageState();
    const cookie = state.cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
    for (const chunked of [false, true]) {
      expect(await rawPost("/api/bridges/devices/revoke", "x".repeat(BODY_LIMIT + 1), { chunked, cookie })).toBe(413);
      expect(await rawPost("/api/auth/register", "x".repeat(BODY_LIMIT + 1), { chunked })).toBe(413);
    }
    for (const body of ["", "null", "[]"]) {
      expect(await rawPost("/api/bridges/devices/revoke", body, { cookie })).toBe(400);
      expect(await rawPost("/api/auth/register", body)).toBe(400);
    }
  } finally {
    await context.dispose();
  }
});

test("concurrent malformed registrations admit exactly ten requests from one source", async () => {
  const ip = source();
  const responses = await Promise.all(Array.from({ length: 24 }, async () => {
    const context = await client(ip);
    try {
      return (await context.post("/api/auth/register", { headers: { "Content-Type": "application/json" }, data: "{" })).status();
    } finally {
      await context.dispose();
    }
  }));
  expect(responses.filter((status) => status === 400)).toHaveLength(10);
  expect(responses.filter((status) => status === 429)).toHaveLength(14);
  const context = await client(ip);
  try {
    expect((await context.post("/api/auth/register", { data: { email: makeUser("e2e-denied").email, password: "e2e-password-123" } })).status()).toBe(429);
  } finally {
    await context.dispose();
  }
});

test("attacker failures cannot hard-lock a victim signing in from another source", async () => {
  const user = makeUser("e2e-security-victim");
  await registerUser(user.email, user.password);
  const attacker = await client();
  const victim = await client();
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      expect((await signIn(attacker, user.email, "e2e-wrong-password")).searchParams.has("error")).toBe(true);
    }
    const destination = await signIn(victim, user.email, user.password);
    expect(destination.searchParams.has("error")).toBe(false);
    expect(destination.pathname).toBe("/dashboard");
    const session = await (await victim.get("/api/auth/session")).json() as { user?: { email?: string } };
    expect(session.user?.email).toBe(user.email);
  } finally {
    await attacker.dispose();
    await victim.dispose();
  }
});

test("successful login consumes its source slot and cannot refund a full budget", async () => {
  const user = makeUser("e2e-security-success");
  await registerUser(user.email, user.password);
  const context = await client();
  try {
    for (let attempt = 0; attempt < 29; attempt++) {
      expect((await signIn(context, user.email, "e2e-wrong-password")).searchParams.has("error")).toBe(true);
    }
    expect((await signIn(context, user.email, user.password)).searchParams.has("error")).toBe(false);
    expect((await signIn(context, user.email, user.password)).searchParams.has("error")).toBe(true);
  } finally {
    await context.dispose();
  }
});
