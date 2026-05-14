/**
 * Render REST API client — narrow wrapper for custom domain operations.
 *
 * Endpoints (verified empirically against api.render.com on 2026-05-13):
 *   GET    /v1/services/{serviceId}/custom-domains
 *   GET    /v1/services/{serviceId}/custom-domains/{domainId}
 *   POST   /v1/services/{serviceId}/custom-domains            body: {name}
 *   POST   /v1/services/{serviceId}/custom-domains/{domainId}/verify   → 202
 *   DELETE /v1/services/{serviceId}/custom-domains/{domainId}          → 204
 */

const RENDER_API_BASE = "https://api.render.com/v1";

export type VerificationStatus =
  | "unverified"
  | "verified"
  | "verification_failed"
  | "expired"
  | string; // tolerate unseen states rather than narrow incorrectly

export interface CustomDomain {
  id: string;
  name: string;
  domainType: "apex" | "subdomain";
  verificationStatus: VerificationStatus;
  publicSuffix: string;
  redirectForName: string;
  createdAt: string;
}

interface ListEnvelope {
  cursor: string;
  customDomain: CustomDomain;
}

export class RenderApiError extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
    this.name = "RenderApiError";
  }
}

export class RenderClient {
  constructor(private token: string, private baseUrl: string = RENDER_API_BASE) {
    if (!token) throw new Error("RENDER_API_TOKEN is required");
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new RenderApiError(
        res.status,
        text,
        `Render API ${method} ${path} failed: ${res.status} ${res.statusText} — ${text.slice(0, 200)}`
      );
    }
    return res;
  }

  async listDomains(serviceId: string): Promise<CustomDomain[]> {
    const res = await this.request("GET", `/services/${serviceId}/custom-domains`);
    const envelopes = (await res.json()) as ListEnvelope[];
    return envelopes.map((e) => e.customDomain);
  }

  async getDomain(serviceId: string, domainId: string): Promise<CustomDomain> {
    const res = await this.request("GET", `/services/${serviceId}/custom-domains/${domainId}`);
    return (await res.json()) as CustomDomain;
  }

  async addDomain(serviceId: string, name: string): Promise<CustomDomain> {
    const res = await this.request("POST", `/services/${serviceId}/custom-domains`, { name });
    const created = (await res.json()) as CustomDomain[];
    if (!created.length) {
      throw new RenderApiError(500, "", "Render returned empty array on POST /custom-domains");
    }
    return created[0];
  }

  /**
   * Triggers Render's async verification check. Returns immediately (202 Accepted).
   * Caller is responsible for polling getDomain() to observe verificationStatus changes.
   */
  async triggerVerify(serviceId: string, domainId: string): Promise<void> {
    await this.request("POST", `/services/${serviceId}/custom-domains/${domainId}/verify`);
  }

  async removeDomain(serviceId: string, domainId: string): Promise<void> {
    await this.request("DELETE", `/services/${serviceId}/custom-domains/${domainId}`);
  }

  /**
   * Set (upsert) environment variables on a service. Reads existing vars,
   * merges in the new ones (replacing values for matching keys), and writes
   * the full list back.
   *
   * Render's `PUT /env-vars` is a full replace, so we fetch-merge-write to
   * preserve unrelated vars. The returned list values are NOT propagated
   * back to callers of `setEnvVars` — callers should use this for secret
   * values they don't want echoed.
   */
  async setEnvVars(serviceId: string, updates: { key: string; value: string }[]): Promise<void> {
    const getRes = await this.request("GET", `/services/${serviceId}/env-vars`);
    const current = (await getRes.json()) as { envVar: { key: string; value: string } }[];

    const updateKeys = new Set(updates.map((u) => u.key));
    const merged = [
      ...current.filter((c) => !updateKeys.has(c.envVar.key)).map((c) => c.envVar),
      ...updates,
    ];

    await this.request("PUT", `/services/${serviceId}/env-vars`, merged);
  }
}
