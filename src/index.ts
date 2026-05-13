#!/usr/bin/env -S npx tsx
/**
 * Stdio transport entry point — for local Claude Code / Cursor / Codex use.
 *
 * Run: RENDER_API_TOKEN=rnd_... npx tsx src/index.ts
 *
 * For Render-hosted HTTP mode, use src/http.ts instead.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

const token = process.env.RENDER_API_TOKEN;
if (!token) {
  console.error(
    "[render-domains-mcp] ERROR: RENDER_API_TOKEN env var is required.\n" +
      "Get one at https://dashboard.render.com/u/settings#api-keys"
  );
  process.exit(1);
}

const server = createMcpServer({ renderApiToken: token });
const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr so we don't pollute stdio JSON-RPC stream.
console.error("[render-domains-mcp] stdio server ready (7 tools registered)");
