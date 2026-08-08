import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HookUsagePersister } from './hook-usage.js';
import type { Session } from './types.js';

describe('HookUsagePersister', () => {
  it('persists cumulative Pi usage received from the authenticated extension hook', async () => {
    const session: Session = {
      id: 'ftown-session', name: 'Pi', command: 'pi', shellType: 'pi', status: 'running',
      bridgeId: 'bridge', createdAt: '2026-08-08T00:00:00.000Z', updatedAt: '2026-08-08T00:00:00.000Z',
    };
    const saved: Session[] = [];
    const published: Session[] = [];
    const persister = new HookUsagePersister({
      store: {
        loadSession: async () => session,
        saveSession: async (next) => { saved.push({ ...next }); },
      } as any,
      publishSessionUpdate: async (next) => { published.push({ ...next }); },
      now: () => new Date('2026-08-08T12:00:00.000Z'),
    });

    const usage = await persister.persist({
      sessionId: 'ftown-session', eventName: 'Stop', source: 'env',
      data: {
        usage: {
          inputTokens: 77, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 1,
          totalTokens: 999, models: ['openai/gpt-5'],
          perModel: [{
            model: 'openai/gpt-5', inputTokens: 77, outputTokens: 9,
            cacheReadTokens: 3, cacheWriteTokens: 1,
          }],
          harness: 'untrusted-value',
        },
      },
    });

    assert.deepEqual(usage, {
      inputTokens: 77, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 1,
      totalTokens: 90, models: ['openai/gpt-5'],
      perModel: [{
        model: 'openai/gpt-5', inputTokens: 77, outputTokens: 9,
        cacheReadTokens: 3, cacheWriteTokens: 1,
      }],
      harness: 'pi', collectedAt: '2026-08-08T12:00:00.000Z',
    });
    assert.deepEqual(saved[0].usage, usage);
    assert.equal(published.length, 1);
  });
});
