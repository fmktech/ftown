import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HARNESSES,
  HOOKED_SHELL_TYPES,
  LOOP_HARNESS_TYPES,
  SHELL_TYPES,
  WORKFLOW_SHELLS,
  buildKimiCodeCommand,
  buildMuseCommand,
  buildOpencodeCommand,
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
  'claude' | 'cursor' | 'codex' | 'shell' | 'grok' | 'muse' | 'pi' | 'kimi-code' | 'opencode'
> = true;
const _workflowShellUnion: Equals<
  WorkflowShell,
  'claude' | 'cursor' | 'codex' | 'pi' | 'shell' | 'opencode'
> = true;
void _shellTypeIsRegistryKeys;
void _loopHarnessUnion;
void _workflowShellUnion;

describe('harness registry', () => {
  it('contains the supported ShellType set', () => {
    assert.deepEqual(
      [...SHELL_TYPES].sort(),
      ['claude', 'codex', 'cursor', 'deepseek', 'fireworks', 'grok', 'kimi', 'kimi-code', 'muse', 'opencode', 'pi', 'shell', 'zai'],
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

  it('derives the loop harness set', () => {
    assert.deepEqual(
      [...LOOP_HARNESS_TYPES].sort(),
      ['claude', 'codex', 'cursor', 'grok', 'kimi-code', 'muse', 'opencode', 'pi', 'shell'],
    );
  });

  it('derives the workflow shell set (grok and muse stay excluded — preserved decision)', () => {
    assert.deepEqual(
      [...WORKFLOW_SHELLS].sort(),
      ['claude', 'codex', 'cursor', 'opencode', 'pi', 'shell'],
    );
  });

  it('derives the hooked harness set (Pi uses the bundled ftown extension, opencode/muse the bundled ftown plugins)', () => {
    assert.deepEqual(
      [...HOOKED_SHELL_TYPES].sort(),
      ['claude', 'codex', 'deepseek', 'fireworks', 'kimi', 'muse', 'opencode', 'pi', 'zai'],
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

    it('muse: yes, unless resuming a muse session', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('muse', {}), true);
      assert.equal(harnessAcceptsPromptAsCliArg('muse', { museSessionId: 'sess_abc' }), false);
      // Other harnesses' resume fields do not suppress it.
      assert.equal(harnessAcceptsPromptAsCliArg('muse', { claudeSessionId: 'abc' }), true);
    });

    it('pi: accepts an initial CLI prompt', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('pi', {}), true);
    });

    it('opencode: yes, unless resuming an opencode session', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('opencode', {}), true);
      assert.equal(harnessAcceptsPromptAsCliArg('opencode', { opencodeSessionId: 'ses_123' }), false);
      // Other harnesses' resume fields do not suppress it.
      assert.equal(harnessAcceptsPromptAsCliArg('opencode', { claudeSessionId: 'abc' }), true);
    });

    it('shell: never (prompt is typed into the TTY)', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('shell', {}), false);
    });

    it('kimi-code: never (interactive TUI takes no positional prompt)', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('kimi-code', {}), false);
      assert.equal(
        harnessAcceptsPromptAsCliArg('kimi-code', {
          claudeSessionId: 'a',
          cursorSessionId: 'b',
          codexSessionId: 'c',
        }),
        false,
      );
    });

    it('blank resume ids do not suppress the CLI arg (trim semantics preserved)', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('claude', { claudeSessionId: '   ' }), true);
      assert.equal(harnessAcceptsPromptAsCliArg('cursor', { cursorSessionId: '' }), true);
    });
  });
});

describe('buildOpencodeCommand', () => {
  it('base launch is --auto only (frozen)', () => {
    assert.equal(buildOpencodeCommand({}), 'opencode --auto');
  });

  it('model rides -m in provider/model form', () => {
    assert.equal(
      buildOpencodeCommand({ model: 'anthropic/claude-sonnet-4-5' }),
      "opencode --auto -m 'anthropic/claude-sonnet-4-5'",
    );
  });

  it('initial prompt rides --prompt (the TUI submits it on launch)', () => {
    assert.equal(
      buildOpencodeCommand({ initialPrompt: 'do the thing' }),
      "opencode --auto --prompt 'do the thing'",
    );
  });

  it('model and prompt compose', () => {
    assert.equal(
      buildOpencodeCommand({ model: 'openai/gpt-5.2', initialPrompt: 'hello world' }),
      "opencode --auto -m 'openai/gpt-5.2' --prompt 'hello world'",
    );
  });

  it('resume suppresses model and prompt (thread is restored)', () => {
    assert.equal(buildOpencodeCommand({ opencodeSessionId: 'ses_abc' }), "opencode --auto --session 'ses_abc'");
    assert.equal(
      buildOpencodeCommand({ opencodeSessionId: 'ses_abc', model: 'm', initialPrompt: 'p' }),
      "opencode --auto --session 'ses_abc'",
    );
  });

  it('prompts are single-quote escaped', () => {
    assert.equal(
      buildOpencodeCommand({ initialPrompt: "it's here" }),
      `opencode --auto --prompt 'it'\\''s here'`,
    );
  });

  it('registry entry threads session id, model, and prompt through', () => {
    assert.equal(HARNESSES.opencode.buildCommand({}), 'opencode --auto');
    assert.equal(
      HARNESSES.opencode.buildCommand({ opencodeSessionId: 'x' }),
      "opencode --auto --session 'x'",
    );
  });
});

describe('buildKimiCodeCommand', () => {
  const KIMI = '"$HOME/.kimi-code/bin/kimi"';

  it('no-resume output is unchanged (frozen)', () => {
    assert.equal(buildKimiCodeCommand({}), `${KIMI} --yolo`);
    assert.equal(buildKimiCodeCommand({ model: 'k2' }), `${KIMI} --yolo -m 'k2'`);
  });

  it('resume appends -c after --yolo', () => {
    assert.equal(buildKimiCodeCommand({ resume: true }), `${KIMI} --yolo -c`);
  });

  it('resume keeps the model so the resumed session retains it', () => {
    assert.equal(
      buildKimiCodeCommand({ resume: true, model: 'k2' }),
      `${KIMI} --yolo -c -m 'k2'`,
    );
  });

  it('registry kimi-code entry threads the resume flag through', () => {
    assert.equal(HARNESSES['kimi-code'].buildCommand({}), `${KIMI} --yolo`);
    assert.equal(HARNESSES['kimi-code'].buildCommand({ resume: true }), `${KIMI} --yolo -c`);
    assert.equal(
      HARNESSES['kimi-code'].buildCommand({ resume: true, model: 'k2' }),
      `${KIMI} --yolo -c -m 'k2'`,
    );
  });
});

describe('buildMuseCommand', () => {
  it('base launch is --yolo only (frozen)', () => {
    assert.equal(buildMuseCommand({}), 'muse --yolo');
  });

  it('--workspace rides only when the workdir is known', () => {
    assert.equal(buildMuseCommand({ workingDir: '/tmp/w' }), "muse --yolo --workspace '/tmp/w'");
    assert.equal(buildMuseCommand({ workingDir: '  ' }), 'muse --yolo');
  });

  it('model and prompt compose after --workspace (flag order mirrors cursor)', () => {
    assert.equal(
      buildMuseCommand({ workingDir: '/tmp/w', model: 'm1', initialPrompt: 'hello world' }),
      "muse --yolo --workspace '/tmp/w' --model 'm1' 'hello world'",
    );
  });

  it('prompt is positional without a workdir', () => {
    assert.equal(buildMuseCommand({ initialPrompt: 'do the thing' }), "muse --yolo 'do the thing'");
  });

  it('prompts are single-quote escaped', () => {
    assert.equal(
      buildMuseCommand({ initialPrompt: "it's here" }),
      `muse --yolo 'it'\\''s here'`,
    );
  });

  it('resume early-returns with no model and no prompt (codex/opencode precedent)', () => {
    assert.equal(
      buildMuseCommand({ workingDir: '/tmp/w', museSessionId: 'sess-abc' }),
      "muse --yolo --workspace '/tmp/w' resume 'sess-abc'",
    );
    assert.equal(
      buildMuseCommand({ workingDir: '/tmp/w', museSessionId: 'sess-abc', model: 'm1', initialPrompt: 'p' }),
      "muse --yolo --workspace '/tmp/w' resume 'sess-abc'",
    );
    assert.equal(buildMuseCommand({ museSessionId: 'sess-abc' }), "muse --yolo resume 'sess-abc'");
  });

  it('resume suppresses the prompt-as-CLI-arg path (prompt never replays on resume)', () => {
    assert.equal(harnessAcceptsPromptAsCliArg('muse', { museSessionId: 'sess-abc' }), false);
    assert.equal(
      buildMuseCommand({ workingDir: '/tmp/w', museSessionId: 'sess-abc', initialPrompt: 'do not replay' }),
      "muse --yolo --workspace '/tmp/w' resume 'sess-abc'",
    );
  });

  it('registry muse entry threads workdir, model, prompt, and session id through', () => {
    assert.equal(HARNESSES.muse.buildCommand({}), 'muse --yolo');
    assert.equal(
      HARNESSES.muse.buildCommand({ workingDir: '/tmp/w', model: 'm1', initialPrompt: 'hi' }),
      "muse --yolo --workspace '/tmp/w' --model 'm1' 'hi'",
    );
    assert.equal(
      HARNESSES.muse.buildCommand({ workingDir: '/tmp/w', museSessionId: 'sess-abc' }),
      "muse --yolo --workspace '/tmp/w' resume 'sess-abc'",
    );
  });

  it('registry muse spec matches the frozen contract (A1: hooked + museSessionId)', () => {
    assert.equal(HARNESSES.muse.hooked, true);
    assert.equal(HARNESSES.muse.promptAsCliArg, true);
    assert.equal(HARNESSES.muse.resumeField, 'museSessionId');
    assert.ok(!('providerBase' in HARNESSES.muse));
    assert.equal(HARNESSES.muse.validForLoop, true);
    assert.equal(HARNESSES.muse.validForWorkflow, false);
    assert.ok(!('spawnStaggerMs' in HARNESSES.muse));
  });
});
