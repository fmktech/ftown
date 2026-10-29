import { describe, expect, it, vi } from 'vitest';
import type { AccountCheckpoint } from '@security/account-protocol';
import { DeviceDisplayNameStore, parseDeviceNameRequest } from './device-display-name-store';

const checkpoint = { ownerId: 'owner', rootId: 'root', revision: 3, head: 'head',
  devices: [{ endpoint: { id: 'browser-id' } }], bridges: [{ bridgeId: 'roster-bridge' }], revokedBridgeIds: ['revoked-bridge'] } as unknown as AccountCheckpoint;
const trust = () => ({ readVerified: vi.fn(async () => ({ checkpoint, history: {} as never })) });

describe('account device display names', () => {
  it('lists only eligible owner targets and excludes revoked and foreign metadata', async () => {
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(params).toEqual(['owner']);
      if (sql.includes('FROM bridge_refresh')) return [{ bridge_id: 'legacy' }, { bridge_id: 'revoked-bridge' }];
      return [{ kind: 'browser', target_id: 'browser-id', display_name: 'Phone' },
        { kind: 'bridge', target_id: 'revoked-bridge', display_name: 'Old' },
        { kind: 'bridge', target_id: 'foreign', display_name: 'Foreign' }];
    });
    const store = new DeviceDisplayNameStore(query, trust());
    expect(await store.list('owner')).toEqual({ names: [{ kind: 'browser', id: 'browser-id', name: 'Phone' }],
      eligible: [{ kind: 'browser', id: 'browser-id' }, { kind: 'bridge', id: 'roster-bridge' }, { kind: 'bridge', id: 'legacy' }] });
    expect(query.mock.calls[1][0]).toContain('WHERE owner_id=$1');
  });

  it('sets normalized names and resets idempotently with head and legacy membership guards', async () => {
    const query = vi.fn(async (sql: string, _params: unknown[]) => sql.includes('FROM bridge_refresh') && !sql.startsWith('WITH')
      ? [{ bridge_id: 'legacy' }] : [{ head_ok: true, target_ok: true }]);
    const store = new DeviceDisplayNameStore(query, trust());
    await expect(store.set('owner', { kind: 'browser', id: 'browser-id', name: ' Phone ' })).resolves.toEqual({ name: { kind: 'browser', id: 'browser-id', name: 'Phone' } });
    expect(query.mock.calls[1][0]).toContain('root_id=$4 AND revision=$5 AND head=$6');
    expect(query.mock.calls[1][1]).toEqual(['owner', 'browser', 'browser-id', 'root', 3, 'head', false, 'Phone']);
    await expect(store.set('owner', { kind: 'bridge', id: 'legacy', name: null })).resolves.toEqual({ name: null });
    expect(query.mock.calls[3][0]).toContain('DELETE FROM security_device_display_names WHERE owner_id=$1');
    expect(query.mock.calls[3][1][6]).toBe(true);
  });

  it('rejects unknown, revoked, wrong-kind, stale-head, and lost legacy ownership', async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith('WITH') ? [{ head_ok: false, target_ok: true }] : [{ bridge_id: 'legacy' }, { bridge_id: 'revoked-bridge' }]);
    const store = new DeviceDisplayNameStore(query, trust());
    for (const target of [{ kind: 'browser' as const, id: 'legacy' }, { kind: 'bridge' as const, id: 'revoked-bridge' }, { kind: 'bridge' as const, id: 'foreign' }])
      await expect(store.set('owner', { ...target, name: 'Name' })).rejects.toMatchObject({ code: 'unknown_device' });
    await expect(store.set('owner', { kind: 'browser', id: 'browser-id', name: 'Name' })).rejects.toMatchObject({ code: 'conflict' });
    query.mockImplementation(async sql => sql.startsWith('WITH') ? [{ head_ok: true, target_ok: false }] : [{ bridge_id: 'legacy' }]);
    await expect(store.set('owner', { kind: 'bridge', id: 'legacy', name: 'Name' })).rejects.toMatchObject({ code: 'unknown_device' });
  });

  it('handles no signed history without trusting an arbitrary browser', async () => {
    const reader = { readVerified: vi.fn(async () => null) };
    const query = vi.fn(async (sql: string, _params: unknown[]) => sql.startsWith('WITH') ? [{ head_ok: true, target_ok: true }] : [{ bridge_id: 'legacy' }]);
    const store = new DeviceDisplayNameStore(query, reader);
    await expect(store.set('owner', { kind: 'bridge', id: 'legacy', name: 'PC' })).resolves.toMatchObject({ name: { name: 'PC' } });
    expect(query.mock.calls[1][0]).toContain('NOT EXISTS(SELECT 1 FROM security_account_history');
    expect(query.mock.calls[1][1].slice(3, 7)).toEqual([null, null, null, true]);
    await expect(store.set('owner', { kind: 'browser', id: 'browser', name: 'X' })).rejects.toMatchObject({ code: 'unknown_device' });
  });

  it('validates shape, UTF-16 length, ids, controls and bidi while allowing duplicate/generic labels', () => {
    expect(parseDeviceNameRequest({ kind: 'browser', id: 'a'.repeat(200), name: ' Browser ' }).name).toBe('Browser');
    expect(parseDeviceNameRequest({ kind: 'bridge', id: 'pc', name: '😀'.repeat(40) }).name).toBe('😀'.repeat(40));
    for (const input of [{ kind: 'browser', id: 'a'.repeat(201), name: 'x' }, { kind: 'browser', id: 'a', name: ' ' },
      { kind: 'browser', id: 'a', name: '😀'.repeat(41) }, { kind: 'browser', id: 'a', name: 'x\u202ey' },
      { kind: 'browser', id: 'a', name: '\nx' }, { kind: 'browser', id: 'a', name: 'x', ownerId: 'other' },
      { kind: 'bridge', id: '../x', name: null }]) expect(() => parseDeviceNameRequest(input)).toThrow('invalid_request');
  });
});
