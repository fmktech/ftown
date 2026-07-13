import type { ShellType } from './types.js';

/** Shell-escape a value for use inside zsh -c '...' */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildCursorAgentCommand(options: {
  workingDir?: string;
  model?: string;
  cursorSessionId?: string;
  initialPrompt?: string;
}): string {
  const parts = ['agent', '--force'];

  if (options.workingDir?.trim()) {
    parts.push('--workspace', shellQuote(options.workingDir.trim()));
  }

  if (options.model?.trim()) {
    parts.push('--model', shellQuote(options.model.trim()));
  }

  if (options.cursorSessionId?.trim()) {
    parts.push('--resume', shellQuote(options.cursorSessionId.trim()));
  }

  if (options.initialPrompt?.trim()) {
    parts.push(shellQuote(options.initialPrompt));
  }

  return parts.join(' ');
}

export function buildCodexCommand(options: {
  model?: string;
  codexSessionId?: string;
  initialPrompt?: string;
}): string {
  // --dangerously-bypass-hook-trust silences the interactive hook-trust review
  // for our installed ~/.codex/hooks.json entries (harmless warning banner).
  const parts = [
    'codex',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
  ];

  if (options.codexSessionId?.trim()) {
    // Resume must not replay the original prompt — codex restores the thread.
    parts.push('resume', shellQuote(options.codexSessionId.trim()));
    return parts.join(' ');
  }

  if (options.model?.trim()) {
    parts.push('-m', shellQuote(options.model.trim()));
  }

  if (options.initialPrompt?.trim()) {
    // The positional prompt is auto-submitted by the codex TUI.
    parts.push(shellQuote(options.initialPrompt));
  }

  return parts.join(' ');
}

export function buildGrokCommand(options: {
  model?: string;
  initialPrompt?: string;
}): string {
  // --always-approve auto-approves all tool executions for unattended runs.
  const parts = ['grok', '--always-approve'];

  if (options.model?.trim()) {
    parts.push('-m', shellQuote(options.model.trim()));
  }

  if (options.initialPrompt?.trim()) {
    // The positional prompt is auto-submitted by the grok TUI.
    parts.push(shellQuote(options.initialPrompt));
  }

  return parts.join(' ');
}

export interface BuildSessionCommandInput {
  shellType?: ShellType;
  workingDir?: string;
  model?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  command?: string;
  /** Initial prompt passed as a CLI argument — avoids racing the TUI with typed input. */
  initialPrompt?: string;
}

export function buildSessionCommand(input: BuildSessionCommandInput): string {
  if (input.command?.trim()) {
    return input.command.trim();
  }

  const shellType = input.shellType ?? 'claude';

  if (shellType === 'shell') {
    return '/bin/zsh -l';
  }
  if (shellType === 'opencode') {
    return 'opencode';
  }
  if (shellType === 'cursor') {
    return buildCursorAgentCommand({
      workingDir: input.workingDir,
      model: input.model,
      cursorSessionId: input.cursorSessionId,
      initialPrompt: input.initialPrompt,
    });
  }
  if (shellType === 'codex') {
    // Workdir comes from the runner cwd — codex needs no -C flag.
    return buildCodexCommand({
      model: input.model,
      codexSessionId: input.codexSessionId,
      initialPrompt: input.initialPrompt,
    });
  }
  if (shellType === 'grok') {
    // Workdir comes from the runner cwd — grok inherits process cwd, no --cwd.
    return buildGrokCommand({
      model: input.model,
      initialPrompt: input.initialPrompt,
    });
  }
  if (input.claudeSessionId?.trim()) {
    return `claude --allow-dangerously-skip-permissions --resume ${shellQuote(input.claudeSessionId.trim())}`;
  }
  if (input.initialPrompt?.trim()) {
    return `claude --allow-dangerously-skip-permissions ${shellQuote(input.initialPrompt)}`;
  }
  return 'claude --allow-dangerously-skip-permissions';
}
