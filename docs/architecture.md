# Architecture note — Core MVP (Phase 0–F)

This repository is an **Enterprise MCP control plane**. Codex and Claude Code
authenticate to the same tenant-scoped Streamable HTTP resource at
`/api/mcp/{tenantSlug}`. Control Plane is the admin surface: definitions,
connectors, IAM, skills, write approvals, and the hash-chained audit log.

Clerk is the OAuth authorization server; this app is only a resource server.
The canonical OAuth resource identifier (token audience, if any) is
`{origin}/api/mcp` — no tenant slug. Tenant isolation is the URL slug plus
membership or superadmin assume. See `docs/mcp-compatibility-runbook.md`.

**Core MVP is live:**

| Phase | What |
|---|---|
| 0 | Clean compilation boundary. `legacy/` is REFERENCE ONLY (retained on purpose). |
| A | Codex + Claude Code on `/api/mcp/{tenantSlug}` |
| B | Greenfield Prisma (`0001_init`). Publish creates an append-only `AgentDefinitionVersion`. |
| C | Drive **read** MCP tools (`google_drive_search`, `google_drive_read_file`) |
| E | Drive **write** enqueue + Control Plane approval (`google_drive_create_folder`) |
| F | Agent rail gone. Professional `audit_log` restored (append-only, hash-chain v2). Seed publishes **and activates** the Drive assistant with a **write** binding. |

There is no in-app chat, dispatcher, or agent runtime. The operator works in
Codex / Claude Code. Control Plane chrome is header nav + page body.

`console.info` may remain as an ops breadcrumb. **Acceptance evidence is
`audit_log` + `/control-plane/audit`**, not stdout.

Dual-harness gate: `GOOGLE_DRIVE_API_STUB=true` + seed placeholder grant.
Live Google OAuth is optional in the runbook, not a closer.

## Entry points

| Path | Role |
|---|---|
| `app/src/domain/gateway-services.ts` | Target composition root (IAM, tenant, agent definitions, connector/grant, skill, provisioning, **audit**) |
| `app/src/auth/mcp-principal.ts` | MCP principal (Phase A) |
| `app/src/app/api/mcp/[tenantSlug]/route.ts` | Tenant-scoped MCP resource URL |
| `app/src/domain/agent-definition/` | Immutable Agent Definition (Phase B) |
| `app/src/domain/enterprise-tools/` | `authorizeToolCall` + Drive read/write gateway |
| `app/src/domain/gateway-operation/` | GatewayOperation enqueue / approve / execute (Phase E) |
| `app/src/domain/audit/` | `verifyChain` + tenant-scoped JSONL export (Phase F) |
| `app/src/app/control-plane/audit/` | Browse + chain panel |
| `app/src/app/control-plane/operations/` | Approve / reject writes |

Control Plane login remains Clerk (`app/src/auth/*`). Tenant membership is
`auth/tenant-context.ts` plus `domain/iam` and `domain/tenant`.

## `legacy/` rule

DELETE / REFERENCE ONLY / DEFER trees were `git mv`'d to `legacy/` at the repo
root, **outside** `app/`. They are readable history and a reference for later
EXTRACT work (Gmail, sandbox, scheduling). They are **not** part of the active
TypeScript project and must not be imported from `app/src`.

**Phase F kept `legacy/` on purpose.** Do not treat the retained tree as a
defect. A dedicated deletion issue comes only when it is clearly unused.

Do not use `tsconfig.exclude` for those trees: exclude only drops root files,
not transitives. Moving them makes leftover imports fail, which is the
rewiring todo list.

## Import boundary

CI fails if the target layers import the old `@/domain` services barrel
(exact `@/domain` / `@/domain/index`, not KEEP subpaths such as
`@/domain/iam/...`), the legacy runtime graph (`AgentChatRuntime`,
`ModelGateway`, dispatcher, conversation, harness), or `legacy/`. See
`app/src/domain/import-boundary-guard.ts` and the `no-restricted-imports`
ESLint rule. `domain/audit` is a target module.

## Isolation decisions

- The platform does not call a model for agent execution and does not store
  Conversation / AgentTurn state for MCP.
- There is no server-side selected-tenant / selected-agent session. Tenant is
  `/api/mcp/{tenantSlug}` plus membership or superadmin assume.
- `tools/list` is not a security boundary. `tools/call` uses an allow-list
  (`platform.whoami`, `platform.agents.list`, `platform.agent.get_definition`,
  `platform.agent.checkout`, `platform.gateway_operation.get`, `google_drive_search`,
  `google_drive_read_file`, `google_drive_create_folder`); every Drive
  `tools/call` still runs `authorizeToolCall`. Writes enqueue instead of
  calling Google until a human approves.
- Active tenant skills are MCP resources under `skill://{name}/…` (`skills/list`,
  `skills/get`, `resources/read`). Scripts belong in the skill package and run
  on the client. The platform does not execute skill code.
- Credentials never leave the server.
- Unauthenticated MCP 401s are **not** written to `audit_log` (flood).
  `invalid_token` and membership/assume/inactive denies **are** audited
  (`mcp.auth.deny`).
- Control Plane list / `verifyChain` / JSONL export always filter
  `tenantId = active tenant`. Cross-tenant read is denied.
- `computeAuditHashV2` is unchanged. Callers pass `ticketId: null` and
  `conversationId: null` (hashed as `''`); those columns are gone.
- A `write` connector binding satisfies read tools; write tools require `write`.

Detailed KEEP / EXTRACT / DELETE ledger: [`docs/rebuild-surgery-manifest.md`](rebuild-surgery-manifest.md).
