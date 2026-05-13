/**
 * MCP server factory — shared by stdio and HTTP transport entry points.
 *
 * Why a factory: `src/index.ts` uses StdioServerTransport (local Claude Code use),
 * `src/http.ts` uses StreamableHTTPServerTransport (Render-hosted use). Both share
 * the same tool registrations + state (RenderClient, TaskRegistry).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { RenderApiError, RenderClient } from "./render.js";
import { TaskRegistry, runVerifyTask } from "./tasks.js";

export interface ServerOptions {
  /** Render API token used by the server to call api.render.com on behalf of the user. */
  renderApiToken: string;
}

function jsonContent(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorContent(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const renderStatus = err instanceof RenderApiError ? err.status : undefined;
  const body = err instanceof RenderApiError ? err.body : undefined;
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ error: message, renderStatus, renderBody: body }, null, 2),
      },
    ],
    isError: true,
  };
}

async function resolveDoh(name: string, type: "A" | "CNAME"): Promise<string[]> {
  const res = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
    { headers: { Accept: "application/dns-json" } }
  );
  if (!res.ok) throw new Error(`DoH lookup failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as { Answer?: { name: string; type: number; TTL: number; data: string }[] };
  return (json.Answer ?? []).map((a) => a.data);
}

export function createMcpServer(opts: ServerOptions): McpServer {
  const render = new RenderClient(opts.renderApiToken);
  const tasks = new TaskRegistry();

  const server = new McpServer({
    name: "render-domains-mcp",
    version: "0.1.0",
  });

  // --------------------------------------------------------------------------
  // Synchronous domain CRUD tools
  // --------------------------------------------------------------------------

  server.registerTool(
    "render_domains_list",
    {
      title: "List custom domains",
      description: "List all custom domains attached to a Render service.",
      inputSchema: { serviceId: z.string().describe("Render service ID, e.g. srv-d81l8apo3t8c739e1nlg") },
    },
    async ({ serviceId }) => {
      try {
        const domains = await render.listDomains(serviceId);
        return jsonContent({ count: domains.length, domains });
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    "render_domains_get",
    {
      title: "Get custom domain",
      description: "Fetch details for a single custom domain on a Render service.",
      inputSchema: {
        serviceId: z.string().describe("Render service ID"),
        domainId: z.string().describe("Custom domain ID, e.g. cdm-..."),
      },
    },
    async ({ serviceId, domainId }) => {
      try {
        const domain = await render.getDomain(serviceId, domainId);
        return jsonContent(domain);
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    "render_domains_add",
    {
      title: "Add custom domain",
      description:
        "Attach a custom domain to a Render service. Returns the new domain in 'unverified' state — caller should then trigger render_domains_verify and update DNS at the registrar.",
      inputSchema: {
        serviceId: z.string().describe("Render service ID"),
        name: z.string().describe("Fully-qualified domain to attach, e.g. example.com or www.example.com"),
      },
    },
    async ({ serviceId, name }) => {
      try {
        const domain = await render.addDomain(serviceId, name);
        return jsonContent({
          domain,
          nextSteps: [
            domain.domainType === "apex"
              ? "Add an A record at @ pointing to 216.24.57.1 (Render's static site IP) or an ALIAS/ANAME to the Render-provided target"
              : `Add a CNAME at ${name.split(".")[0]} pointing to <your-service>.onrender.com`,
            `Then call render_domains_verify({ serviceId: "${serviceId}", domainId: "${domain.id}" })`,
          ],
        });
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    "render_domains_remove",
    {
      title: "Remove custom domain",
      description: "Detach a custom domain from a Render service. Destructive — agent should confirm with the user first.",
      inputSchema: {
        serviceId: z.string().describe("Render service ID"),
        domainId: z.string().describe("Custom domain ID to remove"),
      },
    },
    async ({ serviceId, domainId }) => {
      try {
        await render.removeDomain(serviceId, domainId);
        return jsonContent({ removed: true, domainId });
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  // --------------------------------------------------------------------------
  // Tasks-pattern verify tools (forward-compatible with MCP Tasks spec)
  // --------------------------------------------------------------------------

  server.registerTool(
    "render_domains_verify",
    {
      title: "Verify custom domain (async)",
      description:
        "Trigger Render's verification check and return a task handle. " +
        "Render verifies asynchronously (POST /verify returns 202), so this tool spawns a background poll that updates a task registry. " +
        "Caller should poll render_domains_verify_status({ taskId }) until status is terminal: completed | failed | timed_out.",
      inputSchema: {
        serviceId: z.string().describe("Render service ID"),
        domainId: z.string().describe("Custom domain ID to verify"),
        timeoutSeconds: z
          .number()
          .int()
          .min(10)
          .max(1800)
          .optional()
          .describe("Max seconds to wait for verification. Default 300 (5 min)."),
      },
    },
    async ({ serviceId, domainId, timeoutSeconds }) => {
      try {
        const domain = await render.getDomain(serviceId, domainId);
        const task = tasks.createVerifyTask(serviceId, domainId, domain.name);

        // Fire-and-forget the polling loop. Task state updates via registry.
        void runVerifyTask(
          tasks,
          task,
          () => render.triggerVerify(serviceId, domainId),
          () => render.getDomain(serviceId, domainId),
          timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}
        );

        return jsonContent({
          ...tasks.toHandle(task),
          domain: { id: domain.id, name: domain.name, currentStatus: domain.verificationStatus },
          note: "Background verification started. Poll render_domains_verify_status with the taskId to observe progress.",
        });
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  server.registerTool(
    "render_domains_verify_status",
    {
      title: "Get verification task status",
      description:
        "Poll the status of a verification task previously started via render_domains_verify. Returns current status, polling attempts, and the verified domain object once complete.",
      inputSchema: {
        taskId: z.string().describe("Task ID returned from render_domains_verify"),
      },
    },
    async ({ taskId }) => {
      const task = tasks.get(taskId);
      if (!task) {
        return errorContent(new Error(`No task with id ${taskId} (may have been evicted after TTL)`));
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
  );

  // --------------------------------------------------------------------------
  // DNS pre-flight check
  // --------------------------------------------------------------------------

  server.registerTool(
    "render_domains_dns_check",
    {
      title: "Check DNS resolution",
      description:
        "Resolve a domain via DNS-over-HTTPS (Cloudflare 1.1.1.1) and report whether it currently points at Render. " +
        "Useful for the agent to verify registrar-side DNS is in place BEFORE triggering Render's verification (saves a failed verify cycle).",
      inputSchema: {
        domain: z.string().describe("Domain to resolve, e.g. example.com or www.example.com"),
        expectedTarget: z
          .string()
          .optional()
          .describe("Expected target IP or hostname. Defaults to Render's static site A record 216.24.57.1."),
      },
    },
    async ({ domain, expectedTarget }) => {
      const target = expectedTarget ?? "216.24.57.1";
      try {
        const [a, cname] = await Promise.all([resolveDoh(domain, "A"), resolveDoh(domain, "CNAME")]);
        const pointsAtRender =
          a.some((rec) => rec === target) ||
          cname.some((rec) => rec.endsWith(".onrender.com.") || rec.endsWith(".onrender.com"));
        return jsonContent({
          domain,
          resolves: a.length > 0 || cname.length > 0,
          a,
          cname,
          expectedTarget: target,
          pointsAtRender,
          guidance: pointsAtRender
            ? "DNS points at Render — safe to call render_domains_verify."
            : "DNS does NOT currently point at Render. Update the registrar before calling render_domains_verify, otherwise Render's check will fail.",
        });
      } catch (err) {
        return errorContent(err);
      }
    }
  );

  return server;
}
