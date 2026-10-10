import { randomUUID } from "node:crypto";
import { Centrifuge, type Subscription } from "centrifuge";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { FleetError, requestSchema, type BridgeRequest } from "./fleet.js";
import { legacyRelayCommand } from "./legacy-relay.js";

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
    request = requestSchema.parse(request);
    const deadline = Date.now() + request.timeoutMs;
    const mutation = request.method !== "GET";
    const response = await this.rpc(userId, machineId, "mcp_request", {
      request, expiresAt: deadline,
    }, deadline, mutation, signal);
    if (response.success) return this.unwrap(response.data);
    // Only this rejection proves the operation was not executed. Never fall
    // back after a timeout, connection failure or ambiguous execution error.
    if (response.error !== "Unknown command type: mcp_request")
      throw new FleetError("bridge_error", "Bridge could not execute the relay request", mutation);
    const lifecycle = request.method === "POST"
      ? /^\/api\/sessions\/([a-zA-Z0-9_-]+)\/(stop|retry)$/.exec(request.path) : null;
    const type = lifecycle ? `${lifecycle[2]}_session` : "bridge_exec";
    const payload = lifecycle ? { sessionId: lifecycle[1] } : {
      command: legacyRelayCommand(machineId, request, deadline),
      timeout: Math.max(1, deadline - Date.now()),
    };
    const legacy = await this.rpc(userId, machineId, type, payload, deadline, mutation, signal);
    if (!legacy.success) {
      if (legacy.error === "bridge_exec disabled (FTOWN_DISABLE_BRIDGE_EXEC=1)")
        throw new FleetError("bridge_upgrade_required", "Upgrade this bridge to enable native MCP support; legacy execution is disabled");
      throw new FleetError("bridge_error", "Bridge rejected the compatibility request", mutation);
    }
    if (lifecycle) return legacy.data;
    if (legacy.data?.exitCode !== 0)
      throw new FleetError("bridge_error", "Legacy bridge helper failed; check Node availability or upgrade this bridge", mutation);
    let result;
    try { result = JSON.parse(legacy.data.stdout); }
    catch { throw new FleetError("bridge_error", "Legacy bridge returned an invalid result", mutation); }
    return this.unwrap(result);
  }
  private unwrap(result: any) {
    if (result?.error)
      throw new FleetError(result.error.code, result.error.message, result.error.outcomeUnknown, result.error.status);
    return result?.data;
  }
  private async rpc(
    userId: string, machineId: string, type: string, payload: Record<string, unknown>,
    deadline: number, mutation: boolean, signal?: AbortSignal,
  ): Promise<any> {
    if (Date.now() >= deadline) throw new FleetError("timeout", "Request expired before publication");
    if (signal?.aborted) throw new FleetError("cancelled", "Relay request cancelled");
    const { sub, pending } = this.connection(userId);
    const id = randomUUID();
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
            sent && mutation,
          ),
        );
      const timer = setTimeout(
        () =>
          finish(
            new FleetError(
              "timeout",
              "Bridge did not respond before the deadline",
              sent && mutation,
            ),
          ),
        Math.max(1, deadline - Date.now()),
      );
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      pending.set(id, (response) => finish(undefined, response));
      void sub
        .ready(Math.max(1, deadline - Date.now()))
        .then(async () => {
          if (settled) return;
          // No retries: publication failure may still mean the request was delivered.
          sent = true;
          await sub.publish({
            type,
            requestId: id,
            payload: { ...payload, bridgeId: machineId },
          });
        })
        .catch(() =>
          finish(
            new FleetError(
              "connection_error",
              "Relay connection unavailable",
              sent && mutation,
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
