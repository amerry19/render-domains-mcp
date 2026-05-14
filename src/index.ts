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
import { loadGoDaddyConfig, requireEnv } from "./config.js";

const renderApiToken = requireEnv("RENDER_API_TOKEN", "https://dashboard.render.com/u/settings#api-keys");
const goDaddy = loadGoDaddyConfig();

const server = createMcpServer({ renderApiToken, goDaddy });
await server.connect(new StdioServerTransport());

const toolCount = 7 + (goDaddy ? 3 : 0);
console.error(`[render-domains-mcp] stdio server ready (${toolCount} tools${goDaddy ? "; GoDaddy adapter enabled" : ""})`);
