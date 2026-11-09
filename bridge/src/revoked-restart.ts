import { argvForPairingRestart, beginIdentityReset, reexec, type IdentityResetReason } from './identity-reset.js';

export const REVOKED_RESTART_MESSAGE = 'This computer was removed from your ftown account. Creating a new identity; pair it again with the link below.';
export const PAIR_AGAIN_HINT = 'Run `ftown start` to pair this computer again.';

export interface RevokedRestartDeps {
  dataDir: string;
  /** Entry script of this process (process.argv[1]). */
  scriptPath: string;
  /** Original arguments without node and the script (process.argv.slice(2)). */
  argv: readonly string[];
  /** Graceful bridge shutdown that keeps tmux sessions alive and never exits the process. */
  shutdown: () => Promise<void>;
  log: (message: string) => void;
  exit: (code: number) => void;
  /** False while an update owns this process or its reservation; the next `ftown start` then finishes the reset. */
  canReexec?: () => boolean;
  beginIdentityReset?: (dataDir: string, reason: IdentityResetReason) => void;
  argvForPairingRestart?: (argv: readonly string[]) => string[];
  reexec?: (scriptPath: string, argv: string[]) => boolean;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Restarts the process as a fresh install after signed proof of revocation; every call shares one run. */
export function createRevokedRestart(deps: RevokedRestartDeps): () => Promise<void> {
  const begin = deps.beginIdentityReset ?? beginIdentityReset;
  const restartArgv = deps.argvForPairingRestart ?? argvForPairingRestart;
  const replaceProcess = deps.reexec ?? reexec;
  const canReexec = deps.canReexec ?? (() => true);
  let run: Promise<void> | undefined;

  const shutdownQuietly = async (): Promise<void> => {
    try { await deps.shutdown(); }
    catch (err) { deps.log(`[Bridge] Shutdown before the identity reset failed: ${describeError(err)}`); }
  };

  const restart = async (): Promise<void> => {
    deps.log(REVOKED_RESTART_MESSAGE);
    try { begin(deps.dataDir, 'revoked'); }
    catch (err) {
      // Without the marker a re-executed process would come back as the revoked identity and loop.
      deps.log(`[Bridge] Could not start the identity reset: ${describeError(err)}`);
      await shutdownQuietly();
      deps.exit(1);
      return;
    }
    await shutdownQuietly();
    if (!canReexec()) {
      deps.log('[Bridge] An update is in progress, so this process will not restart itself.');
      deps.log(PAIR_AGAIN_HINT);
      deps.exit(1);
      return;
    }
    let replaced = false;
    try { replaced = replaceProcess(deps.scriptPath, restartArgv(deps.argv)); }
    catch (err) { deps.log(`[Bridge] Restart failed: ${describeError(err)}`); }
    if (replaced) return;
    deps.log(PAIR_AGAIN_HINT);
    deps.exit(0);
  };

  return () => (run ??= restart());
}
