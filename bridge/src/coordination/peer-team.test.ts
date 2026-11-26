import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TreeEventLog } from './tree-events.js';
import { PeerTeamOutbox, TEAM_EVENT_PATH, teamEvent } from './peer-team.js';
import { CHILD_PLAN_PATH } from '../remote-child-plan.js';
import type { PeerControl } from '../peer-control.js';

test('restarts after losing a manager receipt, with one event and its following plan completion', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'team-outbox-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const path = join(dir, 'pending.sqlite');
  const log = () => new TreeEventLog({sessionDir: manager => join(dir, manager), now: Date.now});
  let reachable = false;
  const actions: unknown[] = [];
  const peers: Pick<PeerControl, 'http'> = {
    async http(owner, method, route, body) {
      assert.equal(owner, 'B');
      assert.equal(method, 'POST');
      if (route === TEAM_EVENT_PATH) {
        const packet = teamEvent.parse(body);
        await log().append(packet.manager, {...packet.event, deliveryId: packet.deliveryId});
        if (!reachable) throw new Error('Receipt lost');
      } else {
        assert.equal(route, CHILD_PLAN_PATH);
        actions.push(body);
      }
      return {status: 200, body: {ok: true}};
    },
  };
  const child = {id: 'C', bridgeId: 'A', parentBridgeId: 'B', parentSessionId: 'middle'};
  const original = new PeerTeamOutbox(path, peers);
  original.event(child, {sessionId: 'C', sessionName: 'Worker', kind: 'status', summary: 'done'});
  original.plan(child, 'complete');
  await original.flush();
  await original.close();
  assert.equal(await log().head('middle'), 1);
  assert.deepEqual(actions, []);
  reachable = true;
  const reopened = new PeerTeamOutbox(path, peers);
  await reopened.flush();
  await reopened.close();
  assert.equal(await log().head('middle'), 1);
  assert.deepEqual(actions, [{action: 'complete', parentId: 'middle', childId: 'C'}]);
});
