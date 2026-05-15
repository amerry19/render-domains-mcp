#!/usr/bin/env -S npx tsx
/**
 * Streamable HTTP transport entry point — for hosted deployment (e.g. on Render).
 *
 * Auth model (matches Render's own MCP and their Python template):
 *   - MCP_API_TOKEN (env, set by Render's `generateValue: true` on deploy)
 *     → Validated against incoming `Authorization: Bearer <token>` headers.
 *     → When unset (local dev), auth is disabled entirely.
 *   - RENDER_API_TOKEN (env, set by you in render.yaml as `sync: false`)
 *     → Used by the server to call api.render.com on the user's behalf.
 *
 * Endpoints:
 *   GET  /health         → liveness probe (no auth)
 *   POST /mcp            → MCP JSON-RPC over Streamable HTTP
 *   GET  /mcp            → SSE stream for server→client messages
 *   DELETE /mcp          → session termination
 */

import { timingSafeEqual } from "node:crypto";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { Request, Response, NextFunction } from "express";

import { createMcpServer } from "./server.js";
import { TaskRegistry } from "./tasks.js";
import { loadGoDaddyConfig, requireEnv } from "./config.js";
import { RenderClient } from "./render.js";
import {
  RenderPassTokenStore,
  renderFormHtml,
  renderResultHtml,
} from "./render-pass.js";

// ----------------------------------------------------------------------------
// Env config
// ----------------------------------------------------------------------------

const renderApiToken = requireEnv("RENDER_API_TOKEN");
const mcpApiToken = process.env.MCP_API_TOKEN; // optional — when set, enables bearer auth
const goDaddy = loadGoDaddyConfig();

const port = Number.parseInt(process.env.PORT ?? "10000", 10);
const host = "0.0.0.0";
const externalHost = process.env.RENDER_EXTERNAL_HOSTNAME; // Render injects this on deploy
const allowedHosts = externalHost ? [externalHost, "localhost"] : undefined;

// ----------------------------------------------------------------------------
// Express app + bearer auth
// ----------------------------------------------------------------------------

const app = createMcpExpressApp({ host, allowedHosts });

// urlencoded parser for the Render Pass form POST
app.use(express.urlencoded({ extended: false, limit: "16kb" }));

// Health check — must precede auth middleware so it's publicly reachable.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "render-domains-mcp", auth: mcpApiToken ? "enabled" : "disabled" });
});

// ----------------------------------------------------------------------------
// Render Pass — browser intake routes (BEFORE auth middleware so the user's
// browser can reach them without a bearer token; the token in the URL is the
// auth)
// ----------------------------------------------------------------------------

const passTokenStore = new RenderPassTokenStore();
const renderClient = new RenderClient(renderApiToken);

app.get("/render-pass/:token", (req, res) => {
  const pass = passTokenStore.get(req.params.token);
  if (!pass) {
    res.status(404).type("html").send(renderResultHtml({ ok: false }));
    return;
  }
  res.type("html").send(
    renderFormHtml({
      token: pass.token,
      requestedKeys: pass.requestedKeys,
      description: pass.description,
    })
  );
});

app.post("/render-pass/:token", (req, res) => {
  void (async () => {
    const pass = passTokenStore.consume(req.params.token);
    if (!pass) {
      res.status(404).type("html").send(renderResultHtml({ ok: false }));
      return;
    }
    const body = (req.body ?? {}) as Record<string, string>;
    const secrets = pass.requestedKeys.map((key) => ({ key, value: body[key] ?? "" }));
    const missing = secrets.filter((s) => !s.value);
    if (missing.length > 0) {
      res
        .status(400)
        .type("html")
        .send(
          renderResultHtml({
            ok: false,
            message: `Missing value(s) for: ${missing.map((m) => m.key).join(", ")}`,
          })
        );
      return;
    }
    try {
      await renderClient.setEnvVars(pass.serviceId, secrets);
      res.type("html").send(renderResultHtml({ ok: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res
        .status(500)
        .type("html")
        .send(renderResultHtml({ ok: false, message: `Failed to write env vars: ${message}` }));
    }
  })();
});

// OAuth 2.0 / RFC 6750 shaped 401 response. The MCP TypeScript SDK runs an
// OAuth discovery probe on initial HTTP connection and Zod-validates the
// response body; it expects `error: string` (not the JSON-RPC `error: object`
// shape). Using the OAuth-bearer error format lets the SDK's auth flow fail
// cleanly into "use the bearer token from the client config" instead of
// bombing on a schema mismatch. Defense-in-depth: we also include the
// canonical `WWW-Authenticate` header per RFC 6750 §3.
const UNAUTHORIZED = {
  error: "invalid_token",
  error_description: "Missing or invalid Authorization bearer token.",
} as const;

const WWW_AUTHENTICATE =
  'Bearer realm="render-domains-mcp", error="invalid_token", ' +
  'error_description="Missing or invalid Authorization bearer token."';

function sendUnauthorized(res: Response): Response {
  return res.status(401).setHeader("WWW-Authenticate", WWW_AUTHENTICATE).json(UNAUTHORIZED);
}

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") return next();
  if (!mcpApiToken) return next(); // local dev — auth disabled

  const provided = req.header("Authorization") ?? "";
  const expected = `Bearer ${mcpApiToken}`;

  // Length check before timingSafeEqual (which requires equal-length buffers).
  if (provided.length !== expected.length) {
    return sendUnauthorized(res);
  }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return sendUnauthorized(res);
  }

  next();
});

// ----------------------------------------------------------------------------
// MCP server + stateless Streamable HTTP transport
// ----------------------------------------------------------------------------

// Module-scoped: survives across requests so verify_status can find the task
// created by an earlier verify call. For multi-instance deploys, swap for
// Render KV or Postgres-backed storage.
const sharedTaskRegistry = new TaskRegistry();

// Each request gets its own transport + server (stateless mode, matching
// Render's own Python template). Avoids "Server already initialized" when
// multiple clients connect; app-level state lives in sharedTaskRegistry.
async function handleMcpRequest(req: Request, res: Response, body?: unknown): Promise<void> {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer({
    renderApiToken,
    taskRegistry: sharedTaskRegistry,
    passTokenStore,
    goDaddy,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

app.post("/mcp", (req, res) => void handleMcpRequest(req, res, req.body));
app.get("/mcp", (req, res) => void handleMcpRequest(req, res));
app.delete("/mcp", (req, res) => void handleMcpRequest(req, res));

// ----------------------------------------------------------------------------
// Listen
// ----------------------------------------------------------------------------

app.listen(port, host, () => {
  console.error(`[render-domains-mcp] HTTP server listening on ${host}:${port}`);
  console.error(
    `[render-domains-mcp] auth: ${
      mcpApiToken ? "enabled (Bearer)" : "DISABLED (no MCP_API_TOKEN set — local dev only!)"
    }`
  );
  if (goDaddy) console.error("[render-domains-mcp] GoDaddy adapter enabled");
  if (externalHost) console.error(`[render-domains-mcp] external URL: https://${externalHost}/mcp`);
});
