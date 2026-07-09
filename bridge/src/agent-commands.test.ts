import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildGrokCommand, buildSessionCommand } from './agent-commands.js';

describe('buildSessionCommand — grok', () => {
  it('launches bare grok with --always-approve when no model/prompt', () => {
    assert.strictEqual(buildSessionCommand({ shellType: 'grok' }), 'grok --always-approve');
  });

  it("appends -m '<model>' when a model is provided", () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'grok', model: 'grok-4.5' }),
      "grok --always-approve -m 'grok-4.5'",
    );
  });

  it('appends the shell-quoted initial prompt as the last positional arg', () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'grok', model: 'grok-4.5', initialPrompt: 'hello world' }),
      "grok --always-approve -m 'grok-4.5' 'hello world'",
    );
  });

  it('shell-escapes a single quote in the initial prompt', () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'grok', initialPrompt: "it's fine" }),
      "grok --always-approve 'it'\\''s fine'",
    );
  });

  it('produces the same string as buildGrokCommand for matching inputs', () => {
    const options = { model: 'grok-4.5', initialPrompt: "it's fine" };
    assert.strictEqual(
      buildSessionCommand({ shellType: 'grok', ...options }),
      buildGrokCommand(options),
    );
  });
});
