import { Centrifuge, type Subscription } from "centrifuge";
import {
  SECURITY_NUDGE_MIN_SPACING_MS, createCoalescedTrigger, parseSecurityNudge, securityNudge, securityNudgeChannel,
  type CoalescedTrigger, type SecurityNudgeScope,
} from "@security/security-nudge";

type Timers = { now(): number; setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
export interface SecurityNudgeBusOptions {
  /** Default: POST /api/auth/token (credentials include, no-store) → { token, centrifugoUrl }. */
  fetchBootstrap?: () => Promise<{ token: string; centrifugoUrl: string }>;
  /** Default: (url, token) => new Centrifuge(url, { token }). */
  createClient?: (url: string, token: string) => Centrifuge;
  timers?: Timers;
}

const ONE_SHOT_TIMEOUT_MS = 10_000;
const SCOPES: SecurityNudgeScope[] = ["approvals", "account"];
const defaultTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

async function defaultFetchBootstrap(): Promise<{ token: string; centrifugoUrl: string }> {
  const response = await fetch("/api/auth/token", { method: "POST", credentials: "include", cache: "no-store" });
  if (!response.ok) throw new Error(`bootstrap failed: ${response.status}`);
  const body = (await response.json()) as { token?: unknown; centrifugoUrl?: unknown };
  if (typeof body.token !== "string" || typeof body.centrifugoUrl !== "string") throw new Error("bootstrap malformed");
  return { token: body.token, centrifugoUrl: body.centrifugoUrl };
}

/** Unverified: only names the channel to publish on; the broker enforces the token. */
function jwtSubject(token: string): string | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const sub = (JSON.parse(new TextDecoder().decode(bytes)) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch { return null; }
}

interface Attachment { client: Centrifuge; channel: string; userId: string; sub: Subscription }

export class SecurityNudgeBus {
  private readonly fetchBootstrap: () => Promise<{ token: string; centrifugoUrl: string }>;
  private readonly createClient: (url: string, token: string) => Centrifuge;
  private readonly timers: Timers;
  private readonly handlers: Record<SecurityNudgeScope, Set<() => void>> = { approvals: new Set(), account: new Set() };
  private readonly triggers: Record<SecurityNudgeScope, CoalescedTrigger>;
  private attachment: Attachment | null = null;
  private queued = new Set<SecurityNudgeScope>();
  private oneShot: { queue: Set<SecurityNudgeScope> } | null = null;

  constructor(options: SecurityNudgeBusOptions = {}) {
    this.fetchBootstrap = options.fetchBootstrap ?? defaultFetchBootstrap;
    this.createClient = options.createClient ?? ((url, token) => new Centrifuge(url, { token }));
    this.timers = options.timers ?? defaultTimers;
    const trigger = (scope: SecurityNudgeScope) => createCoalescedTrigger(() => {
      for (const handler of Array.from(this.handlers[scope])) { try { handler(); } catch { /* one handler must not starve the rest */ } }
    }, SECURITY_NUDGE_MIN_SPACING_MS, this.timers);
    this.triggers = { approvals: trigger("approvals"), account: trigger("account") };
  }

  get attached(): boolean { return this.attachment !== null; }

  attach(client: Centrifuge, userId: string): () => void {
    this.detach();
    const channel = securityNudgeChannel(userId);
    const sub = client.newSubscription(channel);
    const attachment: Attachment = { client, channel, userId, sub };
    sub.on("publication", (ctx) => {
      if (this.attachment !== attachment || ctx.info?.user !== userId) return;
      const scope = parseSecurityNudge(ctx.data);
      if (scope) this.triggers[scope].request();
    });
    sub.on("subscribed", () => {
      if (this.attachment !== attachment) return;
      for (const scope of SCOPES) this.triggers[scope].request();
      this.flush(attachment);
    });
    this.attachment = attachment;
    sub.subscribe();
    return () => { if (this.attachment === attachment) this.detach(); };
  }

  on(scope: SecurityNudgeScope, handler: () => void): () => void {
    this.handlers[scope].add(handler);
    return () => { this.handlers[scope].delete(handler); };
  }

  publish(scope: SecurityNudgeScope): void {
    try {
      const attachment = this.attachment;
      if (!attachment) { this.publishOneShot(scope); return; }
      if (attachment.client.state !== "connected") { this.queued.add(scope); return; }
      this.send(attachment, scope);
    } catch { /* best-effort */ }
  }

  private detach(): void {
    const attachment = this.attachment;
    if (!attachment) return;
    this.attachment = null;
    const pending = Array.from(this.queued);
    this.queued.clear();
    try { attachment.sub.unsubscribe(); } catch { /* already gone */ }
    try { attachment.client.removeSubscription(attachment.sub); } catch { /* already gone */ }
    for (const scope of pending) { try { this.publishOneShot(scope); } catch { /* best-effort */ } }
  }

  private send(attachment: Attachment, scope: SecurityNudgeScope): void {
    attachment.client.publish(attachment.channel, securityNudge(scope)).catch(() => { if (this.attachment === attachment) this.queued.add(scope); });
  }

  private flush(attachment: Attachment): void {
    const scopes = Array.from(this.queued);
    this.queued.clear();
    for (const scope of scopes) this.send(attachment, scope);
  }

  private publishOneShot(scope: SecurityNudgeScope): void {
    if (this.oneShot) { this.oneShot.queue.add(scope); return; }
    const state = { queue: new Set<SecurityNudgeScope>([scope]) };
    this.oneShot = state;
    let client: Centrifuge | null = null;
    let finished = false;
    let timer: unknown = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== null) this.timers.clearTimeout(timer);
      state.queue.clear();
      try { client?.disconnect(); } catch { /* best-effort */ }
      if (this.oneShot === state) this.oneShot = null;
    };
    timer = this.timers.setTimeout(finish, ONE_SHOT_TIMEOUT_MS);
    const drain = async (channel: string) => {
      while (!finished && state.queue.size) {
        const scopes = Array.from(state.queue);
        state.queue.clear();
        await Promise.all(scopes.map((s) => client!.publish(channel, securityNudge(s)).catch(() => undefined)));
      }
      finish();
    };
    void (async () => {
      const { token, centrifugoUrl } = await this.fetchBootstrap();
      if (finished) return;
      const userId = jwtSubject(token);
      if (!userId) { finish(); return; }
      const channel = securityNudgeChannel(userId);
      client = this.createClient(centrifugoUrl, token);
      client.on("connected", () => { void drain(channel).catch(finish); });
      client.connect();
    })().catch(finish);
  }
}

/** One bus per page. */
export const securityNudges = new SecurityNudgeBus();
