# Kontrollált Enterprise AI Agent Platform — MVP fejlesztési specifikáció és roadmap (walking skeleton)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0 — fejlesztői átadási csomag
**Dátum:** 2026-06-15
**Forrásdokumentum:** `AI-Agent-Platform-MVP-Terv-v1.0.md` (architektúra-teljes MVP / walking skeleton)
**Háttér:** `AI-Agent-Platform-Koncepcio.md` (v0.8)
**Olvasó:** a fejlesztő(k). Direkt, technikai. Feltételezi az MVP-terv ismeretét.
**Státusz:** kivitelezésre kész — a nyitott döntések (D1, D3, D4, D6) ebben a dokumentumban default-javaslattal **lezárva** (lásd 1. fejezet).

---

## 0. Mit ad ez a dokumentum

Az `AI-Agent-Platform-MVP-Terv-v1.0.md` eldönti **mit** építünk: egy architektúra-teljes, valódi (nem mockolt) walking skeletont, amelyben a platform minden komponense alapszinten összeáll, és az első "lakó" agent egy belső **tudás-asszisztens (wiki-agent)**. Ez a dokumentum azt adja meg, **hogyan** építjük meg: komponensenkénti API-k, teljes adatmodell, a Goose-recipe formátuma, a write-gate token protokollja, az állapotgép, a spike-protokollok és a sprintre bontott roadmap.

**Vezérelv (a tervből változatlanul):** az MVP célja **nem egy use case bizonyítása**, hanem hogy **minden architektúra-komponens egy alapszinten működjön és egy valódi végigfutásban összeálljon**. A wiki-agent cseppszabatos paraméterezés — a váz onnantól bármilyen agenttel feltölthető a kód érdemi átírása nélkül.

> **Fontos elhatárolás:** ez **nem** az `AI-Agent-Platform-Fazis1-Spec.md`-ben leírt rendszer. Az a régi v0.1 koncepcióra épült (kattintható mockup, könyvelő/számla-agent, Gemini/Claude modell). Ez a spec a **v1.0 walking skeletont** specifikálja: **wiki-agent**, **kizárólag ChatGPT OAuth** modellforrás, **Goose harness Cloud Run Jobban**, **Tool Broker + dispatcher**. A két anyag nem keverendő.

---

## 1. Lezárt alapdöntések (a spec előfeltételei)

A v1.0 terv 10. fejezetének nyitott döntései ebben a specben az alábbi default-javaslatokkal **lezárva**. Ha üzleti okból bármelyik változik, az érintett fejezet újranyitandó.

| # | Döntés | **Lezárás ebben a specben** | Indok |
|---|---|---|---|
| D1 | Adatbázis | **Postgres (Cloud SQL)** | `LISTEN/NOTIFY` a dispatcherhez; relációs hash-láncolt audit; a csapat ismeri (posnavigator) |
| D2 | Modellforrás | **Kizárólag ChatGPT OAuth** (Codex-provider, „Sign in with ChatGPT") | A tervben már eldöntve. Sem külön OpenAI API, sem Gemini |
| D3 | Tudásbázis-forrás | **Excellence Pay belső dokumentumok** | Nincs ügyfélfüggőség; gyorsan tölthető |
| D4 | Hosting | **GCP** (Cloud Run + Cloud Run Jobs + Cloud SQL + Secret Manager) | A Cloud Run Jobs miatt koherens |
| D5 | Reflexió-feeder (4.6.3) | **Következő iteráció** (nem MVP) | A write-gate demó enélkül is teljes |
| D6 | Csapat / időkeret | **2 fejlesztő, ~9–10 hét** (1 senior full-stack + 1 platform/infra) | A terv 11. ütemezése erre van kalibrálva |
| D7 | Sandbox App Container / App Registry | **MVP-vékony szelet** | A0 single-file HTML app registry + preview + `.html` export beleférhet; A1-A3 app-platform, adatmodell-generálás, deployment és graduation Fázis 2 |

**Csapat-szereposztás (javaslat a roadmaphoz):**

- **Dev A — platform/infra:** Goose-integráció, Cloud Run Jobs, dispatcher, Model Gateway (OAuth-mediáció), Tool Broker, egress/izoláció, Secret Manager. Ő viszi a spike-okat (S1–S5).
- **Dev B — full-stack:** Next.js control plane + sandbox UI, Postgres/Prisma adatmodell, ticket-állapotgép, IAM/RBAC (Clerk), tanítás/memória UI, audit-nézet, dashboard.

---

## 2. Architektúra-áttekintés

### 2.1 Rétegek és komponensek

```
┌──────────────────────────────────────────────────────────────────────┐
│ CONTROL PLANE (Next.js, App Router) — "mit szabad, ki hagyja jóvá"     │
│  • Kanban board + ticket-állapotgép (szerveroldali validáció)          │
│  • Agent Registry  • IAM/RBAC (Clerk)  • Connector-definíciók          │
│  • Tanítás/memória (write-gate)  • Audit-nézet  • Költség-dashboard    │
├──────────────────────────────────────────────────────────────────────┤
│ SANDBOX / EXECUTION PLANE (Next.js UI + data plane)                    │
│  • Tudásfeltöltés  • Kérdés→citált válasz  • Jóváhagyásra küldés       │
├──────────────────────────────────────────────────────────────────────┤
│ DISPATCHER (nem-LLM worker)  — Postgres LISTEN/NOTIFY + cron safety net │
│  • Ready-predikátum  • ticket-lock/idempotencia  • budget/rate cap     │
│           │ indít (Cloud Run Jobs API)                                  │
│           ▼                                                             │
│  ┌────────────────────────────────────────────────────────────┐       │
│  │ HARNESS — Goose `goose run` (Cloud Run Job, ticketenként)    │       │
│  │  • recipe betöltés  • efemer munkaterület                    │       │
│  │  • deny-by-default egress  • developer-extension LEZÁRVA     │       │
│  │      │ provider-réteg            │ extension-réteg           │       │
│  └──────┼───────────────────────────┼──────────────────────────┘       │
│         ▼                           ▼                                   │
│  ┌──────────────┐           ┌────────────────────┐                     │
│  │ MODEL GATEWAY│           │ TOOL BROKER (MCP)   │                     │
│  │ OAuth-mediáció│          │ authorize() + secret│                     │
│  │ token/költség│           │ injektálás + napló  │                     │
│  │  napló       │           │  • kb_search        │                     │
│  └──────┬───────┘           │  • board_write      │                     │
│         ▼                   └─────────┬───────────┘                     │
│  ChatGPT OAuth (Codex)               ▼                                  │
│  (az EGYETLEN modellforrás)   Connector-réteg (wiki KB, board)         │
├──────────────────────────────────────────────────────────────────────┤
│ PERZISZTENCIA — Postgres (Cloud SQL) + Secret Manager                  │
│  • repository-absztrakció mögött  • append-only hash-láncolt audit     │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 A két átjáró elve (a termék fő differenciátora)

A walking skeleton lényege, hogy **a Goose semmit nem ér el közvetlenül**:

- **minden modellhívás** a **Model Gateway**-en megy át (ott marad szerveroldalon az OAuth-token, ott készül a token/költség-napló),
- **minden eszközhívás** a **Tool Broker**-en megy át (ott dől el az `authorize()`, ott injektálódik a secret, ott készül a hívás-napló),
- a Goose-konténer **kimenő hálózata deny-by-default**: csak a Gateway és a Broker felé mehet ki.

Ez a két átjáró + az append-only audit adja a „kontrollált, auditálható autonómia" állítást. Ha ez a három dolog nincs valódian kikényszerítve, az MVP nem éri el a célját — ezért ezek a spike-ok (S2–S4) a legmagasabb prioritásúak.

### 2.3 Kötelező absztrakciók az első naptól

Hogy az elhalasztott komponensek (több modell, OPA/Cedar, on-prem) **kódváltás nélkül** beköthetők legyenek:

1. **`ModelProvider` interfész** a Model Gateway mögött — most egyetlen impl: `ChatGptOAuthProvider`. A routing-réteg megmarad, de egyetlen célra mutat.
2. **`Authorizer` interfész** a Tool Brokerben — most egyetlen impl: `AllowlistAuthorizer`. Később OPA/Cedar.
3. **`MemoryStore` interfész** — most egyetlen impl: `PostgresMemoryStore` (teljes beinjektálás / kulcsszavas). Később hibrid retrieval / külső substrate.
4. **`AuthProvider` interfész** — most `ClerkAuthProvider`. Később Keycloak (on-prem).
5. **`*Repository` interfészek** — most Prisma/Postgres impl. Később on-prem store.

---

## 3. Tech stack és projektstruktúra

### 3.1 Tech stack (MVP — lezárva)

| Réteg | Döntés | Indok / cserepont |
|---|---|---|
| Control + Sandbox app | **Next.js (App Router)** | csapat ismeri; a sandbox amúgy is Next.js |
| Nyelv | **TypeScript (strict)** | a projekt-konvenció; `any` tiltott |
| Adatbázis | **Postgres (Cloud SQL)** | `LISTEN/NOTIFY`, relációs audit-lánc |
| ORM | **Prisma** | migrációk, típusbiztos kliens |
| Humán auth | **Clerk** (`AuthProvider` absztrakció mögött) | gyors; Keycloak az on-prem upgrade |
| Validáció | **Zod** | minden API-input sémázva |
| Harness | **Goose** (Apache-2.0), `goose run` headless | a kontrollált runtime |
| Harness futtatás | **Cloud Run Jobs** | pay-per-run, scale-to-zero, lefut-és-kilép |
| Model Gateway | saját thin szolgáltatás (Cloud Run service) | OAuth-token-mediáció; `ModelProvider` mögött |
| Tool Broker | saját MCP-proxy (Cloud Run service) | Goose extension ráköt; `Authorizer` mögött |
| Dispatcher | nem-LLM worker (Cloud Run service, min-instance ≥ 1) | `LISTEN/NOTIFY` + cron safety net |
| Secret | **GCP Secret Manager** | alias mögött, szerveroldali injektálás |
| Objektumtár (dokumentumok) | **GCS bucket** | a feltöltött tudásdokumentumok |

### 3.2 Repó-topológia (javaslat: monorepo)

```
ai-agent-platform/
  apps/
    web/                      # Next.js — control plane + sandbox UI + server actions
  services/
    model-gateway/            # OAuth-mediáció, modellhívás-napló (Cloud Run service)
    tool-broker/              # MCP-proxy, authorize(), secret-injektálás (Cloud Run service)
    dispatcher/               # nem-LLM worker, Ready-predikátum, job-indítás
  harness/
    goose/                    # Dockerfile, recipe-k, izoláció-config, egress-policy
  packages/
    domain/                   # TicketService, AgentService, TrainingService, AuditService...
    repositories/             # *Repository interfészek + Prisma-impl
    contracts/                # Zod-sémák, megosztott típusok, API-szerződések
    auth/                     # AuthProvider absztrakció (Clerk-impl)
  prisma/                     # schema.prisma + migrations
  infra/                      # IaC (Terraform), Cloud Run/Cloud SQL/Secret Manager config
```

> A `packages/domain` keret-független (nem importál Next.js-t), hogy a control plane és a háttérszolgáltatások közösen használják.

> **Megvalósítási eltérés (2026-06-19, kód-audit):** a fenti monorepo csak **javaslat** volt; a tényleges kódbázis egyetlen Next.js **monolit** az `app/` alatt. A domain/repository rétegek `app/src/domain` és `app/src/repositories` alatt élnek (nem külön `packages/`), a háttérszolgáltatások pedig scriptként/route-ként futnak: dispatcher = `app/scripts/dispatcher-worker.ts` (+ `Dockerfile.dispatcher`), Tool Broker MCP-bridge = `app/scripts/platform-mcp-bridge.ts`, Model Gateway = `app/src/domain/gateway/*` + `app/src/app/api/v1/gateway/...` route. Funkcionálisan egyenértékű a tervezett réteg-szeparációval (a `*Repository`/`ModelProvider`/`Authorizer` absztrakciók megvannak), de a `services/` és `packages/` mappák **nem léteznek** — új fejlesztő az `app/src` alatt keresse a komponenseket.

---

## 4. Adatmodell (Postgres, részletes)

A v1.0 terv 3.12 entitásai kibontva. A mezők indikatívak; a migrációban finomítandók, de a kulcsmezők és kapcsolatok kötelezőek. Minden `id` UUID (pk), minden időbélyeg `timestamptz`, tárolás UTC.

> **Forrás-igazság (2026-06-19, kód-audit):** az alábbi adatmodell az **MVP-magot** írja le; a tényleges, mérvadó séma a `app/prisma/schema.prisma`. A séma a §4-en **túl** több entitást is tartalmaz, amelyek MVP-feletti / bővített képességekhez tartoznak (lásd §15.4): `Playbook`/`PlaybookVersion` (Recipe melletti absztrakció), `Resource`/`AgentResource` (per-agent tudástár + megosztás), `Conversation`/`Message` (chat-first flow), `ScheduledTask` (ütemezés), `Eval`/`EvalRun` (eval backend), `PlatformSetting` (runtime kill-switch/cron config), valamint a `WriteGateToken` önálló modellként (a §4.4 csak referenciaként említette) és a `ConnectorGrant` (per-user delegált connector, Fázis 2). Ezek létezése **nem** bővíti az MVP acceptance-t; a §4 a minimális magot rögzíti, a részletekért a séma a hiteles forrás.

### 4.1 IAM / RBAC

**`users`**
```
id, external_auth_id (text, unique)   -- Clerk subject
email, name
role (enum: admin | approver | operator | viewer)
status (enum: pending | active | suspended)   -- MVP: önregisztrációs kapu még nem kemény (Fázis 2)
tenant_id (uuid)                      -- multi-tenant by design; MVP: 1 tenant
created_at
```

**`invitations`** *(admin-meghívás; lejáró, egyszer beváltható)*
```
id, email, role, token_hash, expires_at, redeemed_at (nullable), created_by (fk users), created_at
```

### 4.2 Agent Registry

**`agents`**
```
id, name
status (enum: draft | active | suspended | retired)
current_role_instruction_version (int)     -- "mit csinál"
current_behavior_profile_version (int)      -- "hogyan" (magyar, tömör, citálás-kötelező)
model_config (jsonb)                        -- { provider:"chatgpt-oauth", model, temperature, max_tokens }
current_memory_version (int)
tenant_id, created_at
```

**`agent_versions`** *(reprodukálhatóság — bármely ticketre visszakereshető)*
```
id, agent_id (fk)
version (int)
role_instruction_snapshot (text)
behavior_profile_snapshot (text)
model_config_snapshot (jsonb)
memory_version_id (fk memory_versions)
recipe_version_id (fk recipe_versions)
created_at
```

**`agent_api_keys`** *(scoped service account kulcs)*
```
id, agent_id (fk)
key_hash (text)                  -- a nyers kulcs SOSEM tárolt
scopes (jsonb)                   -- pl. ["ticket:read","ticket:write","tool:kb_search","tool:board_write"]
status (enum: active | revoked)
rotated_at, last_used_at, created_at
```

### 4.3 Recipe-katalógus

**`recipes`** + **`recipe_versions`** *(verziózott, agenthez köthető — lásd 6. fejezet)*
```
recipes:         id, name, ticket_type (enum: interaction | training), scope (enum: global|single), created_at
recipe_versions: id, recipe_id (fk), version (int), content (text/jsonb -- a recipe YAML/JSON),
                 status (enum: proposed | active | retired), approved_by (fk users, nullable), created_at
```

### 4.4 Memória / tanítás

**`memories`** + **`memory_versions`**
```
memories:        id, agent_id (fk), current_version_id (fk memory_versions)
memory_versions: id, memory_id (fk), version (int)
                 content_ref (text)           -- a jóváhagyott tudás (GCS/inline)
                 diff_from_previous (jsonb)
                 status (enum: proposed | active | rolled_back)
                 source (text), approved_by (fk users, nullable)
                 parent_version (int, nullable)
                 created_at
```

**`training_tickets`** *(a write-gate köti — lásd 5.8)*
```
ticket_id (fk tickets, pk)
proposed_diff (jsonb)
write_gate_token_ref (text)       -- a kiállított token referenciája (a nyers token sosem tárolt nyersen)
eval_result (jsonb, nullable)
target_memory_version (int)       -- melyik verzióra köt a token
```

### 4.5 Ticket / folyamat

**`tickets`**
```
id, type (enum: interaction | training), title
state (enum: backlog | ready | in_progress | awaiting_human | approved | done | rejected)
assignee_type (enum: human | agent, nullable), assignee_id (nullable)
agent_id (fk, nullable)
payload (jsonb)                   -- kérdés, citált válasz + forráslista, indoklás, diff stb.
source_document_id (fk documents, nullable)
execute_after (timestamptz, nullable)   -- séma kész; MVP-ben az azonnali indítás aktív
due_by (timestamptz, nullable)
lock_token (text, nullable), locked_at (nullable)   -- idempotencia
created_by, created_at, updated_at
```

**`ticket_transitions`** *(auditforrás)*
```
id, ticket_id (fk), from_state, to_state, actor_type, actor_id, note (nullable), ts
```

### 4.6 Connector / capability

**`connectors`** *(first-class erőforrás)*
```
id, type (enum: knowledge_base | board | ...), name
auth_mode (enum: service | user_delegated | agent_owned)   -- DEFAULT 'service'; lásd koncepció 4.12.1
scope (enum: global | single), secret_alias (text, nullable)  -- service/agent_owned módban használt
version (int), config (jsonb), tenant_id, created_at
```
> **Fit-pont (koncepció 4.12.1, NEM MVP-implementáció):** az `auth_mode` mező **most** bekerül a sémába (DEFAULT `service`), hogy a per-user delegált connector (pl. Gmail) később **migráció nélkül** illeszthető legyen. Az MVP minden connectora `service` módú; a `user_delegated` ág implementációja Fázis 2 (külön spec: `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md`).

**`agent_connectors`** *(many-to-many, access-mode)*
```
agent_id (fk), connector_id (fk), access_mode (enum: read | write)   -- pk(agent_id, connector_id)
```

**`connector_grants`** *(per-user delegált felhatalmazás — séma most, implementáció Fázis 2)*
```
id, tenant_id
connector_id (fk connectors)      -- csak auth_mode = 'user_delegated'
user_id (fk users)                -- KI adta a hozzáférést (az ő fiókja)
status (enum: active | revoked | expired)
scopes (jsonb)                    -- ténylegesen engedélyezett OAuth-scope-ok
token_ref (text)                  -- Secret Manager refresh-token referencia; nyers token SOSEM tárolt/promptban/logban
granted_at, expires_at (nullable), revoked_at (nullable)
unique(tenant_id, connector_id, user_id)
```
> **Fit-pont:** a tábla **definiálva, de MVP-ben üres/nem-használt**. Bekerülése most azért fontos, hogy az `auth_mode` + grant-modell ne igényeljen későbbi sémamigrációt. A teljes OAuth-flow, token-vault és runtime-feloldás a Fázis 2 feature-spec szerint. A `token_ref` ugyanazt a "secret sosem nyersen" elvet követi, mint a `write_gate_token_ref` (4.4) és a `secret_alias` (10.).

**`capabilities`** *(deny-by-default eszközjog)*
```
agent_id (fk), tool_name (text), allowed (bool)                      -- pk(agent_id, tool_name)
```

### 4.7 Naplók

**`model_calls`** *(Model Gateway napló)*
```
id, ticket_id (fk, nullable), agent_id (fk), agent_version (int)
model (text), prompt_tokens (int, nullable), completion_tokens (int, nullable)
cost_estimate (numeric, nullable)        -- flat-rate kvóta → becsült/aggregált
latency_ms (int), status (enum: ok | error | rate_limited)
created_at
```
> **Kvóta-megjegyzés (D2 következménye):** a ChatGPT OAuth flat-rate → a pontos per-call költség nem feltétlenül elérhető. A `cost_estimate` ezért **becsült/aggregált** mező; az MVP a hívásszámot és a token-becslést naplózza, a pontosság nem elvárás.

**`tool_calls`** *(Tool Broker napló)*
```
id, ticket_id (fk, nullable), agent_id (fk), agent_version (int)
tool (text), args_meta (jsonb)           -- argumentum-metaadat, NEM nyers secret
result_meta (jsonb), authorized (bool), denied_reason (text, nullable)
latency_ms (int), created_at
```

**`documents`** *(sandbox feltöltések)*
```
id, filename, storage_ref (text -- GCS), extracted_text (text, nullable)
status (enum: uploaded | processing | processed | failed)
connector_id (fk, nullable), uploaded_by (fk users), created_at
```

**`sandbox_apps`** *(MVP-vékony App Registry — A0 single-file app)*
```
id, tenant_id, name, slug, description (text, nullable)
level (enum: A0)                  -- MVP-ben csak single-file HTML app
status (enum: draft | active | archived)
created_by (fk users, nullable)
created_by_agent_id (fk agents, nullable)
created_from_ticket_id (fk tickets, nullable)
current_version_id (fk sandbox_app_versions, nullable)
created_at, updated_at
```

**`sandbox_app_versions`** *(verziózott, letölthető artefakt)*
```
id, app_id (fk sandbox_apps), version (int)
artifact_type (enum: single_html)
content_ref (text)                -- GCS/ref vagy DB-backed blob; nyers HTML nem audit_logban
content_hash (text)               -- export/preview integritás
change_summary (text, nullable)
created_by (fk users, nullable)
created_by_agent_id (fk agents, nullable)
created_at
```

**MVP-korlát:** nincs többfájlos build, nincs sandbox-adatmodell generálás, nincs automatikus deploy és nincs külső connector-hozzáférés az appból. A preview sandboxed iframe-ben fut; az export `.html` letöltés + hash.

### 4.8 Append-only hash-láncolt audit

**`audit_log`** *(a tamper-evidence MVP-ben VALÓDI — nem halasztott)*
```
id, seq (bigserial)               -- monoton sorrend
prev_hash (text, nullable)        -- az előző esemény hash-e (genezis: null)
hash (text)                       -- = SHA-256( prev_hash || canonical_json(payload_without_hash) )
type (text)                       -- ld. 5.11 eseménytípus-lista
actor_type (enum: human | agent | system), actor_id (nullable), agent_version (int, nullable)
target_type (text, nullable), target_id (nullable)
payload (jsonb)                   -- típusfüggő részletek (model, token, tool, diff, jóváhagyó stb.)
ts (timestamptz)
```

> **Hash-lánc szabály:** az audit-írás **kizárólag** egy dedikált `AuditService.append()`-en megy át, amely tranzakcióban olvassa az utolsó `hash`-t, kiszámítja az újat, és beilleszt. Az `audit_log` táblára `UPDATE`/`DELETE` az alkalmazás-szerepkörnek **megvonva** (csak `INSERT`/`SELECT`). A láncot egy `verifyChain()` segédfüggvény ellenőrzi (a demó és a tesztek használják).

---

## 5. Komponensenkénti fejlesztői specifikáció

Minden alfejezet: **felelősség → API/interfész → kipróbálhatósági kritérium**. A standard API-válasz: `{ success: boolean, data?, error? }`. Minden szerveroldali belépés mintája: **auth-check → Zod-validáció → domain-hívás → audit**.

### 5.1 Control Plane — ticket-állapotgép (terv 3.1)

**Felelősség:** Kanban board + ticket-részlet UI; szerveroldali állapotgép (a UI **nem** dönt átmenetet); 2 tickettípus; admin tickettípus/átmenet CRUD (alap); audit minden átmenetre.

**Engedélyezett átmenetek:**

| From | To | Ki válthat | Megjegyzés |
|---|---|---|---|
| `backlog` | `ready` | system / operator | a `Ready`-predikátum teljesülésekor |
| `ready` | `in_progress` | **system (dispatcher)** | a dispatcher indítja a Goose-jobot |
| `in_progress` | `awaiting_human` | system (agent eredménye) | citált válasz / kifelé menő / bizonytalan |
| `in_progress` | `done` | system | ha nem igényel jóváhagyást (belső, citált, biztos) |
| `awaiting_human` | `approved` | approver / admin | human-in-the-loop kapu |
| `awaiting_human` | `rejected` | approver / admin | visszadobás, indoklással |
| `approved` | `done` | system | lezárás |
| `rejected` | `ready` | operator | javítás után újra |

**API (server actions):**
```
listTickets({ filter? }) -> Ticket[]                         [viewer+]
getTicket({ id }) -> TicketDetail                            [viewer+]
transitionTicket({ id, toState, note? }) -> Ticket          [szerep-függő, ld. tábla]
createInteractionTicket({ agentId, payload, sourceDocumentId? }) -> Ticket   [operator / agent-key]
adminUpsertTicketType({ type, allowedTransitions }) -> TicketTypeConfig       [admin]
```
**Szerverszabály:** `transitionTicket` először az állapotgép-konfigból ellenőrzi `(from → to)` engedélyezettségét, majd a hívó szerepkörét. Tiltott átmenet → `error` + **audit-bejegyzés** (`ticket.transition.denied`), állapot **nem** változik.

**Kipróbálható, ha:** egy ticket végigvihető a boardon; `backlog → done` közvetlen átmenet szerveroldalon elutasításra kerül és auditba kerül.

### 5.2 IAM / RBAC (terv 3.2)

**Felelősség:** Clerk-alapú humán login `AuthProvider` mögött; 4 szerepkör; agent = service account scoped kulccsal; minden hozzáférési esemény auditba.

**Interfész:**
```
AuthProvider.getCurrentUser() -> { userId, role, status, tenantId }
AuthProvider.requireRole(min: Role) -> void | throws
```
**Szerepkörök:** `admin` (minden, user-meghívás, agent-konfig), `approver` (jóváhagyás, audit, tanítás-jóváhagyás), `operator` (ticket/dokumentum létrehozás, tanítás-javaslat), `viewer` (olvasás).

**Agent-authz NEM Clerkben:** az agent kulcsos service account; a jogok az `agent_api_keys.scopes`-ban + a `capabilities`/`agent_connectors` táblákban, a control plane kényszeríti ki. A Tool Broker minden hívásnál ezt ellenőrzi (5.5).

**MVP-egyszerűsítés:** a deny-by-default humán önregisztrációs kapu (Fázis 2) még nem kemény; a `status`-mező és az `invitations` tábla viszont kész, hogy később ne legyen migráció.

**Kipróbálható, ha:** `viewer` nem tud jóváhagyni (szerver elutasít + audit); agent-kulccsal csak a jogosult eszköz érhető el; minden hozzáférési esemény auditba kerül.

### 5.3 Agent Registry & életciklus (terv 3.3)

**Felelősség:** a wiki-agent verziózott rekordja; **szerep-instrukció** és **viselkedés-profil külön verziózva**; modell-konfig; memória-verzió; recipe-verzió; scoped kulcs.

**API:**
```
listAgents() -> Agent[]                                      [viewer+]
getAgent({ id }) -> AgentDetail (anatómia: szerep+viselkedés+modell+memória+recipe+jogok)   [viewer+]
createAgent({ name, roleInstruction, behaviorProfile, modelConfig }) -> Agent   [admin]
updateAgentInstruction({ agentId, roleInstruction?, behaviorProfile? }) -> AgentVersion   [admin]
rotateAgentKey({ agentId }) -> { apiKeyOnce }               [admin]   -- a nyers kulcs CSAK egyszer látszik
setAgentStatus({ agentId, status }) -> Agent                [admin]   -- suspended = kill-switch
```
**Reprodukálhatóság (kötelező):** minden agent-futás egy `agent_versions` rekordra hivatkozik, amely fagyasztja a szerep+viselkedés+modell+memória+recipe snapshotot. Egy lezárt ticketről visszakereshető, **melyik agent-/memória-/recipe-verzió** dolgozott rajta.

**Kipróbálható, ha:** bármely lezárt ticketről az anatómia visszaadja a négy verziót, és azokkal a futás reprodukálható.

### 5.4 Model Gateway (terv 3.4) — a leginkább kockázatos integráció

**Felelősség:** egyetlen végpont, amelyre a Goose **provider-rétege** köt. Egyetlen modellforrás: **ChatGPT OAuth** (Codex-provider). Az OAuth-tokent a Gateway **szerveroldalon mediálja** (az agent és a Goose sosem birtokolja). Minden hívás naplózva.

**Interfész (a Goose felé OpenAI-kompatibilis HTTP-végpont; befelé a domain felé):**
```
ModelGateway.chat({ agentId, agentVersion, ticketId?, messages, modelConfig })
  -> { content, usage?: { promptTokens, completionTokens }, latencyMs, status }
```
**Implementáció (`ChatGptOAuthProvider`):**
- a Gateway tartja az OAuth-előfizetői tokent (Secret Manager), és **ő** csatolja a felfelé menő híváshoz — a Goose-konténer csak a Gateway saját, rövid életű belső kulcsát kapja;
- minden hívásra `model_calls` + `audit_log` (`model.call`) bejegyzés: modell, token-becslés, latency, státusz, **agentVersion** (mert az OAuth emberi identitáshoz köt — az agent-szintű attribútálást a Gateway naplózza külön);
- **guardrail (alap):** ticketenkénti hívás-/token-keret; egyszerű kimenet-validáció;
- **rate/budget:** együttműködik a dispatcher cap-jével (5.7) — heti kvóta-plafon miatt kötelező.

**D2 három következménye, amit kezelni kell (a tervből):** (a) emberi előfizetői identitás → agent-attribútálás a Gateway naplójában; (b) flat-rate → becsült/aggregált költség; (c) heti plafon → dispatcher budget-cap kötelező. Az illeszkedést az **S2 spike** igazolja a fejlesztés előtt.

**Kipróbálható, ha:** az agent nem birtokolja az OAuth-tokent; a használat ticketenként legalább aggregáltan látszik; a futás megjelenik a Gateway naplójában.

### 5.5 Tool Broker — MCP-proxy (terv 3.5)

**Felelősség:** MCP-proxy, amelyre a Goose extension-konfigurációja mutat. Két eszköz: `kb_search` (wiki-retrieval) és `board_write` (ticket-frissítés). Deny-by-default `authorize()`; secret szerveroldali injektálás alias mögött; minden hívás auditba.

**Interfész:**
```
Authorizer.authorize(agentId, tool, args, actingUserId?) -> { allowed: boolean, reason? }   -- MVP: AllowlistAuthorizer
ToolBroker.invoke({ agentId, agentVersion, ticketId, tool, args, actingUserId? })
  -> { result, resultMeta, latencyMs }    -- nem engedélyezett → { denied, reason } + audit-flag
```
> **Fit-pont (koncepció 4.12.1):** az `actingUserId` paraméter **most** bekerül az interfész-szignatúrába (MVP-ben nullable / nem-használt), hogy a per-user delegált connector később ne igényelje a Broker-kontraktus átírását. `service`-módú connectornál a secret-feloldás az `auth_mode`/`secret_alias` alapján megy (mai út); `user_delegated`-nél a Broker a kredenciált `(actingUserId, connectorId)` `connector_grant` alapján oldja fel (kétrétegű engedély: agent-capability **és** érvényes user-grant). Az `actingUserId`-t a session/beszélgetés (koncepció 4.14) hordozza; autonóm futásnál csak explicit "run-as" felhatalmazásból jöhet.
**Eszközök (MCP-tool kontraktusok):**
```
kb_search(query: string, k?: int)
  -> { hits: [{ docId, snippet, sourceRef, memoryVersion }] }   -- a beolvasott memória-verziót naplózza
board_write(ticketId: string, patch: { state?, payload? })
  -> { ok: boolean }                                            -- a board-connectoron át; scope-ellenőrzött
```
**Secret-injektálás:** a connector secretje **alias** mögött; a Broker a hívás pillanatában injektálja szerveroldalon. A secret **sosem** kerül a promptba/runtime-ba/logba (csak `args_meta`, nem nyers érték).

**Kipróbálható, ha:** nem engedélyezett tool hívása **blokk + audit-flag**; a secret sehol nem jelenik meg promptban/runtime-ban/logban.

### 5.6 Harness — Goose (terv 3.6) + recipe

**Felelősség:** Goose-konténer, `goose run` **headless** módban, **ticketenkénti Cloud Run Jobként** a dispatcherből indítva; a tickethez tartozó **recipe** betöltése; strukturált kimenet visszaírása a ticketre; a provider-réteg a **Model Gateway**-re, az extension-réteg a **Tool Broker**-re kötve.

**Indítási kontraktus (a dispatcher → Cloud Run Jobs):**
```
goose run --no-session --recipe <recipe_ref> \
  --params ticket_id=<id> agent_version=<ver> \
  GOOSE_MODE=auto \
  (provider endpoint = MODEL_GATEWAY_URL, extension = TOOL_BROKER_MCP_URL)
Kimenet: stream-json a ticket payload-jába (citált válasz + forráslista + indoklás).
```
**Kritikus lezárás (governance — S4 spike igazolja):**
- **deny-by-default egress:** a konténer csak a Gateway + Broker felé mehet ki (VPC egress policy / serverless VPC connector + firewall);
- a beépített **developer-extension lezárva:** shell/fájl csak az efemer munkaterületre; tetszőleges MCP-extension tiltva — a Goose **csak** a Tool Broker MCP-végpontját látja;
- az agent **nem deploy-olhat** közvetlenül.

**Kipróbálható, ha:** egy ticket lefuttat egy valódi `goose run`-t, a futás a két átjárón megy, és igazolható (pl. teszt-kísérlet), hogy a konténer **nem ér el** közvetlen internetet/rendszert.

### 5.7 Dispatcher (terv 3.7)

**Felelősség:** nem-LLM work-queue + worker. `Ready` ticketnél elindítja a Goose Cloud Run Jobot. Eseményvezérelt trigger (`LISTEN/NOTIFY` állapotváltásra) + alacsony frekvenciás cron safety net. `Ready`-predikátum. Ticket-lock/idempotencia. Per-agent budget cap + max párhuzamosság.

**`Ready`-predikátum (MVP):**
```
indítható = (execute_after IS NULL OR now() >= execute_after)
          AND state = 'ready'
          AND nincs aktív lock a ticketen
          AND az agent budget-cap-je nem merült ki
```
**Idempotencia:** indítás előtt `UPDATE tickets SET lock_token=..., locked_at=now() WHERE id=$1 AND lock_token IS NULL` — ha 0 sor érintett, valaki más már viszi. A job végén/timeoutján a lock felszabadul.

**Budget cap (D2 heti plafon miatt kötelező):** per-agent napi/heti hívás- vagy becsült-token-plafon; elérve a dispatcher nem indít, a ticket `ready`-ben vár + audit (`dispatch.budget_blocked`).

**Kipróbálható, ha:** a dispatcher üresben **nulla LLM-tokent** fogyaszt; egy ticket pontosan egyszer fut (nincs duplázódás).

### 5.8 Tanítás és memória — write-gate (terv 3.8)

**Felelősség:** verziózott `MemoryStore`; tanítási ticket → javasolt diff → jóváhagyási lánc → a platform **szerveroldali, aláírt, egyszer használatos write-gate tokennel** ír → új verzió + rollback. Olvasás: MVP-ben teljes beinjektálás vagy `kb_search` kulcsszavas retrieval.

**Write-gate token protokoll (a koncepció 4.6.1 szerint, pontosan):**
1. Tanítási ticket létrejöttekor a platform **maga generál** egy egyedi, **egyszer használatos, aláírt** tokent, amely **az adott ticketre ÉS a cél memória-verzióra** van kötve (HMAC-aláírás szerveroldali kulccsal; a `training_tickets.write_gate_token_ref` csak referenciát/ hash-t tárol, nyers tokent nem).
2. A token **szerveroldalon marad** — az agent/Goose **nem birtokolja**, nem adja tovább (különben prompt injection kicsalná/újrajátszaná).
3. A memória-író szolgáltatás **csak ezt a tokent fogadja el**: hibás/lejárt/már-felhasznált token → **nem ír**.
4. A modell legfeljebb **javasol** (a `proposed_diff` tartalma); a **tényleges írást a platform végzi**, miután a javaslat átment a jóváhagyáson.
5. Sikeres írás → új `memory_versions` (`status: active`), a régi lezárul, a token elhasználva; audit (`memory.update`, diff + jóváhagyó + verzió).

**API:**
```
createTrainingTicket({ agentId, proposedContent, source }) -> Ticket
  -- kiszámolja a diffet a current memóriához, payloadba teszi, write-gate tokent állít ki   [operator+]
approveTraining({ ticketId }) -> { memoryVersion }          [approver+]   -- a platform ír a tokennel
rollbackMemory({ agentId, toVersion }) -> { memoryVersion } [approver+]   -- current_version visszaáll, audit
```
**Kipróbálható, ha:** külső prompt („tanuld meg, hogy…") **nem** ír memóriát; csak jóváhagyott tanítási ticket ír; a frissítés visszagörgethető; a retrieval naplózza, mely memória-verziót olvasta.

### 5.9 Connector-réteg (terv 3.9)

**Felelősség:** a wiki tudásbázis mint first-class connector (verziózott, scope-olt, agenthez kötve); a board mint connector. Secret alias mögött, szerveroldali injektálással.

**Kipróbálható, ha:** a connector definíciója a control plane-ben, a forgalom a data plane-ben; az agent csak a jogosult connectort éri el (Tool Broker `authorize()`).

### 5.10 Execution / Sandbox Plane (terv 3.10)

**Felelősség:** egyetlen reprezentatív Next.js-felület: tudásfeltöltés, kérdés→citált válasz+indoklás, jóváhagyásra küldés, lezárás. Request/response, állapotmentes — az agent **nem ebben fut**.

**API:**
```
uploadDocument({ file }) -> Document                        [operator+]
askWiki({ agentId, question }) -> { ticketId }              [operator+]   -- interakciós ticket + ready
getAnswer({ ticketId }) -> { answer, sources[], rationale, state }   [viewer+]
generateReport({ agentId, templateId }) -> { ticketId }    [operator+]   -- 1 előre definiált riport-sablon
```
**Kipróbálható, ha:** a felhasználó végigvisz egy kérdés→válasz→(opcionális tanítás)→jóváhagyás folyamatot, és minden a boardon/auditban látszik.

> **Kiegészítés (2026-06-19, kód-audit) — chat-first conversation runtime (CR-MVP-003, bővített scope):** a kódbázis a fenti állapotmentes Q&A út **mellett** egy ticket nélküli, beszélgetős réteget is tartalmaz: `Conversation`/`Message` modellek, `conversation-service.ts`, `agent-chat-panel` + chat sidebar UI, `agent-chat-runtime.ts` + `chat-tool-loop.ts`, és egy OpenAI-kompatibilis gateway chat completions végpont. A chat ugyanúgy a két átjárón (Model Gateway + Tool Broker) megy, conversation/message/model/tool logot ír, és van **promote-to-ticket** határátlépés (`conversation.promote_to_ticket` audit), amikor döntés/jóváhagyás/tartós nyom kell. Ez **bővített scope**, nem a core MVP §5.10 acceptance része; a 9.3 demó 5–9. lépése hivatkozik rá. A teljes komponens-spec (API-k, conversation állapotgép) Fázis 2 / külön CR.

#### 5.10.1 Sandbox App Container / App Registry — MVP-vékony szelet

**Válasz a scope-kérdésre:** igen, ebből tehető valami nagyon alap az MVP-be, de csak **A0 single-file app** szinten. Ez nem teljes Goose-szerű app-platform és nem graduation-ready export, hanem egy bizonyító szelet: az AI vagy az operator létrehoz egy különálló sandbox mini-appot, a felhasználó preview-ban megnyitja, majd `.html` fájlként letölti.

**MVP in scope:**
- App Registry lista a sandboxban: név, státusz, verzió, létrehozó, létrehozó ticket/agent.
- Egyetlen app-típus: `single_html` (HTML/CSS/JS egy fájlban, külső dependency nélkül).
- Sandboxed iframe preview: `sandbox` attribútummal, hálózat/secret/connector nélkül.
- Verzió létrehozása és aktiválása; régi verzió megtekinthető vagy visszaállítható.
- Export: `.html` letöltés + `content_hash` megjelenítése.
- Audit: létrehozás, verziózás, preview/export esemény.

**Out of scope MVP-ben:** többfájlos app bundle, npm build, app-saját adatmodell, külső API/connector az appból, deploy ügyfélkörnyezetbe, Docker/Git export, automatikus A1-A3 graduation.

**API:**
```
createSandboxApp({ name, description, createdFromTicketId? })
  -> { appId }                                           [operator+]
upsertSandboxAppVersion({ appId, html, changeSummary })
  -> { versionId, version, contentHash }                 [operator+ vagy agent toolon át]
listSandboxApps() -> { apps[] }                          [viewer+]
getSandboxAppPreview({ appId, version? }) -> { html }    [viewer+] -- iframe-ben renderelve
exportSandboxApp({ appId, version? })
  -> { filename, contentRef, contentHash }               [operator+]
```

**Tool Broker útvonal az agent felé (opcionális, ha S1-S4 után belefér):**
```
sandbox_app.create
sandbox_app.update_artifact
sandbox_app.preview
sandbox_app.export
```
Az MVP akkor is értékes, ha az első appot még operator action vagy seed hozza létre; az architekturális cél az, hogy ugyanez később Goose-toolként fusson, ne közvetlen fájlrendszer-/deploy-joggal.

### 5.11 Audit (terv 3.11)

**Kötelezően naplózandó eseménytípusok:**
```
ticket.transition | ticket.transition.denied
model.call
tool.call | tool.call.denied
access.invite | access.redeem | access.role_change | access.suspend
memory.update | memory.rollback | memory.write_denied
agent.create | agent.version | agent.key_rotate | agent.suspend
recipe.create | recipe.version | recipe.approve
dispatch.start | dispatch.budget_blocked
sandbox_app.create | sandbox_app.version | sandbox_app.preview | sandbox_app.export
connector.grant.create | connector.grant.refresh | connector.grant.revoke | connector.grant.expire   -- Fázis 2 (per-user delegált connector, koncepció 4.12.1)
```
**Kipróbálható, ha:** a demó végén egy adott eredményhez megmutatható a **teljes láncolat**: input → agent-/memória-/recipe-verzió → modell- és eszközhívások → jóváhagyó; és a `verifyChain()` zöld.

---

## 6. A Goose-recipe formátuma (MVP)

A recipe a **tickettípus szintű „hogyan végezd"** utasítás hordozója (agent-privát) — **nem** a folyamat-flow (azt a ticket-állapotgép kényszeríti ki). Verziózott, agenthez köthető, a `recipe_versions` táblában tárolt. Javasolt YAML-séma:

```yaml
name: wiki-answer
version: 3
ticket_type: interaction
description: "Belső tudásbázisból citált, magyar nyelvű választ ad."
parameters:
  - ticket_id
  - agent_version
instructions: |
  Te az Excellence Pay belső tudás-asszisztense vagy.
  1. Olvasd be a kérdést a ticket payloadból.
  2. Keress a tudásbázisban a `kb_search` eszközzel (max 6 találat).
  3. KIZÁRÓLAG a megtalált forrásokra támaszkodva válaszolj, magyarul, tömören.
  4. MINDEN állítás mellé tedd a forráshivatkozást (docId + szakasz).
  5. Ha a források nem fedik le a kérdést, mondd ki: "nincs elég forrás", és NE találj ki tényt.
  6. Írd vissza az eredményt a `board_write` eszközzel: { answer, sources[], rationale }.
  7. Ha a válasz kifelé menő vagy bizonytalan, a ticketet hagyd `awaiting_human` állapotban.
tools:
  - kb_search
  - board_write
output_schema:
  answer: string
  sources: [{ docId: string, sectionRef: string }]
  rationale: string
  confidence: enum[high, medium, low]
```

**Governance:** a recipe módosítása ugyanúgy jóváhagyás-köteles és auditesemény, mint a memória (a megosztott recipe sok agent viselkedését érintheti). MVP-ben egy agenthez kötött, de a verziózás/jóváhagyás kész.

> **Megjegyzés (2026-06-19, kód-audit) — Recipe vs. Playbook:** a kódbázisban a `Recipe`/`RecipeVersion` mellett egy külön `Playbook`/`PlaybookVersion` absztrakció is megjelent (`playbook-service.ts`, `playbook-spec.ts`). **Az MVP mérvadó kontraktusa továbbra is az itt leírt recipe-formátum** (tickettípus-szintű „hogyan végezd", verziózott, jóváhagyás-köteles). A Playbook réteg MVP-feletti cserepont (lásd §15.4); a két fogalom végleges viszonyát (a Playbook a Recipe fölötti újrahasznosítható réteg-e vagy önálló koncepció) egy külön CR tisztázza, mielőtt éles ügyfélnél támaszkodnánk rá.

---

## 7. Spike-protokollok (a fejlesztés előtt / közben)

A v1.0 terv 7. fejezete kibontva belépő/kilépő kritériummal. **Az S1–S4 idődobozolt integrációs spike (cél: ~1 hét, Fázis 0) az Epik 5 előtt fusson** — ezek a Goose-integráció ismeretlenjei és a legnagyobb kockázat.

| # | Spike | Belépő | Kilépő kritérium (DONE) | Ha elbukik |
|---|---|---|---|---|
| **S1** | `goose run` + recipe Cloud Run Jobban | Goose-image kész, 1 recipe | Egy `goose run` job API-ból indítható, recipe-paraméterekkel, és strukturált kimenetet ad | a teljes harness-modell újragondolandó |
| **S2** | Goose provider → Model Gateway, mögötte ChatGPT OAuth-mediáció | S1 kész, OAuth-előfizetés | Minden modellhívás a Gatewayen megy; az OAuth-token szerveroldalon marad; a hívás naplózódik agentVersion-nel | modellforrás-/illeszkedési kockázat — eszkaláció Gergőhöz |
| **S3** | Goose extension → Tool Broker MCP-proxy | S1 kész | `kb_search` + `board_write` a Brokeren át fut; `authorize()` deny működik; secret nem szivárog | secret-szivárgás kockázat |
| **S4** | developer-extension lezárás + deny-by-default egress | S1 kész | A konténerből egy szándékos „kiszökési" kísérlet (pl. külső HTTP) **blokkolódik**; shell csak az efemer munkatérre hat | a governance-állítás összeomlik |
| **S5** | write-gate token end-to-end | adatmodell kész | Aláírt, egyszer használatos token; újrajátszás/lejárt token elutasítva; rollback működik | a fő differenciátor sérül |
| **S6** | retrieval-minőség kis tudásbázison | tudásbázis betöltve | Teljes beinjektálás vs. kulcsszavas `kb_search` összevetése; a citált válasz használható kis mintán | use-case érték kérdéses — retrieval-stratégia újragondolandó |

> **Javaslat:** S1–S4 egy idődobozolt (1 hetes) integrációs spike-ként az Epik 5 előtt. S5 az Epik 6-tal, S6 az Epik 7-tel párhuzamosan.

### 7.1 S6 eval plan — wiki-agent retrieval és válaszminőség

**Cél:** bizonyítani, hogy a wiki-agent kis, kontrollált tudásbázison megbízhatóan megtalálja a releváns forrást, citált választ ad, és nem talál ki választ, ha nincs lefedettség. Az S6 nem általános RAG-benchmark: az MVP-hez szükséges, auditálható, kis tudásbázisos működést méri.

**Tesztkészlet:** minimum 15 kérdés, négy csoportban. A seedelt/demo tudásbázisban minden pozitív kérdéshez legyen előre megadott `expectedDocId`, `expectedSectionRef`, rövid `goldAnswer`, és elfogadható alternatív kulcsszavak listája.

| Csoport | Darab | Cél | Példakérdés |
|---|---:|---|---|
| Direkt ténykérdés | 6 | Egyértelmű szakasz visszakeresése és tömör válasz | „Mi az MVP fő célja?" |
| Többlépéses / összekötő kérdés | 4 | Két kapcsolódó szakasz összefoglalása citációval | „Milyen átjárókon kell átmennie egy agent műveletnek, és miért?" |
| Fájlnév- és dokumentum-orientált kérdés | 3 | `kb_search` megtalálja a dokumentumot fájlnév, cím vagy tartalmi kulcsszó alapján | „Miről szól a Project_description_users.md dokumentum?" |
| Negatív / nincs forrás | 2 | Bizonytalan vagy nem lefedett kérdésnél ne hallucináljon | „Milyen SLA-t ígér az éles banki deployment?" |

**Konkrét induló kérdéskészlet (v0):**

1. Mi az MVP fő célja?
2. Miben különbözik a walking skeleton a régi kattintható mockuptól?
3. Melyik modellforrás az MVP hivatalos útja?
4. Milyen két átjárón kell átmennie az agent műveleteinek?
5. Miért kötelező a write-gate token a tanuláshoz?
6. Mikor kell emberi jóváhagyásra küldeni egy választ?
7. Mi történik, ha egy viewer próbál jóváhagyni?
8. Milyen audit bizonyíték kell egy lezárt tickethez?
9. Mit bizonyít az App Registry v0 az MVP-ben?
10. Mi a különbség a service connector és a per-user Gmail grant között?
11. Mire használhatóak a ticket workspace file toolok?
12. Miről szól a Project_description_users.md dokumentum?
13. Milyen fájleszközöket lát az agent az MCP bridge-en keresztül?
14. Van-e az MVP-ben banki on-prem / Keycloak deployment?
15. Ígér-e a specifikáció production-grade hibrid retrievalt az MVP-re?

**Elfogadási küszöbök:**

| Metrika | Küszöb | Mérési mód |
|---|---:|---|
| Retrieval `hit@3` pozitív kérdéseken | >= 90% | Az `expectedDocId` vagy `expectedSectionRef` a top 3 találatban van. |
| Retrieval `hit@1` direkt ténykérdéseken | >= 75% | Direkt kérdésnél az első találat a várt szakasz. |
| Citációs lefedettség | >= 95% | Minden nem-negatív válaszban legalább egy valós `sources[]` elem van. |
| Válaszhelyesség | >= 80% | Manuális 0/1 értékelés a `goldAnswer` alapján; részpont nincs az MVP-ben. |
| Negatív kérdések kezelése | 100% | A válasz jelzi, hogy nincs elég forrás, és nem ad kitalált tényt. |
| Forráshűség | 0 kritikus hiba | Nincs olyan állítás, amely ellentmond a citált forrásnak. |
| Futási korlát | <= 20 Gateway hívás / kérdés | A guardrail alatt konvergál; különben recipe vagy tool-loop javítandó. |

**Retrieval-stratégia összevetés:**

1. `full_injection`: kis tudásbázis teljes kontextusba adva.
2. `kb_search_keyword`: Tool Broker `kb_search` kulcsszavas kereséssel, `k=3`.
3. Opcionális kontroll: `kb_search_keyword`, `k=6`, ha `k=3` alatt gyenge a `hit@3`.

Az MVP alapértelmezett stratégia az, amelyik teljesíti a küszöböket kevesebb tokennel és stabilabban. Ha mindkettő teljesít, `kb_search_keyword k=3` a preferált út, mert jobban bizonyítja a Brokerelt retrievalt. Ha egyik sem teljesít, S6 nem zöld: a recipe/prompt, chunkolás vagy egyszerű scoring javítandó, hibrid retrieval bevezetése csak külön scope-döntéssel.

**Dokumentált tesztek és futtatás:**

| Teszt | Parancs | Mit igazol |
|---|---|---|
| Determinisztikus filename/tartalom retrieval | `cd app && npx tsx scripts/kb-search-retrieval.test.ts` | A `kb_search` scoring kezeli a fájlnév-alapú és ékezetes magyar találatokat. |
| Tool-call relay parser | `cd app && npm run test:gateway-relay` | A ChatGPT OAuth szöveges tool-hívásai strukturált `kb_search` hívássá alakíthatók. |
| Teljes acceptance, benne wiki/chat/file/Gmail smoke | `cd app && npm run test:acceptance` | A retrieval, citált válasz, conversation log, file tool és per-user connector kapuk auditáltan működnek. |
| Mérési riport | `cd app && npm run report:measurement` | A demó-futás minőségi, átfutási és költség adatai exportálhatók. |

**S6 kimeneti artefaktum:** egy rövid Markdown jegyzőkönyv a demó dátumával, tudásbázis-verzióval, agent-/recipe-verzióval, futtatott kérdéskészlettel, táblázatos eredményekkel (`hit@1`, `hit@3`, citáció, helyesség, negatív kezelés), és a választott retrieval-stratégia indoklásával. A jegyzőkönyv linkeljen a releváns audit/model/tool call rekordokra vagy tartalmazza azok azonosítóit.

---

## 8. Epik → sprint roadmap

### 8.1 Epikek (a v1.0 terv 5. fejezete, dev-ready bontásban)

**Epik 1 — Control Plane mag**
ticket board + ticket-részlet UI; szerveroldali állapotgép (5.1); 2 tickettípus; admin tickettípus/átmenet CRUD (alap); **append-only hash-láncolt audit** event-modell (4.8) + audit-nézet (`verifyChain`).

**Epik 2 — IAM / RBAC**
Clerk OIDC-absztrakció mögött; 4 szerepkör; admin-meghívás (`invitations`); agent service account + scoped kulcs; hozzáférési események auditálása.

**Epik 3 — Agent Registry + Model Gateway**
agent-rekord (szerep/viselkedés külön, verziózva); modell-konfig; **Model Gateway wrapper a ChatGPT OAuth-mediációval** (`ChatGptOAuthProvider`); routing-absztrakció (1 cél); token/költség/latency napló; költség/hívás-plafon guardrail. *(Megjegyzés: a v1.0 terv 5. epik-szövege még „OpenAI + Gemini"-t említ — ez a D2 döntés miatt elavult; helyesen **kizárólag ChatGPT OAuth**.)*

**Epik 4 — Tool Broker + connector**
MCP-proxy; `authorize()` allowlist; secret-alias szerveroldali injektálás; `kb_search` + `board_write`; wiki-connector + board-connector; hívás-napló.

**Epik 5 — Harness (Goose) + Dispatcher**
Goose-konténer; `goose run` recipe-vel; provider→Gateway, extension→Broker; deny-by-default egress + developer-extension lezárás; Cloud Run Job; nem-LLM dispatcher (`LISTEN/NOTIFY` + cron); `Ready`-predikátum; ticket-lock/idempotencia; per-agent budget cap. **(Előfeltétel: S1–S4 zöld.)**

**Epik 6 — Tanítás / memória**
verziózott `MemoryStore`; tanítási ticket + javasolt diff; jóváhagyási lánc; **write-gate token** (aláírt, egyszer használatos, diffhez kötött); verzió-promóció + rollback; retrieval-napló. *(S5.)*

**Epik 7 — Sandbox use case (wiki) + App Registry v0**
tudásfeltöltés; kérdés→citált válasz+indoklás UI; jóváhagyásra küldés; lezárás; 1 előre definiált riport-sablon; **A0 Sandbox App Registry** (single-file HTML app, preview, verzió, export). *(S6.)*

**Epik 8 — Governance és mérés**
human-in-the-loop kapu; token/költség dashboard minimum; bizonytalan eset eszkaláció; egyszerű eval dataset + manuális értékelő felület; a 9.2 negatív tesztek.

**Függőség:** Epik 1–2 → Epik 3–4 → (S1–S4) → Epik 5 → Epik 6–7 → Epik 8.

### 8.2 Ütemezés (2 fő, ~9–10 hét — D6)

| Fázis | Hét | Tartalom | Fő felelős | Mérföldkő |
|---|---|---|---|---|
| **0. Spike** | 1 | S1–S4 Goose-integráció (idődoboz) | Dev A | A két átjáró + izoláció valódian működik egy futáson |
| **1. Control Plane + IAM** | 2–3 | Epik 1–2 | Dev B (A: infra/IaC) | Ticket végigvihető, hash-lánc él, 4 szerep, meghívás |
| **2. Gateway + Broker + Registry** | 4–5 | Epik 3–4 | A: Gateway+Broker, B: Registry | Modellhívás + eszközhívás naplózva; agent anatómia |
| **3. Harness + Dispatcher** | 6–7 (≈1,5) | Epik 5 | Dev A | Valódi `goose run` ticketenként a dispatcher mögött |
| **4. Tanítás + Sandbox** | 7–9 (≈2) | Epik 6–7 (S5, S6) | B: Sandbox+tanítás-UI + App Registry v0, A: write-gate+MemoryStore | Write-gate + rollback; citált wiki-válasz; A0 app preview/export |
| **5. Governance + mérés + demó** | 10 (≈1) | Epik 8 + negatív tesztek | Dev B (A: budget/kill-switch) | A 4. fejezet demó + 4 negatív teszt zöld |

> Az ütemezés a spike-eredménytől függ. Ha S2 (OAuth-mediáció) csúszik, az a kritikus út — azonnal eszkalálandó.

---

## 9. Elfogadási kritériumok

### 9.1 Funkcionális + architektúra (a v1.0 terv 6. fejezete)

A walking skeleton akkor kész, ha **valódi adaton, stabilan** teljesül:

1. A wiki use case-re végigmegy egy teljes folyamat **kérdéstől jóváhagyott, citált eredményig**.
2. **Legalább egy agent ténylegesen fut kontrollált runtime-ban** (valódi `goose run`, nem szimuláció).
3. Minden agent-művelet **tickethez kötött és visszakereshető**.
4. Van **Model Gateway napló** (modell, token/költség-becslés, latency, státusz) és **Tool Broker napló** (eszköz, jogosultság).
5. A kritikus lépés **emberi jóváhagyáson** megy át; bizonytalan eset emberhez eszkalálódik.
6. Visszakereshető, **melyik agent-/memória-/recipe-verzió + input** alapján született az eredmény.
7. Van **rövid mérési riport** (válaszminőség, átfutás, visszadobás, költség/ticket).
8. **Architektúra-teljesség:** mind az 5.1–5.11 komponens legalább egyszer szerepel egy valódi végigfutásban.
9. Az App Registry v0 bizonyított: legalább egy A0 sandbox app létrejön, preview-ban megnyílik, verziózott, és `.html` exportként letölthető hash-sel.

### 9.2 Kötelező negatív tesztek (governance-bizonyítékok)

| # | Teszt | Elvárt eredmény |
|---|---|---|
| N1 | `viewer` megpróbál jóváhagyni | Szerver elutasít + `ticket.transition.denied` audit |
| N2 | Agent egy nem engedélyezett toolt hív | Tool Broker blokk + `tool.call.denied` audit-flag |
| N3 | Külső „tanuld meg, hogy…" prompt | **Nem** ír memóriát (write-gate token nélkül nincs írás) |
| N4 | Goose-konténer közvetlen internet/rendszer-elérés kísérlete | Egress blokk; a kísérlet nem jut ki |

### 9.3 End-to-end demó-forgatókönyv

A demó célja nem egy wiki-kérdés megválaszolása önmagában, hanem annak bemutatása, hogy a platform ma már egy kontrollált agent-munkakörnyezet: sima beszélgetős agent-chat, ticket board, agent tudástárak, brokerelt toolok, Excel/fájl workspace, per-user connector előkészítés/Gmail, agent-to-agent delegálás, App Registry, governance és mérés együtt látható. A **core MVP acceptance** továbbra is a wiki-agent + Gateway + Tool Broker + human approval + write-gate + audit út; az Excel/file tool, Gmail, agent-to-agent és általános tudástár-kezelési részek **bővített demó-szakaszok**, külön feature-scope-ként jelölve.

**Előkészítés:**

1. Lokális demóhoz: `cd app && npm install && npm run db:push && npm run db:seed && npm run dev`.
2. Acceptance bizonyítékhoz: `cd app && npm run test:acceptance`.
3. Retrieval bizonyítékhoz: `cd app && npx tsx scripts/kb-search-retrieval.test.ts`.
4. Demó URL: lokálisan `http://localhost:3000`, éles hosted appnál az App Hosting URL.
5. Szerepek: legalább egy `operator` és egy `approver` seed user; Gmail szakaszhoz teszt user grant vagy stubolt S7 környezet.

**Kattintható demómenet:**

| # | Képernyő / kattintás | Teendő | Elvárt bizonyíték |
|---|---|---|---|
| 1 | `/control-plane` | Mutasd meg a dashboardot: nyitott ügyek, aktív agentek, token/költség napi összesítő. | A rendszer nem mockup: DB-ből jövő agent/ticket/metrika látszik. |
| 2 | `/control-plane/agents` → bármely worker agent | Nyisd meg az agent részleteit. | Látszik a szerep, viselkedésprofil, agent-verzió, modellkonfig, recipe kapcsolat és tudástár panel. |
| 3 | Agent részlet → tudástár panel | Tölts fel `.md`, `.pdf`, `.docx`, `.csv` vagy `.xlsx` fájlt az agent saját tudástárába. | A dokumentum az adott agent knowledge base-éhez kötődik; a feltöltött szöveg később `kb_search`-ben használható. |
| 4 | Tudástár megosztás *(bővített scope)* | Oszd meg az egyik agent tudástárát egy másik agenttel, majd vond vissza vagy mutasd a jogosultságot. | A tudás nem globális: agenthez kötött connector és explicit megosztás látszik. |
| 5 | Agent részlet → `Chat` gomb | Tegyél fel egy egyszerű kérdést ticket nélkül: „Mi az MVP célja?" vagy „Foglalod össze a feltöltött fájlt?" | A chat ticket nélkül indul; létrejön conversation/message/model/tool log. |
| 6 | Chat ablak → fájlcsatolás *(bővített scope)* | Csatolj egy Excel fájlt, majd kérd: „Elemezd az Excel fő sorait és emeld ki a kiugró összegeket." | Az agent `xlsx_read_sheet` / file tool eredményre támaszkodik; nem kell ticketet nyitni a sima elemzéshez. |
| 7 | Chat ablak → Gmail kérés *(bővített/F2 scope)* | Ha van grant: „Nézd át a mai olvasatlan Gmailjeimet, és foglald össze a teendőket." | `gmail_search` / `gmail_get_message` csak acting user granttel fut; grant hiányában az agent a fiók csatlakoztatását kéri. |
| 8 | Chat ablak → agent-to-agent kérés *(bővített scope)* | Kérd meg az agentet: „Kérdezd meg a Wiki Agentet is erről, és vond össze a választ." | `agent_ask` delegálás jön létre; a másik agent válasza visszakerül az eredeti beszélgetésbe vagy ticketbe. |
| 9 | Chat ablak → `Ticket létrehozása` / approval-promote | Promotálj ticketet abból a válaszból, ahol döntés, jóváhagyás vagy tartós nyom kell. | A határátlépés auditált: `conversation.promote_to_ticket`, a ticket `awaiting_human`. |
| 10 | `/control-plane/board` → új ticket | Nyisd meg a ticketet. | Látszik a kérdés, a citált válasz, a `sources[]`, rationale, agent-/recipe-/memory-verzió. |
| 11 | Ticket oldal → `Fájlok` panel *(bővített scope)* | Tölts fel egy kis `.txt`, `.md` vagy `.xlsx` fájlt a ticket workspace-ébe. | A fájl ticket workspace-ben jelenik meg; letölthető; az agent `file_read` / `xlsx_read_sheet`-tel eléri. |
| 12 | Agent/tool bizonyíték | Acceptance-ben vagy auditban mutasd: `file_read`, `file_write`, `file_edit`, `file_search`, `xlsx_read_sheet` saját ticket workspace-en belül. | File/Excel tool hívások tartalom nélkül, path + méret metaadattal auditáltak; más ticket workspace nem olvasható. |
| 13 | Ticket oldal → approver transition | Approverrel hagyd jóvá, majd zárd le a választ. | `approved` → `done`; auditban szerepel a humán döntés. |
| 14 | `/control-plane/training` | Hozz létre vagy mutass egy tanítási javaslatot a tudásbázis frissítésére. | Write-gate tokennel megy az írás; token replay/lejárat negatív tesztben tiltott. |
| 15 | Training / memória verzió | Mutasd meg a memória verzióváltást és rollbacket. | Új verzió és rollback esemény auditált, a régi verzió visszakereshető. |
| 16 | `/sandbox` | Tölts fel vagy válassz tudásanyagot, kérdezz rá a wiki sandboxban. | Ugyanaz a core képesség felhasználói sandbox felületen is kipróbálható. |
| 17 | `/sandbox` vagy sandbox proposal oldal | Hozz létre / nyiss meg egy A0 sandbox appot. | Preview iframe megnyílik, verziózott app látszik, `.html` export hash-sel letölthető. |
| 18 | `/control-plane/connectors` *(bővített/F2 scope)* | Mutasd meg a Gmail connector/grant állapotot, scope-profilt és visszavonhatóságot. | Kétrétegű engedély látszik: agent capability + user grant; acting user nélkül DENY. |
| 19 | Gmail demó *(ha grant elérhető)* | Keress Gmailben `gmail_search`-sel, majd draft/send kaput mutass. | Search csak user-granttel fut; send human approval nélkül DENY, jóváhagyással OK. |
| 20 | `/control-plane/audit` | Szűrj a demó conversationre/ticketre és a tool eseményekre. | Model Gateway, Tool Broker, file/Excel/Gmail/agent_ask, transition és write-gate események visszakereshetők. |
| 21 | `/control-plane/governance` → report | Nyisd meg/exportáld a mérési riportot. | Minőség, átfutás, token/költség és sandbox app metrikák egy riportban. |
| 22 | `/control-plane/system` | Mutasd meg a dispatcher/kill-switch/admin konfigurációt. | Látszik, hogy a futtatás nem ad hoc: dispatcher, budget/kill switch és ticket type config kontrollálható. |

**Kötelező negatív demóblokk:**

| # | Lépés | Elvárt eredmény |
|---|---|---|
| N1 | Viewer próbál ticketet jóváhagyni | Szerver DENY + audit. |
| N2 | Agent nem engedélyezett toolt hív | Tool Broker DENY + audit. |
| N3 | Chatben vagy dokumentumban „tanuld meg ezt gate nélkül" prompt | Nincs memóriaírás write-gate token nélkül. |
| N4 | Harness közvetlen külső hívást próbál | Egress guard blokkolja; prod hálózati enforcement külön S4 hardening. |
| N5 | File tool `../` path traversal | `PATH_TRAVERSAL` / DENY; nincs workspace-kilépés. |
| N6 | Gmail tool acting user vagy grant nélkül | DENY; token nem oldódik fel. |
| N7 | Másik agent privát tudástárának olvasása megosztás nélkül | DENY vagy nincs találat; a tudástár-hozzáférés explicit connector linkhez kötött. |

**Demó sikerfeltétele:**

- A chat-first út legalább egy sima conversationnel végigfut ticket nélkül, és látszik, mikor kell ticketre promotálni.
- A core ticket út kézi DB-módosítás nélkül végigfut jóváhagyott, lezárt ticketig.
- Az Excel/file, Gmail és agent-to-agent lépések élő vagy stub/F2 demóként világosan jelölve vannak; egyik sem mossa össze a core MVP acceptance-szel.
- A végén van legalább egy visszakereshető conversation és egy lezárt ticket, amelyből látszik: agentVersion, recipeVersion, memoryVersion, model/tool call log, human approval, audit chain.
- Az S6 kérdéskészletből legalább a direkt ténykérdések demó közben is átfutnak, és a 7.1 küszöbök szerint kiértékelhetők.

---

## 10. Security baseline (MVP-minimum)

- **Secret:** soha a promptban/runtime-ban; alias + szerveroldali injektálás a Tool Brokerben; GCP Secret Manager. Az OAuth-token a Gatewaynél, szerveroldalon.
- **Egress:** harness-konténer deny-by-default; csak Gateway + Broker.
- **Audit:** append-only, hash-láncolt; `UPDATE/DELETE` megvonva; `verifyChain()`.
- **Human approval:** kötelező a tudásfrissítésnél és a kifelé menő/bizonytalan válasznál.
- **Rate/budget/kill-switch:** per-agent budget cap; eszköz-szintű rate limit; agent-felfüggesztés (`setAgentStatus(suspended)`).
- **Prompt injection:** a dokumentum-/web-tartalom **adat, nem utasítás**; a write-gate token nem csalható ki promptból.
- **Sandbox app preview:** A0 app sandboxed iframe-ben fut; nincs secret, nincs connector, nincs külső hálózati jogosultság. Exportkor hash készül, az export auditált.
- **Lock-out védelem:** utolsó aktív admin nem zárható ki; admin a saját szerepét nem írhatja át.

---

## 11. Mérés / observability (MVP-minimum)

| Dimenzió | MVP-metrika | Forrás |
|---|---|---|
| Hatékonyság | válaszidő / kérdés; becsült kézi keresési idő megtakarítása | `model_calls.latency_ms`, ticket időbélyegek |
| Minőség | citált válaszok aránya; forrás-lefedettség; emberi visszadobási arány | ticket payload + transitions |
| Kontroll | jóváhagyott vs. automatikus lépések; audit-lánc teljessége | `audit_log` + `verifyChain` |
| Költség | (becsült) token/költség per ticket; runtime-költség / nap | `model_calls`, Cloud Run Jobs metrikák |
| Sandbox app | létrehozott appok száma; preview/export események; app-verziók száma | `sandbox_apps`, `sandbox_app_versions`, `audit_log` |

A dashboard MVP-ben egyszerű (Epik 8): aggregált számok + ticketenkénti lebontás. Eval: kis kérdéskészlet + manuális értékelő felület.

---

## 12. Kockázatok és figyelmeztetések

- **Az S2 (OAuth-mediáció) a kritikus út.** A Goose provider ↔ ChatGPT OAuth illeszkedés ismeretlen. Ha a flat-rate kvóta vagy a provider-csatorna nem fér össze a Gatewayjel, az az MVP modellforrását érinti → azonnal Gergő/Koordinátor.
- **A két átjáró nem opcionális.** Ha bármelyik komponens „kényelemből" közvetlenül elérné a modellt vagy egy eszközt, az MVP fő állítása sérül. A negatív tesztek (N1–N4) ezt fogják meg.
- **Scope-fegyelem.** A kísértés, hogy egy komponenst „rendesen" építsünk meg. Minden komponens a **legszűkebb működő formában** készül; a mélységet a use case-ek élesedése hajtja, nem az MVP.
- **App Registry v0 nem válhat rejtett platformépítéssé.** MVP-ben kizárólag A0 single-file HTML preview/export. Ha adatmodell, build pipeline, külső API vagy deploy kell, az Fázis 2.
- **A v1.0 terv 5. epik-szövegének „OpenAI + Gemini" megjegyzése elavult** (D2 előtti maradvány). Mérvadó: **kizárólag ChatGPT OAuth**.
- **Elhalasztott komponensek (terv 1.4 / koncepció 10.B):** sensitivity router, OPA/Cedar, külső memory substrate, hibrid retrieval, saját model hosting — mind **cserepont mögé** építve, nem implementálva. Éles ügyfél előtt újra validálandók.

---

## 13. Definition of Done / átadási checklist

A fejlesztés akkor kész, ha:

- [ ] Mind a 8 epik leszállítva; a 9.1 nyolc kritériuma valódi adaton stabil.
- [ ] A 9.2 négy negatív tesztje (N1–N4) zöld.
- [ ] A 9.3 end-to-end demó kattintható forgatókönyvként lefut.
- [ ] `verifyChain()` zöld egy teljes demó-futás után.
- [ ] Egy lezárt ticketről reprodukálható az agent-/memória-/recipe-verzió.
- [ ] A spike-eredmények (S1–S6) dokumentálva; az elhalasztott cserepontok a kódban jelölve.
- [ ] Rövid mérési riport (9.1/7) elkészült.
- [ ] Secret/egress/audit baseline (10.) auditálva.

---

## 14. Következő dokumentumok (a spec után)

- **S6 eval jegyzőkönyv** — a 7.1 szerinti tényleges futtatási eredmény, kérdésenkénti `hit@1` / `hit@3`, citáció, helyesség, negatív kezelés és választott retrieval-stratégia.
- **Demó runbook / felvételi jegyzet** — a 9.3 kattintható forgatókönyv konkrét dátummal, környezettel, seed/adatverzióval és ismert eltérésekkel.
- **Fázis 2 spec** — governance/biztonsági keménység (write-gate-en túli hardening, observability, deny-by-default humán kapu), ha az MVP kilépési kritériuma teljesült.
- **Per-user connector feature-spec** — `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md`: a `user_delegated` connectorok (Gmail-first) OAuth-flow-ja, `connector_grants` token-vault, Tool Broker runtime-feloldás, acting-user, elfogadási kritériumok és roadmap-illesztés. A séma-kampók (`connectors.auth_mode`, `connector_grants` tábla, `ToolBroker.invoke(..., actingUserId?)`) **már ebben a specben** bekerültek, hogy a feature migráció nélkül illeszthető legyen.

---

## 15. Megvalósítási státusz a jelenlegi kódbázis alapján

**Frissítve:** 2026-06-19
**Állapotjelölés:** `Kész` = működő kód + build zöld; `Részben kész` = van alap, de nem teljesíti még a spec minden kipróbálhatósági kritériumát; `Hátra van` = érdemi implementáció hiányzik.

> **Fontos:** az alábbi táblázat felülírja a 2026-06-15/16-es session-jegyzeteket. A walking skeleton nagy része megvan; a nyitott MVP-lezárás főleg **production hardening** (hálózati egress) és **governance bizonyítás** (S6 tényleges futtatási jegyzőkönyv, 9.3 demó lefuttatása).
>
> **Scope-frissítés (2026-06-19):** a kódbázis tartalmaz több MVP-feletti cserepontot is. Ezeket a 15.4 szakasz külön listázza. Nem törlendők, de **nem számítanak bele az MVP Definition of Done-ba**, és új fejlesztésük előtt külön scope-döntés kell.
>
> **Kód-audit korrekció (2026-06-19, második pass):** egy kód-tényállapot ellenőrzés alapján a következők pontosítva lettek: (1) az **Epik 1 admin tickettípus/átmenet CRUD elkészült** (korábban hátralévőként szerepelt) — lásd §15.2; (2) a §15.4 kibővült a kódban talált, eddig nem dokumentált MVP-feletti elemekkel (**általános/több-agentes runtime, agent-org/persona, Playbook absztrakció, per-agent tudástár+megosztás, chat-first conversation flow**); (3) a §3.2 topológia, a §4 adatmodell, a §5.10 (chat-first) és a §6 (Recipe vs. Playbook) megjelölve, hol tér el a kód a spec eredeti szövegétől. Az **MVP core acceptance és a DoD változatlan**.

### 15.0 Spike-ok

| Spike | Státusz | Megjegyzés |
|---|---:|---|
| **S1** Goose + Cloud Run Job | **Kész** | `wiki-harness` Job, Cloud Build amd64, éles smoke zöld (`harness:cloud-run-smoke`). |
| **S2** ChatGPT OAuth mediáció | **Kész** | Beágyazott provider: `CHATGPT_OAUTH_EMBEDDED` + `CHATGPT_OAUTH_TOKEN_SECRET` (App Hosting). `chatgpt-oauth-bridge.ts` → Codex Responses API; token refresh + SM write-back. Sidecar (`s2:provider`) és `s2:live-smoke` is van. A kódbázisban lévő további provider-adapterek MVP-feletti cserepontok (lásd 15.4); az MVP-demó hivatalos útja ChatGPT OAuth. |
| **S3** Tool Broker MCP | **Kész** | `platform-mcp-bridge`, Goose config, acceptance [17–18]. |
| **S4** Egress + dev-extension | Részben kész | App-szintű guard + N4 acceptance zöld. **Hálózati** deny-by-default prod Job-on még nincs (`HARNESS_EGRESS_ENFORCE=false`). |
| **S5** Write-gate | **Kész** | Token issue/consume, N3 negatív tesztek zöldek. |
| **S6** Retrieval minőség | Dokumentálva, futtatási jegyzőkönyv hátra | Eval plan, kérdéskészlet, küszöbök és determinisztikus retrieval-teszt a 7.1-ben. Következő: tényleges dataset-futtatás és jegyzőkönyv. |

### 15.1 Elkészült / részben elkészült elemek

| Terület | Státusz | Megjegyzés |
|---|---:|---|
| Next.js control plane + sandbox | **Kész** | Board, wiki sandbox, beszélgetés-elsődleges flow (CR-MVP-003), agent chat, governance oldal. |
| Prisma/Postgres + séma | **Kész** | Spec §4 entitások nagy része; conversations, scheduled tasks, file workspace a spec feletti bővítések (lásd 15.4). |
| Recipe-katalógus | **Kész** | §6 `wiki-answer`, governance audit, agent snapshot link. |
| Ticket-állapotgép + transitions | **Kész** | Szerveroldali validáció, tiltott átmenet audit, UI idővonal. |
| Dispatcher + harness | **Production dispatcher kész + deployolva** | `dispatcher-worker.ts` (`LISTEN/NOTIFY` + cron + health-szerver), `Dockerfile.dispatcher`, `deploy-dispatcher-service.sh`. **Élesben fut:** `wiki-dispatcher` Cloud Run service (`enterprise-ai-demo`, europe-west4, `minScale=1`, `cpu-throttling=false`), dedikált runtime SA `run.jobs.runWithOverrides`-szal. Igazolt lánc: `ready→in_progress` (NOTIFY 0s) → `dispatch.start` → harness goose valódi Gateway model-hívások → budget cap. **Admin kill-switch + cron-intervallum** runtime állítható a `/control-plane/system` oldalról (`platform_settings` tábla, élesben tesztelve). **Nyitott (harness/S6, nem dispatcher):** a `wiki-answer` recipe nem konvergál a Gateway 20-hívásos guardrailje alatt. |
| Append-only audit | Részben kész | `verifyChain()` + UI; Postgres `UPDATE/DELETE` tiltás nincs igazolva. |
| IAM/RBAC | **Kész** | Meghívás/redeem UI (`/control-plane/iam`), lock-out, kill-switch, acceptance zöld. |
| Agent Registry | **Kész** | Szerep/viselkedés külön verzió, recipe snapshot, governance kártyák. |
| Model Gateway | **Kész (S2)** | `chatgpt-oauth` beágyazott OAuth, guardrail, latency/status napló. `gemini` és `ollama` csak MVP-feletti provider-cserepontként kezelendő. |
| Tool Broker | **Kész** | MCP bridge, kb_search, board_write. A per-user connector / Gmail ág Fázis 2 scope (lásd 15.4). |
| Sandbox App Registry A0 | **Kész** | Preview iframe, verzió, export + hash, audit. |
| Training / write-gate | **Kész** | §5.8 protokoll, negatív tesztek. |
| Governance / mérés | Részben kész | Mérési riport Markdown export; S6 eval plan és 9.3 demo script dokumentálva; **hátra:** futtatási jegyzőkönyv + demó lefuttatása. |
| Build / lint | **Kész** | `npm run lint` + `npm run build` zöld. |

### 15.2 Hátralévő feladatok epik szerint

| Epik | Státusz | Hátralévő munka |
|---|---:|---|
| Epik 1 — Control Plane | **Kész** | `adminUpsertTicketType` CRUD **implementálva** (`platform.ts` server action + `getTicketTypeConfigs` + `platformSettings.upsertTicketTypeConfig` + `ticket-type-config-panel.tsx` UI a `/control-plane/system` oldalon). |
| Epik 2 — IAM | **Kész** | Clerk webhook szinkron finomítás (Fázis 2). |
| Epik 3 — Registry + Gateway | **Kész** | S2 lezárva; nem-ChatGPT provider-adapterek MVP-feletti cserepontként dokumentálva. |
| Epik 4 — Tool Broker | **Kész** | Prod connector secret rotáció üzemeltetése. |
| Epik 5 — Harness + Dispatcher | Részben kész | **Production dispatcher deployolva és igazolva** (Cloud Run service + runtime SA, end-to-end audit-nyom). **Következő kritikus:** harness/recipe konvergencia a 20-hívásos guardrail alatt (S6) + hálózati S4 egress (VPC/NAT/firewall). |
| Epik 6 — Tanítás | **Kész** | Retrieval-napló UI finomítás opcionális. |
| Epik 7 — Sandbox + App Registry | **Kész** | `generateReport` API (§5.10) **implementálva**: előre definiált riport-sablon katalógus (`src/domain/report/report-templates.ts`), `services.wiki.generateReport` (interakciós `ready` ticket a wiki-runtime-on át → kb_search → Gateway → board_write), `generateReport` + `listReportTemplatesAction` server action, és wiki sandbox UI riport-kártya. |
| Epik 8 — Governance | Részben kész | S6 futtatási jegyzőkönyv; 9.3 demó lefuttatása; §13 checklist végigpipálása. Eval **backend** kész (`Eval`/`EvalRun` modell, `createEval`/`runEval`/`listEvals` action, `approval_mode: eval_only \| auto_after_eval`), de **dedikált manuális értékelő UI-oldal** még nincs (csak az audit oldalról hivatkozott). |

### 15.3 Következő javasolt fejlesztési sorrend

1. ~~**Production dispatcher**~~ — **KÉSZ (2026-06-18).** `wiki-dispatcher` Cloud Run service él (`min-instances=1`, always-on CPU), dedikált runtime SA `run.jobs.runWithOverrides`-szal; a teljes lánc audit-nyommal igazolva. Lásd `app/infra/gcp/CLOUD-RUN-DISPATCHER-SETUP.md` §6.
2. **Hálózati S4 egress** — VPC connector + NAT + firewall; Job-on `HARNESS_EGRESS_ENFORCE=true`.
3. **MVP lezárás (Epik 8)** — S6 futtatási jegyzőkönyv, 9.3 kattintható demo végigfuttatása, §13 DoD checklist.
4. ~~**`generateReport` API (§5.10)**~~ — **KÉSZ.** Előre definiált riport-sablon katalógus + wiki-runtime-on át a tudásbázisból generált riport-ticket; server action + sandbox UI; build/lint zöld.
5. **Eval értékelő UI** — a meglévő eval backend (`Eval`/`EvalRun`) fölé egy minimális manuális értékelő oldal (Epik 8).
6. **Audit DB-szintű védelem** — `audit_log` táblára `UPDATE`/`DELETE` megvonás az alkalmazás-szerepkörnek (jelenleg csak app-szintű `AuditService.append()`).
7. **Üzemeltetés** — OAuth token rotáció runbook, harness image CI, audit DB jogosultságok.

> **Megjegyzés (2026-06-19, kód-audit):** az Epik 1 admin tickettípus/átmenet CRUD a korábbi listával ellentétben **már elkészült** (lásd §15.2), ezért lekerült a következő lépések közül.

### 15.4 MVP-feletti, de már jelen lévő képességek

Ezek a képességek a jelenlegi repóban részben vagy egészben léteznek, de **nem növelik az MVP scope-ját**. A fejlesztés során nem ezek mélyítése az alapértelmezett következő lépés; ha ilyen irányba kell menni, külön döntés szükséges.

| Képesség | Kódbázisban látható állapot | Scope-döntés |
|---|---|---|
| **Gemini / Ollama provider** | Model Gateway adapterek és konfigurációs útvonalak megjelentek. | MVP-feletti modell-cserepont. Az MVP acceptance és demó továbbra is `chatgpt-oauth` providerrel fut. |
| **Per-user connector / Gmail** | `connector_grants`, Gmail OAuth/token-vault runtime, S7 smoke és kapcsolódó UI/API elemek vannak. | Fázis 2 feature a külön per-user connector spec alapján. Az MVP Tool Broker követelménye: `kb_search` + `board_write`, service-módú connectorral. |
| **File editor / workspace tools** | Külön feature-spec, domain adapterek, workspace storage és Playwright E2E vannak. | Külön feature-scope. Nem része a core wiki-agent MVP lezárásának. |
| **Scheduled / recurring task felület** | `scheduled-task` domain, UI és recurrence logika megjelent. | Fázis 2 / későbbi proaktív monitor irány. Az MVP-ben csak az `execute_after` mező és az azonnali dispatcher indítás kötelező. |
| **Általános / több-agentes runtime** | A wiki-runtime mellett `bookkeeper-runtime`, `general-task-runtime`, `agent-chat-runtime` és `chat-tool-loop` is van; az `agent-kind.ts` `wiki \| bookkeeper \| generic` típusokra routol, a nem-wiki ticketeket egységes general task runtime futtatja. | MVP-feletti cserepont. A v1.0 terv az MVP-t **wiki-agentre** szűkíti; a többi runtime létezik, de **nem része a core MVP acceptance-nek**. A két átjáró + audit elve rájuk is érvényes. |
| **Agent-„org" / persona / katalógus** | `agent-org-roster.ts`, `agent-persona.ts`, `agent-catalog.ts`, `dashboard-agent-card` — a UI agent-csapatot (nickname, persona) prezentál. | MVP-feletti prezentációs réteg. Az MVP-modell egyetlen verziózott wiki-agent; a roster/persona nem MVP-követelmény. |
| **Playbook absztrakció** | A `Recipe`/`RecipeVersion` mellett külön `Playbook`/`PlaybookVersion` modell + `playbook-service.ts` + `playbook-spec.ts`. | MVP-feletti absztrakció. A §6 recipe-formátum a mérvadó MVP-kontraktus; a Playbook réteg viszonyát a §6 megjegyzése tisztázza. |
| **Per-agent tudástár + megosztás** | `Resource`/`AgentResource` modellek, `agent-knowledge-base.ts`, `agent-knowledge-base-panel`, agentek közti tudástár-megosztás (`platform.ts`). | Bővített scope (a 9.3 demó 3–4. lépése). Az MVP core követelménye egyetlen wiki KB connector; a per-agent tudástár + megosztás MVP-feletti. |
| **Chat-first / conversation flow** | `Conversation`/`Message` modellek, `conversation-service.ts`, `agent-chat-panel`, chat sidebar, OpenAI-kompatibilis gateway chat completions endpoint (CR-MVP-003). | Bővített scope (9.3 demó 5–9. lépés). A core MVP §5.10 állapotmentes Q&A útja a mérvadó; a chat-first runtime komponens-specje a §5.10 kiegészítésében. |

**MVP-lezárási prioritás változatlan:** S4 hálózati egress igazolás, S6 futtatási jegyzőkönyv, 9.3 demó végigfuttatása, §13 DoD checklist, majd az Epik 1 admin tickettípus/átmenet CRUD maradéka.

---

*Forrásalap: `AI-Agent-Platform-MVP-Terv-v1.0.md` (2026-06-15, scope-frissítés: 2026-06-19). **S2 (ChatGPT OAuth) 2026-06-18-án lezárva** beágyazott Secret Manager mediációval. A Gemini/Ollama provider, a per-user Gmail connector, a file editor és a scheduled task ág MVP-feletti cserepontként / külön feature-scope-ként kezelendő. A D1/D3/D4/D6/D7 döntések változatlanok.*
