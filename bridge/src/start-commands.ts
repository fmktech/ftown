import { homedir } from 'node:os';
import { assertUpdateReservationAllowed } from './update-handoff.js';
import { assertSetupReady } from './setup-state.js';
import { packageVersion } from './setup.js';

interface BridgeEntry {
  runBridge(argv: string[], commandName?: string): Promise<number>;
}

export interface StartDependencies {
  assertReady(): void;
  loadBridge(): Promise<BridgeEntry>;
}

const dependencies: StartDependencies = {
  assertReady: () => { assertUpdateReservationAllowed(homedir()); assertSetupReady(packageVersion()); },
  loadBridge: () => import('./index.js'),
};

/** Reject incomplete installations before loading the bridge's native dependencies. */
export async function runStart(argv: string[], deps = dependencies): Promise<number> {
  const helpOnly = argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h');
  if (!helpOnly) deps.assertReady();
  const bridge = await deps.loadBridge();
  return bridge.runBridge(argv, 'ftown start');
}
