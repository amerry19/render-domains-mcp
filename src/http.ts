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
import type { Request, Response, NextFunction } from "express";

import { createMcpServer } from "./server.js";
import { TaskRegistry } from "./tasks.js";
import { loadGoDaddyConfig, requireEnv } from "./config.js";

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

// Health check — must precede auth middleware so it's publicly reachable.
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "render-domains-mcp", auth: mcpApiToken ? "enabled" : "disabled" });
});

const UNAUTHORIZED = {
  jsonrpc: "2.0",
  error: { code: -32001, message: "Unauthorized" },
  id: null,
} as const;

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") return next();
  if (!mcpApiToken) return next(); // local dev — auth disabled

  const provided = req.header("Authorization") ?? "";
  const expected = `Bearer ${mcpApiToken}`;

  // Length check before timingSafeEqual (which requires equal-length buffers).
  if (provided.length !== expected.length) {
    return res.status(401).json(UNAUTHORIZED);
  }
  if (!timingSafeEqual(Buffer.from(provided), Buffer.from(expected))) {
    return res.status(401).json(UNAUTHORIZED);
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
