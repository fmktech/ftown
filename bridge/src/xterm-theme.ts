/** Match ui/src/components/Terminal.tsx so serialize/replay preserves agent colors. */
export const FTOWN_XTERM_THEME = {
  background: '#07070a',
  foreground: '#e8e8f0',
  cursor: '#00ff88',
  cursorAccent: '#07070a',
  selectionBackground: 'rgba(0, 255, 136, 0.15)',
  black: '#0a0a0d',
  red: '#ff4466',
  green: '#00ff88',
  yellow: '#ffaa00',
  blue: '#44aaff',
  magenta: '#cc66ff',
  cyan: '#00ddff',
  white: '#c8c8d8',
  brightBlack: '#44444f',
  brightRed: '#ff6680',
  brightGreen: '#33ffaa',
  brightYellow: '#ffcc44',
  brightBlue: '#66bbff',
  brightMagenta: '#dd88ff',
  brightCyan: '#44eeff',
  brightWhite: '#e8e8f0',
} as const;

/** Ink-based CLIs (Cursor Agent) emit no ANSI colors unless truecolor is advertised. */
export function applyTerminalColorEnv(env: Record<string, string>): void {
  if (!env.TERM) {
    env.TERM = 'xterm-256color';
  }
  if (!env.COLORTERM) {
    env.COLORTERM = 'truecolor';
  }
  if (!env.NO_COLOR && env.FORCE_COLOR === undefined) {
    env.FORCE_COLOR = '3';
  }
}
