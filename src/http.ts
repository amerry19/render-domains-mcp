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

// ----------------------------------------------------------------------------
// Config from env
// ----------------------------------------------------------------------------

const renderApiToken = process.env.RENDER_API_TOKEN;
if (!renderApiToken) {
  console.error("[render-domains-mcp] ERROR: RENDER_API_TOKEN env var is required.");
  process.exit(1);
}

const mcpApiToken = process.env.MCP_API_TOKEN; // optional — when set, enables bearer auth
const port = Number.parseInt(process.env.PORT ?? "10000", 10);
const host = "0.0.0.0";
const externalHost = process.env.RENDER_EXTERNAL_HOSTNAME; // Render injects this
const allowedHosts = externalHost ? [externalHost, "localhost"] : undefined;

// ----------------------------------------------------------------------------
// Express app with DNS rebinding protection (from MCP SDK)
// ----------------------------------------------------------------------------

const app = createMcpExpressApp({ host, allowedHosts });

// Health check — must come BEFORE auth middleware so it's publicly reachable
app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "render-domains-mcp", auth: mcpApiToken ? "enabled" : "disabled" });
});

// ----------------------------------------------------------------------------
// Bearer auth middleware (timing-safe)
// ----------------------------------------------------------------------------

app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.path === "/health") return next();
  if (!mcpApiToken) return next(); // local dev — auth disabled

  const provided = req.header("Authorization") ?? "";
  const expected = `Bearer ${mcpApiToken}`;

  // Length check before timingSafeEqual (which requires equal-length buffers)
  if (provided.length !== expected.length) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }

  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (!timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }

  next();
});

// ----------------------------------------------------------------------------
// MCP server + transport
// ----------------------------------------------------------------------------

// Stateless mode (matches Render's own Python template `stateless_http=True`).
// Each request gets a fresh transport + fresh server instance — no cross-request
// state, no "Server already initialized" errors when multiple clients connect.
async function handleMcpRequest(req: Request, res: Response, body?: unknown) {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createMcpServer({ renderApiToken: renderApiToken! });
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
  console.error(`[render-domains-mcp] auth: ${mcpApiToken ? "enabled (Bearer)" : "DISABLED (no MCP_API_TOKEN set — local dev only!)"}`);
  if (externalHost) {
    console.error(`[render-domains-mcp] external URL: https://${externalHost}/mcp`);
  }
});
