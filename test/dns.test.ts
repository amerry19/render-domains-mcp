import { describe, it, expect, vi } from "vitest";

import { RENDER_STATIC_SITE_A, renderDomainsDnsCheck, type DohResolver } from "../src/dns.js";

function parsedBody(content: { content: { text: string }[] }): unknown {
  return JSON.parse(content.content[0].text);
}

function makeResolver(records: { A?: string[]; CNAME?: string[] }): DohResolver {
  return vi.fn((_name, type) => Promise.resolve(records[type] ?? []));
}

describe("renderDomainsDnsCheck", () => {
  it("reports pointsAtRender=true when A record matches the expected target", async () => {
    const resolver = makeResolver({ A: [RENDER_STATIC_SITE_A], CNAME: [] });
    const result = await renderDomainsDnsCheck({ domain: "example.com" }, resolver);
    const body = parsedBody(result) as { pointsAtRender: boolean; guidance: string };
    expect(body.pointsAtRender).toBe(true);
    expect(body.guidance).toMatch(/safe to call render_domains_verify/);
  });

  it("reports pointsAtRender=true when CNAME ends with .onrender.com", async () => {
    const resolver = makeResolver({ A: [], CNAME: ["myapp.onrender.com."] });
    const result = await renderDomainsDnsCheck({ domain: "www.example.com" }, resolver);
    const body = parsedBody(result) as { pointsAtRender: boolean };
    expect(body.pointsAtRender).toBe(true);
  });

  it("reports pointsAtRender=false when DNS goes elsewhere", async () => {
    const resolver = makeResolver({ A: ["1.2.3.4"], CNAME: [] });
    const result = await renderDomainsDnsCheck({ domain: "example.com" }, resolver);
    const body = parsedBody(result) as { pointsAtRender: boolean; guidance: string };
    expect(body.pointsAtRender).toBe(false);
    expect(body.guidance).toMatch(/Update the registrar/);
  });

  it("reports resolves=false when nothing comes back", async () => {
    const resolver = makeResolver({ A: [], CNAME: [] });
    const result = await renderDomainsDnsCheck({ domain: "nothing.example.com" }, resolver);
    const body = parsedBody(result) as { resolves: boolean; pointsAtRender: boolean };
    expect(body.resolves).toBe(false);
    expect(body.pointsAtRender).toBe(false);
  });

  it("uses an explicit expectedTarget when provided", async () => {
    const customTarget = "10.0.0.1";
    const resolver = makeResolver({ A: [customTarget], CNAME: [] });
    const result = await renderDomainsDnsCheck(
      { domain: "example.com", expectedTarget: customTarget },
      resolver
    );
    const body = parsedBody(result) as { pointsAtRender: boolean; expectedTarget: string };
    expect(body.expectedTarget).toBe(customTarget);
    expect(body.pointsAtRender).toBe(true);
  });

  it("returns isError when the resolver throws", async () => {
    const resolver: DohResolver = vi.fn().mockRejectedValue(new Error("doh down"));
    const result = await renderDomainsDnsCheck({ domain: "example.com" }, resolver);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
