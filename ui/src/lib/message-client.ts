import type { SecurityCommand, SecurityCommandResults } from "@security/protocol";
import type { SecureEndpointRuntime } from "./secure-endpoint-runtime";

/** Shared authenticated message transport used by cloud and local dashboards. */
export interface MessagePublishOptions { deadline?: number; signal?: AbortSignal }
export interface MessageEvents {
  publication: { data: unknown; info?: { user?: string } };
  subscribed: unknown;
  join: { info: { client: string; connInfo?: unknown } };
  leave: { info: { client: string } };
}
export interface MessageSubscription {
  state: string;
  subscribe(): void;
  unsubscribe(): void;
  publish(data: unknown, options?: MessagePublishOptions): Promise<unknown>;
  on(event: "publication", listener: (ctx: MessageEvents["publication"]) => void): unknown;
  on(event: "subscribed", listener: (ctx: MessageEvents["subscribed"]) => void): unknown;
  on(event: "join", listener: (ctx: MessageEvents["join"]) => void): unknown;
  on(event: "leave", listener: (ctx: MessageEvents["leave"]) => void): unknown;
  off(event: "publication", listener: (ctx: MessageEvents["publication"]) => void): unknown;
  off(event: "subscribed", listener: (ctx: MessageEvents["subscribed"]) => void): unknown;
  off(event: "join", listener: (ctx: MessageEvents["join"]) => void): unknown;
  off(event: "leave", listener: (ctx: MessageEvents["leave"]) => void): unknown;
  removeAllListeners(): unknown;
  presence(): Promise<{ clients: Record<string, { connInfo?: unknown }> }>;
}
export interface MessageClient {
  readonly securityRuntime?: SecureEndpointRuntime;
  readonly executeSecurity?: <C extends SecurityCommand>(command: C) => Promise<SecurityCommandResults[C["type"]]>;
  readonly commandTimeoutMs?: number;
  /** A local controller snapshot is authoritative for this single bridge. */
  readonly sessionSnapshotBridgeId?: string;
  newSubscription(channel: string, options?: { since: { offset: number; epoch: string } }): MessageSubscription;
  getSubscription(channel: string): MessageSubscription | null;
  removeSubscription(sub: MessageSubscription | null): void;
}
