import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildChildBriefing, parseCreateSessionBody, resolveProviderAuthEnv } from './create-ftown-session.js';

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
// through the browser or the spawn command.
describe('resolveProviderAuthEnv — provider token mapping', () => {
  it('maps ZAI_API_TOKEN -> ANTHROPIC_AUTH_TOKEN for the zai flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('zai', { ZAI_API_TOKEN: 'tok-zai' }),
      { ANTHROPIC_AUTH_TOKEN: 'tok-zai' },
    );
  });

  it('maps FIREWORKS_API_TOKEN -> ANTHROPIC_AUTH_TOKEN for the fireworks flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('fireworks', { FIREWORKS_API_TOKEN: 'tok-fw' }),
      { ANTHROPIC_AUTH_TOKEN: 'tok-fw' },
    );
  });

  it('maps KIMI_API_TOKEN -> ANTHROPIC_API_KEY for the kimi flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('kimi', { KIMI_API_TOKEN: 'tok-kimi' }),
      { ANTHROPIC_API_KEY: 'tok-kimi' },
    );
  });

  it('maps DEEPSEEK_API_TOKEN -> ANTHROPIC_API_KEY for the deepseek flavor', () => {
    assert.deepEqual(
      resolveProviderAuthEnv('deepseek', { DEEPSEEK_API_TOKEN: 'tok-ds' }),
      { ANTHROPIC_API_KEY: 'tok-ds' },
    );
  });

  it('returns nothing when the provider token is absent', () => {
    assert.deepEqual(resolveProviderAuthEnv('zai', {}), {});
  });

  it('returns nothing for non-provider shell types (plain claude/cursor/codex/shell)', () => {
    assert.deepEqual(resolveProviderAuthEnv('claude', { ANTHROPIC_API_KEY: 'x' }), {});
    assert.deepEqual(resolveProviderAuthEnv(undefined, {}), {});
  });

  it('does not leak another provider token into this flavor', () => {
    assert.deepEqual(resolveProviderAuthEnv('kimi', { ZAI_API_TOKEN: 'tok-zai' }), {});
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
