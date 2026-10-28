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
import { directShellCommand } from './direct-shell.js';

import type { SessionRuntime } from './types.js';

export interface ProcessRunnerEvents {
  ready: [sessionId: string];
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

/** A session ID survives reruns; lifecycle intent belongs to one launch. */
interface ProcessGeneration {
  stopping: boolean;
  detachOnly: boolean;
  /** PTY removed from activeProcesses by its stop timeout but awaiting exit. */
  forcedStopProcess?: IPty;
}

export class ProcessRunner extends EventEmitter<ProcessRunnerEvents> {
  private readonly activeProcesses: Map<string, IPty> = new Map();
  private readonly runtimes: Map<string, SessionRuntime> = new Map();
  /** stop/detach intent must not transfer to a later launch with the same ID. */
  private readonly generations = new Map<string, ProcessGeneration>();
  /** A tmux generation can attach multiple clients; track each PTY's exit. */
  private readonly exitedProcesses = new WeakSet<IPty>();
  /** Last client-requested size, so tmux reattach does not snap back to creation-time size. */
  private readonly lastSizes: Map<string, { cols: number; rows: number }> = new Map();

  constructor(private readonly dependencies: {
    spawn?: typeof pty.spawn;
    createTmuxSession?: typeof createTmuxSession;
  } = {}) {
    super();
  }

  getPreferredRuntime(): SessionRuntime {
    // Native Windows PTYs cannot attach to a Unix tmux server.
    if (process.platform === 'win32') return 'direct';
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
    const generation: ProcessGeneration = { stopping: false, detachOnly: false };
    this.generations.set(sessionId, generation);
    this.activeProcesses.delete(sessionId);
    this.lastSizes.delete(sessionId);

    console.log(`[ProcessRunner] Spawning command in ${cwd} (${this.getPreferredRuntime()}): ${command}`);

    if (this.getPreferredRuntime() === 'tmux') {
      // Register the generation before async creation so stop() can cancel it.
      this.runtimes.set(sessionId, 'tmux');
      void this.runTmux(sessionId, generation, command, env, {
        cwd,
        cols,
        rows,
        initialInput: options.initialInput,
        initialInputDelay: options.initialInputDelay,
        submitSuffix: options.submitSuffix,
      });
      return;
    }

    this.runDirect(sessionId, generation, command, env, cwd, cols, rows, options);
  }

  /** Attach to an existing tmux session without creating it (session resurrection). */
  reattach(sessionId: string, options: ReattachOptions = {}): boolean {
    if (this.activeProcesses.has(sessionId)) {
      return true;
    }
    if (!this.hasTmuxSession(sessionId)) {
      return false;
    }

    const env = this.buildEnv(sessionId, { parentSessionId: options.parentSessionId });
    const generation: ProcessGeneration = { stopping: false, detachOnly: false };
    this.generations.set(sessionId, generation);
    this.attachTmux(sessionId, generation, {
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
    const generation = this.generations.get(sessionId);

    if (isTmux) {
      if (generation) generation.stopping = true;
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
    if (generation) generation.stopping = true;

    proc.kill();

    setTimeout(() => {
      if (generation && !this.exitedProcesses.has(proc)) {
        if (this.generations.get(sessionId) === generation && this.activeProcesses.get(sessionId) === proc) {
          generation.forcedStopProcess = proc;
        }
        proc.kill('SIGKILL');
        if (this.generations.get(sessionId) === generation && this.activeProcesses.get(sessionId) === proc) {
          this.activeProcesses.delete(sessionId);
        }
      }
    }, 5000);

    return true;
  }

  stopAll(): void {
    for (const [sessionId, proc] of this.activeProcesses) {
      if (this.runtimes.get(sessionId) === 'tmux') {
        // Detach only — the tmux session keeps running and survives bridge restarts.
        const generation = this.generations.get(sessionId);
        if (generation) generation.detachOnly = true;
        proc.kill();
      } else {
        this.stop(sessionId);
      }
    }
  }

  /** Includes pending creation and stopping generations, not just attached PTYs. */
  hasLiveGenerations(): boolean {
    return this.generations.size > 0 || this.activeProcesses.size > 0;
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
    generation: ProcessGeneration,
    command: string,
    env: Record<string, string>,
    params: Omit<TmuxAttachParams, 'env'>,
  ): Promise<void> {
    try {
      await (this.dependencies.createTmuxSession ?? createTmuxSession)({
        sessionId,
        command,
        cwd: params.cwd,
        cols: params.cols,
        rows: params.rows,
        env,
      });
    } catch (err) {
      if (this.generations.get(sessionId) !== generation) return;
      const wasStopping = generation.stopping;
      this.generations.delete(sessionId);
      this.runtimes.delete(sessionId);
      console.error(`[ProcessRunner] Failed to create tmux session:`, err);
      if (!wasStopping) {
        this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
      }
      return;
    }

    // stop() may have arrived while the session was being created; honor it
    // instead of attaching. stop_session already persisted the final status.
    if (this.generations.get(sessionId) !== generation) return;
    if (generation.stopping) {
      this.generations.delete(sessionId);
      this.runtimes.delete(sessionId);
      this.killTmuxSessionLogged(sessionId);
      return;
    }

    this.attachTmux(sessionId, generation, { ...params, env });
  }

  private attachTmux(sessionId: string, generation: ProcessGeneration, params: TmuxAttachParams): void {
    if (this.generations.get(sessionId) !== generation) return;
    // params holds creation-time cols/rows; prefer the latest client size.
    const size = this.lastSizes.get(sessionId);
    if (size) {
      params = { ...params, cols: size.cols, rows: size.rows };
    }

    let proc: IPty;
    try {
      proc = (this.dependencies.spawn ?? pty.spawn)(
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
      if (this.generations.get(sessionId) !== generation) return;
      this.generations.delete(sessionId);
      this.runtimes.delete(sessionId);
      console.error(`[ProcessRunner] Failed to attach to tmux session:`, err);
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.activeProcesses.set(sessionId, proc);
    this.runtimes.set(sessionId, 'tmux');

    proc.onData((data: string) => {
      if (this.generations.get(sessionId) === generation && this.activeProcesses.get(sessionId) === proc) this.emit('data', sessionId, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      this.exitedProcesses.add(proc);
      if (this.generations.get(sessionId) !== generation ||
        (this.activeProcesses.get(sessionId) !== proc &&
          !(generation.stopping && generation.forcedStopProcess === proc && !this.activeProcesses.has(sessionId)))) return;
      console.log(`[ProcessRunner] tmux attach client exited, code: ${exitCode}, signal: ${signal}`);
      this.activeProcesses.delete(sessionId);
      this.runtimes.delete(sessionId);

      if (generation.detachOnly) {
        this.generations.delete(sessionId);
        return;
      }

      if (generation.stopping) {
        this.generations.delete(sessionId);
        // stop() initiated this exit; stop_session persists the final status,
        // so emit nothing (kill-session makes the trap record a bogus code).
        readAndClearExitCode(sessionId);
        this.lastSizes.delete(sessionId);
        return;
      }

      if (hasTmuxSession(sessionId)) {
        // Client detached but the command is still running — reattach to keep streaming.
        this.attachTmux(sessionId, generation, { ...params, initialInput: undefined });
        return;
      }

      this.lastSizes.delete(sessionId);
      this.generations.delete(sessionId);

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

    this.emit('ready', sessionId);
    this.scheduleInitialInput(sessionId, proc, params.initialInput, params.initialInputDelay, params.submitSuffix);
  }

  private runDirect(
    sessionId: string,
    generation: ProcessGeneration,
    command: string,
    env: Record<string, string>,
    cwd: string,
    cols: number,
    rows: number,
    options: RunOptions,
  ): void {
    let proc: IPty;
    try {
      const shell = directShellCommand(command);
      proc = (this.dependencies.spawn ?? pty.spawn)(shell.file, shell.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
      });
      console.log(`[ProcessRunner] Process spawned, pid: ${proc.pid}`);
    } catch (err) {
      if (this.generations.get(sessionId) !== generation) return;
      this.generations.delete(sessionId);
      this.runtimes.delete(sessionId);
      console.error(`[ProcessRunner] Failed to spawn process:`, err);
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.activeProcesses.set(sessionId, proc);
    this.runtimes.set(sessionId, 'direct');

    proc.onData((data: string) => {
      if (this.generations.get(sessionId) === generation && this.activeProcesses.get(sessionId) === proc) this.emit('data', sessionId, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      this.exitedProcesses.add(proc);
      if (this.generations.get(sessionId) !== generation ||
        (this.activeProcesses.get(sessionId) !== proc &&
          !(generation.stopping && generation.forcedStopProcess === proc && !this.activeProcesses.has(sessionId)))) return;
      console.log(`[ProcessRunner] Process exited, code: ${exitCode}, signal: ${signal}`);
      this.activeProcesses.delete(sessionId);
      this.runtimes.delete(sessionId);
      this.lastSizes.delete(sessionId);
      this.generations.delete(sessionId);
      if (generation.stopping) {
        // stop() initiated this exit; the caller persists the final status.
        return;
      }
      if (exitCode === 0 || exitCode === null || exitCode === undefined) {
        this.emit('complete', sessionId);
      } else {
        this.emit('error', sessionId, new Error(`Process exited with code ${exitCode}`));
      }
    });

    this.emit('ready', sessionId);
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
