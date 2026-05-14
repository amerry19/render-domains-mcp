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

export interface SecretsSetArgs {
  serviceId: string;
  secrets: { key: string; value: string }[];
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

/**
 * Set secret env vars on a Render service WITHOUT echoing values back in
 * the response. Counter-positions Render's official MCP
 * `update_environment_variables` tool, which returns the values it sets —
 * leaking secrets into the agent's transcript / context.
 *
 * The values still pass through the agent ONCE (when the user provides
 * them), but they don't get echoed a second time. For a fully redacted
 * flow the user should provide values via a local `! read -s …` shell
 * command rather than typing them into chat.
 */
export async function renderSecretsSet(
  client: RenderClient,
  args: SecretsSetArgs
): Promise<McpTextContent> {
  try {
    await client.setEnvVars(args.serviceId, args.secrets);
    return jsonContent({
      ok: true,
      serviceId: args.serviceId,
      keysSet: args.secrets.map((s) => s.key),
      note:
        "Values intentionally not echoed in this response (this is the point of the tool). " +
        "Render will auto-redeploy the service in ~30-60 seconds; new env vars take effect on the next live deploy.",
    });
  } catch (err) {
    return errorContent(err);
  }
}

/**
 * Returns markdown explaining how to get a Render API token and find a
 * service ID. Useful for first-time onboarding — the agent can call this
 * tool to teach a user about the inputs the rest of the Render tools need.
 */
export function renderSetupGuide(): McpTextContent {
  const text = `# Render API Credentials Setup

This MCP server talks to Render's REST API on your behalf. To configure it you need two things: an API token and the service ID you want to manage custom domains for.

## 1. Generate an API token

1. **Open** https://dashboard.render.com/u/settings#api-keys
2. **Click** "Create API Key"
3. **Name** it something descriptive (e.g. \`render-domains-mcp\`)
4. **Copy the token** (starts with \`rnd_...\`) — it's shown once only

## 2. Find your service ID

1. **Open** https://dashboard.render.com/services
2. **Click** the service you want to manage (web service or static site)
3. **Copy the ID** from the URL — format: \`srv-...\` (e.g. \`srv-d81l8apo3t8c739e1nlg\`)

You can also call \`mcp__render__list_services\` from the official Render MCP if it's connected — it returns all services with their IDs.

## 3. How to use these

- **Local stdio mode** (Claude Code / Cursor / Codex):
  Set \`RENDER_API_TOKEN=rnd_...\` in your shell before running the server.

- **Hosted HTTP mode** (this MCP running on Render itself):
  Set \`RENDER_API_TOKEN\` as an env var on the service via the official Render MCP's \`update_environment_variables\` — no dashboard handoff required.

## Security

Render API tokens have full account access by default. Treat them like a password. Rotate or revoke individual keys from the dashboard.`;
  return { content: [{ type: "text", text }] };
}
