import { Terminal } from '@xterm/headless';

export interface ScreenData {
  lines: string[];
  totalLines: number;
  offset: number;
  limit: number;
}

export interface GrepMatch {
  lineNumber: number;
  text: string;
}

export interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
  offset: number;
  limit: number;
}

interface ManagedTerminal {
  terminal: Terminal;
  rawBuffer: string;
}

export class TerminalManager {
  private readonly terminals: Map<string, ManagedTerminal> = new Map();
  private readonly scrollback: number;
  private readonly cols: number;

  constructor(scrollback = 50000, cols = 120) {
    this.scrollback = scrollback;
    this.cols = cols;
  }

  private ensureTerminal(sessionId: string): ManagedTerminal {
    let managed = this.terminals.get(sessionId);
    if (!managed) {
      const terminal = new Terminal({
        cols: this.cols,
        rows: 40,
        scrollback: this.scrollback,
        allowProposedApi: true,
      });
      managed = { terminal, rawBuffer: '' };
      this.terminals.set(sessionId, managed);
    }
    return managed;
  }

  write(sessionId: string, data: string): void {
    const managed = this.ensureTerminal(sessionId);
    managed.terminal.write(data, () => {});
    managed.rawBuffer += data;
  }

  flushRawLog(sessionId: string): string {
    const managed = this.terminals.get(sessionId);
    if (!managed) return '';
    const data = managed.rawBuffer;
    managed.rawBuffer = '';
    return data;
  }

  getScreen(sessionId: string, offset = 0, limit = 1000): ScreenData {
    const managed = this.terminals.get(sessionId);
    if (!managed) {
      return { lines: [], totalLines: 0, offset, limit };
    }

    const totalLines = managed.terminal.buffer.active.length;
    const allLines: string[] = [];

    for (let i = 0; i < totalLines; i++) {
      const line = managed.terminal.buffer.active.getLine(i);
      if (line) {
        allLines.push(line.translateToString(true));
      }
    }

    const lines = allLines.slice(offset, offset + limit);
    return { lines, totalLines, offset, limit };
  }

  grep(sessionId: string, pattern: string, offset = 0, limit = 1000): GrepResult {
    const managed = this.terminals.get(sessionId);
    if (!managed) {
      return { matches: [], totalMatches: 0, offset, limit };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      return { matches: [], totalMatches: 0, offset, limit };
    }

    const totalLines = managed.terminal.buffer.active.length;
    const matches: GrepMatch[] = [];

    for (let i = 0; i < totalLines; i++) {
      const line = managed.terminal.buffer.active.getLine(i);
      if (line) {
        const text = line.translateToString(true);
        if (regex.test(text)) {
          matches.push({ lineNumber: i + 1, text });
        }
      }
    }

    const totalMatches = matches.length;
    const paginatedMatches = matches.slice(offset, offset + limit);
    return { matches: paginatedMatches, totalMatches, offset, limit };
  }

  replay(sessionId: string, rawLog: string): void {
    const managed = this.ensureTerminal(sessionId);
    managed.terminal.reset();
    managed.terminal.write(rawLog, () => {});
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const managed = this.terminals.get(sessionId);
    if (managed) {
      managed.terminal.resize(cols, rows);
    }
  }

  destroy(sessionId: string): void {
    const managed = this.terminals.get(sessionId);
    if (managed) {
      managed.terminal.dispose();
      this.terminals.delete(sessionId);
    }
  }

  has(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }
}
