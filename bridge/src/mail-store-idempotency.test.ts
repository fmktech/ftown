import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMailMessage, MailStore } from './mail-store.js';

test('MailStore deduplicates a stable idempotency key across store instances', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ftown-mail-idempotency-'));
  try {
    const resolveDir = (sessionId: string) => join(root, sessionId);
    const beforeRestart = new MailStore(resolveDir);
    const afterRestart = new MailStore(resolveDir);
    const input = {
      from: 'child',
      to: 'parent',
      type: 'escalation' as const,
      idempotencyKey: 'session-block:child:usage_limit||running',
      body: 'Session blocked',
    };
    const first = createMailMessage(input);
    const retry = createMailMessage(input);
    assert.equal(retry.id, first.id);

    await beforeRestart.append(first);
    await afterRestart.append(retry);
    assert.deepEqual(await afterRestart.listAll('parent', 0), [first]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
