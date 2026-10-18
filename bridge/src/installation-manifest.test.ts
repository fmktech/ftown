import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_LAUNCHERS, CLI_RUNTIME_MODULES, REQUIRED_RUNTIME_FILES, REQUIRED_SETUP_ASSETS, RUNTIME_DIRECTORIES, parseRuntimeInventory } from './installation-manifest.js';

test('shared readiness inventory covers canonical startup, notifications and compatibility launchers', () => {
  for (const module of ['start-commands', 'index', 'attention-store', 'push-notifier', 'native-mail']) assert.ok((CLI_RUNTIME_MODULES as readonly string[]).includes(module));
  for (const { path } of CLI_LAUNCHERS) assert.ok(REQUIRED_SETUP_ASSETS.includes(path));
});
test('Claude Mod is copied with the runtime and required at its stable launch path', () => {
  assert.ok((RUNTIME_DIRECTORIES as readonly string[]).includes('claude-mod'));
  assert.ok((CLI_RUNTIME_MODULES as readonly string[]).includes('claude-mod-installer'));
  for (const relative of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.js']) {
    assert.ok(REQUIRED_SETUP_ASSETS.includes(`claude-plugin/${relative}`));
    assert.ok(REQUIRED_SETUP_ASSETS.includes(`cli/claude-mod/${relative}`));
  }
});
test('runtime inventory rejects incomplete core inventory and paths outside the installation', () => {
  const valid = { schema: 1, packageVersion: '1.2.3', files: [...REQUIRED_RUNTIME_FILES, 'node_modules/native/build/addon.node'] };
  assert.deepEqual(parseRuntimeInventory(valid), valid);
  for (const value of [null, { ...valid, files: [] }, { ...valid, files: [...valid.files, '../outside'] },
    { ...valid, files: [...valid.files, '/absolute'] }, { ...valid, files: [...valid.files, 'node_modules\\outside'] },
    { ...valid, files: [...valid.files, valid.files[0]] }]) assert.throws(() => parseRuntimeInventory(value), /Invalid installed runtime inventory/);
});
