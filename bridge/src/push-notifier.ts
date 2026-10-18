export interface PushNotice {
  kind: 'question' | 'idle'; eventKey: string; title: string; message: string; occurredAt: string;
}
export interface BridgePushNotifierOptions {
  apiUrl: string; bridgeId: string;
  getToken: () => string | Promise<string>;
  getSession: (id: string) => Promise<{ name: string; shellType?: string } | null | undefined>;
}
interface Pending { sessionId: string; notice: PushNotice; expires: number; attempt: number }
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
  private controller?: AbortController;
  constructor(private options: BridgePushNotifierOptions, private deps: Dependencies = defaults) {}
  notify(sessionId: string, notice: PushNotice): void {
    if (this.stopped || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) return;
    const key = `${sessionId}:${notice.eventKey}`;
    if (this.queue.has(key) || this.queue.size >= 100) return;
    this.queue.set(key, { sessionId, notice, expires: this.deps.now() + 300_000, attempt: 0 });
    if (!this.running && !this.timer) void this.drain();
  }
  stop(): void {
    this.stopped = true;
    this.queue.clear();
    if (this.timer) this.deps.cancel(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }
  private async drain(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      while (this.queue.size && !this.stopped) {
        const [key, item] = this.queue.entries().next().value!;
        if (this.deps.now() >= item.expires) { this.queue.delete(key); continue; }
        let transient = false;
        try {
          const session = await this.options.getSession(item.sessionId);
          if (!session || session.shellType === 'shell' || this.stopped) { this.queue.delete(key); continue; }
          const token = await this.options.getToken();
          if (this.stopped) return;
          if (this.deps.now() >= item.expires) { this.queue.delete(key); continue; }
          this.controller = new AbortController();
          const timeout = this.deps.schedule(() => this.controller?.abort(), Math.min(10_000, item.expires - this.deps.now()));
          try {
            const response = await this.deps.fetch(`${this.options.apiUrl.replace(/\/$/, '')}/api/push/events`, {
              method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ ...item.notice, bridgeId: this.options.bridgeId, sessionId: item.sessionId, sessionName: session.name }),
              signal: this.controller.signal,
            });
            transient = response.status === 408 || response.status === 429 || response.status >= 500;
          } finally { this.deps.cancel(timeout); this.controller = undefined; }
        } catch { transient = true; }
        if (!transient || this.stopped || this.deps.now() >= item.expires) { this.queue.delete(key); continue; }
        const wait = Math.min([5_000, 15_000, 60_000][Math.min(item.attempt++, 2)], item.expires - this.deps.now());
        this.timer = this.deps.schedule(() => { this.timer = undefined; void this.drain(); }, wait);
        return;
      }
    } finally { this.running = false; }
  }
}
