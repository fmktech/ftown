/** Strip ANSI CSI/SGR and OSC sequences; drop non-printable controls. */
// CSI sequences, charset selection (e.g. ESC ( B), and single-char ESC modes (e.g. ESC =).
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[()#%*+][0-9A-Za-z@]|\x1b[=><~}|MDEHc78]/g;
const OSC_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CONTROL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

export function cleanTerminalLine(text: string): string {
  return text.replace(OSC_RE, '').replace(ANSI_RE, '').replace(CONTROL_RE, '').trimEnd();
}

export function isDisplayableLine(text: string): boolean {
  return cleanTerminalLine(text).trim().length > 0;
}

export function formatLogLines(rawLines: string[]): string[] {
  return rawLines.map(cleanTerminalLine).filter(isDisplayableLine);
}
