import { expect, request as apiRequest, type BrowserContext, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LedgerTransition, Signed } from "../../bridge/src/security/ledger/protocol";
import { signWithBrowserDeviceKey } from "../helpers/browser-proof";
import { withDb } from "../helpers/db";
import { test } from "../helpers/fixtures";
import { createShellSessionWhenAccepted, getCentrifugoToken, login, openSession, runMarkerInTerminal, sharedAccountId, waitForBridgeOnline } from "../helpers/app";
import { readBridgePointer } from "../helpers/bridge-api";
import { BRIDGE_HOME, E2E_DIR, UI_BASE_URL } from "../helpers/config";
import { sessionIdsFor, waitForNewSessionId } from "../helpers/centrifugo";
import { attemptPublish, attemptSubscribe, type CentrifugoAttempt } from "../helpers/centrifugo-raw";
import {
  browserDevice, channelsLib, importAuthKey, ledgerCredentialId, ledgerLib, passkeyAssertion, requestRelayToken, revokeDevices, serverLedger,
  serverNonce, signProof,
} from "../helpers/ledger-admin";
import { readSharedBridgeLog, tmuxSocket } from "../helpers/ledger-bridge";
import { startReadinessProbe } from "../helpers/readiness";
import {
  browserEndpointId, fillCreateAccountForm, readRunAccount, signIn, takeEnrolledBrowsers, virtualAuthenticator, type RunAccount,
} from "../helpers/passkey";
import { createSecondAccount, type SecondAccount } from "../helpers/second-account";

/**
 * Isolation between two REAL accounts on one multi-account server.
 *
 *   A = the suite's shared account (tests/account.setup.ts): its own browser context here, its shared bridge
 *       (e2e/.bridge-home) and a fresh shell session on it.
 *   B = a brand-new account created through /login in its OWN context, with its OWN virtual authenticator (passkey),
 *       its own first device, its own isolated paired bridge and its own shell session (helpers/second-account.ts).
 *
 * Every probe uses what B legitimately holds: B's session cookie, B's relay token from POST /api/auth/token, B's
 * browser device key (non-extractable, signed in B's page), B's bridge key and B's passkey. Nothing is hand-minted.
 *
 * Relay publish isolation is a known follow-up (PR B): Centrifugo's user-limited channels gate SUBSCRIBE, and
 * client publish is enabled, so the relay may ACCEPT B's publish into A's channels. Each publish test records what
 * the relay did (annotation "cross-account publish accepted by relay (PR B)") and asserts the property that must hold
 * either way: A's bridge executes nothing, A's terminal shows nothing from B, A's session list and attention state
 * are unchanged, and A's dashboard keeps working.
 */

const execute = promisify(execFile);
const ACCEPTED = "cross-account publish accepted by relay (PR B)";
const REFUSED = "cross-account publish refused by relay";
const SETTLE_MS = 4000;

interface AccountA {
  account: RunAccount;
  accountId: string;
  context: BrowserContext;
  page: Page;
  endpointId: string;
  sessionName: string;
  sid: string;
  /** The shared bridge hosting `sid` and its endpoint id. */
  hostBridgeId: string;
  hostBridgeEndpointId: string;
  /** Every bridge id / device endpoint id A's ledger ever listed (incl. revoked ones from other specs). */
  bridgeIds: string[];
  deviceIds: string[];
  /** A's dashboard computer count before B existed. */
  computers: number;
  token: string;
  frames: string[];
  pageErrors: string[];
}
interface AccountB {
  second: SecondAccount;
  sessionName: string;
  sid: string;
  bridgeId: string;
  token: string;
}

let a: AccountA;
let b: AccountB;
let second: SecondAccount | null = null;
let contextA: BrowserContext | null = null;
let enrolledA: string | null = null;

const hex = (bytes = 4) => randomBytes(bytes).toString("hex");
const b64url = (bytes: number) => randomBytes(bytes).toString("base64url");
function source(): string {
  return `2001:db8:150:${randomBytes(10).toString("hex").match(/.{4}/g)!.join(":")}`;
}
function jwtSub(token: string): unknown {
  return (JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub?: unknown }).sub;
}

/** The dashboard header's computer count once the relay is connected; -1 while unreadable (safe inside expect.poll). */
async function computerCount(page: Page): Promise<number> {
  try {
    if (!await page.getByRole("group", { name: "Cloud connected", exact: true }).isVisible()) return -1;
    const label = await page.getByRole("img", { name: /^\d+ bridges; \d+ encrypted connections ready$/ }).getAttribute("aria-label", { timeout: 2000 });
    const count = /^(\d+) bridges;/.exec(label ?? "")?.[1];
    return count === undefined ? -1 : Number(count);
  } catch { return -1; }
}

/** Visible text of the dashboard sidebar (session rows). */
async function sidebarText(page: Page): Promise<string> {
  return page.locator("#dashboard-sidebar").innerText();
}

/** The computers offered by the New Session modal (option values are bridge ids); closes the modal again. */
async function offeredComputers(page: Page): Promise<string[]> {
  await page.getByRole("button", { name: "Create a new session", exact: true }).click();
  const title = page.getByText("New Session", { exact: true });
  await expect(title).toBeVisible();
  const values = await page.locator("#ns-bridge option").evaluateAll(nodes => nodes.map(node => (node as HTMLOptionElement).value));
  await page.locator("#ns-bridge").focus();
  await page.keyboard.press("Escape");
  await expect(title).toBeHidden();
  return values;
}

/** The Inbox control's accessible label ("Inbox, 0 messages" or "Inbox, <n> waiting"). */
async function inboxLabel(page: Page): Promise<string> {
  return page.getByRole("button", { name: /^Inbox, \d+ (waiting|messages?)$/ }).evaluate(node => node.getAttribute("aria-label") ?? node.textContent ?? "");
}

async function terminalText(page: Page): Promise<string> {
  return (await page.locator(".xterm-rows").first().innerText().catch(() => "")) ?? "";
}

/** The shared bridge's tmux pane for a session, read through that bridge's PRIVATE socket only (never the default server). */
async function sharedPane(sid: string): Promise<string> {
  const dir = readFileSync(join(E2E_DIR, ".bridge.tmux"), "utf8").trim();
  const { stdout } = await execute("tmux", ["-S", tmuxSocket(dir), "capture-pane", "-p", "-J", "-S", "-500", "-t", `=ftown-${sid}:`], { timeout: 5000, maxBuffer: 1 << 20 });
  return stdout;
}

async function sharedHasSession(sid: string): Promise<boolean> {
  const dir = readFileSync(join(E2E_DIR, ".bridge.tmux"), "utf8").trim();
  try { await execute("tmux", ["-S", tmuxSocket(dir), "has-session", "-t", `=ftown-${sid}`], { timeout: 5000 }); return true; } catch { return false; }
}

/** A well-formed-looking but undecryptable application envelope addressed to A's bridge, from B's endpoint. */
function garbageEnvelope(channel: string): Record<string, unknown> {
  const now = Date.now();
  return {
    type: "ftown_encrypted", version: 1, senderId: b.second.endpointId, recipientId: a.hostBridgeEndpointId, ownerId: a.accountId,
    bridgeId: a.hostBridgeId, channel, purpose: "application", messageId: randomUUID(), createdAt: now, expiresAt: now + 60_000,
    enc: b64url(65), ciphertext: b64url(96),
  };
}

/** Publish with B's REAL relay token and record what the relay decided. A failed connect is a precondition failure (throws). */
async function publishAsB(channel: string, payloads: unknown[]): Promise<CentrifugoAttempt[]> {
  const outcomes: CentrifugoAttempt[] = [];
  for (const payload of payloads) {
    const outcome = await attemptPublish(b.token, channel, payload);
    outcomes.push(outcome);
    if (outcome.ok) {
      test.info().annotations.push({ type: ACCEPTED, description: channel });
      console.log(`[account-isolation] ${ACCEPTED}: ${channel}`);
    } else {
      test.info().annotations.push({ type: REFUSED, description: `${channel}: ${outcome.error?.code} ${outcome.error?.message}` });
      console.log(`[account-isolation] ${REFUSED}: ${channel} (${outcome.error?.code} ${outcome.error?.message})`);
    }
  }
  return outcomes;
}

/** Make A's page show its session terminal, live. */
async function showASession(): Promise<void> {
  await openSession(a.page, a.sessionName);
  await expect(a.page.locator(".xterm-rows").first()).toContainText(/[$%#>]/, { timeout: 30_000 });
}

test.describe("account isolation: two real accounts on one server", () => {
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    // ---- A: the shared account, its shared bridge and a fresh session ----
    const account = readRunAccount();
    const accountId = sharedAccountId();
    contextA = await browser.newContext();
    const page = await contextA.newPage();
    const frames: string[] = [];
    const pageErrors: string[] = [];
    page.on("websocket", socket => socket.on("framereceived", ({ payload }) => { frames.push(typeof payload === "string" ? payload : payload.toString("utf8")); }));
    page.on("pageerror", error => pageErrors.push(error.message));
    // Readiness diagnostics: the shared host bridge's output and ledger replica, from before this browser is added to A.
    const probe = startReadinessProbe(`A's new browser on the shared bridge (account ${accountId.slice(0, 8)})`, {
      log: () => readSharedBridgeLog("bridge"), replicaFile: join(BRIDGE_HOME, ".ftown", "data", "security", "ledger.json"),
    });
    let endpointId: string;
    try {
      await login(page, { browserLabel: `E2E isolation A ${hex(2)}` });
      endpointId = await browserEndpointId(page);
      probe.watchEndpoint(endpointId);
      probe.mark("browser added");
    } catch (error) { probe.stop(); throw error; }
    // Enrolled in a hook: the per-test fixture would revoke it after the FIRST test; this file revokes it in afterAll.
    takeEnrolledBrowsers(test.info().testId);
    enrolledA = endpointId;
    const sessionName = `iso-A-${hex()}`;
    const hostBridgeId = readBridgePointer().bridgeId;
    let computers: number;
    let before: Set<string>;
    try {
      await waitForBridgeOnline(page);
      await expect.poll(() => computerCount(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
      computers = await computerCount(page);
      before = await sessionIdsFor(accountId);
      // This browser was just added to A: the computer may refuse its first encrypted requests for a few seconds.
      await createShellSessionWhenAccepted(page, sessionName, hostBridgeId, { probe, origin: "browser added" });
    } finally { probe.stop(); }
    const sid = await waitForNewSessionId(accountId, before);
    await openSession(page, sessionName);
    await runMarkerInTerminal(page, `iso-a-baseline-${hex()}`);
    const { ledger, checkpoint } = await serverLedger(account);
    const host = checkpoint.bridges.find(item => item.bridgeId === hostBridgeId);
    if (!host) throw new Error("the shared bridge is not in A's ledger");
    const everListed = (kind: "add_device" | "add_bridge") => ledger.transitions.map(item => item.payload.operation)
      .flatMap(operation => operation.type === "add_device" && kind === "add_device" ? [operation.device.endpoint.id]
        : operation.type === "add_bridge" && kind === "add_bridge" ? [operation.bridge.bridgeId] : []);
    a = {
      account, accountId, context: contextA, page, endpointId, sessionName, sid, hostBridgeId, hostBridgeEndpointId: host.endpoint.id,
      bridgeIds: everListed("add_bridge"), deviceIds: everListed("add_device"), computers, token: await getCentrifugoToken(page), frames, pageErrors,
    };

    // ---- B: a brand-new account in its own context, its own passkey, device, bridge and session ----
    second = await createSecondAccount(browser, { name: `E2E account B ${hex(3)}` });
    const paired = await second.pairBridge();
    const bSessionName = `iso-B-${hex()}`;
    const bSid = await second.createSession(bSessionName);
    await openSession(second.page, bSessionName);
    await runMarkerInTerminal(second.page, `iso-b-baseline-${hex()}`);
    b = { second, sessionName: bSessionName, sid: bSid, bridgeId: paired.bridgeId, token: await second.relayToken() };
    expect(jwtSub(b.token)).toBe(second.accountId);
    expect(jwtSub(a.token)).toBe(accountId);
  });

  test.afterAll(async () => {
    try { await second?.close(); } finally {
      await contextA?.close();
      if (enrolledA) await revokeDevices([enrolledA]);
    }
  });

  test("each dashboard lists only its own account's computers and sessions", async () => {
    const pageB = b.second.page;
    await pageB.goto("/dashboard");
    await waitForBridgeOnline(pageB);
    await expect(pageB.getByRole("button", { name: new RegExp(b.sessionName) })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => computerCount(pageB), { timeout: 30_000 }).toBe(1);
    // The only computer B can start a session on is B's own.
    expect(await offeredComputers(pageB)).toEqual([b.bridgeId]);
    const htmlB = await pageB.content();
    for (const value of [a.accountId, a.sessionName, a.sid, ...a.bridgeIds]) {
      expect(htmlB, `B's dashboard shows A's ${value}`).not.toContain(value);
    }
    for (const value of [a.accountId, a.sessionName, a.sid, ...a.bridgeIds]) {
      expect(b.second.receivedFrames.some(frame => frame.includes(value)), `B's browser received a frame naming A's ${value}`).toBe(false);
    }

    // ...and A's dashboard is exactly as before B existed.
    await a.page.reload();
    await waitForBridgeOnline(a.page);
    await expect(a.page.getByRole("button", { name: new RegExp(a.sessionName) })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => computerCount(a.page), { timeout: 30_000 }).toBe(a.computers);
    const offeredA = await offeredComputers(a.page);
    expect(offeredA).toContain(a.hostBridgeId);
    expect(offeredA).not.toContain(b.bridgeId);
    const htmlA = await a.page.content();
    for (const value of [b.second.accountId, b.sessionName, b.sid, b.bridgeId]) {
      expect(htmlA, `A's dashboard shows B's ${value}`).not.toContain(value);
      expect(a.frames.some(frame => frame.includes(value)), `A's browser received a frame naming B's ${value}`).toBe(false);
    }
  });

  test("endpoint directory: B reads only B's endpoints and cannot publish an entry for A", async () => {
    const origin = { origin: UI_BASE_URL };
    type Entry = { protocolVersion: 1; bridgeId: string | null; label: string; endpoint: { version: 1; id: string; ownerId: string; kind: string; publicKey: string } };
    type Directory = { ownerId: string; endpoints: Entry[] };
    const read = async (page: Page): Promise<Directory> => {
      const response = await page.request.get("/api/security/endpoints");
      expect(response.status()).toBe(200);
      return await response.json() as Directory;
    };
    const directoryA = await read(a.page);
    const directoryB = await read(b.second.page);
    const ledgerA = (await serverLedger(a.account)).checkpoint;
    const ledgerB = (await serverLedger(b.second.account)).checkpoint;
    const ownIdsB = [...ledgerB.devices.map(item => item.endpoint.id), ...ledgerB.bridges.map(item => item.endpoint.id)];
    expect(directoryB.ownerId).toBe(b.second.accountId);
    expect(directoryB.endpoints.length).toBeGreaterThanOrEqual(1);
    expect(directoryB.endpoints.every(entry => entry.endpoint.ownerId === b.second.accountId)).toBe(true);
    expect(directoryB.endpoints.filter(entry => !ownIdsB.includes(entry.endpoint.id))).toEqual([]);
    const idsB = directoryB.endpoints.map(entry => entry.endpoint.id);
    for (const id of [...a.deviceIds, a.hostBridgeEndpointId, ...directoryA.endpoints.map(entry => entry.endpoint.id)]) expect(idsB).not.toContain(id);
    for (const bridgeId of directoryB.endpoints.map(entry => entry.bridgeId).filter(Boolean)) expect(bridgeId).toBe(b.bridgeId);

    // Writes: A's own entries (built from A's public ledger) replayed by B, and B's session claiming A's browser key under
    // B's account, are refused.
    const aDevice = ledgerA.devices.find(item => item.endpoint.id === a.endpointId)!;
    const aHost = ledgerA.bridges.find(item => item.bridgeId === a.hostBridgeId)!;
    const aBrowser: Entry = { protocolVersion: 1, bridgeId: null, label: aDevice.label, endpoint: aDevice.endpoint };
    const aBridge: Entry = { protocolVersion: 1, bridgeId: aHost.bridgeId, label: aHost.label, endpoint: aHost.endpoint };
    for (const entry of [aBrowser, aBridge, { ...aBrowser, endpoint: { ...aBrowser.endpoint, ownerId: b.second.accountId } }]) {
      const response = await b.second.page.request.put("/api/security/endpoints", { headers: origin, data: entry });
      expect(response.status(), JSON.stringify(entry.endpoint)).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }
    // Positive control: B can publish its own browser entry (the endpoint B's ledger lists for this browser).
    const bDevice = ledgerB.devices.find(item => item.endpoint.id === b.second.endpointId)!;
    const own: Entry = { protocolVersion: 1, bridgeId: null, label: bDevice.label, endpoint: bDevice.endpoint };
    const ownPut = await b.second.page.request.put("/api/security/endpoints", { headers: origin, data: own });
    expect(ownPut.status()).toBe(200);
    expect((await read(b.second.page)).endpoints.map(entry => entry.endpoint.id)).toContain(b.second.endpointId);
    const after = await read(a.page);
    expect(after.ownerId).toBe(a.accountId);
    expect(after.endpoints.map(entry => entry.endpoint.id).sort()).toEqual(directoryA.endpoints.map(entry => entry.endpoint.id).sort());
    expect(after.endpoints.every(entry => entry.endpoint.ownerId === a.accountId)).toBe(true);
  });

  test("device display names: B lists only its own devices and cannot name A's computer or browser", async () => {
    const origin = { origin: UI_BASE_URL };
    type Names = { names: { kind: string; id: string; name: string }[]; eligible: { kind: string; id: string }[] };
    const list = async (page: Page): Promise<Names> => {
      const response = await page.request.get("/api/security/device-names");
      expect(response.status()).toBe(200);
      return await response.json() as Names;
    };
    const beforeA = await list(a.page);
    const namesB = await list(b.second.page);
    expect(namesB.eligible.map(item => `${item.kind}:${item.id}`).sort()).toEqual([`bridge:${b.bridgeId}`, `browser:${b.second.endpointId}`].sort());
    const aIds = new Set([...a.bridgeIds, ...a.deviceIds]);
    expect(namesB.names.filter(item => aIds.has(item.id))).toEqual([]);
    for (const target of [{ kind: "bridge", id: a.hostBridgeId }, { kind: "browser", id: a.endpointId }]) {
      const response = await b.second.page.request.put("/api/security/device-names", { headers: origin, data: { ...target, name: `renamed by B ${hex(2)}` } });
      expect(response.status(), JSON.stringify(target)).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("unknown_device");
    }
    // Positive control: B names its own computer; A never sees it.
    const ownName = `B's own computer ${hex(2)}`;
    const own = await b.second.page.request.put("/api/security/device-names", { headers: origin, data: { kind: "bridge", id: b.bridgeId, name: ownName } });
    expect(own.status()).toBe(200);
    const afterA = await list(a.page);
    expect(afterA).toEqual(beforeA);
    expect(JSON.stringify(afterA)).not.toContain(ownName);
  });

  test("push subscriptions: B can neither take over nor remove A's push endpoint", async () => {
    const origin = { origin: UI_BASE_URL };
    const keys = () => { const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: b64url(16) }; };
    const endpoint = `https://fcm.googleapis.com/fcm/send/e2e-isolation-${hex(8)}`;
    const keysA = keys();
    await withDb(async db => {
      const rows = async () => (await db.query("SELECT account_id, p256dh, auth FROM push_subscriptions WHERE endpoint=$1", [endpoint])).rows as { account_id: string; p256dh: string; auth: string }[];
      try {
        const subscribed = await a.page.request.post("/api/push", { headers: origin, data: { endpoint, keys: keysA } });
        expect(subscribed.status()).toBe(201);
        const takeover = await b.second.page.request.post("/api/push", { headers: origin, data: { endpoint, keys: keys() } });
        expect(takeover.status()).toBe(409);
        expect(await takeover.json()).toEqual({ error: "subscription_limit_or_conflict" });
        const removal = await b.second.page.request.delete("/api/push", { headers: origin, data: { endpoint } });
        expect(removal.status()).toBe(204); // idempotent and scoped to B: B holds no such subscription
        expect(await rows()).toEqual([{ account_id: a.accountId, p256dh: keysA.p256dh, auth: keysA.auth }]);
      } finally {
        expect((await a.page.request.delete("/api/push", { headers: origin, data: { endpoint } })).status()).toBe(204);
        expect(await rows()).toEqual([]);
      }
    });
  });

  test("pair mailbox: B cannot overwrite A's sealed approval and the refusal reveals nothing", async () => {
    const requestId = b64url(32);
    const sealedA = `e2e-sealed-by-A-${hex(8)}`;
    expect((await a.page.request.put(`/api/pair/${requestId}`, { data: { sealed: sealedA } })).status()).toBe(204);
    const conflict = await b.second.page.request.put(`/api/pair/${requestId}`, { data: { sealed: `e2e-sealed-by-B-${hex(8)}` } });
    expect(conflict.status()).toBe(409);
    expect(await conflict.text()).toBe(JSON.stringify({ error: "conflict" }));
    // The public contract: whoever holds the 256-bit request id (the bridge that minted it) reads the sealed blob, which is
    // sealed end-to-end to that bridge. B's session adds nothing to an anonymous read.
    const anonymous = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": source() } });
    try {
      const publicRead = await anonymous.get(`/api/pair/${requestId}`);
      expect(publicRead.status()).toBe(200);
      expect(await publicRead.json()).toEqual({ sealed: sealedA });
      const readByB = await b.second.page.request.get(`/api/pair/${requestId}`);
      expect(readByB.status()).toBe(200);
      expect(await readByB.json()).toEqual({ sealed: sealedA });
    } finally { await anonymous.dispose(); }
    // Symmetric: A cannot overwrite B's mailbox entry either.
    const requestB = b64url(32);
    expect((await b.second.page.request.put(`/api/pair/${requestB}`, { data: { sealed: "e2e-sealed-by-B" } })).status()).toBe(204);
    const reverse = await a.page.request.put(`/api/pair/${requestB}`, { data: { sealed: "e2e-sealed-by-A" } });
    expect(reverse.status()).toBe(409);
    expect(await reverse.json()).toEqual({ error: "conflict" });
  });

  test("relay tokens: B's session and every key B holds only ever yield tokens for B", async () => {
    // Session-minted: body input never chooses the subject.
    const minted = await b.second.page.request.post(`${UI_BASE_URL}/api/auth/token`, { data: { accountId: a.accountId, sub: a.accountId, userId: a.accountId } });
    expect(minted.status()).toBe(200);
    const body = await minted.json() as { token: string; accountId: string };
    expect(body.accountId).toBe(b.second.accountId);
    expect(jwtSub(body.token)).toBe(b.second.accountId);

    const audience = new URL(UI_BASE_URL).origin;
    const deviceProof = async (accountId: string, keyId: string) => signWithBrowserDeviceKey(b.second.page, {
      accountId, kind: "device", keyId, nonce: await serverNonce("relay"), purpose: "relay", audience,
    });
    // Positive control: B's in-page device-key proof for B is a valid proof (so the refusals below are not a broken signer).
    const own = await requestRelayToken(await deviceProof(b.second.accountId, b.second.endpointId));
    expect(own.status).toBe(200);
    expect(jwtSub(own.body.token as string)).toBe(b.second.accountId);
    // B's device key, claiming A's account (as B's device, or as one of A's real devices).
    for (const keyId of [b.second.endpointId, a.endpointId]) {
      const refused = await requestRelayToken(await deviceProof(a.accountId, keyId));
      expect(refused.status, `device proof accountId=A keyId=${keyId}`).toBe(401);
      expect(refused.body).toEqual({ error: "unauthorized" });
    }
    // B's bridge key, claiming A's account (as B's bridge, or as A's shared bridge).
    const bridgeKey = await importAuthKey(b.second.paired!.authPrivateKey);
    const ownBridge = await requestRelayToken(await signProof(bridgeKey, { accountId: b.second.accountId, kind: "bridge", keyId: b.bridgeId, purpose: "relay" }));
    expect(ownBridge.status).toBe(200);
    expect(jwtSub(ownBridge.body.token as string)).toBe(b.second.accountId);
    for (const keyId of [b.bridgeId, a.hostBridgeId]) {
      const refused = await requestRelayToken(await signProof(bridgeKey, { accountId: a.accountId, kind: "bridge", keyId, purpose: "relay" }));
      expect(refused.status, `bridge proof accountId=A keyId=${keyId}`).toBe(401);
      expect(refused.body).toEqual({ error: "unauthorized" });
    }
  });

  test("ledger: B's passkey cannot extend A's chain; A's ledger is public by design and holds only public material", async () => {
    const lib = await ledgerLib();
    const before = await serverLedger(a.account);
    const bLedger = await serverLedger(b.second.account);
    const bAuthority = bLedger.checkpoint.authorities[0];
    const bCredential = ledgerCredentialId(b.second.account);
    expect(bAuthority.credentialId).toBe(bCredential);
    const issuedAt = Math.max(Date.now(), lib.ledgerLastIssuedAt(before.ledger));
    const base = { type: "ftown_account_transition" as const, version: 2 as const, accountId: a.accountId, revision: before.checkpoint.revision + 1, previousHead: before.checkpoint.head, issuedAt };
    const smuggled = await browserDevice(a.accountId, "smuggled by B", issuedAt);
    const consent = await passkeyAssertion(await lib.authorityConsentChallenge(a.accountId, { credentialId: bCredential, publicKey: bAuthority.publicKey }), b.second.account);
    const candidates: [string, LedgerTransition][] = [
      ["B signs as itself: add a device", { ...base, credentialId: bCredential, operation: { type: "add_device", device: smuggled } }],
      ["B claims A's authority id: add a device", { ...base, credentialId: before.checkpoint.authorities[0].credentialId, operation: { type: "add_device", device: smuggled } }],
      ["B adds its own passkey as an authority of A (with B's own consent)", { ...base, credentialId: bCredential, operation: { type: "add_authority", authority: { credentialId: bCredential, publicKey: bAuthority.publicKey, label: "B takes over", addedAt: issuedAt }, consent } }],
      ["B revokes A's browser", { ...base, credentialId: bCredential, operation: { type: "revoke_device", endpointId: a.endpointId } }],
    ];
    for (const [label, payload] of candidates) {
      const record: Signed<LedgerTransition> = { payload, signature: await passkeyAssertion(await lib.ledgerChallenge(payload), b.second.account) };
      const response = await b.second.page.request.post("/api/account/ledger", {
        headers: { "x-real-ip": source() }, data: { ledger: { genesis: before.ledger.genesis, transitions: [...before.ledger.transitions, record] } },
      });
      expect(response.status(), label).toBe(409);
      const refusal = await response.json() as { error: string; ledger: unknown };
      expect(refusal.error, label).toBe("ledger_rejected");
      expect((await lib.verifyLedger(lib.parseLedger(refusal.ledger))).head, label).toBe(before.checkpoint.head);
    }
    const after = await serverLedger(a.account);
    expect(after.checkpoint.head).toBe(before.checkpoint.head);
    expect(after.checkpoint.authorities).toEqual(before.checkpoint.authorities);
    expect(after.checkpoint.devices.map(item => item.endpoint.id)).not.toContain(smuggled.endpoint.id);
    expect(after.checkpoint.devices.map(item => item.endpoint.id)).toContain(a.endpointId);

    // GET by accountId is public BY DESIGN (ui/src/app/api/account/ledger/route.ts): B, and anyone, can read A's chain. It is
    // self-authenticating and holds only the ledger format: public keys, labels, origins, ids and timestamps, plus signatures.
    const byB = await b.second.page.request.get(`/api/account/ledger?accountId=${a.accountId}`);
    expect(byB.status()).toBe(200);
    const anonymous = await apiRequest.newContext({ baseURL: UI_BASE_URL, extraHTTPHeaders: { "x-real-ip": source() } });
    let publicBody: unknown;
    try {
      const response = await anonymous.get(`/api/account/ledger?accountId=${a.accountId}`);
      expect(response.status()).toBe(200);
      publicBody = await response.json();
    } finally { await anonymous.dispose(); }
    const readByB = await byB.json() as { ledger: unknown };
    expect(readByB).toEqual(publicBody);
    expect(Object.keys(readByB)).toEqual(["ledger"]);
    // parseLedger accepts exactly the ledger format (unknown members throw) and normalizes nothing away.
    expect(lib.parseLedger(readByB.ledger)).toEqual(readByB.ledger);
    const allowed = new Set([
      "genesis", "transitions", "payload", "signature", "authenticatorData", "clientDataJSON",
      "type", "version", "rpId", "origins", "handle", "createdAt", "authority", "credentialId", "publicKey", "label", "addedAt",
      "accountId", "revision", "previousHead", "issuedAt", "operation", "device", "bridge", "endpointId", "bridgeId", "consent",
      "endpoint", "id", "ownerId", "kind", "authPublicKey", "approvedAt",
    ]);
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { keys.add(key); walk(item); }
    };
    walk(readByB.ledger);
    expect([...keys].filter(key => !allowed.has(key))).toEqual([]);
    expect(JSON.stringify(readByB)).not.toMatch(/privateKey|"d":|sealed|token|secret|sticky|nonce/i);
  });

  test("relay subscribe: B's real token is refused on every one of A's channels; both accounts keep their own", async () => {
    const { accountChannel, sessionChannel } = await channelsLib();
    const accountKinds = ["sessions:updates", "commands:rpc", "bridges:presence", "bridges:security", "bridges:ledger"] as const;
    const sessionKinds = ["terminal", "terminal-input", "events"] as const;
    const channelsOf = (accountId: string, sid: string) => [
      ...accountKinds.map(kind => accountChannel(kind, accountId)),
      ...sessionKinds.map(kind => sessionChannel(kind, sid, accountId)),
    ];
    for (const channel of channelsOf(a.accountId, a.sid)) {
      const result = await attemptSubscribe(b.token, channel); // B's token is valid: a failed connect throws (precondition)
      expect.soft(result.ok, `SECURITY: B's relay token subscribed to A's ${channel}`).toBe(false);
      expect.soft(result.error?.code, `${channel}: refused, but not with 103 permission denied (${JSON.stringify(result.error)})`).toBe(103);
    }
    // `stream:<sid>#<account>` (useSessionStream) has no relay namespace in any Centrifugo config, so it is refused as an
    // unknown channel (102) for EVERY token, A's own included: refused for B, and not an isolation decision.
    const stream = sessionChannel("stream", a.sid, a.accountId);
    const streamByB = await attemptSubscribe(b.token, stream);
    expect.soft(streamByB.ok, `SECURITY: B's relay token subscribed to A's ${stream}`).toBe(false);
    expect.soft([102, 103], JSON.stringify(streamByB.error)).toContain(streamByB.error?.code);
    expect.soft((await attemptSubscribe(a.token, stream)).error?.code, "stream namespace is unknown to the relay").toBe(102);
    // Positive controls: each token subscribes to its own account's channels (presence channels skipped: a raw subscriber
    // would briefly count as a computer on the dashboard).
    for (const channel of channelsOf(b.second.accountId, b.sid).filter(name => !name.startsWith("bridges:presence"))) {
      expect.soft((await attemptSubscribe(b.token, channel)).ok, `B on its own ${channel}`).toBe(true);
    }
    for (const channel of channelsOf(a.accountId, a.sid).filter(name => !name.startsWith("bridges:presence"))) {
      expect.soft((await attemptSubscribe(a.token, channel)).ok, `A on its own ${channel}`).toBe(true);
    }
    // A still receives its own traffic end to end.
    await showASession();
    await runMarkerInTerminal(a.page, `iso-a-own-${hex()}`);
  });

  test("relay publish into A's terminal-input: nothing reaches A's shell", async () => {
    await showASession();
    const errors = a.pageErrors.length;
    const { sessionChannel } = await channelsLib();
    const channel = sessionChannel("terminal-input", a.sid, a.accountId);
    const marker = `XACCTIN${hex()}`;
    const dropsBefore = readSharedBridgeLog("bridge").split(`Dropped foreign publication on ${channel} from user="${b.second.accountId}"`).length;
    const outcomes = await publishAsB(channel, [
      { kind: "input", data: `echo ${marker}plain\r` },
      { type: "input", data: `echo ${marker}typed\r` },
      { type: "terminal_input", sessionId: a.sid, data: `echo ${marker}legacy\r` },
      garbageEnvelope(channel),
    ]);
    await a.page.waitForTimeout(SETTLE_MS);
    expect(await terminalText(a.page), "SECURITY: B's keystrokes reached A's terminal").not.toContain(marker);
    expect(await sharedPane(a.sid), "SECURITY: B's keystrokes reached A's PTY").not.toContain(marker);
    const drops = readSharedBridgeLog("bridge").split(`Dropped foreign publication on ${channel} from user="${b.second.accountId}"`).length - dropsBefore;
    test.info().annotations.push({ type: "bridge dropped foreign terminal-input publications", description: `${drops} of ${outcomes.filter(item => item.ok).length} accepted` });
    expect(a.pageErrors.slice(errors)).toEqual([]);
    // The terminal is live: A's own input still round-trips.
    await runMarkerInTerminal(a.page, `iso-a-live-${hex()}`);
  });

  test("relay publish into A's commands channel: A's bridge executes nothing", async () => {
    await showASession();
    const errors = a.pageErrors.length;
    const { accountChannel } = await channelsLib();
    const channel = accountChannel("commands:rpc", a.accountId);
    const before = await sessionIdsFor(a.accountId);
    const spoof = `iso-B-spawned-${hex()}`;
    const marker = `XACCTCMD${hex()}`;
    await publishAsB(channel, [
      { type: "create_session", payload: { command: "/bin/zsh -l", shellType: "shell", name: spoof, bridgeId: a.hostBridgeId }, requestId: randomUUID() },
      { type: "kill_session", payload: { sessionId: a.sid }, requestId: randomUUID() },
      { type: "send_input", payload: { sessionId: a.sid, data: `echo ${marker}\r` }, requestId: randomUUID() },
      { type: "webrtc_close", sessionId: a.sid, bridgeId: a.hostBridgeId },
      garbageEnvelope(channel),
    ]);
    await a.page.waitForTimeout(SETTLE_MS);
    expect([...await sessionIdsFor(a.accountId)].sort(), "SECURITY: B's command changed A's sessions").toEqual([...before].sort());
    expect(await sharedHasSession(a.sid), "SECURITY: B killed A's session").toBe(true);
    expect(await sharedPane(a.sid)).not.toContain(marker);
    expect(await sidebarText(a.page)).not.toContain(spoof);
    await expect(a.page.getByRole("button", { name: new RegExp(a.sessionName) })).toBeVisible();
    expect(a.pageErrors.slice(errors)).toEqual([]);
    await runMarkerInTerminal(a.page, `iso-a-live-${hex()}`);
  });

  test("relay publish into A's events channel: A's attention state is unchanged", async () => {
    await showASession();
    const errors = a.pageErrors.length;
    const { sessionChannel } = await channelsLib();
    const channel = sessionChannel("events", a.sid, a.accountId);
    const inboxBefore = await inboxLabel(a.page);
    const neededBefore = await a.page.getByRole("img", { name: "Input needed" }).count();
    const now = new Date().toISOString();
    await publishAsB(channel, [
      { type: "hook_event", sessionId: a.sid, eventName: "Notification", data: { message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" }, timestamp: now },
      { type: "hook_event", sessionId: a.sid, eventName: "PermissionRequest", data: { tool_name: "Bash" }, timestamp: now },
      { type: "hook_event", sessionId: a.sid, eventName: "Stop", data: {}, timestamp: now },
      garbageEnvelope(channel),
    ]);
    await a.page.waitForTimeout(SETTLE_MS);
    expect(await inboxLabel(a.page), "SECURITY: B changed A's inbox").toBe(inboxBefore);
    expect(await a.page.getByRole("img", { name: "Input needed" }).count(), "SECURITY: B raised attention on A's session").toBe(neededBefore);
    expect(a.pageErrors.slice(errors)).toEqual([]);
  });

  test("relay publish into A's sessions channel: A's session list is unchanged", async () => {
    await showASession();
    const errors = a.pageErrors.length;
    const { accountChannel } = await channelsLib();
    const channel = accountChannel("sessions:updates", a.accountId);
    const idsBefore = await sessionIdsFor(a.accountId);
    const now = new Date().toISOString();
    const fake = `iso-B-fake-${hex()}`;
    const renamed = `iso-B-renamed-${hex()}`;
    const row = (id: string, name: string, status: string) => ({ id, bridgeId: a.hostBridgeId, name, status, shellType: "shell", runtime: "tmux", createdAt: now, updatedAt: now });
    await publishAsB(channel, [
      { type: "session_update", session: row(randomUUID(), fake, "running"), timestamp: now },
      { type: "session_update", session: row(a.sid, renamed, "running"), timestamp: now },
      { type: "session_update", session: row(a.sid, a.sessionName, "removed"), timestamp: now },
      garbageEnvelope(channel),
    ]);
    await a.page.waitForTimeout(SETTLE_MS);
    const sidebar = await sidebarText(a.page);
    expect(sidebar, "SECURITY: B injected a session row into A's list").not.toContain(fake);
    expect(sidebar, "SECURITY: B renamed A's session").not.toContain(renamed);
    await expect(a.page.getByRole("button", { name: new RegExp(a.sessionName) }), "SECURITY: B removed A's session from A's list").toBeVisible();
    expect([...await sessionIdsFor(a.accountId)].sort()).toEqual([...idsBefore].sort());
    expect(a.pageErrors.slice(errors)).toEqual([]);
  });

  test("relay publish into A's terminal output channel: nothing renders in A's terminal", async () => {
    await showASession();
    const errors = a.pageErrors.length;
    const { sessionChannel } = await channelsLib();
    const channel = sessionChannel("terminal", a.sid, a.accountId);
    const marker = `XACCTOUT${hex()}`;
    await publishAsB(channel, [
      { type: "output", data: `\r\n${marker}output\r\n` },
      { type: "screen_dump", raw: `${marker}dump`, lines: [`${marker}lines`] },
      garbageEnvelope(channel),
    ]);
    await a.page.waitForTimeout(SETTLE_MS);
    expect(await terminalText(a.page), "SECURITY: B's output rendered in A's terminal").not.toContain(marker);
    expect(a.pageErrors.slice(errors)).toEqual([]);
    await runMarkerInTerminal(a.page, `iso-a-live-${hex()}`);
  });

  test("browser binding: B's browser cannot create or switch to another account", async () => {
    test.setTimeout(240_000);
    const page = b.second.page;
    const authenticator = await virtualAuthenticator(page);
    await page.goto("/dashboard");
    await page.getByRole("button", { name: `Account: ${b.second.accountId}`, exact: true }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.waitForURL("**/login**");
    const signInButton = page.getByRole("button", { name: "Sign in with passkey" });
    await expect(signInButton).toBeVisible();
    const aBefore = await serverLedger(a.account);
    const bound = "This browser already belongs to an account. Sign in with its passkey, or reset this browser in Security first.";

    // Creating an account from B's bound browser is refused before any passkey is made; sign-in stays offered.
    await fillCreateAccountForm(page, { accountName: "E2E takeover of A", passkey: "E2E takeover passkey", browser: "E2E takeover browser" });
    await page.getByRole("button", { name: "1. Create passkey" }).click();
    await expect(page.locator("#login-error")).toContainText(bound);
    await expect(signInButton).toBeVisible();
    await expect(signInButton).toBeEnabled();
    expect((await authenticator.credentials()).map(item => item.credentialId)).toEqual([b.second.account.credential.credentialId]);

    // With A's synced passkey ALSO in this browser, identifying still yields B: the ceremony is restricted to B's authorities.
    await authenticator.addCredential(a.account.credential);
    await signInButton.click();
    await page.waitForURL("**/dashboard", { timeout: 30_000 });
    expect((await (await page.request.get("/api/auth/session")).json()).user).toEqual({ id: b.second.accountId, endpointId: b.second.endpointId });

    // With ONLY A's passkey in this browser, nothing signs in: the session stays empty and the browser keeps B's identity.
    await page.getByRole("button", { name: `Account: ${b.second.accountId}`, exact: true }).click();
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await page.waitForURL("**/login**");
    await authenticator.cdp.send("WebAuthn.removeCredential", { authenticatorId: authenticator.authenticatorId, credentialId: b.second.account.credential.credentialId });
    expect((await authenticator.credentials()).map(item => item.credentialId)).toEqual([a.account.credential.credentialId]);
    await signInButton.click();
    await expect(page.locator("#login-error")).toBeVisible({ timeout: 60_000 });
    test.info().annotations.push({ type: "identify with only A's passkey in B's browser", description: (await page.locator("#login-error").innerText()).trim() });
    await expect(page).toHaveURL(/\/login/);
    await expect(signInButton).toBeVisible();
    expect((await (await page.request.get("/api/auth/session")).json())?.user).toBeUndefined();
    expect((await page.request.post(`${UI_BASE_URL}/api/auth/token`)).status()).toBe(401);
    expect(await browserEndpointId(page, b.second.accountId)).toBe(b.second.endpointId);
    await expect(browserEndpointId(page, a.accountId)).rejects.toThrow(/No browser identity for this account/);
    const aAfter = await serverLedger(a.account);
    expect(aAfter.checkpoint.head).toBe(aBefore.checkpoint.head);

    // B's own passkey still signs B back in.
    await authenticator.addCredential(b.second.account.credential);
    expect(await signIn(page, { account: b.second.account })).toEqual({ enrolled: null });
    expect((await (await page.request.get("/api/auth/session")).json()).user).toEqual({ id: b.second.accountId, endpointId: b.second.endpointId });
  });

  test("A's bridge and session are unaffected by B's whole lifecycle", async () => {
    // B was created, paired a computer, ran a session, probed A, and now its computer goes away.
    await b.second.page.goto("/dashboard");
    await expect.poll(() => computerCount(b.second.page), { timeout: 30_000 }).toBe(1);
    await b.second.stopBridge();
    await expect.poll(() => computerCount(b.second.page), { timeout: 30_000 }).toBe(0);
    await a.page.reload();
    await waitForBridgeOnline(a.page);
    await expect.poll(() => computerCount(a.page), { timeout: 30_000 }).toBe(a.computers);
    await showASession();
    await runMarkerInTerminal(a.page, `iso-a-after-B-${hex()}`);
    expect(await sharedHasSession(a.sid)).toBe(true);
    const ids = await sessionIdsFor(a.accountId);
    expect(ids.has(a.sid)).toBe(true);
    expect(ids.has(b.sid)).toBe(false);
    const { checkpoint } = await serverLedger(a.account);
    expect(checkpoint.devices.map(item => item.endpoint.id)).not.toContain(b.second.endpointId);
    expect(checkpoint.bridges.map(item => item.bridgeId)).not.toContain(b.bridgeId);
    expect(checkpoint.bridges.map(item => item.bridgeId)).toContain(a.hostBridgeId);
    expect(a.pageErrors).toEqual([]);
  });
});
