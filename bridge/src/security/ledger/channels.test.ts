import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accountChannel, sessionChannel } from './channels';

describe('accountChannel', () => {
  it('builds kind#account for every account-scoped kind', () => {
    assert.equal(accountChannel('sessions:updates', 'a@x.io'), 'sessions:updates#a@x.io');
    assert.equal(accountChannel('commands:rpc', 'acc1'), 'commands:rpc#acc1');
    assert.equal(accountChannel('bridges:presence', 'acc1'), 'bridges:presence#acc1');
    assert.equal(accountChannel('bridges:security', 'acc1'), 'bridges:security#acc1');
    assert.equal(accountChannel('bridges:ledger', 'acc1'), 'bridges:ledger#acc1');
  });

  it('throws invalid_channel_part for empty or forbidden accountId characters', () => {
    for (const bad of ['', 'a#b', 'a:b', 'a,b', 'a b', 'a\tb', 'a\nb']) {
      assert.throws(() => accountChannel('commands:rpc', bad), /invalid_channel_part/, JSON.stringify(bad));
    }
  });
});

describe('sessionChannel', () => {
  it('builds kind:session#account for every session-scoped kind', () => {
    assert.equal(sessionChannel('terminal', 's1', 'acc1'), 'terminal:s1#acc1');
    assert.equal(sessionChannel('terminal-input', 's1', 'acc1'), 'terminal-input:s1#acc1');
    assert.equal(sessionChannel('events', 's1', 'acc1'), 'events:s1#acc1');
    assert.equal(sessionChannel('stream', 's1', 'acc1'), 'stream:s1#acc1');
  });

  it('throws invalid_channel_part for empty or forbidden sessionId characters', () => {
    for (const bad of ['', 'a#b', 'a,b', 'a b', 'a\tb']) {
      assert.throws(() => sessionChannel('events', bad, 'acc1'), /invalid_channel_part/, JSON.stringify(bad));
    }
  });

  it('throws invalid_channel_part for empty or forbidden accountId characters', () => {
    for (const bad of ['', 'a#b', 'a:b', 'a,b', 'a b']) {
      assert.throws(() => sessionChannel('events', 's1', bad), /invalid_channel_part/, JSON.stringify(bad));
    }
  });
});
