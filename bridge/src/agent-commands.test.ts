import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGrokCommand,
  buildMuseCommand,
  buildPiCommand,
  buildSessionCommand,
  shellQuote,
} from './agent-commands.js';

describe('buildSessionCommand — pi', () => {
  it('launches Pi as an interactive coding agent', () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'pi' }),
      'pi --extension "$HOME/.ftown/pi/ftown.js"',
    );
  });

  it('passes the model and initial prompt through Pi CLI arguments', () => {
    const options = { model: 'anthropic/claude-sonnet-4', initialPrompt: "review today's diff" };
    assert.strictEqual(
      buildSessionCommand({ shellType: 'pi', ...options }),
      "pi --extension \"$HOME/.ftown/pi/ftown.js\" --model 'anthropic/claude-sonnet-4' 'review today'\\''s diff'",
    );
    assert.strictEqual(buildSessionCommand({ shellType: 'pi', ...options }), buildPiCommand(options));
  });

  it('continues the workdir session without replaying its original prompt', () => {
    assert.strictEqual(
      buildSessionCommand({
        shellType: 'pi',
        model: 'openai/gpt-5',
        initialPrompt: 'do not replay',
        resume: true,
      }),
      "pi --extension \"$HOME/.ftown/pi/ftown.js\" -c --model 'openai/gpt-5'",
    );
  });

  it('resumes the exact native Pi session when its UUID is known', () => {
    assert.strictEqual(
      buildSessionCommand({
        shellType: 'pi',
        piSessionId: '550e8400-e29b-41d4-a716-446655440000',
        resume: true,
      }),
      "pi --extension \"$HOME/.ftown/pi/ftown.js\" --session '550e8400-e29b-41d4-a716-446655440000'",
    );
  });
});

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

describe('buildSessionCommand — muse', () => {
  it('launches bare muse with --yolo when no workdir/model/prompt', () => {
    assert.strictEqual(buildSessionCommand({ shellType: 'muse' }), 'muse --yolo');
  });

  it("appends --workspace '<workdir>' when a workdir is provided", () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'muse', workingDir: '/tmp/w' }),
      "muse --yolo --workspace '/tmp/w'",
    );
  });

  it("appends --model '<model>' when a model is provided", () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'muse', workingDir: '/tmp/w', model: 'm1' }),
      "muse --yolo --workspace '/tmp/w' --model 'm1'",
    );
  });

  it('appends the shell-quoted initial prompt as the last positional arg', () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'muse', workingDir: '/tmp/w', model: 'm1', initialPrompt: 'hello world' }),
      "muse --yolo --workspace '/tmp/w' --model 'm1' 'hello world'",
    );
  });

  it('shell-escapes a single quote in the initial prompt', () => {
    assert.strictEqual(
      buildSessionCommand({ shellType: 'muse', initialPrompt: "it's fine" }),
      "muse --yolo 'it'\\''s fine'",
    );
  });

  it('resume restores the native session without model or prompt', () => {
    assert.strictEqual(
      buildSessionCommand({
        shellType: 'muse',
        workingDir: '/tmp/w',
        model: 'm1',
        initialPrompt: 'do not replay',
        museSessionId: 'sess-abc',
      }),
      "muse --yolo --workspace '/tmp/w' resume 'sess-abc'",
    );
  });

  it('produces the same string as buildMuseCommand for matching inputs', () => {
    const options = { workingDir: '/tmp/w', model: 'm1', initialPrompt: "it's fine" };
    assert.strictEqual(
      buildSessionCommand({ shellType: 'muse', ...options }),
      buildMuseCommand(options),
    );
    assert.strictEqual(
      buildSessionCommand({ shellType: 'muse', workingDir: '/tmp/w', museSessionId: 'sess-abc' }),
      buildMuseCommand({ workingDir: '/tmp/w', museSessionId: 'sess-abc' }),
    );
  });
});

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
