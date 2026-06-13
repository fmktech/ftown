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
