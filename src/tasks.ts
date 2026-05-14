/**
 * In-memory task registry implementing the MCP Tasks PATTERN.
 *
 * This is intentionally a forward-compatible shim for the experimental
 * `server.experimental.tasks.registerToolTask` API in @modelcontextprotocol/sdk
 * v2.0.0-alpha (April 2026). When v2 stabilizes, the verify tool can migrate
 * to native Tasks with minimal changes — the semantic contract is identical:
 *
 *   1. Tool call returns a task handle (taskId + initial status)
 *   2. Caller polls a separate status tool to observe progress
 *   3. Terminal states: completed | failed | timed_out
 *
 * Rationale for shipping on v1.29 + pattern rather than v2-alpha:
 *   - v2 Tasks API is flagged experimental
 *   - The reference example uses HTTP/SSE transport; Claude Code prefers stdio
 *   - Stability matters more than novelty for a demo POC
 */

import { randomUUID } from "node:crypto";
import type { CustomDomain } from "./render.js";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "timed_out";

export interface VerifyTask {
  taskId: string;
  serviceId: string;
  domainId: string;
  domainName: string;
  status: TaskStatus;
  statusMessage: string;
  result?: CustomDomain;
  error?: string;
  createdAt: string;
  updatedAt: string;
  pollAttempts: number;
}

export interface TaskHandle {
  taskId: string;
  status: TaskStatus;
  statusMessage: string;
  pollWith: string; // human-readable hint to the agent
}

interface TaskOptions {
  /** Total wait budget before marking timed_out (ms). Default 5 min. */
  timeoutMs?: number;
  /** Initial poll interval (ms). Doubles up to maxIntervalMs. Default 3s. */
  initialIntervalMs?: number;
  /** Max poll interval after backoff (ms). Default 30s. */
  maxIntervalMs?: number;
}

const TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

export class TaskRegistry {
  private tasks = new Map<string, VerifyTask>();

  createVerifyTask(
    serviceId: string,
    domainId: string,
    domainName: string
  ): VerifyTask {
    const now = new Date().toISOString();
    const task: VerifyTask = {
      taskId: `task-${randomUUID()}`,
      serviceId,
      domainId,
      domainName,
      status: "pending",
      statusMessage: "Task created, awaiting verification trigger",
      createdAt: now,
      updatedAt: now,
      pollAttempts: 0,
    };
    this.tasks.set(task.taskId, task);
    this.gc();
    return task;
  }

  get(taskId: string): VerifyTask | undefined {
    return this.tasks.get(taskId);
  }

  update(taskId: string, patch: Partial<VerifyTask>): VerifyTask | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    return t;
  }

  /** Evict tasks older than TASK_TTL_MS. Cheap to call on every mutation. */
  private gc(): void {
    const cutoff = Date.now() - TASK_TTL_MS;
    for (const [id, t] of this.tasks) {
      if (new Date(t.updatedAt).getTime() < cutoff) {
        this.tasks.delete(id);
      }
    }
  }

  toHandle(task: VerifyTask): TaskHandle {
    return {
      taskId: task.taskId,
      status: task.status,
      statusMessage: task.statusMessage,
      pollWith: `render_domains_verify_status({ taskId: "${task.taskId}" })`,
    };
  }
}

/**
 * Background polling loop. Fire-and-forget — updates the registry as state
 * changes, so the agent's status polls always reflect the latest known state.
 *
 * Two-phase pattern:
 *   Phase 1 — poll Render's verificationStatus (the DNS/ownership check)
 *   Phase 2 — poll the actual HTTPS handshake (proxies cert issuance, which
 *             Render's REST API does NOT surface)
 *
 * The task only flips to `completed` when both phases succeed: the URL
 * actually serves traffic with a valid TLS cert. This avoids the UX trap
 * where Render says "verified" but the browser shows ERR_SSL because the
 * cert hasn't issued yet (usually 1-5 min lag).
 *
 * `httpsCheck` is optional — pass `undefined` to skip phase 2 (e.g. when
 * the caller only cares about Render-side verification, not user-facing
 * URL readiness).
 */
export async function runVerifyTask(
  registry: TaskRegistry,
  task: VerifyTask,
  triggerVerify: () => Promise<void>,
  fetchDomain: () => Promise<CustomDomain>,
  httpsCheck: ((domain: string) => Promise<boolean>) | undefined,
  options: TaskOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const initialIntervalMs = options.initialIntervalMs ?? 3_000;
  const maxIntervalMs = options.maxIntervalMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  registry.update(task.taskId, {
    status: "running",
    statusMessage: "Triggering Render verification check",
  });

  try {
    await triggerVerify();
  } catch (err) {
    registry.update(task.taskId, {
      status: "failed",
      statusMessage: "Failed to trigger verification on Render",
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  let interval = initialIntervalMs;
  let verifiedDomain: CustomDomain | undefined;

  // --------------------------------------------------------------------------
  // Phase 1: wait for Render's verificationStatus → "verified"
  // --------------------------------------------------------------------------
  while (Date.now() < deadline && !verifiedDomain) {
    await sleep(interval);

    let domain: CustomDomain;
    try {
      domain = await fetchDomain();
    } catch (err) {
      registry.update(task.taskId, {
        statusMessage: `Poll failed (will retry): ${err instanceof Error ? err.message : err}`,
        pollAttempts: (registry.get(task.taskId)?.pollAttempts ?? 0) + 1,
      });
      interval = Math.min(interval * 2, maxIntervalMs);
      continue;
    }

    const currentTask = registry.get(task.taskId);
    if (!currentTask) return; // evicted

    registry.update(task.taskId, {
      pollAttempts: currentTask.pollAttempts + 1,
      statusMessage: `Phase 1 — Render reports verificationStatus=${domain.verificationStatus}`,
    });

    if (domain.verificationStatus === "verified") {
      verifiedDomain = domain;
      break;
    }

    if (
      domain.verificationStatus === "verification_failed" ||
      domain.verificationStatus === "expired"
    ) {
      registry.update(task.taskId, {
        status: "failed",
        statusMessage: `Render verification reached terminal failure state: ${domain.verificationStatus}`,
        result: domain,
        error: `verificationStatus=${domain.verificationStatus}`,
      });
      return;
    }

    interval = Math.min(interval * 2, maxIntervalMs);
  }

  if (!verifiedDomain) {
    registry.update(task.taskId, {
      status: "timed_out",
      statusMessage: `Phase 1 timed out — Render did not verify within ${Math.round(timeoutMs / 1000)}s`,
      error: "timeout (phase 1: verification)",
    });
    return;
  }

  // --------------------------------------------------------------------------
  // Phase 2: wait for the HTTPS handshake to succeed (proxy for cert issued).
  // Skipped if no httpsCheck function provided.
  // --------------------------------------------------------------------------
  if (!httpsCheck) {
    registry.update(task.taskId, {
      status: "completed",
      statusMessage: "Domain verified by Render (TLS check skipped)",
      result: verifiedDomain,
    });
    return;
  }

  registry.update(task.taskId, {
    statusMessage: "Phase 2 — Render verified the domain. Waiting for HTTPS cert to issue…",
  });

  // Reset interval for phase 2 (cert issuance is usually 1-5 min, so faster
  // poll cadence is fine).
  interval = initialIntervalMs;

  while (Date.now() < deadline) {
    await sleep(interval);

    let tlsReady = false;
    try {
      tlsReady = await httpsCheck(verifiedDomain.name);
    } catch {
      tlsReady = false;
    }

    const currentTask = registry.get(task.taskId);
    if (!currentTask) return; // evicted

    registry.update(task.taskId, {
      pollAttempts: currentTask.pollAttempts + 1,
      statusMessage: tlsReady
        ? "Phase 2 — HTTPS handshake succeeded"
        : "Phase 2 — Waiting for HTTPS cert (still failing handshake)",
    });

    if (tlsReady) {
      registry.update(task.taskId, {
        status: "completed",
        statusMessage: "Domain verified AND HTTPS cert issued — URL is live",
        result: verifiedDomain,
      });
      return;
    }

    interval = Math.min(interval * 2, maxIntervalMs);
  }

  registry.update(task.taskId, {
    status: "timed_out",
    statusMessage: `Phase 2 timed out — Render verified but HTTPS cert did not issue within ${Math.round(timeoutMs / 1000)}s`,
    error: "timeout (phase 2: cert issuance)",
    result: verifiedDomain,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
