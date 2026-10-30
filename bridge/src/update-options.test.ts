import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Command } from 'commander';
import { configureUpdateOptions } from './update-options.js';

test('updates default enabled and the last explicit option wins', () => {
  for (const [args, expected] of [
    [[], true], [['--allow-updates'], true], [['--no-allow-updates'], false],
    [['--allow-updates', '--no-allow-updates'], false], [['--no-allow-updates', '--allow-updates'], true],
  ] as const) {
    const program = configureUpdateOptions(new Command());
    program.parse([...args], { from: 'user' });
    assert.equal(program.opts().allowUpdates, expected, args.join(' '));
  }
});
