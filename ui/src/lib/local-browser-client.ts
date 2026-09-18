import type { Command, CommandResponse } from '@/types';
import type { MessageClient, MessageEvents, MessageSubscription } from './message-client';

export interface BrowserBootstrap {
  version: 1; userId: string; bridgeId: string; hostname: string;
  localPort: number; localNonce: string;
}
export interface LocalDevice { port: number; bridgeId: string; credential: string }
export interface Pairing { id: string; code: string; pollToken: string; expiresAt: string }
export class LocalAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export function localOrigin(port: string | number): string {
  if (!/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('Enter the local port printed by ftown-bridge pair.');
  }
  return `http://127.0.0.1:${Number(port)}`;
}

/** Never follows redirects or sends browser cookies/credentials to hosted APIs. */
export async function localRequest<T>(port: number, path: string, credential?: string,
  body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!path.startsWith('/api/browser/')) throw new Error('Invalid local API path');
  const timeout = path === '/api/browser/commands' ? 35_000 : 25_000;
  const response = await fetch(`${localOrigin(port)}${path}`, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
  });
  const data = await response.json();
  if (!response.ok) throw new LocalAccessError(data.error ?? `Local bridge returned ${response.status}`, response.status);
  return data as T;
}

export async function bootstrapLocal(device: LocalDevice, signal?: AbortSignal): Promise<BrowserBootstrap> {
  const boot = await localRequest<BrowserBootstrap>(device.port, '/api/browser/bootstrap', device.credential, {}, signal);
  if (boot.version !== 1 || typeof boot.bridgeId !== 'string' || !boot.bridgeId ||
    typeof boot.userId !== 'string' || !boot.userId || typeof boot.hostname !== 'string' ||
    boot.localNonce !== device.credential) throw new Error('Invalid local bridge response.');
  localOrigin(boot.localPort);
  if (device.bridgeId && device.bridgeId !== boot.bridgeId) {
    throw new LocalAccessError('A different bridge is using this port. Pair again.', 401);
  }
  return boot;
}

const SELECTED = 'ftown:local:port';
const key = (port: number) => `ftown:local:device:${port}`;
export function rememberDevice(device: LocalDevice, remember: boolean): void {
  localOrigin(device.port);
  forgetDevice(device.port);
  const storage = remember ? localStorage : sessionStorage;
  storage.setItem(key(device.port), JSON.stringify(device));
  storage.setItem(SELECTED, String(device.port));
}
export function readDevice(selectedPort?: number): LocalDevice | null {
  for (const storage of [sessionStorage, localStorage]) {
    try {
      const port = selectedPort === undefined ? storage.getItem(SELECTED) : String(selectedPort);
      if (!port) continue;
      localOrigin(port);
      const data = JSON.parse(storage.getItem(key(Number(port))) ?? 'null') as LocalDevice | null;
      if (data && data.port === Number(port) && typeof data.credential === 'string' && data.credential &&
        typeof data.bridgeId === 'string' && data.bridgeId) return data;
    } catch { /* Unavailable or malformed browser storage is not authorization. */ }
  }
  return null;
}
export function forgetDevice(port: number): void {
  for (const storage of [sessionStorage, localStorage]) {
    storage.removeItem(key(port));
    if (storage.getItem(SELECTED) === String(port)) storage.removeItem(SELECTED);
  }
}

class LocalSubscription implements MessageSubscription {
  state = 'unsubscribed';
  private listeners = new Map<keyof MessageEvents, Set<(ctx: never) => void>>();
  constructor(readonly channel: string, private owner: LocalBrowserClient) {}
  on<E extends keyof MessageEvents>(event: E, listener: (ctx: MessageEvents[E]) => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (ctx: never) => void); this.listeners.set(event, set); return this;
  }
  off<E extends keyof MessageEvents>(event: E, listener: (ctx: MessageEvents[E]) => void): this {
    this.listeners.get(event)?.delete(listener as (ctx: never) => void); return this;
  }
  emit<E extends keyof MessageEvents>(event: E, data: MessageEvents[E]): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data as never);
  }
  subscribe(): void {
    if (this.state === 'subscribed') return;
    this.state = 'subscribed'; queueMicrotask(() => { if (this.state === 'subscribed') this.emit('subscribed', undefined); });
  }
  unsubscribe(): void { this.state = 'unsubscribed'; }
  removeAllListeners(): void { this.listeners.clear(); }
  presence() { return Promise.resolve(this.owner.presence()); }
  async publish(data: unknown): Promise<void> {
    if (this.channel !== `commands:rpc#${this.owner.boot.userId}`) throw new Error('Local terminals require a direct connection.');
    const command = data as Command;
    let response: CommandResponse;
    try {
      response = await this.owner.command(command);
    } catch (error) {
      // Resolve the shared RPC immediately with an explicit failure, never retry
      // a mutation whose request might already have reached the controller.
      response = { requestId: command.requestId, success: false,
        error: `${error instanceof Error ? error.message : 'Local request failed'}. Delivery may be uncertain; refresh before retrying.` };
    }
    this.owner.deliver(this.channel, { type: 'command_response', response });
  }
}

/** Adapts authenticated local HTTP commands/events to existing dashboard hooks. */
export class LocalBrowserClient implements MessageClient {
  readonly commandTimeoutMs = 40_000;
  private subscriptions = new Map<string, LocalSubscription>();
  private abort = new AbortController();
  private cursor = 0;
  private lastBootstrapCheck = Date.now();
  private online = true;
  private running = false;
  constructor(readonly device: LocalDevice, readonly boot: BrowserBootstrap,
    private status: (connected: boolean, error?: string) => void,
    private unauthorized: () => void,
    private bootstrapChanged?: () => void) {}
  get sessionSnapshotBridgeId(): string { return this.boot.bridgeId; }
  newSubscription(channel: string): LocalSubscription {
    if (this.subscriptions.has(channel)) throw new Error(`Duplicate subscription: ${channel}`);
    const sub = new LocalSubscription(channel, this); this.subscriptions.set(channel, sub); return sub;
  }
  getSubscription(channel: string): LocalSubscription | null { return this.subscriptions.get(channel) ?? null; }
  removeSubscription(sub: { subscribe(): void } | null): void {
    for (const [channel, existing] of this.subscriptions) if (existing === sub) this.subscriptions.delete(channel);
  }
  presence() {
    return { clients: this.online ? { [this.boot.bridgeId]: { connInfo: { bridgeId: this.boot.bridgeId, hostname: this.boot.hostname, connectedAt: '' } } } : {} };
  }
  deliver(channel: string, data: unknown): void {
    const sub = this.subscriptions.get(channel);
    if (sub?.state === 'subscribed') sub.emit('publication', { data, info: { user: this.boot.userId } });
  }
  async command(command: Command): Promise<CommandResponse> {
    try {
      return await localRequest(this.device.port, '/api/browser/commands', this.device.credential, command, this.abort.signal);
    } catch (error) { this.handleError(error); throw error; }
  }
  private handleError(error: unknown): void {
    if (this.abort.signal.aborted) return;
    this.online = false;
    this.status(false, error instanceof Error ? error.message : 'Local bridge unreachable');
    if (error instanceof LocalAccessError && (error.status === 401 || error.status === 403)) {
      this.close(); this.unauthorized();
    }
  }
  start(): void { if (!this.running) { this.running = true; void this.poll(); } }
  private async poll(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        const result = await localRequest<{ cursor: number; reset: boolean; events: { channel: string; data: unknown }[] }>(
          this.device.port, `/api/browser/events?cursor=${this.cursor}`, this.device.credential, undefined, this.abort.signal);
        if (this.abort.signal.aborted) return;
        const recovered = !this.online;
        if (recovered || result.reset || Date.now() - this.lastBootstrapCheck >= 10_000) {
          const refreshed = await bootstrapLocal(this.device, this.abort.signal);
          this.lastBootstrapCheck = Date.now();
          if (this.abort.signal.aborted) return;
          if (refreshed.userId !== this.boot.userId || refreshed.localPort !== this.boot.localPort) {
            this.close(); this.bootstrapChanged?.(); return;
          }
        }
        this.online = true; this.status(true);
        this.cursor = result.cursor;
        for (const event of result.events) this.deliver(event.channel, event.data);
        if (result.reset || recovered) {
          // Existing hooks refresh authoritative sessions/loops on subscribe.
          for (const sub of this.subscriptions.values()) if (sub.state === 'subscribed') sub.emit('subscribed', undefined);
        }
      } catch (error) {
        this.handleError(error);
        if (this.abort.signal.aborted) return;
        await new Promise<void>((resolve) => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 2000); this.abort.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  close(): void { this.abort.abort(); this.subscriptions.clear(); }
}
