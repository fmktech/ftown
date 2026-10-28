import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertUpdateReservationAllowed, finalizeUpdateReady, protectOrStopReplacement, readUpdateReceipt, reserveUpdate, selectUpdateLaunchEnvironment, waitForUpdateChild, writeUpdateReceipt } from './update-handoff.js';

describe('private update reservation and receipt', () => {
  it('enforces exclusive ownership and rejects setup in progress', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ftown-reservation-')));
    try {
      const id = randomUUID(); const reservation = await reserveUpdate(home, id);
      assert.throws(() => assertUpdateReservationAllowed(home), /in progress/);
      await assert.rejects(reserveUpdate(home, randomUUID()));
      assert.equal(statSync(join(home, '.ftown', 'update-reservation.json')).mode & 0o077, 0);
      await reservation.release(); assert.doesNotThrow(() => assertUpdateReservationAllowed(home));
      mkdirSync(join(home, '.ftown', 'setup.lock'));
      await assert.rejects(reserveUpdate(home, randomUUID()), /Setup is in progress/);
      assert.doesNotThrow(() => assertUpdateReservationAllowed(home));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('preserves malformed and symlink reservations and refuses foreign release', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ftown-reservation-')));
    try {
      const ftown = join(home, '.ftown'); mkdirSync(ftown, { mode: 0o700 });
      const path = join(ftown, 'update-reservation.json'); writeFileSync(path, '{}', { mode: 0o600 });
      await assert.rejects(reserveUpdate(home, randomUUID())); assert.equal(readFileSync(path, 'utf8'), '{}');
      rmSync(path); const target = join(home, 'external'); writeFileSync(target, 'sentinel'); symlinkSync(target, path);
      await assert.rejects(reserveUpdate(home, randomUUID())); assert.equal(readFileSync(target, 'utf8'), 'sentinel');
      rmSync(path); const reservation = await reserveUpdate(home, randomUUID());
      const record = JSON.parse(readFileSync(path, 'utf8')); record.token = 'a'.repeat(64);
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      await assert.rejects(reservation.release(), /ownership lost/); assert.equal(JSON.parse(readFileSync(path, 'utf8')).token, 'a'.repeat(64));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('reclaims a proven-dead reservation without accepting malformed or live owners', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ftown-dead-owner-')));
    try {
      const ftown = join(home, '.ftown'); mkdirSync(ftown, { mode: 0o700 });
      const path = join(ftown, 'update-reservation.json');
      const deadPid = 2147483647;
      assert.throws(() => process.kill(deadPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
      writeFileSync(path, JSON.stringify({ schema: 1, operationId: randomUUID(), ownerPid: deadPid, token: 'a'.repeat(64) }), { mode: 0o600 });
      assert.doesNotThrow(() => assertUpdateReservationAllowed(home));
      const fresh = await reserveUpdate(home, randomUUID()); await fresh.release();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('recovers a dead exact guard and preserves live or unknown guard ownership', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ftown-guard-')));
    try {
      const ftown = join(home, '.ftown'); mkdirSync(ftown, { mode: 0o700 }); const guard = join(ftown, 'update-reservation.guard');
      const dead = 2147483647; assert.throws(() => process.kill(dead, 0), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ESRCH');
      const token = 'a'.repeat(32); mkdirSync(guard, { mode: 0o700 });
      writeFileSync(join(guard, `owner-${dead}-${token}.json`), JSON.stringify({ pid: dead, token }), { mode: 0o600 });
      assert.doesNotThrow(() => assertUpdateReservationAllowed(home));
      const reservation = await reserveUpdate(home, randomUUID()); await reservation.release();
      mkdirSync(guard, { mode: 0o700 });
      const liveMarker = join(guard, `owner-${process.pid}-${token}.json`);
      writeFileSync(liveMarker, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      assert.throws(() => assertUpdateReservationAllowed(home), /changing/); await assert.rejects(reserveUpdate(home, randomUUID()));
      assert.equal(statSync(liveMarker).isFile(), true);
      rmSync(guard, { recursive: true }); mkdirSync(guard, { mode: 0o700 });
      assert.throws(() => assertUpdateReservationAllowed(home), /Unknown/); await assert.rejects(reserveUpdate(home, randomUUID()));
      assert.equal(statSync(guard).isDirectory(), true);
      const malformed = join(guard, `owner-${dead}-${token}.json`);
      writeFileSync(malformed, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 });
      assert.throws(() => assertUpdateReservationAllowed(home), /Unknown/); await assert.rejects(reserveUpdate(home, randomUUID()));
      assert.equal(statSync(malformed).isFile(), true);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it('bounds child termination proof when close never arrives', async () => {
    const missing = new EventEmitter() as ChildProcess; let stopped = 0;
    await assert.rejects(waitForUpdateChild(missing, () => { stopped++; }, 5, 5), (e: unknown) => (e as { code?: string }).code === 'update_process_uncertain');
    assert.equal(stopped, 1);
    const exited = new EventEmitter() as ChildProcess;
    await assert.rejects(waitForUpdateChild(exited, () => { exited.emit('close', null); }, 5, 5), (e: unknown) => (e as { code?: string }).code !== 'update_process_uncertain');
  });
  it('persists before ACK and releases only after ACK is confirmed', async () => {
    const events: string[] = []; let releasePersist!: () => void; let releaseAck!: () => void;
    const persisted = new Promise<void>(resolve => { releasePersist = resolve; });
    const ack = new Promise<void>(resolve => { releaseAck = resolve; });
    const done = finalizeUpdateReady({
      persist: async () => { events.push('persist-start'); await persisted; events.push('persist-done'); },
      markAckAttempted: () => { events.push('mark-attempt'); },
      acknowledge: async () => { events.push('ack-start'); await ack; events.push('ack-done'); },
      release: async () => { events.push('release'); },
    });
    assert.deepEqual(events, ['persist-start']);
    releasePersist(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(events, ['persist-start', 'persist-done', 'mark-attempt', 'ack-start']);
    releaseAck(); await done;
    assert.deepEqual(events, ['persist-start', 'persist-done', 'mark-attempt', 'ack-start', 'ack-done', 'release']);
  });
  it('retains reservation and never kills replacement on uncertain ACK or release', async () => {
    for (const failure of ['ack', 'release'] as const) {
      let attempted = false; let reservation = true; let kills = 0; let retained = 0;
      try {
        await finalizeUpdateReady({
          persist: async () => undefined,
          markAckAttempted: () => { attempted = true; },
          acknowledge: async () => { if (failure === 'ack') throw new Error('uncertain send'); },
          release: async () => { if (failure === 'release') throw new Error('release failed'); reservation = false; },
        });
        assert.fail('expected failure');
      } catch {
        await protectOrStopReplacement(attempted, {
          stop: async () => { kills++; throw new Error('child exit unproven'); },
          retain: async () => { retained++; },
        });
      }
      assert.equal(reservation, true, failure); assert.equal(kills, 0, failure); assert.equal(retained, 1, failure);
    }
    let attempted = false; let kills = 0; let retained = 0;
    try {
      await finalizeUpdateReady({
        persist: async () => { throw new Error('receipt failed'); }, markAckAttempted: () => { attempted = true; },
        acknowledge: async () => undefined, release: async () => undefined,
      });
      assert.fail('expected failure');
    } catch {
      await protectOrStopReplacement(attempted, { stop: async () => { kills++; }, retain: async () => { retained++; } });
    }
    assert.equal(attempted, false); assert.equal(kills, 1); assert.equal(retained, 0);
  });
  it('preserves only the explicit trusted-LAN opt-in in addition to nonsecret launch settings', () => {
    const selected = selectUpdateLaunchEnvironment({ PATH: '/bin', FTOWN_ALLOW_INSECURE_API: '1', FTOWN_TOKEN: 'secret', NODE_OPTIONS: '--inspect', NPM_CONFIG_REGISTRY: 'unsafe', LANG: 'en_US' });
    assert.deepEqual(selected, { PATH: '/bin', FTOWN_ALLOW_INSECURE_API: '1', LANG: 'en_US' });
    assert.deepEqual(selectUpdateLaunchEnvironment({ FTOWN_ALLOW_INSECURE_API: '0' }), {});
  });
  it('writes and reads a private atomic receipt with exact operation identity', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'ftown-receipt-'))); const root = join(home, '.ftown', 'updates');
    try {
      const id = randomUUID(); const receipt = { schema: 1 as const, bridgeId: 'bridge', operation: { id, targetVersion: '1.2.3', phase: 'staging' as const, startedAt: '2026-10-28T00:00:00.000Z', updatedAt: '2026-10-28T00:00:00.000Z', error: null } };
      await writeUpdateReceipt(root, receipt); assert.deepEqual(await readUpdateReceipt(root), receipt);
      assert.equal(statSync(join(root, 'operation.json')).mode & 0o077, 0);
      await assert.rejects(writeUpdateReceipt(root, { ...receipt, operation: { ...receipt.operation, targetVersion: 'latest' } }));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
