# Repository surgery manifest

**Issue:** [#8](https://github.com/giretg/enterprise-mcp/issues/8) (Phase 0), parent [#7](https://github.com/giretg/enterprise-mcp/issues/7)  
**Forrás:** `enterprise-ai-control-plane-mcp-rebuild-plan-v2-2026-09-18`  
**Baseline HEAD:** `f9935cb0289d9513b7baeee4a8d6684b1785a57f` (`Merge pull request #533 from giretg/feat/518-capacity-queue`, 2026-09-17)  
**Repo:** `giretg/enterprise-mcp`  
**Dátum:** 2026-09-18

**Phase F (issue #542, 2026-09-18):** `legacy/` **nem** lett törölve — REFERENCE ONLY marad a repóban (későbbi EXTRACT: Gmail, sandbox, scheduling). A cut után `app/`-ban maradt DELETE-felület (agent rail, `GET /api/agents/rail-state`, dispatcher/harness/code-sandbox Dockerfile + GCP deploy script) itt kikerült. Az `audit_log` KEEP visszaállt (append-only trigger, hash-chain v2, event catalog, payload guard, Control Plane `/audit` + `verifyChain`) — ez felülírja a #539 „nincs AuditLog tábla” döntést. A seed publikál **és aktivál** egy write-bound Drive assistantot.

Ez **nem** a rebuild terv második példánya. Egy fájlra egy döntés. Implementáció közben az architekturális besorolást **ne nyisd újra**, kivéve ha a kód bizonyítja, hogy a sor hibás — akkor javítsd itt, egy helyen.

---

## Döntési szavak

| Szó | Jelentés | Aktív `app` build |
|---|---|---|
| **KEEP** | Célállapotú felelősség. MCP principalhoz igazítva marad. | bent |
| **EXTRACT** | Üzleti/biztonsági mag kell; ticket/chat/runtime coupling nem. Emeld az új helyre, az eredeti nem a target graph. | forrás olvasható maradhat a cutig; a target **nem** importálja |
| **REWRITE** | Új, kicsi célállapotú komponens. A régi szerződés nem marad. | a régi kód nem a target graph |
| **REFERENCE ONLY** | Mintát/leírást ad; tilos importálni a target graphból. | Phase 0-ban kikerül az aktív typecheckből |
| **DELETE** | Nincs helye a termékben. | Phase 0-ban kikerül az aktív typecheckből; Phase F törli a fájlt |
| **DEFER** | Core MVP után. Most ne séma, ne route, ne nav. | kikerül az aktív typecheckből, ha legacy modellekre támaszkodik |

**COPY** = EXTRACT, más néven. Nincs külön „mentés kedvéért” kategória.

---

## Cél compilation boundary

Új composition root — **ez** az egyetlen `services` graph, amit a target út importálhat:

```text
app/src/domain/gateway-services.ts
```

Új belépési pontok. A **Fázis** oszlop a tartalom fázisa; a mappa/fájl határ **Phase 0-ban létrejön** (issue #8 „create the target package/module boundaries"), egy `index.ts`-szel, ami csak típust / `TODO(phase-X)` exportot tartalmaz — így az import-boundary guardnak van célpontja, és a határ a forrásfában explicit:

| Path | Fázis | Felelősség |
|---|---|---|
| `app/src/domain/gateway-services.ts` | 0 | IAM, tenant, audit, connector/grant, skill/knowledge read; később AgentDefinition + EnterpriseToolGateway |
| `app/src/auth/mcp-principal.ts` | A | Bearer → user → URL tenant → membership → `McpPrincipal` |
| `app/src/app/api/mcp/[tenantSlug]/route.ts` | A | Hivatalos MCP SDK v2 `createMcpHandler`, stateless |
| `app/src/domain/agent-definition/` | B | Immutable Agent Definition |
| `app/src/domain/enterprise-tools/` | C | `authorizeToolCall` + registry + gateway |
| `app/src/domain/gateway-operation/` | E | `GatewayOperation` / `GatewayApproval` |
| `app/src/domain/audit/` | F | `verifyChain` + tenant-scoped JSONL export |

A `connectors` és `tenant/user authorization` határ nem új mappa: a meglévő KEEP `domain/connector*`, `domain/iam`, `domain/tenant`, `auth/tenant-context.ts` az. A `gateway-services.ts` exportja jelöli ki, mi tartozik a target graphba.

**Tilos** a fenti rétegeknek importálni:

```text
@/domain                          # a régi domain/index.ts services graph
@/domain/index.ts
AgentChatRuntime
ChatTurnLauncher / ChatTurnDispatcher
ModelGateway / RoutingEngine / BudgetEngine
WikiAgentRuntime / GeneralTaskRuntime / BookkeeperAgentRuntime
Conversation / ConversationService
AgentTurn launcher / queue / recovery / watchdog
domain/dispatcher/**
harness/job-entrypoint.ts
wiki/general-task/bookkeeper runtime
```

Phase 0 cut mód: a DELETE / REFERENCE ONLY / DEFER fák **`git mv`-vel `legacy/` alá** kerülnek a repo gyökerében, az `app/`-on kívül (pl. `app/src/domain/gateway/**` → `legacy/domain/gateway/**`). A Git history és a külön futó legacy app a referencia — az új working tree-nek nem kell futtatnia őket.

**Miért nem `tsconfig exclude`:** az `exclude` csak a root fájlokat szűri; amit egy bent maradó fájl importál, azt a TS továbbra is fordítja. A baseline-on 51 fájl importálja a fat `@/domain` barrelt (30 KEEP-fában), és 12 KEEP domain-fájl húz közvetlenül `@/domain/gateway/*` vagy `@/domain/dispatcher/*`-t. Exclude-dal a cut set visszaszivárog, és a „Phase 0 done" 5. pontja nem teljesíthető. A költöztetés után minden maradó import hibát dob — ez a **kívánt** viselkedés: a hibalista a rewiring teendőlistája.

Ismert KEEP → DELETE függések, amiket a cut **előtt** kell feloldani (lásd a §3 sorokat):

| KEEP fájl | Húzza | Feloldás |
|---|---|---|
| `connector/connector-secret-store.ts`, `connector/http-api-client.ts`, `connector-grant/grant-token-vault.ts` | `@/domain/dispatcher/cloud-run-auth` (`getCloudRunAccessToken`) | EXTRACT → `domain/net/cloud-run-auth.ts` |
| `privacy/prompt-privacy-transform.ts` | `@/domain/gateway/sensitivity-router` (`collectSensitivityMatchSpans`) | EXTRACT a span-collector tiszta függvényt `privacy/` alá; a router többi része DELETE |
| `platform-settings/platform-settings-service.ts` | `gateway/sensitivity-mode`, `gateway/fallback-chain`, `gateway/price-sync` | Modell-/ár-/fallback ágak DROP (EXTRACT sor már mondja); `sensitivity-mode` típus → `privacy/` |
| `skill/skill-review-agent.ts`, `skill/skill-distiller-agent.ts` | `gateway/model-gateway` | DELETE — a `skill/**` KEEP fából **külön** kiszedve |
| `agent-access/*materialization.ts`, `agents/run-analyst-role.ts` | system-agent runtime | DELETE; az `agent-access-service` EXTRACT-nál a hívást vágd |

**Sorrendi invariáns:** compilation-boundary cut → tiszta target Prisma schema (#10). Ne fordítva.

---

## Célcsomag-határok

Issue #8 szerinti új modulhatárok, és honnan jön a mag:

| Határ | Új hely | Forrás a baseline-on |
|---|---|---|
| MCP transport + auth | `app/api/mcp/[tenantSlug]`, `auth/mcp-principal.ts` | REFERENCE: `harness/platform-mcp-bridge.ts`; KEEP: `auth/*` Clerk/IAM, nem az agent API key |
| Tenant / user authorization | `gateway-services` + `auth/tenant-context.ts` + `domain/iam`, `domain/tenant` | KEEP/EXTRACT |
| Agent definitions | `domain/agent-definition/` | EXTRACT: Agent/Skill repo, `prompt-assembler` tiszta része; REWRITE: modell/runtime mezők |
| Connectors | `domain/connector`, `domain/connector-grant` | KEEP a canonical config / secret / grant / Drive+Gmail kliens |
| Tool grants / policies | `domain/enterprise-tools/` | EXTRACT: authorizer/registry/handler minták; REWRITE: a broker szerződés |
| Operations / approvals / audit | `domain/gateway-operation/` + `domain/audit` | REWRITE approval; KEEP audit append |

---

## 1. Composition root, auth, shell

| Path | Döntés | Új célhely | Megjegyzés |
|---|---|---|---|
| `app/src/domain/index.ts` | DELETE / REPLACE | `gateway-services.ts` | Régi global `services` graph. A target **soha** nem importálja. |
| `app/src/domain/gateway-services.ts` | REWRITE (új) | — | Phase 0 skeleton. Csak KEEP szolgáltatások. |
| `app/src/auth/index.ts` | KEEP | control plane login | Clerk vs dev provider. |
| `app/src/auth/clerk-provider.ts` | KEEP | — | IdP adapter. |
| `app/src/auth/clerk-user-sync.ts` | KEEP | — | User provisioning. |
| `app/src/auth/dev-provider.ts` | KEEP | local/dev | Nem production IdP. |
| `app/src/auth/context.ts` | KEEP | — | UI session. Nem MCP principal. |
| `app/src/auth/tenant-context.ts` | KEEP | control plane + MCP membership | Tenant-scoped role. |
| `app/src/auth/permission.ts` | KEEP | — | RBAC helper. |
| `app/src/auth/types.ts` | KEEP | — | `AuthUser`. MCP-hez `McpPrincipal` külön típus. |
| `app/src/auth/agent-api-key.ts` | DELETE | — | Machine API key, nem human MCP principal. |
| `app/src/auth/mcp-principal.ts` | REWRITE (új) | MCP resource server | Phase A. |
| `app/src/lib/clerk-config.ts` | KEEP | — | Clerk on/off. |
| `app/src/lib/iam-policy.ts` | KEEP | — | Role rank, lock-out, deny-by-default. |
| `app/src/lib/tenant-policy.ts` | KEEP | — | Platform vs tenant role. |
| `app/src/app/api/webhooks/clerk/route.ts` | KEEP | — | Váltson `gateway-services`-re; ne `@/domain`. |
| `app/src/app/sign-in/**`, `sign-up/**` | KEEP | — | Clerk UI. |
| `app/src/proxy.ts` | KEEP | — | Next proxy/middleware. |
| `app/src/app/layout.tsx`, `globals.css`, `error.tsx`, `not-found.tsx` | KEEP | — | App shell. |
| `app/src/app/[locale]/**` | KEEP | public legal pages | Nem runtime. |
| `app/src/i18n/**`, `app/src/messages/**` | KEEP | — | next-intl. |
| `app/src/logo/**`, `app/src/content/**` | KEEP | — | Statikus. |

---

## 2. IAM, tenant, agent, skill, knowledge

| Path | Döntés | Új célhely | Megjegyzés |
|---|---|---|---|
| `app/src/domain/iam/**` | KEEP | control plane | MCP principalhoz igazítva. |
| `app/src/domain/tenant/**` | KEEP | control plane | Membership minden MCP kérésen. |
| `app/src/repositories/postgres/iam-repository.ts` | KEEP | — | |
| `app/src/repositories/postgres/tenant-repository.ts` | KEEP | — | |
| `app/src/repositories/postgres/role-template-repository.ts` | KEEP | — | RolePermission forrás. |
| `app/src/domain/agents/agent-scaffold-agent.ts` | DELETE | harness-side draft | LLM helper; platform csak validál/aktivál, ha kell. |
| `app/src/domain/agents/run-analyst-role.ts` | DELETE | — | Platform system-agent runtime. |
| `app/src/domain/agents/web-egress-role.ts` | EXTRACT | capability/policy | A web-egress *agent role* nem kell; a connector egress szabály igen. |
| `app/src/domain/agent-access/agent-access-service.ts` | EXTRACT | `ResourceGrant` view/operate | `canAddress` / agent→agent gráf nem jön át. |
| `app/src/domain/agent-access/addressable-colleagues.ts` | DELETE | — | Chat addressing. |
| `app/src/domain/agent-access/default-user-agent-grants.ts` | EXTRACT | user→agent operate | Csak human principal. |
| `app/src/domain/agent-access/agent-graph-node-select.ts` | DELETE | — | Gráf UI. |
| `app/src/domain/agent-access/run-analyst-*.ts` | DELETE | — | |
| `app/src/domain/agent-access/web-egress-materialization.ts` | DELETE | — | System-agent materializálás. |
| `app/src/domain/agent-access/tenant-web-egress-selection.ts` | EXTRACT | connector/egress policy | Tenant web-egress *connector* választás kellhet; az agent nem. |
| `app/src/repositories/postgres/agent-access-grant-repository.ts` | EXTRACT | ResourceGrant vagy szűk `canUse` | Első választás: `ResourceGrant(resourceType=agent, view\|operate)`. |
| `app/src/repositories/postgres/agent-repository.ts` | EXTRACT | `agent-definition` + KEEP CRUD mezők | `modelConfig`, `memoryId`, runtime relációk kiesnek a target sémából. |
| `app/src/repositories/postgres/behavior-profile-repository.ts` | EXTRACT | Agent Definition behavior | Verziózott viselkedésszöveg kell; chat-persona runtime nem. |
| `app/src/domain/skill/skill-service.ts` | KEEP | control plane + definition snapshot | |
| `app/src/domain/skill/skill-package-fetcher.ts` | KEEP | skill resources | MCP Resource URI később. |
| `app/src/domain/skill/skill-distiller-agent.ts` | DELETE | harness draft | |
| `app/src/domain/skill/skill-review-agent.ts` | DELETE | harness draft | Mindkettő `model-gateway`-t húz; a `skill/**` KEEP fából a cut előtt ki kell venni. |
| `app/src/repositories/postgres/skill-repository.ts` | KEEP | — | |
| `app/src/lib/skill/**` | KEEP | — | Parser/validator/hash. Distill-transcript chat-kötés: EXTRACT vagy drop. |
| `app/src/domain/knowledge-base/**` | EXTRACT | knowledge read | Tárolás/search marad; platform LLM ingestion nem core. |
| `app/src/repositories/postgres/knowledge-repository.ts` | KEEP | — | |
| `app/src/domain/agent/prompt-assembler.ts` | EXTRACT | `agent-definition` builder | Csak role/instruction/skill kompozíció. History, model, cache, memory: drop. |
| `app/src/lib/agent-lifecycle.ts` | EXTRACT | Agent CRUD | Status/draft/active. |
| `app/src/lib/agent-kind.ts` | KEEP | — | Ha a target sémában marad kind; különben drop. |
| `app/src/lib/agent-persona.ts` | EXTRACT | definition snapshot opcionális display | Nem runtime. |
| `app/src/lib/agent-catalog.ts` | EXTRACT | `agents_list` | Model/chat mezők nélkül. |
| `app/src/lib/agent-tenant-access.ts` | KEEP | — | Tenant membership gate. |
| `app/src/lib/create-agent-wizard.ts` | EXTRACT | admin UI | Model-config lépés kiesik. |

---

## 3. Tool path, connector, grant, privacy, audit

| Path | Döntés | Új célhely | Megjegyzés |
|---|---|---|---|
| `app/src/domain/enterprise-tools/**` | REWRITE (új) | — | Phase C: registry + `authorizeToolCall` + gateway. |
| `app/src/domain/tool-broker/tool-broker-service.ts` | REFERENCE / EXTRACT | `EnterpriseToolGateway` | invoke/authorizer/handler/audit keret; ticket/conversation/acting-user nem. |
| `app/src/domain/tool-broker/tool-broker-authorizer.ts` | EXTRACT | `authorizeToolCall` | Egyetlen kanonikus kapu. Acting-user fallback tiltott. |
| `app/src/domain/tool-broker/tool-registry.ts` | REFERENCE / EXTRACT | `enterprise-tool-registry.ts` | Csak `google_drive_search`, `google_drive_read_file`, Phase E-ben `google_drive_create_folder`. A 2700+ soros registry nem portolandó. |
| `app/src/domain/tool-broker/tool-connector-requirements.ts` | EXTRACT | enterprise registry | Connector binding. |
| `app/src/domain/tool-broker/tool-broker-audit.ts` | EXTRACT | gateway audit | |
| `app/src/domain/tool-broker/tool-output-privacy.ts` | EXTRACT | safe MCP output | MCP-n csak privacyzott text; `machineData` nem default. |
| `app/src/domain/tool-broker/tool-output-contract.ts` | EXTRACT | result envelope | Minimál. |
| `app/src/domain/tool-broker/tool-result-envelope.ts` | EXTRACT | — | |
| `app/src/domain/tool-broker/tool-trust-registry.ts` | DEFER | — | Core MVP Drive pilothoz nem kell. |
| `app/src/domain/tool-broker/write-approval-trust.ts` | REFERENCE ONLY | GatewayApproval | Exact-args minta; chat continuation nem. |
| `app/src/domain/tool-broker/consequence-approval-service.ts` | REFERENCE ONLY | `gateway-operation` | Conversation/ticket continuation. Új modell kevesebb munka. |
| `app/src/domain/tool-broker/consequence-gate-policy.ts` | EXTRACT | approval requirement | Risk/approval döntés magja. |
| `app/src/domain/tool-broker/tool-broker-delegation.ts` | DELETE | — | Agent delegation runtime. |
| `app/src/domain/tool-broker/tool-access-diagnostics.ts` | DEFER | — | Admin diagnosztika, nem MCP security boundary. |
| `app/src/domain/tool-broker/handlers/tool-handler.ts` | EXTRACT | enterprise-tools | Handler interface. |
| `app/src/domain/tool-broker/handlers/registry.ts` | EXTRACT | kis handler map | |
| `app/src/domain/tool-broker/handlers/google-drive.handler.ts` | EXTRACT | Drive vertical slice | Search / read / create_folder. Többi Drive write: DEFER. |
| `app/src/domain/connector-grant/google-drive-*.ts` | KEEP | Tool & Data Plane | Credential szerveren marad. |
| `app/src/domain/connector-grant/gmail-*.ts` | DEFER | Gmail read később | Phase I. |
| `app/src/domain/tool-broker/handlers/gmail.handler.ts` | DEFER | — | |
| `app/src/domain/tool-broker/handlers/http-api.handler.ts` | DEFER | — | Pilot után. |
| `app/src/domain/tool-broker/handlers/document-read.handler.ts` | DEFER | knowledge read | Ha a knowledge tool kell, akkor EXTRACT. |
| `app/src/domain/tool-broker/handlers/kb.handler.ts` | EXTRACT | `knowledge_search` | Csak ha Phase B knowledge context MCP-n megy. |
| `app/src/domain/tool-broker/handlers/{agent-ask,board-write,debug-trace,file,memory,reconcile-records,repo,run-*,sandbox-*,ticket-create,tulajdoni-lap,web-*}.handler.ts` | DELETE | — | Chat/runtime/sandbox/ticket/web-research surface. |
| `app/src/domain/connector/canonical-config.ts` | KEEP | — | |
| `app/src/domain/connector/connector-secret-store.ts` | KEEP | — | Secret soha nem megy a harnesshez. |
| `app/src/domain/connector/http-api-client.ts` | KEEP | HTTP connector execution | |
| `app/src/domain/connector/http-api-paginate.ts` | KEEP | — | |
| `app/src/domain/connector/{github-*,decode-github-*}` | DEFER | — | Nincs a Core MVP pathben. |
| `app/src/domain/connector/http-api-prompt.ts` | DELETE | — | Model-facing prompt. |
| `app/src/domain/connector-grant/connector-grant-service.ts` | KEEP | — | |
| `app/src/domain/connector-grant/connector-grant-needed.ts` | KEEP | — | |
| `app/src/domain/connector-grant/grant-token-vault.ts` | KEEP | — | |
| `app/src/domain/connector-grant/delegated-oauth-registry.ts` | KEEP | — | |
| `app/src/domain/connector-grant/google-workspace-api-client.ts` | KEEP | Drive/Gmail shared | |
| `app/src/repositories/postgres/connector-repository.ts` | KEEP | — | |
| `app/src/repositories/postgres/connector-grant-repository.ts` | KEEP | — | |
| `app/src/repositories/postgres/tool-broker-repository.ts` | EXTRACT | operation/audit store | ToolCall runtime tábla nem target séma. |
| `app/src/repositories/postgres/consequence-approval-repository.ts` | REFERENCE ONLY | GatewayApproval repo | |
| `app/src/domain/net/egress-guard.ts` | KEEP | Tool & Data Plane | SSRF/allowlist. Sandbox/web_fetch coupling nélkül is kell. |
| `app/src/domain/net/untrusted-patterns.ts` | KEEP | — | |
| `app/src/domain/dispatcher/cloud-run-auth.ts` | EXTRACT | `domain/net/cloud-run-auth.ts` | `getCloudRunAccessToken` — 3 KEEP connector/grant fájl függ tőle. A `dispatcher/**` többi része DELETE. |
| `app/src/harness/egress-guard.ts` | REFERENCE ONLY | `domain/net/egress-guard.ts` | Duplikátum-gyanú; a domain/net a forrás. |
| `app/src/domain/audit/**` | KEEP | gateway audit | Csak szükséges metadata. |
| `app/src/repositories/postgres/audit-repository.ts` | EXTRACT | AuditEvent append | `ModelCall` / budget / routing repo **DELETE**. Szedd szét, ne vidd a model-táblákat. |
| `app/src/lib/audit/**` | KEEP | event catalog | Runtime-only event neveket ne portolj. |
| `app/src/lib/crypto/**` | KEEP | secrets, hash-chain, timing-safe | `audit-backfill.ts` DEFER/DELETE (legacy migráció). |
| `app/src/domain/privacy/privacy-mode.ts` | EXTRACT | safe output policy | |
| `app/src/domain/privacy/privacy-category-policy.ts` | EXTRACT | — | |
| `app/src/domain/privacy/privacy-egress-matrix.ts` | EXTRACT | MCP output | |
| `app/src/domain/privacy/prompt-privacy-transform.ts` | EXTRACT | safe projection | `collectSensitivityMatchSpans` a `gateway/sensitivity-router`-ből jön → a tiszta span-collector is EXTRACT ide; a router többi része DELETE. |
| `app/src/domain/privacy/structured-output-transform.ts` | DEFER | structuredContent | Csak ha kliens kéri. |
| `app/src/domain/privacy/connector-privacy*.ts` | EXTRACT | connector egress | |
| `app/src/domain/privacy/*surrogate*` | DEFER | — | Conversation surrogate vault. MCP első verzió: egyszerű safe text. |
| `app/src/domain/privacy/conversation-privacy-key-crypto.ts` | DELETE | — | Conversation key. |
| `app/src/domain/privacy/privacy-catalog-sync*.ts` | DEFER | — | |
| `app/src/repositories/postgres/surrogate-vault-repository.ts` | DEFER | — | |
| `app/src/repositories/postgres/conversation-privacy-key-repository.ts` | DELETE | — | |

---

## 4. Runtime, model, chat, dispatcher, harness — DELETE

Ezek **Phase 0 cut**. Nem kivétel, hogy frissen írták.

| Path | Döntés | Megjegyzés |
|---|---|---|
| `app/src/domain/agent/agent-chat-runtime.ts` | DELETE | |
| `app/src/domain/agent/chat-tool-loop.ts` | DELETE | Policy/validation EXTRACT csak ha `authorizeToolCall` nem fedi. |
| `app/src/domain/agent/chat-turn-*.ts` | DELETE | launcher/dispatch/input/liveness |
| `app/src/domain/agent/agent-turn-*.ts` | DELETE | runner/reconnect/snapshot/watchdog |
| `app/src/domain/agent/{wiki,general-task,bookkeeper}-runtime.ts` | DELETE | |
| `app/src/domain/agent/context-compactor.ts` | DELETE | |
| `app/src/domain/agent/turn-continuation.ts` | DELETE | |
| `app/src/domain/agent/turn-cost-signals.ts` | DELETE | |
| `app/src/domain/agent/loop-stop-decision.ts` | DELETE | |
| `app/src/domain/agent/stuck-final-answer.ts` | DELETE | |
| `app/src/domain/agent/ticket-runtime-progress.ts` | DELETE | |
| `app/src/domain/agent/tool-result-*.ts` | DELETE | Runtime archive. |
| `app/src/domain/agent/efficiency-advisor*.ts` | DELETE | |
| `app/src/domain/agent/skill-task-promotion.ts` | DELETE | |
| `app/src/domain/gateway/**` | DELETE | ModelGateway, routing, budget, provider bridges, prompt-cache, sensitivity-router. **Kivétel nincs.** Az új fájlnév `gateway-services.ts` nem ebben a mappában él, hogy ne keveredjen. |
| `app/src/domain/dispatcher/**` | DELETE | Harness launcher, dispatch-cycle, Cloud Run job. |
| `app/src/domain/conversation/**` | DELETE | |
| `app/src/domain/channel/**` | DELETE | Telegram AI channel. |
| `app/src/domain/ticket/**` | DELETE | |
| `app/src/domain/memory/**` | DELETE | Platform memory runtime. Projektmemória/tanítás: DEFER, nem MCP core. |
| `app/src/domain/training/**` | DELETE | LLM teach analyzer. Approval/versioning később, ha termékigény. |
| `app/src/domain/eval/**` | DELETE | |
| `app/src/domain/run-analysis/**` | DELETE | AgentTurn analytics. |
| `app/src/domain/file-editor/**` | DELETE | Chat workspace editor. |
| `app/src/domain/contract-runtime/**` | DELETE | |
| `app/src/domain/writegate/**` | DELETE | Runtime write-gate token; az új approval más modell. |
| `app/src/domain/debug-log/**` | DELETE | |
| `app/src/domain/web-search/**` | DELETE | Platform search runtime. Harness native search. |
| `app/src/domain/web-fetch/**` | DELETE | Platform fetch runtime. Egress-guard KEEP. |
| `app/src/domain/web-research/**` | DELETE | |
| `app/src/domain/agent-diagnostics/**` | DELETE | |
| `app/src/domain/report/**` | DELETE | Measurement/governance report a model/runtime metrikákra. |
| `app/src/domain/governance/**` | DELETE | Ugyanez. |
| `app/src/harness/job-entrypoint.ts` | DELETE | |
| `app/src/harness/harness-mode.ts` | DELETE | |
| `app/src/harness/wiki-ticket-process.ts` | DELETE | |
| `app/src/harness/platform-mcp-bridge.ts` | REFERENCE ONLY | Registry projection ötlet; STDIO / kézi JSON-RPC / agent API key / legacy protocol **nem**. |

---

## 5. Connector lifecycle, sandbox, scheduling, playbook — DEFER / DELETE

| Path | Döntés | Új célhely | Megjegyzés |
|---|---|---|---|
| `app/src/domain/provisioning/provisioning-service.ts` | EXTRACT | connector CRUD | LLM assistant nélkül. |
| `app/src/domain/provisioning/connector-config.ts` | KEEP | — | |
| `app/src/domain/provisioning/draft-validator.ts` | EXTRACT | connector create validation | |
| `app/src/domain/provisioning/google-drive-draft-validator.ts` | KEEP | Drive pilot | |
| `app/src/domain/provisioning/gmail-draft-validator.ts` | DEFER | — | |
| `app/src/domain/provisioning/secret-alias.ts` | KEEP | — | |
| `app/src/domain/provisioning/connector-secret-alias-policy.ts` | KEEP | — | |
| `app/src/domain/provisioning/provisioning-assistant*.ts` | DELETE | harness draft import | |
| `app/src/domain/provisioning/openapi-config-extractor.ts` | DEFER | — | |
| `app/src/domain/provisioning/sandbox-connection-tester.ts` | DEFER | Managed Compute | |
| `app/src/domain/connector-template/**` | DEFER | — | CRUD sablon, ha a Drive seedhez kell: EXTRACT a seed JSON. |
| `app/src/domain/connector-self-update/**` | DEFER | — | |
| `app/src/repositories/postgres/connector-template-repository.ts` | DEFER | — | |
| `app/src/repositories/postgres/connector-draft-repository.ts` | DEFER | — | Draft UI; Drive pilot mehet canonical Connectorral. |
| `app/src/repositories/postgres/self-updating-connector-repository.ts` | DEFER | — | |
| `app/src/domain/code-sandbox/**` | DEFER | Managed Compute (G) | Ticket/conversation coupling DROP, ha előkerül. |
| `app/src/domain/sandbox/**` | DEFER / DELETE | — | App-builder/hosting: DELETE, hacsak nincs külön üzleti döntés. Artifact store: DEFER compute-hoz. |
| `app/src/domain/sandbox-versioning/**` | DEFER | — | |
| `app/src/domain/scheduled-task/**` | DEFER | Task Definition (H) | Nem ticket materializálás. |
| `app/src/domain/monitor/**` | DEFER | — | Nem MCP core. |
| `app/src/domain/playbook/**` | DELETE | — | Workflow engine nem első release. |
| `app/src/domain/step-template/**` | DELETE | — | |
| `app/src/domain/recipe/**` | DELETE | — | |
| `app/src/domain/work-project/**` | DELETE | — | Board/chat projekt. |
| `app/src/domain/platform-settings/**` | EXTRACT | platform settings | Model-provider/budget kulcsok DROP. Clerk/OAuth/Drive client settings KEEP. |

---

## 6. App routes, actions, API

A KEEP UI/route **nem** importálhat `@/domain` (fat root). Vagy `gateway-services`, vagy közvetlen KEEP modul.

| Path | Döntés | Megjegyzés |
|---|---|---|
| `app/src/app/api/mcp/**` | REWRITE (új) | Phase A. Egyetlen tenant-scoped resource URL. |
| `app/src/app/api/healthz/**`, `readyz/**`, `metrics/**` | KEEP | Ops. |
| `app/src/app/api/connectors/oauth/**` | KEEP | Downstream OAuth callback. Váltson gateway-services-re. |
| `app/src/app/api/agents/**` | EXTRACT | Rail/chat state: DELETE a chat részt; agent list API maradhat. |
| `app/src/app/api/v1/agent-chat/**` | DELETE | |
| `app/src/app/api/v1/conversations/**` | DELETE | |
| `app/src/app/api/v1/gateway/**` | DELETE | Model gateway HTTP. |
| `app/src/app/api/v1/harness/**` | DELETE | |
| `app/src/app/api/v1/internal/dispatch-cycle/**` | DELETE | |
| `app/src/app/api/v1/agent/tools/**` | DELETE | Machine API key tool surface. |
| `app/src/app/api/v1/agent/tickets/**` | DELETE | |
| `app/src/app/api/v1/tickets/**` | DELETE | |
| `app/src/app/api/v1/active-runs/**` | DELETE | |
| `app/src/app/api/v1/process-definitions/**` | DELETE | |
| `app/src/app/api/v1/agents/**` | EXTRACT | Suitable-for-chat: DELETE. Tiszta agent read: KEEP/EXTRACT. |
| `app/src/app/api/channels/**` | DELETE | |
| `app/src/app/api/sandbox-apps/**` | DEFER | |
| `app/src/app/actions/tenant.ts` | KEEP | gateway-services |
| `app/src/app/actions/tenant-language.ts` | KEEP | |
| `app/src/app/actions/skills.ts` | KEEP | |
| `app/src/app/actions/connector-grants.ts` | KEEP | |
| `app/src/app/actions/provisioning.ts` | EXTRACT | LLM assistant ág DELETE |
| `app/src/app/actions/platform.ts` | EXTRACT | Model/budget settings DROP |
| `app/src/app/actions/menu-access.ts` | KEEP | Nav policy |
| `app/src/app/actions/agent-access.ts` | EXTRACT | view/operate; canAddress DROP |
| `app/src/app/actions/agent-detail-page.ts` | EXTRACT | Chat/runtime panelek DROP |
| `app/src/app/actions/{channel*,chat-*,debug-log,efficiency-advisor,monitor,playbook,process,run-analysis,sandbox-versioning,self-updating-connectors,step-template,system-agents,web-search,work-projects,agent-model-config-update,agent-diagnostics,code-sandbox,embed-apps,privacy}.ts` | DELETE vagy DEFER | A fájlnév a legacy felelősség. Privacy admin: DEFER. |

---

## 7. Control Plane UI

**KEEP / egyszerűsödik** (chat/runtime panel nélkül):

| Path | Döntés |
|---|---|
| `app/src/app/control-plane/layout.tsx`, `control-plane-shell.tsx` | KEEP |
| `app/src/app/control-plane/page.tsx`, `control-plane/dashboard/**` | REWRITE — belépő oldal a KEEP levelekre (agents/connectors/skills/iam/audit); chat/board/ticket widget DELETE |
| `app/src/app/control-plane/iam/**` | KEEP |
| `app/src/app/control-plane/platform/tenants/**`, `platform/iam/**` | KEEP |
| `app/src/app/control-plane/platform/settings/**` | EXTRACT — model routing/budget UI DROP |
| `app/src/app/control-plane/agents/**` | EXTRACT — workspace chat tab DELETE; definition/skill/connector tab KEEP |
| `app/src/app/control-plane/skills/**` | KEEP |
| `app/src/app/control-plane/connectors/**` | KEEP (self-updating: DEFER) |
| `app/src/app/control-plane/provisioning/**` | EXTRACT — assistant LLM DROP, CRUD KEEP |
| `app/src/app/control-plane/audit/**` | KEEP |
| `app/src/app/control-plane/account/**` | KEEP — delegated OAuth kötés |
| `app/src/app/control-plane/agent-access/**` | EXTRACT — human view/operate; gráf/canAddress DROP |
| `app/src/app/control-plane/menu-access/**` | KEEP |
| `app/src/app/control-plane/behavior-profiles/**` | EXTRACT — definition behavior |
| `app/src/app/control-plane/pending/**` | REWRITE — később GatewayApproval queue; a mai ticket/chat pending DELETE |

**DELETE** (Phase 0 nav + route cut):

```text
control-plane/board
control-plane/tickets
control-plane/projects
control-plane/playbooks
control-plane/processes
control-plane/step-templates
control-plane/monitors
control-plane/training
control-plane/governance          # model eval / measurement
control-plane/system              # ha csak DB-mode / runtime worker; ops KEEP külön
control-plane/apps                # mini-app hosting
control-plane/sandbox-versions
control-plane/embed-apps
control-plane/scheduled-tasks     # DEFER, ne Core MVP nav
control-plane/platform/system-agents
app/src/app/sandbox/**
app/src/app/embed/**
app/src/components/chat/**
app/src/components/tickets/**
app/src/components/playbooks/**
app/src/components/processes/**
app/src/components/monitors/**
app/src/components/run-analysis/**
app/src/components/evals/**
app/src/components/active-runs/**
app/src/components/automation/**
app/src/components/workspace/**   # chat workspace
```

**DEFER UI:** `components/sandbox/**`, `components/scheduled-tasks/**`, Managed Compute settings.

`app/src/lib/control-plane-nav.ts` — REWRITE a katalógust a KEEP levelekre. Board/ticket/playbook/chat entries DELETE.

`app/src/components/{agents,connectors,iam,skills,tenant,account,ui,tool-capabilities}/**` — KEEP, chat-dock/runtime widget DROP.

---

## 8. Prisma

| Path | Döntés | Megjegyzés |
|---|---|---|
| `app/prisma/schema.prisma` | REWRITE | Phase B, **a cut után**. Új migration history. |
| `app/prisma/migrations/**` | DELETE | Történeti okból nem marad. |
| `app/prisma/seed.ts` | REWRITE | Minimális User/Tenant/Agent/Drive grant seed. |

**Target séma (Phase B, Core read path):**

```text
User, Tenant, TenantMembership, RolePermission, ResourceGrant
Agent, AgentDefinitionVersion
Skill, SkillVersion, AgentSkill
KnowledgeSource / KnowledgeArtifact, AgentKnowledgeSource   # csak ha knowledge_search tényleg kell
Connector, Capability, AgentConnector, ConnectorGrant
AuditEvent
```

**Phase E:** `GatewayOperation`, `GatewayApproval`  
**Nem kerül be:** Conversation, Message, AgentTurn, ModelCall, ModelBudget, ModelRoutingPolicy, ToolCall (runtime), Channel*, Ticket*, Playbook*, Process*, Memory*, Training*, Eval*, WriteGateToken, Sandbox*, ConsequenceApproval, AgentApiKey, ScheduledTask, Monitor*.

`Agent.modelConfig`, `Agent.memoryId`, `AgentVersion.modelConfigSnapshot`, `AgentAccessGrant.canAddress` — nem target mezők.

`app/src/lib/db.ts` — EXTRACT a Prisma kliens; a `DEV_REQUIRED_MODELS = conversation/message/workProject` stale-check **REWRITE**.

`app/src/lib/database-mode.ts` — DEFER/DELETE (prod/test DB toggle a legacy control plane-hez). Egy fejlesztői DB elég.

---

## 9. Lib — csoportosítás

KEEP: `api-response.ts`, `result.ts`, `safe-regex.ts`, `extract-json-object.ts`, `oauth-navigation.ts`, `platform-google-oauth-config.ts`, `seed-google-drive-connector.ts`, `connector-upsert.ts`, `nav-visibility.ts`, `public-app-url.ts`, `tenant-settings.ts`, `tenant-language.ts`, `tenant-operation-gate.ts`, `tenant-reachability.ts`.

EXTRACT: `agent-detail-*`, `agent-operator-visibility.ts`, `agent-knowledge-base.ts`, `agent-skill-management.ts`, `agent-delegated-connectors*.ts`, `tool-capability-catalog.ts`, `tool-ui-labels.ts` (csak áthozott toolok), `document-storage.ts` / `document-tenant-access.ts` ha knowledge file kell.

DELETE: `active-runs*`, `agent-chat-*`, `agent-turn-*`, `agent-rail-*`, `agent-workspace-*`, `agent-access-graph*`, `agent-activity.ts`, `agent-prompt.ts`, `agent-org-roster.ts`, `agent-api-tool-context.ts`, `agent-api-key-*`, `agent-interaction-ticket.ts`, `board-*`, `budget-*`, `channel-*`, `chat-*`, `dispatcher-*`, `ticket-*`, `wiki-*`, `resume-last-agent-conversation.ts`, `run-analysis-*`, `run-as-payload.ts`, `schedule-background.ts`, `task-only-ticket.ts`, `gateway-ticket-*`, `control-plane-embed*` (chat embed).

DEFER: `sandbox-*`, `code-sandbox` actions, `tulajdoni-*`, office/xlsx helpers ha nem Drive read.

---

## 10. Repositories barrel

| Path | Döntés |
|---|---|
| `app/src/repositories/postgres/index.ts` | REWRITE — csak KEEP repo-k. A fat barrel húzza a DELETE modelleket. |
| `app/src/repositories/interfaces/**` | EXTRACT — vágd a Conversation/AgentTurn/Ticket interface-eket. |
| `app/src/repositories/postgres/{agent-turn,channel,conversation,ticket,training,memory,playbook*,process*,sandbox*,scheduled-task,monitor,work-project,recipe,user-notification}-repository.ts` | DELETE |
| `app/src/repositories/order-by-ids.ts` | KEEP |

---

## 11. Scripts, package.json, infra, tesztek

| Path | Döntés |
|---|---|
| `app/scripts/**` chat/runtime/model/dispatcher/harness/channel/playbook tesztek | DELETE |
| `app/scripts/*backfill*` | DELETE | Legacy adat. Új DB, nincs mit backfilleni. |
| `app/scripts/chatgpt-oauth-*`, `claude-code-oauth-bridge.test.ts` | DELETE | Provider bridge. Az MCP OAuth az IdP resource-server, nem model OAuth. |
| `app/package.json` scripts `harness:*`, `dispatcher:*`, `dispatch-cycle:*`, `s2:*`, `code-sandbox:*`, `sync:model-pricing` | DELETE |
| `app/package.json` deps `@clerk/nextjs`, `@prisma/client`, `next`, `react`, `zod`, `pg`, `next-intl` | KEEP |
| `@google/genai` | DELETE | Model provider. |
| `@xyflow/react` | DELETE | Flow builder. |
| `docx`, `exceljs`, `mammoth`, `pdf-*`, `pptxgenjs` | DEFER | Drive read PDF/texthez később EXTRACT a minimális parser. |
| `aho-corasick`, `bcryptjs`, `js-yaml`, markdown stack | KEEP ha skill/privacy/parser használja; különben Phase F prune. |
| `infra/gcp/deploy-harness-*.sh`, `deploy-dispatcher-*.sh`, `deploy-dispatch-cycle-*.sh` | DELETE |
| `infra/gcp/deploy-code-sandbox-service.sh` | DEFER | Phase G |
| Root `DEPLOY.md`, `apphosting.yaml` | KEEP | Control plane host. Harness job config DROP. |

Új teszt: csak az új termék. Legacy runtime teszt megőrzése nem cél. Phase 0: egy import-boundary guard (30–50 sor, `no-restricted-imports` vagy kis architecture test) a `gateway-services` / `mcp` / `agent-definition` / `enterprise-tools` rétegekre.

---

## 12. Docs és egyéb repo-gyökér

| Path | Döntés |
|---|---|
| `docs/rebuild-surgery-manifest.md` | KEEP | Ez a fájl — a részletes ledger. |
| `docs/architecture.md` | REWRITE (új, Phase 0) | Az issue #8 „short architecture note" deliverable-je: ~1 oldal — belépési pontok, `legacy/` szabály, import-boundary, link ide. Nem duplikálja a ledgert. |
| `CONTEXT.md` | REWRITE később | A glossary még a chat/tanítás nyelv. Phase 0-ban ne blokkoljon. |
| `docs/specs/**`, `docs/AI-Agent-Platform-*` | REFERENCE ONLY | Historikus. Nem implementációs szerződés. |
| `README.md` | REWRITE | Control Plane + MCP Gateway; chat/dispatcher mondatok ki. |
| `DOCS.md` | DELETE vagy archív | A legacy architecture leírása. |

---

## Szándékosan bent maradó legacy utility-k

A target graph **KEEP** listája. Mindegyiknek van célállapotú oka; a frissesség önmagában nem indok.

| Utility | Miért marad |
|---|---|
| Clerk auth adapter + user sync | MCP resource server IdP-je; login/tokenkiadás nem a platformé. |
| `iam-policy` / `tenant-policy` / `IamService` / `TenantService` | Minden toolhívás membership ∩ RBAC metszete. |
| Connector secret store + grant vault + delegated OAuth | Credential nem kerül a harnesshez. |
| Google Drive API client + scopes + grant metadata | Core MVP vertical slice. |
| Canonical connector config + HTTP client | Szerveroldali execution. |
| `domain/net/egress-guard.ts` | SSRF/allowlist a connector hívásokon. |
| Audit append + hash-chain crypto | Gateway audit. |
| Skill parser/validator/hash | Agent Definition skill references + későbbi MCP Resources. |
| Prisma/Postgres + `lib/db.ts` (stale-check nélkül) | Technológiai shell. |
| Control Plane IAM/Agents/Skills/Connectors/Audit UI shell | Admin a termék magja. |

Ezek **nem** részei a target graphnak akkor sem, ha a fájl még a fában van: ToolBrokerService, ConsequenceApprovalService, platform-mcp-bridge, ModelGateway, bármely `*Runtime`, dispatcher, ConversationService.

---

## Phase 0 cut set — ezt kell kivenni az aktív typecheckből

Kötelező `git mv` `legacy/` alá Commit 1-ben (nem `tsconfig exclude` — lásd fent):

```text
app/src/domain/index.ts                    # replace gateway-services.ts-szel
app/src/domain/agent/**                    # kivéve prompt-assembler.ts, amíg EXTRACT másolat nincs
app/src/domain/agents/run-analyst-role.ts
app/src/domain/agent-access/{run-analyst-*,web-egress-materialization,addressable-colleagues,agent-graph-node-select}.ts
app/src/domain/skill/{skill-review-agent,skill-distiller-agent}.ts
app/src/domain/provisioning/provisioning-assistant*.ts
app/src/domain/dispatcher/**               # kivéve cloud-run-auth.ts → EXTRACT domain/net/
app/src/domain/gateway/**                  # Model Gateway; nem keverendő gateway-services.ts-szel
app/src/domain/dispatcher/**
app/src/domain/conversation/**
app/src/domain/channel/**
app/src/domain/ticket/**
app/src/domain/memory/**
app/src/domain/training/**
app/src/domain/eval/**
app/src/domain/run-analysis/**
app/src/domain/file-editor/**
app/src/domain/contract-runtime/**
app/src/domain/writegate/**
app/src/domain/debug-log/**
app/src/domain/web-search/**
app/src/domain/web-fetch/**
app/src/domain/web-research/**
app/src/domain/agent-diagnostics/**
app/src/domain/playbook/**
app/src/domain/step-template/**
app/src/domain/recipe/**
app/src/domain/work-project/**
app/src/domain/monitor/**
app/src/domain/sandbox/**
app/src/domain/sandbox-versioning/**
app/src/domain/code-sandbox/**
app/src/domain/scheduled-task/**
app/src/domain/connector-self-update/**
app/src/harness/**
app/src/app/api/v1/agent-chat/**
app/src/app/api/v1/conversations/**
app/src/app/api/v1/gateway/**
app/src/app/api/v1/harness/**
app/src/app/api/v1/internal/**
app/src/app/api/v1/agent/**
app/src/app/api/v1/tickets/**
app/src/app/api/v1/active-runs/**
app/src/app/api/v1/process-definitions/**
app/src/app/api/channels/**
app/src/app/sandbox/**
app/src/app/embed/**
app/src/components/chat/**
```

EXTRACT másolat **előbb** (vagy a fájl marad az exclude-on kívül):

```text
app/src/domain/agent/prompt-assembler.ts
app/src/domain/tool-broker/tool-broker-authorizer.ts
app/src/domain/tool-broker/tool-registry.ts          # REFERENCE, olvasható
app/src/domain/tool-broker/handlers/google-drive.handler.ts
app/src/domain/tool-broker/consequence-gate-policy.ts
app/src/domain/tool-broker/tool-output-privacy.ts
```

A `tool-broker/` fa **nem maradhat** az `app/` alatt: 20+ importja mutat a cut setbe (web-search, code-sandbox, ticket, memory, sandbox-versioning). Költözik `legacy/domain/tool-broker/`-ba mint REFERENCE/EXTRACT forrás.

Phase 0 KEEP no longer imports the later-phase EXTRACT list (prompt-assembler, authorizer, registry, Drive handler, consequence-gate, output-privacy). Those stay in `legacy/domain/` until Phase B/C/E. The KEEP slivers that still had callers were extracted to `domain/connector-grant/tool-connector-requirements.ts` and Docs/Slides op types on `google-workspace-api-client.ts`. Self-updating pin logic is DEFER: KEEP uses `domain/connector/runtime-config.ts` (fail-closed).

---

## Import-boundary guard

Bukjon a CI, ha ezek a könyvtárak / fájlok bármit importálnak a tiltott listából:

```text
app/src/domain/gateway-services.ts
app/src/domain/agent-definition/**
app/src/domain/enterprise-tools/**
app/src/auth/mcp-principal.ts
app/src/app/api/mcp/**
```

Tiltott import-minták (minimum):

```text
@/domain$
@/domain/index
@/domain/agent/
@/domain/gateway/
@/domain/dispatcher
@/domain/conversation
@/domain/channel
AgentChatRuntime
ChatTurnLauncher
ModelGateway
WikiAgentRuntime
GeneralTaskRuntime
BookkeeperAgentRuntime
ConversationService
```

Ne vezess be nagy architecture-lint frameworköt.

---

## Architecture invariants (minden későbbi PR)

- A target graph nem importálja a régi `@/domain` `services` objektumot.
- A platform nem hív modellt agent executionhöz, és nem tárol Conversation/AgentTurn state-et MCP-hez.
- Nincs szerveroldali selected-tenant / selected-agent session. Tenant = `/api/mcp/{tenantSlug}` + membership check.
- `userId` / `tenantId` nem jöhet tool JSON-ból.
- `tools/list` nem security boundary; minden `tools/call` `authorizeToolCall`-on megy.
- Credential és downstream refresh token nem kerül harnesshez.
- MCP transport = hivatalos SDK v2; nincs saját JSON-RPC parser.
- A target Prisma schema nem tart fenn legacy runtime mezőt azért, hogy régi kód forduljon.

---

## Phase 0 done

Akkor kész a Phase 0, ha:

1. Ez a manifest a baseline HEAD-re igaz (eltérés → javítsd a sort, ne a kódot „ideiglenesen”).
2. `gateway-services.ts` létezik, és nem importálja a tiltott runtime grapht.
3. A DELETE/REFERENCE cut set kint van az aktív typecheckből.
4. A KEEP UI/route nem a fat `@/domain` barrelön keresztül fordul.
5. `npm install` + typecheck/build zöld a cut után, **még a target Prisma schema nélkül**.
6. Az import-boundary guard piros, ha valaki visszavezeti a ModelGateway/AgentChatRuntime/dispatcher importot.
7. **Fut** (issue #8: „compiles and runs the new skeleton"): `npm run dev` elindul, `GET /api/healthz` 200, Clerk/dev login után a Control Plane IAM és Agents oldal betölt a legacy DB-n.
8. A 6 célhatár (`gateway-services.ts`, `auth/mcp-principal.ts`, `api/mcp/[tenantSlug]/`, `domain/agent-definition/`, `domain/enterprise-tools/`, `domain/gateway-operation/`) létezik a forrásfában placeholder `index.ts`-szel.
9. `docs/architecture.md` megvan (rövid note: belépési pontok + `legacy/` szabály + izolációs döntések, link erre a manifestre).

Phase A (#9) csak ezután indul.
