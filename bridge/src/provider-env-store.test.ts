import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROVIDER_AUTH_ENV,
  PROVIDER_FLAVORS,
  getProviderToken,
  listProviderEnv,
  loadProviderEnv,
  removeProviderToken,
  setProviderToken,
} from './provider-env-store.js';

// Overrides $HOME so every read/write targets a throwaway ~/.ftown/env.json,
// mirroring claude-trust.test.ts. homedir() reads $HOME at call time.
describe('provider-env-store', () => {
  let realHome: string | undefined;
  let home: string;

  beforeEach(() => {
    realHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), 'ftw-env-'));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  const envDir = () => join(home, '.ftown');
  const envPath = () => join(home, '.ftown', 'env.json');

  describe('loadProviderEnv', () => {
    it('returns {} when env.json is absent', () => {
      assert.deepStrictEqual(loadProviderEnv(), {});
    });

    it('returns {} on corrupt JSON without throwing', () => {
      mkdirSync(envDir(), { recursive: true, mode: 0o700 });
      writeFileSync(envPath(), '{ this is : not json', { mode: 0o600 });
      assert.doesNotThrow(() => loadProviderEnv());
      assert.deepStrictEqual(loadProviderEnv(), {});
    });
  });

  describe('setProviderToken', () => {
    it('writes env.json at mode 0o600 inside a 0o700 dir', () => {
      setProviderToken('ZAI_API_TOKEN', 'secret-value');

      const fileMode = statSync(envPath()).mode & 0o777;
      const dirMode = statSync(envDir()).mode & 0o777;
      assert.strictEqual(fileMode, 0o600);
      assert.strictEqual(dirMode, 0o700);
    });

    it('round-trips through loadProviderEnv', () => {
      setProviderToken('ZAI_API_TOKEN', 'zai-secret');
      assert.deepStrictEqual(loadProviderEnv(), { ZAI_API_TOKEN: 'zai-secret' });
      assert.strictEqual(getProviderToken('ZAI_API_TOKEN'), 'zai-secret');
    });

    it('a second set preserves other keys', () => {
      setProviderToken('ZAI_API_TOKEN', 'zai-1');
      setProviderToken('FIREWORKS_API_TOKEN', 'fw-1');
      setProviderToken('ZAI_API_TOKEN', 'zai-2');

      assert.deepStrictEqual(loadProviderEnv(), {
        ZAI_API_TOKEN: 'zai-2',
        FIREWORKS_API_TOKEN: 'fw-1',
      });
    });
  });

  describe('getProviderToken', () => {
    it('returns undefined for an absent key', () => {
      assert.strictEqual(getProviderToken('KIMI_API_TOKEN'), undefined);
    });
  });

  describe('removeProviderToken', () => {
    it('returns true then false, dropping only that key', () => {
      setProviderToken('ZAI_API_TOKEN', 'zai-1');
      setProviderToken('KIMI_API_TOKEN', 'kimi-1');

      assert.strictEqual(removeProviderToken('ZAI_API_TOKEN'), true);
      assert.strictEqual(removeProviderToken('ZAI_API_TOKEN'), false);
      assert.deepStrictEqual(loadProviderEnv(), { KIMI_API_TOKEN: 'kimi-1' });
    });

    it('returns false when nothing was ever stored', () => {
      assert.strictEqual(removeProviderToken('DEEPSEEK_API_TOKEN'), false);
    });
  });

  describe('listProviderEnv', () => {
    it('returns the raw stored map', () => {
      setProviderToken('ZAI_API_TOKEN', 'zai-1');
      setProviderToken('FIREWORKS_API_TOKEN', 'fw-1');
      assert.deepStrictEqual(listProviderEnv(), {
        ZAI_API_TOKEN: 'zai-1',
        FIREWORKS_API_TOKEN: 'fw-1',
      });
    });
  });

  describe('PROVIDER_FLAVORS / PROVIDER_AUTH_ENV', () => {
    it('lists the four flavors in order', () => {
      assert.deepStrictEqual([...PROVIDER_FLAVORS], ['zai', 'fireworks', 'kimi', 'deepseek']);
    });

    it('targets ANTHROPIC_AUTH_TOKEN for zai + fireworks', () => {
      assert.strictEqual(PROVIDER_AUTH_ENV.zai.target, 'ANTHROPIC_AUTH_TOKEN');
      assert.strictEqual(PROVIDER_AUTH_ENV.fireworks.target, 'ANTHROPIC_AUTH_TOKEN');
      assert.strictEqual(PROVIDER_AUTH_ENV.zai.source, 'ZAI_API_TOKEN');
      assert.strictEqual(PROVIDER_AUTH_ENV.fireworks.source, 'FIREWORKS_API_TOKEN');
    });

    it('targets ANTHROPIC_API_KEY for kimi + deepseek', () => {
      assert.strictEqual(PROVIDER_AUTH_ENV.kimi.target, 'ANTHROPIC_API_KEY');
      assert.strictEqual(PROVIDER_AUTH_ENV.deepseek.target, 'ANTHROPIC_API_KEY');
      assert.strictEqual(PROVIDER_AUTH_ENV.kimi.source, 'KIMI_API_TOKEN');
      assert.strictEqual(PROVIDER_AUTH_ENV.deepseek.source, 'DEEPSEEK_API_TOKEN');
    });
  });
});
