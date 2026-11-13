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

  it('dedupes repeat hook events via the opencode cache entry (no redundant save)', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'opencode',
      command: 'opencode --auto',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-08-08T00:00:00.000Z',
      updatedAt: '2026-08-08T00:00:00.000Z',
      shellType: 'opencode',
      opencodeSessionId: 'ses_opencode_123',
    };
    let saves = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async () => { saves += 1; },
      } as any,
      publishSessionUpdate: async () => {},
    });

    const event = {
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'env',
      data: { session_id: 'ses_opencode_123' },
    } as const;
    await persister.persist({ ...event });
    await persister.persist({ ...event });

    assert.equal(saves, 0);
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

describe('AgentSessionIdPersister — muse', () => {
  it('persists the plugin-reported muse session id from ANY event without claiming a Claude session id', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'muse',
      command: 'muse --yolo',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      shellType: 'muse',
    };
    const saved: Session[] = [];
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => {},
    });

    // Stop, not SessionStart: SessionStart does NOT re-fire on resume, so the
    // id must persist from whatever event carries it.
    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'env',
      data: { session_id: 'muse-session-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].museSessionId, 'muse-session-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
    assert.equal(saved[0].codexSessionId, undefined);
  });

  it('dedupes repeat hook events via the muse cache entry (no redundant save)', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'muse',
      command: 'muse --yolo',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
      shellType: 'muse',
      museSessionId: 'muse-session-uuid',
    };
    let saves = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async () => { saves += 1; },
      } as any,
      publishSessionUpdate: async () => {},
    });

    const event = {
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'muse-session-uuid' },
    } as const;
    await persister.persist({ ...event });
    await persister.persist({ ...event });

    assert.equal(saves, 0);
  });
});

describe('AgentSessionIdPersister — grok', () => {
  const baseSession = (): Session => ({
    id: 'ftown-session',
    name: 'grok',
    command: 'grok',
    status: 'running',
    bridgeId: 'bridge',
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    shellType: 'grok',
  });

  it('persists the native grok session id from SessionStart without claiming a Claude session id', async () => {
    const session = baseSession();
    const saved: Session[] = [];
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'grok-session-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].grokSessionId, 'grok-session-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
    assert.equal(published, 1);
  });

  it('persists the grok session id from a Stop event', async () => {
    const session = baseSession();
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
      source: 'env',
      data: { session_id: 'grok-session-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].grokSessionId, 'grok-session-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
  });

  it('dedupes repeat hook events via the grok cache entry (no redundant load, save or publish)', async () => {
    const session = { ...baseSession(), grokSessionId: 'grok-session-uuid' };
    let loads = 0;
    let saves = 0;
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => { loads += 1; return { ...session }; },
        saveSession: async () => { saves += 1; },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    const event = {
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'env',
      data: { session_id: 'grok-session-uuid' },
    } as const;
    await persister.persist({ ...event });
    await persister.persist({ ...event });

    assert.equal(loads, 1);
    assert.equal(saves, 0);
    assert.equal(published, 0);
  });

  it('does not re-save after a failed save is retried', async () => {
    // Pins that the cache is written only after a successful save: the first
    // attempt throws, so the second identical event must reach saveSession.
    let stored: Session = { ...baseSession() };
    let saveCalls = 0;
    const saved: Session[] = [];
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => ({ ...stored }),
        saveSession: async (next: Session) => {
          saveCalls += 1;
          if (saveCalls === 1) throw new Error('disk unavailable');
          stored = { ...next };
          saved.push({ ...next });
        },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    const event = {
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'env',
      data: { session_id: 'grok-session-uuid' },
    } as const;

    await assert.rejects(persister.persist({ ...event }), /disk unavailable/);
    assert.equal(published, 0);

    await persister.persist({ ...event });
    assert.equal(saveCalls, 2);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].grokSessionId, 'grok-session-uuid');
    assert.equal(published, 1);
  });

  it('replaces the stored grok id when a different id arrives', async () => {
    const session = { ...baseSession(), grokSessionId: 'grok-old-uuid' };
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
      data: { session_id: 'grok-new-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].grokSessionId, 'grok-new-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
  });

  it('persists nothing from a workspace-fallback event', async () => {
    const session = baseSession();
    const saved: Session[] = [];
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'workspace',
      data: { session_id: 'foreign-id' },
    });

    assert.equal(saved.length, 0);
    assert.equal(published, 0);
  });

  it('does not save or publish when the stored id already matches (fresh persister, empty cache)', async () => {
    const session = { ...baseSession(), grokSessionId: 'grok-session-uuid' };
    let saves = 0;
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async () => { saves += 1; },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'grok-session-uuid' },
    });

    assert.equal(saves, 0);
    assert.equal(published, 0);
  });
});

describe('AgentSessionIdPersister — antigravity', () => {
  const baseSession = (): Session => ({
    id: 'ftown-session',
    name: 'antigravity',
    command: 'antigravity',
    status: 'running',
    bridgeId: 'bridge',
    createdAt: '2026-11-13T00:00:00.000Z',
    updatedAt: '2026-11-13T00:00:00.000Z',
    shellType: 'antigravity',
  });

  it('persists the native antigravity session id from SessionStart without claiming a Claude session id', async () => {
    const session = baseSession();
    const saved: Session[] = [];
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'antigravity-session-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].antigravitySessionId, 'antigravity-session-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
    assert.equal(published, 1);
  });

  it('persists the antigravity session id from a Stop event', async () => {
    const session = baseSession();
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
      source: 'env',
      data: { session_id: 'antigravity-session-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].antigravitySessionId, 'antigravity-session-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
  });

  it('dedupes repeat hook events via the antigravity cache entry (no redundant load, save or publish)', async () => {
    const session = { ...baseSession(), antigravitySessionId: 'antigravity-session-uuid' };
    let loads = 0;
    let saves = 0;
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => { loads += 1; return { ...session }; },
        saveSession: async () => { saves += 1; },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    const event = {
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'env',
      data: { session_id: 'antigravity-session-uuid' },
    } as const;
    await persister.persist({ ...event });
    await persister.persist({ ...event });

    assert.equal(loads, 1);
    assert.equal(saves, 0);
    assert.equal(published, 0);
  });

  it('replaces the stored antigravity id when a different id arrives', async () => {
    const session = { ...baseSession(), antigravitySessionId: 'antigravity-old-uuid' };
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
      data: { session_id: 'antigravity-new-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].antigravitySessionId, 'antigravity-new-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
  });

  it('persists nothing from a workspace-fallback event', async () => {
    const session = baseSession();
    const saved: Session[] = [];
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'workspace',
      data: { session_id: 'foreign-id' },
    });

    assert.equal(saved.length, 0);
    assert.equal(published, 0);
  });

  it('does not save or publish when the stored id already matches (fresh persister, empty cache)', async () => {
    const session = { ...baseSession(), antigravitySessionId: 'antigravity-session-uuid' };
    let saves = 0;
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => session,
        saveSession: async () => { saves += 1; },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'antigravity-session-uuid' },
    });

    assert.equal(saves, 0);
    assert.equal(published, 0);
  });
});

describe('AgentSessionIdPersister — pi restart and session_file', () => {
  it('does not write a stored pi id into claudeSessionId on a fresh persister (no save, no publish)', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'pi',
      command: 'pi',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
      shellType: 'pi',
      piSessionId: 'pi-session-uuid',
    };
    let saves = 0;
    let published = 0;
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => ({ ...session }),
        saveSession: async () => { saves += 1; },
      } as any,
      publishSessionUpdate: async () => { published += 1; },
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'pi-session-uuid' },
    });

    assert.equal(saves, 0);
    assert.equal(published, 0);
    assert.equal(session.claudeSessionId, undefined);
  });

  it('persists a changed pi session_file on its own', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'pi',
      command: 'pi',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
      shellType: 'pi',
      piSessionId: 'pi-session-uuid',
      piSessionFile: '/tmp/pi-old.jsonl',
    };
    const saved: Session[] = [];
    const persister = new AgentSessionIdPersister({
      store: {
        loadSession: async () => ({ ...session }),
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async () => {},
    });

    await persister.persist({
      sessionId: 'ftown-session',
      eventName: 'Stop',
      source: 'env',
      data: { session_file: '/tmp/pi-new.jsonl' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].piSessionFile, '/tmp/pi-new.jsonl');
    assert.equal(saved[0].piSessionId, 'pi-session-uuid');
    assert.equal(saved[0].claudeSessionId, undefined);
  });
});

describe('AgentSessionIdPersister — claude regression', () => {
  it('still persists a plain claude session_id into claudeSessionId', async () => {
    const session: Session = {
      id: 'ftown-session',
      name: 'Claude',
      command: 'claude',
      status: 'running',
      bridgeId: 'bridge',
      createdAt: '2026-11-13T00:00:00.000Z',
      updatedAt: '2026-11-13T00:00:00.000Z',
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
      eventName: 'SessionStart',
      source: 'env',
      data: { session_id: 'claude-session-uuid' },
    });

    assert.equal(saved.length, 1);
    assert.equal(saved[0].claudeSessionId, 'claude-session-uuid');
    assert.equal(saved[0].grokSessionId, undefined);
    assert.equal(saved[0].antigravitySessionId, undefined);
  });
});
