import { randomUUID } from "node:crypto";
import { Centrifuge, type Subscription } from "centrifuge";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { FleetError, type BridgeRequest } from "./fleet.js";

/** One renewable owner-scoped relay connection per account, shared by all its MCP requests. */
export class FleetRelay {
  private clients = new Map<
    string,
    {
      client: Centrifuge;
      sub: Subscription;
      pending: Map<string, (data: any) => void>;
    }
  >();
  constructor(
    private url: string,
    private tokenSecret: string,
  ) {}
  private connection(userId: string) {
    const cached = this.clients.get(userId);
    if (cached) return cached;
    const mint = () =>
      jwt.sign({}, this.tokenSecret, {
        subject: userId,
        audience: "ftown:centrifugo",
        expiresIn: "10m",
      });
    const client = new Centrifuge(this.url, {
      websocket: WebSocket,
      token: mint(),
      getToken: async () => mint(),
      timeout: 10000,
    });
    const sub = client.newSubscription(`commands:rpc#${userId}`);
    const pending = new Map<string, (data: any) => void>();
    sub.on("publication", (ctx) => {
      // Same fail-closed publisher check as the existing bridge transport.
      if (ctx.info?.user !== userId || ctx.data?.type !== "command_response")
        return;
      const response = ctx.data.response;
      pending.get(response?.requestId)?.(response);
    });
    sub.subscribe();
    client.connect();
    const entry = { client, sub, pending };
    this.clients.set(userId, entry);
    return entry;
  }
  async request(
    userId: string,
    machineId: string,
    request: BridgeRequest,
    signal?: AbortSignal,
  ) {
    const { sub, pending } = this.connection(userId);
    const id = randomUUID();
    const deadline = Date.now() + request.timeoutMs;
    return new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        pending.delete(id);
        signal?.removeEventListener("abort", cancel);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = () =>
        finish(
          new FleetError(
            "cancelled",
            "Relay request cancelled",
            sent && request.method !== "GET",
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new FleetError(
              "timeout",
              "Bridge did not respond before the deadline",
              sent && request.method !== "GET",
            ),
          ),
        request.timeoutMs,
      );
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      pending.set(id, (response) => {
        if (!response.success) {
          finish(
            new FleetError(
              "bridge_error",
              "Bridge could not execute the relay request",
              sent && request.method !== "GET",
            ),
          );
          return;
        }
        const result = response.data;
        if (result?.error)
          finish(
            new FleetError(
              result.error.code,
              result.error.message,
              result.error.outcomeUnknown,
              result.error.status,
            ),
          );
        else finish(undefined, result?.data);
      });
      void sub
        .ready(request.timeoutMs)
        .then(async () => {
          if (settled) return;
          // No retries: publication failure may still mean the request was delivered.
          sent = true;
          await sub.publish({
            type: "mcp_request",
            requestId: id,
            payload: { bridgeId: machineId, request, expiresAt: deadline },
          });
        })
        .catch(() =>
          finish(
            new FleetError(
              "connection_error",
              "Relay connection unavailable",
              sent && request.method !== "GET",
            ),
          ),
        );
    });
  }
  close() {
    for (const entry of this.clients.values()) {
      for (const finish of [...entry.pending.values()]) finish({ success: false });
      entry.client.disconnect();
    }
    this.clients.clear();
  }
}
