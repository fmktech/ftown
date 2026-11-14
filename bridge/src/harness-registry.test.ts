import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CLAUDE_MOD_FILES } from './claude-mod-installer.js';

import {
  ACCEPTED_SHELL_TYPES,
  HARNESSES,
  HOOKED_SHELL_TYPES,
  InvalidShellTypeError,
  isShellType,
  isShellTypeOrAlias,
  normalizeShellType,
  resolveShellType,
  SHELL_ALIASES,
  SHELL_TYPES,
  buildAntigravityCommand,
  buildGrokCommand,
  buildKimiCodeCommand,
  buildMuseCommand,
  buildOpencodeCommand,
  harnessAcceptsPromptAsCliArg,
} from './harness-registry.js';
import { QUOTA_PROVIDER_IDS } from './quota/types.js';
import { buildSessionCommand } from './agent-commands.js';
import { PROVIDER_AUTH_ENV, PROVIDER_FLAVORS, PROVIDER_RUNTIME_ENV } from './provider-env-store.js';

import type { ShellType } from './harness-registry.js';

// ---- Type-level drift guards: derived unions must match the registry keys ----

type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _shellTypeIsRegistryKeys: Equals<ShellType, keyof typeof HARNESSES> = true;
void _shellTypeIsRegistryKeys;

describe('harness registry', () => {
  it('loads the installed Mod only for compatible Claude executables, including provider aliases', () => {
    if (process.platform === 'win32') return;
    const home = process.env.HOME; const path = process.env.PATH;
    const temporary = mkdtempSync(join(tmpdir(), 'ftown-mod-launch-'));
    try {
      process.env.HOME = temporary;
      for (const relative of CLAUDE_MOD_FILES) {
        const file = join(temporary, '.ftown/claude-plugin', relative);
        mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'asset');
      }
      const bin = join(temporary, 'bin'); mkdirSync(bin);
      writeFileSync(join(bin, 'claude'), '#!/bin/sh\necho "2.1.302 (Claude Code)"\n'); chmodSync(join(bin, 'claude'), 0o755);
      process.env.PATH = bin;
      for (const type of ['claude', 'zai', 'kimi', 'deepseek', 'fireworks'] as const) {
        const command = HARNESSES[type].buildCommand({ claudeSessionId: 'native-id', model: 'm' });
        assert.ok(command.includes(`--plugin-dir '${join(temporary, '.ftown/claude-plugin')}'`), type);
        assert.match(command, /--resume 'native-id'/);
      }
      // Changing PATH invalidates the bounded probe cache.
      const oldBin = join(temporary, 'old-bin'); mkdirSync(oldBin);
      writeFileSync(join(oldBin, 'claude'), '#!/bin/sh\necho "2.1.286 (Claude Code)"\n'); chmodSync(join(oldBin, 'claude'), 0o755);
      process.env.PATH = oldBin;
      assert.doesNotMatch(HARNESSES.claude.buildCommand({}), /--plugin-dir/);
    } finally {
      if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
      rmSync(temporary, { recursive: true, force: true });
    }
  });
  it('contains the supported ShellType set', () => {
    assert.deepEqual(
      [...SHELL_TYPES].sort(),
      ['antigravity', 'claude', 'codex', 'cursor', 'deepseek', 'fireworks', 'grok', 'kimi', 'kimi-code', 'muse', 'opencode', 'pi', 'shell', 'zai'],
    );
  });

  it('registers antigravity directly after muse', () => {
    assert.equal(SHELL_TYPES.indexOf('antigravity'), SHELL_TYPES.indexOf('muse') + 1);
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

  it('derives the hooked harness set (Pi uses the bundled ftown extension, opencode/muse the bundled ftown plugins, antigravity the ftown Stop hook)', () => {
    assert.deepEqual(
      [...HOOKED_SHELL_TYPES].sort(),
      ['antigravity', 'claude', 'codex', 'deepseek', 'fireworks', 'kimi', 'muse', 'opencode', 'pi', 'zai'],
    );
    // Grok hooks only report the session id; mail stays a typed nudge.
    assert.equal(HOOKED_SHELL_TYPES.has('grok'), false);
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

    it('grok: yes, unless resuming a grok session', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('grok', {}), true);
      assert.equal(harnessAcceptsPromptAsCliArg('grok', { grokSessionId: 'g-123' }), false);
      assert.equal(harnessAcceptsPromptAsCliArg('grok', { grokSessionId: '   ' }), true);
      // Other harnesses' resume fields do not suppress it.
      assert.equal(
        harnessAcceptsPromptAsCliArg('grok', { claudeSessionId: 'a', cursorSessionId: 'b', codexSessionId: 'c' }),
        true,
      );
    });

    it('antigravity: yes, unless resuming an antigravity conversation', () => {
      assert.equal(harnessAcceptsPromptAsCliArg('antigravity', {}), true);
      assert.equal(harnessAcceptsPromptAsCliArg('antigravity', { antigravitySessionId: 'conv-1' }), false);
      assert.equal(harnessAcceptsPromptAsCliArg('antigravity', { antigravitySessionId: '  ' }), true);
      // Other harnesses' resume fields do not suppress it.
      assert.equal(harnessAcceptsPromptAsCliArg('antigravity', { grokSessionId: 'g', museSessionId: 'm' }), true);
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
      process.platform === 'win32' ? "opencode --auto --prompt 'it''s here'" : `opencode --auto --prompt 'it'\\''s here'`,
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
      process.platform === 'win32' ? "muse --yolo 'it''s here'" : `muse --yolo 'it'\\''s here'`,
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
    assert.ok(!('spawnStaggerMs' in HARNESSES.muse));
  });
});

describe('buildAntigravityCommand', () => {
  const AGY = 'agy --dangerously-skip-permissions';

  it('base launch is --dangerously-skip-permissions only (frozen)', () => {
    assert.equal(buildAntigravityCommand({}), AGY);
  });

  it('model rides --model (trimmed)', () => {
    assert.equal(buildAntigravityCommand({ model: 'gemini-3-pro' }), `${AGY} --model 'gemini-3-pro'`);
    assert.equal(buildAntigravityCommand({ model: '  gemini-3-pro  ' }), `${AGY} --model 'gemini-3-pro'`);
  });

  it('initial prompt rides -i (quoted untrimmed)', () => {
    assert.equal(buildAntigravityCommand({ initialPrompt: 'do the thing' }), `${AGY} -i 'do the thing'`);
    assert.equal(buildAntigravityCommand({ initialPrompt: ' padded ' }), `${AGY} -i ' padded '`);
  });

  it('model and prompt compose (model first)', () => {
    assert.equal(
      buildAntigravityCommand({ model: 'm1', initialPrompt: 'hello world' }),
      `${AGY} --model 'm1' -i 'hello world'`,
    );
  });

  it('prompts are single-quote escaped', () => {
    assert.equal(
      buildAntigravityCommand({ initialPrompt: "it's here" }),
      process.platform === 'win32' ? `${AGY} -i 'it''s here'` : `${AGY} -i 'it'\\''s here'`,
    );
  });

  it('whitespace-only model and prompt are ignored', () => {
    assert.equal(buildAntigravityCommand({ model: '   ', initialPrompt: ' \n\t ' }), AGY);
  });

  it('resume early-returns with --conversation, dropping model and prompt', () => {
    assert.equal(buildAntigravityCommand({ antigravitySessionId: 'conv-abc' }), `${AGY} --conversation 'conv-abc'`);
    assert.equal(
      buildAntigravityCommand({ antigravitySessionId: 'conv-abc', model: 'm1', initialPrompt: 'do not replay' }),
      `${AGY} --conversation 'conv-abc'`,
    );
  });

  it('resume id is trimmed; a whitespace-only id counts as absent', () => {
    assert.equal(buildAntigravityCommand({ antigravitySessionId: '  conv-abc  ' }), `${AGY} --conversation 'conv-abc'`);
    assert.equal(
      buildAntigravityCommand({ antigravitySessionId: '   ', model: 'm1', initialPrompt: 'p' }),
      `${AGY} --model 'm1' -i 'p'`,
    );
  });

  it('registry antigravity entry threads model, prompt, and session id through (no workdir flag)', () => {
    assert.equal(HARNESSES.antigravity.buildCommand({ workingDir: '/tmp/w' }), AGY);
    assert.equal(
      HARNESSES.antigravity.buildCommand({ workingDir: '/tmp/w', model: 'm1', initialPrompt: 'hi' }),
      `${AGY} --model 'm1' -i 'hi'`,
    );
    assert.equal(
      HARNESSES.antigravity.buildCommand({ antigravitySessionId: 'conv-abc', initialPrompt: 'hi' }),
      `${AGY} --conversation 'conv-abc'`,
    );
  });

  it('registry antigravity spec matches the frozen contract', () => {
    assert.equal(HARNESSES.antigravity.hooked, true);
    assert.equal(HARNESSES.antigravity.promptAsCliArg, true);
    assert.equal(HARNESSES.antigravity.resumeField, 'antigravitySessionId');
    assert.ok(!('providerBase' in HARNESSES.antigravity));
    assert.ok(!('spawnStaggerMs' in HARNESSES.antigravity));
  });
});

describe('buildGrokCommand', () => {
  const GROK = 'grok --always-approve';

  it('fresh output is unchanged (frozen)', () => {
    assert.equal(buildGrokCommand({}), GROK);
    assert.equal(buildGrokCommand({ model: ' grok-4 ' }), `${GROK} -m 'grok-4'`);
    assert.equal(buildGrokCommand({ initialPrompt: 'do the thing' }), `${GROK} 'do the thing'`);
    assert.equal(buildGrokCommand({ model: 'grok-4', initialPrompt: 'hello world' }), `${GROK} -m 'grok-4' 'hello world'`);
    assert.equal(buildGrokCommand({ model: '  ', initialPrompt: '   ' }), GROK);
    assert.equal(
      buildGrokCommand({ initialPrompt: "it's here" }),
      process.platform === 'win32' ? `${GROK} 'it''s here'` : `${GROK} 'it'\\''s here'`,
    );
  });

  it('resume early-returns with -r, dropping model and prompt', () => {
    assert.equal(buildGrokCommand({ grokSessionId: 'g-abc' }), `${GROK} -r 'g-abc'`);
    assert.equal(
      buildGrokCommand({ grokSessionId: 'g-abc', model: 'grok-4', initialPrompt: 'do not replay' }),
      `${GROK} -r 'g-abc'`,
    );
  });

  it('resume id is trimmed; a whitespace-only id counts as absent', () => {
    assert.equal(buildGrokCommand({ grokSessionId: '  g-abc  ' }), `${GROK} -r 'g-abc'`);
    assert.equal(buildGrokCommand({ grokSessionId: '   ', model: 'grok-4', initialPrompt: 'p' }), `${GROK} -m 'grok-4' 'p'`);
  });

  it('registry grok entry threads the session id through and stays unhooked', () => {
    assert.equal(HARNESSES.grok.buildCommand({ grokSessionId: 'g-abc', model: 'grok-4' }), `${GROK} -r 'g-abc'`);
    assert.equal(HARNESSES.grok.hooked, false);
    assert.equal(HARNESSES.grok.promptAsCliArg, true);
    assert.equal(HARNESSES.grok.resumeField, 'grokSessionId');
  });
});

describe('shellType aliases and validation', () => {
  it('maps routing/quota provider ids to canonical harness keys', () => {
    assert.deepEqual(SHELL_ALIASES, { agy: 'antigravity' });
    // Verify all QUOTA_PROVIDER_IDS against harness-registry
    for (const providerId of QUOTA_PROVIDER_IDS) {
      const canonical = normalizeShellType(providerId);
      assert.ok(canonical && isShellType(canonical), `provider ${providerId} must resolve to a valid harness key`);
      if (providerId === 'agy') {
        assert.equal(canonical, 'antigravity');
      } else {
        assert.equal(canonical, providerId);
      }
    }
  });

  it('normalizes valid harness keys and aliases', () => {
    assert.equal(normalizeShellType(undefined), undefined);
    assert.equal(normalizeShellType(null), undefined);
    assert.equal(normalizeShellType('agy'), 'antigravity');
    assert.equal(normalizeShellType('  agy  '), 'antigravity');
    assert.equal(normalizeShellType('antigravity'), 'antigravity');
    assert.equal(normalizeShellType('claude'), 'claude');
    assert.equal(normalizeShellType('codex'), 'codex');
    assert.equal(normalizeShellType('cursor'), 'cursor');
    assert.equal(normalizeShellType('shell'), 'shell');
    assert.equal(normalizeShellType('grok'), 'grok');
    assert.equal(normalizeShellType('muse'), 'muse');
    assert.equal(normalizeShellType('pi'), 'pi');
    assert.equal(normalizeShellType('opencode'), 'opencode');
    assert.equal(normalizeShellType('kimi-code'), 'kimi-code');
    assert.equal(normalizeShellType('zai'), 'zai');
    assert.equal(normalizeShellType('kimi'), 'kimi');
    assert.equal(normalizeShellType('deepseek'), 'deepseek');
    assert.equal(normalizeShellType('fireworks'), 'fireworks');
  });

  it('identifies valid shell types and aliases with isShellTypeOrAlias', () => {
    assert.equal(isShellTypeOrAlias('agy'), true);
    assert.equal(isShellTypeOrAlias('antigravity'), true);
    assert.equal(isShellTypeOrAlias('claude'), true);
    assert.equal(isShellTypeOrAlias('unknown'), false);
    assert.equal(isShellTypeOrAlias(''), false);
    assert.equal(isShellTypeOrAlias(null), false);
  });

  it('rejects unknown shellType with 400 InvalidShellTypeError listing valid values', () => {
    for (const bad of ['unknown', 'gemini', 'agy2', '', '  ', 123, {}]) {
      assert.throws(
        () => normalizeShellType(bad),
        (err: unknown) => {
          assert.ok(err instanceof InvalidShellTypeError);
          assert.equal(err.status, 400);
          assert.equal(err.code, 'invalid_shell_type');
          assert.match(err.message, /Invalid shellType/);
          assert.match(err.message, /Valid values:/);
          assert.ok(ACCEPTED_SHELL_TYPES.every((t) => err.message.includes(t)));
          return true;
        },
      );
    }
  });

  it('buildSessionCommand resolves alias agy to antigravity instead of falling back to claude', () => {
    const cmd = buildSessionCommand({
      shellType: 'agy' as ShellType,
      model: 'gemini-4-hydrogen-medium',
    });
    assert.equal(cmd, "agy --dangerously-skip-permissions --model 'gemini-4-hydrogen-medium'");
    assert.doesNotMatch(cmd, /claude/);
  });

  it('buildSessionCommand rejects unknown shellType and never silently falls back to claude', () => {
    assert.throws(
      () => buildSessionCommand({ shellType: 'unknown' as ShellType }),
      (err: unknown) => {
        assert.ok(err instanceof InvalidShellTypeError);
        assert.match(err.message, /Valid values:/);
        return true;
      },
    );
  });
});
