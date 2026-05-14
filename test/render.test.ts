import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { RenderClient, RenderApiError, type CustomDomain } from "../src/render.js";

const SERVICE_ID = "srv-test";
const TOKEN = "rnd_test_token";

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function noContentResponse(): Response {
  return new Response(null, { status: 204 });
}

const APEX_DOMAIN: CustomDomain = {
  id: "cdm-apex",
  name: "example.com",
  domainType: "apex",
  verificationStatus: "verified",
  publicSuffix: "com",
  redirectForName: "",
  createdAt: "2026-01-01T00:00:00Z",
};

describe("RenderClient", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requires a token in the constructor", () => {
    expect(() => new RenderClient("")).toThrow(/required/i);
  });

  it("sends Bearer auth on all requests", async () => {
    let captured: Record<string, string> = {};
    global.fetch = mockFetch((_url, init) => {
      captured = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse([]);
    });

    await new RenderClient(TOKEN).listDomains(SERVICE_ID);

    expect(captured.authorization).toBe(`Bearer ${TOKEN}`);
    expect(captured.accept).toBe("application/json");
  });

  describe("listDomains", () => {
    it("unwraps the envelope shape and returns CustomDomain[]", async () => {
      global.fetch = mockFetch(() =>
        jsonResponse([
          { cursor: "abc", customDomain: APEX_DOMAIN },
          { cursor: "def", customDomain: { ...APEX_DOMAIN, id: "cdm-www", name: "www.example.com", domainType: "subdomain" } },
        ])
      );

      const result = await new RenderClient(TOKEN).listDomains(SERVICE_ID);

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("cdm-apex");
      expect(result[1].domainType).toBe("subdomain");
    });

    it("returns empty array if Render returns empty array", async () => {
      global.fetch = mockFetch(() => jsonResponse([]));
      const result = await new RenderClient(TOKEN).listDomains(SERVICE_ID);
      expect(result).toEqual([]);
    });

    it("hits the correct URL", async () => {
      let capturedUrl = "";
      global.fetch = mockFetch((url) => {
        capturedUrl = String(url);
        return jsonResponse([]);
      });
      await new RenderClient(TOKEN).listDomains(SERVICE_ID);
      expect(capturedUrl).toBe(`https://api.render.com/v1/services/${SERVICE_ID}/custom-domains`);
    });
  });

  describe("getDomain", () => {
    it("returns the domain object directly (no envelope)", async () => {
      global.fetch = mockFetch(() => jsonResponse(APEX_DOMAIN));
      const result = await new RenderClient(TOKEN).getDomain(SERVICE_ID, "cdm-apex");
      expect(result).toEqual(APEX_DOMAIN);
    });
  });

  describe("addDomain", () => {
    it("POSTs {name} and returns the first element of the response array", async () => {
      let capturedBody: unknown;
      let capturedMethod = "";
      global.fetch = mockFetch((_url, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse([APEX_DOMAIN]);
      });

      const result = await new RenderClient(TOKEN).addDomain(SERVICE_ID, "example.com");

      expect(capturedMethod).toBe("POST");
      expect(capturedBody).toEqual({ name: "example.com" });
      expect(result).toEqual(APEX_DOMAIN);
    });

    it("throws if Render returns empty array", async () => {
      global.fetch = mockFetch(() => jsonResponse([]));
      await expect(new RenderClient(TOKEN).addDomain(SERVICE_ID, "example.com")).rejects.toThrow(/empty/i);
    });
  });

  describe("triggerVerify", () => {
    it("POSTs to /verify and resolves on 202", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      global.fetch = mockFetch((url, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = String(url);
        return new Response(null, { status: 202 });
      });

      await new RenderClient(TOKEN).triggerVerify(SERVICE_ID, "cdm-apex");

      expect(capturedMethod).toBe("POST");
      expect(capturedUrl).toBe(`https://api.render.com/v1/services/${SERVICE_ID}/custom-domains/cdm-apex/verify`);
    });
  });

  describe("removeDomain", () => {
    it("DELETEs and resolves on 204", async () => {
      let capturedMethod = "";
      global.fetch = mockFetch((_url, init) => {
        capturedMethod = init?.method ?? "GET";
        return noContentResponse();
      });

      await new RenderClient(TOKEN).removeDomain(SERVICE_ID, "cdm-apex");

      expect(capturedMethod).toBe("DELETE");
    });
  });

  describe("error handling", () => {
    it("throws RenderApiError on non-2xx with status + body", async () => {
      global.fetch = mockFetch(() => new Response("not found", { status: 404, statusText: "Not Found" }));

      try {
        await new RenderClient(TOKEN).getDomain(SERVICE_ID, "cdm-missing");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(RenderApiError);
        expect((err as RenderApiError).status).toBe(404);
        expect((err as RenderApiError).body).toBe("not found");
        expect((err as Error).message).toMatch(/404/);
      }
    });
  });

  describe("setEnvVars", () => {
    it("GETs existing env vars then PUTs a merged list (preserves vars not being changed)", async () => {
      const calls: { method: string; url: string; body: unknown }[] = [];
      global.fetch = mockFetch((url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method: init?.method ?? "GET", url: String(url), body });
        if (init?.method === "PUT") return jsonResponse(null);
        // GET response: existing vars
        return jsonResponse([
          { envVar: { key: "RENDER_API_TOKEN", value: "rnd_existing" } },
          { envVar: { key: "PORT", value: "10000" } },
        ]);
      });

      await new RenderClient(TOKEN).setEnvVars(SERVICE_ID, [
        { key: "GODADDY_API_KEY", value: "gd_new" },
        { key: "GODADDY_API_SECRET", value: "gd_secret_new" },
      ]);

      expect(calls).toHaveLength(2);
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toBe(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars`);
      expect(calls[1].method).toBe("PUT");

      const putBody = calls[1].body as { key: string; value: string }[];
      const sorted = [...putBody].sort((a, b) => a.key.localeCompare(b.key));
      expect(sorted).toEqual([
        { key: "GODADDY_API_KEY", value: "gd_new" },
        { key: "GODADDY_API_SECRET", value: "gd_secret_new" },
        { key: "PORT", value: "10000" },
        { key: "RENDER_API_TOKEN", value: "rnd_existing" },
      ]);
    });

    it("replaces the value when a key already exists (merge, not duplicate)", async () => {
      const calls: { method: string; body: unknown }[] = [];
      global.fetch = mockFetch((_url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ method: init?.method ?? "GET", body });
        if (init?.method === "PUT") return jsonResponse(null);
        return jsonResponse([
          { envVar: { key: "GODADDY_API_KEY", value: "gd_OLD" } },
          { envVar: { key: "PORT", value: "10000" } },
        ]);
      });

      await new RenderClient(TOKEN).setEnvVars(SERVICE_ID, [
        { key: "GODADDY_API_KEY", value: "gd_NEW" },
      ]);

      const putBody = calls[1].body as { key: string; value: string }[];
      const godaddyEntries = putBody.filter((v) => v.key === "GODADDY_API_KEY");
      expect(godaddyEntries).toHaveLength(1);
      expect(godaddyEntries[0].value).toBe("gd_NEW");
    });
  });
});
