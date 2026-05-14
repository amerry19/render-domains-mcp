import { describe, it, expect, vi } from "vitest";

import { GoDaddyApiError, type DnsRecord } from "../src/godaddy.js";
import {
  godaddyDnsList,
  godaddyDnsSetCname,
  godaddyDnsDelete,
} from "../src/godaddy-tools.js";

interface FakeClient {
  listRecords: ReturnType<typeof vi.fn>;
  upsertCname: ReturnType<typeof vi.fn>;
  deleteRecords: ReturnType<typeof vi.fn>;
}

function fakeClient(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    listRecords: vi.fn().mockResolvedValue([]),
    upsertCname: vi.fn().mockResolvedValue(undefined),
    deleteRecords: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function parsedBody(content: { content: { text: string }[] }): unknown {
  return JSON.parse(content.content[0].text);
}

const RECORDS: DnsRecord[] = [
  { type: "A", name: "@", data: "1.2.3.4", ttl: 600 },
  { type: "CNAME", name: "www", data: "example.com", ttl: 3600 },
];

describe("godaddyDnsList", () => {
  it("returns count and records from the client", async () => {
    const client = fakeClient({ listRecords: vi.fn().mockResolvedValue(RECORDS) });

    const result = await godaddyDnsList(client as never, { domain: "example.com" });

    expect(client.listRecords).toHaveBeenCalledWith("example.com", { type: undefined, name: undefined });
    const body = parsedBody(result) as { count: number; records: DnsRecord[] };
    expect(body.count).toBe(2);
    expect(body.records).toEqual(RECORDS);
  });

  it("forwards type + name filters to the client", async () => {
    const client = fakeClient();
    await godaddyDnsList(client as never, { domain: "example.com", type: "CNAME", name: "www" });
    expect(client.listRecords).toHaveBeenCalledWith("example.com", { type: "CNAME", name: "www" });
  });

  it("returns isError content on GoDaddyApiError", async () => {
    const client = fakeClient({
      listRecords: vi.fn().mockRejectedValue(new GoDaddyApiError(401, "bad key", "auth failed")),
    });

    const result = await godaddyDnsList(client as never, { domain: "example.com" });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const body = parsedBody(result) as { error: string; godaddyStatus: number };
    expect(body.godaddyStatus).toBe(401);
    expect(body.error).toContain("auth failed");
  });
});

describe("godaddyDnsSetCname", () => {
  it("calls upsertCname with name+target and reports success", async () => {
    const client = fakeClient();

    const result = await godaddyDnsSetCname(client as never, {
      domain: "example.com",
      name: "test-mcp",
      target: "myapp.onrender.com",
    });

    expect(client.upsertCname).toHaveBeenCalledWith("example.com", "test-mcp", "myapp.onrender.com", undefined);
    const body = parsedBody(result) as { ok: boolean; record: DnsRecord };
    expect(body.ok).toBe(true);
    expect(body.record).toEqual({ type: "CNAME", name: "test-mcp", data: "myapp.onrender.com", ttl: 3600 });
  });

  it("passes a custom TTL through", async () => {
    const client = fakeClient();
    await godaddyDnsSetCname(client as never, {
      domain: "example.com",
      name: "test-mcp",
      target: "myapp.onrender.com",
      ttl: 600,
    });
    expect(client.upsertCname).toHaveBeenCalledWith("example.com", "test-mcp", "myapp.onrender.com", 600);
  });

  it("returns isError on rejection", async () => {
    const client = fakeClient({
      upsertCname: vi.fn().mockRejectedValue(new Error("network")),
    });

    const result = await godaddyDnsSetCname(client as never, {
      domain: "example.com",
      name: "test",
      target: "x.onrender.com",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});

describe("godaddyDnsDelete", () => {
  it("calls deleteRecords with the right args", async () => {
    const client = fakeClient();

    const result = await godaddyDnsDelete(client as never, {
      domain: "example.com",
      type: "CNAME",
      name: "test-mcp",
    });

    expect(client.deleteRecords).toHaveBeenCalledWith("example.com", "CNAME", "test-mcp");
    const body = parsedBody(result) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  it("returns isError on rejection", async () => {
    const client = fakeClient({
      deleteRecords: vi.fn().mockRejectedValue(new GoDaddyApiError(404, "no such record", "Not Found")),
    });

    const result = await godaddyDnsDelete(client as never, {
      domain: "example.com",
      type: "CNAME",
      name: "missing",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
