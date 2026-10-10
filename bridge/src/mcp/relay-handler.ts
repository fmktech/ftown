import { createHash } from "node:crypto";
import {
  requestSchema,
  httpRequest,
  errorResult,
  FleetError,
} from "./fleet.js";

export function createRelayHandler(port: number, token: string) {
  const recent = new Map<
    string,
    { fingerprint: string; expires: number; promise: Promise<unknown> }
  >();
  return async (id: string, payload: Record<string, unknown>) => {
    const request = requestSchema.parse(payload.request);
    if (
      typeof payload.expiresAt !== "number" ||
      payload.expiresAt <= Date.now() ||
      payload.expiresAt > Date.now() + 65000
    )
      throw new Error("Expired relay request");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const existing = recent.get(id);
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new Error("Request ID already used");
      return existing.promise;
    }
    for (const [key, value] of recent)
      if (value.expires < Date.now()) recent.delete(key);
    if (recent.size >= 10000) throw new Error("Relay request capacity reached");
    const promise = (async () => {
      try {
        const data = await httpRequest(`http://127.0.0.1:${port}`, token, {
          ...request,
          timeoutMs: Math.max(
            1000,
            Math.min(
              request.timeoutMs,
              (payload.expiresAt as number) - Date.now(),
            ),
          ),
        });
        if (Buffer.byteLength(JSON.stringify(data)) > 400000)
          throw new FleetError(
            "response_too_large",
            "Relay result is too large; request a smaller page",
            request.method !== "GET",
          );
        return { data };
      } catch (e) {
        return { error: errorResult(e) };
      }
    })();
    recent.set(id, { fingerprint, expires: Date.now() + 120000, promise });
    return promise;
  };
}
