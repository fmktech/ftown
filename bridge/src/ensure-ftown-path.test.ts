import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFishManagedBlock,
  buildManagedBlock,
  ensureFtownOnPath,
  upsertManagedBlock,
} from './ensure-ftown-path.js';

const BEGIN = '# >>> ftown (managed by ftown-bridge) >>>';
const END = '# <<< ftown (managed by ftown-bridge) <<<';

describe('buildManagedBlock', () => {
  it('contains the BEGIN/END markers and the export PATH line in order', () => {
    assert.equal(
      buildManagedBlock(),
      [BEGIN, 'export PATH="$HOME/.ftown:$PATH"', END].join('\n'),
    );
  });
});

describe('buildFishManagedBlock', () => {
  it('uses fish `set -gx` syntax under the same markers', () => {
    assert.equal(
      buildFishManagedBlock(),
      [BEGIN, 'set -gx PATH "$HOME/.ftown" $PATH', END].join('\n'),
    );
  });

  it('does not use POSIX `export` (invalid in fish)', () => {
    assert.ok(!buildFishManagedBlock().includes('export '));
  });
});

describe('upsertManagedBlock', () => {
  it('appends the block when absent (changed=true), creating from empty', () => {
    const block = buildManagedBlock();
    const { content, changed } = upsertManagedBlock('', block);
    assert.equal(changed, true);
    assert.equal(content, block + '\n');
  });

  it('appends with exactly one blank line of separation from existing content', () => {
    const block = buildManagedBlock();
    const { content, changed } = upsertManagedBlock('export FOO=bar\n', block);
    assert.equal(changed, true);
    assert.equal(content, 'export FOO=bar\n\n' + block + '\n');
  });

  it('normalises trailing newlines to a single blank-line separator', () => {
    const block = buildManagedBlock();
    const { content } = upsertManagedBlock('export FOO=bar\n\n\n', block);
    assert.equal(content, 'export FOO=bar\n\n' + block + '\n');
  });

  it('is a NO-OP (changed=false) when the identical block is already present', () => {
    const block = buildManagedBlock();
    const existing = 'foo\n\n' + block + '\n';
    const { content, changed } = upsertManagedBlock(existing, block);
    assert.equal(changed, false);
    assert.equal(content, existing);
  });

  it('replaces the managed region when markers exist but inner content differs', () => {
    const block = buildManagedBlock();
    const stale = [BEGIN, 'export PATH="$HOME/.old:$PATH"', END].join('\n');
    const existing = 'line before\n' + stale + '\nline after\n';
    const { content, changed } = upsertManagedBlock(existing, block);
    assert.equal(changed, true);
    assert.equal(content, 'line before\n' + block + '\nline after\n');
    assert.ok(!content.includes('.old'), 'stale PATH must be gone');
    assert.ok(content.includes('line before\n'), 'preceding line preserved');
    assert.ok(content.includes('\nline after\n'), 'trailing line preserved');
  });

  it('upserts the fish block without duplicating it', () => {
    const block = buildFishManagedBlock();
    const first = upsertManagedBlock('# fish config\n', block);
    assert.equal(first.changed, true);
    const second = upsertManagedBlock(first.content, block);
    assert.equal(second.changed, false);
    assert.equal(second.content, first.content);
    assert.equal(second.content.split(BEGIN).length - 1, 1, 'exactly one managed block');
  });
});

describe('ensureFtownOnPath', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ftw-path-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('creates ~/.zshenv with the managed block', () => {
    const result = ensureFtownOnPath({ home, env: {} });
    assert.equal(result.skipped, false);
    assert.ok(result.updated.includes(join(home, '.zshenv')));
    assert.ok(readFileSync(join(home, '.zshenv'), 'utf8').includes(buildManagedBlock()));
  });

  it('is idempotent — a second call writes nothing', () => {
    ensureFtownOnPath({ home, env: {} });
    const second = ensureFtownOnPath({ home, env: {} });
    assert.equal(second.skipped, false);
    assert.deepEqual(second.updated, []);
  });

  it('never duplicates the managed block across repeated calls', () => {
    ensureFtownOnPath({ home, env: {} });
    ensureFtownOnPath({ home, env: {} });
    ensureFtownOnPath({ home, env: {} });
    for (const file of [
      join(home, '.zshenv'),
      join(home, '.profile'),
      join(home, '.config', 'fish', 'conf.d', 'ftown.fish'),
    ]) {
      const content = readFileSync(file, 'utf8');
      assert.equal(content.split(BEGIN).length - 1, 1, `${file}: one BEGIN marker`);
      assert.equal(content.split(END).length - 1, 1, `${file}: one END marker`);
    }
  });

  it('respects FTOWN_SKIP_PATH_SETUP via opts.env (skips and writes nothing)', () => {
    const result = ensureFtownOnPath({ home, env: { FTOWN_SKIP_PATH_SETUP: '1' } });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.updated, []);
    assert.equal(existsSync(join(home, '.zshenv')), false);
  });

  it('treats FTOWN_SKIP_PATH_SETUP=0/false/no/off as NOT set (does not skip)', () => {
    for (const value of ['0', 'false', 'no', 'off', 'FALSE', ' off ']) {
      const dir = mkdtempSync(join(tmpdir(), 'ftw-path-flag-'));
      try {
        const result = ensureFtownOnPath({ home: dir, env: { FTOWN_SKIP_PATH_SETUP: value } });
        assert.equal(result.skipped, false, `value ${JSON.stringify(value)} must not skip`);
        assert.ok(existsSync(join(dir, '.zshenv')));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('does not create ~/.bashrc when it is absent', () => {
    const result = ensureFtownOnPath({ home, env: {} });
    assert.equal(existsSync(join(home, '.bashrc')), false);
    assert.ok(!result.updated.includes(join(home, '.bashrc')));
  });

  it('updates ~/.bashrc only when it pre-exists, preserving its content', () => {
    const bashrc = join(home, '.bashrc');
    writeFileSync(bashrc, '# my bashrc\n');
    const result = ensureFtownOnPath({ home, env: {} });
    assert.ok(result.updated.includes(bashrc));
    const after = readFileSync(bashrc, 'utf8');
    assert.ok(after.includes('# my bashrc'));
    assert.ok(after.includes(buildManagedBlock()));
    assert.equal(existsSync(join(home, '.profile')), false, 'no login file needed with .bashrc');
  });

  it('writes ~/.profile when there is no ~/.bashrc', () => {
    const result = ensureFtownOnPath({ home, env: {} });
    const profile = join(home, '.profile');
    assert.ok(result.updated.includes(profile));
    assert.ok(readFileSync(profile, 'utf8').includes(buildManagedBlock()));
    assert.equal(existsSync(join(home, '.bashrc')), false);
  });

  it('preserves existing ~/.profile content and is idempotent', () => {
    const profile = join(home, '.profile');
    writeFileSync(profile, '# my login profile\n');
    ensureFtownOnPath({ home, env: {} });
    const after = readFileSync(profile, 'utf8');
    assert.ok(after.includes('# my login profile'));
    assert.ok(after.includes(buildManagedBlock()));
    const second = ensureFtownOnPath({ home, env: {} });
    assert.ok(!second.updated.includes(profile));
    assert.equal(readFileSync(profile, 'utf8'), after);
  });

  it('prefers ~/.bash_profile over ~/.profile for bash login shells', () => {
    const bashProfile = join(home, '.bash_profile');
    writeFileSync(bashProfile, '# my bash profile\n');
    const result = ensureFtownOnPath({ home, env: {} });
    assert.ok(result.updated.includes(bashProfile));
    assert.ok(readFileSync(bashProfile, 'utf8').includes(buildManagedBlock()));
    assert.equal(existsSync(join(home, '.profile')), false, 'must not create ignored .profile');
  });

  it('creates fish conf.d/ftown.fish with fish syntax, making parent dirs', () => {
    const fishConf = join(home, '.config', 'fish', 'conf.d', 'ftown.fish');
    assert.equal(existsSync(fishConf), false);
    const result = ensureFtownOnPath({ home, env: {} });
    assert.ok(result.updated.includes(fishConf));
    const after = readFileSync(fishConf, 'utf8');
    assert.ok(after.includes(buildFishManagedBlock()));
    assert.ok(!after.includes('export PATH'), 'fish config must not use export');
    const second = ensureFtownOnPath({ home, env: {} });
    assert.ok(!second.updated.includes(fishConf));
  });

  it('updates an existing fish conf.d file without clobbering other config', () => {
    const fishConf = join(home, '.config', 'fish', 'conf.d', 'ftown.fish');
    mkdirSync(join(home, '.config', 'fish', 'conf.d'), { recursive: true });
    writeFileSync(fishConf, 'set -gx EDITOR vim\n');
    const result = ensureFtownOnPath({ home, env: {} });
    assert.ok(result.updated.includes(fishConf));
    const after = readFileSync(fishConf, 'utf8');
    assert.ok(after.includes('set -gx EDITOR vim'));
    assert.ok(after.includes(buildFishManagedBlock()));
    assert.equal(after.split(BEGIN).length - 1, 1, 'exactly one fish managed block');
  });
});
