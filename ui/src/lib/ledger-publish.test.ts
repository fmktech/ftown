import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Centrifuge } from 'centrifuge';
import type { Ledger } from '@security/ledger/protocol';
import { ledgerHead } from '@security/ledger/ledger';

vi.mock('centrifuge', () => ({ Centrifuge: class {} }));
import { LEDGER_PUBLISH_MAX_BYTES, ledgerPublication, publishLedger } from './ledger-publish';

const ACCOUNT = 'A'.repeat(43);
const genesisPayload = { type: 'ftown_account_genesis', version: 2, handle: 'h' };
const small = { genesis: { payload: genesisPayload, signature: {} }, transitions: [] } as unknown as Ledger;
const bigTransition = { payload: { type: 'ftown_account_transition', revision: 1, pad: 'x'.repeat(LEDGER_PUBLISH_MAX_BYTES) }, signature: {} };
const big = { genesis: small.genesis, transitions: [bigTransition] } as unknown as Ledger;

class FakeClient {
  handlers: Record<string, () => void> = {};
  published: Array<{ channel: string; data: unknown }> = [];
  disconnects = 0;
  publishResult: Promise<unknown> = Promise.resolve({});
  on(event: string, handler: () => void) { this.handlers[event] = handler; return this; }
  connect() { queueMicrotask(() => this.handlers.connected?.()); }
  disconnect() { this.disconnects += 1; }
  publish(channel: string, data: unknown) { this.published.push({ channel, data }); return this.publishResult; }
}
const asClient = (client: FakeClient) => client as unknown as Centrifuge;
beforeEach(() => { vi.stubEnv('CENTRIFUGO_TOKEN_SECRET', 'k'.repeat(48)); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('ledgerPublication', () => {
  it('sends the full ledger when the message is at most 60 KB', async () => {
    expect(await ledgerPublication(small)).toEqual({ type: 'ledger', ledger: small });
  });
  it('sends only the head and revision beyond 60 KB', async () => {
    const message = await ledgerPublication(big);
    expect(message).toEqual({ type: 'ledger_head', head: await ledgerHead(bigTransition.payload as never), revision: 1 });
    expect(JSON.stringify(message).length).toBeLessThan(200);
  });
});

describe('publishLedger', () => {
  it('publishes on bridges:ledger#accountId with a 60s JWT whose sub is the accountId, then disconnects', async () => {
    const client = new FakeClient();
    const createClient = vi.fn((_url: string, _token: string) => asClient(client));
    await publishLedger(ACCOUNT, small, { centrifugoUrl: () => 'wss://hub.test/ws', createClient });
    expect(client.published).toEqual([{ channel: `bridges:ledger#${ACCOUNT}`, data: { type: 'ledger', ledger: small } }]);
    expect(client.disconnects).toBe(1);
    const token = createClient.mock.calls[0][1];
    const claims = jwt.verify(token, 'k'.repeat(48), { audience: 'ftown:centrifugo' }) as jwt.JwtPayload;
    expect(claims.sub).toBe(ACCOUNT);
    expect((claims.exp ?? 0) - (claims.iat ?? 0)).toBe(60);
  });

  it('publishes the head-only message for a large ledger', async () => {
    const client = new FakeClient();
    await publishLedger(ACCOUNT, big, { centrifugoUrl: () => 'wss://hub.test/ws', createClient: () => asClient(client) });
    expect((client.published[0].data as { type: string }).type).toBe('ledger_head');
  });

  it('never throws: no url, token failure, publish rejection and bad account all resolve', async () => {
    const client = new FakeClient();
    await expect(publishLedger(ACCOUNT, small, { centrifugoUrl: () => null, createClient: () => asClient(client) })).resolves.toBeUndefined();
    expect(client.published).toEqual([]);
    await expect(publishLedger(ACCOUNT, small, { centrifugoUrl: () => 'wss://x', signToken: () => { throw new Error('boom'); } })).resolves.toBeUndefined();
    const failing = new FakeClient();
    failing.publishResult = Promise.reject(new Error('down'));
    await expect(publishLedger(ACCOUNT, small, { centrifugoUrl: () => 'wss://x', createClient: () => asClient(failing) })).resolves.toBeUndefined();
    expect(failing.disconnects).toBe(1);
    await expect(publishLedger('bad:account', small, { centrifugoUrl: () => 'wss://x', createClient: () => asClient(client) })).resolves.toBeUndefined();
  });
});
