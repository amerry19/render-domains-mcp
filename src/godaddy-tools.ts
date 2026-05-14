/**
 * Pure-function tool handlers for the GoDaddy adapter.
 *
 * Each function takes a GoDaddyClient + the tool's parsed args and returns
 * an MCP content object. Kept as pure functions (no McpServer coupling)
 * so the tools are trivially unit-testable with a mock client.
 */

import type { GoDaddyClient, DnsRecord } from "./godaddy.js";
import { jsonContent, errorContent, type McpTextContent } from "./mcp-helpers.js";

export interface DnsListArgs {
  domain: string;
  type?: string;
  name?: string;
}

export interface DnsSetCnameArgs {
  domain: string;
  name: string;
  target: string;
  ttl?: number;
}

export interface DnsDeleteArgs {
  domain: string;
  type: string;
  name: string;
}

export async function godaddyDnsList(
  client: GoDaddyClient,
  args: DnsListArgs
): Promise<McpTextContent> {
  try {
    const records = await client.listRecords(args.domain, { type: args.type, name: args.name });
    return jsonContent({ count: records.length, records });
  } catch (err) {
    return errorContent(err);
  }
}

export async function godaddyDnsSetCname(
  client: GoDaddyClient,
  args: DnsSetCnameArgs
): Promise<McpTextContent> {
  try {
    await client.upsertCname(args.domain, args.name, args.target, args.ttl);
    const record: DnsRecord = {
      type: "CNAME",
      name: args.name,
      data: args.target,
      ttl: args.ttl ?? 3600,
    };
    return jsonContent({
      ok: true,
      record,
      note: `CNAME set. Allow a few minutes for DNS propagation before calling render_domains_verify.`,
    });
  } catch (err) {
    return errorContent(err);
  }
}

export async function godaddyDnsDelete(
  client: GoDaddyClient,
  args: DnsDeleteArgs
): Promise<McpTextContent> {
  try {
    await client.deleteRecords(args.domain, args.type, args.name);
    return jsonContent({ ok: true, deleted: { domain: args.domain, type: args.type, name: args.name } });
  } catch (err) {
    return errorContent(err);
  }
}

/**
 * Returns markdown instructions for getting a GoDaddy API key + secret AND
 * wiring them into the Render service env vars via the official Render MCP.
 *
 * Always registered (even when GoDaddy creds are absent) so an agent can
 * guide a brand-new user through onboarding without a dashboard handoff.
 */
export function godaddySetupGuide(): McpTextContent {
  const text = `# GoDaddy API Credentials Setup

To enable the GoDaddy adapter (so the agent can set DNS records for you), you need a Production API key.

## Step 1 — Generate the key

1. **Open** https://developer.godaddy.com/keys
2. **Click** "Create New API Key"
3. **Choose Environment:** \`Production\` (NOT OTE — that's a sandbox)
4. **Name** the key something descriptive (e.g. \`render-domains-mcp\`)
5. **Copy both** the Key AND the Secret (the Secret is shown once only)

**Eligibility (April 2026 update):** GoDaddy now allows API access with as few as 1 domain — earlier 10/50-domain restrictions were lifted.

## Step 2 — Get the values into the MCP server

**Two options, security-ranked:**

### Option A (recommended): Secure shell-prompt — values never appear in chat

In Claude Code / Cursor, paste this as a single \`!\` command. \`read -s\` reads silently and the curl response body is suppressed, so neither the keys nor the response values land in the transcript:

\`\`\`bash
! read -s -p "GoDaddy Key: " GD_KEY; echo; \\
  read -s -p "GoDaddy Secret: " GD_SECRET; echo; \\
  curl -s -o /dev/null -w "HTTP %{http_code}\\n" -X POST \\
    -H "Authorization: Bearer $RENDER_API_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d "[{\\"key\\":\\"GODADDY_API_KEY\\",\\"value\\":\\"$GD_KEY\\"},{\\"key\\":\\"GODADDY_API_SECRET\\",\\"value\\":\\"$GD_SECRET\\"}]" \\
    "https://api.render.com/v1/services/<SERVICE_ID>/env-vars/merge"; \\
  unset GD_KEY GD_SECRET
\`\`\`

### Option B: Use this MCP's \`render_secrets_set\` tool

If you trust the chat surface and want a fully agentic flow, paste your key + secret and I'll call:

\`\`\`
render_secrets_set({
  serviceId: "<your-render-service-id>",
  secrets: [
    { key: "GODADDY_API_KEY",    value: "<your-key>" },
    { key: "GODADDY_API_SECRET", value: "<your-secret>" }
  ]
})
\`\`\`

\`render_secrets_set\` is **this MCP's** tool, not the official Render MCP's — it's designed specifically to NOT echo values back in the response, which fixes the secret-leakage gap in \`mcp__render__update_environment_variables\`.

Values still pass through the agent's context ONCE (when you paste them), so Option A is strictly safer if you have shell access. Use Option A for real secrets.

## Step 3 — Wait + verify

Render auto-redeploys in ~30-60 seconds. Once live, the GoDaddy action tools (\`godaddy_dns_list\`, \`godaddy_dns_set_cname\`, \`godaddy_dns_delete\`) register and the agent can close the full domain-add → DNS → verify loop.

## Security baseline

- Treat the key + secret like a password.
- Once stored in Render's env vars they're encrypted at rest; only the MCP server reads them.
- Rotate via GoDaddy dashboard any time. If they ever appear in a transcript, rotate immediately.`;
  return { content: [{ type: "text", text }] };
}
