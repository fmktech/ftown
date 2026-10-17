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
        for (const sub of ['env', 'sessions', 'harness']) {
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
        for (const sub of ['env', 'sessions', 'harness']) {
          assert.ok(err.message.includes(sub), `message should mention "${sub}"`);
        }
        return true;
      },
    );
  });
});

describe('retired workflow route', () => {
  it('rejects workflows even if an old launcher remains installed', () => {
    assert.throws(() => resolveSubcommandTarget('workflows', FTOWN_DIR), /Unknown subcommand/);
    assert.doesNotMatch(usage(), /workflows/);
  });
});

describe('usage', () => {
  it('mentions all three subcommands', () => {
    const text = usage();
    for (const sub of ['env', 'sessions', 'harness']) {
      assert.ok(text.includes(sub), `usage should mention "${sub}"`);
    }
  });

  it('starts with the canonical Usage line', () => {
    assert.ok(
      usage().startsWith('Usage: ftown <env|sessions|harness> [args...]'),
    );
  });
});


describe('CLI entry recognition', () => {
  it('recognizes physical, parent-symlink and npm-bin paths without running on import', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pathToFileURL } = await import('node:url');
    const { isCliEntry } = await import('./ftown-cli.js');
    const temporary = mkdtempSync(join(tmpdir(), 'ftown-entry-'));
    try {
      const dist = join(temporary, 'node_modules', 'ftown-bridge', 'dist');
      const bin = join(temporary, 'node_modules', '.bin');
      mkdirSync(dist, { recursive: true }); mkdirSync(bin);
      const target = join(dist, 'ftown-cli.js'); writeFileSync(target, 'export {};');
      const npmBin = join(bin, 'ftown'); symlinkSync('../ftown-bridge/dist/ftown-cli.js', npmBin);
      const parentLink = join(temporary, 'linked-dist'); symlinkSync(dist, parentLink);
      const moduleUrl = pathToFileURL(realpathSync(target)).href;
      assert.equal(isCliEntry(moduleUrl, target), true);
      assert.equal(isCliEntry(moduleUrl, npmBin), true);
      assert.equal(isCliEntry(moduleUrl, join(parentLink, 'ftown-cli.js')), true);
      assert.equal(isCliEntry('file:///different-module.js', npmBin), false);
      assert.equal(isCliEntry(moduleUrl, undefined), false);
      assert.equal(isCliEntry(moduleUrl, join(temporary, 'missing')), false);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });
});
