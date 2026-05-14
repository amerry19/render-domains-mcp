/**
 * DNS-over-HTTPS lookups + the pre-flight check tool used by the agent
 * to confirm a domain points at Render before triggering verification.
 *
 * Using DoH (Cloudflare 1.1.1.1) instead of `dns.resolve` so we dodge
 * ISP DNS caches and get a closer-to-truth answer.
 */

import { errorContent, jsonContent, type McpTextContent } from "./mcp-helpers.js";

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

/** Render's static-site apex A target. Web services typically use CNAMEs. */
export const RENDER_STATIC_SITE_A = "216.24.57.1";

export interface DnsCheckArgs {
  domain: string;
  expectedTarget?: string;
}

export interface DohResolver {
  (name: string, type: "A" | "CNAME"): Promise<string[]>;
}

async function resolveDoh(name: string, type: "A" | "CNAME"): Promise<string[]> {
  const res = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: "application/dns-json" },
  });
  if (!res.ok) throw new Error(`DoH lookup failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { Answer?: { name: string; type: number; TTL: number; data: string }[] };
  return (json.Answer ?? []).map((a) => a.data);
}

/**
 * The DNS check tool handler. Pure function — takes an optional resolver
 * for dependency injection in tests; defaults to the real DoH client.
 */
export async function renderDomainsDnsCheckLogic(
  args: DnsCheckArgs,
  resolver: DohResolver = resolveDoh
): Promise<McpTextContent> {
  const target = args.expectedTarget ?? RENDER_STATIC_SITE_A;
  try {
    const [a, cname] = await Promise.all([resolver(args.domain, "A"), resolver(args.domain, "CNAME")]);
    const pointsAtRender =
      a.some((rec) => rec === target) ||
      cname.some((rec) => rec.endsWith(".onrender.com.") || rec.endsWith(".onrender.com"));
    return jsonContent({
      domain: args.domain,
      resolves: a.length > 0 || cname.length > 0,
      a,
      cname,
      expectedTarget: target,
      pointsAtRender,
      guidance: pointsAtRender
        ? "DNS points at Render — safe to call render_domains_verify."
        : "DNS does NOT currently point at Render. Update the registrar before calling render_domains_verify, otherwise Render's check will fail.",
    });
  } catch (err) {
    return errorContent(err);
  }
}
