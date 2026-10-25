import express from "express";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  mcpAuthRouter,
  createOAuthMetadata,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { z } from "zod";
import { configSchema, Fleet, FleetError } from "./fleet.js";
import type { FleetRelay } from "./relay.js";
import { createMcpServer } from "./server.js";
import { FtownOAuthProvider, MCP_SCOPES } from "./oauth.js";
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { errorResult } from './fleet.js';
import { SecurityEventStore, READ_MCP_TOOLS, safeTool, safeFailureCode, securityOutcome, finishSecurityEvent, type SecurityOutcome, type SecurityFinalizationState } from './security-events.js';
import type { McpActionContext, SecurityEvent } from '../security/protocol.js';

const httpsOrigin = z
  .string()
  .url()
  .refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && u.origin === s;
  }, "An HTTPS origin without a trailing slash is required");
export const gatewayConfigSchema = z
  .object({
    publicUrl: httpsOrigin,
    loginUrl: httpsOrigin,
    allowedOrigins: z.array(httpsOrigin).default([]),
    fleet: configSchema,
    access: z
      .array(
        z
          .object({
            subject: z.string().min(1),
            machines: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.access.map((a) => a.subject)).size !== c.access.length)
      ctx.addIssue({ code: "custom", message: "Duplicate account subject" });
    for (const a of c.access)
      if (a.machines.some((id) => !c.fleet.machines.some((m) => m.id === id)))
        ctx.addIssue({
          code: "custom",
          message: "Access references an unknown machine",
        });
  });
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export function createGateway(
  config: GatewayConfig,
  provider: FtownOAuthProvider,
  relay?: FleetRelay,
  audit?: Pick<SecurityEventStore, 'admit' | 'finish'>,
) {
  const app = express();
  const rootFleet = new Fleet(
    config.fleet,
    relay
      ? (user, id, request, signal, context) => relay.request(user, id, request, signal, context)
      : undefined,
  );
  const actions = new AsyncLocalStorage<McpActionContext>();
  interface RequestState extends SecurityFinalizationState { action: McpActionContext; dispatched: boolean }
  const states = new WeakMap<express.Request, RequestState>();
  const finish = (state: RequestState, outcome: SecurityOutcome) => finishSecurityEvent(audit, state, outcome);
  const admission = async (req: express.Request, res: express.Response): Promise<RequestState> => {
    if (!audit || !provider.keys) throw new FleetError('security_setup_required', 'Encrypted MCP storage and security audit must be configured');
    const subject = String(req.auth!.extra!.subject);
    const tool = req.body?.method === 'tools/call' ? safeTool(req.body?.params?.name)
      : req.body?.method === 'initialize' ? 'initialize' : req.body?.method === 'tools/list' ? 'tools_list'
      : req.body?.method === 'resources/list' ? 'resources_list' : req.body?.method === 'resources/read' ? 'resources_read'
      : req.body?.id === undefined ? 'protocol_notification' : 'protocol_request';
    const target = req.body?.params?.arguments;
    const allowed = req.auth!.extra!.machines as string[];
    const actionId = randomUUID();
    const action: McpActionContext = { actionId, parentActionId: null, clientId: req.auth!.clientId, grantId: String(req.auth!.extra!.grantId), tool, operation: null };
    const event: SecurityEvent = {
      version: 1, id: actionId, actionId, parentActionId: null, ownerId: subject, source: 'gateway',
      bridgeId: typeof target?.machine === 'string' && allowed.includes(target.machine) ? target.machine : null,
      clientId: action.clientId, grantId: action.grantId, endpointId: String(req.auth!.extra!.endpointId), tool, operation: null,
      sessionId: typeof target?.sessionId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(target.sessionId) ? target.sessionId : null,
      startedAt: new Date().toISOString(), finishedAt: null, status: 'started', errorCode: null,
      mutating: req.body?.method === 'tools/call' && !READ_MCP_TOOLS.has(tool),
    };
    await audit.admit(event);
    const state = { event, action, finished: false, dispatched: false };
    states.set(req, state);
    res.once('close', () => {
      if (!state.finished) void finish(state, { status: state.dispatched ? 'unknown' : 'rejected', errorCode: state.dispatched ? 'outcome_unknown' : res.statusCode >= 400 ? 'invalid_request' : 'cancelled' }).catch(() => {});
    });
    return state;
  };
  app.disable("x-powered-by");
  // Fly's edge is the sole HTTP ingress; forwarded headers are not used for authorization.
  app.set("trust proxy", 1);
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    if (req.headers.host !== new URL(config.publicUrl).host) {
      res.status(421).end();
      return;
    }
    if (
      req.headers["x-forwarded-proto"] &&
      req.headers["x-forwarded-proto"] !== "https"
    ) {
      res.status(400).end();
      return;
    }
    next();
  });
  // Keep issuer spelling identical across discovery and authorization responses.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({
      ...createOAuthMetadata({
        provider,
        issuerUrl: new URL(config.publicUrl),
        scopesSupported: MCP_SCOPES,
      }),
      issuer: config.publicUrl,
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  });
  app.get(
    [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ],
    (_req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.json({
        resource: provider.resource,
        authorization_servers: [config.publicUrl],
        scopes_supported: MCP_SCOPES,
        bearer_methods_supported: ["header"],
        resource_name: "ftown agent fleet",
      });
    },
  );
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      resourceServerUrl: new URL(provider.resource),
      scopesSupported: MCP_SCOPES,
      resourceName: "ftown agent fleet",
    }),
  );
  app.use(
    "/consent",
    rateLimit({
      windowMs: 60000,
      limit: 60,
      standardHeaders: true,
      legacyHeaders: false,
    }),
    express.json({ limit: "512kb" }),
  );
  app.post("/consent/:action", async (req, res) => {
    try {
      if (typeof req.body?.assertion !== "string") {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      if (req.params.action === "details")
        res.json(await provider.consentDetails(req.body.assertion));
      else if (req.params.action === "approve" || req.params.action === "deny")
        res.json({
          redirect: await provider.approve(
            req.body.assertion,
            req.params.action === "deny",
          ),
        });
      else res.status(404).end();
    } catch {
      res.status(400).json({ error: "Invalid or expired consent request" });
    }
  });
  app.use("/mcp", (req, res, next) => {
    const origin = req.headers.origin;
    if (
      origin &&
      ![config.loginUrl, ...config.allowedOrigins].includes(origin)
    ) {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "WWW-Authenticate, MCP-Session-Id, MCP-Protocol-Version",
    );
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(
    "/mcp",
    requireBearerAuth({
      verifier: provider,
      requiredScopes: ["mcp:read"],
      resourceMetadataUrl: new URL(
        "/.well-known/oauth-protected-resource/mcp",
        config.publicUrl,
      ).href,
    }),
  );
  app.use('/mcp', express.json({ limit: '1mb' }));
  app.use('/mcp', async (req, res, next) => {
    try { await admission(req, res); next(); }
    catch { res.status(503).json({ error: 'Security audit or encrypted endpoint is unavailable' }); }
  });
  app.use(
    "/mcp",
    rateLimit({
      windowMs: 60000,
      limit: 600,
      keyGenerator: (req) => String(req.auth?.extra?.subject),
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
        const state = states.get(req);
        void (state ? finish(state, { status: 'rejected', errorCode: 'capacity_exceeded' }) : Promise.resolve()).catch(() => {}).finally(() => res.status(429).json({ error: 'MCP request limit exceeded' }));
      },
    }),
  );
  app.post("/mcp", async (req, res) => {
    const state = states.get(req)!;
    let identity;
    try {
      identity = await provider.keys!.loadGrantIdentity(state.event.ownerId, state.action.grantId);
      await provider.keys!.markActive(identity.ownerId, identity.requestId);
    } catch {
      await finish(state, { status: 'rejected', errorCode: 'approval_required' });
      res.status(403).json({ error: 'Renew encrypted bridge consent' }); return;
    }
    const allowed = req.auth!.extra!.machines as string[];
    const fleet: Pick<Fleet, "config" | "request"> = {
      config: {
        ...config.fleet,
        machines: config.fleet.machines.filter((m) => allowed.includes(m.id)),
      },
      request: (id, ...args) => {
        if (!allowed.includes(id))
          return Promise.reject(
            new FleetError(
              "forbidden",
              "Machine is not authorized for this grant",
            ),
          );
        state.dispatched = true;
        return rootFleet.scoped({ grant: identity, action: actions.getStore() ?? state.action, revalidate: async () => {
          const current = await provider.verifyAccessToken(req.auth!.token);
          if (!(current.extra?.machines as string[]).includes(id) || (state.event.mutating && !current.scopes.includes('mcp:control'))) throw new FleetError('forbidden', 'MCP access changed before dispatch');
        } }).request(id, ...args);
      },
    };
    const server = createMcpServer(fleet, {
      readOnly: !req.auth!.scopes.includes("mcp:control"),
      caller: { subject: String(req.auth!.extra!.subject), clientId: req.auth!.clientId, scopes: [...req.auth!.scopes] },
      revalidate: async (machines) => {
        let current;
        try { current = await provider.verifyAccessToken(req.auth!.token); }
        catch { throw new FleetError("forbidden", "Access expired or was revoked during this request"); }
        const authorized = current.extra?.machines as string[];
        if (machines.some((machine) => !authorized.includes(machine))) throw new FleetError("forbidden", "Machine access was revoked during this request");
      },
      runChild: async (name, args, run) => {
        const actionId = randomUUID();
        const child: SecurityEvent = {
          ...state.event, id: actionId, actionId, parentActionId: state.event.actionId, tool: safeTool(name), operation: safeTool(name),
          bridgeId: typeof args.machine === 'string' && allowed.includes(args.machine) ? args.machine : null,
          sessionId: typeof args.sessionId === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(args.sessionId) ? args.sessionId : null,
          startedAt: new Date().toISOString(), mutating: !READ_MCP_TOOLS.has(name),
        };
        await audit!.admit(child);
        const action = { ...state.action, actionId, parentActionId: state.event.actionId, tool: child.tool, operation: child.operation };
        let outcome: SecurityOutcome;
        try {
          const result = await actions.run(action, run);
          outcome = securityOutcome(result);
          await audit!.finish(child, outcome);
          return result;
        } catch (error) {
          const failure = errorResult(error);
          await audit!.finish(child, { status: failure.outcomeUnknown ? 'unknown' : ['forbidden', 'permission_denied'].includes(failure.code) ? 'rejected' : 'failed', errorCode: safeFailureCode(failure.code) });
          throw error;
        }
      },
    });
    // Stateless transport: every request is authenticated and reconstructs its own scoped tool surface.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // Only a bounded attention_wait call opens a request-scoped SSE stream.
      // No GET stream/session map or unsolicited server notifications are advertised.
      enableJsonResponse: !(req.body?.method === "tools/call" && req.body?.params?.name === "attention_wait"),
    });
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ('id' in message && message.id === req.body?.id && ('result' in message || 'error' in message)) {
        let outcome: SecurityOutcome = 'error' in message ? { status: 'rejected', errorCode: message.error.code === -32602 ? 'invalid_arguments' : message.error.code === -32601 ? 'unknown_tool' : 'invalid_request' } : securityOutcome(message.result);
        if (state.event.mutating && !req.auth!.scopes.includes('mcp:control')) outcome = { status: 'rejected', errorCode: 'permission_denied' };
        try { await finish(state, outcome); }
        catch {
          await finish(state, { status: 'unknown', errorCode: 'outcome_unknown' }).catch(() => {});
          await send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Operation outcome is unknown because final audit storage failed', data: { code: 'outcome_unknown', outcomeUnknown: true } } }, options);
          return;
        }
      }
      await send(message, options);
    };
    res.on("close", () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await actions.run(state.action, () => transport.handleRequest(req, res, req.body));
      if (!state.finished && res.statusCode >= 400) await finish(state, { status: 'rejected', errorCode: 'invalid_request' });
      else if (!state.finished && req.body?.id === undefined) await finish(state, { status: 'succeeded', errorCode: null });
    } catch {
      if (!state.finished) await finish(state, { status: state.dispatched && state.event.mutating ? 'unknown' : 'failed', errorCode: state.dispatched && state.event.mutating ? 'outcome_unknown' : 'internal_error' }).catch(() => {});
      if (!res.headersSent)
        res.status(500).json({ error: "MCP request failed" });
    }
  });
  app.all("/mcp", async (_req, res) => {
    const state = states.get(_req);
    if (state) await finish(state, { status: 'rejected', errorCode: 'invalid_request' }).catch(() => {});
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).end();
  });
  app.use(
    async (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 413
          ? 413
          : 400;
      if (_req.auth) {
        try {
          const state = states.get(_req) ?? await admission(_req, res);
          await finish(state, { status: 'rejected', errorCode: 'invalid_request' });
        } catch { res.status(503).json({ error: 'Security audit storage is unavailable' }); return; }
      }
      res.status(status).json({ error: "Invalid request" });
    },
  );
  return app;
}
