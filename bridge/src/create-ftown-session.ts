import { v4 as uuidv4 } from 'uuid';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { buildSessionCommand } from './agent-commands.js';
import { ensureCodexWorkdirTrust } from './codex-installer.js';
import { PROVIDER_AUTH_ENV, loadProviderEnv } from './provider-env-store.js';
import { registerSessionWorkspace } from './session-registry.js';

import type { CentrifugoClient } from './centrifugo-client.js';
import type { ProcessRunner } from './claude-runner.js';
import type { SessionStore } from './session-store.js';
import type { CreateSessionPayload, Session, ShellType } from './types.js';

export interface CreateFtownSessionDeps {
  store: SessionStore;
  runner: ProcessRunner;
  centrifugo: CentrifugoClient;
  userId: string;
  bridgeId: string;
  hookPort: number;
  hookToken: string;
  notifyScriptPath: string;
  wireTerminalInput: (sessionId: string) => void;
}

export interface CreateFtownSessionInput {
  command?: string;
  prompt?: string;
  name?: string;
  workingDir?: string;
  shellType?: ShellType;
  model?: string;
  claudeSessionId?: string;
  cursorSessionId?: string;
  codexSessionId?: string;
  env?: Record<string, string>;
  parentSessionId?: string;
  initialInput?: string;
  initialInputDelay?: number;
  orchestrator?: boolean;
  suppressBriefing?: boolean;
  createMissingWorkingDir?: boolean;
  loopId?: string;
}

export async function resolveParentSessionId(
  store: SessionStore,
  parentSessionId: string | undefined,
): Promise<string | undefined> {
  if (!parentSessionId) return undefined;
  const proposed = await store.loadSession(parentSessionId);
  if (!proposed) {
    throw new Error('Parent session not found');
  }
  return proposed.parentSessionId ?? proposed.id;
}

interface ChildBriefingParams {
  childName: string;
  childId: string;
  parentName: string;
  parentId: string;
}

/** One compact paragraph injected into a child agent's first input. */
export function buildChildBriefing(params: ChildBriefingParams): string {
  return (
    `[ftown] You are child session '${params.childName}' (${params.childId}), ` +
    `spawned by parent '${params.parentName}' (${params.parentId}). ` +
    `Mail from other agents arrives automatically as [ftown mail] context at turn boundaries. ` +
    `Report results/questions to your parent with: ftown-harness mail send --parent "<message>" ` +
    `(add --type result or --type escalation when reporting). Check mail explicitly with: ` +
    `ftown-harness mail read. Inspect peers with ~/.ftown/ftown-sessions list / screen <id>. ` +
    `Your parent can read your terminal at any time.`
  );
}

interface OrchestratorBriefingParams {
  sessionName: string;
  sessionId: string;
}

/** Compact pointer injected into an orchestrator agent's first input. */
export function buildOrchestratorBriefing(params: OrchestratorBriefingParams): string {
  return (
    `[ftown] You are an ORCHESTRATOR running inside ftown session '${params.sessionName}' ` +
    `(${params.sessionId}). Use the 'ftown-orchestrator' skill (installed at ` +
    `~/.ftown/skills/ftown-orchestrator, linked from ~/.agents/skills and ~/.claude/skills — ` +
    `read its SKILL.md if not auto-loaded) to spawn and coordinate worker agent sessions ` +
    `via ~/.ftown/ftown-sessions. Children you spawn with --parent report back via mail — ` +
    `their messages arrive automatically as [ftown mail] context at your turn boundaries; ` +
    `check on demand with ftown-harness mail read.`
  );
}

/**
 * Provider API tokens live on the bridge machine under provider-specific keys
 * (ZAI_API_TOKEN, KIMI_API_TOKEN, DEEPSEEK_API_TOKEN, FIREWORKS_API_TOKEN) so
 * secrets never travel through the browser or the spawn command. A flavor's
 * source token may arrive from three places, resolved last-wins:
 * processEnv (the bridge's own environment), storeEnv (~/.ftown/env.json), and
 * inputEnv (the per-create body). The matching token is mapped onto the
 * Anthropic auth var the CLI expects.
 */
export interface ProviderEnvSources {
  inputEnv?: Record<string, string | undefined>;
  storeEnv?: Record<string, string | undefined>;
  processEnv: Record<string, string | undefined>;
}

/**
 * Raised when a MAPPED provider flavor is requested but its source token is
 * absent from every configured source. The message names the provider, the
 * env-var KEY, and the `ftown env set` remedy — NEVER a token value.
 */
export class ProviderAuthMissingError extends Error {
  readonly provider: string;
  readonly source: string;
  readonly fix: string;

  constructor(provider: string, source: string, fix: string) {
    super(
      `Provider '${provider}' requires a machine token, but ${source} is not set ` +
        `in the bridge env, ~/.ftown/env.json, or the create request. Fix: ${fix}`,
    );
    this.name = 'ProviderAuthMissingError';
    this.provider = provider;
    this.source = source;
    this.fix = fix;
  }
}

export class WorkingDirMissingError extends Error {
  readonly code = 'working_dir_missing';
  readonly workingDir: string;

  constructor(workingDir: string) {
    super(`Working directory does not exist: ${workingDir}`);
    this.name = 'WorkingDirMissingError';
    this.workingDir = workingDir;
  }
}

export function prepareWorkingDir(
  workingDir: string | undefined,
  createMissingWorkingDir: boolean | undefined,
): string | undefined {
  const trimmed = workingDir?.trim();
  if (!trimmed) return undefined;

  const resolved = resolve(trimmed);
  if (!existsSync(resolved)) {
    if (!createMissingWorkingDir) {
      throw new WorkingDirMissingError(resolved);
    }
    mkdirSync(resolved, { recursive: true });
  }

  if (!statSync(resolved).isDirectory()) {
    throw new Error(`Working directory is not a directory: ${resolved}`);
  }

  return resolved;
}

export function nextAvailableGeneratedName(baseName: string, existingNames: Iterable<string>): string {
  const existing = new Set(existingNames);
  if (!existing.has(baseName)) return baseName;

  for (let i = 1; ; i += 1) {
    const candidate = `${baseName}_${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/**
 * Last-wins merge of the three sources for SOURCE-token lookup: inputEnv beats
 * storeEnv beats processEnv (object-spread order — later spreads override).
 */
function mergeProviderSources(sources: ProviderEnvSources): Record<string, string | undefined> {
  return { ...sources.processEnv, ...(sources.storeEnv ?? {}), ...(sources.inputEnv ?? {}) };
}

/**
 * TOTAL resolver: returns {} for an unmapped flavor (plain
 * claude/cursor/codex/shell/opencode or undefined) OR when the source token is
 * absent in every source. Otherwise maps the source token onto the flavor's
 * Anthropic auth target.
 */
export function resolveProviderAuthEnv(
  shellType: ShellType | undefined,
  sources: ProviderEnvSources,
): Record<string, string> {
  const mapping = PROVIDER_AUTH_ENV[shellType ?? ''];
  if (!mapping) return {};
  const token = mergeProviderSources(sources)[mapping.source];
  if (!token) return {};
  return { [mapping.target]: token };
}

/**
 * Non-throwing guard twin: returns the ProviderAuthMissingError a mapped flavor
 * would raise when its source token is absent everywhere, or undefined when the
 * flavor is unmapped or a token is present. Used by resurrection to re-block a
 * dead session whose token has since disappeared.
 */
export function findMissingProviderAuth(
  shellType: ShellType | undefined,
  sources: ProviderEnvSources,
): ProviderAuthMissingError | undefined {
  const mapping = PROVIDER_AUTH_ENV[shellType ?? ''];
  if (!mapping) return undefined;
  const token = mergeProviderSources(sources)[mapping.source];
  if (token) return undefined;
  const provider = shellType ?? '';
  return new ProviderAuthMissingError(provider, mapping.source, `ftown env set ${provider} <token>`);
}

/** Throwing guard: surfaces the missing-token error for a mapped flavor. */
export function assertProviderAuthAvailable(
  shellType: ShellType | undefined,
  sources: ProviderEnvSources,
): void {
  const missing = findMissingProviderAuth(shellType, sources);
  if (missing) throw missing;
}

export async function createFtownSession(
  deps: CreateFtownSessionDeps,
  input: CreateFtownSessionInput,
): Promise<Session> {
  const prompt = input.prompt?.trim() ?? '';

  let parentSessionId: string | undefined;
  let parentName: string | undefined;
  if (input.parentSessionId) {
    parentSessionId = await resolveParentSessionId(deps.store, input.parentSessionId);
    if (parentSessionId) {
      const parentSession = await deps.store.loadSession(parentSessionId);
      parentName = parentSession?.name ?? parentSessionId.slice(0, 8);
    }
  }

  const isAgent = input.shellType !== 'shell';
  // Provider API tokens are read from the bridge's environment, the
  // ~/.ftown/env.json store, and the per-create input (last-wins) and mapped
  // onto the Anthropic auth var here — so the UI-supplied env (base URL, model
  // overrides) never carries a secret. Fail loudly BEFORE persisting the
  // session when a mapped flavor has no token anywhere.
  const sources: ProviderEnvSources = {
    processEnv: process.env,
    storeEnv: loadProviderEnv(),
    inputEnv: input.env,
  };
  assertProviderAuthAvailable(input.shellType, sources);
  const providerAuth = resolveProviderAuthEnv(input.shellType, sources);
  const isOrchestratorAgent = input.orchestrator && isAgent;
  const sessionEnv: Record<string, string> | undefined =
    input.env || Object.keys(providerAuth).length > 0 || isOrchestratorAgent
      ? {
          ...(input.env ?? {}),
          ...providerAuth,
          ...(isOrchestratorAgent ? { FTOWN_ORCHESTRATOR: '1' } : {}),
        }
      : undefined;

  const workingDir = prepareWorkingDir(input.workingDir, input.createMissingWorkingDir);
  const effectiveInput: CreateFtownSessionInput = { ...input, workingDir };
  // Base command (no prompt arg) — persisted on the session and used for the
  // default name; the prompt-bearing launch command must not be replayed on revive.
  const command = buildSessionCommand(effectiveInput);

  const explicitName = input.name?.trim();
  const shouldSuffixGeneratedName = !explicitName && Boolean(workingDir);
  const generatedBaseName =
    (workingDir ? basename(workingDir) : '') || (prompt || command).slice(0, 80);
  const sessionName = explicitName
    ?? (shouldSuffixGeneratedName
      ? nextAvailableGeneratedName(
          generatedBaseName,
          (await deps.store.listSessions()).map((session) => session.name),
        )
      : generatedBaseName);

  const sessionId = uuidv4();
  const session: Session = {
    id: sessionId,
    name: sessionName,
    command,
    prompt: prompt || undefined,
    status: 'running',
    bridgeId: deps.bridgeId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workingDir,
    shellType: input.shellType,
    model: input.model,
    claudeSessionId: input.claudeSessionId,
    cursorSessionId: input.cursorSessionId,
    codexSessionId: input.codexSessionId,
    env: sessionEnv,
    parentSessionId,
    runtime: deps.runner.getPreferredRuntime(),
    loopId: input.loopId,
  };

  await deps.store.saveSession(session);
  try {
    await deps.centrifugo.publishSessionUpdate(deps.userId, session);
  } catch (err) {
    // UI sync failure must not fail session creation — resurrection treats
    // publish errors the same way.
    console.error(`[Bridge] Failed to publish session create for ${sessionId}:`, err);
  }

  registerSessionWorkspace(sessionId, workingDir);

  // Agent sessions (anything but a plain 'shell') spawned by a parent get a
  // one-paragraph briefing prepended to their first input so they know their
  // place in the session tree and how to talk to parent/siblings.
  const childBriefing =
    !input.suppressBriefing && parentSessionId && parentName && isAgent
      ? buildChildBriefing({
          childName: session.name,
          childId: sessionId,
          parentName,
          parentId: parentSessionId,
        })
      : undefined;
  const orchestratorBriefing =
    !input.suppressBriefing && input.orchestrator && isAgent
      ? buildOrchestratorBriefing({ sessionName: session.name, sessionId })
      : undefined;
  // Orchestrator paragraph follows the child paragraph, separated by a blank line.
  const briefing = [childBriefing, orchestratorBriefing].filter(Boolean).join('\n\n') || undefined;

  // Composer TUIs need the submit CR sent separately after the paste settles —
  // a CR inside the pasted chunk becomes a newline, and ESC+CR reads as
  // Alt+Enter (newline) on current Claude Code, so plain CR it is.
  const promptSubmitSuffix = '\r';

  let initialInput: string | undefined;
  let initialInputDelay: number | undefined;
  let submitSuffix: string | undefined;
  if (briefing) {
    initialInput = prompt ? `${briefing}\n\nTask: ${prompt}` : briefing;
    initialInputDelay = input.initialInputDelay ?? 2000;
    submitSuffix = promptSubmitSuffix;
  } else if (input.initialInput !== undefined) {
    // Raw passthrough: callers own the submit keystrokes; suppress the default CR.
    initialInput = input.initialInput;
    initialInputDelay = input.initialInputDelay;
    submitSuffix = '';
  } else {
    initialInput = prompt || undefined;
    initialInputDelay = input.initialInputDelay ?? (prompt ? 2000 : undefined);
    submitSuffix = promptSubmitSuffix;
  }

  // claude, cursor, and codex accept the initial prompt as a CLI argument —
  // far more reliable than racing the composer TUI with delayed keystrokes.
  // Typed injection remains for custom commands, resumes, and raw passthrough.
  const shellTypeForPrompt = effectiveInput.shellType ?? 'claude';
  const promptAsCliArg =
    initialInput !== undefined &&
    effectiveInput.initialInput === undefined &&
    !effectiveInput.command?.trim() &&
    ((shellTypeForPrompt === 'claude' && !effectiveInput.claudeSessionId?.trim()) ||
      (shellTypeForPrompt === 'cursor' && !effectiveInput.cursorSessionId?.trim()) ||
      (shellTypeForPrompt === 'codex' && !effectiveInput.codexSessionId?.trim()));

  const launchCommand = promptAsCliArg
    ? buildSessionCommand({ ...effectiveInput, initialPrompt: initialInput })
    : command;
  if (promptAsCliArg) {
    initialInput = undefined;
    initialInputDelay = undefined;
    submitSuffix = undefined;
  }

  if (effectiveInput.shellType === 'codex') {
    // Codex blocks on an interactive "Do you trust this directory?" prompt
    // unless the resolved workdir is trusted in ~/.codex/config.toml.
    ensureCodexWorkdirTrust(workingDir ?? process.cwd());
  }

  deps.runner.run(sessionId, launchCommand, {
    workingDir,
    env: sessionEnv,
    initialInput,
    initialInputDelay,
    submitSuffix,
    hookPort: deps.hookPort,
    hookToken: deps.hookToken,
    parentSessionId,
  });

  deps.wireTerminalInput(sessionId);

  return session;
}

/** Map a Local API JSON body into create input. */
export function parseCreateSessionBody(
  body: Record<string, unknown>,
  callerSessionId?: string,
): CreateFtownSessionInput {
  const shellType = body.shellType as ShellType | undefined;
  const env = body.env as Record<string, string> | undefined;

  let parentSessionId =
    typeof body.parentSessionId === 'string' ? body.parentSessionId : undefined;
  if (!parentSessionId && callerSessionId) {
    parentSessionId = callerSessionId;
  }

  return {
    command: typeof body.command === 'string' ? body.command : undefined,
    prompt: typeof body.prompt === 'string' ? body.prompt : undefined,
    name: typeof body.name === 'string' ? body.name : undefined,
    workingDir: typeof body.workingDir === 'string' ? body.workingDir : undefined,
    shellType,
    model: typeof body.model === 'string' ? body.model : undefined,
    claudeSessionId:
      typeof body.claudeSessionId === 'string' ? body.claudeSessionId : undefined,
    cursorSessionId:
      typeof body.cursorSessionId === 'string' ? body.cursorSessionId : undefined,
    codexSessionId:
      typeof body.codexSessionId === 'string' ? body.codexSessionId : undefined,
    env: env && typeof env === 'object' ? env : undefined,
    parentSessionId,
    initialInput: typeof body.initialInput === 'string' ? body.initialInput : undefined,
    initialInputDelay:
      typeof body.initialInputDelay === 'number' ? body.initialInputDelay : undefined,
    orchestrator: body.orchestrator === true,
    suppressBriefing: body.suppressBriefing === true,
    createMissingWorkingDir: body.createMissingWorkingDir === true,
  };
}
