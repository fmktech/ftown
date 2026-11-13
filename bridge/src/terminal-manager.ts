import xtermHeadless, { type Terminal as TerminalType } from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';

import { FTOWN_XTERM_THEME } from './xterm-theme.js';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

export interface ScreenData {
  lines: string[];
  totalLines: number;
  offset: number;
  limit: number;
}

export interface GrepMatch {
  lineNumber: number;
  text: string;
  before?: string[];
  after?: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  totalMatches: number;
  offset: number;
  limit: number;
}

interface ManagedTerminal {
  terminal: TerminalType;
  serializer: InstanceType<typeof SerializeAddon>;
  /** Callers waiting for the emulator to catch up; settled on parse or destroy. */
  parseWaiters: Set<() => void>;
}

/**
 * Replay a raw pty log through a headless terminal and return the rendered,
 * human-readable text (scrollback + final screen). Unlike regex ANSI stripping,
 * this interprets cursor movement and repaints, so TUI output comes out as the
 * final screen content instead of duplicated frames or control-code residue.
 * Runs of blank lines are collapsed to one; leading/trailing blanks dropped.
 */
export async function renderRawLogToText(raw: string, cols = 120, rows = 40, scrollback = 50000): Promise<string> {
  if (!raw) return '';
  const terminal = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
  try {
    await new Promise<void>((resolve) => terminal.write(raw, resolve));
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buffer.length; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true).trimEnd() ?? '');
    }
    const collapsed: string[] = [];
    for (const line of lines) {
      if (line === '' && (collapsed.length === 0 || collapsed[collapsed.length - 1] === '')) continue;
      collapsed.push(line);
    }
    while (collapsed.length > 0 && collapsed[collapsed.length - 1] === '') collapsed.pop();
    return collapsed.join('\n');
  } finally {
    terminal.dispose();
  }
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
        theme: FTOWN_XTERM_THEME,
      });
      const serializer = new SerializeAddon();
      terminal.loadAddon(serializer);
      managed = { terminal, serializer, parseWaiters: new Set() };
      this.terminals.set(sessionId, managed);
    }
    return managed;
  }

  write(sessionId: string, data: string): void {
    const managed = this.ensureTerminal(sessionId);
    managed.terminal.write(data, () => {});
  }

  /**
   * xterm parses writes asynchronously: `serialize`/`getScreen` in the same turn
   * as a `write` do not contain it yet. `done` runs once the emulator holds
   * exactly the bytes written before this call — synchronously inside xterm's
   * write loop, before any later write is parsed — or immediately when the
   * session has no emulator, or when it is destroyed while waiting.
   */
  whenParsed(sessionId: string, done: () => void): void {
    const managed = this.terminals.get(sessionId);
    if (!managed) {
      done();
      return;
    }
    const settle = (): void => {
      if (managed.parseWaiters.delete(settle)) done();
    };
    managed.parseWaiters.add(settle);
    managed.terminal.write('', settle);
  }

  serialize(sessionId: string, scrollback?: number): string {
    const managed = this.terminals.get(sessionId);
    if (!managed) return '';
    return managed.serializer.serialize({ scrollback });
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

  /**
   * All buffered terminal lines, top to bottom. Callers match under a bounded
   * regex budget (see bounded-regex.ts) rather than running a pattern here.
   */
  allLines(sessionId: string): string[] {
    const managed = this.terminals.get(sessionId);
    if (!managed) return [];
    const totalLines = managed.terminal.buffer.active.length;
    const lines: string[] = [];
    for (let i = 0; i < totalLines; i++) {
      const line = managed.terminal.buffer.active.getLine(i);
      lines.push(line ? line.translateToString(true) : '');
    }
    return lines;
  }

  replay(sessionId: string, rawLog: string): void {
    const managed = this.ensureTerminal(sessionId);
    managed.terminal.reset();
    managed.terminal.write(rawLog, () => {});
  }

  getSize(sessionId: string): { cols: number; rows: number } | undefined {
    const managed = this.terminals.get(sessionId);
    if (!managed) return undefined;
    return { cols: managed.terminal.cols, rows: managed.terminal.rows };
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
      for (const settle of [...managed.parseWaiters]) settle();
    }
  }

  has(sessionId: string): boolean {
    return this.terminals.has(sessionId);
  }
}
