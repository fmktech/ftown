import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Response } from "express";
import type {
  OAuthServerProvider,
  AuthorizationParams,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
  InvalidRequestError,
  InvalidScopeError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthStore, OAuthTransaction } from "./oauth-store.js";
import { z } from 'zod';
import { open, parseSecureEnvelope } from '../security/crypto.js';
import type { ApprovedBridge } from '../security/protocol.js';
import type { McpIdentityStore } from './mcp-key-store.js';

const secretToken = () => randomBytes(32).toString("base64url");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const now = () => Math.floor(Date.now() / 1000);
export const MCP_SCOPES = ["mcp:read", "mcp:control"];
interface Pending {
  clientId: string;
  clientName: string;
  redirectUri: string;
  challenge: string;
  state?: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
  subject?: string;
  grantId?: string;
}
interface Code extends Pending {
  subject: string;
  machines: string[];
  grantId: string;
  activeExpiresAt: string;
}
interface Grant {
  resource: string;
  subject: string;
  machines: string[];
  scopes: string[];
  clientId: string;
  expiresAt: number;
  revoked: boolean;
}
interface TokenRecord {
  grantId: string;
  clientId: string;
  expiresAt: number;
  used?: boolean;
  scopes: string[];
}
export interface OAuthOptions {
  publicUrl: string;
  loginUrl: string;
  approvalSecret: string;
  access: Array<{ subject: string; machines: string[] }>;
}
export class FtownOAuthProvider implements OAuthServerProvider {
  readonly resource: string;
  constructor(
    readonly store: OAuthStore,
    readonly options: OAuthOptions,
    readonly keys?: McpIdentityStore,
  ) {
    this.resource = new URL("/mcp", options.publicUrl).href;
  }
  private currentMachines(subject: string) {
    return (
      this.options.access.find((a) => a.subject === subject)?.machines ?? []
    );
  }
  readonly clientsStore = {
    getClient: (id: string) =>
      this.store.transaction((tx) =>
        tx.get<OAuthClientInformationFull>("client", id),
      ),
    registerClient: async (
      input: Omit<
        OAuthClientInformationFull,
        "client_id" | "client_id_issued_at"
      >,
    ): Promise<OAuthClientInformationFull> => {
      // Public clients only: PKCE is mandatory; never persist an unneeded client secret.
      if (
        input.token_endpoint_auth_method &&
        input.token_endpoint_auth_method !== "none"
      )
        throw new InvalidRequestError("Only public PKCE clients are supported");
      if (
        input.redirect_uris.length > 10 ||
        input.redirect_uris.some((uri) => {
          const u = new URL(uri);
          return (
            !!(u.hash || u.username || u.password) ||
            !(
              u.protocol === "https:" ||
              (u.protocol === "http:" &&
                ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname))
            )
          );
        })
      )
        throw new InvalidRequestError(
          "Redirect URIs require HTTPS or loopback HTTP",
        );
      const client: OAuthClientInformationFull = {
        client_id: secretToken(),
        client_id_issued_at: now(),
        client_name: input.client_name?.slice(0, 200),
        redirect_uris: input.redirect_uris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      };
      await this.store.transaction((tx) =>
        tx.put("client", client.client_id, client, now() + 365 * 86400),
      );
      return client;
    },
  };
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ) {
    if (params.resource?.href !== this.resource)
      throw new InvalidRequestError("resource must identify this MCP endpoint");
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge))
      throw new InvalidRequestError("S256 PKCE challenge required");
    const scopes = params.scopes?.length
      ? [...new Set(params.scopes)]
      : ["mcp:read"];
    if (
      !scopes.includes("mcp:read") ||
      scopes.some((s) => !MCP_SCOPES.includes(s))
    )
      throw new InvalidScopeError("Supported scopes: mcp:read and mcp:control");
    const id = secretToken();
    const pending: Pending = {
      clientId: client.client_id,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
      challenge: params.codeChallenge,
      state: params.state,
      scopes,
      resource: this.resource,
      expiresAt: now() + 600,
    };
    await this.store.transaction((tx) =>
      tx.put("pending", id, pending, now() + 600),
    );
    const consent = new URL("/mcp/consent", this.options.loginUrl);
    consent.searchParams.set("request", id);
    res.redirect(consent.href);
  }
  private assertion(token: string, purpose: "inspect" | "approve" | "deny") {
    const value = jwt.verify(token, this.options.approvalSecret, {
      algorithms: ["HS256"],
      audience: this.options.publicUrl,
      issuer: this.options.loginUrl,
      maxAge: "60s",
    });
    if (
      typeof value === "string" ||
      typeof value.sub !== "string" ||
      typeof value.request !== "string" ||
      value.purpose !== purpose
    )
      throw new InvalidRequestError("Invalid approval assertion");
    return value;
  }
  async consentDetails(assertion: string) {
    const claims = this.assertion(assertion, "inspect");
    const { pending, owned } = await this.store.transaction(async (tx) => ({
      pending: await tx.get<Pending>("pending", claims.request),
      owned: await tx.ownedMachines(claims.sub!),
    }));
    if (!pending || pending.resource !== this.resource || !pending.expiresAt || (pending.subject && pending.subject !== claims.sub))
      throw new InvalidRequestError("Authorization request expired");
    if (!this.keys) throw new InvalidRequestError('Encrypted MCP identities must be configured');
    const security = await this.keys.ensurePendingIdentity(claims.request, claims.sub!, pending.scopes.includes('mcp:control') ? ['read', 'control'] : ['read']);
    await this.store.transaction(async tx => {
      const current = await tx.get<Pending>('pending', claims.request);
      if (!current || (current.subject && current.subject !== claims.sub)) throw new InvalidRequestError('Authorization request expired');
      await tx.put('pending', claims.request, { ...current, subject: claims.sub, grantId: security.grantId }, current.expiresAt);
    });
    return {
      clientName: pending.clientName,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      machines: this.currentMachines(claims.sub!).filter((m) =>
        owned.includes(m),
      ),
      security,
    };
  }
  async approve(assertion: string, deny = false) {
    const claims = this.assertion(assertion, deny ? "deny" : "approve");
    // Never hold an OAuth pool connection while the key store acquires another.
    const { pending, owned } = await this.store.transaction(async tx => ({
      pending: await tx.get<Pending>('pending', claims.request),
      owned: deny ? [] : await tx.ownedMachines(claims.sub!),
    }));
    if (!pending || pending.resource !== this.resource) throw new InvalidRequestError('Authorization request expired or already handled');
    const redirect = new URL(pending.redirectUri);
    if (pending.state !== undefined) redirect.searchParams.set('state', pending.state);
    redirect.searchParams.set('iss', this.options.publicUrl);
    if (deny) {
      await this.store.transaction(async tx => {
        if (!await tx.take<Pending>('pending', claims.request)) throw new InvalidRequestError('Authorization request expired or already handled');
      });
      redirect.searchParams.set('error', 'access_denied');
      return redirect.href;
    }
    if (!this.keys || pending.subject !== claims.sub || !pending.grantId) throw new InvalidRequestError('Inspect and approve the encrypted endpoint before continuing');
    const machines = claims.machines;
    const allowed = this.currentMachines(claims.sub!).filter(machine => owned.includes(machine));
    if (!Array.isArray(machines) || !machines.length || machines.some(machine => typeof machine !== 'string' || !allowed.includes(machine))) throw new InvalidRequestError('No authorized machines selected');
    const selected = [...new Set(machines)] as string[];
    if (selected.length > 64) throw new InvalidRequestError('Select at most 64 computers');
    const identity = await this.keys.loadByRequest(claims.sub!, claims.request);
    if (identity.grantId !== pending.grantId || identity.state !== 'pending' || Date.parse(identity.pendingExpiresAt) <= Date.now()) throw new InvalidRequestError('Encrypted endpoint approval expired');
    const pins = await this.approvalPins(claims.approvals, selected, identity);
    // The row-locked transition permits one winner. If code persistence fails,
    // the orphan approval has no usable OAuth token and fresh consent is required.
    await this.keys.approve(claims.sub!, claims.request, pins);
    const code = secretToken();
    await this.store.transaction(async tx => {
      const current = await tx.take<Pending>('pending', claims.request);
      if (!current || current.subject !== claims.sub || current.grantId !== identity.grantId || JSON.stringify(current) !== JSON.stringify(pending)) throw new InvalidRequestError('Authorization request expired or already handled');
      const currentOwned = await tx.ownedMachines(claims.sub!);
      if (selected.some(machine => !currentOwned.includes(machine) || !this.currentMachines(claims.sub!).includes(machine))) throw new InvalidRequestError('Machine access revoked');
      await tx.put('code', hash(code), { ...current, subject: claims.sub!, machines: selected, grantId: identity.grantId, activeExpiresAt: identity.activeExpiresAt } satisfies Code, now() + 120);
    });
    redirect.searchParams.set('code', code);
    return redirect.href;
  }
  private async approvalPins(value: unknown, machines: string[], identity: Awaited<ReturnType<McpIdentityStore['loadByRequest']>>): Promise<ApprovedBridge[]> {
    const endpoint = z.object({ version: z.literal(1), id: z.string().regex(/^[A-Za-z0-9_-]{43}$/), ownerId: z.string().guid(), kind: z.literal('bridge'), publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/) }).strict();
    const approvals = z.array(z.object({ bridgeId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/), bridge: endpoint, receipt: z.unknown().optional() }).strict()).min(1).max(64).safeParse(value);
    if (!approvals.success || approvals.data.length !== machines.length || new Set(approvals.data.map(approval => approval.bridgeId)).size !== machines.length) throw new InvalidRequestError('Every selected bridge must return encrypted approval');
    const pins: ApprovedBridge[] = [];
    for (const approval of approvals.data) {
      if (!machines.includes(approval.bridgeId) || approval.bridge.ownerId !== identity.ownerId) throw new InvalidRequestError('Bridge approval does not match this account');
      let receipt: unknown;
      try {
        const envelope = parseSecureEnvelope(approval.receipt);
        receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await open(identity.identity, approval.bridge, envelope, { ownerId: identity.ownerId, bridgeId: approval.bridgeId, channel: `mcp-approval:${approval.bridgeId}:${identity.requestId}`, recipientId: identity.identity.endpoint.id, purpose: 'mcp-approval' })));
      } catch { throw new InvalidRequestError('Bridge encrypted approval could not be verified'); }
      const parsed = z.object({ type: z.literal('mcp-approval'), approvalId: z.string().min(1).max(200), requestId: z.literal(identity.requestId), ownerId: z.literal(identity.ownerId), grantId: z.literal(identity.grantId), candidateEndpointId: z.literal(identity.identity.endpoint.id), bridgeId: z.literal(approval.bridgeId), bridge: endpoint, permissions: z.array(z.enum(['read', 'control'])).min(1).max(2), expiresAt: z.string().datetime(), activeExpiresAt: z.literal(identity.activeExpiresAt) }).strict().safeParse(receipt);
      if (!parsed.success || parsed.data.bridge.id !== approval.bridge.id || parsed.data.bridge.publicKey !== approval.bridge.publicKey
        || [...parsed.data.permissions].sort().join(' ') !== [...identity.permissions].sort().join(' ')
        || Date.parse(parsed.data.expiresAt) <= Date.now() || Date.parse(parsed.data.expiresAt) > Date.parse(identity.pendingExpiresAt)) throw new InvalidRequestError('Bridge approval does not match this consent');
      pins.push({ bridgeId: approval.bridgeId, endpoint: approval.bridge, permissions: parsed.data.permissions });
    }
    return pins;
  }
  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
  ) {
    const record = await this.store.transaction((tx) =>
      tx.get<Code>("code", hash(code)),
    );
    if (!record || record.clientId !== client.client_id)
      throw new InvalidGrantError("Invalid authorization code");
    return record.challenge;
  }
  private async tokens(
    tx: OAuthTransaction,
    grantId: string,
    grant: Grant,
    scopes: string[],
  ): Promise<OAuthTokens> {
    const access = secretToken(),
      refresh = secretToken();
    await tx.put(
      "access",
      hash(access),
      { grantId, clientId: grant.clientId, expiresAt: now() + 900, scopes },
      now() + 900,
    );
    await tx.put(
      "refresh",
      hash(refresh),
      { grantId, clientId: grant.clientId, expiresAt: grant.expiresAt, scopes },
      grant.expiresAt,
    );
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: refresh,
      scope: scopes.join(" "),
    };
  }
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _verifier?: string,
    redirectUri?: string,
    resource?: URL,
  ) {
    const prepared = await this.store.transaction(tx => tx.get<Code>('code', hash(code)));
    if (!prepared || prepared.clientId !== client.client_id || prepared.redirectUri !== redirectUri || prepared.resource !== this.resource || resource?.href !== this.resource) throw new InvalidGrantError('Invalid code, redirect URI or resource');
    if (!this.keys || !prepared.grantId || !prepared.activeExpiresAt) throw new InvalidGrantError('Renew consent to authorize an encrypted endpoint');
    const identity = await this.keys.loadGrantIdentity(prepared.subject, prepared.grantId);
    if (identity.state !== 'approved' || identity.activeExpiresAt !== prepared.activeExpiresAt) throw new InvalidGrantError('Encrypted endpoint consent is unavailable');
    return this.store.transaction(async (tx) => {
      const record = await tx.take<Code>('code', hash(code));
      if (!record || JSON.stringify(record) !== JSON.stringify(prepared)) throw new InvalidGrantError('Invalid or already used authorization code');
      const grantId = record.grantId;
      const grant: Grant = {
        resource: this.resource,
        subject: record.subject,
        machines: record.machines,
        scopes: record.scopes,
        clientId: client.client_id,
        expiresAt: Math.floor(Date.parse(record.activeExpiresAt) / 1000),
        revoked: false,
      };
      await tx.put("grant", grantId, grant, grant.expiresAt);
      return this.tokens(tx, grantId, grant, grant.scopes);
    });
  }
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    token: string,
    scopes?: string[],
    resource?: URL,
  ) {
    if (resource?.href !== this.resource)
      throw new InvalidGrantError("Wrong resource");
    const result = await this.store.transaction(async (tx) => {
      const record = await tx.get<TokenRecord>("refresh", hash(token));
      if (!record || record.clientId !== client.client_id)
        throw new InvalidGrantError("Invalid refresh token");
      await tx.lock(record.grantId);
      const current = await tx.get<TokenRecord>("refresh", hash(token));
      const grant = await tx.get<Grant>("grant", record.grantId);
      if (!grant || grant.revoked || grant.resource !== this.resource)
        throw new InvalidGrantError("Grant revoked or expired");
      if (current?.used) {
        await tx.put(
          "grant",
          record.grantId,
          { ...grant, revoked: true },
          grant.expiresAt,
        );
        return null; // Commit replay revocation before returning the error.
      }
      const requested = scopes ?? record.scopes;
      if (
        !requested.includes("mcp:read") ||
        requested.some((s) => !record.scopes.includes(s))
      )
        throw new InvalidScopeError("Refresh cannot expand scope");
      await tx.put(
        "refresh",
        hash(token),
        { ...record, used: true },
        record.expiresAt,
      );
      return this.tokens(tx, record.grantId, grant, requested);
    });
    if (!result)
      throw new InvalidGrantError(
        "Refresh token reused; authorization revoked",
      );
    return result;
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const result = await this.store.transaction(async (tx) => {
      const record = await tx.get<TokenRecord>("access", hash(token));
      const grant = record && (await tx.get<Grant>("grant", record.grantId));
      if (!record || !grant || grant.revoked || grant.resource !== this.resource)
        throw new InvalidTokenError("Invalid, expired or revoked access token");
      const owned = await tx.ownedMachines(grant.subject);
      const machines = grant.machines.filter(
        (m) =>
          this.currentMachines(grant.subject).includes(m) && owned.includes(m),
      );
      if (!machines.length)
        throw new InvalidTokenError("Machine access revoked");
      return {
        token,
        clientId: record.clientId,
        scopes: record.scopes,
        expiresAt: record.expiresAt,
        resource: new URL(this.resource),
        extra: { subject: grant.subject, machines, grantId: record.grantId },
      };
    });
    if (!this.keys) throw new InvalidTokenError('Renew consent to authorize an encrypted endpoint');
    let identity;
    try { identity = await this.keys.loadGrantIdentity(result.extra.subject, result.extra.grantId); }
    catch { throw new InvalidTokenError('Encrypted endpoint approval expired or requires renewed consent'); }
    return { ...result, extra: { ...result.extra, endpointId: identity.identity.endpoint.id } };
  }
  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ) {
    await this.store.transaction(async (tx) => {
      const record =
        (await tx.get<TokenRecord>("access", hash(request.token))) ??
        (await tx.get<TokenRecord>("refresh", hash(request.token)));
      if (!record || record.clientId !== client.client_id) return;
      await tx.lock(record.grantId);
      const grant = await tx.get<Grant>("grant", record.grantId);
      if (grant && grant.resource === this.resource)
        await tx.put(
          "grant",
          record.grantId,
          { ...grant, revoked: true },
          grant.expiresAt,
        );
    });
  }
}
