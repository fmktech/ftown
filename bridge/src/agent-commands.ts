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

export interface BuildSessionCommandInput {
  shellType?: ShellType;
  workingDir?: string;
  model?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
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
  if (input.claudeSessionId?.trim()) {
    return `claude --allow-dangerously-skip-permissions --resume ${shellQuote(input.claudeSessionId.trim())}`;
  }
  if (input.initialPrompt?.trim()) {
    return `claude --allow-dangerously-skip-permissions ${shellQuote(input.initialPrompt)}`;
  }
  return 'claude --allow-dangerously-skip-permissions';
}
