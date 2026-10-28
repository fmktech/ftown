import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import type { VerifiedApplication } from './security/protocol.js';
import { UpdateAdmission, UpdateResponseTicket } from './update-admission.js';
import { observeHttpDelivery, scopedUpdateObserver, UpdateEffects } from './update-effects.js';

const makeMessage = (id: string, command = 'update_bridge') => ({ envelope: { messageId: id }, application: {
  route: { kind: 'command', command, requestId: id, sessionId: null },
  data: { type: command, requestId: id, payload: { bridgeId: 'bridge', operationId: 'operation', targetVersion: '1.2.3' } },
} }) as unknown as VerifiedApplication;
const success = (id: string) => ({ type: 'command_response', response: { requestId: id, success: true, data: { bridgeId: 'bridge', operation: { id: 'operation', targetVersion: '1.2.3' } } } } as const);
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('only audited sealed and delivered response starts once, after admission release', async () => {
  const admission = new UpdateAdmission(); const effects = new UpdateEffects(admission); const msg = makeMessage('r');
  let started = 0, aborted = 0, drained = false;
  effects.admitted(msg);
  effects.attachTicket(msg, new UpdateResponseTicket(() => { started++; void admission.drain(20).then(() => { drained = true; }); }, () => { aborted++; }));
  admission.freeze(); await assert.rejects(admission.drain(1));
  effects.sealed(msg, success('r')); assert.equal(started, 0);
  effects.delivered('r'); effects.delivered('r'); await turn(); await turn();
  assert.equal(started, 1); assert.equal(aborted, 0); assert.equal(drained, true);
});

test('failed, mismatched and forged responses cannot arm a ticket', async () => {
  for (const failure of ['failed', 'mismatch', 'forged'] as const) {
    const admission = new UpdateAdmission(); const effects = new UpdateEffects(admission); const msg = makeMessage('r'); let starts = 0, aborts = 0;
    effects.admitted(msg); effects.attachTicket(msg, new UpdateResponseTicket(() => { starts++; }, () => { aborts++; }));
    if (failure === 'mismatch') effects.sealed(msg, success('wrong'));
    if (failure === 'forged') { const other = scopedUpdateObserver(effects)!; other.failed('r'); effects.failed('r'); }
    if (failure === 'failed') effects.failed('r');
    effects.delivered('r'); await turn(); assert.equal(starts, 0); assert.equal(aborts, 1);
  }
});

test('read-only requests do not drain while consuming inbox and mutations do', async () => {
  const admission = new UpdateAdmission(); const effects = new UpdateEffects(admission);
  const read = makeMessage('read', 'list_sessions'); effects.admitted(read); admission.freeze(); await admission.drain(2); admission.reopen(); effects.delivered('read');
  const consume = { ...makeMessage('mail'), application: { route: { kind: 'http', method: 'GET', path: '/api/sessions/a/inbox', requestId: 'mail' }, data: {} } } as unknown as VerifiedApplication;
  effects.admitted(consume); admission.freeze(); await assert.rejects(admission.drain(1)); effects.failed('mail'); await admission.drain(2);
});

test('HTTP finish versus premature close waits for dispatch to stop and never double completes', async () => {
  for (const event of ['finish', 'close', 'error'] as const) {
    const admission = new UpdateAdmission(); const effects = new UpdateEffects(admission); const msg = makeMessage(event); let starts = 0, aborts = 0;
    effects.admitted(msg); effects.attachTicket(msg, new UpdateResponseTicket(() => { starts++; }, () => { aborts++; }));
    const response = Object.assign(new EventEmitter(), { destroyed: false }) as unknown as ServerResponse;
    const settled = observeHttpDelivery(response, effects, event);
    if (event !== 'finish') response.emit(event, new Error('closed'));
    admission.freeze(); await assert.rejects(admission.drain(1));
    effects.sealed(msg, success(event)); settled(true);
    if (event === 'finish') response.emit('finish');
    response.emit('close'); await turn(); await admission.drain(10);
    assert.equal(starts, event === 'finish' ? 1 : 0); assert.equal(aborts, event === 'finish' ? 0 : 1);
  }
});
