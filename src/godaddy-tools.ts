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

## Steps

1. **Open** https://developer.godaddy.com/keys
2. **Click** "Create New API Key"
3. **Choose Environment:** \`Production\` (NOT OTE — that's a sandbox)
4. **Name** the key something descriptive (e.g. \`render-domains-mcp\`)
5. **Copy both** the Key AND the Secret (the Secret is shown once only)
6. **Paste both back into this chat** — I'll wire them into your Render service automatically

## Eligibility (April 2026 update)

GoDaddy now allows API access to accounts with **as few as 1 domain**. Earlier restrictions (10+ or 50+ domains) were lifted.

## What I'll do after you paste them

I will call the official Render MCP to set environment variables on your render-domains-mcp service:

\`\`\`
mcp__render__update_environment_variables({
  serviceId: "<your-render-service-id>",
  envVars: [
    { key: "GODADDY_API_KEY",    value: "<your-key>" },
    { key: "GODADDY_API_SECRET", value: "<your-secret>" }
  ]
})
\`\`\`

Render will auto-redeploy in ~30-60 seconds. Once it's back live, the GoDaddy tools (\`godaddy_dns_list\`, \`godaddy_dns_set_cname\`, \`godaddy_dns_delete\`) will be registered and the agent can close the full domain-add → DNS → verify loop.

## Security note

Treat the key + secret like a password. Once they're in Render's env vars they're encrypted at rest and only the MCP server reads them. Rotate them in the GoDaddy dashboard any time.`;
  return { content: [{ type: "text", text }] };
}
