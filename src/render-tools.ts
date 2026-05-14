/**
 * Pure-function tool handlers for the Render adapter.
 *
 * Mirrors the godaddy-tools.ts shape: each function takes the relevant
 * dependencies + parsed args and returns an MCP content object. No coupling
 * to the McpServer instance — registration lives in src/server.ts.
 */

import type { RenderClient } from "./render.js";
import type { TaskRegistry } from "./tasks.js";
import { runVerifyTask } from "./tasks.js";
import { jsonContent, errorContent, type McpTextContent } from "./mcp-helpers.js";

// ----------------------------------------------------------------------------
// Argument shapes — keep aligned with the zod schemas in server.ts
// ----------------------------------------------------------------------------

export interface ListArgs {
  serviceId: string;
}

export interface GetArgs {
  serviceId: string;
  domainId: string;
}

export interface AddArgs {
  serviceId: string;
  name: string;
}

export interface RemoveArgs {
  serviceId: string;
  domainId: string;
}

export interface VerifyArgs {
  serviceId: string;
  domainId: string;
  timeoutSeconds?: number;
}

export interface VerifyStatusArgs {
  taskId: string;
}

// ----------------------------------------------------------------------------
// Handlers
// ----------------------------------------------------------------------------

export async function renderDomainsList(
  client: RenderClient,
  args: ListArgs
): Promise<McpTextContent> {
  try {
    const domains = await client.listDomains(args.serviceId);
    return jsonContent({ count: domains.length, domains });
  } catch (err) {
    return errorContent(err);
  }
}

export async function renderDomainsGet(
  client: RenderClient,
  args: GetArgs
): Promise<McpTextContent> {
  try {
    const domain = await client.getDomain(args.serviceId, args.domainId);
    return jsonContent(domain);
  } catch (err) {
    return errorContent(err);
  }
}

export async function renderDomainsAdd(
  client: RenderClient,
  args: AddArgs
): Promise<McpTextContent> {
  try {
    const domain = await client.addDomain(args.serviceId, args.name);
    const dnsHint =
      domain.domainType === "apex"
        ? "Add an A record at @ pointing to 216.24.57.1 (Render's static site IP) or an ALIAS/ANAME to the Render-provided target"
        : `Add a CNAME at ${args.name.split(".")[0]} pointing to <your-service>.onrender.com`;
    return jsonContent({
      domain,
      nextSteps: [
        dnsHint,
        `Then call render_domains_verify({ serviceId: "${args.serviceId}", domainId: "${domain.id}" })`,
      ],
    });
  } catch (err) {
    return errorContent(err);
  }
}

export async function renderDomainsRemove(
  client: RenderClient,
  args: RemoveArgs
): Promise<McpTextContent> {
  try {
    await client.removeDomain(args.serviceId, args.domainId);
    return jsonContent({ removed: true, domainId: args.domainId });
  } catch (err) {
    return errorContent(err);
  }
}

export async function renderDomainsVerify(
  client: RenderClient,
  registry: TaskRegistry,
  args: VerifyArgs
): Promise<McpTextContent> {
  try {
    const domain = await client.getDomain(args.serviceId, args.domainId);
    const task = registry.createVerifyTask(args.serviceId, args.domainId, domain.name);

    // Fire-and-forget the polling loop. Task state updates via the registry.
    void runVerifyTask(
      registry,
      task,
      () => client.triggerVerify(args.serviceId, args.domainId),
      () => client.getDomain(args.serviceId, args.domainId),
      args.timeoutSeconds ? { timeoutMs: args.timeoutSeconds * 1000 } : {}
    );

    return jsonContent({
      ...registry.toHandle(task),
      domain: { id: domain.id, name: domain.name, currentStatus: domain.verificationStatus },
      note: "Background verification started. Poll render_domains_verify_status with the taskId to observe progress.",
    });
  } catch (err) {
    return errorContent(err);
  }
}

export function renderDomainsVerifyStatus(
  registry: TaskRegistry,
  args: VerifyStatusArgs
): McpTextContent {
  const task = registry.get(args.taskId);
  if (!task) {
    return errorContent(
      new Error(`No task with id ${args.taskId} (may have been evicted after TTL)`)
    );
  }
  return jsonContent({
    taskId: task.taskId,
    status: task.status,
    statusMessage: task.statusMessage,
    pollAttempts: task.pollAttempts,
    domain: task.domainName,
    result: task.result,
    error: task.error,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}
