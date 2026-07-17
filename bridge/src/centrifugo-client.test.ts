import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { CentrifugoClient } from './centrifugo-client.js';
import type { Command } from './types.js';

/**
 * Publisher-identity guard tests for the two inbound client-publish handlers.
 *
 * Threat recap: Centrifugo gates SUBSCRIBE but not PUBLISH on user-limited
 * channels, so any authenticated user can publish to another user's
 * `commands:rpc#{owner}` / `terminal-input:{sid}#{owner}`. The bridge must act
 * ONLY on publications whose authenticated publisher (`ctx.info.user`) equals the
 * channel owner, and fail CLOSED when that identity is missing/empty.
 */

const OWNER = 'owner@example.com';
const ATTACKER = 'attacker@evil.com';

interface FakePublicationCtx {
  data: unknown;
  info?: { user?: string };
}

/**
 * Build a CentrifugoClient whose underlying Centrifuge is replaced by a stub that
 * hands back a fake subscription. The fake records the 'publication' handler the
 * client registers so a test can invoke it with a fabricated PublicationContext.
 */
function makeClientWithFakeSub(): {
  client: CentrifugoClient;
  publish: (ctx: FakePublicationCtx) => void;
} {
  const client = new CentrifugoClient('ws://127.0.0.1:0/connection/websocket', 'tok', async () => 'tok');

  let publicationHandler: ((ctx: FakePublicationCtx) => void) | undefined;
  const fakeSub = {
    on(event: string, cb: (ctx: FakePublicationCtx) => void) {
      if (event === 'publication') publicationHandler = cb;
    },
    subscribe() {},
    unsubscribe() {},
  };

  (client as unknown as { client: { newSubscription: () => unknown } }).client = {
    newSubscription: () => fakeSub,
  };

  return {
    client,
    publish: (ctx: FakePublicationCtx) => {
      if (!publicationHandler) throw new Error('publication handler was never registered');
      publicationHandler(ctx);
    },
  };
}

describe('CentrifugoClient.subscribeToCommands — publisher-identity guard (fail-closed)', () => {
  let warnCalls = 0;
  const originalWarn = console.warn;

  beforeEach(() => {
    warnCalls = 0;
    console.warn = () => {
      warnCalls += 1;
    };
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('dispatches a command published by the channel owner', () => {
    const { client, publish } = makeClientWithFakeSub();
    const received: Command[] = [];
    client.subscribeToCommands(OWNER, (c) => received.push(c));

    publish({ data: { type: 'list_sessions', requestId: 'r1', payload: {} }, info: { user: OWNER } });

    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].requestId, 'r1');
    assert.strictEqual(warnCalls, 0);
  });

  it('drops a command published by another user (cross-tenant RCE close)', () => {
    const { client, publish } = makeClientWithFakeSub();
    const received: Command[] = [];
    client.subscribeToCommands(OWNER, (c) => received.push(c));

    publish({ data: { type: 'create_session', requestId: 'r2', payload: {} }, info: { user: ATTACKER } });

    assert.strictEqual(received.length, 0);
    assert.strictEqual(warnCalls, 1);
  });

  it('drops a command when publisher info is absent (fail-closed)', () => {
    const { client, publish } = makeClientWithFakeSub();
    const received: Command[] = [];
    client.subscribeToCommands(OWNER, (c) => received.push(c));

    publish({ data: { type: 'create_session', requestId: 'r3', payload: {} } });

    assert.strictEqual(received.length, 0);
  });

  it('drops a command when publisher info.user is empty (fail-closed)', () => {
    const { client, publish } = makeClientWithFakeSub();
    const received: Command[] = [];
    client.subscribeToCommands(OWNER, (c) => received.push(c));

    publish({ data: { type: 'create_session', requestId: 'r4', payload: {} }, info: { user: '' } });

    assert.strictEqual(received.length, 0);
  });
});

describe('CentrifugoClient.subscribeToTerminalInput — publisher-identity guard (fail-closed)', () => {
  const originalWarn = console.warn;

  beforeEach(() => {
    console.warn = () => {};
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  it('delivers input published by the channel owner', () => {
    const { client, publish } = makeClientWithFakeSub();
    const inputs: Array<{ sid: string; data: string }> = [];
    client.subscribeToTerminalInput(
      OWNER,
      'sess-1',
      (sid, data) => inputs.push({ sid, data }),
      () => {},
      () => {},
    );

    publish({ data: { type: 'input', data: 'ls\n' }, info: { user: OWNER } });

    assert.deepStrictEqual(inputs, [{ sid: 'sess-1', data: 'ls\n' }]);
  });

  it('drops keystroke injection from another user', () => {
    const { client, publish } = makeClientWithFakeSub();
    const inputs: Array<{ sid: string; data: string }> = [];
    client.subscribeToTerminalInput(
      OWNER,
      'sess-1',
      (sid, data) => inputs.push({ sid, data }),
      () => {},
      () => {},
    );

    publish({ data: { type: 'input', data: 'rm -rf ~\n' }, info: { user: ATTACKER } });

    assert.strictEqual(inputs.length, 0);
  });

  it('drops input when publisher info is absent (fail-closed)', () => {
    const { client, publish } = makeClientWithFakeSub();
    const inputs: Array<{ sid: string; data: string }> = [];
    client.subscribeToTerminalInput(
      OWNER,
      'sess-1',
      (sid, data) => inputs.push({ sid, data }),
      () => {},
      () => {},
    );

    publish({ data: { type: 'input', data: 'whoami\n' } });

    assert.strictEqual(inputs.length, 0);
  });
});
