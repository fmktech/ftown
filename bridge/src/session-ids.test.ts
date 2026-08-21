import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AgentSessionIdPersister } from './session-ids.js';
import type { Session } from './types.js';

describe('AgentSessionIdPersister — Pi', () => {
  it('persists Pi native session identity without claiming a Claude session id', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'Pi',
      command: 'pi',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
      shellType: 'pi',
    };
    const saved: Session[] = [];
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => {},
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: {
        session_id: 'pi-session-uuid',
        session_file: '/tmp/pi-session.jsonl',
      },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].piSessionId, 'pi-session-uuid');
    assert.equal(saved[0].piSessionFile, '/tmp/pi-session.jsonl');
    assert.equal(saved[0].claudeSessionId, undefined);
  });
});

describe('AgentSessionIdPersister — opencode', () => {
  it('persists the plugin-reported opencode session id without claiming a Claude session id', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'opencode',
      command: 'opencode --auto',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
      shellType: 'opencode',
    };
    const saved: Session[] = [];
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => {},
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'ses_opencode_123' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].opencodeSessionId, 'ses_opencode_123');
    assert.equal(saved[0].claudeSessionId, undefined);
    assert.equal(saved[0].codexSessionId, undefined);
  });

  it('never persists a foreign opencode id onto a claude session (workspace fallback)', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'Claude',
      command: 'claude',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
      shellType: 'claude',
    };
    const saved: Session[] = [];
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => {},
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'workspace',
      data: { session_id: 'foreign-id' },
    });

    assert.equal(saved.length, 0);
  });
});
