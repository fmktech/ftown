import { HARNESSES, shellQuote } from './harness-registry.js';
import { claudeModLaunchPath } from './claude-mod-installer.js';

import type { HarnessSpec } from './harness-registry.js';
import type { ShellType } from './types.js';

// The per-harness builders live in the registry; re-exported here so existing
// importers (and tests) keep their import paths.
export {
  buildOpencodeCommand,
  shellQuote,
  buildCursorAgentCommand,
  buildCodexCommand,
  buildGrokCommand,
  buildMuseCommand,
  buildPiCommand,
  buildKimiCodeCommand,
} from './harness-registry.js';

export interface BuildSessionCommandInput {
  shellType?: ShellType;
  workingDir?: string;
  model?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  piSessionId?: string;
  opencodeSessionId?: string;
  museSessionId?: string;
  command?: string;
  /** Initial prompt passed as a CLI argument — avoids racing the TUI with typed input. */
  initialPrompt?: string;
  /** Resurrection resume — workdir-based harnesses (Pi/kimi-code) append their continue flag; id-based harnesses (incl. muse) ignore it and key off their id fields. */
  resume?: boolean;
}

export function buildSessionCommand(input: BuildSessionCommandInput): string {
  if (input.command?.trim()) {
    const command = input.command.trim();
    const type = input.shellType ?? 'claude';
    const spec: HarnessSpec | undefined = (HARNESSES as Record<string, HarnessSpec>)[type];
    const base = 'claude --allow-dangerously-skip-permissions';
    const nativeId = input.claudeSessionId?.trim();
    // Existing/cached dashboards send these exact generated commands. Decorate
    // only that narrow surface; genuine custom commands remain verbatim, and
    // the dashboard's model/prompt/resume behavior stays unchanged.
    const generatedResume = nativeId && /^[a-zA-Z0-9_-]+$/.test(nativeId) && (
      command === `${base} --resume ${nativeId}` || command === `${base} --resume ${shellQuote(nativeId)}`
    );
    if ((type === 'claude' || spec?.providerBase === 'claude') && (command === base || generatedResume)) {
      const mod = claudeModLaunchPath();
      if (mod) return `${base} --plugin-dir ${shellQuote(mod)}${command.slice(base.length)}`;
    }
    return command;
  }

  const shellType = input.shellType ?? 'claude';
  // Runtime shellType may come from unvalidated JSON — unknown values fall back
  // to the claude launch, exactly like the old if/else chain's final branch.
  const spec: HarnessSpec = (HARNESSES as Record<string, HarnessSpec>)[shellType] ?? HARNESSES.claude;
  return spec.buildCommand(input);
}
