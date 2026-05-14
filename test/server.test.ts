import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpServer } from "../src/server.js";

/**
 * We test the factory by patching McpServer.prototype.registerTool so we can
 * capture the names + descriptions of tools that get registered. This avoids
 * coupling the test to SDK internals like _registeredTools.
 */

interface CapturedRegistration {
  name: string;
  config: { title?: string; description?: string };
}

describe("createMcpServer", () => {
  let captured: CapturedRegistration[];
  let originalRegisterTool: typeof McpServer.prototype.registerTool;

  beforeEach(() => {
    captured = [];
    originalRegisterTool = McpServer.prototype.registerTool;
    McpServer.prototype.registerTool = function (this: McpServer, name: string, config: unknown, cb: unknown) {
      captured.push({ name, config: config as CapturedRegistration["config"] });
      return originalRegisterTool.call(this, name, config as Parameters<typeof originalRegisterTool>[1], cb as Parameters<typeof originalRegisterTool>[2]);
    } as typeof originalRegisterTool;
  });

  afterEach(() => {
    McpServer.prototype.registerTool = originalRegisterTool;
  });

  it("registers exactly the 7 Render tools when GoDaddy creds are omitted", () => {
    createMcpServer({ renderApiToken: "rnd_test" });

    const names = captured.map((c) => c.name).sort();
    expect(names).toEqual([
      "render_domains_add",
      "render_domains_dns_check",
      "render_domains_get",
      "render_domains_list",
      "render_domains_remove",
      "render_domains_verify",
      "render_domains_verify_status",
    ]);
  });

  it("adds the 3 GoDaddy tools when credentials are provided", () => {
    createMcpServer({
      renderApiToken: "rnd_test",
      goDaddy: { key: "gd_key", secret: "gd_secret" },
    });

    const names = captured.map((c) => c.name).sort();
    expect(names).toContain("godaddy_dns_list");
    expect(names).toContain("godaddy_dns_set_cname");
    expect(names).toContain("godaddy_dns_delete");
    expect(names.length).toBe(10);
  });

  it("does NOT register GoDaddy tools when goDaddy option is omitted", () => {
    createMcpServer({ renderApiToken: "rnd_test" });
    const godaddyTools = captured.filter((c) => c.name.startsWith("godaddy_"));
    expect(godaddyTools).toEqual([]);
  });

  it("every tool has a description for the LLM", () => {
    createMcpServer({
      renderApiToken: "rnd_test",
      goDaddy: { key: "k", secret: "s" },
    });

    for (const c of captured) {
      expect(c.config.description, `${c.name} should have a description`).toBeTruthy();
    }
  });

  it("returns an McpServer instance", () => {
    const server = createMcpServer({ renderApiToken: "rnd_test" });
    expect(server).toBeInstanceOf(McpServer);
  });

  it("validates GoDaddy credentials eagerly (throws on construction)", () => {
    expect(() =>
      createMcpServer({
        renderApiToken: "rnd_test",
        goDaddy: { key: "", secret: "" },
      })
    ).toThrow(/required/i);
  });
});
