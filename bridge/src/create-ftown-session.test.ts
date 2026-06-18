import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertProviderAuthAvailable,
  buildChildBriefing,
  createFtownSession,
  nextAvailableGeneratedName,
  findMissingProviderAuth,
  parseCreateSessionBody,
  prepareWorkingDir,
  ProviderAuthMissingError,
  resolveProviderAuthEnv,
  WorkingDirMissingError,
} from './create-ftown-session.js';
import type { CreateFtownSessionDeps } from './create-ftown-session.js';
import type { Session } from './types.js';

function restoreHome(realHome: string | undefined): void {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
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

function fakeDeps(existingSessions: Session[] = []): {
  deps: CreateFtownSessionDeps;
  saved: Session[];
  runs: Array<{ sessionId: string; command: string; workingDir?: string }>;
} {
  const sessions = [...existingSessions];
  const saved: Session[] = [];
  const runs: Array<{ sessionId: string; command: string; workingDir?: string }> = [];

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
        run: (sessionId: string, command: string, opts: { workingDir?: string }) => {
          runs.push({ sessionId, command, workingDir: opts.workingDir });
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

// FIX C: ftown-workflows children must be spawnable WITHOUT the standard child briefing,
// because that briefing tells the child to report via mail — which conflicts with the
// file-based result protocol the workflow runner polls for. The flag is carried on the
// create-session body and parsed here.
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
    const realHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    const root = mkdtempSync(join(tmpdir(), 'ftw-create-preflight-'));
    const missing = join(root, 'missing-project');
    process.env.HOME = home;
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
    const realHome = process.env.HOME;
    const home = mkdtempSync(join(tmpdir(), 'ftw-home-'));
    const root = mkdtempSync(join(tmpdir(), 'ftw-name-wd-'));
    const workdir = join(root, 'medieval-new5');
    mkdirSync(workdir);
    process.env.HOME = home;
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

  it('returns nothing for the five unmapped shell types and undefined', () => {
    for (const unmapped of ['claude', 'cursor', 'codex', 'shell', 'opencode'] as const) {
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

  it('does not throw for the five unmapped shell types or undefined', () => {
    for (const unmapped of ['claude', 'cursor', 'codex', 'shell', 'opencode'] as const) {
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

// Sanity: the standard briefing genuinely instructs mail-based reporting — which is
// exactly what we suppress for workflow children. If this ever changes, the suppression
// rationale should be revisited.
describe('buildChildBriefing', () => {
  it('instructs the child to report via ftown-harness mail (the conflicting channel)', () => {
    const briefing = buildChildBriefing({
      childName: 'worker',
      childId: 'c1',
      parentName: 'orch',
      parentId: 'p1',
    });
    assert.ok(briefing.includes('mail send --parent'));
  });
});
