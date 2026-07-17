import { HARNESSES } from './harness-registry.js';

import type { HarnessSpec } from './harness-registry.js';
import type { ShellType } from './types.js';

// The per-harness builders live in the registry; re-exported here so existing
// importers (and tests) keep their import paths.
export {
  shellQuote,
  buildCursorAgentCommand,
  buildCodexCommand,
  buildGrokCommand,
  buildKimiCodeCommand,
} from './harness-registry.js';

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
  // Runtime shellType may come from unvalidated JSON — unknown values fall back
  // to the claude launch, exactly like the old if/else chain's final branch.
  const spec: HarnessSpec = (HARNESSES as Record<string, HarnessSpec>)[shellType] ?? HARNESSES.claude;
  return spec.buildCommand(input);
}
