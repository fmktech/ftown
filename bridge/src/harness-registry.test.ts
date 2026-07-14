import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HARNESSES,
  HOOKED_SHELL_TYPES,
  LOOP_HARNESS_TYPES,
  SHELL_TYPES,
  WORKFLOW_SHELLS,
  harnessAcceptsPromptAsCliArg,
  isLoopHarness,
  isShellType,
} from './harness-registry.js';
import { buildSessionCommand } from './agent-commands.js';
import { PROVIDER_AUTH_ENV, PROVIDER_FLAVORS, PROVIDER_RUNTIME_ENV } from './provider-env-store.js';

import type { LoopHarness, ShellType, WorkflowShell } from './harness-registry.js';

// ---- Type-level drift guards: derived unions must match the registry keys ----

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _shellTypeIsRegistryKeys: Equals<ShellType, keyof typeof HARNESSES> = true;
const _loopHarnessUnion: Equals<
  LoopHarness,
  'claude' | 'cursor' | 'codex' | 'shell' | 'grok' | 'opencode'
> = true;
const _workflowShellUnion: Equals<
  WorkflowShell,
  'claude' | 'cursor' | 'codex' | 'shell' | 'opencode'
> = true;
void _shellTypeIsRegistryKeys;
void _loopHarnessUnion;
void _workflowShellUnion;

describe('harness registry', () => {
  it('contains exactly the historical ShellType set', () => {
    assert.deepEqual(
      [...SHELL_TYPES].sort(),
      ['claude', 'codex', 'cursor', 'deepseek', 'fireworks', 'grok', 'kimi', 'opencode', 'shell', 'zai'],
    );
  });

  for (const type of SHELL_TYPES) {
    describe(`harness "${type}"`, () => {
      const spec = HARNESSES[type];

      it('builds a non-empty launch command', () => {
        const command = spec.buildCommand({ model: 'm', initialPrompt: 'hello' });
        assert.equal(typeof command, 'string');
        assert.ok(command.trim().length > 0);
      });

      it('buildCommand agrees with buildSessionCommand', () => {
        const input = {
          shellType: type,
          workingDir: '/tmp/w',
          model: 'some-model',
          initialPrompt: 'do the thing',
        };
        assert.equal(spec.buildCommand(input), buildSessionCommand(input));
      });

      it('resumeField implies the prompt may be a CLI arg at all', () => {
        // A resume gate is meaningless for a harness that never takes the prompt as an arg.
        if (spec.resumeField) assert.equal(spec.promptAsCliArg, true);
      });

      it('providerBase implies entries in BOTH provider maps', () => {
        if (spec.providerBase) {
          assert.ok(PROVIDER_AUTH_ENV[type], `PROVIDER_AUTH_ENV missing "${type}"`);
          assert.ok(PROVIDER_RUNTIME_ENV[type], `PROVIDER_RUNTIME_ENV missing "${type}"`);
        }
      });
    });
  }

  it('every provider flavor is a registry key with providerBase set', () => {
    for (const flavor of PROVIDER_FLAVORS) {
      assert.ok(isShellType(flavor), `flavor "${flavor}" missing from HARNESSES`);
      assert.equal(HARNESSES[flavor].providerBase, 'claude');
    }
  });

  it('derives the historical LOOP_HARNESSES set', () => {
    assert.deepEqual(
      [...LOOP_HARNESS_TYPES].sort(),
      ['claude', 'codex', 'cursor', 'grok', 'opencode', 'shell'],
    );
  });

  it('derives the historical WorkflowShell set (grok stays excluded — preserved decision)', () => {
    assert.deepEqual(
      [...WORKFLOW_SHELLS].sort(),
      ['claude', 'codex', 'cursor', 'opencode', 'shell'],
    );
  });

  it('derives the historical HOOKED_SHELL_TYPES set (grok/cursor/opencode/shell stay unhooked)', () => {
    assert.deepEqual(
      [...HOOKED_SHELL_TYPES].sort(),
      ['claude', 'codex', 'deepseek', 'fireworks', 'kimi', 'zai'],
    );
  });

  it('isLoopHarness accepts exactly the loop harnesses', () => {
    for (const type of SHELL_TYPES) {
      assert.equal(isLoopHarness(type), HARNESSES[type].validForLoop, type);
    }
    assert.equal(isLoopHarness('nonsense'), false);
    assert.equal(isLoopHarness(undefined), false);
  });

  describe('prompt-as-CLI-arg predicate (behavior preserved from create-ftown-session)', () => {
    it('claude and claude flavors: yes, unless resuming a claude session', () => {
      for (const type of ['claude', 'zai', 'kimi', 'deepseek', 'fireworks'] as const) {
        assert.equal(harnessAcceptsPromptAsCliArg(type, {}), true, type);
        assert.equal(harnessAcceptsPromptAsCliArg(type, { claudeSessionId: 'abc' }), false, type);
        // Other harnesses' resume fields do not suppress it.
        assert.equal(harnessAcceptsPromptAsCliArg(type, { cursorSessionId: 'abc' }), true, type);
      }
    });

    it('cursor: yes, unless resuming a cursor session', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('cursor', {}), true);
      assert.equal(harnessAcceptsPromptAsCliArg('cursor', { cursorSessionId: 'abc' }), false);
      assert.equal(harnessAcceptsPromptAsCliArg('cursor', { claudeSessionId: 'abc' }), true);
    });

    it('codex: yes, unless resuming a codex session', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('codex', {}), true);
      assert.equal(harnessAcceptsPromptAsCliArg('codex', { codexSessionId: 'abc' }), false);
    });

    it('grok: always (no resume support)', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('grok', {}), true);
      assert.equal(
        harnessAcceptsPromptAsCliArg('grok', { claudeSessionId: 'a', cursorSessionId: 'b', codexSessionId: 'c' }),
        true,
      );
    });

    it('shell and opencode: never (prompt is typed into the TUI)', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('shell', {}), false);
      assert.equal(harnessAcceptsPromptAsCliArg('opencode', {}), false);
    });

    it('blank resume ids do not suppress the CLI arg (trim semantics preserved)', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('claude', { claudeSessionId: '   ' }), true);
      assert.equal(harnessAcceptsPromptAsCliArg('cursor', { cursorSessionId: '' }), true);
    });
  });
});
