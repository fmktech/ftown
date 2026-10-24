import { Centrifuge, type Subscription } from "centrifuge";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { FleetError, requestSchema, type BridgeRequest } from "./fleet.js";
import { parseSecureEnvelope } from "../security/crypto.js";
import type { SecureEnvelope } from "../security/protocol.js";
import { SecureMcpClient, type McpRequestContext } from "./secure-client.js";

/** Renewable routing connections carry ciphertext only; identities stay request-bound. */
export class FleetRelay {
  private clients = new Map<string, { client: Centrifuge; sub: Subscription; pending: Map<string, { accept: (packet: SecureEnvelope) => void; reject: () => void }> }>();
  constructor(private url: string, private tokenSecret: string) {}
  private connection(userId: string) {
    const cached = this.clients.get(userId);
    if (cached) return cached;
    const mint = () => jwt.sign({}, this.tokenSecret, { subject: userId, audience: "ftown:centrifugo", expiresIn: "10m" });
    const client = new Centrifuge(this.url, { websocket: WebSocket, token: mint(), getToken: async () => mint(), timeout: 10000 });
    const sub = client.newSubscription(`commands:rpc#${userId}`);
    const pending = new Map<string, { accept: (packet: SecureEnvelope) => void; reject: () => void }>();
    sub.on("publication", ctx => {
      if (ctx.info?.user !== userId) return;
      try {
        const packet = parseSecureEnvelope(ctx.data);
        pending.get(packet.messageId)?.accept(packet);
      } catch { /* Plaintext/unknown/oversized traffic never enters the application. */ }
    });
    sub.subscribe(); client.connect();
    const entry = { client, sub, pending };
    this.clients.set(userId, entry);
    return entry;
  }
  async request(userId: string, machineId: string, request: BridgeRequest, signal?: AbortSignal, context?: McpRequestContext): Promise<unknown> {
    if (!context) throw new FleetError("approval_required", "An encrypted MCP grant is required");
    const client = new SecureMcpClient(context, machineId, `commands:rpc#${userId}`,
      (packet, deadline, mutating, abort) => this.exchange(userId, packet, deadline, mutating, abort));
    return client.request(requestSchema.parse(request), signal);
  }
  private async exchange(userId: string, packet: SecureEnvelope, deadline: number, mutating: boolean, signal?: AbortSignal): Promise<SecureEnvelope> {
    if (Date.now() >= deadline) throw new FleetError("timeout", "Encrypted request expired before publication");
    if (signal?.aborted) throw new FleetError("cancelled", "Encrypted request cancelled");
    const { sub, pending } = this.connection(userId);
    const id = packet.messageId;
    return new Promise((resolve, reject) => {
      let sent = false, settled = false;
      const finish = (error?: FleetError, value?: SecureEnvelope) => {
        if (settled) return;
        settled = true; clearTimeout(timer); pending.delete(id); signal?.removeEventListener("abort", cancel);
        if (error) reject(error); else if (value) resolve(value);
      };
      const cancel = () => finish(new FleetError("cancelled", "Encrypted relay request cancelled", sent && mutating));
      const timer = setTimeout(() => finish(new FleetError("timeout", "Encrypted bridge did not respond before the deadline", sent && mutating)), Math.max(1, deadline - Date.now()));
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      pending.set(id, { accept: value => {
        // Other concurrent gateways/endpoints can publish the same visible ID; only accept the exact route here.
        if (value.senderId === packet.recipientId && value.recipientId === packet.senderId && value.ownerId === packet.ownerId && value.bridgeId === packet.bridgeId && value.channel === packet.channel) finish(undefined, value);
      }, reject: () => finish(new FleetError("connection_error", "Encrypted relay is closing", sent && mutating)) });
      void sub.ready(Math.max(1, deadline - Date.now())).then(async () => {
        if (settled) return;
        sent = true;
        await sub.publish(packet);
      }).catch(() => finish(new FleetError("connection_error", "Encrypted relay connection unavailable", sent && mutating)));
    });
  }
  close() {
    for (const entry of this.clients.values()) {
      for (const pending of [...entry.pending.values()]) pending.reject();
      entry.client.disconnect();
    }
    this.clients.clear();
  }
}
