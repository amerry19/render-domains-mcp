/**
 * MCP server factory — shared by stdio and HTTP transport entry points.
 *
 * The factory wires zod schemas + tool registrations to the pure handler
 * functions in *-tools.ts modules. Provider adapters (Render, GoDaddy)
 * register their own tool sets — GoDaddy is optional and registered only
 * when credentials are passed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { RenderClient } from "./render.js";
import { TaskRegistry } from "./tasks.js";
import { GoDaddyClient } from "./godaddy.js";
import {
  renderDomainsAdd,
  renderDomainsGet,
  renderDomainsList,
  renderDomainsRemove,
  renderDomainsVerify,
  renderDomainsVerifyStatus,
  renderSecretsSet,
  renderSetupGuide,
} from "./render-tools.js";
import { renderDomainsDnsCheck } from "./dns.js";
import {
  godaddyDnsDelete,
  godaddyDnsList,
  godaddyDnsSetCname,
  godaddySetupGuide,
} from "./godaddy-tools.js";

export interface ServerOptions {
  /** Render API token used by the server to call api.render.com on behalf of the user. */
  renderApiToken: string;
  /**
   * Optional GoDaddy credentials. When provided, the server also registers
   * registrar-side tools (DNS record CRUD) so the agent can close the full
   * "add custom domain → set DNS → verify" loop in one flow.
   */
  goDaddy?: {
    key: string;
    secret: string;
  };
  /**
   * Optional shared TaskRegistry. Required when running in stateless HTTP mode,
   * where multiple request handlers need to see each other's task state.
   * If omitted, a per-server registry is created (fine for stdio mode).
   *
   * Production note: swap this for a Render KV-backed implementation so task
   * state survives instance restarts and scales horizontally.
   */
  taskRegistry?: TaskRegistry;
}

export function createMcpServer(opts: ServerOptions): McpServer {
  const render = new RenderClient(opts.renderApiToken);
  const tasks = opts.taskRegistry ?? new TaskRegistry();

  const server = new McpServer({
    name: "render-domains-mcp",
    version: "0.1.0",
  });

  // Setup guides are always registered (even without GoDaddy creds) so the
  // agent can guide a brand-new user through credential setup without a
  // dashboard handoff.
  registerSetupGuides(server);
  registerRenderTools(server, render, tasks);

  if (opts.goDaddy) {
    const godaddy = new GoDaddyClient(opts.goDaddy.key, opts.goDaddy.secret);
    registerGoDaddyTools(server, godaddy);
  }

  return server;
}

// ----------------------------------------------------------------------------
// Setup guides — unconditionally registered, no credentials required
// ----------------------------------------------------------------------------

function registerSetupGuides(server: McpServer): void {
  server.registerTool(
    "render_setup_guide",
    {
      title: "Render setup guide",
      description:
        "Returns markdown explaining how to generate a Render API token and find a service ID. " +
        "Call this when a user is configuring this MCP for the first time, or when they ask 'how do I get a Render API key'.",
      inputSchema: {},
    },
    () => renderSetupGuide()
  );

  server.registerTool(
    "godaddy_setup_guide",
    {
      title: "GoDaddy setup guide",
      description:
        "Returns markdown walking a user through generating a GoDaddy Production API key + secret, and instructions for wiring the credentials into this MCP server's env vars via the official Render MCP's `update_environment_variables` tool. " +
        "Call this when the user wants to enable the GoDaddy adapter and the relevant env vars are not yet set.",
      inputSchema: {},
    },
    () => godaddySetupGuide()
  );
}

// ----------------------------------------------------------------------------
// Render adapter — 7 tools
// ----------------------------------------------------------------------------

function registerRenderTools(server: McpServer, render: RenderClient, tasks: TaskRegistry): void {
  server.registerTool(
    "render_domains_list",
    {
      title: "List custom domains",
      description: "List all custom domains attached to a Render service.",
      inputSchema: {
        serviceId: z.string().describe("Render service ID, e.g. srv-d81l8apo3t8c739e1nlg"),
      },
    },
    ({ serviceId }) => renderDomainsList(render, { serviceId })
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
    ({ serviceId, domainId }) => renderDomainsGet(render, { serviceId, domainId })
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
    ({ serviceId, name }) => renderDomainsAdd(render, { serviceId, name })
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
    ({ serviceId, domainId }) => renderDomainsRemove(render, { serviceId, domainId })
  );

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
    ({ serviceId, domainId, timeoutSeconds }) =>
      renderDomainsVerify(render, tasks, { serviceId, domainId, timeoutSeconds })
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
    ({ taskId }) => renderDomainsVerifyStatus(tasks, { taskId })
  );

  server.registerTool(
    "render_secrets_set",
    {
      title: "Set service env vars (secrets) without value echo",
      description:
        "Set or update environment variables on a Render service WITHOUT echoing the values back in the response. " +
        "Use this — not the official Render MCP's update_environment_variables — when wiring sensitive values (API keys, tokens, secrets) into a service. " +
        "Existing env vars are preserved (merge semantics). The response contains only key names, never values. " +
        "Render will auto-redeploy the service ~30-60s after this call.",
      inputSchema: {
        serviceId: z.string().describe("Render service ID, e.g. srv-..."),
        secrets: z
          .array(
            z.object({
              key: z.string().describe("Env var name, e.g. GODADDY_API_KEY"),
              value: z
                .string()
                .describe(
                  "Sensitive — will be sent to Render's API but NOT echoed back in this tool's response."
                ),
            })
          )
          .min(1)
          .describe("One or more secret key/value pairs to upsert"),
      },
    },
    ({ serviceId, secrets }) => renderSecretsSet(render, { serviceId, secrets })
  );

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
    ({ domain, expectedTarget }) => renderDomainsDnsCheck({ domain, expectedTarget })
  );
}

// ----------------------------------------------------------------------------
// GoDaddy adapter — 3 tools (optional, registered only when creds provided)
// ----------------------------------------------------------------------------

function registerGoDaddyTools(server: McpServer, godaddy: GoDaddyClient): void {
  server.registerTool(
    "godaddy_dns_list",
    {
      title: "List DNS records (GoDaddy)",
      description:
        "List DNS records for a GoDaddy-managed domain. Optionally filter by type and/or name. " +
        "Use this to inspect current DNS before/after changes.",
      inputSchema: {
        domain: z.string().describe("Apex domain managed by GoDaddy, e.g. example.com"),
        type: z
          .string()
          .optional()
          .describe("Filter by record type (A, CNAME, TXT, etc.)"),
        name: z
          .string()
          .optional()
          .describe("Filter by record name (e.g. 'www' or '@' for the apex)"),
      },
    },
    ({ domain, type, name }) => godaddyDnsList(godaddy, { domain, type, name })
  );

  server.registerTool(
    "godaddy_dns_set_cname",
    {
      title: "Set CNAME record (GoDaddy)",
      description:
        "Upsert a CNAME record at the given subdomain pointing to a target hostname. " +
        "GoDaddy PUTs replace all records of that type+name, so this is the safe 'set, replacing prior values' operation. " +
        "Typical use: after render_domains_add, call this to point the registrar DNS at <service>.onrender.com, then call render_domains_verify.",
      inputSchema: {
        domain: z.string().describe("Apex domain managed by GoDaddy, e.g. example.com"),
        name: z.string().describe("Subdomain to set the CNAME at, e.g. 'www' or 'test-mcp'"),
        target: z.string().describe("Target hostname the CNAME should point to, e.g. 'myapp.onrender.com'"),
        ttl: z
          .number()
          .int()
          .min(600)
          .optional()
          .describe("TTL in seconds. Defaults to 3600. GoDaddy enforces a 600-second minimum."),
      },
    },
    ({ domain, name, target, ttl }) =>
      godaddyDnsSetCname(godaddy, { domain, name, target, ttl })
  );

  server.registerTool(
    "godaddy_dns_delete",
    {
      title: "Delete DNS records (GoDaddy)",
      description:
        "Delete all DNS records of the given type+name. Destructive — agent should confirm with the user first.",
      inputSchema: {
        domain: z.string().describe("Apex domain managed by GoDaddy"),
        type: z.string().describe("Record type to delete (A, CNAME, etc.)"),
        name: z.string().describe("Record name to delete (e.g. 'test-mcp')"),
      },
    },
    ({ domain, type, name }) => godaddyDnsDelete(godaddy, { domain, type, name })
  );
}
