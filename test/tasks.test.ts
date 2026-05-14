import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TaskRegistry, runVerifyTask } from "../src/tasks.js";
import type { CustomDomain } from "../src/render.js";

function makeDomain(overrides: Partial<CustomDomain> = {}): CustomDomain {
  return {
    id: "cdm-test",
    name: "example.com",
    domainType: "apex",
    verificationStatus: "unverified",
    publicSuffix: "com",
    redirectForName: "",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("TaskRegistry", () => {
  it("creates a task with expected fields", () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv-1", "cdm-1", "example.com");

    expect(task.taskId).toMatch(/^task-/);
    expect(task.serviceId).toBe("srv-1");
    expect(task.domainId).toBe("cdm-1");
    expect(task.domainName).toBe("example.com");
    expect(task.status).toBe("pending");
    expect(task.pollAttempts).toBe(0);
    expect(task.createdAt).toBeTypeOf("string");
    expect(task.updatedAt).toBe(task.createdAt);
  });

  it("get() returns the registered task", () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");
    expect(registry.get(task.taskId)).toEqual(task);
  });

  it("get() returns undefined for unknown taskId", () => {
    expect(new TaskRegistry().get("task-unknown")).toBeUndefined();
  });

  it("update() merges fields and bumps updatedAt", async () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");
    const originalUpdatedAt = task.updatedAt;

    await new Promise((r) => setTimeout(r, 5));
    const updated = registry.update(task.taskId, { status: "running", pollAttempts: 3 });

    expect(updated?.status).toBe("running");
    expect(updated?.pollAttempts).toBe(3);
    expect(updated?.updatedAt).not.toBe(originalUpdatedAt);
  });

  it("update() returns undefined for unknown taskId", () => {
    expect(new TaskRegistry().update("task-unknown", { status: "running" })).toBeUndefined();
  });

  it("toHandle() returns a poll-friendly shape", () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");
    const handle = registry.toHandle(task);

    expect(handle.taskId).toBe(task.taskId);
    expect(handle.status).toBe("pending");
    expect(handle.pollWith).toContain("render_domains_verify_status");
    expect(handle.pollWith).toContain(task.taskId);
  });
});

describe("runVerifyTask", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions to running when triggering verify", async () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");

    const trigger = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue(makeDomain({ verificationStatus: "unverified" }));

    const promise = runVerifyTask(registry, task, trigger, fetcher, { timeoutMs: 100, initialIntervalMs: 1000 });

    // Yield to allow trigger() promise to resolve before assertions
    await vi.advanceTimersByTimeAsync(0);
    expect(registry.get(task.taskId)?.status).toBe("running");
    expect(trigger).toHaveBeenCalledOnce();

    // Let it finish
    await vi.runAllTimersAsync();
    await promise;
  });

  it("transitions to completed when Render reports verified", async () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");
    const verifiedDomain = makeDomain({ verificationStatus: "verified" });

    const trigger = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue(verifiedDomain);

    const promise = runVerifyTask(registry, task, trigger, fetcher, {
      timeoutMs: 10_000,
      initialIntervalMs: 1000,
    });

    await vi.runAllTimersAsync();
    await promise;

    const final = registry.get(task.taskId);
    expect(final?.status).toBe("completed");
    expect(final?.result).toEqual(verifiedDomain);
  });

  it("transitions to failed when Render reports verification_failed", async () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");

    const trigger = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue(makeDomain({ verificationStatus: "verification_failed" }));

    const promise = runVerifyTask(registry, task, trigger, fetcher, {
      timeoutMs: 10_000,
      initialIntervalMs: 1000,
    });

    await vi.runAllTimersAsync();
    await promise;

    const final = registry.get(task.taskId);
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("verification_failed");
  });

  it("transitions to timed_out when deadline passes without verification", async () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");

    const trigger = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue(makeDomain({ verificationStatus: "unverified" }));

    const promise = runVerifyTask(registry, task, trigger, fetcher, {
      timeoutMs: 5_000,
      initialIntervalMs: 1000,
      maxIntervalMs: 2000,
    });

    await vi.runAllTimersAsync();
    await promise;

    const final = registry.get(task.taskId);
    expect(final?.status).toBe("timed_out");
    expect(final?.error).toBe("timeout");
  });

  it("transitions to failed when triggerVerify itself throws", async () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");

    const trigger = vi.fn().mockRejectedValue(new Error("Render API 500"));
    const fetcher = vi.fn();

    await runVerifyTask(registry, task, trigger, fetcher, { timeoutMs: 1000, initialIntervalMs: 100 });

    const final = registry.get(task.taskId);
    expect(final?.status).toBe("failed");
    expect(final?.error).toContain("Render API 500");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries when fetchDomain throws transiently", async () => {
    const registry = new TaskRegistry();
    const task = registry.createVerifyTask("srv", "cdm", "ex.com");
    const verifiedDomain = makeDomain({ verificationStatus: "verified" });

    const trigger = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(verifiedDomain);

    const promise = runVerifyTask(registry, task, trigger, fetcher, {
      timeoutMs: 30_000,
      initialIntervalMs: 1000,
      maxIntervalMs: 2000,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(registry.get(task.taskId)?.status).toBe("completed");
  });
});
