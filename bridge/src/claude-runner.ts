import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';

import type { IPty } from 'node-pty';

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
  hookPort?: number;
}

export class ProcessRunner extends EventEmitter<ProcessRunnerEvents> {
  private readonly activeProcesses: Map<string, IPty> = new Map();

  run(sessionId: string, command: string, options: RunOptions = {}): void {
    const cwd = options.workingDir ?? process.cwd();
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: 'xterm-256color',
    };

    if (options.hookPort) {
      env.FTOWN_HOOK_PORT = String(options.hookPort);
      env.FTOWN_SESSION_ID = sessionId;
    }

    if (options.env) {
      Object.assign(env, options.env);
    }

    console.log(`[ProcessRunner] Spawning command in ${cwd}: ${command}`);

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

    proc.onData((data: string) => {
      this.emit('data', sessionId, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      console.log(`[ProcessRunner] Process exited, code: ${exitCode}, signal: ${signal}`);
      this.activeProcesses.delete(sessionId);
      if (exitCode === 0 || exitCode === null || exitCode === undefined) {
        this.emit('complete', sessionId);
      } else {
        this.emit('error', sessionId, new Error(`Process exited with code ${exitCode}`));
      }
    });

    if (options.initialInput) {
      const delay = options.initialInputDelay ?? 2000;
      setTimeout(() => {
        if (this.activeProcesses.has(sessionId)) {
          console.log(`[ProcessRunner] Sending initial input to session ${sessionId}`);
          proc.write(options.initialInput + '\r');
        }
      }, delay);
    }
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
    return true;
  }

  stop(sessionId: string): boolean {
    const proc = this.activeProcesses.get(sessionId);
    if (!proc) {
      return false;
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
    for (const [sessionId] of this.activeProcesses) {
      this.stop(sessionId);
    }
  }

  isRunning(sessionId: string): boolean {
    return this.activeProcesses.has(sessionId);
  }

}
