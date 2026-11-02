/** Minimal structural view of an xterm buffer (@xterm/xterm IBuffer satisfies it). */
export interface TerminalBufferLike {
  readonly length: number;
  getLine(y: number): { readonly isWrapped: boolean; translateToString(trimRight?: boolean): string } | undefined;
}

/**
 * Plain text of the buffer. Rows with isWrapped=true are joined onto the previous row with no
 * separator, forming one logical line. Each logical line has its trailing whitespace trimmed.
 * Trailing blank logical lines are dropped. Lines are joined with "\n".
 * maxLines keeps only the LAST n logical lines (n >= 1; non-positive or absent means all).
 */
export function terminalBufferText(buffer: TerminalBufferLike, options?: { maxLines?: number }): string {
  const logical: string[] = [];
  let current: string | null = null;

  for (let y = 0; y < buffer.length; y++) {
    const line = buffer.getLine(y);
    const text = line ? line.translateToString(false) : "";
    const wrapped = line ? line.isWrapped : false;
    if (wrapped && current !== null) {
      current += text;
    } else {
      if (current !== null) logical.push(current);
      current = text;
    }
  }
  if (current !== null) logical.push(current);

  const lines = logical.map((text) => text.trimEnd());
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const maxLines = options?.maxLines;
  const kept =
    typeof maxLines === "number" && Number.isFinite(maxLines) && maxLines >= 1
      ? lines.slice(-Math.floor(maxLines))
      : lines;

  return kept.join("\n");
}
