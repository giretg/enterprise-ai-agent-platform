# MCP compatibility runbook (Phase A + Phase C Drive + Phase E write + Phase F audit)

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

## Phase C — Google Drive read

Same URL as Phase A: `/api/mcp/{tenantSlug}`. No dispatcher, queue, or internal agent runtime.

### Local stub (no live Google)

Set `GOOGLE_DRIVE_API_STUB=true`. Seed keeps a placeholder grant whose `tokenRef` starts with `stub-`. `resolveAccessToken` returns that stub token; `GoogleDriveApiClient` serves in-memory files.

| Step | Action | Expect |
|---|---|---|
| 1 | OAuth connect; `platform.whoami` | `tenantSlug` matches the URL |
| 2 | `platform.agents.list` | Contains **Drive assistant** |
| 3 | `platform.agent.get_definition` | Snapshot lists `google_drive_search` + `google_drive_read_file` (+ `google_drive_create_folder`) and a `google_drive` connector with `accessMode: write` (write also satisfies read) |
| 4 | `google_drive_search` `{ definitionId, nameContains: "Platform" }` | `files[]` non-empty (stub document) |
| 5 | `google_drive_read_file` `{ definitionId, fileId }` from step 4 | `text` or `warnings`; payload has **no** access token / `tokenRef` |
| 6 | Negative: definition without the capability, or operator with only `view` | HTTP 200, MCP `isError: true`, `code` ∈ `{ capability_not_allowed, agent_access_denied, … }` |

`definitionId` is required (published `AgentDefinitionVersion.id`). Extra JSON keys such as `tenantId` / `userId` are ignored.

### Live Google OAuth (harness)

1. Seed with `SEED_CLERK_USER_ID` = the Clerk user id of the human running Codex / Claude Code.
2. In Control Plane, complete Google Drive OAuth for that same user on the tenant Drive connector (`drive.readonly` or broader). This replaces the seed placeholder grant.
3. Repeat steps 1–6 above against a real Drive file the account can see.
4. Record `codex --version`, `claude --version`, and Clerk instance type (dev/prod) in the PR.

Policy is the **published snapshot**. If an admin later decommissions the connector, calls against an old `definitionId` fail with `connector_not_active` even if the snapshot still lists it.

## Audit choice (unauthenticated 401s)

Unauthenticated 401s are **not** written to `audit_log` (they would flood). They are logged at info. `invalid_token` and membership/assume/inactive denies **are** audited (`mcp.auth.deny`). Successful principal resolution writes `mcp.auth.ok` with `{ tenantSlug, assumed }` — not `tenant.assume` on every assumed MCP request.

Drive tool invokes append `enterprise.tool.ok`, `enterprise.tool.denied`, and `enterprise.tool.error` (and may still `console.info` as an ops breadcrumb). Gateway writes append `gateway.operation.enqueued` / `approved` / `rejected` / `executing` / `succeeded` / `failed`. Evidence is the `audit_log` table — append-only, hash-chain v2 — browsed at Control Plane `/control-plane/audit`.

## Phase E — Controlled write + approval

Same URL as Phase A/C: `/api/mcp/{tenantSlug}`. No dispatcher, queue, or internal agent runtime. Folder creation **does not call Google** until a human approves in Control Plane.

### Local stub (no live Google)

Set `GOOGLE_DRIVE_API_STUB=true`. Seed uses a `write` connector binding and `selected_write` scopes (`drive.readonly` + `drive.file`). A `write` binding still satisfies read tools.

Complete Phase C steps 1–6 first, then:

| Step | Action | Expect |
|---|---|---|
| 7 | `google_drive_create_folder` `{ definitionId, name, idempotencyKey }` | `{ operationId, status: "awaiting_approval" }`; **no folder yet** |
| 8 | `platform.gateway_operation.get` `{ operationId }` | `status: "awaiting_approval"`, `approval.decision: "pending"` |
| 9 | Control Plane → **Jóváhagyások**: approve (same user OK if admin/approver) | operation → `succeeded`; `result.file.id` present |
| 10 | Repeat step 7 with **same** `idempotencyKey` | same `operationId`, `status: "succeeded"`; **no second folder** |
| 11 | Repeat step 7 with **new** key; reject in Control Plane | `status: "rejected"`; no Drive side effect |
| 12 | Negative: operator without `operate` grant | MCP `isError: true`, `agent_access_denied` |
| 13 | Negative: non-privileged user tries to approve | Control Plane error `approver_not_authorized` |

`awaiting_approval` is a successful enqueue (`isError` omitted/false), not a policy deny.

### Live Google OAuth (harness)

1. Complete Phase C live OAuth so the same Clerk user has a Drive grant with write-capable scopes (`drive.file` or full Drive).
2. Repeat steps 7–13. After approval, the folder exists in the Google account; a retry with the same `idempotencyKey` must not create a second folder.
3. Record `codex --version`, `claude --version`, and Clerk instance type (dev/prod) in the PR.

## Phase F — Core MVP acceptance (stub is the gate)

Same URL as Phase A/C/E: `/api/mcp/{tenantSlug}`. No dispatcher, queue, or in-app chat. Set `GOOGLE_DRIVE_API_STUB=true`. After `prisma migrate reset` + seed the Drive assistant is **active**, published, write-bound (`accessMode: write`, `selected_write` scopes). Live Google OAuth is optional, not a closer.

Complete Phase C steps 1–6 and Phase E steps 7–13 first, then prove the audit trail:

| Step | Action | Expect |
|---|---|---|
| 1 | OAuth connect; `platform.whoami` | `tenantSlug` matches URL; `audit_log` has `mcp.auth.ok` |
| 2 | `platform.agents.list` | Contains **Drive assistant**, `status: active`, `currentDefinitionId` set |
| 3 | `platform.agent.get_definition` | Snapshot lists search + read_file + create_folder and a `google_drive` connector with `accessMode: write` |
| 4 | `google_drive_search` `{ definitionId, nameContains: "Platform" }` | `files[]`; `enterprise.tool.ok` |
| 5 | `google_drive_read_file` `{ definitionId, fileId }` | text/warnings; **no** token in payload; `enterprise.tool.ok` |
| 6 | `google_drive_create_folder` `{ definitionId, name, idempotencyKey }` | `{ operationId, status: "awaiting_approval" }`; **no** folder yet; `gateway.operation.enqueued` |
| 7 | Control Plane `/operations`: approve (same admin user OK) | operation `succeeded`; stub file id in result; `gateway.operation.approved` + `executing` + `succeeded` |
| 8 | Repeat step 6 with **same** `idempotencyKey` | same `operationId`, already `succeeded`; **no** second folder; **no** second enqueue event |
| 9 | New key; reject in Control Plane | `rejected`; no Drive side effect; `gateway.operation.rejected` |
| 10 | Control Plane `/audit` | Steps 1–9 visible, tenant-scoped, no tokens in metadata |
| 11 | **Lánc ellenőrzése** | `verifyChain` ok for this tenant |
| 12 | Negative: wrong tenant / non-member | HTTP 403; `mcp.auth.deny` (not for missing Bearer 401) |
| 13 | Negative: operator with only `view` | MCP `isError`, `agent_access_denied`, `enterprise.tool.denied` |

JSONL download on `/audit` is tenant-scoped (same rows as the table). Unauthenticated 401s must **not** appear.

Record `codex --version`, `claude --version`, and Clerk instance type (dev/prod) on the PR.

## Import notes

Clerk’s Next example may still show `mcp-adapter` / `experimental_withMcpAuth`. This app uses the maintained names: `mcp-handler@2.1.1` `createMcpHandler` + `withMcpAuth`. `@clerk/mcp-tools@0.6.0` still depends on `@modelcontextprotocol/sdk@1.30.0` (security floor ≥ 1.26.0) for `verifyClerkToken`; the transport uses `@modelcontextprotocol/server@2.0.0`.
