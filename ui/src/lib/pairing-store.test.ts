import { beforeEach, it, expect, vi } from 'vitest';
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db', () => ({ getDb: () => ({ query }) }));
import { approvePairingRequest, consumePairingRequest, createPairingRequest, type PairingAccountBinding } from './pairing-store';
beforeEach(() => vi.resetAllMocks());
const binding: PairingAccountBinding = {
  ownerId: '349f8d2e-38e4-4d59-888d-687dcfa19e39', head: { rootId: 'root', revision: 2, head: 'head' },
  // These tests assert the storage transition/CAS seam; public crypto is validated at its callers.
  enrollment: { version: 1, kind: 'bridge', requestId: 'request', challenge: 'challenge', expiresAt: '2030-01-01T00:00:00.000Z', label: 'Computer', bridgeId: 'bridge-a', candidate: { version: 1, id: 'candidate', ownerId: 'pending:bridge-a', kind: 'bridge', publicKey: 'public' } },
  bundle: { version: 1, requestId: 'request', ownerId: '349f8d2e-38e4-4d59-888d-687dcfa19e39', approver: { version: 1, id: 'admin', ownerId: '349f8d2e-38e4-4d59-888d-687dcfa19e39', kind: 'browser', publicKey: 'public' },
    envelope: { type: 'ftown_encrypted', version: 1, ownerId: '349f8d2e-38e4-4d59-888d-687dcfa19e39', bridgeId: 'bridge-a', channel: 'account-enrollment:request', purpose: 'enrolled', senderId: 'admin', recipientId: 'candidate', messageId: 'request', createdAt: 1, expiresAt: 2, receiverEpoch: null, enc: 'enc', ciphertext: 'ciphertext' } },
};
it('legacy approvals and consumption cannot silently accept account-enrolled rows and both enforce TTL in SQL', async () => {
  query.mockResolvedValue([]);
  expect(await approvePairingRequest('ABCD-1234', 'owner@example.test', 'jti')).toBeNull();
  expect(query.mock.calls[0][0]).toContain('enrollment IS NULL');
  expect(query.mock.calls[0][0]).toContain('expires_at > NOW()');
  expect(query.mock.calls[0][0]).toContain('NOT EXISTS(SELECT 1 FROM security_pending_approvals');
  expect(await consumePairingRequest('device-code')).toBeNull();
  expect(query.mock.calls[1][0]).toContain('enrollment IS NULL');
  expect(query.mock.calls[1][0]).toContain('expires_at > NOW()');
  expect(query.mock.calls[1][0]).toContain('NOT EXISTS(SELECT 1 FROM security_pending_approvals');
});
it('account approval/reseal is owner/head/request bound and consumption requires exact encrypted bundle', async () => {
  query.mockResolvedValue([]);
  await approvePairingRequest('ABCD-1234', 'owner@example.test', 'jti', binding);
  const [approvalSql, approvalParams] = query.mock.calls[0];
  expect(approvalSql).toContain('enrollment=$5::jsonb');
  expect(approvalSql).toContain('NOT EXISTS(SELECT 1 FROM security_pending_approvals');
  expect(approvalSql).toContain('h.owner_id=$6 AND h.root_id=$7 AND h.revision=$8 AND h.head=$9');
  expect(approvalSql).toContain("account_approval->'approver'");
  expect(approvalParams.slice(5)).toEqual([binding.ownerId, binding.head.rootId, 2, binding.head.head]);
  await consumePairingRequest('device-code', binding);
  const [consumeSql, consumeParams] = query.mock.calls[1];
  expect(consumeSql).toContain("status='approved' AND expires_at>NOW()");
  expect(consumeSql).toContain('NOT EXISTS(SELECT 1 FROM security_pending_approvals');
  expect(consumeSql).toContain('enrollment=$2::jsonb AND account_approval=$3::jsonb');
  expect(consumeSql).toContain('h.owner_id=$4 AND h.root_id=$5 AND h.revision=$6 AND h.head=$7');
  expect(consumeParams.slice(3)).toEqual([binding.ownerId, binding.head.rootId, 2, binding.head.head]);
});
it('new request creation stores only public enrollment; legacy requests explicitly store null', async () => {
  query.mockResolvedValue([]);
  const request = { deviceCode: 'device', userCode: 'ABCD-1234', bridgeId: 'bridge-a', hostname: 'Computer', platform: 'linux', expiresAtIso: binding.enrollment.expiresAt };
  await createPairingRequest({ ...request, enrollment: binding.enrollment });
  expect(JSON.parse(query.mock.calls[0][1][6])).toEqual(binding.enrollment);
  await createPairingRequest(request);
  expect(query.mock.calls[1][1][6]).toBeNull();
});
