import { createHash, createECDH, ECDH } from "node:crypto";
import { request as httpsRequest } from "node:https";
import jwt from "jsonwebtoken";
import webpush from "web-push";
import { isValidBridgeLabel } from "@/lib/bridge-label";
import { getDb } from "@/lib/db";
import { getRequiredSecret } from "@/lib/secrets";
import { isTrustedBrowserOrigin } from '@/lib/request-origin';

export class PushError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
export interface PushConfig { publicKey: string; privateKey: string; subject: string }
export interface BrowserSubscription { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushEvent {
  sessionId: string; sessionName: string; kind: "question" | "idle";
  eventKey: string; title: string; message: string; occurredAt: string;
}
/** Public push providers/control-plane storage receive routing references only. */
export function genericPushEvent(event: Pick<PushEvent, 'sessionId' | 'kind' | 'eventKey' | 'occurredAt'>): PushEvent {
  return { sessionId: event.sessionId, kind: event.kind, eventKey: event.eventKey, occurredAt: event.occurredAt,
    sessionName: 'FTown', title: 'FTown attention', message: 'Open FTown to view details.' };
}
export function pushConfig(): PushConfig | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  try {
    if (Buffer.from(publicKey, "base64url").length !== 65 || Buffer.from(privateKey, "base64url").length !== 32) return null;
    const curve = createECDH("prime256v1"); curve.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (!curve.getPublicKey().equals(Buffer.from(publicKey, "base64url"))) return null;
    const parsed = new URL(subject);
    if (!["https:", "mailto:"].includes(parsed.protocol)) return null;
    return { publicKey, privateKey, subject };
  } catch { return null; }
}
export function endpointAllowed(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    const vendor = u.hostname === "fcm.googleapis.com" || u.hostname === "web.push.apple.com"
      || u.hostname === "push.services.mozilla.com" || u.hostname.endsWith(".push.services.mozilla.com")
      || u.hostname === "notify.windows.com" || u.hostname.endsWith(".notify.windows.com");
    return endpoint.length <= 2048 && u.protocol === "https:" && !u.username && !u.password && !u.port && !u.hash && vendor;
  } catch { return false; }
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function key(value: unknown, bytes: number): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").length === bytes;
}
export function parseSubscription(value: unknown): BrowserSubscription {
  if (!record(value) || typeof value.endpoint !== "string" || !endpointAllowed(value.endpoint)
    || !record(value.keys) || !key(value.keys.p256dh, 65) || !key(value.keys.auth, 16)
    || Buffer.from(value.keys.p256dh, "base64url")[0] !== 4) throw new PushError("invalid_subscription", 400);
  try { ECDH.convertKey(Buffer.from(value.keys.p256dh, "base64url"), "prime256v1"); } catch { throw new PushError("invalid_subscription",400); }
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}
export function cleanPushText(value: string, limit: number): string {
  return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[redacted]")
    .replace(/\b((?:[A-Z_]*(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)[A-Z_]*|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, "[redacted]").trim().slice(0, limit);
}
export function parsePushEvent(value: unknown, now = Date.now()): PushEvent {
  if (!record(value) || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(value.sessionId)
    || typeof value.sessionName !== "string" || value.sessionName.length > 200
    || !["question", "idle"].includes(String(value.kind)) || typeof value.eventKey !== "string"
    || (value.kind === "idle" ? value.eventKey !== "idle" && !/^idle:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.eventKey) : !/^question:[a-f0-9-]{36}$/.test(value.eventKey))
    || typeof value.title !== "string" || value.title.length > 200 || typeof value.message !== "string" || value.message.length > 2000
    || typeof value.occurredAt !== "string" || !Number.isFinite(Date.parse(value.occurredAt))
    || Date.parse(value.occurredAt) > now + 60_000 || Date.parse(value.occurredAt) < now - 600_000) throw new PushError("invalid_event", 400);
  return genericPushEvent({ sessionId: value.sessionId, kind: value.kind as PushEvent["kind"],
    eventKey: value.eventKey, occurredAt: new Date(value.occurredAt).toISOString() });
}
export function eventIdentity(owner: string, bridge: string, event: Pick<PushEvent, "sessionId" | "eventKey">): string {
  return createHash("sha256").update(JSON.stringify([owner, bridge, event.sessionId, event.eventKey])).digest("hex");
}
export function endpointHash(endpoint: string): string { return createHash("sha256").update(endpoint).digest("hex"); }
export function requireSameOrigin(request: Request): void {
  if (!isTrustedBrowserOrigin(request)) throw new PushError("forbidden_origin", 403);
}
export async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get("content-length")) > 16_384) throw new PushError("payload_too_large", 413);
  if (!request.body) throw new PushError("invalid_json", 400);
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > 16_384) { await reader.cancel(); throw new PushError("payload_too_large", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) { if (error instanceof PushError) throw error; throw new PushError("invalid_json", 400); }
}
export async function bridgePushIdentity(request: Request): Promise<{ owner: string; bridgeId: string }> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new PushError("unauthorized", 401);
  let decoded: unknown;
  try { decoded = jwt.verify(authorization.slice(7), getRequiredSecret("CENTRIFUGO_TOKEN_SECRET"), { audience: "ftown:centrifugo", algorithms: ["HS256"] }); }
  catch { throw new PushError("unauthorized", 401); }
  if (!record(decoded) || typeof decoded.sub !== "string" || !record(decoded.info)
    || !isValidBridgeLabel(decoded.info.bridgeId)) throw new PushError("unauthorized", 401);
  const rows = await getDb().query("SELECT bridge_id FROM bridge_refresh WHERE bridge_id = $1 AND sub = $2 AND current_jti <> 'revoked'", [decoded.info.bridgeId, decoded.sub]);
  if (rows.length !== 1) throw new PushError("forbidden_bridge", 403);
  return { owner: decoded.sub, bridgeId: decoded.info.bridgeId };
}
/** Encrypt via web-push; bound the complete HTTPS request and never follow redirects. */
export async function sendBrowserPush(subscription: BrowserSubscription, payload: string, config: PushConfig): Promise<number> {
  if (!endpointAllowed(subscription.endpoint)) throw new PushError("invalid_subscription", 400);
  const details = webpush.generateRequestDetails(subscription, payload, { vapidDetails: config, TTL: 300, urgency: "high" });
  return new Promise((resolve, reject) => {
    const req = httpsRequest(subscription.endpoint, { method: details.method, headers: details.headers, signal: AbortSignal.timeout(5_000) }, (res) => {
      res.resume(); res.once("end", () => resolve(res.statusCode ?? 503));
      res.once("error", reject);
    });
    req.once("error", reject); req.end(details.body);
  });
}
