import { randomUUID } from 'node:crypto';
import { normalizePullRequestUrl } from './pull-request-url.js';
import type { SessionStore } from './session-store.js';
import type { Session } from './types.js';
import type { PullRequestStatusService } from './pull-request-status.js';
import type { MailStore } from './mail-store.js';

type Timer = ReturnType<typeof setTimeout>;
interface Options {
  bridgeId: string;
  store: Pick<SessionStore, 'listSessions' | 'loadSession' | 'saveSession'>;
  withSessionMutation: (id: string, task: () => Promise<void>) => Promise<void>;
  statusService: Pick<PullRequestStatusService, 'getObservations' | 'setBackgroundUrls'>;
  mailStore: Pick<MailStore, 'commitPullRequestObservation'>;
  notifyCommitted: (session: Session, sender: string) => Promise<void>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => Timer;
  clearTimeout?: (timer: Timer) => void;
}
type Link = { id: string; url: string; key: string; linkId: string };
function canonical(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = normalizePullRequestUrl(value);
    return Number(url.slice(url.lastIndexOf('/') + 1)) <= 2_147_483_647 ? url : undefined;
  } catch { return undefined; }
}
function eligible(session: Session | null, bridgeId: string): session is Session {
  return !!session && session.bridgeId === bridgeId && session.shellType !== 'shell' && !!canonical(session.pullRequestUrl);
}

/** Polls only observed changes using the same cache and quota as dashboard reads. */
export class PullRequestEventWatcher {
  private stopped = false;
  private started = false;
  private epoch = 0;
  private flight?: Promise<void>;
  private timer?: Timer;
  private group: string[] = [];
  private baseline = new Map<string, number>();
  private cursor = '';
  private pendingWake = new Map<string, { key: string; linkId: string }>();
  private nextDelay = 60_000;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (timer: Timer) => void;
  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimeout ?? (timer => clearTimeout(timer));
  }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.runOnce().catch(error => console.error('[PR events] Scan failed:', error)).finally(() => this.schedule());
  }
  private schedule(): void {
    if (!this.started || this.stopped || this.timer) return;
    this.timer = this.setTimer(() => { this.timer = undefined; void this.runOnce().catch(error => console.error('[PR events] Scan failed:', error)).finally(() => this.schedule()); }, Math.max(60_000, this.nextDelay));
    this.timer.unref?.();
  }
  async stop(): Promise<void> {
    this.stopped = true; this.epoch++;
    if (this.timer) { this.clearTimer(this.timer); this.timer = undefined; }
    await this.flight?.catch(() => {});
    this.options.statusService.setBackgroundUrls([]);
  }
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.flight) return this.flight;
    const epoch = this.epoch;
    this.flight = this.scan(epoch).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async scan(epoch: number): Promise<void> {
    const { store, bridgeId, withSessionMutation, statusService, mailStore, notifyCommitted } = this.options;
    const active = () => !this.stopped && this.epoch === epoch;
    const links: Link[] = [];
    for (const candidate of await store.listSessions()) {
      if (!active()) return;
      if (!eligible(candidate, bridgeId)) continue;
      try {
        await withSessionMutation(candidate.id, async () => {
          if (!active()) return;
          const session = await store.loadSession(candidate.id);
          if (!eligible(session, bridgeId)) return;
          const url = canonical(session.pullRequestUrl)!;
          const linkId = session.pullRequestLinkId ?? randomUUID();
          if (!session.pullRequestLinkId) await store.saveSession({ ...session, pullRequestLinkId: linkId });
          links.push({ id: session.id, url, key: url.toLowerCase(), linkId });
        });
      } catch {
        // One damaged session must not prevent unrelated links from being scanned.
        console.error(`[PR events] Could not inspect session ${candidate.id}`);
      }
    }
    if (!active()) return;
    // A committed message survives a failed wake; retry without depending on a fresh gh result.
    for (const [id, pending] of this.pendingWake) {
      let sessionForWake: Session | undefined;
      await withSessionMutation(id, async () => {
        if (!active()) return;
        const session = await store.loadSession(id);
        if (eligible(session, bridgeId) && canonical(session.pullRequestUrl)?.toLowerCase() === pending.key && session.pullRequestLinkId === pending.linkId) sessionForWake = session;
      });
      if (!active()) return;
      if (!sessionForWake) { this.pendingWake.delete(id); continue; }
      try { await notifyCommitted(sessionForWake, 'FTown PR updates'); this.pendingWake.delete(id); } catch { /* Retry on the next scan. */ }
    }
    const urls = [...new Map(links.map(link => [link.key, link.url])).entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const keys = new Set(urls.map(([key]) => key));
    if (this.group.some(key => !keys.has(key))) { this.group = []; this.baseline.clear(); }
    if (!this.group.length && urls.length) {
      let start = urls.findIndex(([key]) => key > this.cursor);
      if (start < 0) start = 0;
      const selected = [...urls.slice(start), ...urls.slice(0, start)].slice(0, 20);
      this.group = selected.map(([key]) => key);
      // Capture attempt ordinals before pinning: a quota-blocked read must not advance the group.
      const before = await statusService.getObservations(selected.map(([, url]) => url));
      if (!active()) return;
      this.baseline = new Map(before.observations.map(item => [item.url.toLowerCase(), item.attempt]));
      statusService.setBackgroundUrls(selected.map(([, url]) => url));
    }
    if (!this.group.length) { statusService.setBackgroundUrls([]); this.nextDelay = 60_000; return; }
    const selectedUrls = this.group.map(key => urls.find(([entry]) => entry === key)?.[1]).filter((url): url is string => !!url);
    const result = await statusService.getObservations(selectedUrls);
    if (!active()) return;
    this.nextDelay = Math.max(60_000, Date.parse(result.nextRefreshAt) - this.now() || 60_000);
    const observed = new Map(result.observations.map(item => [item.url.toLowerCase(), item]));
    for (const link of links) {
      const observation = observed.get(link.key);
      if (!observation || observation.stale || observation.reason || !observation.checkedAt || !['in_progress', 'failed', 'passed', 'merged'].includes(observation.state)) continue;
      let sessionForWake: Session | undefined;
      let attemptingCommit = false;
      try {
        await withSessionMutation(link.id, async () => {
          if (!active()) return;
          const session = await store.loadSession(link.id);
          if (!eligible(session, bridgeId) || canonical(session.pullRequestUrl)?.toLowerCase() !== link.key || session.pullRequestLinkId !== link.linkId) return;
          attemptingCommit = true;
          await mailStore.commitPullRequestObservation(session.id, link.linkId, observation);
          if (active()) sessionForWake = session;
        });
      } catch {
        // A failed atomic commit may have renamed successfully before reporting an error.
        if (active() && attemptingCommit) this.pendingWake.set(link.id, { key: link.key, linkId: link.linkId });
        console.error(`[PR events] Could not commit observation for session ${link.id}`);
        continue;
      }
      if (active() && sessionForWake) {
        try { await notifyCommitted(sessionForWake, 'FTown PR updates'); this.pendingWake.delete(link.id); }
        catch { this.pendingWake.set(link.id, { key: link.key, linkId: link.linkId }); }
      }
    }
    if (this.group.every(key => { const observation = observed.get(key); return !!observation && ((!observation.stale && !!observation.checkedAt && !observation.reason) || observation.attempt !== (this.baseline.get(key) ?? 0)); })) {
      this.cursor = this.group.at(-1)!; this.group = []; this.baseline.clear(); statusService.setBackgroundUrls([]);
      // Keep discovering new links and rotating other groups at the shared quota cadence.
      this.nextDelay = 60_000;
    }
  }
}
