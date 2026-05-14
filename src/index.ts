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

// Optional GoDaddy adapter — both vars must be present to enable
const godaddyKey = process.env.GODADDY_API_KEY;
const godaddySecret = process.env.GODADDY_API_SECRET;
const goDaddy = godaddyKey && godaddySecret ? { key: godaddyKey, secret: godaddySecret } : undefined;

const server = createMcpServer({ renderApiToken: token, goDaddy });
const transport = new StdioServerTransport();
await server.connect(transport);

const toolCount = 7 + (goDaddy ? 3 : 0);
console.error(`[render-domains-mcp] stdio server ready (${toolCount} tools registered${goDaddy ? "; GoDaddy adapter enabled" : ""})`);
