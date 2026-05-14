/**
 * GoDaddy REST API client — narrow wrapper for DNS record management.
 *
 * Endpoints (per https://developer.godaddy.com/doc/endpoint/domains):
 *   GET    /v1/domains/{domain}/records[/{type}/{name}]
 *   PUT    /v1/domains/{domain}/records/{type}/{name}    body: [{data, ttl}]
 *   DELETE /v1/domains/{domain}/records/{type}/{name}
 *
 * Auth header format: 'sso-key {KEY}:{SECRET}'.
 *
 * As of April 2026 GoDaddy lifted the prior 10/50-domain gate; production
 * API keys are available to any account with at least one domain.
 */

const GODADDY_API_BASE = "https://api.godaddy.com/v1";

export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "NS" | "SOA" | "SRV" | "TXT";

export interface DnsRecord {
  type: DnsRecordType | string;
  name: string;
  data: string;
  ttl: number;
}

export interface ListOptions {
  type?: DnsRecordType | string;
  name?: string;
}

export class GoDaddyApiError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
    this.name = "GoDaddyApiError";
  }
}

export class GoDaddyClient {
  constructor(
    private key: string,
    private secret: string,
    private baseUrl: string = GODADDY_API_BASE
  ) {
    if (!key) throw new Error("GoDaddy API key is required");
    if (!secret) throw new Error("GoDaddy API secret is required");
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `sso-key ${this.key}:${this.secret}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new GoDaddyApiError(
        res.status,
        text,
        `GoDaddy API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`
      );
    }
    return res;
  }

  /** List DNS records, optionally filtered by type and/or name. */
  async listRecords(domain: string, opts: ListOptions = {}): Promise<DnsRecord[]> {
    let path = `/domains/${domain}/records`;
    if (opts.type) {
      path += `/${opts.type}`;
      if (opts.name) path += `/${opts.name}`;
    }
    const res = await this.request("GET", path);
    return (await res.json()) as DnsRecord[];
  }

  /**
   * Upsert a CNAME at the given name to the given target. GoDaddy PUTs replace
   * all records of that type+name, so this is effectively "set, replacing any
   * prior values."
   */
  async upsertCname(domain: string, name: string, target: string, ttl: number = 3600): Promise<void> {
    await this.request("PUT", `/domains/${domain}/records/CNAME/${name}`, [{ data: target, ttl }]);
  }

  /** Delete all records of the given type+name. */
  async deleteRecords(domain: string, type: DnsRecordType | string, name: string): Promise<void> {
    await this.request("DELETE", `/domains/${domain}/records/${type}/${name}`);
  }
}
