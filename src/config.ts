/**
 * Env var loading helpers shared by the stdio and HTTP entry points.
 *
 * Kept here (rather than inside `createMcpServer`) so the factory remains a
 * pure function that takes explicit config — easier to test and to drive
 * from places that aren't reading process.env.
 */

import type { ServerOptions } from "./server.js";

/**
 * Read a required env var. Exits the process with a clear error message if
 * unset. Return type is `string` (not `string | undefined`) because the
 * `process.exit` branch is `never`, so callers get clean type narrowing.
 */
export function requireEnv(name: string, helpUrl?: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[render-domains-mcp] ERROR: ${name} env var is required.` +
        (helpUrl ? `\nGet one at ${helpUrl}` : "")
    );
    process.exit(1);
  }
  return value;
}

/**
 * Read GoDaddy credentials from the environment. Returns `undefined` when
 * either env var is missing — both are required to enable the GoDaddy
 * adapter.
 */
export function loadGoDaddyConfig(): ServerOptions["goDaddy"] {
  const key = process.env.GODADDY_API_KEY;
  const secret = process.env.GODADDY_API_SECRET;
  return key && secret ? { key, secret } : undefined;
}
