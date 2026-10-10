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
) {
  const app = express();
  const rootFleet = new Fleet(
    config.fleet,
    relay
      ? (user, id, request, signal) => relay.request(user, id, request, signal)
      : undefined,
  );
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
    express.json({ limit: "16kb" }),
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
  app.use(
    "/mcp",
    rateLimit({
      windowMs: 60000,
      limit: 600,
      keyGenerator: (req) => String(req.auth?.extra?.subject),
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );
  app.post("/mcp", express.json({ limit: "1mb" }), async (req, res) => {
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
        return rootFleet.request(id, ...args);
      },
    };
    const server = createMcpServer(fleet, {
      readOnly: !req.auth!.scopes.includes("mcp:control"),
    });
    // Stateless transport: every request is authenticated and reconstructs its own scoped tool surface.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ error: "MCP request failed" });
    }
  });
  app.all("/mcp", (_req, res) => {
    res.setHeader("Allow", "POST, OPTIONS");
    res.status(405).end();
  });
  app.use(
    (
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
      res.status(status).json({ error: "Invalid request" });
    },
  );
  return app;
}
