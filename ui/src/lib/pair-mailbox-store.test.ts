import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const query = vi.fn();
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
import { putPairApproval, takePairApproval } from './pair-mailbox-store';

const rid = () => randomBytes(32).toString('base64url');

describe('pair mailbox store', () => {
  beforeEach(() => { query.mockReset(); query.mockImplementation(async (t: string) => String(t).startsWith('INSERT') ? [{ request_id: 'r' }] : []); });

  it('rejects invalid request ids', async () => {
    for (const bad of ['', 'short', 'a'.repeat(44), '!'.repeat(43), randomBytes(16).toString('base64url')]) {
      await expect(putPairApproval(bad, 'acct', 's')).rejects.toThrow('invalid_request_id');
      await expect(takePairApproval(bad)).rejects.toThrow('invalid_request_id');
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects sealed over 256 KB, accepts exactly 256 KB', async () => {
    await expect(putPairApproval(rid(), 'acct', 'x'.repeat(256 * 1024 + 1))).rejects.toThrow('pair_mailbox_too_large');
    expect(query).not.toHaveBeenCalled();
    await putPairApproval(rid(), 'acct', 'x'.repeat(256 * 1024));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('upserts with a 10 minute TTL', async () => {
    const id = rid(); const before = Date.now();
    await putPairApproval(id, 'acct', 'sealed');
    const [text, params] = query.mock.calls[0];
    expect(text).toContain('ON CONFLICT (request_id) DO UPDATE');
    expect(text).toContain('WHERE pair_mailbox.account_id = EXCLUDED.account_id');
    expect(text).toContain('RETURNING');
    expect(text.split('WHERE')[0]).not.toMatch(/account_id = EXCLUDED/);
    expect(params.slice(0, 3)).toEqual([id, 'acct', 'sealed']);
    const exp = Date.parse(params[3]);
    expect(exp).toBeGreaterThanOrEqual(before + 600_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  it('conflict with another account throws pair_mailbox_conflict', async () => {
    query.mockResolvedValueOnce([]);
    await expect(putPairApproval(rid(), 'other', 's')).rejects.toThrow('pair_mailbox_conflict');
  });

  it('missing row is pending', async () => {
    expect(await takePairApproval(rid())).toEqual({ status: 'pending' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('ready returns sealed and does not delete', async () => {
    query.mockResolvedValueOnce([{ sealed: 'S', expired: false }]);
    expect(await takePairApproval(rid())).toEqual({ status: 'ready', sealed: 'S' });
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).not.toMatch(/DELETE/);
  });

  it('expired row is deleted and reported expired', async () => {
    const id = rid();
    query.mockResolvedValueOnce([{ sealed: 'S', expired: true }]);
    expect(await takePairApproval(id)).toEqual({ status: 'expired' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1][0])).toMatch(/^DELETE FROM pair_mailbox/);
    expect(query.mock.calls[1][1]).toEqual([id]);
  });
});
