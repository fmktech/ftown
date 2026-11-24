import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MAIL_TYPES, formatMailMessage, submitSuffix, type MailMessage } from './wire-types.js';

describe('submitSuffix', () => {
  it('returns plain CR for every shell type — ESC+CR is not a safe universal submit prefix', () => {
    assert.equal(submitSuffix('claude'), '\r');
    assert.equal(submitSuffix('cursor'), '\r');
    assert.equal(submitSuffix('codex'), '\r');
    assert.equal(submitSuffix('shell'), '\r');
    assert.equal(submitSuffix(undefined), '\r');
  });
});

describe('MAIL_TYPES', () => {
  it('lists the five mail types', () => {
    assert.deepEqual(MAIL_TYPES, ['message', 'task', 'result', 'escalation', 'fyi']);
  });
});

describe('formatMailMessage', () => {
  it('prefers fromName over from when present', () => {
    const m: MailMessage = {
      id: '1',
      ts: '2026-01-01T00:00:00.000Z',
      from: 'agent-a',
      fromName: 'Agent A',
      to: 'agent-b',
      type: 'message',
      body: 'hello',
    };
    assert.equal(formatMailMessage(m), '[2026-01-01T00:00:00.000Z] Agent A (message): hello');
  });

  it('falls back to from when fromName is absent', () => {
    const m: MailMessage = {
      id: '2',
      ts: '2026-01-01T00:00:00.000Z',
      from: 'agent-a',
      to: 'agent-b',
      type: 'task',
      body: 'do the thing',
    };
    assert.equal(formatMailMessage(m), '[2026-01-01T00:00:00.000Z] agent-a (task): do the thing');
  });
});

describe('project discussion inbox notices', () => {
  const project = 'ae434dc2-deec-45fd-8848-b650a00c755d';
  const thread = 'b3c79010-c608-481a-a99b-24164c1d9c4a';
  const notice: MailMessage = {
    id: '1', ts: '2026-01-01T00:00:00Z', from: 'project-discussion', to: 'pm', type: 'message',
    body: 'Hi pm', threadId: thread, idempotencyKey: 'discussion:' + project + ':82f41e59-e955-4af6-9d66-dacd4178a3f1',
  };
  const prefix = '[2026-01-01T00:00:00Z] project-discussion (message): ';
  const reply = 'Reply in this discussion thread: ftown discuss reply ' + thread + ' --project ' + project;

  it('recovers the original thread and project from stored pre-upgrade notices', () => {
    assert.equal(formatMailMessage(notice), prefix + 'Hi pm\n\n' + reply + ' --text "your reply"');
  });

  it('keeps an existing reply instruction when an older inbox drops the discussion metadata', () => {
    const body = 'Hi pm\n\n' + reply + ' --bridge 5291a356-c90a-4f97-810f-077a0fe43bfd --text "your reply"';
    assert.equal(formatMailMessage({ ...notice, body }), prefix + body);
  });

  it('only derives reply instructions from valid discussion identifiers', () => {
    for (const invalid of [{ threadId: thread + ' unsafe' }, { idempotencyKey: 'discussion:' + project + ':bad' }]) {
      assert.equal(formatMailMessage({ ...notice, ...invalid }), prefix + notice.body);
    }
    assert.equal(formatMailMessage({ ...notice, from: 'worker' }), '[2026-01-01T00:00:00Z] worker (message): Hi pm');
  });
});
