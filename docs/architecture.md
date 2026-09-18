# Architecture note — Phase 0 compilation boundary + Phase A MCP gate + Phase B schema + Phase C Drive read + Phase E write approval

This repository is being rebuilt as an Enterprise MCP control plane. Phase 0
establishes a **clean compilation boundary**. It is not a compatibility layer
and not a data-model migration.

**Phase A is live:** Codex and Claude Code authenticate to the same tenant-scoped
Streamable HTTP resource at `/api/mcp/{tenantSlug}`. Clerk is the OAuth
authorization server; this app is only a resource server. The canonical OAuth
resource identifier (token audience, if any) is `{origin}/api/mcp` — no tenant
slug. Tenant isolation is the URL slug plus membership or superadmin assume.
See `docs/mcp-compatibility-runbook.md`.

**Phase B is live:** Prisma is a greenfield target schema (new `0001_init`).
Publish creates an append-only `AgentDefinitionVersion` (stable id = version
UUID). MCP tools `platform.whoami`, `platform.agents.list`, and
`platform.agent.get_definition` are read-only. Control Plane is the write path.
There is no `AuditLog` table. `GatewayOperation` / `GatewayApproval` tables
exist; Phase E implements enqueue / approve / reject / execute.

**Phase C:** `google_drive_search` and `google_drive_read_file` are registered
on the same `/api/mcp/{tenantSlug}` resource. Policy comes from the published
`AgentDefinitionVersion.snapshot`; live DB checks confirm the connector is
still `active` and the principal has a delegated `ConnectorGrant`.
`authorizeToolCall` is the single gate. Credentials are resolved server-side only
(`resolveAccessToken`) and never appear in MCP payloads. Audit is structured
`console.info` (`enterprise.tool.ok` / `denied` / `error`) — still no
`AuditLog` table.

**Phase E:** `google_drive_create_folder` enqueues a `GatewayOperation` in
`awaiting_approval`. A tenant admin/approver (self-approval allowed) approves
or rejects in Control Plane `/control-plane/operations`. Approval executes
the Drive write once in the same request (no worker). Idempotent retries use
`idempotencyKey`. Status is readable via `platform.gateway_operation.get`.
A `write` connector binding satisfies read tools; write tools require `write`.
Dual-harness evidence (Codex + Claude Code CLI versions and Clerk instance
type) is recorded on the PR when `docs/mcp-compatibility-runbook.md` is executed.

## Entry points

| Path | Role |
|---|---|
| `app/src/domain/gateway-services.ts` | Target composition root (IAM, tenant, agent definitions, connector/grant, skill, provisioning) |
| `app/src/auth/mcp-principal.ts` | MCP principal (Phase A/B) |
| `app/src/app/api/mcp/[tenantSlug]/route.ts` | Tenant-scoped MCP resource URL (Phase A) |
| `app/src/domain/agent-definition/` | Immutable Agent Definition (Phase B) |
| `app/src/domain/enterprise-tools/` | `authorizeToolCall` + Drive read/write gateway |
| `app/src/domain/gateway-operation/` | GatewayOperation enqueue / approve / execute (Phase E) |

Control Plane login remains Clerk (`app/src/auth/*`). Tenant membership is
`auth/tenant-context.ts` plus `domain/iam` and `domain/tenant`.

## `legacy/` rule

DELETE / REFERENCE ONLY / DEFER trees were `git mv`'d to `legacy/` at the repo
root, **outside** `app/`. They are readable history and a reference for later
EXTRACT work. They are **not** part of the active TypeScript project and must
not be imported from `app/src`.

Do not use `tsconfig.exclude` for those trees: exclude only drops root files,
not transitives. Moving them makes leftover imports fail, which is the
rewiring todo list.

## Import boundary

CI fails if the target layers import the old `@/domain` services barrel
(exact `@/domain` / `@/domain/index`, not KEEP subpaths such as
`@/domain/iam/...`) or the legacy runtime graph (`AgentChatRuntime`,
`ModelGateway`, dispatcher, conversation, harness). See
`app/src/domain/import-boundary-guard.ts` and the `no-restricted-imports`
ESLint rule.

## Isolation decisions

- The platform does not call a model for agent execution and does not store
  Conversation / AgentTurn state for MCP.
- There is no server-side selected-tenant / selected-agent session. Tenant is
  `/api/mcp/{tenantSlug}` plus membership or superadmin assume.
- `tools/list` is not a security boundary. `tools/call` uses an allow-list
  (`platform.whoami`, `platform.agents.list`, `platform.agent.get_definition`,
  `platform.gateway_operation.get`, `google_drive_search`,
  `google_drive_read_file`, `google_drive_create_folder`); every Drive
  `tools/call` still runs `authorizeToolCall`. Writes enqueue instead of
  calling Google until a human approves.
- Credentials never leave the server.
- Prisma is the Phase B target schema. Drive **read** MCP tools are Phase C
  (#540). Drive **write** + approval is Phase E (#541).

Detailed KEEP / EXTRACT / DELETE ledger: [`docs/rebuild-surgery-manifest.md`](rebuild-surgery-manifest.md).
