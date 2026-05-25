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

export async function createFtownSession(
  deps: CreateFtownSessionDeps,
  input: CreateFtownSessionInput,
): Promise<Session> {
  const command = buildSessionCommand(input);
  const prompt = input.prompt?.trim() ?? '';

  let parentSessionId: string | undefined;
  if (input.parentSessionId) {
    parentSessionId = await resolveParentSessionId(deps.store, input.parentSessionId);
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
  };

  await deps.store.saveSession(session);
  await deps.centrifugo.publishSessionUpdate(deps.userId, session);

  registerSessionWorkspace(sessionId, input.workingDir);
  if (input.shellType === 'cursor' && input.workingDir) {
    installProjectCursorHooks(input.workingDir, deps.notifyScriptPath);
  }

  const initialInput =
    input.initialInput ?? (prompt ? `${prompt}\r` : undefined);
  const initialInputDelay = input.initialInputDelay ?? (prompt ? 2000 : undefined);

  deps.runner.run(sessionId, command, {
    workingDir: input.workingDir,
    env: input.env,
    initialInput,
    initialInputDelay,
    hookPort: deps.hookPort,
    hookToken: deps.hookToken,
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
  };
}
