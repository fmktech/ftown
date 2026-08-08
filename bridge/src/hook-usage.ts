import type { HookEvent } from './local-api-server.js';
import type { SessionStore } from './session-store.js';
import type { ModelUsage, Session, SessionUsage } from './types.js';

export interface HookUsagePersisterDeps {
  store: Pick<SessionStore, 'loadSession' | 'saveSession'>;
  publishSessionUpdate: (session: Session) => Promise<void>;
  now?: () => Date;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function modelUsage(value: unknown): ModelUsage | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== 'string' || !raw.model) return null;
  return {
    model: raw.model,
    inputTokens: tokenCount(raw.inputTokens),
    outputTokens: tokenCount(raw.outputTokens),
    cacheReadTokens: tokenCount(raw.cacheReadTokens),
    cacheWriteTokens: tokenCount(raw.cacheWriteTokens),
  };
}

/** Persist cumulative usage emitted by authenticated harness extensions. */
export class HookUsagePersister {
  private readonly now: () => Date;

  constructor(private readonly deps: HookUsagePersisterDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async persist(hookEvent: HookEvent): Promise<SessionUsage | undefined> {
    if (hookEvent.eventName !== 'Stop' || hookEvent.source === 'workspace') return undefined;
    const raw = hookEvent.data.usage;
    if (!raw || typeof raw !== 'object') return undefined;
    const session = await this.deps.store.loadSession(hookEvent.sessionId);
    if (!session || session.shellType !== 'pi') return undefined;

    const record = raw as Record<string, unknown>;
    const perModel = Array.isArray(record.perModel)
      ? record.perModel.map(modelUsage).filter((value): value is ModelUsage => value !== null)
      : [];
    const inputTokens = tokenCount(record.inputTokens);
    const outputTokens = tokenCount(record.outputTokens);
    const cacheReadTokens = tokenCount(record.cacheReadTokens);
    const cacheWriteTokens = tokenCount(record.cacheWriteTokens);
    const models = perModel.length > 0
      ? perModel.map((item) => item.model)
      : Array.isArray(record.models)
        ? record.models.filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [];
    const usage: SessionUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      models,
      ...(perModel.length > 0 ? { perModel } : {}),
      harness: 'pi',
      collectedAt: this.now().toISOString(),
    };
    session.usage = usage;
    await this.deps.store.saveSession(session);
    await this.deps.publishSessionUpdate(session);
    return usage;
  }
}
