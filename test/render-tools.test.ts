import { describe, it, expect, vi } from "vitest";

import { RenderApiError, type CustomDomain } from "../src/render.js";
import { TaskRegistry } from "../src/tasks.js";
import {
  renderDomainsAdd,
  renderDomainsGet,
  renderDomainsList,
  renderDomainsRemove,
  renderDomainsVerify,
  renderDomainsVerifyStatus,
  renderSecretsSet,
} from "../src/render-tools.js";

interface FakeClient {
  listDomains: ReturnType<typeof vi.fn>;
  getDomain: ReturnType<typeof vi.fn>;
  addDomain: ReturnType<typeof vi.fn>;
  triggerVerify: ReturnType<typeof vi.fn>;
  removeDomain: ReturnType<typeof vi.fn>;
  setEnvVars: ReturnType<typeof vi.fn>;
  triggerDeploy: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listDomains: vi.fn().mockResolvedValue([]),
    getDomain: vi.fn(),
    addDomain: vi.fn(),
    triggerVerify: vi.fn().mockResolvedValue(undefined),
    removeDomain: vi.fn().mockResolvedValue(undefined),
    setEnvVars: vi.fn().mockResolvedValue(undefined),
    triggerDeploy: vi.fn().mockResolvedValue("dep-test-123"),
    ...overrides,
  };
}

function parsedBody(content: { content: { text: string }[] }): unknown {
  return JSON.parse(content.content[0].text);
}

const APEX: CustomDomain = {
  id: "cdm-apex",
  name: "example.com",
  domainType: "apex",
  verificationStatus: "verified",
  publicSuffix: "com",
  redirectForName: "",
  createdAt: "2026-01-01T00:00:00Z",
};

const SUBDOMAIN: CustomDomain = { ...APEX, id: "cdm-www", name: "www.example.com", domainType: "subdomain" };

describe("renderDomainsList", () => {
  it("returns count + domains", async () => {
    const client = fakeClient({ listDomains: vi.fn().mockResolvedValue([APEX, SUBDOMAIN]) });
    const result = await renderDomainsList(client as never, { serviceId: "srv-1" });
    const body = parsedBody(result) as { count: number; domains: CustomDomain[] };
    expect(body.count).toBe(2);
    expect(body.domains).toEqual([APEX, SUBDOMAIN]);
  });

  it("returns isError on RenderApiError", async () => {
    const client = fakeClient({
      listDomains: vi.fn().mockRejectedValue(new RenderApiError(401, "bad", "unauthorized")),
    });
    const result = await renderDomainsList(client as never, { serviceId: "srv-1" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((parsedBody(result) as { renderStatus: number }).renderStatus).toBe(401);
  });
});

describe("renderDomainsGet", () => {
  it("returns the domain object fields", async () => {
    const client = fakeClient({ getDomain: vi.fn().mockResolvedValue(APEX) });
    const result = await renderDomainsGet(client as never, { serviceId: "srv", domainId: "cdm-apex" });
    const body = parsedBody(result) as CustomDomain & { summary: string };
    expect(body.id).toBe(APEX.id);
    expect(body.name).toBe(APEX.name);
    expect(body.verificationStatus).toBe(APEX.verificationStatus);
    expect(body.summary).toContain(APEX.name);
  });

  it("returns isError on failure", async () => {
    const client = fakeClient({
      getDomain: vi.fn().mockRejectedValue(new RenderApiError(404, "", "not found")),
    });
    const result = await renderDomainsGet(client as never, { serviceId: "srv", domainId: "cdm-x" });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("renderDomainsAdd", () => {
  it("returns the new domain + apex-specific next steps", async () => {
    const client = fakeClient({ addDomain: vi.fn().mockResolvedValue(APEX) });
    const result = await renderDomainsAdd(client as never, { serviceId: "srv", name: "example.com" });
    const body = parsedBody(result) as { domain: CustomDomain; nextSteps: string[] };
    expect(body.domain).toEqual(APEX);
    expect(body.nextSteps[0]).toContain("A record");
    expect(body.nextSteps[1]).toContain("render_domains_verify");
  });

  it("gives CNAME guidance for subdomain types", async () => {
    const client = fakeClient({ addDomain: vi.fn().mockResolvedValue(SUBDOMAIN) });
    const result = await renderDomainsAdd(client as never, { serviceId: "srv", name: "www.example.com" });
    const body = parsedBody(result) as { nextSteps: string[] };
    expect(body.nextSteps[0]).toContain("CNAME");
    expect(body.nextSteps[0]).toContain("www");
  });
});

describe("renderDomainsRemove", () => {
  it("acks removal with the domainId", async () => {
    const client = fakeClient();
    const result = await renderDomainsRemove(client as never, { serviceId: "srv", domainId: "cdm-x" });
    const body = parsedBody(result) as { removed: boolean; domainId: string };
    expect(body.removed).toBe(true);
    expect(body.domainId).toBe("cdm-x");
    expect(client.removeDomain).toHaveBeenCalledWith("srv", "cdm-x");
  });

  it("returns isError on rejection", async () => {
    const client = fakeClient({ removeDomain: vi.fn().mockRejectedValue(new Error("boom")) });
    const result = await renderDomainsRemove(client as never, { serviceId: "srv", domainId: "cdm-x" });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("renderDomainsVerify", () => {
  it("default (fire-and-forget): triggers verify and returns guidance without spawning a task", async () => {
    const client = fakeClient({ getDomain: vi.fn().mockResolvedValue(APEX) });
    const registry = new TaskRegistry();

    const result = await renderDomainsVerify(client as never, registry, {
      serviceId: "srv",
      domainId: "cdm-apex",
    });

    const body = parsedBody(result) as {
      triggered: boolean;
      taskId?: string;
      summary: string;
      nextStep: string;
    };
    expect(body.triggered).toBe(true);
    expect(body.taskId).toBeUndefined(); // no task in fire-and-forget mode
    expect(body.summary).toMatch(/render_domains_check|TLS cert|cert/i);
    expect(body.nextStep).toContain("render_domains_check");
    expect(client.triggerVerify).toHaveBeenCalledWith("srv", "cdm-apex");
  });

  it("pollUntilReady=true: spawns a task and returns a handle", async () => {
    const client = fakeClient({ getDomain: vi.fn().mockResolvedValue(APEX) });
    const registry = new TaskRegistry();

    const result = await renderDomainsVerify(client as never, registry, {
      serviceId: "srv",
      domainId: "cdm-apex",
      pollUntilReady: true,
    });

    const body = parsedBody(result) as { taskId: string; domain: { name: string } };
    expect(body.taskId).toMatch(/^task-/);
    expect(body.domain.name).toBe("example.com");
    expect(registry.get(body.taskId)).toBeDefined();
  });

  it("returns isError if the initial getDomain fails", async () => {
    const client = fakeClient({
      getDomain: vi.fn().mockRejectedValue(new RenderApiError(404, "", "not found")),
    });
    const result = await renderDomainsVerify(client as never, new TaskRegistry(), {
      serviceId: "srv",
      domainId: "cdm-missing",
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("renderDomainsCheck", () => {
  it("returns ready_to_serve=true when verified AND TLS handshake succeeds", async () => {
    const client = fakeClient({ getDomain: vi.fn().mockResolvedValue(APEX) });
    const httpsCheck = vi.fn().mockResolvedValue(true);

    const { renderDomainsCheck } = await import("../src/render-tools.js");
    const result = await renderDomainsCheck(client as never, { serviceId: "srv", domainId: "cdm-x" }, httpsCheck);

    const body = parsedBody(result) as {
      readyToServe: boolean;
      verificationStatus: string;
      tlsHandshake: string;
      summary: string;
    };
    expect(body.readyToServe).toBe(true);
    expect(body.verificationStatus).toBe("verified");
    expect(body.tlsHandshake).toBe("ok");
    expect(body.summary).toMatch(/is live|live/i);
  });

  it("returns ready_to_serve=false when verified but TLS cert still issuing", async () => {
    const client = fakeClient({ getDomain: vi.fn().mockResolvedValue(APEX) });
    const httpsCheck = vi.fn().mockResolvedValue(false);

    const { renderDomainsCheck } = await import("../src/render-tools.js");
    const result = await renderDomainsCheck(client as never, { serviceId: "srv", domainId: "cdm-x" }, httpsCheck);

    const body = parsedBody(result) as { readyToServe: boolean; summary: string };
    expect(body.readyToServe).toBe(false);
    expect(body.summary).toMatch(/cert.*issuing|try again/i);
  });

  it("returns ready_to_serve=false (and skips TLS probe) when domain not yet verified", async () => {
    const unverified = { ...APEX, verificationStatus: "unverified" };
    const client = fakeClient({ getDomain: vi.fn().mockResolvedValue(unverified) });
    const httpsCheck = vi.fn();

    const { renderDomainsCheck } = await import("../src/render-tools.js");
    const result = await renderDomainsCheck(client as never, { serviceId: "srv", domainId: "cdm-x" }, httpsCheck);

    const body = parsedBody(result) as { readyToServe: boolean };
    expect(body.readyToServe).toBe(false);
    expect(httpsCheck).not.toHaveBeenCalled(); // saves a network call
  });
});

describe("renderDomainsVerifyStatus", () => {
  it("returns task state for a known taskId", () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm-x", "example.com");
    registry.update(task.taskId, { status: "running", statusMessage: "polling" });

    const result = renderDomainsVerifyStatus(registry, { taskId: task.taskId });
    const body = parsedBody(result) as { taskId: string; status: string };
    expect(body.taskId).toBe(task.taskId);
    expect(body.status).toBe("running");
  });

  it("returns isError for an unknown taskId", () => {
    const result = renderDomainsVerifyStatus(new TaskRegistry(), { taskId: "task-missing" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(((parsedBody(result) as { error: string }).error)).toContain("No task with id");
  });
});

describe("renderSecretsSet", () => {
  it("forwards key+value pairs to the client", async () => {
    const client = fakeClient();
    await renderSecretsSet(client as never, {
      serviceId: "srv-abc",
      secrets: [
        { key: "GODADDY_API_KEY", value: "gd_sensitive_xxx" },
        { key: "GODADDY_API_SECRET", value: "gd_sensitive_yyy" },
      ],
    });
    expect(client.setEnvVars).toHaveBeenCalledWith("srv-abc", [
      { key: "GODADDY_API_KEY", value: "gd_sensitive_xxx" },
      { key: "GODADDY_API_SECRET", value: "gd_sensitive_yyy" },
    ]);
  });

  it("response contains the KEY NAMES but NEVER the secret values (no echo)", async () => {
    const client = fakeClient();
    const result = await renderSecretsSet(client as never, {
      serviceId: "srv-abc",
      secrets: [
        { key: "GODADDY_API_KEY", value: "gd_sensitive_xxx" },
        { key: "GODADDY_API_SECRET", value: "gd_sensitive_yyy" },
      ],
    });

    const text = result.content[0].text;
    expect(text).toContain("GODADDY_API_KEY");
    expect(text).toContain("GODADDY_API_SECRET");

    // Critical: the secret values must NOT appear anywhere in the response
    expect(text).not.toContain("gd_sensitive_xxx");
    expect(text).not.toContain("gd_sensitive_yyy");
  });

  it("returns ok=true on success", async () => {
    const client = fakeClient();
    const result = await renderSecretsSet(client as never, {
      serviceId: "srv-abc",
      secrets: [{ key: "FOO", value: "bar" }],
    });
    const body = parsedBody(result) as { ok: boolean; keysSet: string[] };
    expect(body.ok).toBe(true);
    expect(body.keysSet).toEqual(["FOO"]);
  });

  it("returns isError when the client rejects", async () => {
    const client = fakeClient({
      setEnvVars: vi.fn().mockRejectedValue(new Error("network down")),
    });
    const result = await renderSecretsSet(client as never, {
      serviceId: "srv-abc",
      secrets: [{ key: "FOO", value: "bar" }],
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  // ---- redeploy semantics (Render's API doesn't auto-deploy on env var change) ----

  it("triggers a deploy by default and returns the deploy id", async () => {
    const client = fakeClient({ triggerDeploy: vi.fn().mockResolvedValue("dep-xyz789") });
    const result = await renderSecretsSet(client as never, {
      serviceId: "srv-abc",
      secrets: [{ key: "FOO", value: "bar" }],
    });
    expect(client.triggerDeploy).toHaveBeenCalledWith("srv-abc");
    const body = parsedBody(result) as { ok: boolean; deployId: string };
    expect(body.ok).toBe(true);
    expect(body.deployId).toBe("dep-xyz789");
  });

  it("with redeploy=false: writes env vars WITHOUT triggering a deploy (batch-friendly)", async () => {
    const client = fakeClient();
    const result = await renderSecretsSet(client as never, {
      serviceId: "srv-abc",
      secrets: [{ key: "FOO", value: "bar" }],
      redeploy: false,
    });
    expect(client.setEnvVars).toHaveBeenCalledOnce();
    expect(client.triggerDeploy).not.toHaveBeenCalled();
    const body = parsedBody(result) as { ok: boolean; deployId?: string };
    expect(body.ok).toBe(true);
    expect(body.deployId).toBeUndefined();
  });

  it("if env-var write succeeds but deploy trigger fails, response surfaces both states", async () => {
    const client = fakeClient({
      triggerDeploy: vi.fn().mockRejectedValue(new Error("deploy API 500")),
    });
    const result = await renderSecretsSet(client as never, {
      serviceId: "srv-abc",
      secrets: [{ key: "FOO", value: "bar" }],
    });
    // setEnvVars did run
    expect(client.setEnvVars).toHaveBeenCalledOnce();
    // response is an error (overall flow failed), but mentions the env-var-write succeeded
    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/env.var.*written|secrets.*saved/i);
  });
});
