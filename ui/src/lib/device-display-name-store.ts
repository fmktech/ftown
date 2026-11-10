import { getDb } from '@/lib/db';
import { readLedger, type StoredLedger } from '@/lib/account-ledger-store';
import { DEVICE_DISPLAY_NAME_MAX_LENGTH, type DeviceNameErrorCode, type DeviceNameKind, type DeviceNameTarget,
  type DeviceDisplayName, type DeviceNamesResponse, type SetDeviceNameRequest, type SetDeviceNameResponse } from './device-display-name-contract';

export class DeviceNameStoreError extends Error {
  constructor(readonly code: DeviceNameErrorCode) { super(code); }
}

export function parseDeviceNameRequest(value: unknown): SetDeviceNameRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeviceNameStoreError('invalid_request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).sort().join(',') !== 'id,kind,name' || (input.kind !== 'browser' && input.kind !== 'bridge')
    || typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(input.id)
    || (input.name !== null && typeof input.name !== 'string')) throw new DeviceNameStoreError('invalid_request');
  const name = typeof input.name === 'string' ? input.name.trim() : null;
  if (name !== null && (!name || name.length > DEVICE_DISPLAY_NAME_MAX_LENGTH || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(input.name as string))) throw new DeviceNameStoreError('invalid_request');
  return { kind: input.kind, id: input.id, name };
}

type LedgerReader = (key: { accountId: string }) => Promise<StoredLedger | null>;
type Query = (text: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
const key = (target: DeviceNameTarget) => `${target.kind}:${target.id}`;

export class DeviceDisplayNameStore {
  constructor(private readonly query: Query = (text, params) => getDb().query(text, params) as Promise<Record<string, unknown>[]>,
    private readonly read: LedgerReader = readLedger) {}

  /** Eligible targets come from the TRUSTED checkpoint (sticky revocations applied), never the raw one. */
  private async membership(accountId: string) {
    const stored = await this.read({ accountId });
    const targets = new Map<string, DeviceNameTarget>();
    for (const device of stored?.trusted.devices ?? []) {
      const target: DeviceNameTarget = { kind: 'browser', id: device.endpoint.id }; targets.set(key(target), target);
    }
    for (const bridge of stored?.trusted.bridges ?? []) {
      const target: DeviceNameTarget = { kind: 'bridge', id: bridge.bridgeId }; targets.set(key(target), target);
    }
    return { stored, targets };
  }

  async list(accountId: string): Promise<DeviceNamesResponse> {
    const { targets } = await this.membership(accountId);
    const rows = await this.query('SELECT kind,target_id,display_name FROM security_device_display_names WHERE account_id=$1 ORDER BY kind,target_id', [accountId]);
    const names: DeviceDisplayName[] = [];
    for (const row of rows) {
      if ((row.kind !== 'browser' && row.kind !== 'bridge') || typeof row.target_id !== 'string' || typeof row.display_name !== 'string') continue;
      const target = { kind: row.kind, id: row.target_id } as DeviceNameTarget;
      if (targets.has(key(target))) names.push({ ...target, name: row.display_name });
    }
    return { names, eligible: [...targets.values()] };
  }

  async set(accountId: string, input: SetDeviceNameRequest): Promise<SetDeviceNameResponse> {
    const target = parseDeviceNameRequest(input);
    const { stored, targets } = await this.membership(accountId);
    if (!stored || !targets.has(key(target))) throw new DeviceNameStoreError('unknown_device');
    // The write is guarded by the ledger head observed during membership: a concurrent ledger change makes it a conflict.
    const params = [accountId, target.kind, target.id, stored.checkpoint.head, stored.checkpoint.revision, target.name];
    const operation = target.name === null
      ? `DELETE FROM security_device_display_names WHERE account_id=$1 AND kind=$2 AND target_id=$3 AND (SELECT allowed FROM guard) RETURNING target_id`
      : `INSERT INTO security_device_display_names(account_id,kind,target_id,display_name) SELECT $1,$2,$3,requested_name FROM guard WHERE allowed
         ON CONFLICT(account_id,kind,target_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=NOW() RETURNING target_id`;
    const rows = await this.query(`WITH guard AS (SELECT EXISTS(SELECT 1 FROM account_ledger WHERE account_id=$1 AND head=$4 AND revision=$5) AS allowed,
       $6::text AS requested_name), mutation AS (${operation})
       SELECT allowed AS head_ok FROM guard`, params);
    if (rows.length !== 1 || typeof rows[0].head_ok !== 'boolean') throw new DeviceNameStoreError('storage_unavailable');
    if (!rows[0].head_ok) throw new DeviceNameStoreError('conflict');
    return { name: target.name === null ? null : { kind: target.kind as DeviceNameKind, id: target.id, name: target.name } };
  }
}
