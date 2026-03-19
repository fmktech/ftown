import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';

import type { IPty } from 'node-pty';

export interface ClaudeRunnerEvents {
  data: [string, string];       // sessionId, raw terminal data
  complete: [string];            // sessionId
  error: [string, Error];       // sessionId, error
}

interface RunOptions {
  model?: string;
  workingDir?: string;
  cols?: number;
  rows?: number;
}

export class ClaudeRunner extends EventEmitter<ClaudeRunnerEvents> {
  private readonly activeProcesses: Map<string, IPty> = new Map();

  run(sessionId: string, prompt: string, options: RunOptions = {}): void {
    const args: string[] = [];

    if (options.model) {
      args.push('--model', options.model);
    }

    const cwd = options.workingDir ?? process.cwd();
    const cols = options.cols ?? 120;
    const rows = options.rows ?? 40;

    const claudePath = process.env.CLAUDE_PATH ?? 'claude';
    const shellCmd = [claudePath, ...args].map((a) => a.includes(' ') ? `"${a}"` : a).join(' ');
    console.log(`[ClaudeRunner] Spawning shell: ${shellCmd} in ${cwd}`);

    let proc: IPty;
    try {
      proc = pty.spawn('/bin/zsh', ['-l', '-c', shellCmd], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
      console.log(`[ClaudeRunner] Process spawned, pid: ${proc.pid}`);
    } catch (err) {
      console.error(`[ClaudeRunner] Failed to spawn:`, err);
      this.emit('error', sessionId, err instanceof Error ? err : new Error(String(err)));
      return;
    }

    this.activeProcesses.set(sessionId, proc);

    proc.onData((data: string) => {
      this.emit('data', sessionId, data);
    });

    proc.onExit(({ exitCode, signal }) => {
      console.log(`[ClaudeRunner] Process exited, code: ${exitCode}, signal: ${signal}`);
      this.activeProcesses.delete(sessionId);
      if (exitCode === 0 || exitCode === null || exitCode === undefined) {
        this.emit('complete', sessionId);
      } else {
        this.emit('error', sessionId, new Error(`Claude exited with code ${exitCode}`));
      }
    });

    // Send the initial prompt after Claude initializes
    setTimeout(() => {
      if (this.activeProcesses.has(sessionId)) {
        console.log(`[ClaudeRunner] Sending prompt to session ${sessionId}`);
        proc.write(prompt + '\r');
      }
    }, 2000);
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
