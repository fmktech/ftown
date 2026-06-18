import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderAuthMissingError, WorkingDirMissingError } from './create-ftown-session.js';
import { providerAuthMissingResponse, workingDirMissingResponse } from './local-api-server.js';

// A blocked provider create/revive must surface as a 422 carrying the provider,
// the env-var KEY-bearing message, and the `ftown env set` fix — and NEVER the
// secret token itself. providerAuthMissingResponse builds that body once so both
// the create and revive catch branches stay identical.
describe('providerAuthMissingResponse', () => {
  it('maps a ProviderAuthMissingError to a 422 with {error, provider, fix}', () => {
    const err = new ProviderAuthMissingError('zai', 'ZAI_API_TOKEN', 'ftown env set zai <token>');
    const response = providerAuthMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.provider, 'zai');
    assert.strictEqual(response.body.fix, 'ftown env set zai <token>');
  });

  it('carries only the env-var KEY and fix, never a token value', () => {
    const secret = 'sk-super-secret-token-value-1234';
    const err = new ProviderAuthMissingError('kimi', 'KIMI_API_TOKEN', 'ftown env set kimi <token>');
    const response = providerAuthMissingResponse(err);

    const serialized = JSON.stringify(response.body);
    assert.ok(serialized.includes('KIMI_API_TOKEN'), 'body should name the env-var KEY');
    assert.ok(!serialized.includes(secret), 'body must not contain any token value');
    assert.strictEqual(response.body.provider, 'kimi');
    assert.strictEqual(response.body.fix, 'ftown env set kimi <token>');
  });

  it('echoes the provider flavor verbatim for each mapped flavor', () => {
    for (const provider of ['zai', 'fireworks', 'kimi', 'deepseek']) {
      const err = new ProviderAuthMissingError(
        provider,
        `${provider.toUpperCase()}_API_TOKEN`,
        `ftown env set ${provider} <token>`,
      );
      const response = providerAuthMissingResponse(err);
      assert.strictEqual(response.status, 422);
      assert.strictEqual(response.body.provider, provider);
      assert.strictEqual(response.body.fix, `ftown env set ${provider} <token>`);
    }
  });
});

describe('workingDirMissingResponse', () => {
  it('maps a WorkingDirMissingError to a 422 with a createable code and path', () => {
    const err = new WorkingDirMissingError('/tmp/missing-project');
    const response = workingDirMissingResponse(err);

    assert.strictEqual(response.status, 422);
    assert.strictEqual(response.body.error, err.message);
    assert.strictEqual(response.body.code, 'working_dir_missing');
    assert.strictEqual(response.body.workingDir, '/tmp/missing-project');
    assert.strictEqual(response.body.canCreate, true);
  });
});
