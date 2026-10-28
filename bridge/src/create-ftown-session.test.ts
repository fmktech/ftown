import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildSessionCommand } from './agent-commands.js';
import { TerminalManager } from './terminal-manager.js';
import {
  assertProviderAuthAvailable,
  buildChildBriefing,
  canResumeStoredSession,
  createFtownSession,
  deriveRelaunchCommand,
  nextAvailableGeneratedName,
  findMissingProviderAuth,
  parseCreateSessionBody,
  prepareWorkingDir,
  ProviderAuthMissingError,
  relaunchFtownSession,
  resolveProviderAuthEnv,
  resolveProviderRuntimeEnv,
  WorkingDirMissingError,
} from './create-ftown-session.js';
import type { CreateFtownSessionDeps } from './create-ftown-session.js';
import type { Session } from './types.js';

function restoreHome(realHome: string | undefined): void {
  if (realHome === undefined) delete process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
  else process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = realHome;
}

function fakeSession(name: string): Session {
  return {
    id: name,
    name,
    command: 'cmd',
    status: 'running',
    bridgeId: 'bridge',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

interface RecordedRun {
  sessionId: string;
  command: string;
  workingDir?: string;
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelay?: number;
  submitSuffix?: string;
  hookPort?: number;
  hookToken?: string;
  parentSessionId?: string;
  cols?: number;
  rows?: number;
}

function fakeDeps(existingSessions: Session[] = []): {
  deps: CreateFtownSessionDeps;
  saved: Session[];
  runs: RecordedRun[];
} {
  const sessions = [...existingSessions];
  const saved: Session[] = [];
  const runs: RecordedRun[] = [];

  return {
    saved,
    runs,
    deps: {
      store: {
        loadSession: async (id: string) => sessions.find((session) => session.id === id) ?? null,
        listSessions: async () => sessions,
        saveSession: async (session: Session) => {
          saved.push(session);
          sessions.unshift(session);
        },
      } as CreateFtownSessionDeps['store'],
      runner: {
        getPreferredRuntime: () => 'direct',
        run: (
          sessionId: string,
          command: string,
          opts: {
            workingDir?: string;
            env?: Record<string, string>;
            initialInput?: string;
            initialInputDelay?: number;
            submitSuffix?: string;
            hookPort?: number;
            hookToken?: string;
            parentSessionId?: string;
            cols?: number;
            rows?: number;
          },
        ) => {
          runs.push({
            sessionId,
            command,
            workingDir: opts.workingDir,
            env: opts.env,
            initialInput: opts.initialInput,
            initialInputDelay: opts.initialInputDelay,
            submitSuffix: opts.submitSuffix,
            hookPort: opts.hookPort,
            hookToken: opts.hookToken,
            parentSessionId: opts.parentSessionId,
            ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
            ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
          });
        },
      } as CreateFtownSessionDeps['runner'],
      centrifugo: {
        publishSessionUpdate: async () => {},
      } as CreateFtownSessionDeps['centrifugo'],
      userId: 'user',
      bridgeId: 'bridge',
      hookPort: 1,
      hookToken: 'token',
      notifyScriptPath: '/tmp/notify.sh',
      wireTerminalInput: () => {},
    },
  };
}

// Callers can suppress automatic briefing without changing task delivery.
describe('parseCreateSessionBody — suppressBriefing plumbing', () => {
  it('parses suppressBriefing: true', () => {
    assert.strictEqual(parseCreateSessionBody({ suppressBriefing: true }).suppressBriefing, true);
  });

  it('defaults suppressBriefing to false when absent', () => {
    assert.strictEqual(parseCreateSessionBody({ prompt: 'do x' }).suppressBriefing, false);
  });

  it('only accepts the strict boolean true (not truthy strings)', () => {
    assert.strictEqual(parseCreateSessionBody({ suppressBriefing: 'yes' }).suppressBriefing, false);
    assert.strictEqual(parseCreateSessionBody({ suppressBriefing: 1 }).suppressBriefing, false);
  });

  it('still passes through the other create fields', () => {
    const input = parseCreateSessionBody({ prompt: 'do x', shellType: 'claude', suppressBriefing: true });
    assert.strictEqual(input.prompt, 'do x');
    assert.strictEqual(input.shellType, 'claude');
    assert.strictEqual(input.suppressBriefing, true);
  });

  it('passes through the muse native session id for resume creates', () => {
    const input = parseCreateSessionBody({ shellType: 'muse', museSessionId: 'sess-abc' });
    assert.strictEqual(input.museSessionId, 'sess-abc');
    assert.strictEqual(parseCreateSessionBody({ shellType: 'muse' }).museSessionId, undefined);
  });
});

describe('parseCreateSessionBody — missing working dir confirmation plumbing', () => {
  it('parses createMissingWorkingDir only when strictly true', () => {
    assert.strictEqual(
      parseCreateSessionBody({ createMissingWorkingDir: true }).createMissingWorkingDir,
      true,
    );
    assert.strictEqual(
      parseCreateSessionBody({ createMissingWorkingDir: 'true' }).createMissingWorkingDir,
      false,
    );
    assert.strictEqual(parseCreateSessionBody({}).createMissingWorkingDir, false);
  });
});

describe('prepareWorkingDir', () => {
  it('throws a structured error when the working directory is absent', () => {
    const root = mkdtempSync(join(tmpdir(), 'ftw-missing-wd-'));
    const missing = join(root, 'missing', 'nested');
    try {
      assert.throws(
        () => prepareWorkingDir(missing, false),
        (err: unknown) => {
          assert.ok(err instanceof WorkingDirMissingError);
          assert.strictEqual(err.code, 'working_dir_missing');
          assert.strictEqual(err.workingDir, resolve(missing));
          return true;
        },
      );
      assert.strictEqual(existsSync(missing), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('creates a missing working directory only when explicitly allowed', () => {
    const root = mkdtempSync(join(tmpdir(), 'ftw-create-wd-'));
    const missing = join(root, 'missing', 'nested');
    try {
      assert.strictEqual(prepareWorkingDir(missing, true), resolve(missing));
      assert.strictEqual(existsSync(missing), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects paths that exist but are not directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'ftw-file-wd-'));
    const file = join(root, 'file.txt');
    try {
      writeFileSync(file, 'not a directory');
      assert.throws(() => prepareWorkingDir(file, true), /not a directory/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('nextAvailableGeneratedName', () => {
  it('appends numeric suffixes when the generated name already exists', () => {
    assert.strictEqual(nextAvailableGeneratedName('medieval-new5', []), 'medieval-new5');
    assert.strictEqual(
      nextAvailableGeneratedName('medieval-new5', ['medieval-new5', 'medieval-new5_1']),
      'medieval-new5_2',
    );
  });
});

describe('createFtownSession — working directory and generated name preflight', () => {
  it('blocks a missing working directory before saving or running the Codex CLI', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    const root = mkdtempSync(join(tmpdir(), 'ftw-create-preflight-'));
    const missing = join(root, 'missing-project');
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    const harness = fakeDeps();

    try {
      await assert.rejects(
        () => createFtownSession(harness.deps, { shellType: 'codex', workingDir: missing }),
        (err: unknown) => {
          assert.ok(err instanceof WorkingDirMissingError);
          assert.strictEqual(err.workingDir, resolve(missing));
          return true;
        },
      );
      assert.strictEqual(harness.saved.length, 0);
      assert.strictEqual(harness.runs.length, 0);
      assert.strictEqual(existsSync(missing), false);
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses the workspace basename as the generated session name and suffixes collisions', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    const root = mkdtempSync(join(tmpdir(), 'ftw-name-wd-'));
    const workdir = join(root, 'medieval-new5');
    mkdirSync(workdir);
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    const harness = fakeDeps([
      fakeSession('medieval-new5'),
      fakeSession('medieval-new5_1'),
    ]);

    try {
      const session = await createFtownSession(harness.deps, {
        shellType: 'shell',
        workingDir: workdir,
      });
      assert.strictEqual(session.name, 'medieval-new5_2');
      assert.strictEqual(session.workingDir, resolve(workdir));
      assert.strictEqual(harness.saved.length, 1);
      assert.strictEqual(harness.runs.length, 1);
      assert.strictEqual(harness.runs[0].workingDir, resolve(workdir));
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('createFtownSession — historical automation metadata is not a creation feature', () => {
  it('does not tag fresh sessions as automation even if untyped input contains legacy loopId', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    try {
      const tagged = fakeDeps();
      const withLoop = await createFtownSession(tagged.deps, { shellType: 'shell', loopId: 'loop-42' } as never);
      assert.strictEqual(withLoop.loopId, undefined);
      assert.strictEqual(tagged.saved[0].loopId, undefined);

      const plain = fakeDeps();
      const withoutLoop = await createFtownSession(plain.deps, { shellType: 'shell' });
      assert.strictEqual(withoutLoop.loopId, undefined);
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Provider API tokens live on the bridge machine under provider-specific keys and are
// mapped onto the Anthropic auth var at session creation — so secrets never travel
// through the browser or the spawn command. The source token may arrive via the bridge
// process env, the ~/.ftown/env.json store, or the per-create input env (last wins).
describe('resolveProviderAuthEnv — provider token mapping', () => {
  it('maps ZAI_API_TOKEN -> ANTHROPIC_AUTH_TOKEN for the zai flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('zai', { processEnv: { ZAI_API_TOKEN: 'tok-zai' } }),
      { ANTHROPIC_AUTH_TOKEN: 'tok-zai' },
    );
  });

  it('maps FIREWORKS_API_TOKEN -> ANTHROPIC_AUTH_TOKEN for the fireworks flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('fireworks', { processEnv: { FIREWORKS_API_TOKEN: 'tok-fw' } }),
      { ANTHROPIC_AUTH_TOKEN: 'tok-fw' },
    );
  });

  it('maps KIMI_API_TOKEN -> ANTHROPIC_API_KEY for the kimi flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('kimi', { processEnv: { KIMI_API_TOKEN: 'tok-kimi' } }),
      { ANTHROPIC_API_KEY: 'tok-kimi' },
    );
  });

  it('maps DEEPSEEK_API_TOKEN -> ANTHROPIC_API_KEY for the deepseek flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('deepseek', { processEnv: { DEEPSEEK_API_TOKEN: 'tok-ds' } }),
      { ANTHROPIC_API_KEY: 'tok-ds' },
    );
  });

  it('reads the source token from the store env', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('zai', { processEnv: {}, storeEnv: { ZAI_API_TOKEN: 'store-zai' } }),
      { ANTHROPIC_AUTH_TOKEN: 'store-zai' },
    );
  });

  it('reads the source token from the per-create input env', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('kimi', { processEnv: {}, inputEnv: { KIMI_API_TOKEN: 'input-kimi' } }),
      { ANTHROPIC_API_KEY: 'input-kimi' },
    );
  });

  it('applies precedence inputEnv > storeEnv > processEnv for the source token', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('zai', {
        processEnv: { ZAI_API_TOKEN: 'from-process' },
        storeEnv: { ZAI_API_TOKEN: 'from-store' },
        inputEnv: { ZAI_API_TOKEN: 'from-input' },
      }),
      { ANTHROPIC_AUTH_TOKEN: 'from-input' },
    );
    assert.deepEqual(
      resolveProviderAuthEnv('zai', {
        processEnv: { ZAI_API_TOKEN: 'from-process' },
        storeEnv: { ZAI_API_TOKEN: 'from-store' },
      }),
      { ANTHROPIC_AUTH_TOKEN: 'from-store' },
    );
  });

  it('returns nothing when the provider token is absent in every source', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('zai', { processEnv: {}, storeEnv: {}, inputEnv: {} }),
      {},
    );
  });

  it('returns nothing for unmapped shell types and undefined', () => {
    for (const unmapped of ['claude', 'cursor', 'codex', 'shell', 'opencode', 'muse'] as const) {
      assert.deepEqual(
        resolveProviderAuthEnv(unmapped, { processEnv: { ANTHROPIC_API_KEY: 'x' } }),
        {},
      );
    }
    assert.deepEqual(resolveProviderAuthEnv(undefined, { processEnv: {} }), {});
  });

  it('does not leak another provider token into this flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('kimi', { processEnv: { ZAI_API_TOKEN: 'tok-zai' } }),
      {},
    );
  });
});

describe('resolveProviderRuntimeEnv — provider CLI defaults', () => {
  it('returns the z.ai endpoint, model defaults, timeout, and compaction window', () => {
    assert.deepEqual(resolveProviderRuntimeEnv('zai'), {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.2[1m]',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2[1m]',
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
    });
  });

  it('returns nothing for non-provider shell types and undefined', () => {
    for (const shellType of ['claude', 'cursor', 'codex', 'shell', 'opencode', 'muse'] as const) {
      assert.deepEqual(resolveProviderRuntimeEnv(shellType), {});
    }
    assert.deepEqual(resolveProviderRuntimeEnv(undefined), {});
  });
});

describe('createFtownSession — provider runtime env', () => {
  it('adds z.ai runtime defaults for CLI-spawned sessions and maps only the auth target', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(join(home, '.ftown', 'env.json'), JSON.stringify({ ZAI_API_TOKEN: 'tok-zai' }));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    const harness = fakeDeps();

    try {
      const session = await createFtownSession(harness.deps, {
        shellType: 'zai',
        prompt: 'do provider work',
      });

      assert.strictEqual(session.env?.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
      assert.strictEqual(session.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'glm-5.2[1m]');
      assert.strictEqual(session.env?.ANTHROPIC_AUTH_TOKEN, 'tok-zai');
      assert.strictEqual(session.env?.ZAI_API_TOKEN, undefined);
      assert.deepEqual(harness.runs[0].env, session.env);
      assert.match(harness.runs[0].command, /^claude --allow-dangerously-skip-permissions 'do provider work'$/);
      assert.strictEqual(harness.runs[0].initialInput, undefined);
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lets caller env override provider defaults while provider auth still wins', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    mkdirSync(join(home, '.ftown'), { recursive: true });
    writeFileSync(join(home, '.ftown', 'env.json'), JSON.stringify({ ZAI_API_TOKEN: 'tok-zai' }));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    const harness = fakeDeps();

    try {
      const session = await createFtownSession(harness.deps, {
        shellType: 'zai',
        env: {
          ANTHROPIC_BASE_URL: 'https://custom.example/anthropic',
          ANTHROPIC_DEFAULT_OPUS_MODEL: 'custom-opus',
          ANTHROPIC_AUTH_TOKEN: 'do-not-use',
        },
      });

      assert.strictEqual(session.env?.ANTHROPIC_BASE_URL, 'https://custom.example/anthropic');
      assert.strictEqual(session.env?.ANTHROPIC_DEFAULT_OPUS_MODEL, 'custom-opus');
      assert.strictEqual(session.env?.ANTHROPIC_AUTH_TOKEN, 'tok-zai');
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// Creating a provider-flavored session without its machine token must fail loudly with a
// fixable, secret-free error — naming the env-var KEY and the `ftown env set` remedy,
// never the token value.
describe('assertProviderAuthAvailable — mapped flavors require a token', () => {
  it('throws ProviderAuthMissingError naming provider, source KEY and fix when absent everywhere', () => {
    assert.throws(
      () => assertProviderAuthAvailable('zai', { processEnv: {}, storeEnv: {}, inputEnv: {} }),
      (err: unknown) => {
        assert.ok(err instanceof ProviderAuthMissingError);
        assert.strictEqual(err.name, 'ProviderAuthMissingError');
        assert.strictEqual(err.provider, 'zai');
        assert.strictEqual(err.source, 'ZAI_API_TOKEN');
        assert.strictEqual(err.fix, 'ftown env set zai <token>');
        assert.ok(err.message.includes('zai'));
        assert.ok(err.message.includes('ZAI_API_TOKEN'));
        assert.ok(err.message.includes('ftown env set zai <token>'));
        return true;
      },
    );
  });

  it('carries the correct source KEY and fix per mapped flavor', () => {
    const cases = [
      ['fireworks', 'FIREWORKS_API_TOKEN'],
      ['kimi', 'KIMI_API_TOKEN'],
      ['deepseek', 'DEEPSEEK_API_TOKEN'],
    ] as const;
    for (const [flavor, source] of cases) {
      assert.throws(
        () => assertProviderAuthAvailable(flavor, { processEnv: {} }),
        (err: unknown) => {
          assert.ok(err instanceof ProviderAuthMissingError);
          assert.strictEqual(err.provider, flavor);
          assert.strictEqual(err.source, source);
          assert.strictEqual(err.fix, `ftown env set ${flavor} <token>`);
          return true;
        },
      );
    }
  });

  it('never embeds the token value in the error (only the KEY)', () => {
    // No value can exist when the token is absent, but guard against a future regression
    // that surfaces a found value in the message: the message must not contain a token.
    assert.throws(
      () => assertProviderAuthAvailable('zai', { processEnv: {} }),
      (err: unknown) => err instanceof ProviderAuthMissingError && !err.message.includes('tok-'),
    );
  });

  it('does not throw when the token is present in ANY source', () => {
    assert.doesNotThrow(() =>
      assertProviderAuthAvailable('zai', { processEnv: { ZAI_API_TOKEN: 'p' } }),
    );
    assert.doesNotThrow(() =>
      assertProviderAuthAvailable('zai', { processEnv: {}, storeEnv: { ZAI_API_TOKEN: 's' } }),
    );
    assert.doesNotThrow(() =>
      assertProviderAuthAvailable('zai', { processEnv: {}, inputEnv: { ZAI_API_TOKEN: 'i' } }),
    );
  });

  it('does not throw for unmapped shell types or undefined', () => {
    for (const unmapped of ['claude', 'cursor', 'codex', 'shell', 'opencode', 'muse'] as const) {
      assert.doesNotThrow(() => assertProviderAuthAvailable(unmapped, { processEnv: {} }));
    }
    assert.doesNotThrow(() => assertProviderAuthAvailable(undefined, { processEnv: {} }));
  });
});

// Non-throwing twin of the guard, used by resurrection to re-block a dead session whose
// provider token has since disappeared. Must mirror the guard symmetrically.
describe('findMissingProviderAuth — non-throwing guard twin', () => {
  it('returns the same error the guard would throw when the token is missing', () => {
    const err = findMissingProviderAuth('deepseek', { processEnv: {}, storeEnv: {} });
    assert.ok(err instanceof ProviderAuthMissingError);
    assert.strictEqual(err.provider, 'deepseek');
    assert.strictEqual(err.source, 'DEEPSEEK_API_TOKEN');
    assert.strictEqual(err.fix, 'ftown env set deepseek <token>');
  });

  it('returns undefined when the token is present in any source', () => {
    assert.strictEqual(
      findMissingProviderAuth('zai', { processEnv: {}, storeEnv: { ZAI_API_TOKEN: 's' } }),
      undefined,
    );
  });

  it('returns undefined for unmapped shell types and undefined', () => {
    assert.strictEqual(findMissingProviderAuth('claude', { processEnv: {} }), undefined);
    assert.strictEqual(findMissingProviderAuth(undefined, { processEnv: {} }), undefined);
  });
});

// The custom-vs-builder relaunch-command heuristic has exactly one home: the session
// module. Resurrection and the revive route both consume it from here.
describe('deriveRelaunchCommand — single home of the relaunch heuristic', () => {
  const stored = {
    shellType: 'claude' as const,
    workingDir: undefined,
    model: undefined,
    claudeSessionId: 'sess-abc',
    cursorSessionId: undefined,
    codexSessionId: undefined,
  };
  const builderDefault = buildSessionCommand({ shellType: 'claude' });
  const builderResume = buildSessionCommand({ shellType: 'claude', claudeSessionId: 'sess-abc' });

  it('rebuilds a builder-default stored command into the resume command', () => {
    const derived = deriveRelaunchCommand({ ...stored, command: builderDefault });
    assert.deepEqual(derived, { command: builderResume, isCustom: false });
    assert.match(derived.command, /--resume 'sess-abc'/);
  });

  it('treats a stored command matching the resume build as builder-generated too', () => {
    assert.deepEqual(deriveRelaunchCommand({ ...stored, command: builderResume }), {
      command: builderResume,
      isCustom: false,
    });
  });

  it('reruns a custom command verbatim instead of injecting --resume', () => {
    const derived = deriveRelaunchCommand({ ...stored, command: 'my-wrapper --flag' });
    assert.deepEqual(derived, { command: 'my-wrapper --flag', isCustom: true });
  });

  it('rebuilds a builder-default kimi-code stored command into the -c resume command (workdir-based)', () => {
    const kimiStored = {
      shellType: 'kimi-code' as const,
      workingDir: '/tmp/work',
      model: undefined,
      claudeSessionId: undefined,
      cursorSessionId: undefined,
      codexSessionId: undefined,
    };
    const kimiDefault = buildSessionCommand({ shellType: 'kimi-code' });
    const derived = deriveRelaunchCommand({ ...kimiStored, command: kimiDefault });
    assert.strictEqual(derived.isCustom, false);
    assert.match(derived.command, /--yolo -c$/);
  });

  it('rebuilds a builder-default Pi command into a workdir-based -c resume command', () => {
    const piStored = {
      shellType: 'pi' as const,
      workingDir: '/tmp/work',
      model: 'anthropic/claude-sonnet-4',
      claudeSessionId: undefined,
      cursorSessionId: undefined,
      codexSessionId: undefined,
    };
    const piDefault = buildSessionCommand({ shellType: 'pi', model: piStored.model });
    assert.deepEqual(deriveRelaunchCommand({ ...piStored, command: piDefault }), {
      command: "pi --extension \"$HOME/.ftown/pi/ftown.js\" -c --model 'anthropic/claude-sonnet-4'",
      isCustom: false,
    });
  });

  it('relaunches the exact Pi conversation after its extension reports a native id', () => {
    const stored = {
      shellType: 'pi' as const,
      command: buildSessionCommand({ shellType: 'pi' }),
      piSessionId: '550e8400-e29b-41d4-a716-446655440000',
    };

    assert.deepEqual(deriveRelaunchCommand(stored), {
      command: "pi --extension \"$HOME/.ftown/pi/ftown.js\" --session '550e8400-e29b-41d4-a716-446655440000'",
      isCustom: false,
    });
  });

  it('rebuilds a builder-default muse stored command into the resume-by-id command', () => {
    const museDefault = buildSessionCommand({ shellType: 'muse', workingDir: '/tmp/work' });
    assert.deepEqual(deriveRelaunchCommand({
      shellType: 'muse',
      command: museDefault,
      workingDir: '/tmp/work',
      museSessionId: 'sess-abc',
    }), {
      command: "muse --yolo --workspace '/tmp/work' resume 'sess-abc'",
      isCustom: false,
    });
  });

  it('upgrades a pre-extension Pi command to the hooked resume command', () => {
    assert.deepEqual(deriveRelaunchCommand({
      shellType: 'pi',
      model: 'openai/gpt-5',
      command: "pi --model 'openai/gpt-5'",
    }), {
      command: "pi --extension \"$HOME/.ftown/pi/ftown.js\" -c --model 'openai/gpt-5'",
      isCustom: false,
    });
  });

  it('KNOWN LIMITATION: a pre-model-fix claude session (stored command lacks --model) is misclassified as custom and relaunched without --model or --resume', () => {
    const derived = deriveRelaunchCommand({
      ...stored,
      model: 'opus',
      // Stored before the builder emitted --model, so it no longer matches the builder output.
      command: buildSessionCommand({ shellType: 'claude' }),
    });
    assert.strictEqual(derived.isCustom, true);
    assert.strictEqual(derived.command, buildSessionCommand({ shellType: 'claude' }));
    assert.doesNotMatch(derived.command, /--resume|--model/);
  });
});

describe('canResumeStoredSession — which stored sessions can resume', () => {
  it('routes each harness to its own recorded agent-session id', () => {
    assert.strictEqual(canResumeStoredSession({ shellType: 'claude', claudeSessionId: 'c' }), true);
    assert.strictEqual(canResumeStoredSession({ shellType: undefined, claudeSessionId: 'c' }), true);
    assert.strictEqual(canResumeStoredSession({ shellType: 'cursor', cursorSessionId: 'u' }), true);
    assert.strictEqual(canResumeStoredSession({ shellType: 'codex', codexSessionId: 'x' }), true);
    assert.strictEqual(canResumeStoredSession({ shellType: 'cursor', claudeSessionId: 'c' }), false);
    assert.strictEqual(canResumeStoredSession({ shellType: 'codex', claudeSessionId: 'c' }), false);
  });

  it('resumes kimi-code by working directory — no recorded id required', () => {
    assert.strictEqual(canResumeStoredSession({ shellType: 'kimi-code' }), true);
    assert.strictEqual(canResumeStoredSession({ shellType: 'kimi-code', claudeSessionId: '  ' }), true);
  });

  it('resumes muse by its captured plugin-reported session id', () => {
    assert.strictEqual(canResumeStoredSession({ shellType: 'muse', museSessionId: 'sess_1' }), true);
    assert.strictEqual(canResumeStoredSession({ shellType: 'muse', claudeSessionId: 'c' }), false);
    assert.strictEqual(canResumeStoredSession({ shellType: 'muse' }), false);
  });

  it('resumes Pi by working directory — no recorded id required', () => {
    assert.strictEqual(canResumeStoredSession({ shellType: 'pi' }), true);
  });

  it('resumes opencode by its captured plugin-reported session id', () => {
    assert.strictEqual(canResumeStoredSession({ shellType: 'opencode', opencodeSessionId: 'ses_1' }), true);
    assert.strictEqual(canResumeStoredSession({ shellType: 'opencode', claudeSessionId: 'c' }), false);
    assert.strictEqual(canResumeStoredSession({ shellType: 'opencode' }), false);
  });

  it('never resumes plain shells or sessions with no recorded id', () => {
    assert.strictEqual(canResumeStoredSession({ shellType: 'shell', claudeSessionId: 'c' }), false);
    assert.strictEqual(canResumeStoredSession({ shellType: 'claude' }), false);
    assert.strictEqual(canResumeStoredSession({ shellType: 'claude', claudeSessionId: '  ' }), false);
  });
});

describe('createFtownSession — Pi launch', () => {
  it('passes the task and model on the Pi command line without typed-input races', async () => {
    const harness = fakeDeps();
    const session = await createFtownSession(harness.deps, {
      shellType: 'pi',
      model: 'openai/gpt-5',
      prompt: "inspect today's changes",
    });

    assert.strictEqual(session.shellType, 'pi');
    assert.strictEqual(
      session.command,
      "pi --extension \"$HOME/.ftown/pi/ftown.js\" --model 'openai/gpt-5'",
    );
    assert.strictEqual(
      harness.runs[0].command,
      "pi --extension \"$HOME/.ftown/pi/ftown.js\" --model 'openai/gpt-5' 'inspect today'\\''s changes'",
    );
    assert.strictEqual(harness.runs[0].initialInput, undefined);
  });

  it('createFtownSession — opencode launch passes the prompt as a --prompt CLI arg', async () => {
    const harness = fakeDeps();
    const session = await createFtownSession(harness.deps, {
      shellType: 'opencode',
      model: 'anthropic/claude-sonnet-4-5',
      prompt: "inspect today's changes",
    });

    assert.strictEqual(session.shellType, 'opencode');
    assert.strictEqual(session.command, "opencode --auto -m 'anthropic/claude-sonnet-4-5'");
    assert.strictEqual(
      harness.runs[0].command,
      "opencode --auto -m 'anthropic/claude-sonnet-4-5' --prompt 'inspect today'\\''s changes'",
    );
    // No typed-input race: the prompt rode the command line.
    assert.strictEqual(harness.runs[0].initialInput, undefined);
  });
});

// All three session-launch entry points — fresh create with a resume id, the
// retry_session RPC, and restart resurrection — must hand the runner the same
// invocation. This is the lock on "how is a session launched has one answer".
describe('relaunchFtownSession — retained terminal geometry', () => {
  it('uses current manager dimensions for retry and resume, including later resizes', async () => {
    const h = fakeDeps();
    const manager = new TerminalManager();
    const session = { ...fakeSession('sized'), status: 'error' as const };
    manager.write(session.id, '');
    manager.resize(session.id, 80, 37);
    h.deps.getTerminalSize = (id) => manager.getSize(id);
    try {
      await relaunchFtownSession(h.deps, session, 'retry');
      await relaunchFtownSession(h.deps, session, 'resume');
      manager.resize(session.id, 91, 29);
      await relaunchFtownSession(h.deps, session, 'retry');
      assert.deepEqual(h.runs.map(({ cols, rows }) => ({ cols, rows })), [
        { cols: 80, rows: 37 }, { cols: 80, rows: 37 }, { cols: 91, rows: 29 },
      ]);
    } finally { manager.destroy(session.id); }
  });

  it('omits dimensions with no lookup or when the lookup has no terminal', async () => {
    const h = fakeDeps();
    const session = { ...fakeSession('missing'), status: 'error' as const };
    await relaunchFtownSession(h.deps, session, 'retry');
    h.deps.getTerminalSize = () => undefined;
    await relaunchFtownSession(h.deps, session, 'resume');
    for (const run of h.runs) {
      assert.equal(Object.hasOwn(run, 'cols'), false);
      assert.equal(Object.hasOwn(run, 'rows'), false);
    }
  });

  it('reads dimensions after awaited preparation and does not affect fresh creates', async () => {
    const h = fakeDeps();
    const manager = new TerminalManager();
    const session = { ...fakeSession('late-size'), status: 'error' as const };
    manager.write(session.id, '');
    manager.resize(session.id, 80, 37);
    h.deps.getTerminalSize = (id) => manager.getSize(id);
    h.deps.centrifugo.publishSessionUpdate = async () => { manager.resize(session.id, 94, 31); };
    try {
      await relaunchFtownSession(h.deps, session, 'retry');
      assert.deepEqual({ cols: h.runs[0].cols, rows: h.runs[0].rows }, { cols: 94, rows: 31 });
      await createFtownSession(h.deps, { command: 'cmd', shellType: 'shell' });
      assert.equal(Object.hasOwn(h.runs[1], 'cols'), false);
      assert.equal(Object.hasOwn(h.runs[1], 'rows'), false);
    } finally { manager.destroy(session.id); }
  });
});

describe('relaunchFtownSession — entry-point parity with createFtownSession', () => {
  it('fresh create with a resume id, retry, and resume relaunch produce the same runner.run invocation', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    const harness = fakeDeps();

    try {
      const session = await createFtownSession(harness.deps, {
        shellType: 'claude',
        claudeSessionId: 'sess-abc',
      });
      session.status = 'error';
      await relaunchFtownSession(harness.deps, session, 'retry');
      session.status = 'error';
      await relaunchFtownSession(harness.deps, session, 'resume');

      assert.strictEqual(harness.runs.length, 3);
      const shape = (run: RecordedRun) => ({
        sessionId: run.sessionId,
        command: run.command,
        workingDir: run.workingDir,
        env: run.env,
        hookPort: run.hookPort,
        hookToken: run.hookToken,
        parentSessionId: run.parentSessionId,
      });
      const [create, retry, resume] = harness.runs.map(shape);
      assert.match(create.command, /--resume 'sess-abc'/);
      assert.deepEqual(retry, create);
      assert.deepEqual(resume, create);
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('retry reruns the stored command verbatim and leaves runtime/errorReason untouched', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    const harness = fakeDeps();
    const session: Session = {
      ...fakeSession('retry-me'),
      command: 'my-wrapper --flag',
      status: 'error',
      errorReason: 'boom',
      runtime: 'tmux',
      bridgeId: 'old-bridge',
      env: { FOO: 'bar' },
      parentSessionId: 'parent-1',
    };

    try {
      const command = await relaunchFtownSession(harness.deps, session, 'retry');
      assert.strictEqual(command, 'my-wrapper --flag');
      assert.strictEqual(session.status, 'running');
      assert.strictEqual(session.bridgeId, 'bridge');
      assert.strictEqual(session.errorReason, 'boom');
      assert.strictEqual(session.runtime, 'tmux');
      assert.strictEqual(harness.saved.length, 1);
      assert.deepEqual(harness.runs[0], {
        sessionId: 'retry-me',
        command: 'my-wrapper --flag',
        workingDir: undefined,
        env: { FOO: 'bar' },
        initialInput: undefined,
        initialInputDelay: undefined,
        submitSuffix: undefined,
        hookPort: 1,
        hookToken: 'token',
        parentSessionId: 'parent-1',
      });
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('resume relaunch derives the command via the heuristic, refreshes runtime, and clears errorReason', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    const harness = fakeDeps();
    const session: Session = {
      ...fakeSession('resume-me'),
      command: buildSessionCommand({ shellType: 'claude' }),
      shellType: 'claude',
      claudeSessionId: 'sess-xyz',
      status: 'error',
      errorReason: 'stale',
      runtime: 'tmux',
    };

    try {
      const command = await relaunchFtownSession(harness.deps, session, 'resume');
      assert.strictEqual(command, buildSessionCommand({ shellType: 'claude', claudeSessionId: 'sess-xyz' }));
      assert.strictEqual(session.status, 'running');
      assert.strictEqual(session.errorReason, undefined);
      assert.strictEqual(session.runtime, 'direct');
      assert.strictEqual(harness.runs[0].command, command);
    } finally {
      restoreHome(realHome);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('refuses to retry a session with no stored command (pre-v0.2.0 records)', async () => {
    const harness = fakeDeps();
    const session: Session = { ...fakeSession('no-cmd'), command: '', status: 'error' };
    await assert.rejects(
      () => relaunchFtownSession(harness.deps, session, 'retry'),
      /Session has no command to relaunch/,
    );
    assert.strictEqual(harness.saved.length, 0);
    assert.strictEqual(harness.runs.length, 0);
  });
});

describe('buildChildBriefing', () => {
  it('identifies the child and parent and directs result and escalation reporting through mail', () => {
    const briefing = buildChildBriefing({
      childName: 'worker',
      childId: 'c1',
      parentName: 'orch',
      parentId: 'p1',
    });
    assert.match(briefing, /child session 'worker' \(c1\)/);
    assert.match(briefing, /parent 'orch' \(p1\)/);
    assert.match(briefing, /ftown harness mail send --parent --type result/);
    assert.match(briefing, /--type escalation when blocked/);
    assert.doesNotMatch(briefing, /mail read|list|screen|remove|very last|keep.*open/i);
    assert.doesNotMatch(briefing, /fticket|FTS|TICKET_ID|fallback|resource leases/i);
  });

});



describe('child task delivery', () => {
  it('keeps the requested task after the short briefing and supports suppression', async () => {
    for (const suppressBriefing of [false, true]) {
      const harness = fakeDeps([fakeSession('parent')]);
      await createFtownSession(harness.deps, { name: 'worker', shellType: 'claude', parentSessionId: 'parent', prompt: 'bounded task', suppressBriefing });
      const command = harness.runs[0].command;
      assert.match(command, /bounded task/);
      assert.doesNotMatch(command, /self-remov|very last command|keep the session open/);
      if (suppressBriefing) assert.doesNotMatch(command, /\[ftown\]|Task:/);
      else {
        assert.match(command, /\[ftown\]/);
        assert.match(command, /ftown harness mail send --parent --type result/);
        assert.match(command, /Task: bounded task/);
      }
    }
  });
});


describe('legacy orchestrator compatibility', () => {
  it('ignores role requests while preserving task, parent and explicitly supplied env', async () => {
    for (const legacy of [false, true]) {
      const harness = fakeDeps([fakeSession('parent')]);
      await createFtownSession(harness.deps, { name: 'ordinary', shellType: 'claude', parentSessionId: 'parent', prompt: 'ordinary task', orchestrator: legacy });
      assert.equal(harness.saved[0].env, undefined);
      assert.equal(harness.saved[0].parentSessionId, 'parent');
      assert.match(harness.runs[0].command, /ordinary task/);
      assert.doesNotMatch(harness.runs[0].command, /ORCHESTRATOR|references\/orchestrator/);
    }
    const harness = fakeDeps();
    await createFtownSession(harness.deps, { shellType: 'claude', prompt: 'keep my env', env: { FTOWN_ORCHESTRATOR: 'custom', USER_SETTING: 'keep' }, orchestrator: true });
    assert.deepEqual(harness.saved[0].env, { FTOWN_ORCHESTRATOR: 'custom', USER_SETTING: 'keep' });
    assert.equal(parseCreateSessionBody({ orchestrator: true, prompt: 'task' }).orchestrator, undefined);
  });
});

// These are actual create calls with the browser's commandless payload shape.
// Expectations assert the external launch contract, not another command builder.
describe('commandless standard launch boundary', () => {
  it('uses registry model/workspace flags and delivers the quoted task exactly once', async () => {
    const realHome = process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const home = mkdtempSync(join(tmpdir(), 'ftown-structured-unit-'));
    process.env[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'] = home;
    try {
      const prompt = "inspect today's changes";
      const quotedPrompt = "'inspect today'\\''s changes'";
      const cases = [
        { shellType: 'claude', base: "claude --allow-dangerously-skip-permissions --model 'provider/model'" },
        { shellType: 'cursor', base: `agent --force --workspace '${home}' --model 'provider/model'` },
        { shellType: 'codex', base: "codex --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust -m 'provider/model'" },
        { shellType: 'grok', base: "grok --always-approve -m 'provider/model'" },
        { shellType: 'muse', base: `muse --yolo --workspace '${home}' --model 'provider/model'` },
      ] as const;
      for (const { shellType, base } of cases) {
        const h = fakeDeps();
        const session = await createFtownSession(h.deps, { shellType, model: 'provider/model', prompt,
          workingDir: home, env: { CUSTOM_SETTING: 'kept verbatim' } });
        assert.equal(session.command, base, `${shellType}: persisted command excludes the task`);
        assert.equal(session.prompt, prompt);
        assert.equal(session.model, 'provider/model');
        assert.equal(h.runs[0].command, `${base} ${quotedPrompt}`);
        assert.equal(h.runs[0].workingDir, home);
        assert.equal(h.runs[0].env?.CUSTOM_SETTING, 'kept verbatim');
        assert.equal(h.runs[0].initialInput, undefined, `${shellType}: no second typed task`);
        assert.equal(h.runs[0].initialInputDelay, undefined);
        assert.equal(h.runs[0].submitSuffix, undefined);
      }
    } finally { restoreHome(realHome); rmSync(home, { recursive: true, force: true }); }
  });

  it('retains typed task delivery for shell and kimi-code without putting it into the command', async () => {
    for (const shellType of ['shell', 'kimi-code'] as const) {
      const h = fakeDeps();
      const session = await createFtownSession(h.deps, { shellType, prompt: 'one task' });
      assert.equal(h.runs[0].command, session.command);
      assert.equal(h.runs[0].command.includes('one task'), false);
      assert.equal(h.runs[0].initialInput, 'one task');
      assert.equal(h.runs[0].initialInputDelay, 2000);
      assert.equal(h.runs[0].submitSuffix, '\r');
    }
  });

  it('delivers a new resume-create task once but never replays it on resurrection', async () => {
    const h = fakeDeps();
    const session = await createFtownSession(h.deps, { shellType: 'claude', claudeSessionId: 'native-id',
      model: 'chosen-model', prompt: 'new follow-up task' });
    assert.match(h.runs[0].command, /--model 'chosen-model' --resume 'native-id'$/);
    assert.equal(h.runs[0].command.includes('new follow-up task'), false);
    assert.equal(h.runs[0].initialInput, 'new follow-up task');
    assert.equal(h.runs[0].submitSuffix, '\r');
    session.status = 'error';
    await relaunchFtownSession(h.deps, session, 'resume');
    assert.equal(h.runs[1].command, h.runs[0].command);
    assert.equal(h.runs[1].initialInput, undefined);
    assert.equal(h.runs[1].initialInputDelay, undefined);
  });

  it('preserves old-browser/custom commands and raw input byte-for-byte', async () => {
    const h = fakeDeps();
    const command = "my-wrapper --custom 'chosen model'";
    const session = await createFtownSession(h.deps, { shellType: 'claude', command, prompt: 'metadata only',
      initialInput: 'raw input\r', initialInputDelay: 37, env: { WRAPPER_SETTING: 'preserved' } });
    assert.equal(session.command, command);
    assert.equal(h.runs[0].command, command);
    assert.equal(h.runs[0].initialInput, 'raw input\r');
    assert.equal(h.runs[0].initialInputDelay, 37);
    assert.equal(h.runs[0].submitSuffix, '');
    assert.equal(h.runs[0].env?.WRAPPER_SETTING, 'preserved');
  });
});

describe('update launch admission', () => {
  it('drains an already-admitted relaunch and refuses new creates while frozen', async () => {
    const { UpdateAdmission } = await import('./update-admission.js');
    const admission = new UpdateAdmission();
    const { deps, runs } = fakeDeps();
    deps.updateAdmission = admission;
    let publishStarted!: () => void;
    const started = new Promise<void>(resolve => { publishStarted = resolve; });
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    deps.centrifugo.publishSessionUpdate = async () => { publishStarted(); await gate; };
    const launch = relaunchFtownSession(deps, fakeSession('existing'), 'retry');
    await started; admission.freeze();
    await assert.rejects(createFtownSession(deps, { command: 'safe', shellType: 'shell' }), /update in progress/i);
    let drained = false; const drain = admission.drain(1000).then(() => { drained = true; });
    await Promise.resolve(); assert.equal(drained, false);
    resume(); await launch; await drain;
    assert.equal(runs.length, 1);
  });
});
