import type { Centrifuge, Subscription } from "centrifuge";
import type { ApplicationRoute, EndpointDirectory, SecureApplication, SecurityCommand, SecurityCommandResults } from "@security/protocol";
import { SecurityError } from "@security/crypto";
import type { MessageClient, MessageEvents, MessageSubscription, MessagePublishOptions } from "./message-client";
import { applicationJson, SecureEndpointRuntime } from "./secure-endpoint-runtime";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
type Listener = (context: never) => void;

class SecureSubscription implements MessageSubscription {
  private listeners = new Map<keyof MessageEvents, Set<Listener>>();
  private queue: Promise<void> = Promise.resolve();
  private receiving = (context: { data: unknown }) => {
    this.queue = this.queue.then(async () => {
      for (const value of await this.owner.securityRuntime.receive(context.data, this.channel)) {
        if (value.application.route.kind === "response" && record(value.application.data) && typeof value.application.data.status === "number" && value.application.data.status >= 400) {
          const body = record(value.application.data.body) ? value.application.data.body : {};
          value.application.data = applicationJson({ type: "command_response", response: { requestId: value.application.route.requestId, success: false,
            error: "Encrypted request rejected", data: { code: typeof body.code === "string" ? body.code : "permission_denied" } } });
        }
        if (!this.owner.observe(value.bridgeId, value.application)) continue;
        this.emit("publication", { data: value.application.data, info: { user: this.owner.userId } });
      }
    }).catch(() => { /* Unauthenticated/plaintext packets never reach domain handlers. */ });
  };
  private subscribed = () => this.emit("subscribed", undefined);
  private joined = (context: MessageEvents["join"]) => this.emit("join", context);
  private left = (context: MessageEvents["leave"]) => this.emit("leave", context);
  constructor(readonly channel: string, readonly raw: Subscription, private owner: SecureMessageClient) {
    raw.on("publication", this.receiving);
    raw.on("subscribed", this.subscribed);
    raw.on("join", this.joined); raw.on("leave", this.left);
  }
  get state(): string { return this.raw.state; }
  subscribe(): void { this.raw.subscribe(); }
  unsubscribe(): void { this.raw.unsubscribe(); }
  publish(data: unknown, options?: MessagePublishOptions): Promise<unknown> { return this.owner.publish(this.channel, data, options); }
  presence() { return this.raw.presence(); }
  on<E extends keyof MessageEvents>(event: E, listener: (ctx: MessageEvents[E]) => void): this {
    const listeners = this.listeners.get(event) ?? new Set<Listener>(); listeners.add(listener as Listener); this.listeners.set(event, listeners); return this;
  }
  off<E extends keyof MessageEvents>(event: E, listener: (ctx: MessageEvents[E]) => void): this { this.listeners.get(event)?.delete(listener as Listener); return this; }
  emit<E extends keyof MessageEvents>(event: E, value: MessageEvents[E]): void { for (const listener of this.listeners.get(event) ?? []) listener(value as never); }
  removeAllListeners(): void { this.listeners.clear(); }
  destroy(): void {
    this.listeners.clear(); this.raw.off("publication", this.receiving); this.raw.off("subscribed", this.subscribed);
    this.raw.off("join", this.joined); this.raw.off("leave", this.left);
  }
}

/** The raw broker is private to this adapter, including signaling and terminal I/O. */
export class SecureMessageClient implements MessageClient {
  readonly commandTimeoutMs = 40_000;
  private subscriptions = new Map<string, SecureSubscription>();
  private sessionOwners = new Map<string, string>();
  private handshakes = new Map<string, Promise<void>>();
  private outbound = new Map<string, Promise<unknown>>();
  private abort = new AbortController();
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  private expectations = new Map<string, { bridgeIds: Set<string>; expiresAt: number }>();
  private generation = 0;
  private closed = false;
  private recovering = new Set<string>();
  constructor(private raw: Centrifuge, readonly userId: string, readonly securityRuntime: SecureEndpointRuntime) {
    const commands = this.newSubscription(`commands:rpc#${userId}`);
    commands.subscribe();
    raw.on("connected", this.connected);
    raw.on("disconnected", this.disconnected);
  }
  private connected = () => {
    for (const pin of this.securityRuntime.pinnedBridges()) void this.ensureReady(pin.bridgeId, true).catch(() => {});
    void fetch("/api/security/endpoints", { credentials: "include", cache: "no-store", signal: this.abort.signal })
      .then(async response => {
        if (!response.ok) return;
        const directory = await response.json() as EndpointDirectory;
        if (directory.ownerId !== this.securityRuntime.ownerId) return;
        for (const entry of directory.endpoints) if (entry.bridgeId && entry.endpoint.kind === "bridge") this.securityRuntime.discover(entry.bridgeId, entry.endpoint);
      }).catch(() => {});
  };
  private disconnected = () => { this.generation++; this.handshakes.clear(); this.securityRuntime.disconnected(); };
  newSubscription(channel: string, options?: { since: { offset: number; epoch: string } }): SecureSubscription {
    if (this.subscriptions.has(channel)) throw new Error(`Duplicate subscription: ${channel}`);
    const raw = this.raw.getSubscription(channel) ?? this.raw.newSubscription(channel, options);
    const sub = new SecureSubscription(channel, raw, this); this.subscriptions.set(channel, sub); return sub;
  }
  getSubscription(channel: string): SecureSubscription | null { return this.subscriptions.get(channel) ?? null; }
  removeSubscription(sub: MessageSubscription | null): void {
    for (const [channel, existing] of this.subscriptions) if (existing === sub) {
      existing.destroy(); this.raw.removeSubscription(existing.raw); this.subscriptions.delete(channel);
    }
  }
  async ensureReady(bridgeId: string, force = false): Promise<void> {
    if (!force && this.securityRuntime.state(bridgeId).status === "ready") return;
    let pending = this.handshakes.get(bridgeId);
    if (!pending) {
      const generation = this.generation;
      pending = this.securityRuntime.handshake(bridgeId, `commands:rpc#${this.userId}`, async packet => {
        if (this.closed || generation !== this.generation) throw new SecurityError("bridge_offline", "Encrypted connection changed");
        await this.raw.publish(`commands:rpc#${this.userId}`, packet);
      }).then(() => {
        if (generation !== this.generation) throw new SecurityError("bridge_offline", "Connection changed during handshake");
      }).finally(() => { if (this.handshakes.get(bridgeId) === pending) this.handshakes.delete(bridgeId); });
      this.handshakes.set(bridgeId, pending);
    }
    return pending;
  }
  private targets(value: unknown, channel: string): string[] {
    if (!record(value)) throw new SecurityError("invalid_envelope", "Invalid application command");
    const payload = record(value.payload) ? value.payload : value;
    const explicit = typeof payload.bridgeId === "string" ? payload.bridgeId : typeof value.bridgeId === "string" ? value.bridgeId : null;
    if (explicit) return [explicit];
    const terminal = /^(?:terminal|terminal-input|events|stream):([^#]+)#/.exec(channel);
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : terminal?.[1];
    if (sessionId) {
      const bridgeId = this.sessionOwners.get(sessionId);
      if (!bridgeId) throw new SecurityError("approval_required", "Refresh the authoritative session list before targeting this session");
      return [bridgeId];
    }
    if (value.type === "list_sessions") return this.securityRuntime.pinnedBridges().filter(pin => !["revoked", "key_changed"].includes(this.securityRuntime.state(pin.bridgeId).status)).map(pin => pin.bridgeId);
    throw new SecurityError("wrong_context", "Select an approved bridge before issuing this command");
  }
  publish(channel: string, input: unknown, options: MessagePublishOptions = {}): Promise<unknown> {
    try {
      const value = applicationJson(input);
      const targets = this.targets(value, channel);
      if (!targets.length) throw new SecurityError("approval_required", "No approved bridge is available");
      const generation = this.generation;
      const deadline = Math.min(options.deadline ?? Date.now() + this.commandTimeoutMs, Date.now() + this.commandTimeoutMs);
      const admit = () => {
        if (this.closed || generation !== this.generation || options.signal?.aborted || !Number.isFinite(deadline) || Date.now() >= deadline) {
          throw new SecurityError("expired", "Encrypted request expired or was cancelled before publication");
        }
      };
      admit();
      for (const [id, expected] of this.expectations) if (expected.expiresAt <= Date.now()) this.expectations.delete(id);
      if (record(value) && typeof value.requestId === "string") this.expectations.set(value.requestId, { bridgeIds: new Set(targets), expiresAt: deadline });
      return Promise.all(targets.map(bridgeId => {
        const key = `${bridgeId}:${channel}`;
        const before = this.outbound.get(key) ?? Promise.resolve();
        const next = before.catch(() => {}).then(async () => {
        admit();
        await this.ensureReady(bridgeId);
        admit();
        const packet = record(value) ? value : {};
        const payload = record(packet.payload) ? packet.payload : packet;
        const terminal = channel.startsWith("terminal-input:");
        const route: ApplicationRoute = terminal
          ? { kind: "terminal", sessionId: /:([^#]+)#/.exec(channel)?.[1] ?? "", frameType: String(packet.type ?? ""), pairId: null }
          : { kind: "command", requestId: typeof packet.requestId === "string" ? packet.requestId : crypto.randomUUID(), command: String(packet.type ?? ""), sessionId: typeof payload.sessionId === "string" ? payload.sessionId : null };
        const { type, ...frame } = packet;
        const data = terminal ? { ...frame, kind: type, sessionId: route.kind === "terminal" ? route.sessionId : "" }
          : record(packet.payload) ? { ...packet, payload: { ...packet.payload, bridgeId } } : { ...packet, bridgeId };
        const encrypted = await this.securityRuntime.sealApplication(bridgeId, channel, { type: "application", route, data: applicationJson(data), mcp: null });
        admit();
        await this.raw.publish(channel, encrypted);
        });
        this.outbound.set(key, next);
        void next.finally(() => { if (this.outbound.get(key) === next) this.outbound.delete(key); }).catch(() => {});
        return next;
      }));
    } catch (error) { return Promise.reject(error); }
  }
  private recoverEpoch(bridgeId: string): void {
    if (this.closed || this.recovering.has(bridgeId)) return;
    this.recovering.add(bridgeId);
    void this.ensureReady(bridgeId, true).then(() => {
      if (!this.closed) this.getSubscription(`commands:rpc#${this.userId}`)?.emit("subscribed", undefined);
    }).catch(() => {}).finally(() => this.recovering.delete(bridgeId));
  }
  observe(bridgeId: string, application: SecureApplication): boolean {
    const value = application.data;
    if (!record(value)) return true;
    const register = (session: unknown) => {
      if (record(session) && session.bridgeId === bridgeId && typeof session.id === "string") this.sessionOwners.set(session.id, bridgeId);
    };
    if (value.type === "session_update") {
      if (!record(value.session) || value.session.bridgeId !== bridgeId) return false;
      register(value.session);
    }
    if (value.type === "command_response" && record(value.response)) {
      const response = value.response;
      if (application.route.kind !== "response" || response.requestId !== application.route.requestId || typeof response.requestId !== "string") return false;
      const expected = this.expectations.get(response.requestId);
      if (!expected || expected.expiresAt <= Date.now() || !expected.bridgeIds.has(bridgeId)) return false;
      if (response.success === false && record(response.data) && response.data.code === "epoch_changed") this.recoverEpoch(bridgeId);
      if (record(response.data)) {
        if (typeof response.data.bridgeId === "string" && response.data.bridgeId !== bridgeId) return false;
        if (Array.isArray(response.data.sessions) && response.data.sessions.some(session => !record(session) || session.bridgeId !== bridgeId)) return false;
        if (record(response.data.session) && response.data.session.bridgeId !== bridgeId) return false;
        if (Array.isArray(response.data.sessions)) for (const session of response.data.sessions) register(session);
        register(response.data.session);
      }
      const pending = typeof response.requestId === "string" ? this.pending.get(response.requestId) : null;
      if (pending) { clearTimeout(pending.timer); this.pending.delete(String(response.requestId)); pending.resolve(response); }
    }
    return true;
  }
  request(command: unknown): Promise<unknown> {
    if (!record(command) || typeof command.requestId !== "string") return Promise.reject(new SecurityError("invalid_envelope", "A request ID is required"));
    const requestId = command.requestId;
    return new Promise((resolve, reject) => {
      const cancellation = new AbortController(); const deadline = Date.now() + this.commandTimeoutMs;
      const timer = setTimeout(() => { cancellation.abort(); this.pending.delete(requestId); reject(new SecurityError("outcome_unknown", "Bridge delivery is uncertain")); }, this.commandTimeoutMs);
      this.pending.set(requestId, { resolve: value => { cancellation.abort(); resolve(value); }, reject: error => { cancellation.abort(); reject(error); }, timer });
      void this.publish(`commands:rpc#${this.userId}`, command, { deadline, signal: cancellation.signal }).catch(error => {
        clearTimeout(timer); cancellation.abort(); this.pending.delete(requestId); reject(error);
      });
    });
  }
  executeSecurity = <C extends SecurityCommand>(command: C): Promise<SecurityCommandResults[C["type"]]> => this.securityRuntime.command(command, value => this.request(value));
  dispose(): void {
    this.closed = true; this.abort.abort(); this.generation++; this.recovering.clear();
    this.raw.off("connected", this.connected); this.raw.off("disconnected", this.disconnected);
    for (const subscription of this.subscriptions.values()) subscription.destroy();
    this.subscriptions.clear(); this.outbound.clear(); this.handshakes.clear(); this.sessionOwners.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new SecurityError("endpoint_revoked", "Encrypted connection closed")); }
    this.pending.clear(); this.expectations.clear();
  }
}
