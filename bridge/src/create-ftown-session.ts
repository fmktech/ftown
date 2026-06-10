import { v4 as uuidv4 } from 'uuid';

import { buildSessionCommand } from './agent-commands.js';
import { installProjectCursorHooks } from './cursor-hook-installer.js';
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
  env?: Record<string, string>;
  parentSessionId?: string;
  initialInput?: string;
  initialInputDelay?: number;
  orchestrator?: boolean;
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
    `Report results/questions to your parent with: ~/.ftown/ftown-sessions tell --parent "<message>" ` +
    `— message siblings with tell --siblings, and inspect peers with ` +
    `~/.ftown/ftown-sessions list / screen <id>. Your parent can read your terminal at any time.`
  );
}

interface OrchestratorBriefingParams {
  sessionName: string;
  sessionId: string;
}

/** One compact paragraph injected into an orchestrator agent's first input. */
export function buildOrchestratorBriefing(params: OrchestratorBriefingParams): string {
  return (
    `[ftown] You are running inside ftown session '${params.sessionName}' ` +
    `(${params.sessionId}) and can orchestrate sibling agent sessions on this machine. ` +
    `Spawn workers with: ~/.ftown/ftown-sessions create --shell claude|cursor|shell ` +
    `--parent --workdir <dir> --name <name> --prompt "<task>" — children are ` +
    `automatically briefed to report back to you via tell, and their reports arrive in ` +
    `your terminal as messages starting with [ftown msg from <name>]. Inspect any session ` +
    `with ~/.ftown/ftown-sessions list / screen <id> / grep <id> --pattern <re>, and ` +
    `message one with tell <id> "<text>".`
  );
}

export async function createFtownSession(
  deps: CreateFtownSessionDeps,
  input: CreateFtownSessionInput,
): Promise<Session> {
  const command = buildSessionCommand(input);
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

  const sessionId = uuidv4();
  const session: Session = {
    id: sessionId,
    name: input.name ?? (prompt || command).slice(0, 80),
    command,
    prompt: prompt || undefined,
    status: 'running',
    bridgeId: deps.bridgeId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workingDir: input.workingDir,
    shellType: input.shellType,
    model: input.model,
    claudeSessionId: input.claudeSessionId,
    cursorSessionId: input.cursorSessionId,
    env: input.env,
    parentSessionId,
    runtime: deps.runner.getPreferredRuntime(),
  };

  await deps.store.saveSession(session);
  await deps.centrifugo.publishSessionUpdate(deps.userId, session);

  registerSessionWorkspace(sessionId, input.workingDir);
  if (input.shellType === 'cursor' && input.workingDir) {
    installProjectCursorHooks(input.workingDir, deps.notifyScriptPath);
  }

  // Agent sessions (anything but a plain 'shell') spawned by a parent get a
  // one-paragraph briefing prepended to their first input so they know their
  // place in the session tree and how to talk to parent/siblings.
  const isAgent = input.shellType !== 'shell';
  const childBriefing =
    parentSessionId && parentName && isAgent
      ? buildChildBriefing({
          childName: session.name,
          childId: sessionId,
          parentName,
          parentId: parentSessionId,
        })
      : undefined;
  const orchestratorBriefing =
    input.orchestrator && isAgent
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

  deps.runner.run(sessionId, command, {
    workingDir: input.workingDir,
    env: input.env,
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
    env: env && typeof env === 'object' ? env : undefined,
    parentSessionId,
    initialInput: typeof body.initialInput === 'string' ? body.initialInput : undefined,
    initialInputDelay:
      typeof body.initialInputDelay === 'number' ? body.initialInputDelay : undefined,
    orchestrator: body.orchestrator === true,
  };
}
