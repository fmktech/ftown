import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { finishUpdateRestartAdmission } from './index.js';
import { UpdateAdmission } from './update-admission.js';
import { createFtownSession, relaunchFtownSession, type CreateFtownSessionDeps } from './create-ftown-session.js';
import type { Session } from './types.js';

test('restart blocks create and revive until helper final readiness acknowledgement', async () => {
  const admission = new UpdateAdmission(); admission.freeze();
  const deps = { updateAdmission: admission } as CreateFtownSessionDeps;
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const finishing = finishUpdateRestartAdmission(admission, () => ready);
  await assert.rejects(createFtownSession(deps, {}), /update in progress/i);
  await assert.rejects(relaunchFtownSession(deps, {} as Session, 'retry'), /update in progress/i);
  assert.equal(admission.isFrozen, true);
  resolveReady(); await finishing;
  assert.equal(admission.isFrozen, false); admission.enter()();
});

test('failed private readiness leaves all admission frozen', async () => {
  const admission = new UpdateAdmission(); admission.freeze();
  await assert.rejects(finishUpdateRestartAdmission(admission, async () => { throw new Error('no acknowledgement'); }));
  assert.throws(() => admission.enter(), /update in progress/i);
});
