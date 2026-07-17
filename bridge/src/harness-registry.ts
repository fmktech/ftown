/**
 * Single source of truth for the supported harnesses ("shell types").
 *
 * Every place that used to re-list harness names (ShellType/LoopHarness unions,
 * LOOP_HARNESSES, HOOKED_SHELL_TYPES, WorkflowShell/SHELLS, the buildSessionCommand
 * branch, the prompt-as-CLI-arg predicate) now derives from HARNESSES below.
 *
 * NOTE: this module is part of the bridge dist and is NOT sibling-copied into
 * ~/.ftown. Standalone sibling-copied modules (provider-env-store.ts,
 * workflow-runner.ts, workflow-runner-cli.ts, harness-cli.ts,
 * ftown-sessions-cli.ts) must not import it at runtime — type-only imports are
 * fine (they are erased at compile time).
 */

/** Shell-escape a value for use inside zsh -c '...' */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Everything a harness may need to assemble its launch command. */
export interface BuildCommandInput {
  workingDir?: string;
  model?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  /** Initial prompt passed as a CLI argument — avoids racing the TUI with typed input. */
  initialPrompt?: string;
}

export interface HarnessSpec {
  /** Launch command for this harness (custom-command override is applied by callers). */
  buildCommand: (input: BuildCommandInput) => string;
  /** Mail arrives via the Stop-hook pump — local-api-server delays its typed nudge. */
  hooked: boolean;
  /** The initial prompt may be passed as a CLI argument instead of typed into the TUI. */
  promptAsCliArg: boolean;
  /** Resume field that suppresses the prompt-as-CLI-arg path when present. */
  resumeField?: 'claudeSessionId' | 'cursorSessionId' | 'codexSessionId';
  /**
   * Rebadged base CLI: the harness launches this CLI with provider env overrides
   * (see PROVIDER_AUTH_ENV / PROVIDER_RUNTIME_ENV in provider-env-store.ts,
   * which stays registry-free so it can be sibling-copied).
   */
  providerBase?: 'claude';
  /** Accepted as a Loop harness (loop-validation / LoopHarness). */
  validForLoop: boolean;
  /** Accepted as a workflow child shell (WorkflowShell / ftown-workflows --shell). */
  validForWorkflow: boolean;
  /**
   * Minimum gap (ms) enforced between concurrent spawns of this harness
   * (see spawn-stagger.ts). Unset means spawns are not staggered.
   */
  spawnStaggerMs?: number;
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

export function buildKimiCodeCommand(options: { model?: string }): string {
  // Absolute path: the kimi-code installer adds ~/.kimi-code/bin to PATH only
  // via .zshrc (interactive), but ftown launches agents with `zsh -l -c`
  // (non-interactive login), which does NOT source .zshrc — so a bare `kimi`
  // would fail to resolve. --yolo auto-approves all tool actions for unattended runs.
  const parts = ['"$HOME/.kimi-code/bin/kimi"', '--yolo'];
  if (options.model?.trim()) {
    parts.push('-m', shellQuote(options.model.trim()));
  }
  return parts.join(' ');
}

/** claude CLI launch — shared by 'claude' and every claude-rebadged provider flavor. */
function buildClaudeCommand(input: BuildCommandInput): string {
  const parts = ['claude', '--allow-dangerously-skip-permissions'];
  if (input.model?.trim()) {
    parts.push('--model', shellQuote(input.model.trim()));
  }
  if (input.claudeSessionId?.trim()) {
    parts.push('--resume', shellQuote(input.claudeSessionId.trim()));
  } else if (input.initialPrompt?.trim()) {
    parts.push(shellQuote(input.initialPrompt));
  }
  return parts.join(' ');
}

const CLAUDE_SPEC = {
  buildCommand: buildClaudeCommand,
  hooked: true,
  promptAsCliArg: true,
  resumeField: 'claudeSessionId',
  validForLoop: true,
  validForWorkflow: true,
} as const;

/** claude-rebadged provider flavor (zai/kimi/deepseek/fireworks): same CLI, provider env. */
const PROVIDER_FLAVOR_SPEC = {
  buildCommand: buildClaudeCommand,
  hooked: true,
  promptAsCliArg: true,
  resumeField: 'claudeSessionId',
  providerBase: 'claude',
  // Preserved decision: provider flavors were never in LOOP_HARNESSES or WorkflowShell.
  validForLoop: false,
  validForWorkflow: false,
} as const;

export const HARNESSES = {
  claude: CLAUDE_SPEC,
  cursor: {
    buildCommand: (input) =>
      buildCursorAgentCommand({
        workingDir: input.workingDir,
        model: input.model,
        cursorSessionId: input.cursorSessionId,
        initialPrompt: input.initialPrompt,
      }),
    hooked: false,
    promptAsCliArg: true,
    resumeField: 'cursorSessionId',
    validForLoop: true,
    validForWorkflow: true,
    // Concurrent cursor-agent startups race on a macOS Keychain WRITE during
    // token refresh (last-writer-wins; corrupts auth from 2 concurrent spawns).
    // A 250ms spawn stagger fully eliminated it in testing (0/27 at N=9);
    // 300ms adds margin.
    spawnStaggerMs: 300,
  },
  codex: {
    // Workdir comes from the runner cwd — codex needs no -C flag.
    buildCommand: (input) =>
      buildCodexCommand({
        model: input.model,
        codexSessionId: input.codexSessionId,
        initialPrompt: input.initialPrompt,
      }),
    hooked: true,
    promptAsCliArg: true,
    resumeField: 'codexSessionId',
    validForLoop: true,
    validForWorkflow: true,
  },
  shell: {
    buildCommand: () => '/bin/zsh -l',
    hooked: false,
    promptAsCliArg: false,
    validForLoop: true,
    validForWorkflow: true,
  },
  grok: {
    // Workdir comes from the runner cwd — grok inherits process cwd, no --cwd.
    buildCommand: (input) =>
      buildGrokCommand({
        model: input.model,
        initialPrompt: input.initialPrompt,
      }),
    // Preserved decision: grok was never in HOOKED_SHELL_TYPES (no Stop-hook pump).
    hooked: false,
    promptAsCliArg: true,
    validForLoop: true,
    // Preserved decision: grok was absent from WorkflowShell / ftown-workflows SHELLS.
    validForWorkflow: false,
  },
  opencode: {
    buildCommand: () => 'opencode',
    // Preserved decision: opencode was never in HOOKED_SHELL_TYPES.
    hooked: false,
    // Preserved decision: opencode prompts are typed into the TUI, not passed as args.
    promptAsCliArg: false,
    validForLoop: true,
    validForWorkflow: true,
  },
  'kimi-code': {
    // Own binary (absolute path); interactive TUI, no positional prompt.
    buildCommand: (input) => buildKimiCodeCommand({ model: input.model }),
    hooked: false,
    promptAsCliArg: false,
    validForLoop: true,
    validForWorkflow: false,
  },
  zai: PROVIDER_FLAVOR_SPEC,
  kimi: PROVIDER_FLAVOR_SPEC,
  deepseek: PROVIDER_FLAVOR_SPEC,
  fireworks: PROVIDER_FLAVOR_SPEC,
} as const satisfies Record<string, HarnessSpec>;

// ---- Derived types ----

export type ShellType = keyof typeof HARNESSES;

type KeysWhere<F extends 'validForLoop' | 'validForWorkflow' | 'hooked'> = {
  [K in ShellType]: (typeof HARNESSES)[K][F] extends true ? K : never;
}[ShellType];

/** Harnesses accepted for Loops — derived, so drift is a compile error. */
export type LoopHarness = KeysWhere<'validForLoop'>;

/** Harnesses accepted as workflow child shells — derived, so drift is a compile error. */
export type WorkflowShell = KeysWhere<'validForWorkflow'>;

// ---- Derived runtime lists / predicates ----

export const SHELL_TYPES = Object.keys(HARNESSES) as readonly ShellType[];

export const LOOP_HARNESS_TYPES = SHELL_TYPES.filter(
  (type) => HARNESSES[type].validForLoop,
) as readonly LoopHarness[];

export const WORKFLOW_SHELLS = SHELL_TYPES.filter(
  (type) => HARNESSES[type].validForWorkflow,
) as readonly WorkflowShell[];

/** Shell types whose mail arrives via the Stop-hook pump (claude/codex + claude flavors). */
export const HOOKED_SHELL_TYPES: ReadonlySet<string> = new Set(
  SHELL_TYPES.filter((type) => HARNESSES[type].hooked),
);

export function isShellType(value: unknown): value is ShellType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(HARNESSES, value);
}

export function isLoopHarness(value: unknown): value is LoopHarness {
  return isShellType(value) && HARNESSES[value].validForLoop;
}

/**
 * Whether the initial prompt may be passed as a CLI argument for this harness,
 * given the session's resume fields (a resume suppresses the prompt arg).
 */
export function harnessAcceptsPromptAsCliArg(
  shellType: ShellType,
  input: Pick<BuildCommandInput, 'claudeSessionId' | 'cursorSessionId' | 'codexSessionId'>,
): boolean {
  const spec: HarnessSpec = HARNESSES[shellType];
  if (!spec.promptAsCliArg) return false;
  if (!spec.resumeField) return true;
  return !input[spec.resumeField]?.trim();
}
