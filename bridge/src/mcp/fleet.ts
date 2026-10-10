import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { z } from "zod";

const machineBase = {
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  label: z.string().optional(),
};
export const configSchema = z
  .object({
    concurrency: z.number().int().min(1).max(32).default(8),
    timeoutMs: z.number().int().min(1000).max(60000).default(15000),
    machines: z
      .array(
        z.discriminatedUnion("transport", [
          z
            .object({
              ...machineBase,
              transport: z.literal("relay"),
              userId: z.string().email(),
            })
            .strict(),
          z
            .object({
              ...machineBase,
              transport: z.literal("local"),
              bridgeFile: z.string().optional(),
            })
            .strict(),
          z
            .object({
              ...machineBase,
              transport: z.literal("ssh"),
              host: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/),
              executable: z.string().min(1).default("ftown-mcp"),
            })
            .strict(),
          z
            .object({
              ...machineBase,
              transport: z.literal("http"),
              url: z.string().url(),
              tokenEnv: z.string().min(1),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(1000),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (
      new Set(config.machines.map((m) => m.id)).size !== config.machines.length
    )
      ctx.addIssue({ code: "custom", message: "Machine IDs must be unique" });
    for (const m of config.machines)
      if (m.transport === "http") {
        const u = new URL(m.url);
        if (
          u.username ||
          u.password ||
          u.search ||
          u.hash ||
          u.pathname !== "/" ||
          !(
            u.protocol === "https:" ||
            (u.protocol === "http:" &&
              ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
          )
        ) {
          ctx.addIssue({
            code: "custom",
            message:
              "HTTP machines require an HTTPS origin or loopback HTTP origin without embedded credentials",
          });
        }
      }
  });
export type FleetConfig = z.infer<typeof configSchema>;
export const requestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PATCH", "DELETE"]),
    path: z
      .string()
      .regex(
        /^\/api\/(?:archive|sessions(?:\/[a-zA-Z0-9_-]+(?:\/(?:screen|grep|keys|message|inbox|resize|usage|running|revive|stop|retry))?)?)(?:\?[^#]*)?$/,
      ),
    body: z.unknown().optional(),
    timeoutMs: z.number().int().min(1000).max(60000),
  })
  .strict();
export type BridgeRequest = z.infer<typeof requestSchema>;
export class FleetError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcomeUnknown = false,
    readonly status?: number,
  ) {
    super(message);
  }
}
export function errorResult(error: unknown) {
  if (error instanceof FleetError)
    return {
      code: error.code,
      message: error.message,
      outcomeUnknown: error.outcomeUnknown,
      ...(error.status ? { status: error.status } : {}),
    };
  return {
    code: "internal_error",
    message: "Operation failed",
    outcomeUnknown: false,
  };
}
const maxBytes = 4 * 1024 * 1024;
export async function httpRequest(
  origin: string,
  token: string,
  request: BridgeRequest,
  signal?: AbortSignal,
): Promise<any> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  try {
    const res = await fetch(new URL(request.path, origin), {
      method: request.method,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body:
        request.body === undefined ? undefined : JSON.stringify(request.body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const reader = res.body?.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            throw new FleetError(
              "response_too_large",
              "Bridge response exceeds 4 MiB; narrow the request",
              request.method !== "GET",
            );
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!res.ok) {
      const detail =
        typeof data?.error === "string"
          ? data.error.replaceAll(token, "[redacted]").slice(0, 1000)
          : "Bridge request rejected";
      throw new FleetError(
        "bridge_error",
        `${detail} (HTTP ${res.status})`,
        request.method !== "GET" && res.status >= 500,
        res.status,
      );
    }
    return data;
  } catch (error) {
    if (error instanceof FleetError) throw error;
    throw new FleetError(
      signal?.aborted
        ? "cancelled"
        : timeout.aborted
          ? "timeout"
          : "connection_error",
      "Bridge request failed; check machine connectivity and credentials",
      request.method !== "GET",
    );
  }
}
export async function localRequest(
  request: BridgeRequest,
  bridgeFile = join(homedir(), ".ftown", "bridge.json"),
  signal?: AbortSignal,
) {
  let credentials;
  try {
    credentials = z
      .object({
        port: z.number().int().min(1).max(65535),
        token: z.string().min(1),
      })
      .parse(JSON.parse(await readFile(bridgeFile, "utf8")));
  } catch {
    throw new FleetError(
      "configuration_error",
      "Cannot read bridge credentials; start ftown-bridge on this machine",
    );
  }
  return httpRequest(
    `http://127.0.0.1:${credentials.port}`,
    credentials.token,
    requestSchema.parse(request),
    signal,
  );
}
export async function loadConfig(path?: string): Promise<FleetConfig> {
  return configSchema.parse(
    path
      ? JSON.parse(await readFile(path, "utf8"))
      : { machines: [{ id: "local", transport: "local" }] },
  );
}
export async function mapLimit<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}
export class Fleet {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(
    readonly config: FleetConfig,
    private relay?: (
      userId: string,
      machineId: string,
      request: BridgeRequest,
      signal?: AbortSignal,
    ) => Promise<unknown>,
  ) {}
  async request(
    machineId: string,
    method: BridgeRequest["method"],
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    timeoutMs = this.config.timeoutMs,
  ): Promise<any> {
    const machine = this.config.machines.find((m) => m.id === machineId);
    if (!machine)
      throw new FleetError("unknown_machine", `Unknown machine: ${machineId}`);
    const request = requestSchema.parse({ method, path, body, timeoutMs });
    if (this.active >= this.config.concurrency)
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active++;
    try {
      if (signal?.aborted)
        throw new FleetError("cancelled", "Request cancelled before dispatch");
      if (machine.transport === "relay") {
        if (!this.relay)
          throw new FleetError(
            "configuration_error",
            "Relay transport is not configured",
          );
        return await this.relay(machine.userId, machine.id, request, signal);
      }
      if (machine.transport === "local")
        return await localRequest(request, machine.bridgeFile, signal);
      if (machine.transport === "http") {
        const token = process.env[machine.tokenEnv];
        if (!token)
          throw new FleetError(
            "configuration_error",
            "Configured token environment variable is missing",
          );
        return await httpRequest(machine.url, token, request, signal);
      }
      // Only a trusted configured executable enters the remote shell. All tool arguments travel over stdin.
      const command = `'${machine.executable.replaceAll("'", "'\\''")}' --proxy`;
      return await new Promise((resolve, reject) => {
        const child = execFile(
          "ssh",
          [
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            machine.host,
            command,
          ],
          { timeout: timeoutMs + 1000, maxBuffer: maxBytes, signal },
          (error, stdout) => {
            if (error) {
              reject(
                new FleetError(
                  "ssh_error",
                  "SSH proxy failed; verify SSH access and remote ftown-mcp installation",
                  method !== "GET",
                ),
              );
              return;
            }
            try {
              const result = JSON.parse(stdout);
              if (result.error)
                reject(
                  new FleetError(
                    result.error.code,
                    result.error.message,
                    result.error.outcomeUnknown,
                    result.error.status,
                  ),
                );
              else resolve(result.data);
            } catch {
              reject(
                new FleetError(
                  "protocol_error",
                  "Invalid SSH proxy response",
                  method !== "GET",
                ),
              );
            }
          },
        );
        child.stdin?.on("error", () => {});
        child.stdin?.end(JSON.stringify(request));
      });
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}
