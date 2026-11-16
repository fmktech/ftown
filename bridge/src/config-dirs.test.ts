import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { claudeConfigDir, codexHome, opencodeConfigDir, xdgCacheHome, xdgConfigHome, xdgDataHome } from './config-dirs.js';

const HOME = '/fake/home';

describe('xdgConfigHome', () => {
  it('defaults to $HOME/.config when XDG_CONFIG_HOME is unset', () => {
    assert.equal(xdgConfigHome(HOME, {}), join(HOME, '.config'));
  });

  it('honours a set XDG_CONFIG_HOME', () => {
    assert.equal(xdgConfigHome(HOME, { XDG_CONFIG_HOME: '/custom/config' }), '/custom/config');
  });

  it('ignores a blank XDG_CONFIG_HOME', () => {
    assert.equal(xdgConfigHome(HOME, { XDG_CONFIG_HOME: '   ' }), join(HOME, '.config'));
  });
});

describe('xdgCacheHome', () => {
  it('defaults to $HOME/.cache when XDG_CACHE_HOME is unset', () => {
    assert.equal(xdgCacheHome(HOME, {}), join(HOME, '.cache'));
  });

  it('honours a set XDG_CACHE_HOME', () => {
    assert.equal(xdgCacheHome(HOME, { XDG_CACHE_HOME: '/custom/cache' }), '/custom/cache');
  });

  it('ignores a blank XDG_CACHE_HOME', () => {
    assert.equal(xdgCacheHome(HOME, { XDG_CACHE_HOME: '' }), join(HOME, '.cache'));
  });
});

describe('opencodeConfigDir', () => {
  it('defaults to $HOME/.config/opencode when no override is set', () => {
    assert.equal(opencodeConfigDir(HOME, {}), join(HOME, '.config', 'opencode'));
  });

  it('uses $XDG_CONFIG_HOME/opencode when XDG_CONFIG_HOME is set', () => {
    assert.equal(
      opencodeConfigDir(HOME, { XDG_CONFIG_HOME: '/custom/config' }),
      join('/custom/config', 'opencode'),
    );
  });

  it('lets OPENCODE_CONFIG_DIR replace the whole config directory', () => {
    assert.equal(
      opencodeConfigDir(HOME, { XDG_CONFIG_HOME: '/custom/config', OPENCODE_CONFIG_DIR: '/opencode/config' }),
      '/opencode/config',
    );
  });

  it('ignores a blank OPENCODE_CONFIG_DIR', () => {
    assert.equal(
      opencodeConfigDir(HOME, { OPENCODE_CONFIG_DIR: '  ' }),
      join(HOME, '.config', 'opencode'),
    );
  });
});

describe('other harness directories', () => {
  it('uses XDG_DATA_HOME or its default', () => {
    assert.equal(xdgDataHome(HOME, {}), join(HOME, '.local', 'share'));
    assert.equal(xdgDataHome(HOME, { XDG_DATA_HOME: '/custom/data' }), '/custom/data');
    assert.equal(xdgDataHome(HOME, { XDG_DATA_HOME: '  ' }), join(HOME, '.local', 'share'));
  });
  it('uses Claude absolute config paths and preserves its invalid-override fallback', () => {
    assert.equal(claudeConfigDir(HOME, {}), join(HOME, '.claude'));
    assert.equal(claudeConfigDir(HOME, { CLAUDE_CONFIG_DIR: '/custom/claude' }), '/custom/claude');
    assert.equal(claudeConfigDir(HOME, { CLAUDE_CONFIG_DIR: 'relative' }), join(HOME, '.claude'));
    assert.equal(claudeConfigDir(HOME, { CLAUDE_CONFIG_DIR: ' ' }), join(HOME, '.claude'));
  });
  it('uses CODEX_HOME or its default', () => {
    assert.equal(codexHome(HOME, {}), join(HOME, '.codex'));
    assert.equal(codexHome(HOME, { CODEX_HOME: '/custom/codex' }), '/custom/codex');
    assert.equal(codexHome(HOME, { CODEX_HOME: '' }), join(HOME, '.codex'));
  });
});

it('preserves nonblank XDG and Codex paths, including relative and trailing spaces', () => {
  assert.equal(xdgConfigHome(HOME, { XDG_CONFIG_HOME: 'relative/config ' }), 'relative/config ');
  assert.equal(xdgDataHome(HOME, { XDG_DATA_HOME: '/data ' }), '/data ');
  assert.equal(xdgCacheHome(HOME, { XDG_CACHE_HOME: '/cache ' }), '/cache ');
  assert.equal(codexHome(HOME, { CODEX_HOME: '/codex ' }), '/codex ');
  assert.equal(opencodeConfigDir(HOME, { OPENCODE_CONFIG_DIR: ' /custom/opencode  ' }), '/custom/opencode');
});
