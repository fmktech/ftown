import type { Command, CommandResponse } from '@/types';
import type { MessageClient, MessageEvents, MessageSubscription, MessagePublishOptions } from './message-client';
import type { BridgeSecurityInfo, LocalEventPage, SecurityCommand, SecurityCommandResults } from '@security/protocol';
import { SecurityError } from '@security/crypto';
import { SecureEndpointRuntime } from './secure-endpoint-runtime';

export interface BrowserBootstrap extends BridgeSecurityInfo {
  version: 1; userId: string; hostname: string; localPort: number;
  /** Legacy structural compatibility; no authorization value. */
  localNonce?: string;
}
export interface LocalDevice { port: number; bridgeId: string; credential?: string }
export interface Pairing { id: string; code: string; pollToken: string; expiresAt: string }
export class LocalAccessError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export function localOrigin(port: string | number): string {
  if (!/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Enter the local bridge port.');
  return `http://127.0.0.1:${Number(port)}`;
}
export async function localRequest<T>(port: number, path: string, _credential?: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  if (!path.startsWith('/api/security/')) throw new LocalAccessError('Upgrade required: plaintext browser commands are disabled.', 426);
  const response = await fetch(`${localOrigin(port)}${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000) });
  if (!response.ok) throw new LocalAccessError('Encrypted local bridge request failed.', response.status);
  return await response.json() as T;
}
export async function bootstrapLocal(device: LocalDevice, signal?: AbortSignal): Promise<BrowserBootstrap> {
  const info = await localRequest<BridgeSecurityInfo>(device.port, '/api/security/info', undefined, undefined, signal);
  if (info.protocolVersion !== 1 || !info.bridgeId || !info.ownerId || !info.relayUserId || info.endpoint?.kind !== 'bridge') throw new LocalAccessError('Upgrade this bridge for encrypted access.', 426);
  if (device.bridgeId && device.bridgeId !== info.bridgeId) throw new LocalAccessError('A different bridge is using this port. Verify a fresh invitation.', 401);
  return { ...info, version: 1, userId: info.relayUserId, hostname: info.bridgeId, localPort: device.port };
}
const SELECTED = 'ftown:local:port';
const key = (port: number) => `ftown:local:device:${port}`;
export function rememberDevice(device: LocalDevice, remember: boolean): void {
  localOrigin(device.port); forgetDevice(device.port);
  const storage = remember ? localStorage : sessionStorage;
  storage.setItem(key(device.port), JSON.stringify({ port: device.port, bridgeId: device.bridgeId })); storage.setItem(SELECTED, String(device.port));
}
export function readDevice(selectedPort?: number): LocalDevice | null {
  for (const storage of [sessionStorage, localStorage]) try {
    const port = selectedPort === undefined ? storage.getItem(SELECTED) : String(selectedPort);
    if (!port) continue; localOrigin(port);
    const data = JSON.parse(storage.getItem(key(Number(port))) ?? 'null') as LocalDevice | null;
    if (data?.port === Number(port) && typeof data.bridgeId === 'string' && data.bridgeId) return { port: data.port, bridgeId: data.bridgeId };
  } catch { /* Discovery metadata is optional and never grants authorization. */ }
  return null;
}
export function forgetDevice(port: number): void {
  for (const storage of [sessionStorage, localStorage]) { storage.removeItem(key(port)); if (storage.getItem(SELECTED) === String(port)) storage.removeItem(SELECTED); }
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
  async publish(data: unknown, options?: MessagePublishOptions): Promise<void> {
    if (this.channel !== `commands:rpc#${this.owner.boot.userId}`) throw new Error('Local terminals require a direct connection.');
    const command = data as Command;
    let response: CommandResponse;
    try {
      response = await this.owner.command(command, options);
    } catch (error) {
      // Resolve the shared RPC immediately with an explicit failure, never retry
      // a mutation whose request might already have reached the controller.
      response = { requestId: command.requestId, success: false,
        error: `${error instanceof Error ? error.message : 'Local request failed'}. Delivery may be uncertain; refresh before retrying.` };
    }
    this.owner.deliver(this.channel, { type: 'command_response', response });
  }
}

/** Encrypted local commands/events adapted to the shared dashboard hooks. */
export class LocalBrowserClient implements MessageClient {
  readonly commandTimeoutMs = 40_000;
  private subscriptions = new Map<string, LocalSubscription>();
  private abort = new AbortController();
  private cursor = 0;
  private online = false;
  private running = false;
  private handshake: Promise<void> | null = null;
  constructor(readonly device: LocalDevice, readonly boot: BrowserBootstrap,
    private status: (connected: boolean, error?: string) => void,
    private unauthorized: () => void,
    private bootstrapChanged?: () => void,
    readonly securityRuntime?: SecureEndpointRuntime) {}
  get sessionSnapshotBridgeId(): string { return this.boot.bridgeId; }
  newSubscription(channel: string): LocalSubscription {
    if (this.subscriptions.has(channel)) throw new Error(`Duplicate subscription: ${channel}`);
    const sub = new LocalSubscription(channel, this); this.subscriptions.set(channel, sub); return sub;
  }
  getSubscription(channel: string): LocalSubscription | null { return this.subscriptions.get(channel) ?? null; }
  removeSubscription(sub: { subscribe(): void } | null): void { for (const [channel, existing] of this.subscriptions) if (existing === sub) this.subscriptions.delete(channel); }
  presence() { return { clients: this.online ? { [this.boot.bridgeId]: { connInfo: { bridgeId: this.boot.bridgeId, hostname: this.boot.hostname, connectedAt: '', localPort: this.device.port } } } : {} }; }
  deliver(channel: string, data: unknown): void {
    if (this.abort.signal.aborted || !channel.endsWith(`#${this.boot.userId}`)) return;
    const sub = this.subscriptions.get(channel);
    if (sub?.state === 'subscribed') sub.emit('publication', { data, info: { user: this.boot.userId } });
  }
  private transmit = (channel: string, path: string, options?: MessagePublishOptions) => async (packet: import('@security/protocol').SecureEnvelope | import('@security/protocol').EnrollmentPacket): Promise<void> => {
    this.admit(options);
    const remaining = (options?.deadline ?? Date.now() + this.commandTimeoutMs) - Date.now();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(Math.max(1, remaining)), ...(options?.signal ? [options.signal] : [])]);
    const reply = await localRequest<unknown>(this.device.port, path, undefined, packet, signal);
    await this.securityRuntime!.receive(reply, channel);
  };
  private admit(options?: MessagePublishOptions): void {
    if (this.abort.signal.aborted || options?.signal?.aborted || (options?.deadline !== undefined && (!Number.isFinite(options.deadline) || Date.now() >= options.deadline))) {
      throw new SecurityError('expired', 'Encrypted request expired or was cancelled before publication');
    }
  }
  private ensureReady(): Promise<void> {
    if (!this.securityRuntime) return Promise.reject(new SecurityError('upgrade_required', 'Encrypted browser identity is required'));
    if (this.securityRuntime.state(this.boot.bridgeId).status === 'ready') return Promise.resolve();
    if (!this.handshake) this.handshake = this.securityRuntime.handshake(this.boot.bridgeId, `local-http:${this.boot.bridgeId}`,
      this.transmit(`local-http:${this.boot.bridgeId}`, '/api/security/envelope')).finally(() => { this.handshake = null; });
    return this.handshake;
  }
  async command(command: Command, options: MessagePublishOptions = { deadline: Date.now() + this.commandTimeoutMs }): Promise<CommandResponse> {
    try {
      this.admit(options);
      await this.ensureReady();
      this.admit(options);
      const channel = `local-http:${this.boot.bridgeId}`;
      const reply = await this.securityRuntime!.request(this.boot.bridgeId, channel,
        { kind: 'command', requestId: command.requestId, command: command.type, sessionId: 'sessionId' in command.payload ? String(command.payload.sessionId) : null },
        { ...command, payload: { ...command.payload, bridgeId: this.boot.bridgeId } }, this.transmit(channel, '/api/security/envelope', options));
      if (reply && typeof reply === 'object' && !Array.isArray(reply) && reply.type === 'command_response' && reply.response) return reply.response as unknown as CommandResponse;
      if (reply && typeof reply === 'object' && !Array.isArray(reply) && typeof reply.status === 'number' && reply.status >= 400
        && reply.body && typeof reply.body === 'object' && !Array.isArray(reply.body) && reply.body.code === 'epoch_changed') throw new SecurityError('epoch_changed', 'Bridge restarted; refresh encrypted state before trying a new action');
      throw new SecurityError('permission_denied', 'Encrypted local command was rejected');
    } catch (error) { this.handleError(error); throw error; }
  }
  executeSecurity = <C extends SecurityCommand>(command: C): Promise<SecurityCommandResults[C['type']]> => this.securityRuntime!.command(command, value => this.command(value as Command));
  private handleError(error: unknown): void {
    if (this.abort.signal.aborted) return;
    this.online = false; this.securityRuntime?.disconnected(this.boot.bridgeId); this.status(false, 'Encrypted local bridge is unavailable.');
    if (error instanceof SecurityError && ['endpoint_revoked', 'key_changed', 'approval_required'].includes(error.code)) { this.close(); this.unauthorized(); }
  }
  start(): void { if (!this.running) { this.running = true; void this.poll(); } }
  private async poll(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.ensureReady();
        const recovered = !this.online; this.online = true; this.status(true);
        if (recovered) for (const sub of this.subscriptions.values()) if (sub.state === 'subscribed') sub.emit('subscribed', undefined);
        const channel = `local-events:${this.boot.bridgeId}`;
        const result = await this.securityRuntime!.request(this.boot.bridgeId, channel,
          { kind: 'http', requestId: crypto.randomUUID(), method: 'GET', path: `/api/browser/events?after=${this.cursor}` }, {},
          this.transmit(channel, '/api/security/events')) as unknown as LocalEventPage;
        if (this.abort.signal.aborted) return;
        if (!Array.isArray(result.events) || !Number.isSafeInteger(result.cursor)) throw new Error('Invalid local event page');
        this.cursor = result.cursor;
        for (const event of result.events) this.deliver(event.channel, event.data);
        if (result.reset) for (const sub of this.subscriptions.values()) if (sub.state === 'subscribed') sub.emit('subscribed', undefined);
      } catch (error) {
        this.handleError(error);
        if (this.abort.signal.aborted) return;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, 2000); this.abort.signal.addEventListener('abort', done, { once: true });
        });
      }
    }
  }
  close(): void { this.abort.abort(); this.subscriptions.clear(); }
}
