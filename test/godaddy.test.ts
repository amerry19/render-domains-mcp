import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GoDaddyClient, GoDaddyApiError, type DnsRecord } from "../src/godaddy.js";

const KEY = "gd_key_abc";
const SECRET = "gd_secret_xyz";
const DOMAIN = "example.com";

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

describe("GoDaddyClient", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("requires key and secret in constructor", () => {
    expect(() => new GoDaddyClient("", SECRET)).toThrow(/required/i);
    expect(() => new GoDaddyClient(KEY, "")).toThrow(/required/i);
  });

  it("sends sso-key auth header on all requests", async () => {
    let captured: Record<string, string> = {};
    global.fetch = mockFetch((_url, init) => {
      captured = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse([]);
    });

    await new GoDaddyClient(KEY, SECRET).listRecords(DOMAIN);

    expect(captured.authorization).toBe(`sso-key ${KEY}:${SECRET}`);
    expect(captured.accept).toBe("application/json");
  });

  describe("listRecords", () => {
    it("GETs the records endpoint and returns the array", async () => {
      const records: DnsRecord[] = [
        { type: "A", name: "@", data: "1.2.3.4", ttl: 600 },
        { type: "CNAME", name: "www", data: "example.com", ttl: 3600 },
      ];
      let capturedUrl = "";
      global.fetch = mockFetch((url) => {
        capturedUrl = String(url);
        return jsonResponse(records);
      });

      const result = await new GoDaddyClient(KEY, SECRET).listRecords(DOMAIN);

      expect(capturedUrl).toBe(`https://api.godaddy.com/v1/domains/${DOMAIN}/records`);
      expect(result).toEqual(records);
    });

    it("appends type+name filters when provided", async () => {
      let capturedUrl = "";
      global.fetch = mockFetch((url) => {
        capturedUrl = String(url);
        return jsonResponse([]);
      });

      await new GoDaddyClient(KEY, SECRET).listRecords(DOMAIN, { type: "CNAME", name: "test" });

      expect(capturedUrl).toBe(`https://api.godaddy.com/v1/domains/${DOMAIN}/records/CNAME/test`);
    });
  });

  describe("upsertCname", () => {
    it("PUTs to /records/CNAME/{name} with the right body", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      let capturedBody: unknown;
      global.fetch = mockFetch((url, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = String(url);
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse(null);
      });

      await new GoDaddyClient(KEY, SECRET).upsertCname(DOMAIN, "test-mcp", "myapp.onrender.com", 600);

      expect(capturedMethod).toBe("PUT");
      expect(capturedUrl).toBe(`https://api.godaddy.com/v1/domains/${DOMAIN}/records/CNAME/test-mcp`);
      expect(capturedBody).toEqual([{ data: "myapp.onrender.com", ttl: 600 }]);
    });

    it("defaults TTL to 3600 if not provided", async () => {
      let capturedBody: unknown;
      global.fetch = mockFetch((_url, init) => {
        capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
        return jsonResponse(null);
      });

      await new GoDaddyClient(KEY, SECRET).upsertCname(DOMAIN, "test-mcp", "myapp.onrender.com");

      expect(capturedBody).toEqual([{ data: "myapp.onrender.com", ttl: 3600 }]);
    });
  });

  describe("deleteRecords", () => {
    it("DELETEs /records/{type}/{name}", async () => {
      let capturedMethod = "";
      let capturedUrl = "";
      global.fetch = mockFetch((url, init) => {
        capturedMethod = init?.method ?? "GET";
        capturedUrl = String(url);
        return new Response(null, { status: 204 });
      });

      await new GoDaddyClient(KEY, SECRET).deleteRecords(DOMAIN, "CNAME", "test-mcp");

      expect(capturedMethod).toBe("DELETE");
      expect(capturedUrl).toBe(`https://api.godaddy.com/v1/domains/${DOMAIN}/records/CNAME/test-mcp`);
    });
  });

  describe("error handling", () => {
    it("throws GoDaddyApiError with status + body on non-2xx", async () => {
      global.fetch = mockFetch(() => new Response('{"code":"UNAUTHORIZED","message":"Bad key"}', {
        status: 401,
        statusText: "Unauthorized",
      }));

      try {
        await new GoDaddyClient(KEY, SECRET).listRecords(DOMAIN);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(GoDaddyApiError);
        expect((err as GoDaddyApiError).status).toBe(401);
        expect((err as GoDaddyApiError).body).toContain("UNAUTHORIZED");
        expect((err as Error).message).toMatch(/401/);
      }
    });
  });
});
