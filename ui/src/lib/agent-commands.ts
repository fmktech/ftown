/** Shell-escape a value for use inside zsh -c '...' */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCursorAgentCommand(options: {
  workingDir?: string;
  model?: string;
  cursorSessionId?: string;
}): string {
  const parts = ["agent", "--force"];

  if (options.workingDir?.trim()) {
    parts.push("--workspace", shellQuote(options.workingDir.trim()));
  }

  if (options.model?.trim()) {
    parts.push("--model", shellQuote(options.model.trim()));
  }

  if (options.cursorSessionId?.trim()) {
    parts.push("--resume", shellQuote(options.cursorSessionId.trim()));
  }

  return parts.join(" ");
}

export function buildCodexCommand(options: {
  model?: string;
  codexSessionId?: string;
}): string {
  const parts = [
    "codex",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
  ];

  if (options.codexSessionId?.trim()) {
    parts.push("resume", shellQuote(options.codexSessionId.trim()));
    return parts.join(" ");
  }

  if (options.model?.trim()) {
    parts.push("-m", shellQuote(options.model.trim()));
  }

  return parts.join(" ");
}

export function buildGrokCommand(options: {
  model?: string;
  initialPrompt?: string;
}): string {
  const parts = ["grok", "--always-approve"];

  if (options.model?.trim()) {
    parts.push("-m", shellQuote(options.model.trim()));
  }

  if (options.initialPrompt?.trim()) {
    parts.push(shellQuote(options.initialPrompt));
  }

  return parts.join(" ");
}

export function buildPiCommand(options: { model?: string }): string {
  const parts = ["pi", "--extension", '"$HOME/.ftown/pi/ftown.js"'];
  if (options.model?.trim()) {
    parts.push("--model", shellQuote(options.model.trim()));
  }
  return parts.join(" ");
}

export function buildKimiCodeCommand(options: { model?: string }): string {
  // Absolute path: the kimi-code installer adds ~/.kimi-code/bin to PATH only via
  // .zshrc (interactive); ftown launches with `zsh -l -c` (non-interactive login),
  // which does not source .zshrc, so a bare `kimi` fails. --yolo auto-approves.
  const parts = ['"$HOME/.kimi-code/bin/kimi"', '--yolo'];
  if (options.model?.trim()) {
    parts.push('-m', shellQuote(options.model.trim()));
  }
  return parts.join(' ');
}
