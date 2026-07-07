# Enterprise code review log

## 2026-07-07 - Kriptográfiai bizalmi határ: aláíró/titkosító titkok fail-closed feloldása

- Reviewed modules:
  - `app/src/lib/crypto/hash-chain.ts` (audit-hash + write-gate token HMAC + write-gate szignatúra verify)
  - `app/src/domain/audit/audit-chain-service.ts` (`verifyChain` teljes/szegmens, `exportJsonLines`)
  - `app/src/repositories/postgres/audit-repository.ts` (`append` — az egyetlen audit belépési pont, advisory-lock + INSERT-előtti hash)
  - `app/src/domain/writegate/write-gate-service.ts` (issue/consume token-életciklus)
  - `app/src/lib/crypto/oauth-state.ts` (OAuth-state HMAC + AES-256-GCM, PKCE code_verifier védelem)
  - `app/src/domain/sandbox/preview-token.ts` (cookieless, tenant-kötött sandbox preview token HMAC)
- Result:
  - Az audit/write-gate/oauth/preview kriptográfiai törzs alapvetően helyes: egyetlen
    append belépési pont advisory-lock alatt, INSERT-előtti hash (append-only DB-triggerrel),
    konstans-idejű aláírás-összehasonlítás, authentikált (AES-256-GCM) OAuth-state, TTL +
    tartalom-hash-kötés a write-gate tokeneknél, session-mentes tenant-kötött preview token.
  - Talált egy **fail-open** biztonsági rést: HÁROM aláíró/titkosító titok
    (`WRITE_GATE_SECRET`, `OAUTH_STATE_SECRET`, `SANDBOX_PREVIEW_SECRET`) egy beégetett
    fejlesztői alapértékre esett vissza (`... ?? 'dev-...-change-in-prod'`). Ha egy éles
    környezetben bármelyik env-változó hiányzott (új környezet, elfelejtett secret,
    félrekonfiguráció), a rendszer NEM állt le — némán egy forráskódban publikált, mindenki
    által ismert kulccsal írt alá és titkosított. Következmény éles környezetben, hiányzó
    titok esetén: (a) write-gate jóváhagyás hamisítható (agent öntanulás/memória-írás kapu),
    (b) OAuth-state hamisítható ÉS a PKCE code_verifier visszafejthető (CSRF / fiók-összekötés),
    (c) bármely tenant sandbox-preview tokenje hamisítható → cross-tenant artefakt-hozzáférés.
    Súlyosbító: mindhárom a `WRITE_GATE_SECRET`-re is fallbackol, így egyetlen hiányzó
    változó kaszkádol.
- Fix applied:
  - Új központi, LUSTA, fail-closed feloldó: `app/src/lib/crypto/secret-config.ts`
    (`resolveSigningSecret`). `NODE_ENV=production` alatt valós, konfigurált titok nélkül
    (üres VAGY `change-in-prod` placeholder) DOB — nem esik vissza a beégetett kulcsra.
    Fejlesztésben/tesztben a determinisztikus dev-default marad. A feloldás a signing/verify
    hívás idején fut (nem modul-betöltéskor), így a production build nem dől el build-időben
    hiányzó titok miatt.
  - `hash-chain.ts`, `oauth-state.ts`, `preview-token.ts` mind a központi feloldón át kéri a
    titkát (a korábbi env-fallback prioritás megtartva: elsődleges → megosztott → dev-default).
  - Új determinisztikus teszt: `scripts/secret-config.test.ts` (`test:secret-config`, 9 eset:
    dev-default, valós titok, production fail-closed, placeholder-marker deny, fallback-prioritás,
    write-gate integráció). A `test:sandbox-app` (preview-token út) zöld; a módosított fájlok
    tsc/eslint tiszták (az egyetlen tsc-hiba a `playbook-v2-core.test.ts` már main-en meglévő
    regex-flag ügye, nem érintett fájl).
- Business impact:
  - Megszünteti azt a kockázatot, hogy egy éles környezet félrekonfigurációja (hiányzó
    titok-env) némán, ismert kulccsal működjön tovább. Éles alatt a rendszer inkább leáll a
    kockázatos műveletnél, minthogy hamisítható/visszafejthető kriptográfiával fusson.
  - Enterprise-elvárás: a titkok kezelése fail-closed, a bizonytalanság nem old fel jogosultságot.
- Decisions raised (not auto-fixed; lásd `docs/code-review/2026-07-07-crypto-secret-audit-decisions.md`):
  - D1 — Az audit hash-lánc nem fedi le a `policyDecision` / `metadata` / `modelUsed` /
    `inputRef` / `outputRef` / `agentVersion` mezőket, így ezek utólag módosíthatók a lánc
    törése nélkül. A javítás visszafelé nem kompatibilis (láncszakadás), verziózott hash-t
    (`hashVersion` oszlop + sor-szintű képletválasztás) igényel → séma/termék-döntés.

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
