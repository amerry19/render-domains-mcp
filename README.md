# render-domains-mcp

> An MCP server for Render custom domain management — closing the agent-loop gap that the official Render MCP leaves open.
>
> **Deployable on Render itself**, eating the platform's own dog food. See [Hosting on Render](#hosting-on-render).

Render's official MCP server (`mcp.render.com/mcp`) exposes a strong read surface — services, deploys, logs, metrics, even direct Postgres SQL. But it stops short of custom domain management, so an AI agent helping a user deploy a site has to break the loop and send the user to the dashboard mid-flow. This POC fills that gap.

It also demonstrates the **MCP Tasks pattern** for async operations like DNS verification, with a forward-compatible shape that maps 1:1 to the experimental `server.experimental.tasks.registerToolTask` API in `@modelcontextprotocol/sdk` v2.0.0-alpha (April 2026).

## Two transports, one server

- **stdio** (`npm start`) — for local Claude Code / Cursor / Codex use
- **Streamable HTTP** (`npm run start:http`) — for hosted deployment, modeled after [Render's own Python MCP template](https://render.com/templates/mcp-server-python)

Both share the same tool registrations via the factory in `src/server.ts`.

## Why this exists

The recommendation this POC embodies:

> Render's MCP is well-positioned on the read side and on data primitives. The most visible gap is **agent-owned end-to-end flows** — custom domains, deploy actions, PR previews. Of those, custom domains is the cleanest to ship first because the REST API already exposes everything needed; only the MCP wrapper is missing.

The full landscape analysis is in [Background](#background).

## Tools

| Tool | Description |
|---|---|
| `render_domains_list` | List all custom domains on a service |
| `render_domains_get` | Fetch one custom domain |
| `render_domains_add` | Attach a new domain. Returns it in `unverified` state with next-step DNS guidance |
| `render_domains_remove` | Detach a domain (destructive — agent should confirm) |
| `render_domains_verify` | **Tasks-pattern.** Triggers Render's async verification and returns a task handle. Background-polls until terminal state |
| `render_domains_verify_status` | Poll a verification task by id. Returns current status, poll attempts, and the verified domain object once complete |
| `render_domains_dns_check` | Resolve via DNS-over-HTTPS and report whether the registrar-side DNS points at Render. Pre-flight check that saves a failed verify cycle |

## Setup

```bash
git clone https://github.com/amerry19/render-domains-mcp
cd render-domains-mcp
npm install
cp .env.example .env
# add your Render API token to .env
```

Get a Render API token at <https://dashboard.render.com/u/settings#api-keys>.

### Use with Claude Code

Add to `~/.claude.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "render-domains": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/render-domains-mcp/src/index.ts"],
      "env": {
        "RENDER_API_TOKEN": "rnd_..."
      }
    }
  }
}
```

Then `/mcp` to connect.

### Smoke test (stdio)

```bash
RENDER_API_TOKEN=rnd_... npm start
```

Or pipe JSON-RPC directly:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | RENDER_API_TOKEN=rnd_... npm start
```

## Hosting on Render

This server can be deployed on Render itself via the included [`render.yaml`](./render.yaml) Blueprint.

### Auth model (matches Render's own MCP template)

| Token | Set by | Used for |
|---|---|---|
| `MCP_API_TOKEN` | Render auto-generates on deploy (`generateValue: true`) | Bearer token the client (Claude Code, etc.) must present to access this MCP |
| `RENDER_API_TOKEN` | You — set in Render dashboard once after Blueprint deploy | The token the server uses to call api.render.com on the user's behalf |

When `MCP_API_TOKEN` is **unset** (e.g. running locally with `npm run start:http`), auth is **disabled** — useful for local dev only.

### Deploy

1. Push this repo to GitHub
2. In Render dashboard: New → **Blueprint** → connect repo. Render reads `render.yaml`, auto-generates `MCP_API_TOKEN`.
3. After deploy, set `RENDER_API_TOKEN` in the service's Environment tab.
4. Grab `MCP_API_TOKEN` value from the Environment tab (Render shows it once-only).
5. Configure your MCP client (Claude Code, Cursor, etc.):
   ```json
   {
     "mcpServers": {
       "render-domains": {
         "transport": "http",
         "url": "https://render-domains-mcp.onrender.com/mcp",
         "headers": {
           "Authorization": "Bearer <MCP_API_TOKEN>"
         }
       }
     }
   }
   ```

### Run HTTP mode locally

```bash
RENDER_API_TOKEN=rnd_... MCP_API_TOKEN=dev-secret PORT=10001 npm run start:http
# server listens on http://localhost:10001/mcp
# health probe: http://localhost:10001/health
```

## End-to-end flow (what an agent does)

```
User: "Deploy adammerry.com on Render and make it live."

agent → render_domains_dns_check({ domain: "adammerry.com" })
        → "DNS does NOT currently point at Render."

agent → render_domains_add({ serviceId, name: "adammerry.com" })
        → { id, verificationStatus: "unverified", nextSteps: [...] }

agent → render_domains_dns_check({ domain: "adammerry.com" })
        → loops until user has updated their registrar

agent → render_domains_verify({ serviceId, domainId, timeoutSeconds: 300 })
        → { taskId, status: "running", pollWith: "..." }

agent → render_domains_verify_status({ taskId })  ← poll
        → status: "running", pollAttempts: 2, ...
... (poll a few more times) ...
        → status: "completed", result: { verificationStatus: "verified", ... }

agent → "adammerry.com is live on Render. ✅"
```

The whole flow happens inside the agent loop, no dashboard handoff.

## Design notes

### Why v1.29 stable + Tasks-pattern instead of v2-alpha native Tasks

The `@modelcontextprotocol/sdk` v2.0.0-alpha (published 2026-04-01) introduces native `TaskManager` and `server.experimental.tasks.registerToolTask`. I evaluated using it directly. Tradeoffs:

| | v1.29 stable + Tasks-pattern (this repo) | v2.0.0-alpha + native Tasks |
|---|---|---|
| Stability | Production-grade | Alpha, flagged experimental |
| Transport | stdio (works directly in Claude Code) | HTTP/SSE per the reference example |
| Demo reliability | Predictable | Possible surprises |
| Migration cost when v2 stabilizes | Minimal — replace two tools with one `registerToolTask` call. Same semantic contract | N/A |

The Tasks-pattern in this repo (`verify` returns handle, `verify_status` polls) is **semantically identical** to the experimental Tasks API. When v2 stabilizes — or when v1.29's own `/experimental/tasks` export becomes stable — the verify tools collapse into one `registerToolTask` call with no client-facing change.

### Tasks-pattern contract

A verification task moves through states:

```
pending → running → ( completed | failed | timed_out )
```

The background poller uses exponential backoff (3s → 6s → … capped at 30s) so a long-running verify doesn't hammer the Render API.

Task state lives in-memory and is evicted after 1h. For production use you'd swap `TaskRegistry` for a durable store (Postgres, Redis, etc.) — same interface, different backend. That's the natural migration path to MCP Tasks' `TaskStore` interface.

### DNS pre-flight (`render_domains_dns_check`)

Render's `POST /verify` is async (202) and silently fails if DNS isn't ready. Agents naively calling `verify` immediately after `add` waste a verification cycle. The DNS check tool lets the agent confirm registrar-side DNS resolves to Render **before** triggering verify, which saves a 30-60s round trip on every deploy.

Uses Cloudflare's DNS-over-HTTPS (`1.1.1.1`) to dodge ISP DNS caches.

## Background

Competitive analysis of agentic API design across:

- **Vercel** — read-heavy, deploys via local CLI handoff, includes `buy_domain` but not custom domain attach
- **Cloudflare** — most ambitious, full DNS/Workers/R2/cert CRUD with "Code Mode" (search+execute) architecture
- **Supabase** — full SQL + migrations, `read_only=true` enforced at Postgres role level
- **Netlify** — "prompt to production," explicit domain settings tool
- **Fly.io** — `flymcp` wraps `flyctl`, full provisioning
- **GitHub** — canonical MCP, read-only mode + Lockdown mode + toolset toggling
- **AWS Labs** — consolidated server pattern (15k API endpoints behind a small fixed tool set)
- **Railway** — destructive ops intentionally excluded; OAuth via browser

Render currently sits in an unusual spot: **strong on read + DB primitives, conservative on mutation**. The mutation gap (custom domains, deploys, rollbacks) is the most visible drag on agent-owned flows. Closing custom domains specifically is the lowest-hanging fruit because:

1. Render's REST API already exposes everything (verified empirically — see `src/render.ts`)
2. The async-verification objection is solved by MCP Tasks (or this pattern)
3. It's the most frequent post-deploy task an agent encounters

## What I'd add next

- **`render_domains_dns_targets`** — return Render's recommended DNS records (A target for apex, CNAME for www) for a given service so the agent can give the user copy-paste DNS instructions
- **Migration to v1.29's `/experimental/tasks`** once stable
- **Scoped-token support** — read-only mode flag à la GitHub's MCP; could be just `RENDER_MCP_READONLY=true` that gates which tools register
- **Cert status surfacing** — Render auto-issues Let's Encrypt after verification but doesn't expose cert details via the API yet; if/when it does, surface here
- **PR preview tools** — `render_previews_list` / `render_previews_url` (the spiritual successor to this POC for the same gap)

## License

MIT
