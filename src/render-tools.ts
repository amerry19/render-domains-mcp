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
import { defaultHttpsCheck, type HttpsCheck } from "./dns.js";
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
  /**
   * Opt in to background polling. When false (default), the tool triggers
   * Render's verification check and returns immediately — the agent isn't
   * tied up waiting on the 1-5 minute cert issuance. Use render_domains_check
   * for one-shot "is it ready" probes instead.
   */
  pollUntilReady?: boolean;
  /** Polling timeout in seconds (only used when pollUntilReady=true). */
  timeoutSeconds?: number;
}

export interface VerifyStatusArgs {
  taskId: string;
}

export interface CheckArgs {
  serviceId: string;
  domainId: string;
}

export interface SecretsSetArgs {
  serviceId: string;
  secrets: { key: string; value: string }[];
  /**
   * Default true. After writing env vars, also trigger a service deploy
   * so the new values take effect in the running container. Set false to
   * stage multiple secret changes before deploying once (batch mode).
   *
   * Why this default exists: Render's REST API does NOT auto-redeploy on
   * env var changes the way the dashboard does. Without an explicit
   * trigger, the running container keeps using the OLD env vars until
   * the next code-change deploy — silent failure mode.
   */
  redeploy?: boolean;
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
    const verified = domains.filter((d) => d.verificationStatus === "verified").length;
    return jsonContent({
      summary: `📋 ${args.serviceId}: ${domains.length} custom domain${domains.length === 1 ? "" : "s"} (${verified} verified).`,
      count: domains.length,
      domains,
    });
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
    return jsonContent({
      summary: `📄 ${domain.name} (${domain.domainType}) — verificationStatus=${domain.verificationStatus}.`,
      ...domain,
    });
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
      summary: `➕ Attached ${args.name} to ${args.serviceId} (status: unverified). Next: set DNS at the registrar, then call render_domains_verify.`,
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
    return jsonContent({
      summary: `🗑️ Removed domain ${args.domainId} from ${args.serviceId}.`,
      removed: true,
      domainId: args.domainId,
    });
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

    // Trigger Render's verification check.
    await client.triggerVerify(args.serviceId, args.domainId);

    // Default: fire-and-forget. Don't tie up the agent on a 1-5 min cert
    // wait that's outside our control. The agent can call render_domains_check
    // later when the user actually wants to confirm.
    if (!args.pollUntilReady) {
      return jsonContent({
        summary: `🔧 Triggered verification for ${domain.name}. Render checks DNS (~30s) then issues a TLS cert (1-5 min). Tell the user to try the URL in ~5 min, or call render_domains_check to confirm when ready.`,
        triggered: true,
        domain: { id: domain.id, name: domain.name, currentStatus: domain.verificationStatus },
        etaSeconds: { dnsCheck: "0-30", certIssuance: "60-300" },
        nextStep: `When the user wants to confirm: render_domains_check({ serviceId: "${args.serviceId}", domainId: "${args.domainId}" })`,
      });
    }

    // Opt-in: spawn the two-phase background polling task. Useful when the
    // caller genuinely wants to wait inline (automation scripts, etc.).
    const task = registry.createVerifyTask(args.serviceId, args.domainId, domain.name);
    void runVerifyTask(
      registry,
      task,
      async () => undefined, // already triggered above
      () => client.getDomain(args.serviceId, args.domainId),
      defaultHttpsCheck,
      args.timeoutSeconds ? { timeoutMs: args.timeoutSeconds * 1000 } : {}
    );

    return jsonContent({
      summary: `🔧 Verification kicked off for ${domain.name} with background polling. Task flips to 'completed' only when URL actually serves traffic with a valid cert (1-5 min).`,
      ...registry.toHandle(task),
      domain: { id: domain.id, name: domain.name, currentStatus: domain.verificationStatus },
      etaSeconds: { dnsCheck: "0-30", certIssuance: "60-300" },
    });
  } catch (err) {
    return errorContent(err);
  }
}

/**
 * One-shot readiness probe. Reads the current verificationStatus from
 * Render AND attempts an HTTPS handshake against the domain. Returns
 * `ready_to_serve: true` only when both: Render says verified AND the
 * URL responds over HTTPS (cert issued).
 *
 * Use this for the user-facing "is my domain ready yet?" question. No
 * background task, no agent-loop blocking — just a single check.
 */
export async function renderDomainsCheck(
  client: RenderClient,
  args: CheckArgs,
  httpsCheck: HttpsCheck = defaultHttpsCheck
): Promise<McpTextContent> {
  try {
    const domain = await client.getDomain(args.serviceId, args.domainId);
    const verified = domain.verificationStatus === "verified";
    const tlsReady = verified ? await httpsCheck(domain.name) : false;
    const readyToServe = verified && tlsReady;

    let summary: string;
    if (readyToServe) {
      summary = `✅ ${domain.name} is live: DNS verified AND HTTPS cert issued.`;
    } else if (verified && !tlsReady) {
      summary = `⏳ ${domain.name} verified by Render, but TLS cert is still issuing (typically 1-5 min after verification). Try again shortly.`;
    } else {
      summary = `⏳ ${domain.name} not yet verified by Render (current: ${domain.verificationStatus}). DNS may still be propagating.`;
    }

    return jsonContent({
      summary,
      domain: domain.name,
      verificationStatus: domain.verificationStatus,
      tlsHandshake: tlsReady ? "ok" : "failed-or-pending",
      readyToServe,
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
  const emoji = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : task.status === "timed_out" ? "⏱️" : "⏳";
  return jsonContent({
    summary: `${emoji} ${task.domainName}: ${task.status} (poll ${task.pollAttempts}) — ${task.statusMessage}`,
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
  const redeploy = args.redeploy !== false; // default true

  // Step 1: write env vars. If this fails, surface a clean error.
  try {
    await client.setEnvVars(args.serviceId, args.secrets);
  } catch (err) {
    return errorContent(err);
  }

  // Step 2: optionally trigger a deploy so the new values take effect.
  // Render's REST API does NOT auto-deploy on env var changes (unlike the
  // dashboard) — we explicitly trigger so the user's "set this secret"
  // intent actually becomes active.
  let deployId: string | undefined;
  if (redeploy) {
    try {
      deployId = await client.triggerDeploy(args.serviceId);
    } catch (err) {
      // Env vars ARE written but deploy didn't trigger. Surface BOTH facts so
      // the caller can manually trigger a deploy without re-setting secrets.
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: `Secrets saved, but deploy trigger failed: ${message}`,
                envVarsWritten: true,
                deployTriggered: false,
                keysSet: args.secrets.map((s) => s.key),
                hint: "Call this tool again with redeploy=true to retry, or trigger a deploy manually via Render's dashboard.",
              },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }

  const deployMsg = deployId
    ? ` Deploy ${deployId} triggered; new values active in ~30-60s.`
    : " redeploy=false: env vars saved but NOT yet active — call again with redeploy=true (or set another secret) to activate.";

  return jsonContent({
    summary: `🔐 Set ${args.secrets.length} secret env var${args.secrets.length === 1 ? "" : "s"} on ${args.serviceId}.${deployMsg}`,
    ok: true,
    serviceId: args.serviceId,
    keysSet: args.secrets.map((s) => s.key),
    deployId,
    note:
      "Values intentionally not echoed in this response (this is the point of the tool). " +
      (deployId
        ? "A deploy was triggered automatically — new env vars take effect in ~30-60s."
        : "redeploy was skipped; new env vars will activate on the next deploy."),
  });
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
