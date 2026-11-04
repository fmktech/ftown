/**
 * Terminal URL detection contract. See
 * docs/investigations/2026-11-04-terminal-multiline-links-fail-to-open.md.
 *
 * The buffer types are structural views of xterm's IBuffer / IBufferLine / IBufferCell, so
 * `term.buffer.active` can be passed as-is and tests can use plain fakes.
 */

export interface TerminalLinkCell {
  /** "" for an empty cell (never written, e.g. skipped by a cursor-forward), else its text. */
  getChars(): string;
  /** 1 for normal, 2 for wide, 0 for the trailing half of a wide character. */
  getWidth(): number;
}

export interface TerminalLinkLine {
  /** True when xterm soft-wrapped the previous row into this one. */
  readonly isWrapped: boolean;
  /** Number of cells in the row (the terminal's cols). */
  readonly length: number;
  getCell(x: number): TerminalLinkCell | undefined;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface TerminalLinkBuffer {
  readonly length: number;
  /** 0-based row index. */
  getLine(y: number): TerminalLinkLine | undefined;
}

/** Buffer cell range, 1-based and inclusive on both ends (xterm's IBufferRange convention). */
export interface TerminalLinkRange {
  readonly start: { readonly x: number; readonly y: number };
  readonly end: { readonly x: number; readonly y: number };
}

export interface TerminalLink {
  /** The URL to open. For a hard-wrapped URL every fragment carries the full joined URL. */
  readonly url: string;
  /** The cells of this fragment only (a continuation row's indent is never included). */
  readonly range: TerminalLinkRange;
}

/**
 * Links touching buffer row `bufferLineNumber` (1-based, as xterm passes to
 * ILinkProvider.provideLinks). Never throws; returns [] when there are none.
 */
export type FindTerminalLinks = (buffer: TerminalLinkBuffer, bufferLineNumber: number) => TerminalLink[];

/** Identical to @xterm/addon-web-links 0.12 `strictUrlRegex` (non-global; callers clone it with "g"). */
export const TERMINAL_URL_REGEX = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\\^<>`]*[^\s"':,.!?{}|\\\^~\[\]`()<>]/;

/** One character that may appear inside a URL (the body class of TERMINAL_URL_REGEX). */
export const TERMINAL_URL_BODY_CHAR = /[^\s"'!*(){}|\\\^<>`]/;

/** A hard-wrapped row continues only if its URL text reaches the row's last cell (cols - 1 - slack). */
export const TERMINAL_LINK_EDGE_SLACK = 0;

/** Deepest leading indent accepted on a continuation row. */
export const TERMINAL_LINK_MAX_INDENT = 8;

/** Longest URL produced by joining hard-wrapped rows (same budget as the addon's line window). */
export const TERMINAL_LINK_MAX_URL_LENGTH = 2048;
