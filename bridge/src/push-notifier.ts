export interface PushNotice {
  kind: 'question' | 'idle'; eventKey: string; title: string; message: string; occurredAt: string;
}
export interface BridgePushNotifierOptions {
  apiUrl: string; bridgeId: string;
  getToken: () => string | Promise<string>;
  getSession: (id: string) => Promise<{ name: string; shellType?: string; status?: string } | null | undefined>;
}
interface Pending { sessionId: string; notice: PushNotice; expires: number; attempt: number; nextAttemptAt: number; canceled: boolean }
interface Dependencies {
  fetch: typeof fetch; now: () => number;
  schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel: (timer: ReturnType<typeof setTimeout>) => void;
}
const defaults: Dependencies = { fetch: (...args) => fetch(...args), now: Date.now,
  schedule: (fn, ms) => setTimeout(fn, ms), cancel: clearTimeout };
/** A bounded, best-effort queue. Cloud event/delivery keys provide durable dedup. */
export class BridgePushNotifier {
  private queue = new Map<string, Pending>();
  private running = false;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inflight?: { item: Pending; controller: AbortController };
  constructor(private options: BridgePushNotifierOptions, private deps: Dependencies = defaults) {}
  notify(sessionId: string, notice: PushNotice): void {
    if (this.stopped || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
    const key = `${sessionId}:${notice.eventKey}`;
    if (this.queue.has(key) || this.queue.size >= 100) return;
    this.queue.set(key, { sessionId, notice, expires: this.deps.now() + 300_000, attempt: 0, nextAttemptAt: this.deps.now(), canceled: false });
    this.wake();
  }
  cancelIdle(sessionId: string): void {
    for (const [key, item] of this.queue) {
      if (item.sessionId !== sessionId || item.notice.kind !== 'idle') continue;
      item.canceled = true;
      this.queue.delete(key);
      if (this.inflight?.item === item) this.inflight.controller.abort();
    }
    this.wake();
  }
  stop(): void {
    this.stopped = true;
    for (const item of this.queue.values()) item.canceled = true;
    this.queue.clear();
    if (this.timer) this.deps.cancel(this.timer);
    this.timer = undefined;
    this.inflight?.controller.abort();
  }
  private wake(): void {
    if (this.stopped || this.running) return;
    if (this.timer) this.deps.cancel(this.timer);
    this.timer = undefined;
    void this.drain();
  }
  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.queue.size && !this.stopped) {
        for (const [key, item] of this.queue) if (this.deps.now() >= item.expires) this.queue.delete(key);
        if (!this.queue.size) return;
        const entry = Array.from(this.queue.entries()).find(([, item]) => item.nextAttemptAt <= this.deps.now());
        if (!entry) {
          const next = Math.min(...Array.from(this.queue.values(), (item) => Math.min(item.nextAttemptAt, item.expires)));
          this.timer = this.deps.schedule(() => { this.timer = undefined; void this.drain(); }, Math.max(0, next - this.deps.now()));
          return;
        }
        const [key, item] = entry;
        const current = () => !this.stopped && !item.canceled && this.queue.get(key) === item;
        let transient = false;
        try {
          const session = await this.options.getSession(item.sessionId);
          if (!current()) continue;
          if (!session || session.shellType === 'shell' || (session.status !== undefined && session.status !== 'running')) { this.queue.delete(key); continue; }
          const token = await this.options.getToken();
          if (!current()) continue;
          if (this.deps.now() >= item.expires) { this.queue.delete(key); continue; }
          const controller = new AbortController();
          this.inflight = { item, controller };
          const timeout = this.deps.schedule(() => controller.abort(), Math.min(10_000, item.expires - this.deps.now()));
          try {
            if (!current()) continue;
            const response = await this.deps.fetch(`${this.options.apiUrl.replace(/\/$/, '')}/api/push/events`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ ...item.notice, bridgeId: this.options.bridgeId, sessionId: item.sessionId, sessionName: session.name }),
              signal: controller.signal,
            });
            transient = response.status === 408 || response.status === 429 || response.status >= 500;
          } finally {
            this.deps.cancel(timeout);
            if (this.inflight?.item === item) this.inflight = undefined;
          }
        } catch { transient = true; }
        if (!current()) continue;
        if (!transient || this.deps.now() >= item.expires) { this.queue.delete(key); continue; }
        const wait = Math.min([5_000, 15_000, 60_000][Math.min(item.attempt++, 2)], item.expires - this.deps.now());
        item.nextAttemptAt = this.deps.now() + wait;
      }
    } finally { this.running = false; }
  }
}
