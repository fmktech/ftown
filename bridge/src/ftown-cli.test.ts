import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSubcommandTarget, usage } from './ftown-cli.js';

const FTOWN_DIR = '/home/tester/.ftown';

describe('resolveSubcommandTarget', () => {
  it('routes env to the sibling ftown-env launcher', () => {
    assert.strictEqual(
      resolveSubcommandTarget('env', FTOWN_DIR),
      join(FTOWN_DIR, 'ftown-env'),
    );
  });

  it('routes sessions to the sibling ftown-sessions launcher', () => {
    assert.strictEqual(
      resolveSubcommandTarget('sessions', FTOWN_DIR),
      join(FTOWN_DIR, 'ftown-sessions'),
    );
  });

  it('routes workflows to the sibling ftown-workflows launcher', () => {
    assert.strictEqual(
      resolveSubcommandTarget('workflows', FTOWN_DIR),
      join(FTOWN_DIR, 'ftown-workflows'),
    );
  });

  it('routes harness to the bin/ftown-harness launcher', () => {
    assert.strictEqual(
      resolveSubcommandTarget('harness', FTOWN_DIR),
      join(FTOWN_DIR, 'bin', 'ftown-harness'),
    );
  });

  it('throws on an undefined subcommand, listing the valid ones', () => {
    assert.throws(
      () => resolveSubcommandTarget(undefined, FTOWN_DIR),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        for (const sub of ['env', 'sessions', 'workflows', 'harness']) {
          assert.ok(err.message.includes(sub), `message should mention "${sub}"`);
        }
        return true;
      },
    );
  });

  it('throws on an unknown subcommand, listing the valid ones', () => {
    assert.throws(
      () => resolveSubcommandTarget('bogus', FTOWN_DIR),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('bogus'));
        for (const sub of ['env', 'sessions', 'workflows', 'harness']) {
          assert.ok(err.message.includes(sub), `message should mention "${sub}"`);
        }
        return true;
      },
    );
  });
});

describe('usage', () => {
  it('mentions all four subcommands', () => {
    const text = usage();
    for (const sub of ['env', 'sessions', 'workflows', 'harness']) {
      assert.ok(text.includes(sub), `usage should mention "${sub}"`);
    }
  });

  it('starts with the canonical Usage line', () => {
    assert.ok(
      usage().startsWith('Usage: ftown <env|sessions|workflows|harness> [args...]'),
    );
  });
});
