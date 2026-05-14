/**
 * Shared helpers for building MCP tool responses.
 *
 * Every tool handler in this server returns a `McpTextContent` — the SDK
 * accepts it via the structural index signature on `CallToolResult`.
 */

import { RenderApiError } from "./render.js";
import { GoDaddyApiError } from "./godaddy.js";

export interface McpTextContent {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // Index signature so this type is compatible with the SDK's CallToolResult.
  [key: string]: unknown;
}

export function jsonContent(payload: unknown): McpTextContent {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Wraps an error in MCP error content. If the error is a known provider error
 * (Render or GoDaddy), surface its status + body so the agent can reason about
 * the failure (e.g. 401 → bad token, 404 → not found).
 */
export function errorContent(err: unknown): McpTextContent {
  const message = err instanceof Error ? err.message : String(err);
  const payload: Record<string, unknown> = { error: message };

  if (err instanceof RenderApiError) {
    payload.renderStatus = err.status;
    payload.renderBody = err.body;
  } else if (err instanceof GoDaddyApiError) {
    payload.godaddyStatus = err.status;
    payload.godaddyBody = err.body;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
