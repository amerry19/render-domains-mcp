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

export interface HttpsCheck {
  (domain: string): Promise<boolean>;
}

/**
 * Probe whether the domain's HTTPS handshake succeeds. Used by the verify
 * task to wait for Render's cert issuance to complete (Render's REST API
 * does NOT expose cert status, so an actual TLS handshake is our only
 * signal). Returns true if any 2xx/3xx/4xx response comes back (means TLS
 * worked); false on cert error, connection refused, or 5xx.
 */
export async function defaultHttpsCheck(domain: string): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}/`, { method: "HEAD", redirect: "manual" });
    return res.status >= 200 && res.status < 500;
  } catch {
    return false;
  }
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
 * Returns true if a single DNS resolver answer looks like it belongs to
 * Render. Matches:
 *   - The Render static-site apex A target (`216.24.57.1` by default)
 *   - Any IP in Render's `216.24.57.0/24` web-service range (e.g. `.7`, `.251`)
 *   - Any hostname containing `.onrender.com` (CNAME chain through Render)
 *
 * DoH for an `A` query returns the FULL resolution chain in the `Answer`
 * section, including intermediate CNAMEs and the final A records. For
 * CNAME-chained subdomains (the common Render web-service / static-site
 * subdomain case) the final IPs are usually in the `.7`/`.251` range, NOT
 * the apex `.1`, so we can't rely on the static-site IP alone.
 */
function looksLikeRender(record: string, apexTarget: string): boolean {
  if (record === apexTarget) return true;
  if (/^216\.24\.57\.\d{1,3}$/.test(record)) return true;
  if (record.includes(".onrender.com")) return true;
  return false;
}

/**
 * The DNS check tool handler. Pure function — takes an optional resolver
 * for dependency injection in tests; defaults to the real DoH client.
 */
export async function renderDomainsDnsCheck(
  args: DnsCheckArgs,
  resolver: DohResolver = resolveDoh
): Promise<McpTextContent> {
  const target = args.expectedTarget ?? RENDER_STATIC_SITE_A;
  try {
    const [a, cname] = await Promise.all([resolver(args.domain, "A"), resolver(args.domain, "CNAME")]);
    const allRecords = [...a, ...cname];
    const pointsAtRender = allRecords.some((rec) => looksLikeRender(rec, target));

    return jsonContent({
      summary: pointsAtRender
        ? `🔎 ${args.domain} resolves to Render via DNS (${a.length} A records, ${cname.length} CNAME records).`
        : `⚠️ ${args.domain} does NOT appear to point at Render yet.`,
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
