import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  RenderPassTokenStore,
  renderPassRequest,
  renderFormHtml,
  renderResultHtml,
} from "../src/render-pass.js";

// ----------------------------------------------------------------------------
// RenderPassTokenStore
// ----------------------------------------------------------------------------

describe("RenderPassTokenStore", () => {
  it("issues a cryptographically random token", () => {
    const store = new RenderPassTokenStore();
    const pass = store.issue("srv-1", ["FOO"]);
    expect(pass.token).toMatch(/^[A-Za-z0-9_-]{32,}$/); // base64url, decent length
    expect(pass.serviceId).toBe("srv-1");
    expect(pass.requestedKeys).toEqual(["FOO"]);
    expect(pass.status).toBe("pending");
  });

  it("issues unique tokens for back-to-back calls", () => {
    const store = new RenderPassTokenStore();
    const a = store.issue("srv-1", ["A"]);
    const b = store.issue("srv-1", ["B"]);
    expect(a.token).not.toBe(b.token);
  });

  it("get() returns the pass for a valid token", () => {
    const store = new RenderPassTokenStore();
    const pass = store.issue("srv-1", ["FOO"]);
    expect(store.get(pass.token)).toEqual(pass);
  });

  it("get() returns undefined for unknown token", () => {
    expect(new RenderPassTokenStore().get("bogus")).toBeUndefined();
  });

  it("consume() marks the pass used and returns it (single-use)", () => {
    const store = new RenderPassTokenStore();
    const pass = store.issue("srv-1", ["FOO"]);

    const consumed = store.consume(pass.token);
    expect(consumed?.serviceId).toBe("srv-1");

    // Second consume should fail (single-use)
    expect(store.consume(pass.token)).toBeUndefined();
  });

  it("consume() returns undefined for unknown token", () => {
    expect(new RenderPassTokenStore().consume("bogus")).toBeUndefined();
  });

  it("get() returns undefined for expired tokens", () => {
    vi.useFakeTimers();
    const store = new RenderPassTokenStore({ ttlMs: 1000 });
    const pass = store.issue("srv-1", ["FOO"]);

    vi.advanceTimersByTime(2000);

    expect(store.get(pass.token)).toBeUndefined();
    vi.useRealTimers();
  });

  // ---- memory hygiene: actually delete entries from the Map, not just hide them ----

  it("size() reports the number of stored passes", () => {
    const store = new RenderPassTokenStore();
    expect(store.size()).toBe(0);
    store.issue("srv-1", ["A"]);
    store.issue("srv-1", ["B"]);
    expect(store.size()).toBe(2);
  });

  it("consume() deletes the entry from storage (not just marks used)", () => {
    const store = new RenderPassTokenStore();
    const pass = store.issue("srv-1", ["FOO"]);
    expect(store.size()).toBe(1);
    store.consume(pass.token);
    expect(store.size()).toBe(0);
  });

  it("issue() sweeps expired entries (GC), preventing unbounded growth", () => {
    vi.useFakeTimers();
    const store = new RenderPassTokenStore({ ttlMs: 1000 });
    store.issue("srv-1", ["A"]);
    store.issue("srv-1", ["B"]);
    expect(store.size()).toBe(2);

    vi.advanceTimersByTime(2000);
    // Issuing a new token should also clean up the expired ones
    store.issue("srv-1", ["C"]);
    expect(store.size()).toBe(1); // only the just-issued one survives

    vi.useRealTimers();
  });
});

// ----------------------------------------------------------------------------
// renderPassRequest handler
// ----------------------------------------------------------------------------

describe("renderPassRequest", () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.RENDER_EXTERNAL_HOSTNAME;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.RENDER_EXTERNAL_HOSTNAME;
    else process.env.RENDER_EXTERNAL_HOSTNAME = originalEnv;
  });

  it("issues a token and returns a one-time URL built from RENDER_EXTERNAL_HOSTNAME", () => {
    process.env.RENDER_EXTERNAL_HOSTNAME = "render-domains-mcp.onrender.com";
    const store = new RenderPassTokenStore();

    const result = renderPassRequest(store, {
      serviceId: "srv-abc",
      keys: ["GODADDY_API_KEY", "GODADDY_API_SECRET"],
    });

    const text = result.content[0].text;
    expect(text).toMatch(/https:\/\/render-domains-mcp\.onrender\.com\/render-pass\/[A-Za-z0-9_-]+/);
    expect(text).toContain("GODADDY_API_KEY");
    expect(text).toContain("GODADDY_API_SECRET");
    expect(text).toContain("one-time");
  });

  it("falls back to a localhost URL when RENDER_EXTERNAL_HOSTNAME is unset", () => {
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
    const store = new RenderPassTokenStore();

    const result = renderPassRequest(store, {
      serviceId: "srv-abc",
      keys: ["FOO"],
    });

    const text = result.content[0].text;
    expect(text).toMatch(/http:\/\/localhost.*\/render-pass\/[A-Za-z0-9_-]+/);
  });

  it("response does NOT echo any secret value (no value field exists yet)", () => {
    process.env.RENDER_EXTERNAL_HOSTNAME = "example.com";
    const store = new RenderPassTokenStore();

    const result = renderPassRequest(store, {
      serviceId: "srv-abc",
      keys: ["GODADDY_API_KEY"],
    });

    const text = result.content[0].text;
    // Sanity: token IS in the URL but no secret values appear (none were given)
    expect(text).toMatch(/render-pass\//);
  });

  it("registers the issued token in the store", () => {
    process.env.RENDER_EXTERNAL_HOSTNAME = "example.com";
    const store = new RenderPassTokenStore();

    const result = renderPassRequest(store, {
      serviceId: "srv-abc",
      keys: ["FOO"],
    });

    const text = result.content[0].text;
    const tokenMatch = text.match(/render-pass\/([A-Za-z0-9_-]+)/);
    expect(tokenMatch).not.toBeNull();
    const token = tokenMatch![1];
    expect(store.get(token)?.serviceId).toBe("srv-abc");
  });
});

// ----------------------------------------------------------------------------
// HTML rendering helpers
// ----------------------------------------------------------------------------

describe("renderFormHtml", () => {
  it("renders one masked input per requested key", () => {
    const html = renderFormHtml({
      token: "abc123",
      requestedKeys: ["GODADDY_API_KEY", "GODADDY_API_SECRET"],
      description: "Enable the GoDaddy adapter",
    });

    expect(html).toContain('<form method="POST"');
    expect(html).toContain('action="/render-pass/abc123"');
    expect(html).toContain('name="GODADDY_API_KEY"');
    expect(html).toContain('name="GODADDY_API_SECRET"');
    // All inputs must be password (masked)
    const passwordInputCount = (html.match(/type="password"/g) ?? []).length;
    expect(passwordInputCount).toBe(2);
  });

  it("includes the optional description in the page", () => {
    const html = renderFormHtml({
      token: "tk",
      requestedKeys: ["X"],
      description: "Wire up Cloudflare",
    });
    expect(html).toContain("Wire up Cloudflare");
  });

  it("escapes HTML in key names and description (prevents injection)", () => {
    const html = renderFormHtml({
      token: "tk",
      requestedKeys: ["<script>alert(1)</script>"],
      description: "<img src=x onerror=alert(1)>",
    });
    // Raw script/img tags must be escaped
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=");
    expect(html).toMatch(/&lt;script&gt;|&lt;/);
  });
});

describe("renderResultHtml", () => {
  it("renders a success page when ok=true", () => {
    const html = renderResultHtml({ ok: true });
    expect(html.toLowerCase()).toContain("received");
    expect(html).not.toContain("error");
  });

  it("renders an error page when ok=false with the given message", () => {
    const html = renderResultHtml({ ok: false, message: "Token expired" });
    expect(html).toContain("Token expired");
  });

  it("escapes the error message (prevents injection)", () => {
    const html = renderResultHtml({ ok: false, message: "<script>x</script>" });
    expect(html).not.toContain("<script>x</script>");
  });
});
