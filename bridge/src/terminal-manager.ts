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
  rawBuffer: string;
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
      managed = { terminal, serializer, rawBuffer: '' };
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

  getRawBuffer(sessionId: string): string {
    const managed = this.terminals.get(sessionId);
    if (!managed) return '';
    return managed.rawBuffer;
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

  grep(
    sessionId: string,
    pattern: string,
    offset = 0,
    limit = 1000,
    contextLines = 0,
  ): GrepResult {
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
    const lineTexts: string[] = [];
    for (let i = 0; i < totalLines; i++) {
      const line = managed.terminal.buffer.active.getLine(i);
      lineTexts.push(line ? line.translateToString(true) : '');
    }

    const matches: GrepMatch[] = [];
    const ctx = Math.max(0, Math.min(10, contextLines));

    for (let i = 0; i < lineTexts.length; i++) {
      if (regex.test(lineTexts[i])) {
        const entry: GrepMatch = { lineNumber: i + 1, text: lineTexts[i] };
        if (ctx > 0) {
          entry.before = lineTexts.slice(Math.max(0, i - ctx), i);
          entry.after = lineTexts.slice(i + 1, Math.min(lineTexts.length, i + 1 + ctx));
        }
        matches.push(entry);
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
