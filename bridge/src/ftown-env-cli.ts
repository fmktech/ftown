#!/usr/bin/env node
// Compatibility entrypoint; canonical dispatch and implementation are shared.
import { runFtown } from './ftown-cli.js';
import { executeCli, isCliEntry } from './cli-entry.js';
export { isCliEntry } from './cli-entry.js';
export * from './env-commands.js';
if (isCliEntry(import.meta.url, process.argv[1])) {
  void executeCli(() => runFtown(['env', ...process.argv.slice(2)]));
}
