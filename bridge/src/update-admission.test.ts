import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { UpdateAdmission, UpdateResponseTicket } from './update-admission.js';

test('freeze blocks admission and drain waits for all prior work', async () => {
  const admission = new UpdateAdmission();
  const release = admission.enter();
  admission.freeze();
  assert.throws(() => admission.enter());
  let drained = false;
  const waiting = admission.drain(1000).then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  release(); release(); await waiting;
  admission.reopen(); admission.enter()();
});

test('ticket requires both signals, schedules once and cannot start after cancel', async () => {
  let starts = 0, cancels = 0;
  const ticket = new UpdateResponseTicket(() => { starts++; }, () => { cancels++; });
  ticket.markDelivered(); await Promise.resolve(); assert.equal(starts, 0);
  ticket.markSealed(); ticket.markSealed(); ticket.markDelivered(); await Promise.resolve();
  assert.equal(starts, 1); ticket.cancel(); assert.equal(cancels, 0);
  const cancelled = new UpdateResponseTicket(() => { starts++; }, () => { cancels++; });
  cancelled.markSealed(); cancelled.cancel(); cancelled.markDelivered(); await Promise.resolve();
  assert.equal(starts, 1); assert.equal(cancels, 1);
});

test('timed out drain can be retried without stale waiters', async () => {
  const admission = new UpdateAdmission(); const release = admission.enter(); admission.freeze();
  await assert.rejects(admission.drain(5)); release(); await admission.drain(5);
});
