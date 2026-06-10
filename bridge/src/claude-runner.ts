import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';

import type { IPty } from 'node-pty';

import {
  TMUX_SOCKET_NAME,
  createTmuxSession,
  hasTmuxSession,
  isTmuxAvailable,
  killTmuxSession,
  readAndClearExitCode,
  tmuxSessionName,
} from './tmux.js';
import { applyTerminalColorEnv } from './xterm-theme.js';

import type { SessionRuntime } from './types.js';

export interface ProcessRunnerEvents {
  data: [string, string];
  complete: [string];
  error: [string, Error];
}

interface RunOptions {
  workingDir?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  initialInput?: string;
  initialInputDelay?: number;
  submitSuffix?: string;
  hookPort?: number;
  hookToken?: string;
  parentSessionId?: string;
}

export interface ReattachOptions {
  workingDir?: string;
  cols?: number;
  rows?: number;
  parentSessionId?: string;
}

interface TmuxAttachParams {
  env: Record<string, string>;
  cwd: string;
  cols: number;
  rows: number;
  initialInput?: string;
  initialInputDelay?: number;
  submitSuffix?: string;
}

export class ProcessRunner extends EventEmitter<ProcessRunnerEvents> {
  private readonly activeProcesses: Map<string, IPty> = new Map();
  private readonly runtimes: Map<string, SessionRuntime> = new Map();
  /** Sessions being killed via stop(); suppresses tmux reattach and exit-event
   * emission — callers of stop() persist the final status themselves, and a
   * late 'complete'/'error' save can resurrect a record removal just deleted. */
  private readonly stopping: Set<string> = new Set();
  /** Sessions detaching on shutdown; the tmux session stays alive, emit nothing. */
  private readonly detachOnly: Set<string> = new Set();
  /** Last client-requested size, so tmux reattach does not snap back to creation-time size. */
  private readonly lastSizes: Map<string, { cols: number; rows: number }> = new Map();

  getPreferredRuntime(): SessionRuntime {
    return isTmuxAvailable() ? 'tmux' : 'direct';
  }

  getRuntime(sessionId: string): SessionRuntime | undefined {
    return this.runtimes.get(sessionId);
  }

  run(sessionId: string, command: string, options: RunOptions = {}): void {
    const cwd = options.workingDir ?? process.cwd();
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;
    const env = this.buildEnv(sessionId, options);

    console.log(`[ProcessRunner] Spawning command in ${cwd} (${this.getPreferredRuntime()}): ${command}`);

    if (this.getPreferredRuntime() === 'tmux') {
      // Registered before the async tmux creation so a stop() arriving in the
      // creation window is recorded (via this.stopping) instead of lost.
      this.runtimes.set(sessionId, 'tmux');
      void this.runTmux(sessionId, command, env, {
        cwd,
        cols,
        rows,
        initialInput: options.initialInput,
        initialInputDelay: options.initialInputDelay,
        submitSuffix: options.submitSuffix,
      });
      return;
    }

    this.runDirect(sessionId, command, env, cwd, cols, rows, options);
  }

  /** Attach to an existing tmux session without creating it (session resurrection). */
  reattach(sessionId: string, options: ReattachOptions = {}): boolean {
    if (this.activeProcesses.has(sessionId)) {
      return true;
    }
    if (!isTmuxAvailable() || !hasTmuxSession(sessionId)) {
      return false;
    }

    const env = this.buildEnv(sessionId, { parentSessionId: options.parentSessionId });
    this.attachTmux(sessionId, {
      env,
      cwd: options.workingDir ?? process.cwd(),
      cols: options.cols ?? 120,
      rows: options.rows ?? 40,
    });
    return true;
  }

  hasTmuxSession(sessionId: string): boolean {
    return isTmuxAvailable() && hasTmuxSession(sessionId);
  }

  write(sessionId: string, data: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }
    proc.write(data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
    }
    proc.resize(cols, rows);
    this.lastSizes.set(sessionId, { cols, rows });
    return true;
  }

  stop(sessionId: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    const isTmux = this.runtimes.get(sessionId) === 'tmux';

    if (isTmux) {
      this.stopping.add(sessionId);
      this.killTmuxSessionLogged(sessionId);
    }

    if (!proc) {
      // Orphaned tmux session with no attached client (e.g. failed reattach).
      if (!isTmux && isTmuxAvailable() && hasTmuxSession(sessionId)) {
        this.killTmuxSessionLogged(sessionId);
        return true;
      }
      return isTmux;
    }

    // Direct runtime: mark stopping so the PTY onExit emits nothing — like the
    // tmux path, the caller owns the final status, and emitting here races
    // remove_session's delete with a status save that recreates the record.
    if (!isTmux) {
      this.stopping.add(sessionId);
    }

    proc.kill();

    setTimeout(() => {
      if (this.activeProcesses.has(sessionId)) {
        proc.kill('SIGKILL');
        this.activeProcesses.delete(sessionId);
      }
    }, 5000);

    return true;
  }

  stopAll(): void {
    for (const [sessionId, proc] of this.activeProcesses) {
      if (this.runtimes.get(sessionId) === 'tmux') {
        // Detach only — the tmux session keeps running and survives bridge restarts.
        this.detachOnly.add(sessionId);
        proc.kill();
      } else {
        this.stop(sessionId);
      }
    }
  }

  isRunning(sessionId: string): boolean {
    return this.activeProcesses.has(sessionId);
  }

  private killTmuxSessionLogged(sessionId: string): void {
    void killTmuxSession(sessionId).then((killed) => {
      if (!killed && hasTmuxSession(sessionId)) {
        console.error(`[ProcessRunner] Failed to kill tmux session for ${sessionId}`);
      }
    });
  }

  private buildEnv(sessionId: string, options: RunOptions): Record<string, string> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
    };
    // Cursor IDE sets NO_COLOR=1 on the bridge process; do not pass that to PTY agents.
    delete env.NO_COLOR;
    delete env.FORCE_COLOR;

    if (options.hookPort) {
      env.FTOWN_HOOK_PORT = String(options.hookPort);
      env.FTOWN_SESSION_ID = sessionId;
    }

    if (options.hookToken) {
      env.FTOWN_HOOK_TOKEN = options.hookToken;
    }

    if (options.parentSessionId) {
      env.FTOWN_PARENT_SESSION_ID = options.parentSessionId;
    }

    if (options.env) {
      Object.assign(env, options.env);
    }

    applyTerminalColorEnv(env);
    return env;
  }

  private async runTmux(
    sessionId: string,
    command: string,
    env: Record<string, string>,
    params: Omit<TmuxAttachParams, 'env'>,
  ): Promise<void> {
    try {
      await createTmuxSession({
        sessionId,
        command,
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
        env,
      });
    } catch (err) {
      const wasStopping = this.stopping.delete(sessionId);
      this.runtimes.delete(sessionId);
      console.error(`[ProcessRunner] Failed to create tmux session:`, err);
      if (!wasStopping) {
        this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    // stop() may have arrived while the session was being created; honor it
    // instead of attaching. stop_session already persisted the final status.
    if (this.stopping.delete(sessionId)) {
      this.runtimes.delete(sessionId);
      this.killTmuxSessionLogged(sessionId);
      return;
    }

    this.attachTmux(sessionId, { ...params, env });
  }

  private attachTmux(sessionId: string, params: TmuxAttachParams): void {
    // params holds creation-time cols/rows; prefer the latest client size.
    const size = this.lastSizes.get(sessionId);
    if (size) {
      params = { ...params, cols: size.cols, rows: size.rows };
    }

    let proc: IPty;
    try {
      proc = pty.spawn(
        'tmux',
        ['-L', TMUX_SOCKET_NAME, 'attach-session', '-t', `=${tmuxSessionName(sessionId)}`],
        {
          name: 'xterm-256color',
          cols: params.cols,
          rows: params.rows,
          cwd: params.cwd,
          env: params.env,
        },
      );
      console.log(`[ProcessRunner] Attached to tmux session ${tmuxSessionName(sessionId)}, client pid: ${proc.pid}`);
    } catch (err) {
      console.error(`[ProcessRunner] Failed to attach to tmux session:`, err);
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.activeProcesses.set(sessionId, proc);
    this.runtimes.set(sessionId, 'tmux');

    proc.onData((data: string) => {
      this.emit('data', sessionId, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      console.log(`[ProcessRunner] tmux attach client exited, code: ${exitCode}, signal: ${signal}`);
      this.activeProcesses.delete(sessionId);
      this.runtimes.delete(sessionId);

      if (this.detachOnly.delete(sessionId)) {
        return;
      }

      if (this.stopping.delete(sessionId)) {
        // stop() initiated this exit; stop_session persists the final status,
        // so emit nothing (kill-session makes the trap record a bogus code).
        readAndClearExitCode(sessionId);
        this.lastSizes.delete(sessionId);
        return;
      }

      if (hasTmuxSession(sessionId)) {
        // Client detached but the command is still running — reattach to keep streaming.
        this.attachTmux(sessionId, { ...params, initialInput: undefined });
        return;
      }

      this.lastSizes.delete(sessionId);

      // The attach client's exit code is unrelated to the command's; the real
      // code is written to a temp file by the command wrapper inside tmux.
      const realCode = readAndClearExitCode(sessionId);
      if (realCode === undefined) {
        // No trap file: the session was destroyed without the wrapper's EXIT
        // trap running (SIGKILL, OOM, tmux server killed).
        this.emit('error', sessionId, new Error('tmux session ended without recording an exit code'));
      } else if (realCode === 0) {
        this.emit('complete', sessionId);
      } else {
        this.emit('error', sessionId, new Error(`Process exited with code ${realCode}`));
      }
    });

    this.scheduleInitialInput(sessionId, proc, params.initialInput, params.initialInputDelay, params.submitSuffix);
  }

  private runDirect(
    sessionId: string,
    command: string,
    env: Record<string, string>,
    cwd: string,
    cols: number,
    rows: number,
    options: RunOptions,
  ): void {
    let proc: IPty;
    try {
      proc = pty.spawn('/bin/zsh', ['-l', '-c', command], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
      console.log(`[ProcessRunner] Process spawned, pid: ${proc.pid}`);
    } catch (err) {
      console.error(`[ProcessRunner] Failed to spawn process:`, err);
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.activeProcesses.set(sessionId, proc);
    this.runtimes.set(sessionId, 'direct');

    proc.onData((data: string) => {
      this.emit('data', sessionId, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      console.log(`[ProcessRunner] Process exited, code: ${exitCode}, signal: ${signal}`);
      this.activeProcesses.delete(sessionId);
      this.runtimes.delete(sessionId);
      this.lastSizes.delete(sessionId);
      if (this.stopping.delete(sessionId)) {
        // stop() initiated this exit; the caller persists the final status.
        return;
      }
      if (exitCode === 0 || exitCode === null || exitCode === undefined) {
        this.emit('complete', sessionId);
      } else {
        this.emit('error', sessionId, new Error(`Process exited with code ${exitCode}`));
      }
    });

    this.scheduleInitialInput(sessionId, proc, options.initialInput, options.initialInputDelay, options.submitSuffix);
  }

  private scheduleInitialInput(
    sessionId: string,
    proc: IPty,
    initialInput: string | undefined,
    initialInputDelay: number | undefined,
    submitSuffix: string | undefined,
  ): void {
    if (!initialInput) {
      return;
    }
    const delay = initialInputDelay ?? 2000;
    setTimeout(() => {
      if (this.activeProcesses.get(sessionId) === proc) {
        console.log(`[ProcessRunner] Sending initial input to session ${sessionId}`);
        proc.write(initialInput);
        // Submit separately after the paste settles: composer TUIs (Claude/Cursor) treat a
        // trailing CR inside a bracketed paste of multi-line text as a newline, not a submit.
        setTimeout(() => {
          if (this.activeProcesses.get(sessionId) === proc) {
            proc.write(submitSuffix ?? '\r');
          }
        }, 600);
      }
    }, delay);
  }
}
