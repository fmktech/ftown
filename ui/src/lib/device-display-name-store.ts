import { getDb } from '@/lib/db';
import { AccountTrustStore, type AccountQuery } from '@/lib/account-trust-store';
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

type TrustReader = Pick<AccountTrustStore, 'readVerified'>;
const key = (target: DeviceNameTarget) => `${target.kind}:${target.id}`;

export class DeviceDisplayNameStore {
  private readonly trust: TrustReader;
  constructor(private readonly query: AccountQuery = (text, params) => getDb().query(text, params), trust?: TrustReader) {
    this.trust = trust ?? new AccountTrustStore(query);
  }

  private async membership(ownerId: string) {
    const verified = await this.trust.readVerified(ownerId);
    const checkpoint = verified?.checkpoint;
    const rows = await this.query(`SELECT b.bridge_id FROM bridge_refresh b JOIN users u ON b.sub=u.email
      WHERE u.id::text=$1 AND b.current_jti<>'revoked'`, [ownerId]);
    const targets = new Map<string, DeviceNameTarget>();
    for (const device of checkpoint?.devices ?? []) {
      const target: DeviceNameTarget = { kind: 'browser', id: device.endpoint.id }; targets.set(key(target), target);
    }
    const revoked = new Set(checkpoint?.revokedBridgeIds ?? []);
    for (const id of [...(checkpoint?.bridges ?? []).map(bridge => bridge.bridgeId), ...rows.map(row => row.bridge_id)]) {
      if (typeof id !== 'string' || revoked.has(id)) continue;
      const target: DeviceNameTarget = { kind: 'bridge', id }; targets.set(key(target), target);
    }
    return { verified, targets };
  }

  async list(ownerId: string): Promise<DeviceNamesResponse> {
    const { targets } = await this.membership(ownerId);
    const rows = await this.query('SELECT kind,target_id,display_name FROM security_device_display_names WHERE owner_id=$1 ORDER BY kind,target_id', [ownerId]);
    const names: DeviceDisplayName[] = [];
    for (const row of rows) {
      if ((row.kind !== 'browser' && row.kind !== 'bridge') || typeof row.target_id !== 'string' || typeof row.display_name !== 'string') continue;
      const target = { kind: row.kind, id: row.target_id } as DeviceNameTarget;
      if (targets.has(key(target))) names.push({ ...target, name: row.display_name });
    }
    return { names, eligible: [...targets.values()] };
  }

  async set(ownerId: string, input: SetDeviceNameRequest): Promise<SetDeviceNameResponse> {
    const target = parseDeviceNameRequest(input);
    const { verified, targets } = await this.membership(ownerId);
    if (!targets.has(key(target))) throw new DeviceNameStoreError('unknown_device');
    const head = verified?.checkpoint;
    const legacyOnly = target.kind === 'bridge' && !head?.bridges.some(bridge => bridge.bridgeId === target.id);
    const params = [ownerId, target.kind, target.id, head?.rootId ?? null, head?.revision ?? null, head?.head ?? null, legacyOnly, target.name];
    const operation = target.name === null
      ? `DELETE FROM security_device_display_names WHERE owner_id=$1 AND kind=$2 AND target_id=$3 AND (SELECT allowed FROM guard) RETURNING target_id`
      : `INSERT INTO security_device_display_names(owner_id,kind,target_id,display_name) SELECT $1,$2,$3,requested_name FROM guard WHERE allowed
         ON CONFLICT(owner_id,kind,target_id) DO UPDATE SET display_name=EXCLUDED.display_name,updated_at=NOW() RETURNING target_id`;
    const rows = await this.query(`WITH checks AS (SELECT CASE WHEN $4::text IS NULL THEN NOT EXISTS(SELECT 1 FROM security_account_history WHERE owner_id=$1)
       ELSE EXISTS(SELECT 1 FROM security_account_history WHERE owner_id=$1 AND root_id=$4 AND revision=$5 AND head=$6) END AS head_ok,
       CASE WHEN $7::boolean THEN EXISTS(SELECT 1 FROM bridge_refresh b JOIN users u ON b.sub=u.email WHERE u.id::text=$1 AND b.bridge_id=$3 AND b.current_jti<>'revoked') ELSE TRUE END AS target_ok),
       guard AS (SELECT head_ok,target_ok,head_ok AND target_ok AS allowed,$8::text AS requested_name FROM checks), mutation AS (${operation})
       SELECT head_ok,target_ok FROM guard`, params);
    if (rows.length !== 1 || typeof rows[0].head_ok !== 'boolean' || typeof rows[0].target_ok !== 'boolean') throw new DeviceNameStoreError('storage_unavailable');
    if (!rows[0].head_ok) throw new DeviceNameStoreError('conflict');
    if (!rows[0].target_ok) throw new DeviceNameStoreError('unknown_device');
    return { name: target.name === null ? null : { kind: target.kind as DeviceNameKind, id: target.id, name: target.name } };
  }
}
