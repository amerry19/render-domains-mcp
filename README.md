# render-domains-mcp

**An MCP server that lets an AI agent set up a custom domain end-to-end — attach, configure DNS, verify — without sending the user to a dashboard.**

Render's official MCP (`mcp.render.com`) has a strong read surface but no custom domain management. So an agent helping you deploy a site hits a wall: it stops and tells you to go click buttons. `render-domains-mcp` fills that gap, and adds a GoDaddy adapter so the registrar side is covered too.

Live, hosted on Render itself: `https://render-domains-mcp.onrender.com/mcp`

## The closed loop

With both adapters active, one instruction → live site on a custom domain. No dashboard, no registrar hop:

```
render_domains_add(serviceId, "app.example.com")
godaddy_dns_set_cname("example.com", "app", "myservice.onrender.com")
render_domains_dns_check("app.example.com")     # DNS propagated yet?
render_domains_verify(serviceId, domainId)      # trigger Render's verify
render_domains_check(serviceId, domainId)       # one-shot: verified + TLS live?
```

## Tools

Adapter pattern: Render tools always load; GoDaddy tools load only when `GODADDY_API_KEY` / `GODADDY_API_SECRET` are set.

**Render domains**

| Tool | Does |
|---|---|
| `render_domains_list` / `_get` | List / fetch custom domains |
| `render_domains_add` / `_remove` | Attach / detach a domain |
| `render_domains_verify` | Trigger Render's async verification, return a task handle |
| `render_domains_verify_status` | Poll a verification task |
| `render_domains_dns_check` | DNS-over-HTTPS pre-flight — does the registrar point at Render yet? |
| `render_domains_check` | One-shot: is the domain verified *and* serving TLS? |

**GoDaddy** (optional)

| Tool | Does |
|---|---|
| `godaddy_dns_list` | List DNS records |
| `godaddy_dns_set_cname` | Upsert a CNAME — the registrar-side move |
| `godaddy_dns_delete` | Delete records |

**Secrets & setup**

| Tool | Does |
|---|---|
| `render_pass_request` | Generate a one-time URL for the user to submit a secret — value never enters chat |
| `render_secrets_set` | Write service env vars without echoing values |
| `render_setup_guide` / `godaddy_setup_guide` | Walk the user through getting API credentials |

## Use locally (Claude Code, stdio)

```json
{
  "mcpServers": {
    "render-domains": {
      "command": "npx",
      "args": ["tsx", "/path/to/render-domains-mcp/src/index.ts"],
      "env": { "RENDER_API_TOKEN": "rnd_..." }
    }
  }
}
```

Get a token at `dashboard.render.com/u/settings#api-keys`, then `/mcp` to connect.

## Use hosted (Render Blueprint)

The repo ships a `render.yaml`. In the Render dashboard: New → Blueprint → connect the repo. Render auto-generates `MCP_API_TOKEN`; you set `RENDER_API_TOKEN` once after deploy.

```json
{
  "mcpServers": {
    "render-domains": {
      "transport": "http",
      "url": "https://render-domains-mcp.onrender.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_API_TOKEN>" }
    }
  }
}
```

Two tokens: `MCP_API_TOKEN` is the bearer your client presents; `RENDER_API_TOKEN` is what the server uses to call `api.render.com`. Leave `MCP_API_TOKEN` unset → auth disabled (local dev only).

## How verification works

Render's `POST /verify` is async — returns `202`, then silently fails if DNS isn't ready. So:

- `render_domains_dns_check` is a pre-flight — confirm DNS resolves to Render *before* triggering verify, saving a wasted cycle.
- `render_domains_verify` triggers the check and returns a task handle; a background poller backs off (3s → 6s → … capped 30s) until terminal state.
- `render_domains_check` is the one-shot companion: probes "verified *and* TLS live" — cert issuance is a separate 1–5 min step Render's verify doesn't wait for.

The verify task shape maps 1:1 to the experimental `registerToolTask` API in `@modelcontextprotocol/sdk` v2 — when that stabilizes, the two verify tools collapse into one call with no client-facing change.

## Develop

```bash
npm install
npm test     # 113 tests across 9 files
npm start            # stdio transport
npm run start:http   # Streamable HTTP transport
```

## License

MIT
