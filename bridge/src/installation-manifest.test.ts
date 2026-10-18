import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLI_LAUNCHERS, CLI_RUNTIME_MODULES, REQUIRED_RUNTIME_FILES, REQUIRED_SETUP_ASSETS, parseRuntimeInventory } from './installation-manifest.js';

test('shared readiness inventory covers canonical startup, notifications and compatibility launchers', () => {
  for (const module of ['start-commands', 'index', 'attention-store', 'push-notifier']) assert.ok((CLI_RUNTIME_MODULES as readonly string[]).includes(module));
  for (const { path } of CLI_LAUNCHERS) assert.ok(REQUIRED_SETUP_ASSETS.includes(path));
});
test('runtime inventory rejects incomplete core inventory and paths outside the installation', () => {
  const valid = { schema: 1, packageVersion: '1.2.3', files: [...REQUIRED_RUNTIME_FILES, 'node_modules/native/build/addon.node'] };
  assert.deepEqual(parseRuntimeInventory(valid), valid);
  for (const value of [null, { ...valid, files: [] }, { ...valid, files: [...valid.files, '../outside'] },
    { ...valid, files: [...valid.files, '/absolute'] }, { ...valid, files: [...valid.files, 'node_modules\\outside'] },
    { ...valid, files: [...valid.files, valid.files[0]] }]) assert.throws(() => parseRuntimeInventory(value), /Invalid installed runtime inventory/);
});
