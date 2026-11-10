import { describe, expect, it, vi } from 'vitest';
import type { LedgerCheckpoint } from '@security/ledger/protocol';
import { DeviceDisplayNameStore, parseDeviceNameRequest } from './device-display-name-store';

const roster = (devices: string[], bridges: string[]) => ({ devices: devices.map(id => ({ endpoint: { id } })), bridges: bridges.map(bridgeId => ({ bridgeId })) });
/** The persisted trusted checkpoint: the chain lists sticky-bridge too, but its sticky revocation removed it here. */
const trusted = { ...roster(['browser-id'], ['roster-bridge']), revision: 3, head: 'head', revokedBridgeIds: ['sticky-bridge'] } as unknown as LedgerCheckpoint;
const reader = (value: LedgerCheckpoint | null = trusted) => vi.fn(async (_accountId: string) => value);

describe('account device display names', () => {
  it('lists only trusted account targets and excludes sticky-revoked and foreign metadata', async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => {
      expect(params).toEqual(['acct']);
      return [{ kind: 'browser', target_id: 'browser-id', display_name: 'Phone' },
        { kind: 'bridge', target_id: 'sticky-bridge', display_name: 'Old' },
        { kind: 'bridge', target_id: 'foreign', display_name: 'Foreign' }];
    });
    const read = reader();
    const store = new DeviceDisplayNameStore(query, read);
    expect(await store.list('acct')).toEqual({ names: [{ kind: 'browser', id: 'browser-id', name: 'Phone' }],
      eligible: [{ kind: 'browser', id: 'browser-id' }, { kind: 'bridge', id: 'roster-bridge' }] });
    expect(read).toHaveBeenCalledWith('acct');
    expect(query.mock.calls[0][0]).toContain('WHERE account_id=$1');
  });

  it('sets normalized names and resets idempotently, guarded by the stored ledger head', async () => {
    const query = vi.fn(async (_sql: string, _params: unknown[]) => [{ head_ok: true }]);
    const store = new DeviceDisplayNameStore(query, reader());
    await expect(store.set('acct', { kind: 'browser', id: 'browser-id', name: ' Phone ' })).resolves.toEqual({ name: { kind: 'browser', id: 'browser-id', name: 'Phone' } });
    expect(query.mock.calls[0][0]).toContain('FROM account_ledger WHERE account_id=$1 AND head=$4 AND revision=$5');
    expect(query.mock.calls[0][1]).toEqual(['acct', 'browser', 'browser-id', 'head', 3, 'Phone']);
    await expect(store.set('acct', { kind: 'bridge', id: 'roster-bridge', name: null })).resolves.toEqual({ name: null });
    expect(query.mock.calls[1][0]).toContain('DELETE FROM security_device_display_names WHERE account_id=$1');
  });

  it('rejects unknown, sticky-revoked and wrong-kind targets without any write', async () => {
    const query = vi.fn(async () => [{ head_ok: true }]);
    const store = new DeviceDisplayNameStore(query, reader());
    for (const target of [{ kind: 'browser' as const, id: 'roster-bridge' }, { kind: 'bridge' as const, id: 'sticky-bridge' }, { kind: 'bridge' as const, id: 'foreign' }])
      await expect(store.set('acct', { ...target, name: 'Name' })).rejects.toMatchObject({ code: 'unknown_device' });
    expect(query).not.toHaveBeenCalled();
  });

  it('reports a stale ledger head as a conflict', async () => {
    const store = new DeviceDisplayNameStore(vi.fn(async () => [{ head_ok: false }]), reader());
    await expect(store.set('acct', { kind: 'browser', id: 'browser-id', name: 'Name' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('has no eligible targets and refuses writes for an unknown account', async () => {
    const query = vi.fn(async () => []);
    const store = new DeviceDisplayNameStore(query, reader(null));
    expect(await store.list('acct')).toEqual({ names: [], eligible: [] });
    await expect(store.set('acct', { kind: 'browser', id: 'browser-id', name: 'X' })).rejects.toMatchObject({ code: 'unknown_device' });
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
