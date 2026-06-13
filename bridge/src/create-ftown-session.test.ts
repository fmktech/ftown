import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertProviderAuthAvailable,
  buildChildBriefing,
  findMissingProviderAuth,
  parseCreateSessionBody,
  ProviderAuthMissingError,
  resolveProviderAuthEnv,
} from './create-ftown-session.js';

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
