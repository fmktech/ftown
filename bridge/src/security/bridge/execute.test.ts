import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplicationJson, SecureEnvelope, VerifiedApplication } from '../protocol.js';
import type { BridgeSecurityService } from './security.js';
import { executeSecurePacket } from './execute.js';
import { UpdateAdmission, UpdateResponseTicket } from '../../update-admission.js';
import { UpdateEffects } from '../../update-effects.js';

const packet = { type: 'ftown_encrypted', purpose: 'application', messageId: 'id', senderId: 'sender' } as SecureEnvelope;
const verified = { envelope: packet, principal: {}, application: { route: { kind: 'command', requestId: 'id', command: 'update_bridge', sessionId: null }, data: {
  type: 'update_bridge', requestId: 'id', payload: { bridgeId: 'bridge', operationId: 'op', targetVersion: '1.2.3' },
} } } as unknown as VerifiedApplication;
const route = { transport: 'cloud', channel: 'commands:rpc#owner', bridgeId: 'bridge', pairId: null } as const;
const response = (success: boolean): ApplicationJson => ({ type: 'command_response', response: { requestId: 'id', success, data: { bridgeId: 'bridge', operation: { id: 'op', targetVersion: '1.2.3' } } } });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('audit and awaited sealing precede the delivery signal and start', async () => {
  const events: string[] = []; const effects = new UpdateEffects(new UpdateAdmission());
  const security = { acceptApplication: async () => verified, revalidate: async () => {}, revokeSelfWithReceipt: async () => null,
    complete: async () => { events.push('audit'); }, sealTo: async () => { await tick(); events.push('seal'); return packet; } } as unknown as BridgeSecurityService;
  await executeSecurePacket(security, packet, route, async message => { effects.attachTicket(message, new UpdateResponseTicket(() => events.push('start'), () => events.push('cancel'))); return response(true); }, undefined, effects);
  assert.deepEqual(events, ['audit', 'seal']); effects.delivered('id'); await tick(); assert.deepEqual(events, ['audit', 'seal', 'start']);
});

test('failed business response and asynchronous seal rejection cancel tickets', async () => {
  for (const sealReject of [false, true]) {
    let seals = 0, starts = 0, cancels = 0; const effects = new UpdateEffects(new UpdateAdmission());
    const security = { acceptApplication: async () => verified, revalidate: async () => {}, revokeSelfWithReceipt: async () => null,
      complete: async () => {}, sealTo: async () => { if (sealReject && ++seals === 1) { await tick(); throw new Error('seal failed'); } return packet; } } as unknown as BridgeSecurityService;
    await executeSecurePacket(security, packet, route, async message => { effects.attachTicket(message, new UpdateResponseTicket(() => { starts++; }, () => { cancels++; })); return response(sealReject); }, undefined, effects);
    effects.delivered('id'); await tick(); assert.equal(starts, 0); assert.equal(cancels, 1);
  }
});

test('without an observer an asynchronous seal rejection retains original propagation', async () => {
  let audits = 0, seals = 0;
  const security = { acceptApplication: async () => verified, revalidate: async () => {}, revokeSelfWithReceipt: async () => null,
    complete: async () => { audits++; }, sealTo: async () => { seals++; await tick(); throw new Error('original seal failure'); } } as unknown as BridgeSecurityService;
  await assert.rejects(executeSecurePacket(security, packet, route, async () => response(true)), /original seal failure/);
  assert.equal(audits, 1); assert.equal(seals, 1);
});
