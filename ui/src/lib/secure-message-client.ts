import type { Centrifuge, PublicationContext, SubscribedContext, Subscription } from "centrifuge";
import type { ApplicationRoute, EndpointDirectory, SecureApplication, SecurityCommand, SecurityCommandResults } from "@security/protocol";
import { SecurityError } from "@security/crypto";
import { accountChannel } from "@security/ledger/channels";
import { classifyCommand } from "@security/bridge/permissions";
import type { ApplicationJson } from "@security/protocol";
import { UNRECOVERED_SUBSCRIBED_CONTEXT, type MessageClient, type MessageEvents, type MessageSubscription, type MessagePublishOptions } from "./message-client";
import { applicationJson, SecureEndpointRuntime } from "./secure-endpoint-runtime";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
type Listener = (context: never) => void;

class SecureSubscription implements MessageSubscription {
  private listeners = new Map<keyof MessageEvents, Set<Listener>>();
  private queue: Promise<void> = Promise.resolve();
  private streamEpoch = "";
  private receiving = (context: PublicationContext) => {
    // Capture the broker epoch before decryption yields. A reconnect can move
    // the raw subscription to another epoch while this packet is queued.
    const epoch = this.streamEpoch;
    if (Number.isSafeInteger(context.offset) && context.offset! >= 0 && epoch
      && (!this.latestStreamPosition || this.latestStreamPosition.epoch !== epoch || context.offset! > this.latestStreamPosition.offset)) {
      this.latestStreamPosition = { offset: context.offset!, epoch };
    }
    this.queue = this.queue.then(async () => {
      for (const value of await this.owner.securityRuntime.receive(context.data, this.channel)) {
        if (value.application.route.kind === "response" && record(value.application.data) && typeof value.application.data.status === "number" && value.application.data.status >= 400) {
          const body = record(value.application.data.body) ? value.application.data.body : {};
          value.application.data = applicationJson({ type: "command_response", response: { requestId: value.application.route.requestId, success: false,
            error: "Encrypted request rejected", data: { code: typeof body.code === "string" ? body.code : "permission_denied" } } });
        }
        if (!this.owner.observe(value.bridgeId, value.application)) continue;
        this.emit("publication", { data: value.application.data, info: { user: this.owner.userId },
          ...(context.offset === undefined ? {} : { offset: context.offset }), ...(epoch ? { epoch } : {}) });
      }
    }).catch(() => { /* Unauthenticated/plaintext packets never reach domain handlers. */ });
  };
  private latestStreamPosition: { offset: number; epoch: string } | null = null;
  private subscribed = (context: SubscribedContext) => {
    const position = context.streamPosition;
    if (position && Number.isSafeInteger(position.offset) && position.offset >= 0 && typeof position.epoch === "string" && position.epoch) {
      this.streamEpoch = position.epoch;
      this.latestStreamPosition = { offset: position.offset, epoch: position.epoch };
    }
    const subscribed: MessageEvents["subscribed"] = {
      recovered: context.recovered,
      positioned: context.positioned,
      wasRecovering: context.wasRecovering,
      ...(position ? { offset: position.offset, epoch: position.epoch } : {}),
    };
    // Domain consumers see the same order as the raw stream, even if a prior
    // publication is still being decrypted when recovery completes.
    this.queue = this.queue.then(() => { this.emit("subscribed", subscribed); }).catch(() => {});
  };
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
  streamPosition() { return this.latestStreamPosition ? { ...this.latestStreamPosition } : null; }
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

/**
 * Account mode: a computer the trusted ledger lists may not have applied the newest ledger yet (a just-enrolled browser is unknown to
 * it, and it cannot even answer an unknown endpoint), so a failed handshake is retried: after 0.5 s, 1 s, 2 s, 4 s, then every 5 s,
 * for 60 s in all; every ledger change and every reconnect starts a fresh window. After the window the computer stays offline
 * (needs attention). A revocation or key change is never retried.
 */
export interface ReadyRetryPolicy { delaysMs: number[]; everyMs: number; windowMs: number; helloTimeoutMs: number }
export const READY_RETRY: ReadyRetryPolicy = { delaysMs: [500, 1000, 2000, 4000], everyMs: 5000, windowMs: 60_000, helloTimeoutMs: 5000 };
const NEVER_RETRY = ["endpoint_revoked", "account_bridge_revoked", "account_device_revoked", "device_revoked", "key_changed", "wrong_context"];
interface ReadyRetry { started: number; attempts: number; timer: ReturnType<typeof setTimeout> | null; exhausted: boolean }

/**
 * Sends one dashboard command to a bridge over its direct channel, connecting first if needed. Resolves once the command has left,
 * with a handle on the answer, or null when the bridge cannot be reached directly (the relay is used then). `timeoutMs` bounds the
 * wait for the answer.
 */
export type DirectCommandSender = (bridgeId: string, route: Extract<ApplicationRoute, { kind: "command" }>, data: unknown, timeoutMs: number)
  => Promise<{ answer: Promise<ApplicationJson> } | null>;
/** Connection setup and terminal watch commands always use the relay: they are how a direct channel comes to exist. */
const RELAY_ONLY = new Set(["terminal_watch", "terminal_unwatch", "webrtc_offer", "webrtc_answer", "webrtc_ice", "webrtc_close"]);
/** How long a read waits for its direct answer before it is repeated over the relay. */
export const DIRECT_READ_TIMEOUT_MS = 8_000;
/**
 * Which commands go to a bridge's direct channel: every dashboard command the bridge knows, except connection setup and the
 * security commands (pairing, devices, revocation), which stay on the relay with the rest of trust setup.
 */
export function isDirectCommand(command: string, payload: unknown): boolean {
  if (RELAY_ONLY.has(command) || command.startsWith("security_")) return false;
  try { classifyCommand(command, applicationJson(payload)); return true; } catch { return false; }
}
/** A read can be repeated over the relay without changing anything twice; a command that changes something cannot. */
export function isDirectRead(command: string, payload: unknown): boolean {
  if (!isDirectCommand(command, payload)) return false;
  const operation = classifyCommand(command, applicationJson(payload));
  return operation.permission === "read" && !operation.mutating;
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
  private recovering = new Map<string, object>();
  private stopTrustObserver: () => void;
  private stopLedgerObserver: (() => void) | undefined;
  private retries = new Map<string, ReadyRetry>();
  private readonly retry: ReadyRetryPolicy;
  private direct: DirectCommandSender | null = null;
  /** Dashboard commands go to a bridge over this sender (its direct channel); the relay carries them only when it returns null. */
  setDirectCommands(sender: DirectCommandSender | null): void { this.direct = sender; }
  /** Hands an answer that arrived on a direct channel to the commands subscribers, under the caller's request id. */
  private deliverDirect(bridgeId: string, requestId: string, response: Record<string, unknown>): boolean {
    const application: SecureApplication = { type: "application", route: { kind: "response", requestId },
      data: applicationJson({ type: "command_response", response: { ...response, requestId } }), mcp: null };
    if (this.closed || !this.observe(bridgeId, application)) return false;
    this.getSubscription(accountChannel("commands:rpc", this.userId))?.emit("publication", { data: application.data, info: { user: this.userId } });
    return true;
  }
  /**
   * True when the command left on the bridge's direct channel; its answer is then delivered when it arrives. False when the bridge
   * has no usable direct channel, and the caller sends it over the relay.
   *
   * A read that is not answered properly is repeated over the relay (`relay`). A command that changes something is never repeated
   * once it has left: its failure is reported to the caller as uncertain delivery.
   */
  private async viaDirect(bridgeId: string, route: Extract<ApplicationRoute, { kind: "command" }>, data: Record<string, unknown>,
    deadline: number, relay: () => Promise<void>): Promise<boolean> {
    const payload = record(data.payload) ? data.payload : data;
    if (!this.direct || !isDirectCommand(route.command, payload)) return false;
    const read = isDirectRead(route.command, payload);
    // A separate request id: a later relay attempt must not look like a replay of this one.
    const directId = crypto.randomUUID();
    let handle: { answer: Promise<ApplicationJson> } | null;
    try {
      handle = await this.direct(bridgeId, { ...route, requestId: directId }, { ...data, requestId: directId },
        read ? DIRECT_READ_TIMEOUT_MS : Math.max(1, deadline - Date.now()));
    } catch { return false; }
    if (!handle) return false;
    const again = () => { if (!this.closed) void relay().catch(() => {}); };
    const uncertain = (code: string, message: string) => this.deliverDirect(bridgeId, route.requestId, { success: false, error: message, data: { code } });
    void handle.answer.then(reply => {
      if (record(reply) && reply.type === "command_response" && record(reply.response) && reply.response.requestId === directId) {
        if (!this.deliverDirect(bridgeId, route.requestId, reply.response) && read) again();
        return;
      }
      if (read) { again(); return; }
      // A refusal before anything ran names its reason; anything else leaves the outcome unknown.
      const body = record(reply) && record(reply.body) ? reply.body : {};
      const refused = record(reply) && reply.status === 403 && body.outcomeUnknown !== true && typeof body.code === "string";
      uncertain(refused ? String(body.code) : "outcome_unknown", refused ? "Encrypted request rejected" : "The bridge did not confirm this action. Refresh before retrying.");
    }, (error: unknown) => {
      // Never left this browser, or only a read: the relay may carry it.
      if (read || (error instanceof Error && error.name === "DirectUnsentError")) { again(); return; }
      uncertain("outcome_unknown", "The connection to the bridge was lost before it answered. Delivery may be uncertain; refresh before retrying.");
    });
    return true;
  }
  constructor(private raw: Centrifuge, readonly userId: string, readonly securityRuntime: SecureEndpointRuntime, options: { retry?: ReadyRetryPolicy } = {}) {
    this.retry = options.retry ?? READY_RETRY;
    const commands = this.newSubscription(accountChannel("commands:rpc", userId));
    commands.subscribe();
    raw.on("connected", this.connected);
    raw.on("disconnected", this.disconnected);
    this.stopTrustObserver = securityRuntime.onChange(() => {
      if (this.closed) return;
      const becameReady = this.noteReadyBridges();
      if (this.raw.state !== "connected") {
        // A bridge can become ready over its direct channel while the relay is down. The dashboard loads its data on the command
        // channel's "subscribed" signal, which the relay cannot send then, so it is raised here.
        if (becameReady) this.getSubscription(accountChannel("commands:rpc", this.userId))?.emit("subscribed", UNRECOVERED_SUBSCRIBED_CONTEXT);
        return;
      }
      for (const pin of securityRuntime.pinnedBridges()) if (securityRuntime.state(pin.bridgeId).status === "offline") {
        this.recoverBridge(pin.bridgeId, false);
      }
    });
    // Account mode: a ledger change may be exactly what a waiting computer needed; re-evaluate now with a fresh window.
    this.stopLedgerObserver = securityRuntime.onLedgerChange?.(() => {
      if (this.closed || this.raw.state !== "connected") return;
      for (const pin of securityRuntime.pinnedBridges()) {
        if (securityRuntime.state(pin.bridgeId).status === "ready") continue;
        this.resetRetry(pin.bridgeId);
        this.recoverBridge(pin.bridgeId, false);
      }
    });
  }
  private resetRetry(bridgeId?: string): void {
    for (const [id, entry] of this.retries) if (bridgeId === undefined || id === bridgeId) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.retries.delete(id);
    }
  }
  /** Account mode: schedules the next handshake for a still-trusted computer after a transient failure (see READY_RETRY). */
  private retryLater(bridgeId: string, error: unknown): void {
    if (this.closed || !this.securityRuntime.accountManaged) return;
    const code = record(error) && typeof error.code === "string" ? error.code : error instanceof Error ? error.message : "";
    if (NEVER_RETRY.includes(code) || !this.securityRuntime.bridge(bridgeId)) { this.resetRetry(bridgeId); return; }
    if (this.raw.state !== "connected") return; // the next "connected" handshakes every computer anyway
    const now = Date.now();
    const entry = this.retries.get(bridgeId) ?? { started: now, attempts: 0, timer: null, exhausted: false };
    this.retries.set(bridgeId, entry);
    if (entry.timer !== null || entry.exhausted) return;
    const left = entry.started + this.retry.windowMs - now;
    if (left <= 0) { entry.exhausted = true; return; }
    const delay = Math.min(entry.attempts < this.retry.delaysMs.length ? this.retry.delaysMs[entry.attempts] : this.retry.everyMs, left);
    entry.attempts++;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (this.closed || this.retries.get(bridgeId) !== entry || this.raw.state !== "connected") return;
      this.recoverBridge(bridgeId, false);
    }, delay);
  }
  private connected = () => {
    this.resetRetry();
    for (const pin of this.securityRuntime.pinnedBridges()) void this.ensureReady(pin.bridgeId, true).catch(() => {});
    void fetch("/api/security/endpoints", { credentials: "include", cache: "no-store", signal: this.abort.signal })
      .then(async response => {
        if (!response.ok) return;
        const directory = await response.json() as EndpointDirectory;
        if (directory.ownerId !== this.securityRuntime.ownerId) return;
        for (const entry of directory.endpoints) if (entry.bridgeId && entry.endpoint.kind === "bridge") this.securityRuntime.discover(entry.bridgeId, entry.endpoint);
      }).catch(() => {});
  };
  private disconnected = () => { this.generation++; this.handshakes.clear(); this.recovering.clear(); this.securityRuntime.disconnected(); };
  newSubscription(channel: string, options?: { since?: { offset: number; epoch: string }; recoverable?: boolean; positioned?: boolean }): SecureSubscription {
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
      const commands = accountChannel("commands:rpc", this.userId);
      pending = this.securityRuntime.handshake(bridgeId, commands, async packet => {
        if (this.closed || generation !== this.generation) throw new SecurityError("bridge_offline", "Encrypted connection changed");
        this.securityRuntime.assertCanSend(bridgeId);
        await this.raw.publish(commands, packet);
      }, this.securityRuntime.accountManaged ? this.retry.helloTimeoutMs : undefined).then(() => {
        if (generation !== this.generation) throw new SecurityError("bridge_offline", "Connection changed during handshake");
        this.resetRetry(bridgeId);
      }, (error: unknown) => { this.retryLater(bridgeId, error); throw error; }).finally(() => { if (this.handshakes.get(bridgeId) === pending) this.handshakes.delete(bridgeId); });
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
        // Connection setup has its own queue: a command waiting for the direct channel must never hold up the offer that opens it.
        const setup = record(value) && typeof value.type === "string" && RELAY_ONLY.has(value.type);
        const key = `${bridgeId}:${channel}${setup ? ":setup" : ""}`;
        const before = this.outbound.get(key) ?? Promise.resolve();
        const next = before.catch(() => {}).then(async () => {
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
        const relay = async () => {
          admit();
          await this.ensureReady(bridgeId);
          admit();
          const encrypted = await this.securityRuntime.sealApplication(bridgeId, channel, { type: "application", route, data: applicationJson(data), mcp: null });
          admit();
          this.securityRuntime.assertCanSend(bridgeId);
          await this.raw.publish(channel, encrypted);
        };
        // A command that leaves on the bridge's direct channel never reaches the relay.
        if (route.kind === "command" && typeof packet.requestId === "string" && await this.viaDirect(bridgeId, route, data, deadline, relay)) return;
        await relay();
        });
        this.outbound.set(key, next);
        void next.finally(() => { if (this.outbound.get(key) === next) this.outbound.delete(key); }).catch(() => {});
        return next;
      }));
    } catch (error) { return Promise.reject(error); }
  }
  /** The bridges seen ready at the last trust change, to tell a bridge that just became ready from one that already was. */
  private readonly readyBridges = new Set<string>();
  private noteReadyBridges(): boolean {
    let becameReady = false;
    for (const pin of this.securityRuntime.pinnedBridges()) {
      if (this.securityRuntime.state(pin.bridgeId).status !== "ready") this.readyBridges.delete(pin.bridgeId);
      else if (!this.readyBridges.has(pin.bridgeId)) { this.readyBridges.add(pin.bridgeId); becameReady = true; }
    }
    return becameReady;
  }
  private recoverBridge(bridgeId: string, force: boolean): void {
    if (this.closed || this.recovering.has(bridgeId)) return;
    const cycle = {};
    const generation = this.generation;
    this.recovering.set(bridgeId, cycle);
    void this.ensureReady(bridgeId, force).then(() => {
      if (!this.closed && this.generation === generation && this.recovering.get(bridgeId) === cycle
        && this.securityRuntime.state(bridgeId).status === "ready") {
        this.getSubscription(accountChannel("commands:rpc", this.userId))?.emit("subscribed", UNRECOVERED_SUBSCRIBED_CONTEXT);
      }
    }).catch(() => {}).finally(() => {
      if (this.recovering.get(bridgeId) === cycle) this.recovering.delete(bridgeId);
    });
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
    if (value.type === "session_board_snapshot" || value.type === "session_board_changed" || value.type === "session_snapshot_required") {
      if (value.bridgeId !== bridgeId) return false;
    }
    if (value.type === "command_response" && record(value.response)) {
      const response = value.response;
      if (application.route.kind !== "response" || response.requestId !== application.route.requestId || typeof response.requestId !== "string") return false;
      const expected = this.expectations.get(response.requestId);
      if (!expected || expected.expiresAt <= Date.now() || !expected.bridgeIds.has(bridgeId)) return false;
      if (response.success === false && record(response.data) && response.data.code === "epoch_changed") this.recoverBridge(bridgeId, true);
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
      void this.publish(accountChannel("commands:rpc", this.userId), command, { deadline, signal: cancellation.signal }).catch(error => {
        clearTimeout(timer); cancellation.abort(); this.pending.delete(requestId); reject(error);
      });
    });
  }
  executeSecurity = <C extends SecurityCommand>(command: C): Promise<SecurityCommandResults[C["type"]]> => this.securityRuntime.command(command, value => this.request(value));
  dispose(): void {
    this.closed = true; this.abort.abort(); this.generation++; this.recovering.clear(); this.resetRetry();
    this.stopTrustObserver(); this.stopLedgerObserver?.();
    this.raw.off("connected", this.connected); this.raw.off("disconnected", this.disconnected);
    for (const subscription of this.subscriptions.values()) subscription.destroy();
    this.subscriptions.clear(); this.outbound.clear(); this.handshakes.clear(); this.sessionOwners.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new SecurityError("endpoint_revoked", "Encrypted connection closed")); }
    this.pending.clear(); this.expectations.clear();
  }
}
