import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';

import type { IPty } from 'node-pty';
import type { ShellType } from './types.js';

export interface ProcessRunnerEvents {
  data: [string, string];
  complete: [string];
  error: [string, Error];
}

interface RunOptions {
  model?: string;
  workingDir?: string;
  cols?: number;
  rows?: number;
  shellType?: ShellType;
  hookPort?: number;
  resumeSessionId?: string;
}

export class ProcessRunner extends EventEmitter<ProcessRunnerEvents> {
  private readonly activeProcesses: Map<string, IPty> = new Map();

  run(sessionId: string, prompt: string, options: RunOptions = {}): void {
    const cwd = options.workingDir ?? process.cwd();
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;
    const shellType = options.shellType ?? 'claude';

    let proc: IPty;

    if (shellType === 'shell') {
      console.log(`[ProcessRunner] Spawning interactive shell in ${cwd}`);
      try {
        proc = pty.spawn('/bin/zsh', ['-l'], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
        console.log(`[ProcessRunner] Shell process spawned, pid: ${proc.pid}`);
      } catch (err) {
        console.error(`[ProcessRunner] Failed to spawn shell:`, err);
        this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
        return;
      }
    } else {
      const args: string[] = ['--dangerously-skip-permissions'];

      if (options.resumeSessionId) {
        args.push('--resume', options.resumeSessionId);
      }

      const env: Record<string, string> = { ...process.env as Record<string, string>, TERM: 'xterm-256color' };

      if (options.hookPort) {
        env.FTOWN_HOOK_PORT = String(options.hookPort);
        env.FTOWN_SESSION_ID = sessionId;
      }

      const claudePath = process.env.CLAUDE_PATH ?? 'claude';
      const shellCmd = [claudePath, ...args].map((a) => a.includes(' ') ? `"${a}"` : a).join(' ');
      console.log(`[ProcessRunner] Spawning claude: ${shellCmd} in ${cwd}`);

      try {
        proc = pty.spawn('/bin/zsh', ['-l', '-c', shellCmd], {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          env,
        });
        console.log(`[ProcessRunner] Claude process spawned, pid: ${proc.pid}`);
      } catch (err) {
        console.error(`[ProcessRunner] Failed to spawn claude:`, err);
        this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
        return;
      }
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

    if (shellType === 'claude' && !options.resumeSessionId) {
      setTimeout(() => {
        if (this.activeProcesses.has(sessionId)) {
          console.log(`[ProcessRunner] Sending prompt to session ${sessionId}`);
          proc.write(prompt + '\r');
        }
      }, 2000);
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
