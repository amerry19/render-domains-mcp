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

export async function godaddyDnsListLogic(
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

export async function godaddyDnsSetCnameLogic(
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

export async function godaddyDnsDeleteLogic(
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
