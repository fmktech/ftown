import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type AddressInfo } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { Centrifuge } from "centrifuge";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { FleetRelay } from "./relay.js";
import { open, seal, parseSecureEnvelope } from '../security/crypto.js';
import type { ApplicationJson, SecureApplication } from '../security/protocol.js';
import type { McpRequestContext } from './secure-client.js';
import { TestIdentityStore, TEST_OWNER_A } from './test-support.js';

// Optional real-broker integration: supply a local Centrifugo v5 binary. Never uses live credentials.
test(
  "real relay routes correlated requests and ignores a foreign publisher",
  { skip: !process.env.FTOWN_TEST_CENTRIFUGO, timeout: 15000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "ftown-relay-"));
    const reserve = createServer();
    reserve.listen(0, "127.0.0.1");
    await new Promise<void>((r) => reserve.once("listening", r));
    const port = (reserve.address() as AddressInfo).port;
    await new Promise<void>((r) => reserve.close(() => r()));
    const secret = "isolated-test-key-not-a-real-token-secret";
    const file = join(dir, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        token_hmac_secret_key: secret,
        token_audience: "ftown:centrifugo",
        address: "127.0.0.1",
        port,
        api_disable: true,
        allowed_origins: [],
        namespaces: [
          {
            name: "commands",
            allow_subscribe_for_client: true,
            allow_user_limited_channels: true,
            allow_publish_for_client: true,
            allow_publish_for_subscriber: true,
          },
        ],
      }),
    );
    const child = spawn(
      process.env.FTOWN_TEST_CENTRIFUGO!,
      ["--config", file],
      { stdio: "ignore" },
    );
    let childError: Error | undefined;
    child.on("error", (e) => {
      childError = e;
    });
    t.after(async () => {
      child.kill();
      await rm(dir, { recursive: true, force: true });
    });
    const url = `ws://127.0.0.1:${port}/connection/websocket`;
    const owner = "owner@example.test";
    const token = (sub: string) =>
      jwt.sign({}, secret, {
        subject: sub,
        audience: "ftown:centrifugo",
        expiresIn: "1m",
      });
    const worker = new Centrifuge(url, {
      websocket: WebSocket,
      token: token(owner),
    });
    const intruder = new Centrifuge(url, {
      websocket: WebSocket,
      token: token("intruder@example.test"),
    });
    const channel = `commands:rpc#${owner}`;
    const sub = worker.newSubscription(channel);
    const keys = new TestIdentityStore();
    const pending = await keys.ensurePendingIdentity(randomBytes(32).toString('base64url'), TEST_OWNER_A, ['read', 'control']);
    const machines = ['bridge-1', 'rejected', 'silent'];
    const bridgeKeys = new Map(await Promise.all(machines.map(async bridgeId => [bridgeId, await keys.bridge(TEST_OWNER_A, bridgeId)] as const)));
    const grant = await keys.approve(TEST_OWNER_A, pending.requestId, machines.map(bridgeId => ({ bridgeId, endpoint: bridgeKeys.get(bridgeId)!.endpoint, permissions: ['read', 'control'] })));
    await keys.markActive(TEST_OWNER_A, pending.requestId);
    const context: McpRequestContext = { grant, action: { actionId: randomUUID(), parentActionId: null, clientId: 'test-client', grantId: grant.grantId, tool: 'sessions_get', operation: null } };
    const received: { bridgeId: string; purpose: string; wire: string }[] = [];
    let handlerError: unknown;
    sub.on('publication', ctx => {
      void (async () => {
        if (ctx.info?.user !== owner) return;
        let packet;
        try { packet = parseSecureEnvelope(ctx.data); } catch { return; }
        const bridge = bridgeKeys.get(packet.bridgeId);
        if (!bridge || packet.recipientId !== bridge.endpoint.id) return;
        received.push({ bridgeId: packet.bridgeId, purpose: packet.purpose, wire: JSON.stringify(ctx.data) });
        const value = JSON.parse(new TextDecoder().decode(await open(bridge, grant.identity.endpoint, packet, { ownerId: TEST_OWNER_A, bridgeId: packet.bridgeId, channel, recipientId: bridge.endpoint.id, purpose: packet.purpose })));
        let response: unknown;
        if (packet.purpose === 'hello') response = { type: 'welcome', challenge: value.challenge, receiverEpoch: 'test-boot-epoch' };
        else {
          const application = value as SecureApplication;
          let data: ApplicationJson;
          if (application.route.kind === 'command') data = { type: 'command_response', response: { requestId: packet.messageId, success: true, data: { grantId: grant.grantId } } };
          else {
            if (packet.bridgeId === 'silent') return;
            data = packet.bridgeId === 'rejected' ? { status: 503, body: { code: 'outcome_unknown', outcomeUnknown: true } } : { status: 200, body: { bridge: packet.bridgeId } };
          }
          response = { type: 'application', route: { kind: 'response', requestId: packet.messageId }, data, mcp: null };
        }
        const reply = await seal(bridge, grant.identity.endpoint, { ...packet, senderId: bridge.endpoint.id, recipientId: grant.identity.endpoint.id, purpose: packet.purpose === 'hello' ? 'welcome' : 'application', receiverEpoch: null }, new TextEncoder().encode(JSON.stringify(response)));
        // Even an otherwise authentic response from a foreign broker identity is ignored.
        const forged = await seal(bridge, grant.identity.endpoint, { ...reply }, new TextEncoder().encode(JSON.stringify({ type: 'welcome', challenge: 'forged', receiverEpoch: 'foreign' })));
        await intruder.publish(channel, forged);
        // Old plaintext publications with a visible correlation ID never enter the client.
        await sub.publish({ type: 'command_response', response: { requestId: packet.messageId, success: true, data: { forged: true } } });
        await sub.publish(reply);
      })().catch(error => { handlerError = error; });
    });
    worker.connect();
    intruder.connect();
    sub.subscribe();
    t.after(() => {
      worker.disconnect();
      intruder.disconnect();
    });
    await Promise.all([sub.ready(10000), intruder.ready(10000)]);
    assert.equal(childError, undefined);
    const relay = new FleetRelay(url, secret);
    t.after(() => relay.close());
    const result = await relay.request(owner, 'bridge-1', { method: 'GET', path: '/api/sessions', timeoutMs: 3000 }, undefined, context);
    assert.deepEqual(result, { bridge: 'bridge-1' });
    assert.deepEqual(received.filter(row => row.bridgeId === 'bridge-1').map(row => row.purpose), ['hello', 'application', 'application']);
    for (const bridgeId of ['rejected', 'silent']) {
      await assert.rejects(relay.request(owner, bridgeId, { method: 'POST', path: '/api/sessions', body: { name: 'sensitive-marker' }, timeoutMs: 1500 }, undefined, context), { outcomeUnknown: true });
      assert.equal(received.filter(row => row.bridgeId === bridgeId).length, 3);
    }
    await assert.rejects(relay.request(owner, 'bridge-1', { method: 'GET', path: '/api/sessions', timeoutMs: 1000 }), { code: 'approval_required' });
    assert.equal(received.some(row => row.wire.includes('sensitive-marker') || row.wire.includes('/api/sessions')), false);
    assert.equal(handlerError, undefined);
  },
);
