import type { ProcessRunner } from './claude-runner.js';
import type { SessionStore } from './session-store.js';
import type { TerminalManager } from './terminal-manager.js';
import { TerminalPump, type TerminalPumpDeps } from './terminal-pump.js';

/** Scrollback lines replayed to a viewer that attaches or asks for a resync. */
const ATTACH_SCROLLBACK_LINES = 20000;
/**
 * Cap for a published screen dump. Accounts for ~50% JSON-encoding inflation on
 * ANSI-heavy buffers (each \x1b expands 1 -> 6 bytes), keeping the on-wire
 * Centrifugo frame under websocket_message_size_limit.
 */
const MAX_SCREEN_DUMP_BYTES = 2_500_000;
/**
 * RIS (full reset), sent in-band at the head of every screen. A viewer resets
 * its terminal when a screen arrives, but that reset is synchronous while its
 * terminal parses writes asynchronously: output received just before the screen
 * is still queued and would be painted AFTER the reset, under the screen's
 * content (wrong cursor, repeated text, later lines overwritten). Carrying the
 * reset inside the data orders it after everything the viewer queued earlier.
 */
const SCREEN_RESET = '\x1bc';

export interface TerminalOutputDeps {
  store: TerminalPumpDeps['store'] & Pick<SessionStore, 'setPendingTerminalFlush'>;
  terminalManager: Pick<TerminalManager, 'write' | 'destroy' | 'serialize' | 'whenParsed'>;
  runner: Pick<ProcessRunner, 'on' | 'stopAll'>;
  /** Fan-out to direct peers and, when remotely watched, Centrifugo. */
  router: {
    hasAttachedPeers(sessionId: string): boolean;
    publishTerminalData(sessionId: string, data: string): void;
    publishTerminalScreen(sessionId: string, screen: string): void;
  };
  watchRegistry: { hasWatchers(sessionId: string): boolean };
  lifecycle: Pick<TerminalPumpDeps, 'publishSessionUpdate' | 'publishHookEvent' | 'unregisterSession' | 'collectUsage'>;
}

export interface TerminalOutput {
  pump: TerminalPump;
  /** Screen for a direct/loopback peer that attaches; `deliver` joins it to the stream. */
  attachScreen(sessionId: string, deliver: (screen: string) => void): void;
  /** Full screen resync for every viewer of the session. */
  publishScreenDump(sessionId: string): void;
  /** Stop the runner's PTY clients and persist all output still in the pump. */
  stop(): Promise<void>;
}

/**
 * Wires the terminal output path: runner -> pump -> store + transports, the
 * watched/unwatched cadence, and every reader that needs output which is still
 * coalescing (screen snapshots, terminal.log readers, shutdown).
 */
export function createTerminalOutput(deps: TerminalOutputDeps): TerminalOutput {
  const { store, terminalManager, runner, router, watchRegistry } = deps;
  const pump = new TerminalPump({
    store,
    terminalManager,
    publishTerminalData: (sessionId, data) => router.publishTerminalData(sessionId, data),
    isWatched: (sessionId) => router.hasAttachedPeers(sessionId) || watchRegistry.hasWatchers(sessionId),
    ...deps.lifecycle,
  });
  pump.attach(runner);
  // terminal.log readers (screen/grep fallbacks, clear) see pending output too.
  store.setPendingTerminalFlush((sessionId) => pump.flush(sessionId));

  return {
    pump,

    attachScreen(sessionId, deliver) {
      pump.snapshot(sessionId, () => deliver(SCREEN_RESET + (terminalManager.serialize(sessionId, ATTACH_SCROLLBACK_LINES) ?? '')));
    },

    publishScreenDump(sessionId) {
      pump.snapshot(sessionId, () => {
        // Phase 1: viewport-only dump (~rows*cols bytes) for instant render.
        const viewportRaw = terminalManager.serialize(sessionId, 0);
        if (viewportRaw) {
          router.publishTerminalScreen(sessionId, SCREEN_RESET + viewportRaw);
        }

        // Phase 2: full dump with scrollback. Client re-renders on top of phase 1.
        let scrollback = ATTACH_SCROLLBACK_LINES;
        let raw = terminalManager.serialize(sessionId, scrollback);
        while (raw && Buffer.byteLength(raw, 'utf8') > MAX_SCREEN_DUMP_BYTES && scrollback > 100) {
          scrollback = Math.floor(scrollback / 2);
          raw = terminalManager.serialize(sessionId, scrollback);
        }
        if (!raw) return;
        if (raw === viewportRaw) return;
        router.publishTerminalScreen(sessionId, SCREEN_RESET + raw);
      });
    },

    async stop() {
      runner.stopAll();
      await pump.drain();
    },
  };
}
