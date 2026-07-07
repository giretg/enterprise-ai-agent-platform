# Enterprise code review log

## 2026-07-07 - Knowledge Base tenant-határ (dokumentum-gate + megosztás + review)

- Áttekintett modulok:
  - `app/src/domain/knowledge-base/knowledge-base-service.ts` (requestDocument /
    approveDocument / rejectDocument / listPendingDocuments / listPendingArtifacts /
    getArtifactReview / publishArtifact + draft-artifact flow)
  - `app/src/app/actions/platform.ts` KB server actionök (requestKbDocument,
    approveKbDocument, rejectKbDocument, listKbDocumentRequests, getKbArtifactReview,
    processDocumentForWiki, listDocumentsForAgent, shareKnowledgeBaseWithAgent,
    unshareKnowledgeBaseFromAgent, getKnowledgeBaseSharing, deleteKbDocument)
  - `app/src/repositories/postgres/knowledge-repository.ts` (searchChunks / listIndex /
    getPageChunks retrieval scope), `app/src/domain/tool-broker/tool-broker-service.ts`
    `resolveKbConnectorScope` + kb_search/kb_list_index/kb_get_page
  - `app/src/auth/tenant-context.ts` (`requireTenantRole`), `app/prisma/schema.prisma`
    Document / KnowledgeArtifact / KnowledgeChunk / Agent tenant-mezők
- Eredmény:
  - A KB retrieval-út (kb_search és a navigáció) helyesen a Tool Broker fail-closed
    capability-kapuján és a connector-scope-on át fut, PUBLISHED-only chunkokra.
  - Talált egy cross-tenant IDOR-osztályt a KB admin-felületen. A KB actionök a hívó
    aktív tenant-szerepét hitelesítették (`requireTenantRole`), de a cél `agentId` /
    `documentId` / `ticketId` / `targetAgentId` feloldása globális `findById` volt,
    tenant-szűrő NÉLKÜL. Multi-tenant telepítésen ez egy tenant operátorának/approverének
    engedte, hogy (a) egy MÁSIK tenant agentjének tudásbázis-review tartalmát (extracted
    text, OKF file-tree) olvassa (`getKbArtifactReview`, `listKbDocumentRequests`),
    (b) idegen dokumentumot csatoljon idegen agent KB-jéhez a jóváhagyási kapu megkerülésével
    (`processDocumentForWiki`) vagy azon át (`requestKbDocument`), (c) idegen KB-jóváhagyást
    hagyjon jóvá/utasítson el (`approve/rejectKbDocument`), (d) cross-tenant KB-t osszon meg
    vagy szüntessen meg (`share/unshare/deleteKbDocument`). A demóban minden agent globális
    (tenantId null), ezért ma nem éles — de pontosan a multi-tenant enterprise használatban
    válik kihasználhatóvá (ugyanaz a mintázat, mint a 2026-07-07 Tool Broker és IAM review).
- Javítás:
  - Új közös primitív: a `isAgentReachableFromTenant` / `filterAgentsByTenant` a Tool
    Brokerből egy megosztott `app/src/lib/tenant-reachability.ts` modulba került (a Tool
    Broker re-exportál, a meglévő teszt változatlan) — így a KB ÉS a Tool Broker EGY
    tenant-invariánst használ (megosztott/null agent bárhonnan elérhető, cross-tenant SOHA).
  - A KB domain-service minden agent-/ticket-belépője `actorTenantId`-t kap és fail-closed
    módon ellenőrzi az elérhetőséget (`assertAgentReachable` / `assertTicketAgentReachable`);
    a cross-tenant hozzáférés opak `Agent not found` / `KB ticket not found` (nincs
    létezés-oracle).
  - A prisma-direkt KB actionök (`processDocumentForWiki`, `listDocumentsForAgent`,
    `share/unshareKnowledgeBaseWithAgent`, `getKnowledgeBaseSharing`, `deleteKbDocument`)
    `assertAgentTenantReachable` őrt kaptak a forrás- ÉS cél-agentre.
  - Új determinisztikus teszt: `scripts/kb-tenant-boundary.test.ts` (10 eset:
    tiszta szabály + request/approve/reject/getReview/listPending cross-tenant deny +
    saját-tenant/megosztott allow), `test:kb-tenant-boundary`. A `knowledge-base-gate.test.ts`
    happy-path suite frissítve (actorTenantId) és zöld; tool-broker-tenant zöld; a módosított
    fájlok tsc/eslint tiszták.
- Üzleti hatás:
  - Megakadályozza, hogy egy ügyfél-tenant KB-adminisztrátora belásson vagy beleírjon egy
    másik ügyfél-tenant tudásbázisába — a tudásbázis a platform legérzékenyebb, ügyfél-tulajdonú
    tartalma. A tenant-határ a domain-rétegbe kerül, ahol a runtime és az audit ugyanazt az
    invariánst látja.
- Nyitott döntések (nem auto-javítva):
  - D1 — `Document`-nek nincs saját `tenantId` oszlopa; a tenant a connectoron / feltöltőn át
    származtatott. A `requestDocument` jelenleg tetszőleges CSATLAKOZATLAN documentId-t elfogad,
    ha a cél-agent elérhető; egy szigorúbb modell a dokumentum feltöltőjének tenantját is
    ellenőrizné (schema-bővítés kellhet).
  - D2 — `shareKnowledgeBaseWithAgent` megengedi, hogy egy tenant-saját KB-t egy MEGOSZTOTT
    (null) cél-agenthez kössenek, ami platform-szintűvé tehet ügyfél-tartalmat. A reachability
    ezt (a demó globális agentjei miatt) nem tiltja; termék/biztonsági döntést igényel, hogy a
    megosztott agent lehet-e tenant-saját KB célpontja.

## 2026-07-07 - IAM/RBAC tenant-context boundary (permission matrix + access audit)

- Reviewed modules:
  - `app/src/domain/iam/iam-service.ts` (invite/redeem/approve/role-change/suspend/reactivate, tenant-scoped target loading, last-admin lock, permission matrix update)
  - `app/src/auth/tenant-context.ts` (tenant membership / superadmin assume resolution, `requireTenantPermission`)
  - `app/src/auth/permission.ts` (legacy user-role based `requirePermission`)
  - `app/src/app/actions/platform.ts` IAM server actions (`listUsers`, invitation/user lifecycle, permission matrix, access audit)
  - `app/src/repositories/postgres/iam-repository.ts` and `app/src/repositories/postgres/audit-repository.ts`
  - `app/src/lib/iam-policy.ts`, `app/src/auth/context.ts`, `app/prisma/schema.prisma` IAM/tenant models
- Result:
  - The IAM domain service already enforces the important enterprise invariants for user lifecycle operations: tenant-scoped target lookup, self-modification denial, last active admin lockout, one-time invitation redemption, and append-only audit events.
  - Found a tenant-boundary gap in the IAM admin surface. The permission matrix and access-audit actions still used legacy `requirePermission`, which decides from the global `User.role`, not the active `TenantMembership` / superadmin-assume tenant context. In a migrated multi-tenant deployment this can deny a valid tenant admin whose membership is correct but legacy `User.role` is stale/null, and it can also apply/read IAM governance outside the selected tenant context. `getAccessAuditLog` also listed all access audit rows matching the action names, with no `tenantId` filter.
- Fix applied:
  - `getPermissionMatrix`, `updateRolePermission`, and `getAccessAuditLog` now use `requireTenantPermission`, so the active tenant membership or explicit superadmin assume context is the authorization boundary.
  - Access audit list construction moved to `buildTenantAccessAuditFilter`, which always includes the active tenant id and the fixed access-audit action allowlist.
  - `IamService.updatePermission` now writes explicit `tenantId` attribution and includes the tenant id in metadata for `user.permission.update`.
  - Added `scripts/iam-tenant-boundary.test.ts` and `test:iam-tenant-boundary` to cover tenant-scoped access-audit filters and permission-update audit attribution.
- Business impact:
  - Prevents IAM administration and access audit review from accidentally crossing customer tenant boundaries.
  - Aligns the admin UI with the platform's current multi-tenant model: tenant membership and superadmin assume mode are the source of authority, not legacy single-tenant user-role fields.
  - Improves audit evidence for enterprise customers because permission-matrix changes are attributable to a specific tenant context.
- Verification:
  - `npm run test:iam-tenant-boundary --prefix app`
  - `npm run test:iam-policy --prefix app`
  - `npm run test:tenant-management --prefix app`
  - `npx eslint src/domain/iam/iam-service.ts src/domain/iam/access-audit.ts src/app/actions/platform.ts scripts/iam-tenant-boundary.test.ts` from `app/`
- Decisions raised (not auto-fixed):
  - D1 — `RolePermission` is still a global table. The current fix scopes the action boundary and audit visibility by active tenant, but the matrix value itself remains platform-wide. If customers need tenant-specific IAM policies, the schema should add `tenantId` to `RolePermission` with a platform-default fallback.

## 2026-07-07 - Tool Broker: agent-oldali tenant-izoláció (delegálás + felderítés)

- Reviewed modules:
  - `app/src/domain/tool-broker/tool-broker-service.ts` (a governance-chokepoint:
    `AllowlistAuthorizer.authorize`, `ToolBrokerService.invoke`/`executeTool`,
    gmail-send jóváhagyás, http_api/file/sandbox/repo végrehajtók, acting-user/tenant
    feloldás, `agentResolve`/`agentCatalog`/`agentAsk`/`ticketCreate`/`userDirectory`)
  - `app/src/lib/agent-catalog.ts` (`buildAgentCatalogEntry` — teljes capability/connector belépő)
  - `app/prisma/schema.prisma` `Agent.tenantId` (nullable → megosztott vs tenant-saját agent)
  - `app/prisma/seed.ts` (a demo agentek mind globálisak, tenantId null)
- Result:
  - A Tool Broker törzse enterprise-helyes: fail-closed capability/role-template kapu,
    connector lifecycle- és tenant-izoláció a connectorokon, delegált OAuth-token
    injekció client_secret-szivárgás nélkül, append-only tool-call audit.
  - Talált tenant-izolációs rést az AGENT-irányú toolokban. A `user_directory` és a
    `ticket_create` HUMÁN-felelős ága kifejezetten tenant-szűrt ("cross-tenant user
    SOHA nem szivárog ki"), de az `agent_resolve`, `agent_catalog`, `agent_ask`, és a
    `ticket_create` AGENT-felelős ága a teljes agent-táblán dolgozott (`agents.findMany()` /
    `findById()` tenant-szűrő nélkül). Multi-tenant telepítésen ez egy tenant agentjének
    engedte, hogy (a) felderítse egy másik tenant agentjeinek nevét, szerepét és TELJES
    capability-/connector-katalógusát, és (b) cross-tenant agentnek delegáljon feladatot
    (confused deputy — a célagent a saját connectorai/tudásbázisa felett dolgozna egy idegen
    tenant kérdésén). A demóban minden agent globális (tenantId null), ezért ma nem éles,
    de pontosan a multi-tenant enterprise használatban válik kihasználhatóvá.
- Fix applied:
  - Új tiszta szabály: `isAgentReachableFromTenant(agentTenantId, effectiveTenantId)` —
    megosztott (null) agent bárhonnan elérhető, egyébként csak azonos tenant; plusz a
    `filterAgentsByTenant` lista-szűrő. Ez a `user_directory` tenant-izolációjának
    agent-oldali párja (defense-in-depth, sosem fail-open).
  - `agent_resolve` és `agent_catalog` (lista- ÉS `agentId`-direktlookup-ág is) a hívó
    effektív tenantjára szűr (`resolveCallerTenantId` = acting-user tenant, különben a
    hívó agent tenantja — a `user_directory` mintája). `agent_ask` és a `ticket_create`
    agent-felelős ága elutasítja a cross-tenant célagentet (a delegálás-ticket tenantja,
    különben a cselekvő felhasználó tenantja a referencia).
  - Új determinisztikus teszt: `scripts/tool-broker-tenant-isolation.test.ts` (8 eset:
    pure szabály + agent_resolve szűrés + agent_catalog direkt-lookup + agent_ask/
    ticket_create cross-tenant deny), `test:tool-broker-tenant`. A kapcsolódó suite-ok
    (tool-broker-bridge, user-directory, repo-pr, tool-loop) zöldek; a módosított fájlok
    tsc/eslint tiszták.
- Business impact:
  - Megakadályozza, hogy egy tenant agentje (vagy egy prompt-injektált agent) felderítse
    vagy elérje egy másik ügyfél-tenant agentjeit — se adat-, se capability-, se
    delegációs úton. A tenant-határ a domain-rétegbe kerül, ahol a runtime és az audit
    ugyanazt az invariánst látja.
- Decisions raised (not auto-fixed):
  - D1 — `checkGmailSendApproval` a jóváhagyó ticketet ID alapján, tenant/agent-kötés és
    egyszer-használatosság (replay-védelem) nélkül fogadja el; a tényleges küldést a
    per-user grant korlátozza ugyan a saját postafiókra, de a per-küldés emberi jóváhagyás
    újrafelhasználható. Termék/biztonsági döntést igényel (kötés a konkrét draft-hoz + consume).
  - D2 — `argsMeta` a `ticket_create`-nél `Object.keys(input.args.payload)`-t hív; ma a séma
    kötelezővé teszi a payloadot (`?? {}`), de egy hiányzó payload a hiba-ági auditban
    TypeError-t dobna. Robusztusság-nit, külön javítható.

## 2026-07-06 - Governed Flow Builder: Playbook v2 compile + runtime path

- Reviewed modules:
  - `app/src/lib/playbook-v2/runtime.ts` (deterministic transition + advance engine)
  - `app/src/lib/playbook-v2/process-step-payload.ts` (step outcome + output contract)
  - `app/src/lib/playbook-v2/step-output-inference.ts`
  - `app/src/domain/playbook/playbook-compiler.ts`
  - `app/src/domain/playbook/playbook-validator.ts`
  - `app/src/domain/playbook/process-service.ts` (advance / concurrency hardening)
  - `app/src/domain/agent/general-task-runtime.ts` (step outcome enforcement path)
- Result:
  - The governed orchestration core has the right enterprise shape: gate-bypass is
    fail-closed (agent/system can never cross a blocking human gate), the cascade
    protection routes `blocked`/`failed` step outcomes away from the happy path, and the
    recent concurrency hardening (idempotency guard + conditional status writes) targets a
    real "stuck running" race.
  - Found a correctness gap in output-contract inference. `inferStepOutputFields` only
    walked `step.onComplete`, but Decision Steps (WP-8) route via `decision.branches` /
    `fallback` (desugared to onComplete at compile time). A decision branch leading to a
    step with a required `step`-source input slot never had that field inferred into the
    decision step's output contract, so neither the validator warned nor the runtime
    enforced it — the decision step closed silently as `ok` and the process only blocked
    later at the next step's creation (`output_contract_unmet` class).
- Fix applied:
  - `inferStepOutputFields` now collects next-step targets from both `onComplete` and
    `decision.branches` / `decision.fallback` via a local `happyPathNextStepIds` helper,
    consistent with the compiler's `desugarDecision` and the validator's `buildAdjacency`
    (traversal inlined to avoid a circular import).
  - Added 2 regression tests in `playbook-process-lifecycle.test.ts` (branch + fallback
    field inference and compiler `outputRequiredFields` pass-through). Full playbook-v2
    core/runtime/process/governed/lifecycle/process-def suites green; eslint clean.
- Decisions raised (not auto-fixed; see `docs/code-review/2026-07-06-playbook-runtime-decisions.md`):
  - D1 — `StepOutcomeSignals.toolDenied` is unreachable code: the tool loop never surfaces
    a mid-loop broker denial, so a step can close `ok` despite a governance-denied tool
    call. Needs a product/security decision on whether denial should hard-fail the step.
  - D2 — the `await_gate` / `await_human` advance branches lack the terminal-status guard
    that `next_step` / `complete` use; unreachable today under the single-active-step
    invariant, but a defense-in-depth inconsistency.

## 2026-07-06 - Model Gateway governed routing / request model override

- Reviewed modules:
  - `app/src/domain/gateway/model-gateway.ts`
  - `app/src/domain/gateway/routing-engine.ts`
  - `app/src/domain/gateway/sensitivity-router.ts`
  - `app/src/domain/gateway/budget-engine.ts`
  - `app/src/app/api/v1/gateway/v1/chat/completions/route.ts`
  - `app/src/lib/harness-model-config.ts`
  - `app/scripts/model-gateway-negative.test.ts`
- Result:
  - The Model Gateway already centralizes provider calls, sensitivity classification, budget guardrails, model-call audit records, and provider abstraction in a shape that is appropriate for enterprise control-plane enforcement.
  - Found a governance bypass in the OpenAI-compatible gateway API path. A caller-provided `model` value was merged into `modelConfig` before entering the gateway, so the routing engine treated it as the agent's registry model. Without an explicit routing policy this let a request choose another model identifier, which can bypass central cost, vendor, residency, and approval expectations.
  - Found that the routing engine's `overrideHint` contract was documented as low trust but, if used, would have accepted the override before policy evaluation. That is the wrong default for an enterprise AI gateway because request-level preferences must be opt-in governance decisions, not caller authority.
- Fix applied:
  - Request-selected models now travel as `modelOverrideHint` instead of overwriting the agent registry `modelConfig`.
  - `RoutingEngine` ignores request model overrides by default and honors them only when the matched routing policy explicitly sets `allowRequestOverride: true`; optional provider/model allowlists further constrain which override can be used.
  - The `/api/v1/gateway/v1/chat/completions` response now reports the actual model used by the gateway, so clients and audit evidence do not claim that a denied override was honored.
  - Added MG-N7 negative tests covering default-deny override behavior, explicitly allowlisted override behavior, and denied unallowlisted override behavior.
- Business impact:
  - Prevents API clients, harnesses, or compromised agents from silently switching to unapproved, more expensive, or non-compliant model backends.
  - Keeps model routing, vendor selection, and data-governance decisions in the platform control plane where administrators can review and audit them.
  - Improves customer-facing transparency by returning the actual model that processed the request.

## 2026-07-01 - Per-user connector grant / OAuth token vault

- Reviewed modules:
  - `app/src/domain/connector-grant/connector-grant-service.ts`
  - `app/src/domain/connector-grant/grant-token-vault.ts`
  - `app/src/domain/connector-grant/gmail-scopes.ts`
  - `app/src/domain/connector-grant/gmail-api-client.ts`
  - `app/src/domain/tool-broker/tool-broker-service.ts` delegated Gmail/token integration
  - `app/src/app/actions/connector-grants.ts`
  - `app/src/app/api/connectors/oauth/callback/route.ts`
  - `app/src/repositories/postgres/connector-grant-repository.ts`
  - `app/prisma/schema.prisma` `ConnectorGrant` model
  - `app/scripts/per-user-connector.test.ts`, `app/scripts/s7-live-smoke.ts`, `app/scripts/acceptance-e2e.ts`
- Result:
  - Found that token issuance and grant status changes relied too much on callers passing a previously authorized `grantId`. The domain service did not independently re-check that the grant belonged to the acting user, tenant, connector, and token reference before loading the token vault. In an enterprise environment this is a defense-in-depth gap: a future integration bug could turn a valid grant id into cross-user delegated mailbox access.
  - Found that initial OAuth token exchange accepted missing `refresh_token` and did not reject provider-returned scopes that were wider than the scopes requested through state. For long-lived delegated access, both should fail closed.
- Fix applied:
  - `ConnectorGrantService` now reloads and verifies grant ownership before token resolution, revoke, and expiry marking.
  - OAuth exchange now requires `access_token` and `refresh_token`, and rejects unrequested provider scopes.
  - OAuth refresh now requires a returned `access_token`.
  - Tool broker and connector-grant action/smoke callers now pass explicit tenant/user expectations.
  - Added deterministic per-user connector tests for the token ownership invariant.
- Business impact:
  - Reduces the risk that one user's delegated Gmail/Workspace token can be used by another user or tenant because of a caller-side bug.
  - Keeps delegated grants least-privilege even if an OAuth provider response is malformed or unexpectedly broad.
  - Moves critical access-control rules into the domain layer, where enterprise audit and runtime paths share the same invariant.

## 2026-07-04 - Web fetch / egress guard SSRF boundary

- Reviewed modules:
  - `app/src/domain/net/egress-guard.ts`
  - `app/src/domain/web-fetch/web-fetch-service.ts`
  - `app/src/domain/web-fetch/content-sanitize.ts`
  - `app/src/domain/web-fetch/web-fetch-types.ts`
  - `app/src/domain/index.ts` production `WebFetchService` DNS resolver wiring
  - `app/scripts/egress-guard.test.ts`
  - `app/scripts/web-fetch.test.ts`
- Result:
  - The web fetch path already had the right enterprise shape: deny-by-default source URL checks, HTTPS-only fetches, manual redirect handling, content-type and size caps, hash-only audit metadata, and production DNS resolution before fetch.
  - Found a defense-in-depth gap in the resolved-IP classifier. It blocked common private ranges but did not cover several reserved IPv4 ranges, IPv6 documentation/transition/multicast prefixes, or compressed IPv4-mapped IPv6 forms such as `::ffff:a9fe:a9fe`. In production, that could let an allowlisted hostname that resolves unexpectedly to a special-use address get further than intended before the network layer fails or behaves inconsistently.
- Fix applied:
  - IP literal host detection now uses Node's IP parser, so bracketed IPv6 literals are rejected as raw IP hosts as well as IPv4 literals.
  - DNS rebinding checks now classify broader IPv4 reserved ranges and IPv6 loopback, ULA, link-local, multicast, documentation, transition, IPv4-mapped, IPv4-compatible, and NAT64 metadata/private forms.
  - Added egress guard and web fetch tests for IPv6-mapped metadata resolution and additional reserved ranges.
- Business impact:
  - Reduces the chance that AI-driven web discovery can be abused to reach cloud metadata services, internal networks, or special-use network ranges through DNS tricks.
  - Makes the documented "reserved IP re-check" behavior match the actual runtime behavior more closely, which is important for enterprise security review and audit evidence.
  - Keeps the mitigation in the shared server-side egress guard, so callers cannot accidentally bypass it by constructing a different web fetch flow.
