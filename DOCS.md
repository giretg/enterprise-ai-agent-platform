# Enterprise AI Agent Platform — Szoftver Dokumentáció

**Verzió:** 1.0
**Utolsó frissítés:** 2026-06-20
**Projekt:** Excellence Pay KFT — Kontrollált Enterprise AI Agent Platform
**Stack:** Next.js 16 · React 19 · TypeScript · PostgreSQL (Prisma) · Clerk · GCP

---

## Tartalomjegyzék

1. [Projekt áttekintés](#1-projekt-áttekintés)
2. [Architektúra](#2-architektúra)
3. [Könyvtárstruktúra](#3-könyvtárstruktúra)
4. [Domain réteg](#4-domain-réteg)
5. [Repository réteg](#5-repository-réteg)
6. [API végpontok](#6-api-végpontok)
7. [Autentikáció és jogosultságkezelés](#7-autentikáció-és-jogosultságkezelés)
8. [Model Gateway](#8-model-gateway)
9. [Tool Broker](#9-tool-broker)
10. [Dispatcher és Harness](#10-dispatcher-és-harness)
11. [Ticket rendszer és állapotgép](#11-ticket-rendszer-és-állapotgép)
12. [Audit lánc](#12-audit-lánc)
13. [Connector és OAuth grant rendszer](#13-connector-és-oauth-grant-rendszer)
14. [Scheduled Tasks](#14-scheduled-tasks)
15. [Sandbox alkalmazások](#15-sandbox-alkalmazások)
16. [Frontend — Control Plane UI](#16-frontend--control-plane-ui)
17. [Környezeti változók](#17-környezeti-változók)
18. [Adatbázis séma (Prisma)](#18-adatbázis-séma-prisma)
19. [Deploy útmutató](#19-deploy-útmutató)
20. [Fejlesztői útmutató](#20-fejlesztői-útmutató)

---

## 1. Projekt áttekintés

Az Enterprise AI Agent Platform egy **kontrollált, auditálható AI agent infrastruktúra** vállalati környezethez. Nem egyszerű chatbot-wrapper: a platform az agentek teljes életciklusát — konfigurálástól a futtatáson át az auditálásig — egységes governance keretbe fogja.

### Fő értékállítás

Az AI agentek a legtöbb vállalatnál azért nem enterprise-ready-k, mert hiányzik a **bizalom, az audit, a jogosultságkezelés és a megfelelőség** infrastruktúrája. Ez a platform pontosan erre ad választ:

- Minden agent-művelet attribútálható és naplózott
- Az agentek nem módosulnak kontroll nélkül (write-gate + self-evolution profil)
- A hozzáférés finom granularitással menedzselt (agent- és ember-szinten)
- Magas kockázatú döntések emberi jóváhagyást igényelnek (human-in-the-loop)

### Három fő komponens

| Komponens | Leírás | Technológia |
|---|---|---|
| **Control Plane** | Governance, audit, IAM, ticket board, dispatcher, Model Gateway, Tool Broker | Next.js App Router (szerver) |
| **Sandbox / Execution Plane** | Ügyfél-specifikus munkatér, wiki agent, A0 HTML riport preview/export | Next.js App Router (UI) |
| **Harness** | Agent-futtató motor; lokálisan in-process, prodban Cloud Run Job | TypeScript process / Docker / GCP Cloud Run |

---

## 2. Architektúra

```
            ┌─────────────────────────────────────────────────────┐
            │  CONTROL PLANE (Next.js szerver)                     │
            │  ├── IAM (Clerk + RBAC)                              │
            │  ├── Ticket állapotgép + Dispatcher                  │
            │  ├── Model Gateway  ──► LLM API-k                    │
            │  └── Tool Broker    ──► Connectors / GCS / Gmail     │
            └───────┬─────────────────────────────────────────────┘
                    │ dispatch (ticketId + lockToken)
                    ▼
            ┌───────────────────────┐
            │  HARNESS              │
            │  (lokál: in-process)  │  ── Model Gateway ──► LLM
            │  (prod: Cloud Run Job)│  ── Tool Broker   ──► eszközök
            └───────────────────────┘
                    │ eredmény
                    ▼
            ┌───────────────────────────────────────┐
            │  SANDBOX / EXECUTION PLANE            │
            │  Wiki agent, ticket board, A0 riport  │
            └───────────────────────────────────────┘
```

### Kommunikációs elvek

1. **Deny-by-default egress**: a harness konténere csak a Model Gateway-re és a Tool Broker-re mehet ki — minden egyéb hálózati forgalom tiltott.
2. **Kétszintű átjáró**: minden modellhívás a `ModelGateway`-en, minden eszközhívás a `ToolBrokerService`-en megy át; mindkettő naplóz.
3. **Szerver-oldali kényszer**: a jóváhagyási kapuk és capability-ellenőrzések kizárólag szerveroldalon futnak, az agent nem kerülheti meg őket.

---

## 3. Könyvtárstruktúra

```
enterprise-ai-agent-platform/
├── app/                          # Next.js alkalmazás gyökere
│   ├── src/
│   │   ├── app/                  # Next.js App Router
│   │   │   ├── api/              # REST API route handler-ek
│   │   │   │   ├── v1/agent/     # Agent API (ticket CRUD, tool hívások)
│   │   │   │   ├── v1/harness/   # Harness callback végpontok
│   │   │   │   ├── v1/gateway/   # OpenAI-kompatibilis Gateway proxy
│   │   │   │   ├── connectors/   # OAuth callback
│   │   │   │   ├── sandbox-apps/ # App preview/export
│   │   │   │   └── webhooks/     # Clerk user webhook
│   │   │   ├── control-plane/    # Admin UI (agents, board, audit, stb.)
│   │   │   └── sandbox/          # Sandbox UI (wiki chat, proposals)
│   │   ├── domain/               # Üzleti logika (services)
│   │   │   ├── agent/            # AgentChatRuntime, WikiRuntime, stb.
│   │   │   ├── audit/            # AuditChainService (hash-lánc)
│   │   │   ├── connector-grant/  # Per-user OAuth grant kezelés
│   │   │   ├── dispatcher/       # DispatcherService + HarnessLauncher-ek
│   │   │   ├── eval/             # EvalService (write-gate értékelés)
│   │   │   ├── file-editor/      # Fájl workspace (GCS + DOCX/XLSX/PDF)
│   │   │   ├── gateway/          # ModelGateway + provider bridge-ek
│   │   │   ├── governance/       # Mérési riport
│   │   │   ├── iam/              # IamService (meghívó + offboarding)
│   │   │   ├── knowledge-base/   # KnowledgeBaseService
│   │   │   ├── platform-settings/# PlatformSettingsService
│   │   │   ├── playbook/         # PlaybookService (verziózott folyamatok)
│   │   │   ├── recipe/           # RecipeService (Goose recipe-k)
│   │   │   ├── sandbox/          # SandboxAppService (A0 HTML app-ok)
│   │   │   ├── scheduled-task/   # ScheduledTaskService
│   │   │   ├── ticket/           # TicketService + állapotgép
│   │   │   ├── tool-broker/      # ToolBrokerService + AllowlistAuthorizer
│   │   │   ├── training/         # TrainingService + SelfEvolutionGuard
│   │   │   ├── writegate/        # WriteGateService (egyszer-használatos token)
│   │   │   └── index.ts          # Dependency injection (services singleton)
│   │   ├── repositories/
│   │   │   ├── interfaces/       # TypeScript interface-ek (repository contract)
│   │   │   └── postgres/         # Prisma implementációk
│   │   ├── auth/                 # AuthProvider absztrakció (Clerk / dev)
│   │   ├── components/           # React UI komponensek
│   │   ├── harness/              # Harness belépőpont + Goose integráció
│   │   └── lib/                  # Shared utilities, típusok, config
│   ├── prisma/
│   │   ├── schema.prisma         # Adatbázis séma
│   │   └── seed.ts               # Demo seed adat
│   ├── infra/gcp/                # GCP deploy scriptek + setup dokumentáció
│   └── scripts/                  # Dev / ops segédscriptek
├── AI-Agent-Platform-Koncepcio.md  # Teljes architekturális koncepció
├── AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md  # Historikus v1 fejlesztési spec
├── DEPLOY.md                       # Production deploy útmutató
└── DOCS.md                         # Ez a dokumentum
```

---

## 4. Domain réteg

A `src/domain/` az alkalmazás üzleti magjа. Az összes service a `src/domain/index.ts`-ben van összekötve dependency injection (kézi DI, nem framework) segítségével, és `services` singleton-ként exportálva.

### 4.1 TicketService

**Fájl:** `src/domain/ticket/ticket-service.ts`

A ticket az aszinkron munka alapegysége. A `TicketService` kezeli:

- Ticket létrehozását típussal, payload-dal és assignee-vel
- Szerveroldali állapotátmeneteket (állapotgép — lásd §11)
- Playbook-referencia rögzítését (audit-pinning)
- Az agent szerepének (`worker` | `orchestrator`) feloldását

**Fontosabb metódusok:**

```typescript
createTicket(input): Promise<Ticket>
transitionTicket(ticketId, toState, actor, comment?): Promise<Ticket>
getTicketById(id): Promise<Ticket | null>
```

### 4.2 AgentChatRuntime

**Fájl:** `src/domain/agent/agent-chat-runtime.ts`

Interaktív (szinkron) chat végrehajtás — a felhasználó kérdez, az agent az aktuális conversation thread alapján válaszol. Belső chat-tool-loop-ot használ, amelyben az agent tool-hívásokat tehet a `ToolBrokerService`-en keresztül.

### 4.3 WikiAgentRuntime

**Fájl:** `src/domain/agent/wiki-runtime.ts`

A tudásbázis-kereső agent runtime-ja. Ticket alapján dolgozik: beolvassa a kérdést a ticket payload-jából, keresést végez a knowledge base-ben, majd citált választ ír vissza. Playbook-vezérelt végrehajtást támogat.

### 4.4 GeneralTaskRuntime

**Fájl:** `src/domain/agent/general-task-runtime.ts`

Általános célú, async ticket-feldolgozó agent. A harness (`local-wiki` módban) az erre a runtime-ra irányítja azokat a ticketeket, amelyek nem wiki-típusúak (`resolveTicketProcessRoute`).

### 4.5 BookkeeperAgentRuntime

**Fájl:** `src/domain/agent/bookkeeper-runtime.ts`

Számlafeldolgozó és könyvelési egyeztetési agent. Dokumentumok szövegét olvassa be, és a `ModelGateway`-en keresztül elemzést végez.

### 4.6 ModelGateway

**Fájl:** `src/domain/gateway/model-gateway.ts`

Minden LLM-hívás egyetlen ponton megy át. Felelőssége:

- **Provider routing**: `chatgpt-oauth`, `gemini`, `ollama`, `openrouter`
- **Per-ticket guardrail**: `GATEWAY_MAX_CALLS_PER_TICKET` (alapértelmezés: 30) — egy elszabaduló loop nem fogyaszthatja el a napi budgetet
- **Prompt-cache határ**: a prompt-assembler által megjelölt stabil prefix végére a Gateway `cache_control` breakpointot tesz azoknál a providereknél, amelyek explicit cache-API-t várnak (OpenRouter → Anthropic modellek). A többinél az automatikus prefix-cache él, ott a jelölés no-op. Ld. `docs/specs/AI-Agent-Platform-Feature-Spec-Prompt-Cache-Control-Breakpoints.md`
- **Teljes naplózás**: minden hívás `ModelCall` rekordot kap (provider, model, tokens, cost, latency, status)
- **Hibaosztályozás**: `rate_limited` vs. `error` állapot automatikusan felismert

**Támogatott providerek:**

| Provider | Konfig | Megjegyzés |
|---|---|---|
| `chatgpt-oauth` | Szerver-oldali ChatGPT OAuth bridge | Alapértelmezett (gpt-5.5) |
| `gemini` | `GEMINI_API_KEY` | Google AI Studio; ajánlott modellek: Gemini 3.5 Flash, 2.5 Pro |
| `ollama` | `OLLAMA_BASE_URL` | Helyi Gemma (Goose GGUF import) |
| `openrouter` | `OPENROUTER_API_KEY` | Kísérleti; adminból allowlist szükséges |

### 4.7 ToolBrokerService

**Fájl:** `src/domain/tool-broker/tool-broker-service.ts`

Minden eszközhívás (fájl, web, DB, connector, board-írás, delegálás) ezen a ponton megy át. Felelőssége:

- **Capability-ellenőrzés**: az `AllowlistAuthorizer` per-agent/tool engedélyt ellenőriz — alapból minden tiltott
- **Secret-injektálás**: a connector titkokat nem adja át az agentnek, csak maga használja fel
- **Per-user grant feloldás**: `(acting_user, connector)` alapján oldja fel a per-user OAuth grant-et
- **Audit naplózás**: minden `ToolCall` rekordot kap (allowed/denied/error)

**Elérhető eszközök az agentnek (MCP-kompatibilis nevek):**

| Tool | Leírás |
|---|---|
| `kb_search` | Tudásbázis (dokumentum) keresés |
| `board_write` | Ticket state/payload frissítés |
| `delegate` | Delegálás másik agentnek (új ticket) |
| `file_read` / `file_write` / `file_edit` | Workspace fájlkezelés (GCS) |
| `file_list` / `file_glob` / `file_search` | Workspace fájl listázás |
| `file_delete` | Workspace fájl törlés |
| `xlsx_read_sheet` / `xlsx_write_cells` / `xlsx_append_rows` | Excel kezelés |
| `xlsx_format_range` / `xlsx_get_layout` / `xlsx_create` | Excel formázás/létrehozás |
| `docx_read` | Word dokumentum olvasás |
| `pdf_read` | PDF olvasás |
| `gmail_*` | Gmail műveletek (per-user OAuth grant alapján) |
| `agent_catalog_search` | Elérhető agentek keresése delegáláshoz |

### 4.8 DispatcherService

**Fájl:** `src/domain/dispatcher/dispatcher-service.ts`

A ticket-alapú aszinkron végrehajtás ütemezője. Felelőssége:

- **Dispatch loop**: `READY` állapotú ticketek lekérdezése és harnessbe küldése
- **Budget-kontroll**: napi `DISPATCH_MAX_CALLS_PER_DAY` és `DISPATCH_MAX_TOKENS_PER_DAY` korlátok ellenőrzése
- **Dispatch lock**: optimistic locking (UUID `lockToken`) — az in-flight ticketek nem kerülnek kétszer futásba
- **Kill-switch**: `PlatformSettingsService.isDispatchEnabled()` — Admin UI-ból leállítható

**HarnessLauncher módok:**

| Mód | Leírás | Env |
|---|---|---|
| `local-wiki` | In-process, `WikiRuntime` / `GeneralTaskRuntime` | Alapértelmezett fejlesztésben |
| `docker-local` | Lokális Docker konténer | `HARNESS_LAUNCHER_MODE=docker-local` |
| `cloud-run-job` | GCP Cloud Run Job | `HARNESS_LAUNCHER_MODE=cloud-run-job` |

### 4.9 TrainingService + SelfEvolutionGuard

**Fájlok:** `src/domain/training/training-service.ts`, `src/domain/training/self-evolution-guard.ts`

Az agent tudásfrissítés kizárólag ezen a kétlépéses folyamaton keresztül történhet:

1. **WriteGateService** kiad egy egyszer-használatos `write_gate_token`-t (HMAC-signed)
2. **EvalService** értékeli a javasolt változtatást
3. **SelfEvolutionGuard** ellenőrzi, hogy az agent nem bővíti-e saját jogosultságait (kemény tiltás)
4. **Audit** minden lépést naplóz

A `self_evolution_profile` per-agent JSON blob konfigurálja a kapu erősségét (scope, jóváhagyási mód).

### 4.10 AuditChainService

**Fájl:** `src/domain/audit/audit-chain-service.ts`

Kriptográfiai hash-lánc az audit log sértetlenségének garantálásához. Minden `AuditLog` rekordhoz:

- `hash`: SHA-256(`prevHash || seq || action || actor || payload`)
- `prevHash`: az előző rekord hash-e (lánc)
- `seq`: monoton növekvő sorszám

A lánc a Control Plane UI „Audit" oldalán verifikálható.

### 4.11 ConnectorGrantService

**Fájl:** `src/domain/connector-grant/connector-grant-service.ts`

Per-user OAuth delegálási modell. Egy connector `auth_mode` szerint lehet:

- `service`: rendszerszintű, közös kulcs (pl. ERP service account)
- `user_delegated`: a belépett user saját fiókja (pl. Gmail)
- `agent_owned`: agent-specifikus kulcs

A `connector_grants` tábla `(tenantId, userId, connectorId)` egyedi kulccsal tárolja a tokeneket — soha nem plaintext, mindig alias-on keresztül (GCS Secret).

### 4.12 PlaybookService

**Fájl:** `src/domain/playbook/playbook-service.ts`

Verziózott, gépiesen olvasható folyamat-dokumentumok. A Playbook:

- Folyamat-/tickettípushoz rendelhető
- Verziópinnning: a ticketen rögzítve, hogy melyik verzió alapján futott
- Az állapotgép átmeneteit / jóváhagyási kapuit a Playbook spec határozza meg

### 4.13 PlatformSettingsService

**Fájl:** `src/domain/platform-settings/platform-settings-service.ts`

Key-value store a platform szintű beállításokhoz (pl. `dispatch_enabled`, `db_branch`, `ticket_type_config`). Minden `set()` auditált.

### 4.14 ConversationService

**Fájl:** `src/domain/conversation/conversation-service.ts`

Tenant-izolált, GDPR-törölhető conversation thread kezelés. A conversation a ticket mellett first-class entitás: saját tároló, retenció-policy és kontextus-rehydration.

---

## 5. Repository réteg

**Interfészek:** `src/repositories/interfaces/index.ts`
**Implementációk:** `src/repositories/postgres/`

Minden domain service repository interface-en keresztül kommunikál az adatbázissal — nem közvetlenül a Prisma klienssel. Ez lehetővé teszi a tesztelhetőséget és a jövőbeli storage csere-pontot.

### Főbb repository-k

| Interface | Tábla(k) | Kulcs funkciók |
|---|---|---|
| `TicketRepository` | `tickets`, `ticket_transitions` | findReadyForDispatch, acquireDispatchLock |
| `AgentRepository` | `agents`, `agent_versions` | findVersionSnapshot, authenticateApiKey |
| `AuditRepository` | `audit_logs` | append (hash-lánc), getActionCounts |
| `ModelCallRepository` | `model_calls` | getGovernanceSummary, getPerTicketBreakdown |
| `ToolBrokerRepository` | `tool_calls`, `connectors` | findCapability, getToolSummary |
| `ConnectorGrantRepository` | `connector_grants` | findActiveGrant, revokeAllForUser |
| `ConversationRepository` | `conversations`, `messages` | appendMessage, findMessages |
| `PlaybookRepository` | `playbooks`, `playbook_versions` | getActiveVersionByName |
| `ScheduledTaskRepository` | `scheduled_tasks` | findDue, claimDue, markMaterialized |
| `SandboxAppRepository` | `sandbox_apps`, `sandbox_app_versions` | createFromTicket, addVersion |

---

## 6. API végpontok

### Agent API — `/api/v1/agent/`

Az agent API kulcsos hitelesítést használ (`Authorization: Bearer <agent-api-key>`).

| Metódus | Útvonal | Leírás |
|---|---|---|
| `GET` | `/api/v1/agent/tickets` | Ticketek lekérdezése (filter: state, type) |
| `POST` | `/api/v1/agent/tickets` | Új ticket létrehozása |
| `GET` | `/api/v1/agent/tickets/[id]` | Ticket részletek |
| `PATCH` | `/api/v1/agent/tickets/[id]` | Ticket frissítése (state, payload) |
| `GET` | `/api/v1/agent/tools` | Elérhető tool-ok lekérdezése |

### Harness API — `/api/v1/harness/`

A harness (Cloud Run Job) callback végpontjai — Clerk auth **nélkül**, de agent API kulccsal védve.

| Metódus | Útvonal | Leírás |
|---|---|---|
| `POST` | `/api/v1/harness/tickets/[id]/process` | Ticket feldolgozás indítása |
| `POST` | `/api/v1/harness/tickets/[id]/complete` | Ticket lezárása, lock feloldása |

### Model Gateway Proxy — `/api/v1/gateway/`

OpenAI-kompatibilis chat completions endpoint — a Goose harness ezt hívja modell-providerként.

| Metódus | Útvonal | Leírás |
|---|---|---|
| `POST` | `/api/v1/gateway/v1/chat/completions` | Chat completion (provider routing a szerveren) |

### Connector OAuth — `/api/connectors/oauth/callback`

Per-user connector OAuth callback (pl. Gmail). A callback tárolja a refresh tokent és létrehozza a `connector_grant` rekordot.

### Sandbox App API

| Metódus | Útvonal | Leírás |
|---|---|---|
| `GET` | `/api/sandbox-apps/[appId]/preview` | HTML app preview (iframe-ben) |
| `GET` | `/api/sandbox-apps/[appId]/export` | HTML letöltés |

### Webhooks

| Metódus | Útvonal | Leírás |
|---|---|---|
| `POST` | `/api/webhooks/clerk` | Clerk user.created / user.updated szinkron |

---

## 7. Autentikáció és jogosultságkezelés

### AuthProvider absztrakció

**Fájl:** `src/auth/index.ts`, `src/auth/types.ts`

```typescript
interface AuthProvider {
  getCurrentUser(): Promise<AuthUser | null>
  requireRole(minimum: UserRole | UserRole[]): Promise<AuthUser>
}
```

Két implementáció:
- **`ClerkProvider`** (`src/auth/clerk-provider.ts`): production — Clerk JWT + `publicMetadata.role`
- **`DevProvider`** (`src/auth/dev-provider.ts`): fejlesztés — `DEV_USER_*` env változókból

A provider az `AUTH_PROVIDER` env alapján választódik. Ha `CLERK_SECRET_KEY` be van állítva, automatikusan a Clerk provider aktiválódik.

### RBAC szerepkörök

| Szerep | Leírás | Hozzáférés |
|---|---|---|
| `viewer` | Csak olvasás | Ticketek, audit megtekintése |
| `operator` | Normál felhasználó | Ticket létrehozás, chat |
| `approver` | Jóváhagyó | Ticketek jóváhagyása, tanítás engedélyezése |
| `admin` | Teljes hozzáférés | Agent kezelés, platform beállítások, IAM |

A role rangsor: `viewer(0) < operator(1) < approver(2) < admin(3)`. A `requireRole()` minimum szintet ellenőriz.

### Agent API kulcs autentikáció

Az `AgentRepository.authenticateApiKey()` bcrypt-tel hash-elt kulcsot validál. Az agentnek saját `apiKey` van, amellyel a `/api/v1/agent/*` és a harness callback végpontokat éri el.

### Agent-hozzáférési gráf (ki kivel dolgozhat)

**Fájlok:** `src/lib/agent-access-graph.ts` (tiszta policy-mag),
`src/domain/agent-access/agent-access-service.ts` (feloldás + audit),
`src/app/control-plane/agent-access` (admin felület)

Az RBAC szerepek MELLETT egy külön, irányított gráf szabályozza az ad-hoc
user→agent és agent→agent elérési utakat. Két **független** jogot ad:

| Ige | Jelentés |
|---|---|
| `view` | A subject megtudhatja, hogy a célagent létezik, és látja a katalógusban. |
| `address` | A subject chatet indíthat, ticketet címezhet vagy delegálhat a célagentnek. |

Az `address` nem implikál `view`-t és fordítva sem. A chat, a ticket és az
`agent_ask` külön csatorna, de ugyanannak az `address` igének a kikényszerítési
pontjai.

**Kompatibilitási alapérték:** minden agent `inbound_restricted = false` és
`outbound_restricted = false` értékkel indul, tehát a tenanton belüli kapcsolat
grant nélkül engedett — a meglévő telepítések viselkedése változatlan. Szűkíteni
agentenként, az admin felületen lehet, kötelező hatás-előnézettel.

**Normatív invariánsok:**

1. Az agent önálló principal: A→B hívásnál A a saját jogán jár el; a kezdeményező
   user joga nem metsződik és nem öröklődik. Ezért egy user→A grant A teljes
   **elérhetőségi kúpjára** ad hozzáférést — ezt az admin UI ki is számolja.
2. A tenant-határ abszolút: grant nem tehet elérhetővé más tenant agentjét.
3. A `tenantId = null` platform-agentek (Playbook Author, Provisioning Assistant)
   **nem gráfcsomópontok**: chatből, ticketből, katalógusból és `agent_ask`-ból
   elérhetetlenek, csak a saját admin paneljük indítja őket.
4. A Web-Egress **tenantonként materializált**, normál tenant-agent, provisioningkor
   mindkét irányban zárva — a webes kutatás csak explicit agent→Web-Egress `address`
   granttal indul.
5. Az él csak elérést ad: nem ad tool capabilityt és nem kölcsönöz skillt.

**Kikényszerítési pontok** (mind a közös `canAccessAgent` / `listAccessibleAgents`
magot hívja, route-onként duplikált policy-logika nélkül): prompt-roster,
`agent_catalog`, `agent_resolve`, `agent_ask`, `ticket_create` agent-felelőssel,
`web_research_request`, agent-chat stream, operátori agent-katalógus,
felelős-választó és a „suitable" ajánló.

**Elutasítási szemantika:** ha a `view` engedett, de az `address` nem → 403; ha a
`view` sem engedett → 404-jellegű „Agent nem található", hogy a cél létezése ne
szivárogjon ki. A domain-hibák stabil kódot kapnak (`AGENT_ACCESS_FORBIDDEN`,
`AGENT_NOT_FOUND`). Szűrt listából kimaradó agentre nem keletkezik deny-esemény.

**Audit:** `agent.access.granted` / `agent.access.denied` (a `channel` mező
`chat | agent_ask | ticket | web_research`, az engedés alapja `grantId` vagy
`default-open`), `agent.access.bypass` (a Playbook/Monitor út átment, de az ad-hoc
gráf elutasította volna — auditál, nem blokkol), valamint
`agent_access.grant.create` / `.revoke` és `agent_access.restriction.update`.
A grant-írás és az audit-esemény ugyanabban a tranzakcióban keletkezik.

### Menü-hozzáférés (melyik szerepkör milyen menüt lát)

**Fájlok:** `src/lib/nav-visibility.ts` (tiszta policy),
`src/lib/control-plane-nav.ts` (nav-katalógus + szűrés),
`src/lib/nav-visibility-server.ts` (kérés-scope-olt betöltés),
`src/app/actions/menu-access.ts` (írás + audit),
`src/app/control-plane/menu-access` (admin felület)

A fejléc-navigáció teljes tartalma egyetlen katalógusban él
(`CONTROL_PLANE_NAV_CATALOG`); minden menüpont és almenü stabil `key`-t kap. A
tenant admin szerepkörönként (`viewer` / `operator` / `approver` / `admin`)
elrejtheti ezeket a kulcsokat. A policy a `tenants.settings.navVisibility`
mezőben lakik — nincs séma-migráció, és az **üres policy az alapérték**, tehát a
meglévő telepítések menüje változatlan.

**Ez kurálás, nem jogosultság.** A szűrés sorrendje: előbb a szerep-követelmény
(`requires.tenantRole` / `requires.platformRole`), utána a láthatósági policy —
így a policy csak **szűkíthet**, sosem jeleníthet meg olyan menüpontot, amihez a
felhasználónak nincs szerepe. Az oldalak `requireTenantRole` guardjai
változatlanul az egyetlen authorizációs határ: az elrejtett menüpont útvonala
közvetlen URL-lel továbbra is annyira elérhető, amennyire a szerepkör engedi.

**Normatív invariánsok:**

1. **Nincs kizárás:** az `admin` szerepkör elől sem az `admin` csoport, sem az
   `admin.menu-access` levél nem rejthető el (`NAV_KEYS_LOCKED_FOR_ADMIN`) —
   különben egyetlen mentés visszavonhatatlanná tenné a beállítást. A
   `sanitizeNavVisibilityPolicy` minden olvasási és írási úton kikényszeríti.
2. **Üresre szűkült csoport eltűnik:** nem marad a fejlécben olyan legördülő,
   ami semmit nem nyit ki.
3. **Ismeretlen kulcs kiesik:** a mentés a katalógushoz méri az inputot, így a
   policy nem hivatkozhat megszűnt menüpontra.
4. **Szerep nélküli hívó elől nem rejtünk:** a tisztán platform-szerepű
   (tenant-role nélküli) superadmin menüje érintetlen.
5. **Fail-open betöltés:** ha a tenant nem oldható fel, üres policy-vel megy
   tovább — egy DB-hiba nem zárhatja ki a felhasználót a saját menüjéből.

**Audit:** `tenant.nav_visibility.update`, a metadatában a teljes előtte/utána
policy-vel; a settings-írás és az audit-esemény egy tranzakcióban keletkezik.

### Feladatkör-korlátozás (taskOnly agent)

**Fájlok:** `prisma/schema.prisma` (`Agent.taskOnly`),
`src/lib/task-only-ticket.ts` (cím- és feladatszöveg-generálás + bemenet-validáció),
`src/components/agents/task-only-form.tsx` (admin kapcsoló),
`src/components/agents/agent-task-button.tsx` (feladat-gomb + indító modál)

Ha egy agent egyetlen jól körülhatárolt célt szolgál (pl. számlafeldolgozás,
tulajdoni lap egyeztetés), a tenant admin bekapcsolhatja rajta a
**Feladatkör-korlátozást**. Ilyenkor az agent felületéről eltűnik a chat, és
egyetlen gomb marad, ami egy előre kiválasztott, az agenten engedélyezett
**skillhez kötött feladatot** indít.

**Mit egyszerűsít:**

- nincs chat-ablak és nincs szabad szöveges feladatleírás;
- nincs cím-mező — a ticket címe szerveroldalon generált:
  `<skill neve> — YYYY-MM-DD HH:mm`;
- a bemenet legfeljebb a skill deklarált **paraméterei** (v1-ben mind opcionális)
  és — ha a skill engedi — a **csatolt fájlok**;
- a gomb felirata az egyetlen engedélyezett, futtatható skill neve; több skillnél
  semleges „Feladat"; futtatható skill hiányában letiltott, magyarázó tooltippel.

**Mit NEM garantál — ez UI-egyszerűsítés, nem jogosultsági korlát:**

- az agent **képességei változatlanok**: amit egyébként megtehet, azt korlátozott
  módban is megteheti; a Level-0 skill-index és a `load_skill` nem szűkül;
- a nem-emberi belépési pontok **nyitva maradnak**: `agent_ask`, csatorna-integrációk
  (pl. Telegram), agent API-kulcs, monitor-eszkaláció;
- a **ticket-kommentek** változatlanul működnek — a cél a felület egyszerűsítése,
  nem a kommunikáció ellehetetlenítése;
- a bekapcsolás pillanatában **futó chat-forduló végigfut**, és az eredménye
  megjelenik; a meglévő beszélgetések olvashatók maradnak. Csak ÚJ forduló nem
  indítható (`POST /api/v1/agent-chat/stream` → `409 agent_task_only`).

Ha valamit ténylegesen tiltani kell, azt a capability-grantoknál vagy a
hozzáférési gráfban kell elvenni — erre a kapcsolóra compliance-garanciaként
hivatkozni hiba.

**Csatolmány-szabály (`SkillContent.runtimeHints.allowAttachments`):** bináris
skill-tulajdonság; hiányzó érték = **engedett** (a meglévő skillek viselkedése
változatlan). `SKILL.md` frontmatterből `allow-attachments: false` alakban jön, a
katalógus szerkesztőjében pipával állítható. Több skill esetén a **legszigorúbb
nyer**: egyetlen tiltó skill is letiltja a csatolást. A kapu **kemény** mindenütt,
ahol a skillt explicit kiválasztják (korlátozott feladat + normál board-feladat) —
és mivel a feltöltés külön hívás, a
`POST /api/v1/tickets/[id]/workspace/files` végpont is ellenőriz (403), különben a
tiltás egy közvetlen POST-tal megkerülhető lenne. Chatben a `/skill` parancsnál
csak figyelmeztetés jelenik meg, a küldés nem törik meg.

**Jogosultság és audit:** a kapcsolót kizárólag **tenant admin** állíthatja
(`updateAgentTaskOnly`); minden váltás `agent.task_only` audit-eseményt ír a
korábbi és az új értékkel.

### Middleware

**Fájl:** `src/middleware.ts`

Clerk middleware minden route-ot véd, kivéve:
- `/sign-in`, `/sign-up`
- `/api/v1/agent/*` (agent API kulcs védi)
- `/api/v1/gateway/*` (gateway proxy)
- `/api/v1/harness/*` (harness callback)
- `/api/webhooks/*`

---

## 8. Model Gateway

### Provider routing logika

```
Agent prompt → ModelGateway.call(config, messages, ticketId?)
  1. Per-ticket guardrail ellenőrzés (call count ≤ GATEWAY_MAX_CALLS_PER_TICKET)
  2. Provider dispatch:
     - "chatgpt-oauth"  → ChatGPT OAuth bridge
     - "gemini"         → GeminiProvider (@google/genai)
     - "ollama"         → Ollama local endpoint
     - "openrouter"     → OpenAI-kompatibilis OpenRouter API
  3. ModelCall rekord mentés (tokens, cost, latency, status)
  4. AuditLog bejegyzés
```

### Guardrail

A `DEFAULT_MAX_CALLS_PER_TICKET = 30` egy biztonsági plafon a Goose `--max-turns` (12) felett. `GatewayBudgetError`-t dob, ha a ticket eléri a limitet.

### ChatGPT OAuth Bridge

**Fájl:** `src/domain/gateway/chatgpt-oauth-bridge.ts`

Szerver-oldali OAuth flow, amely a felhasználó ChatGPT előfizetését használja — nem API kulcsot, hanem OAuth tokent. A tokenek a `oauth_token_store`-ban tárolódnak (Secret Manager alias).

---

## 9. Tool Broker

### Jogosultság-model

```
AllowlistAuthorizer.authorize(agentId, toolName, actingUserId?)
  1. ToolBrokerRepository.findCapability(agentId, toolName)
     → allowed: true/false (alapból false/tiltott)
  2. Ha user_delegated connector → ConnectorGrantRepository.findActiveGrant()
  3. Ha nincs grant → DENIED
```

Az agentet CÉLZÓ toolokra (`agent_ask`, `agent_catalog`, `agent_resolve`,
`ticket_create` agent-felelőssel, `web_research_request`) egy TOVÁBBI kapu is fut —
az agent-hozzáférési gráf (7. fejezet). A sorrend kötött:

```
1. hitelesítés és tenant-kontextus
2. durva capability-check (AllowlistAuthorizer, fent)
3. cél feloldása és csatorna-alkalmassága
4. canAccessAgent(hívó agent, cél, "address")
5. végrehajtás és audit
```

A gráf-kapu nem írja felül a capability-checket, az agent státuszát vagy az
orchestrator-szabályt — mindegyik feltétel önállóan is elutasíthat.

### Kimeneti szerződés — a néma eszköz-hibák ellen (issue #195)

**Fájlok:** `src/domain/tool-broker/tool-output-contract.ts` (kapu),
`tool-output-contracts.ts` (tool-onkénti szerződések).

Amikor az agent „nem végzi el a feladatát", az esetek nagy részében nem a modell
hibázott, hanem az eszköz csendben félrement: a rendszer sikert jelentett, de a
végeredmény üres volt (üres Excel, hiányzó sorok), és a felhasználó csak a fájl
megnyitásakor vette észre. Ezért MINDEN eszköz-eredmény átmegy egy kikényszerített
kimeneti szerződésen a broker határán, az audit-rögzítés ELŐTT:

```
invoke()
  1. bemeneti méret-kapu (D7)          → korlát fölött azonnal `failed`
  2. handler végrehajtás
  3. kimeneti séma (Zod, D2)           → sértés → tipizált `failed`, nem néma átengedés
  4. mért mellékhatás (D4)             → „sikeresen írtam" állítás nem elég
  5. üresség (D3) / részlegesség       → `empty` / `partial`
  6. modellnek szánt szöveg (D5, D6)   → becsomagolás + méret-kapu jelölt csonkolással
  7. audit + ToolCall (outcome, effect_summary)
```

**Kimenetel (`ToolOutcome`)** minden eredményen: `ok` · `empty` · `partial` ·
`failed`. Az `empty` és a `partial` NEM hiba, hanem tény, amit a modell és a
felhasználó is megkap — hétköznapi mondatként, nem gépi címkeként.

**Két csatorna (D5)** — a `ToolBrokerInvokeResult` külön adja:

| mező | kinek | burkolat |
|------|-------|----------|
| `modelText` | a modellnek | bizalmi osztály szerint BECSOMAGOLVA (issue #97) |
| `machineData` | munkaterület, downstream tool, egyeztetés, export | SOHA nem burkolt |

Így a védőburkolat elvi szinten nem kerülhet gépi útra, és nincs szükség utólagos
kicsomagolásra. A régi `result` mező a `machineData` deprecated aliasa.

A `POST /api/v1/agent/tools` (külső agent REST API) GÉPI fogyasztó: a válasz a
`result` (= `machineData`) mezőt adja, `modelText`-et SOHA — kiegészítve az
`outcome` / `outcomeReason` / `effect` mezőkkel, hogy a hívó agent is megtudja,
ha az eszköz „sikeresen semmit nem csinált".

A kimenetel hétköznapi mondata a burkolaton KÍVÜL, platform-szövegként megy a
modellhez, a szövege viszont a tool kimenetéből származik (fájlnév, connector-
hibaüzenet, munkalap-név). Ezért a dinamikus töredékek `sanitizeOutcomeNotice`-on
mennek át: a határoló-szekvenciák escape-elve, a közlés egy sorba fogva és
hosszban korlátozva — enélkül egy támadó által írt fájlnév lezárhatná a burkolt
blokkot és saját utasítás-kontextust nyithatna.

**Megfigyelhetőség:** `ToolCall.outcome` + `ToolCall.effect_summary` (indexelt),
és a `tool_broker_outcomes_total{tool,outcome}` metrika a `/api/metrics`
végponton — ebből derül ki, melyik eszköz megy a leggyakrabban csendben félre.

### Per-user connector grant flow (pl. Gmail)

```
1. Felhasználó → /api/connectors/oauth/callback?code=...&state=...
2. Callback: token csere → ConnectorGrantRepository.create()
3. ToolBroker.gmail_*() híváskor: findActiveGrant(tenantId, connectorId, actingUserId)
4. GmailApiClient inicializálás az active grant tokenRef-jével
5. Tool végrehajtás + ToolCall rekord
```

### Delegálás

Az agent `delegate` tool-t hív → `ToolBrokerService` új ticketet nyit a cél agentnek → `WikiAgentRuntime.processTicket()` (vagy a dispatcher veszi fel).

A delegálás a HÍVÓ AGENT saját `address` jogán fut, nem a kezdeményező emberén: a
user joga nem metsződik és nem öröklődik tovább a láncon. A kezdeményező embert az
audit korrelációként megőrzi.

### Workspace fájlkezelés

**Fájlok:** `src/domain/file-editor/`

A workspace fájlok GCS bucket-ben tárolódnak (`WORKSPACE_BUCKET`). A `FileEditorService` adapter-mintát követ:
- `DocxAdapter` (mammoth): Word olvasás
- `XlsxAdapter` (exceljs): Excel olvasás/írás
- `PdfAdapter` (pdf-parse): PDF szöveg kinyerés

---

## 10. Dispatcher és Harness

### Dispatch loop

A dispatcher worker (`scripts/dispatcher-worker.ts`) polling alapon fut:

```
loop:
  1. isDispatchEnabled() → ha false, skip
  2. Budget check: napi call + token összeg ≤ DISPATCH_MAX_*
  3. findReadyForDispatch(now, limit=5)
  4. acquireDispatchLock(ticketId, lockToken)
  5. HarnessLauncher.launch({ ticketId, agentId, lockToken, ... })
  6. Ticket → IN_PROGRESS
  stale loop:
  findStaleInProgressDispatches(cutoff=15min) → force-unlock + reset
```

### Cloud Run Job konfiguráció

**Fájlok:** `app/infra/gcp/`, `app/src/domain/dispatcher/cloud-run-job-launcher.ts`

A Cloud Run Job indítása:
```
POST /apis/run.googleapis.com/v2/{parent}/jobs/{jobId}:run
  Body: { overrides: { containerOverrides: [{ env: [TICKET_ID, AGENT_ID, ...] }] } }
```

A job a `scripts/harness-entrypoint.ts`-t futtatja, amely a `HarnessJobEntrypoint.run()` belépőpontot hívja.

### Goose integráció

**Fájlok:** `src/harness/goose-command.ts`, `src/harness/goose-config.ts`

A Goose a harness szintjén van integrálva:
- `goose-config.ts`: generálja a Goose YAML konfigot (model provider = Gateway URL, extensions = Tool Broker MCP végpontok)
- `goose-command.ts`: futtatja a `goose run --recipe <recipe>` parancsot
- `platform-mcp-bridge.ts`: MCP szerver implementáció, amelyen keresztül a Goose eléri a Tool Broker-t
- `egress-guard.ts`: validálja, hogy a harness csak az engedélyezett célokra megy ki

---

## 11. Ticket rendszer és állapotgép

### Ticket típusok

| Típus | Leírás | Harness route |
|---|---|---|
| `wiki_search` | Tudásbázis lekérdezés | `WikiAgentRuntime` |
| `training` | Agent tanítási ticket | `TrainingService` |
| `general` | Általános feladat | `GeneralTaskRuntime` |
| *(egyedi)* | Ügyfél-specifikus típusok | Playbook-vezérelt |

### Állapotgép

```
BACKLOG → READY → IN_PROGRESS → AWAITING_HUMAN → DONE
                             ↘ REJECTED
```

| Állapot | Leírás |
|---|---|
| `BACKLOG` | Létrehozva, de nem kész futtatásra |
| `READY` | Dispatcher felveheti |
| `IN_PROGRESS` | Harness futtatja (dispatch lock aktív) |
| `AWAITING_HUMAN` | Az agent emberi jóváhagyást vár |
| `DONE` | Sikeres lezárás |
| `REJECTED` | Elutasítva (jóváhagyó vagy rendszer által) |

Minden állapotátmenet `TicketTransition` rekordot kap (`actor`: human/agent/system, `comment`, `ts`).

### Ticket forrás (source)

| Forrás | Leírás |
|---|---|
| `user` | Felhasználó hozta létre |
| `agent` | Agent hozta létre (delegálás) |
| `scheduled` | Ütemezett feladat materializálta |
| `system` | Rendszer (pl. training pipeline) |

---

## 12. Audit lánc

### Hash-lánc mechanizmus

Minden `AuditLog` rekord tartalmaz:

```typescript
{
  seq: number,         // monoton növekvő
  hash: string,        // SHA-256(prevHash + seq + action + actorId + payload)
  prevHash: string,    // előző rekord hash-e
  action: string,      // pl. "ticket.transition", "agent.update", "tool.call"
  actorId: string,     // userId vagy agentId
  payload: JSON        // akció részletei
}
```

A lánc törése (hash mismatch) az Audit UI-ban vizuálisan jelzett. Visszatöltés esetén a `db:backfill-audit` script újraszámolja a hash-eket.

### Fontosabb audit akciók

| Akció | Leírás |
|---|---|
| `ticket.create` / `ticket.transition` | Ticket életciklus |
| `agent.create` / `agent.update` | Agent konfiguráció |
| `training.proposed` / `training.approved` | Knowledge update |
| `tool.call` | Minden Tool Broker hívás |
| `model.call` | Minden LLM hívás (Model Gateway) |
| `connector_grant.create` / `connector_grant.revoke` | Per-user OAuth |
| `platform_settings.update` | Platform konfiguráció változás |

---

## 13. Connector és OAuth grant rendszer

### Connector auth_mode-ok

| auth_mode | Leírás | Tárolás |
|---|---|---|
| `service` | Rendszerszintű service account | Secret Manager alias |
| `user_delegated` | Belépett user saját fiókja | connector_grants tábla |
| `agent_owned` | Agent-specifikus kulcs | Secret Manager alias |

### Per-user OAuth flow

```
1. Admin: connector bejegyzés auth_mode=user_delegated-del
2. Felhasználó: "Fiók csatlakoztatása" gomb → OAuth redirect
3. /api/connectors/oauth/callback: token csere + ConnectorGrant.create()
4. ToolBroker: (tenantId, userId, connectorId) → findActiveGrant() → token injektálás
5. Autonóm futás (scheduled): csak explicit "run-as" felhatalmazással
```

### Lokális grant tárolás (fejlesztés)

`.connector-grants/tenant/<tenantId>/user/<userId>/connector/<connectorId>.json` — csak lokális fejlesztéshez.

---

## 14. Scheduled Tasks

**Fájl:** `src/domain/scheduled-task/scheduled-task-service.ts`

### Recurrence típusok

| Típus | Leírás |
|---|---|
| `once` | Egyszeri futás meghatározott időpontban |
| `cron` | Cron expression alapú ismétlés |
| `interval` | Fix idő-intervallum (percekben) |

### Materializálás folyamata

```
1. ScheduledTaskRepository.findDue(now, limit)
2. claimDue(id, now) — optimistic lock
3. Új ticket létrehozása a scheduled task payload-jából
4. markMaterialized(id, ticketId, { nextRunAt, runCount })
5. Stale recovery: findStaleMaterializing(cutoff=10min) → reclaimMaterializing()
```

Az ütemezett feladat `run-as` modell: ha az agent per-user connector-t kell használjon, a `runAsUserId` + `runAsAuthorizedAt` mezők tartalmazzák a felhasználói felhatalmazást.

---

## 15. Sandbox alkalmazások

**Fájl:** `src/domain/sandbox/sandbox-app-service.ts`

Az agent képes egyszerű, egyfájlos HTML alkalmazásokat generálni (A0 szint). Az alkalmazás:

1. Ticket payload-ból jön létre (agent generálja a HTML-t)
2. `sandbox_apps` + `sandbox_app_versions` táblában tárolódik
3. Preview: `/api/sandbox-apps/[appId]/preview` — sandboxolt iframe
4. Export: `/api/sandbox-apps/[appId]/export` — letölthető HTML fájl

---

## 16. Frontend — Control Plane UI

### Oldalak (`src/app/control-plane/`)

| Útvonal | Komponens | Leírás |
|---|---|---|
| `/control-plane` | `page.tsx` | Dashboard (ticket stats, agent kártyák) |
| `/control-plane/board` | `board/page.tsx` | Kanban board |
| `/control-plane/agents` | `agents/page.tsx` | Agent registry |
| `/control-plane/agents/[id]` | `agents/[agentId]/page.tsx` | Agent részletek + chat |
| `/control-plane/agents/new` | `agents/new/page.tsx` | Új agent létrehozása |
| `/control-plane/agent-access` | `agent-access/page.tsx` | Kapcsolatok — ki kivel dolgozhat (admin) |
| `/control-plane/audit` | `audit/page.tsx` | Audit lánc néző |
| `/control-plane/connectors` | `connectors/page.tsx` | Connector kezelés |
| `/control-plane/governance` | `governance/page.tsx` | Governance dashboard |
| `/control-plane/iam` | `iam/page.tsx` | IAM + meghívók |
| `/control-plane/menu-access` | `menu-access/page.tsx` | Menü-hozzáférés — melyik szerepkör milyen menüt lát (admin) |
| `/control-plane/scheduled-tasks` | `scheduled-tasks/page.tsx` | Ütemezett feladatok |
| `/control-plane/system` | `system/page.tsx` | Platform beállítások |
| `/control-plane/training` | `training/page.tsx` | Agent tanítás |
| `/control-plane/tickets/[id]` | `tickets/[ticketId]/page.tsx` | Ticket részlet |

### Sandbox UI (`src/app/sandbox/`)

| Útvonal | Leírás |
|---|---|
| `/sandbox` | Sandbox főoldal (agent lista) |
| `/sandbox/[agentId]` | Agent chat workspace |
| `/sandbox/proposals/[proposalId]` | Wiki proposal részlet |

---

## 17. Környezeti változók

### Kötelező

| Változó | Leírás |
|---|---|
| `DATABASE_URL` | Neon Postgres pooled connection string |
| `DIRECT_URL` | Neon Postgres direct connection (migrációhoz) |
| `GEMINI_API_KEY` | Google AI Studio API kulcs |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publikus kulcs |
| `CLERK_SECRET_KEY` | Clerk titkos kulcs |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Clerk webhook signing secret |

### Opcionális / Feature flags

| Változó | Alapértelmezés | Leírás |
|---|---|---|
| `HARNESS_LAUNCHER_MODE` | `local-wiki` | `local-wiki` / `docker-local` / `cloud-run-job` |
| `DISPATCH_MAX_CALLS_PER_DAY` | `100` | Napi dispatch call limit |
| `DISPATCH_MAX_TOKENS_PER_DAY` | `100000` | Napi token limit |
| `GATEWAY_MAX_CALLS_PER_TICKET` | `30` | Per-ticket modellhívás guardrail |
| `GATEWAY_PROMPT_CACHE` | `on` | `off`/`false`/`0` → a Gateway nem küld `cache_control` breakpointot |
| `GATEWAY_PROMPT_CACHE_MIN_TOKENS` | `1024` | Ennél rövidebb becsült prefixet nem jelölünk meg |
| `GATEWAY_PROMPT_CACHE_TTL` | `5m` | `1h` esetén hosszú TTL-ű cache (drágább írás, ritkább forgalomhoz) |
| `WORKSPACE_BUCKET` | `platform-workspace-prod` | GCS bucket neve (fájl workspace) |
| `GCS_SERVICE_ACCOUNT_EMAIL` | — | GCS IAM service account |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Lokális Ollama végpont |
| `OPENROUTER_API_KEY` | — | OpenRouter API kulcs |
| `WRITE_GATE_SECRET` | — | HMAC secret a write-gate token aláíráshoz |
| `DEV_USER_ID` | — | Dev auth: felhasználó ID (Clerk nélkül) |
| `DEV_USER_ROLE` | `admin` | Dev auth: felhasználó szerepköre |
| `AUTH_PROVIDER` | auto | `clerk` / `dev` |

### Cloud Run Job (harness)

| Változó | Leírás |
|---|---|
| `CLOUD_RUN_JOB_NAME` | GCP Cloud Run Job neve |
| `CLOUD_RUN_REGION` | GCP régió (pl. `europe-west1`) |
| `GCP_PROJECT_ID` | GCP projekt azonosítója |

### Teszt adatbázis (opcionális)

| Változó | Leírás |
|---|---|
| `DATABASE_URL_TEST` | Neon teszt branch pooled URL |
| `DIRECT_URL_TEST` | Neon teszt branch direct URL |
| `NEON_API_KEY` | Neon API kulcs (branch restore) |
| `NEON_PROJECT_ID` | Neon projekt ID |
| `NEON_PRODUCTION_BRANCH_ID` | Éles branch ID |
| `NEON_TEST_BRANCH_ID` | Teszt branch ID |

---

## 18. Adatbázis séma (Prisma)

**Fájl:** `app/prisma/schema.prisma`

### Főbb entitások

| Tábla | Leírás |
|---|---|
| `Agent` | Agent konfigurációk (instruction, behavior, model, role, hozzáférési kapcsolók) |
| `AgentAccessGrant` | Agent-hozzáférési gráf élei (user→agent, agent→agent; `view` + `address`) |
| `AgentVersion` | Agent verzió snapshotok (minden változásnál) |
| `Ticket` | Feladatok / munka egységek |
| `TicketTransition` | Állapotátmenet napló |
| `AuditLog` | Hash-láncos audit bejegyzések |
| `ModelCall` | LLM hívás naplók (cost, tokens, latency) |
| `ToolCall` | Tool Broker hívás naplók |
| `Connector` | Rendszer connectorok (ERP, Gmail, stb.) |
| `ConnectorGrant` | Per-user OAuth grantok |
| `Conversation` | Chat session (tenant-izolált) |
| `Message` | Conversation üzenetek |
| `Document` | Feltöltött / indexelt dokumentumok |
| `Playbook` / `PlaybookVersion` | Verziózott folyamat dokumentumok |
| `Recipe` / `RecipeVersion` | Goose recipe-k |
| `ScheduledTask` | Ütemezett feladatok |
| `SandboxApp` / `SandboxAppVersion` | Agent által generált HTML alkalmazások |
| `PlatformSetting` | Platform szintű key-value konfiguráció |
| `WriteGateToken` | Egyszer-használatos write-gate token-ek |

### Migrációk

```bash
# Séma szinkron (dev)
npm run db:push

# Séma szinkron (test branch)
npm run db:push:test

# Seed (demo adat)
npm run db:seed

# Audit hash-lánc visszatöltés (meglévő sorokhoz)
npm run db:backfill-audit

# Tenantonkénti Web-Egress példány pótlása (#142 után KÖTELEZŐ egyszeri lépés).
# Idempotens; a létrejövő példány mindkét irányban ZÁRT, tehát önmagában semmit
# nem tesz elérhetővé — a webes kutatást a tenant admin engedélyezi agentenként.
npm run db:backfill-tenant-web-egress
```

---

## 19. Deploy útmutató

### Előfeltételek

- Firebase Blaze plan (App Hosting)
- Neon Postgres fiók
- Clerk production instance
- Google AI Studio API kulcs (Gemini)
- GCP projekt (Cloud Run Job-okhoz, opcionális)

### Lépések

**1. Secrets beállítása (Firebase Secret Manager):**

```bash
npx firebase-tools apphosting:secrets:set DATABASE_URL
npx firebase-tools apphosting:secrets:set DIRECT_URL
npx firebase-tools apphosting:secrets:set GEMINI_API_KEY
npx firebase-tools apphosting:secrets:set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
npx firebase-tools apphosting:secrets:set CLERK_SECRET_KEY
npx firebase-tools apphosting:secrets:set CLERK_WEBHOOK_SIGNING_SECRET
npx firebase-tools apphosting:secrets:set WRITE_GATE_SECRET
```

**2. Adatbázis séma + seed:**

```bash
cd app
npm run db:push
npm run db:backfill-audit
npm run db:seed
```

**3. Deploy:**

```bash
npx firebase-tools deploy --only apphosting
# vagy a repo gyökeréből:
npm run deploy
```

**4. Clerk webhook:**

Clerk Dashboard → Webhooks → Add Endpoint:
- URL: `https://<app-url>/api/webhooks/clerk`
- Events: `user.created`, `user.updated`

**5. RBAC beállítás:**

Clerk Dashboard → Users → Public metadata:
```json
{ "role": "admin" }
```

### Cloud Run Harness deploy (opcionális)

```bash
cd app
npm run harness:cloud-run-deploy    # Cloud Run Job deploy
npm run dispatcher:cloud-run-deploy # Dispatcher service deploy
```

Részletes dokumentáció: `app/infra/gcp/CLOUD-RUN-HARNESS-SETUP.md`

---

## 20. Fejlesztői útmutató

### Első indítás

```bash
cd app
cp .env.example .env.local
# .env.local kitöltése (DATABASE_URL, GEMINI_API_KEY, stb.)

npm install
npm run db:push
npm run db:seed
npm run dev
```

Nyisd meg: `http://localhost:3000/control-plane`

### Scriptek

| Script | Leírás |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | Production build (prisma generate + next build) |
| `npm run db:push` | Prisma schema push (dev) |
| `npm run db:seed` | Demo seed adat |
| `npm run harness:run` | Harness kézi indítás (local) |
| `npm run dispatcher:worker` | Dispatcher worker indítás |
| `npm run report:measurement` | Governance mérési riport |
| `npm run test:e2e` | Playwright E2E tesztek |
| `npm run test:e2e:ui` | Playwright UI mód |
| `npm run test:tool-loop` | Agent tool-loop unit teszt |
| `npm run test:gateway-relay` | Gateway relay integráció teszt |
| `npm run test:acceptance` | Acceptance E2E |

### Új agent létrehozása (kódból)

```typescript
const { agent, apiKey } = await repositories.agents.create({
  name: 'Számlafeldolgozó agent',
  roleInstruction: 'Te egy szakképzett könyvelési asszisztens vagy...',
  behaviorProfile: 'Mindig citált forrásokra hivatkozz...',
  modelConfig: { provider: 'gemini', model: 'gemini-3.5-flash' },
  role: 'worker',
  selfEvolutionProfile: { scope: 'memory_only', approvalMode: 'human' },
  createdById: adminUserId,
})
```

### Új ticket típus hozzáadása

1. Adjuk hozzá a típust a `ticket_type_config` platform beállításhoz (Control Plane → Rendszer)
2. Definiáljuk a Playbook spec-et (`PlaybookService.createPlaybook()`)
3. Hozzuk létre a Recipe-t a Goose harness számára (`RecipeService.createRecipe()`)
4. A `resolveTicketProcessRoute()` függvényt frissítjük, ha egyedi runtime szükséges

### Tesztelési struktúra

- **Unit tesztek**: `scripts/*.test.ts` (tsx futtatja)
- **E2E tesztek**: `playwright.config.ts` + `tests/` (Playwright)
- **Teszt adatbázis**: Neon branch (`DATABASE_URL_TEST`)

### Architektúrális döntések

- **Dependency injection**: kézi, `domain/index.ts`-ben — framework nélkül, átlátható
- **Repository pattern**: minden storage-hozzáférés interface-en át — cserepontos
- **Async by default**: a ticketek aszinkron dispatch-elve futnak — a Next.js szerver nem blokkolódik
- **Audit first**: minden mutáció auditált — az audit nem utólagos, hanem a flow része
- **Capability deny-by-default**: a Tool Broker mindent tilt, amit nem explicit engedett az admin

---

*Ez a dokumentum a forráskód alapján generálva. A részletes architekturális döntésekért és üzleti kontextusért lásd: `AI-Agent-Platform-Koncepcio.md`.*
