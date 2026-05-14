import { describe, it, expect } from "vitest";

import { godaddySetupGuide } from "../src/godaddy-tools.js";
import { renderSetupGuide } from "../src/render-tools.js";

function textOf(content: { content: { text: string }[] }): string {
  return content.content[0].text;
}

describe("godaddySetupGuide", () => {
  it("returns markdown referencing the GoDaddy API key portal", () => {
    const text = textOf(godaddySetupGuide());
    expect(text).toContain("developer.godaddy.com/keys");
    expect(text).toMatch(/production/i); // emphasize Production env, not OTE
  });

  it("instructs the agent to wire creds via our non-echoing render_secrets_set tool", () => {
    const text = textOf(godaddySetupGuide());
    // Agent-facing hint that closes the credential-handoff loop
    expect(text).toContain("render_secrets_set");
    expect(text).toMatch(/GODADDY_API_KEY/);
    expect(text).toMatch(/GODADDY_API_SECRET/);
  });

  it("documents the secure shell-prompt pattern for value entry", () => {
    const text = textOf(godaddySetupGuide());
    // Reference the `read -s` silent-input pattern so values don't leak via chat
    expect(text).toMatch(/read -s|secure|silent/i);
  });

  it("calls out the April 2026 single-domain eligibility", () => {
    const text = textOf(godaddySetupGuide());
    expect(text).toMatch(/2026|single.{0,5}domain/i);
  });

  it("returns text content (not isError)", () => {
    const result = godaddySetupGuide();
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
  });
});

describe("renderSetupGuide", () => {
  it("returns markdown referencing the Render API key portal", () => {
    const text = textOf(renderSetupGuide());
    expect(text).toContain("dashboard.render.com");
    expect(text).toMatch(/api.{0,5}key/i);
  });

  it("explains how to find a service ID", () => {
    const text = textOf(renderSetupGuide());
    expect(text).toMatch(/service.{0,5}id/i);
    expect(text).toContain("srv-");
  });

  it("returns text content (not isError)", () => {
    const result = renderSetupGuide();
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
  });
});
