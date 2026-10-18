import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runStart, type StartDependencies } from './start-commands.js';

test('start checks readiness before loading native bridge code and forwards options unchanged', async () => {
  const calls: string[] = [];
  const argv = ['--solo', '--port', '8041', '--data-dir', '/tmp/bridge data'];
  const dependencies: StartDependencies = {
    assertReady: () => { calls.push('ready'); },
    loadBridge: async () => {
      calls.push('load');
      return { runBridge: async (actual, commandName) => {
        calls.push('run');
        assert.deepEqual(actual, argv);
        assert.equal(commandName, 'ftown start');
        return 3;
      } };
    },
  };
  assert.equal(await runStart(argv, dependencies), 3);
  assert.deepEqual(calls, ['ready', 'load', 'run']);
});

test('missing or outdated setup never loads native bridge dependencies', async () => {
  let loaded = false;
  await assert.rejects(runStart(['--solo'], {
    assertReady: () => { throw new Error('Run matching ftown setup'); },
    loadBridge: async () => { loaded = true; throw new Error('should not load'); },
  }), /Run matching ftown setup/);
  assert.equal(loaded, false);
});

test('standalone help is discoverable without setup, while option values cannot bypass readiness', async () => {
  let checks = 0;
  const argvSeen: string[][] = [];
  const dependencies: StartDependencies = {
    assertReady: () => { checks++; },
    loadBridge: async () => ({ runBridge: async (argv) => { argvSeen.push(argv); return 0; } }),
  };
  for (const flag of ['--help', '-h']) assert.equal(await runStart([flag], dependencies), 0);
  assert.equal(checks, 0);
  assert.equal(await runStart(['--data-dir', '--help'], dependencies), 0);
  assert.equal(checks, 1);
  assert.equal(await runStart([], dependencies), 0);
  assert.equal(checks, 2);
  assert.deepEqual(argvSeen, [['--help'], ['-h'], ['--data-dir', '--help'], []]);
});
