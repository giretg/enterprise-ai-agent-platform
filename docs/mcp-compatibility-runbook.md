# MCP compatibility runbook (Phase A)

Prove that **Codex and Claude Code authenticate to and use the same tenant-scoped MCP endpoint**. Do not use `mcp-remote`. Live Clerk OAuth is required; `AUTH_DISABLED` / DevAuth is not a passing path.

## Server

From `app/`:

```bash
cd app
npm run dev
```

Required env: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, and a public origin (`NEXT_PUBLIC_APP_URL` if not `http://localhost:3000`). Use a real/seeded tenant slug (example: `acme`).

`localhost:3000` is acceptable for this gate.

## Clerk dashboard (ops, not code)

OAuth applications → Settings → Client onboarding:

1. Prefer **Publish CIMD support** (beta; Clerk may need to enable the account).
2. Enable **Publish DCR support** only as fallback for a client that cannot CIMD. This is a security trade-off (unauthenticated registration endpoint).
3. Default scopes for dynamic clients: `openid profile email` (Claude/Codex often omit `scope`).
4. PKCE S256 required.
5. Consent screen stays on (Clerk enforces this when DCR is enabled).

This app does **not** implement DCR or mint tokens. Clerk does.

## curl discovery

Protected-resource metadata (same document at every path):

```bash
curl -sS http://localhost:3000/.well-known/oauth-protected-resource/api/mcp
```

Expect HTTP 200 with `resource` = `{origin}/api/mcp` and `authorization_servers` listing the Clerk issuer.

Unauthenticated MCP POST:

```bash
curl -sS -D - -o /dev/null \
  -X POST http://localhost:3000/api/mcp/acme \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"ping"}'
```

Expect **401** and `WWW-Authenticate` containing `resource_metadata` pointing at `/.well-known/oauth-protected-resource/api/mcp`.

## Codex

Add the Streamable HTTP URL `http://localhost:3000/api/mcp/{slug}` (current Codex CLI). Complete Clerk consent. `tools/list` must show `platform.whoami`. Invoke it and paste the JSON — `tenantSlug` matches the URL.

Record `codex --version`.

## Claude Code

```bash
claude mcp add --transport http <name> http://localhost:3000/api/mcp/{slug}
```

Then `/mcp`, complete consent, same `platform.whoami`. Record `claude --version`.

## Negative cases

| Case | Expect |
|---|---|
| Member of tenant A calling `/api/mcp/{B}` without membership and without superadmin | 403 `{ error: { code: "not_a_member" } }` |
| Valid token, unknown slug | 403 `{ error: { code: "tenant_unavailable" } }` |
| Superadmin on an active tenant with no membership | `whoami.assumed === true` and `role === "admin"` |
| Inactive tenant (including superadmin) | 403 `{ error: { code: "tenant_not_active" } }` |
| Unknown tool name | HTTP 200 MCP result `isError: true` with `{ code: "tool_not_allowed" }` |

Record Clerk instance type (dev/prod) with the CLI versions.

## Audit choice (unauthenticated 401s)

Unauthenticated 401s are **not** written to `audit_log` (they would flood). They are logged at info. `invalid_token` and membership/assume/inactive denies **are** audited (`mcp.auth.deny`). Successful principal resolution writes `mcp.auth.ok` with `{ tenantSlug, assumed }` — not `tenant.assume` on every assumed MCP request.

## Import notes

Clerk’s Next example may still show `mcp-adapter` / `experimental_withMcpAuth`. This app uses the maintained names: `mcp-handler@2.1.1` `createMcpHandler` + `withMcpAuth`. `@clerk/mcp-tools@0.6.0` still depends on `@modelcontextprotocol/sdk@1.30.0` (security floor ≥ 1.26.0) for `verifyClerkToken`; the transport uses `@modelcontextprotocol/server@2.0.0`.
