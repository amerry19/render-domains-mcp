import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { createMcpServer } from "../src/server.js";
import { RenderPassTokenStore } from "../src/render-pass.js";

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

  it("registers the 7 Render tools + render_secrets_set + 2 setup guides when GoDaddy creds are omitted", () => {
    createMcpServer({ renderApiToken: "rnd_test" });

    const names = captured.map((c) => c.name).sort();
    expect(names).toEqual([
      "godaddy_setup_guide",
      "render_domains_add",
      "render_domains_dns_check",
      "render_domains_get",
      "render_domains_list",
      "render_domains_remove",
      "render_domains_verify",
      "render_domains_verify_status",
      "render_secrets_set",
      "render_setup_guide",
    ]);
  });

  it("adds the 3 GoDaddy action tools when credentials are provided", () => {
    createMcpServer({
      renderApiToken: "rnd_test",
      goDaddy: { key: "gd_key", secret: "gd_secret" },
    });

    const names = captured.map((c) => c.name).sort();
    expect(names).toContain("godaddy_dns_list");
    expect(names).toContain("godaddy_dns_set_cname");
    expect(names).toContain("godaddy_dns_delete");
    expect(names.length).toBe(13); // 7 render-domains + render_secrets_set + 2 guides + 3 godaddy
  });

  it("adds render_pass_request when passTokenStore is provided (HTTP mode)", () => {
    createMcpServer({
      renderApiToken: "rnd_test",
      passTokenStore: new RenderPassTokenStore(),
    });

    const names = captured.map((c) => c.name);
    expect(names).toContain("render_pass_request");
  });

  it("does NOT register render_pass_request when no store (stdio mode default)", () => {
    createMcpServer({ renderApiToken: "rnd_test" });
    const names = captured.map((c) => c.name);
    expect(names).not.toContain("render_pass_request");
  });

  it("registers godaddy_setup_guide even without creds (so agent can onboard the user)", () => {
    createMcpServer({ renderApiToken: "rnd_test" });
    const names = captured.map((c) => c.name);
    expect(names).toContain("godaddy_setup_guide");
    // But the action tools are still gated
    const actionTools = names.filter((n) => n.startsWith("godaddy_dns_"));
    expect(actionTools).toEqual([]);
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
