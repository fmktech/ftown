import { after } from "next/server";
import jwt from "jsonwebtoken";
import { Centrifuge } from "centrifuge";
import { getDb } from "@/lib/db";
import { PENDING_NORMALIZED_EMAIL_SQL } from "@/lib/pending-approval-store";
import { getRequiredSecret } from "@/lib/secrets";
import { securityNudge, securityNudgeChannel, type SecurityNudgeScope } from "@security/security-nudge";

const TIMEOUT_MS = 3000;
type Scopes = SecurityNudgeScope | SecurityNudgeScope[];

export interface ServerNudgeDeps {
  signToken?: (email: string) => string;
  centrifugoUrl?: () => string | null;
  createClient?: (url: string, token: string) => Centrifuge;
}

function defaultSignToken(email: string): string {
  return jwt.sign({ sub: email }, getRequiredSecret("CENTRIFUGO_TOKEN_SECRET"), { audience: "ftown:centrifugo", expiresIn: "60s" });
}

/** Best-effort: a server-side nudge never blocks or fails the mutation that caused it. */
export async function publishOwnerSecurityNudge(ownerEmail: string, scope: Scopes, deps: ServerNudgeDeps = {}): Promise<void> {
  let client: Centrifuge | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const url = (deps.centrifugoUrl ?? (() => process.env.NEXT_PUBLIC_CENTRIFUGO_URL || null))();
    if (!url || !ownerEmail) return;
    const token = (deps.signToken ?? defaultSignToken)(ownerEmail);
    const channel = securityNudgeChannel(ownerEmail);
    const created = (deps.createClient ?? ((u, t) => new Centrifuge(u, { token: t, websocket: WebSocket })))(url, token);
    client = created;
    await new Promise<void>(resolve => {
      timer = setTimeout(resolve, TIMEOUT_MS);
      created.on("connected", () => {
        Promise.all([scope].flat().map(item => created.publish(channel, securityNudge(item)))).then(() => resolve(), () => resolve());
      });
      created.on("error", () => { /* the timeout or a later connect decides */ });
      created.connect();
    });
  } catch {
    // swallowed by contract
  } finally {
    if (timer) clearTimeout(timer);
    try { client?.disconnect(); } catch { /* already closed */ }
  }
}

async function emailWhere(sql: string, param: string): Promise<string | null> {
  const rows = await getDb().query(sql, [param]);
  return rows.length === 1 && typeof rows[0].email === "string" ? rows[0].email : null;
}

/** For callers that know the authenticated owner's user id. */
export async function nudgeOwnerById(ownerId: string, scope: Scopes): Promise<void> {
  try {
    const email = await emailWhere("SELECT email FROM users WHERE id::text=$1", ownerId);
    if (email) await publishOwnerSecurityNudge(email, scope);
  } catch { /* best effort */ }
}

/** For the pending-approval store's normalized routing target; an unknown or ambiguous target is a no-op. */
export async function nudgeOwnerByTarget(target: string, scope: Scopes): Promise<void> {
  try {
    const rows = await getDb().query(`SELECT email FROM users WHERE ${PENDING_NORMALIZED_EMAIL_SQL}=$1 LIMIT 2`, [target]);
    if (rows.length === 1 && typeof rows[0].email === "string") await publishOwnerSecurityNudge(rows[0].email, scope);
  } catch { /* best effort */ }
}

/** `after()` throws outside a request scope; run inline there instead of losing the nudge. */
export function afterResponse(work: () => Promise<void>): void {
  try { after(work); } catch { void work(); }
}

/** Publishes only when the store reports that this very call wrote state. */
export function nudgePendingChange(store: { change: { target: string; account: boolean } | null }): void {
  const change = store.change;
  if (!change) return;
  afterResponse(async () => { await nudgeOwnerByTarget(change.target, change.account ? ["approvals", "account"] : "approvals"); });
}
