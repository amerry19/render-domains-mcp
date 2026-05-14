/**
 * Render Pass — one-time secure credential intake.
 *
 * Problem: agentic flows that need to inject secrets into a service's env
 * vars currently leak the values into the chat transcript and the agent's
 * context window. Even tools that don't echo values back (like our
 * render_secrets_set) still see the values once when the user pastes them.
 *
 * Solution: the MCP server issues a single-use URL that opens an HTML form
 * in the user's browser. The user types the secret directly into a masked
 * input; the form POSTs to the MCP server, which writes the value straight
 * into Render's env vars. The agent's context never sees the value.
 *
 * Components in this file:
 *   - RenderPassTokenStore  — in-memory store of pending passes (TTL'd, single-use)
 *   - renderPassRequest      — MCP tool handler that issues a pass + URL
 *   - renderFormHtml         — renders the masked-input intake form
 *   - renderResultHtml       — renders success / failure response pages
 *
 * The Express routes that consume tokens live in src/http.ts.
 */

import { randomBytes } from "node:crypto";

import { jsonContent, type McpTextContent } from "./mcp-helpers.js";

// ----------------------------------------------------------------------------
// Token store
// ----------------------------------------------------------------------------

export type PassStatus = "pending" | "used" | "expired";

export interface RenderPass {
  token: string;
  serviceId: string;
  requestedKeys: string[];
  description?: string;
  status: PassStatus;
  issuedAt: number; // ms epoch
}

interface TokenStoreOptions {
  /** Token lifetime in ms. Default 10 minutes. */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export class RenderPassTokenStore {
  private passes = new Map<string, RenderPass>();
  private ttlMs: number;

  constructor(options: TokenStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  issue(serviceId: string, requestedKeys: string[], description?: string): RenderPass {
    const token = randomBytes(24).toString("base64url");
    const pass: RenderPass = {
      token,
      serviceId,
      requestedKeys,
      description,
      status: "pending",
      issuedAt: Date.now(),
    };
    this.passes.set(token, pass);
    return pass;
  }

  /** Returns the pass IF it exists, is still pending, and not expired. */
  get(token: string): RenderPass | undefined {
    const pass = this.passes.get(token);
    if (!pass) return undefined;
    if (pass.status !== "pending") return undefined;
    if (Date.now() - pass.issuedAt > this.ttlMs) return undefined;
    return pass;
  }

  /** Atomically claim a token. Marks used + returns the pass, or undefined. */
  consume(token: string): RenderPass | undefined {
    const pass = this.get(token);
    if (!pass) return undefined;
    pass.status = "used";
    return pass;
  }
}

// ----------------------------------------------------------------------------
// MCP tool handler: issue a Render Pass + return its URL to the agent
// ----------------------------------------------------------------------------

export interface RequestArgs {
  serviceId: string;
  keys: string[];
  description?: string;
}

export function renderPassRequest(
  store: RenderPassTokenStore,
  args: RequestArgs
): McpTextContent {
  const pass = store.issue(args.serviceId, args.keys, args.description);

  // Build the URL the user will open in their browser.
  // RENDER_EXTERNAL_HOSTNAME is injected by Render on deploys; fall back to
  // localhost for local dev.
  const externalHost = process.env.RENDER_EXTERNAL_HOSTNAME;
  const port = process.env.PORT ?? "10000";
  const baseUrl = externalHost
    ? `https://${externalHost}`
    : `http://localhost:${port}`;
  const passUrl = `${baseUrl}/render-pass/${pass.token}`;

  return jsonContent({
    passUrl,
    serviceId: args.serviceId,
    keysRequested: args.keys,
    note:
      "Render Pass: this URL is one-time use, expires in 10 minutes, and shows a masked form. " +
      "The user enters the secret(s) in their browser; values flow directly to the Render service's env vars without passing through the agent's context. " +
      "Surface this URL to the user and wait for them to confirm submission before continuing.",
  });
}

// ----------------------------------------------------------------------------
// HTML rendering — kept inline (no template engine), escaped for safety
// ----------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_STYLES = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    max-width: 480px;
    margin: 60px auto;
    padding: 32px 24px;
    color: #0f172a;
    background: #fafafa;
  }
  h1 { font-size: 24px; margin: 0 0 4px; }
  .ticket { font-size: 13px; color: #64748b; margin-bottom: 24px; }
  .desc { font-size: 14px; line-height: 1.5; margin-bottom: 24px; padding: 12px 16px; background: #f1f5f9; border-radius: 6px; }
  label { display: block; margin: 16px 0 4px; font-weight: 600; font-size: 14px; }
  input { width: 100%; padding: 10px 12px; font-size: 14px; border: 1px solid #cbd5e1; border-radius: 6px; box-sizing: border-box; font-family: monospace; }
  input:focus { outline: 2px solid #6366f1; outline-offset: 1px; border-color: transparent; }
  button {
    margin-top: 24px;
    padding: 12px 20px;
    background: #0f172a;
    color: white;
    border: 0;
    border-radius: 6px;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    width: 100%;
  }
  button:hover { background: #1e293b; }
  .footer { margin-top: 32px; font-size: 12px; color: #94a3b8; line-height: 1.5; }
`;

export interface FormArgs {
  token: string;
  requestedKeys: string[];
  description?: string;
}

export function renderFormHtml(args: FormArgs): string {
  const inputs = args.requestedKeys
    .map((key) => {
      const safe = escapeHtml(key);
      return `  <label for="${safe}">${safe}</label>
  <input type="password" id="${safe}" name="${safe}" required autocomplete="off" spellcheck="false">`;
    })
    .join("\n");

  const descBlock = args.description
    ? `<div class="desc">${escapeHtml(args.description)}</div>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Render Pass</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <h1>🎟️ Render Pass</h1>
  <div class="ticket">One-time secret intake · expires 10 min</div>
  ${descBlock}
  <form method="POST" action="/render-pass/${escapeHtml(args.token)}" autocomplete="off">
${inputs}
    <button type="submit">Submit securely</button>
  </form>
  <div class="footer">
    Values are sent over HTTPS directly to your Render service's env vars.
    They never pass through the agent's chat context. This URL can only be used once.
  </div>
</body>
</html>`;
}

export function renderResultHtml(result: { ok: boolean; message?: string }): string {
  if (result.ok) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Render Pass · received</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <h1>✅ Secrets received</h1>
  <p>Your credentials have been written to the Render service's env vars. The service will auto-redeploy in ~30-60 seconds. You can close this tab.</p>
  <div class="footer">Tell the agent you've submitted the form and they'll continue the flow.</div>
</body>
</html>`;
  }
  const safeMessage = escapeHtml(result.message ?? "This pass is invalid, expired, or already used.");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Render Pass · error</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <h1>⚠️ Render Pass invalid</h1>
  <p>${safeMessage}</p>
  <div class="footer">Ask the agent to generate a new Render Pass.</div>
</body>
</html>`;
}
