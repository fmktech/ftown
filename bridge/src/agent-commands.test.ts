import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionCommand, shellQuote } from './agent-commands.js';

describe('buildSessionCommand — claude model flag', () => {
  it('omits --model when model is unset', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude' }),
      'claude --allow-dangerously-skip-permissions',
    );
  });

  it('omits --model when model is blank', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude', model: '  ' }),
      'claude --allow-dangerously-skip-permissions',
    );
  });

  it('appends --model when the session has a model', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude', model: 'sonnet' }),
      `claude --allow-dangerously-skip-permissions --model 'sonnet'`,
    );
  });

  it('keeps --model alongside --resume', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude', model: 'opus', claudeSessionId: 'abc-123' }),
      `claude --allow-dangerously-skip-permissions --model 'opus' --resume 'abc-123'`,
    );
  });

  it('keeps --model alongside an initial prompt', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude', model: 'sonnet', initialPrompt: 'do the thing' }),
      `claude --allow-dangerously-skip-permissions --model 'sonnet' ${shellQuote('do the thing')}`,
    );
  });

  it('resume wins over initial prompt (unchanged precedence)', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude', claudeSessionId: 'abc', initialPrompt: 'hi' }),
      `claude --allow-dangerously-skip-permissions --resume 'abc'`,
    );
  });

  it('shell-quotes a hostile model value', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude', model: `x'; rm -rf /` }),
      `claude --allow-dangerously-skip-permissions --model 'x'\\''; rm -rf /'`,
    );
  });

  it('does not touch the custom-command override path', () => {
    assert.equal(
      buildSessionCommand({ shellType: 'claude', model: 'sonnet', command: 'my-wrapper' }),
      'my-wrapper',
    );
  });
});
