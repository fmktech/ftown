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
  it('lists the four mail types', () => {
    assert.deepEqual(MAIL_TYPES, ['message', 'task', 'result', 'escalation']);
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
