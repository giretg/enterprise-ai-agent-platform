# Kontrollált Enterprise AI Agent Platform — MVP fejlesztési specifikáció és roadmap (walking skeleton)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0 + CR-MVP-001 + CR-MVP-002 + CR-MVP-003 — fejlesztői átadási csomag
**Dátum:** 2026-06-15; CR-MVP-001 hozzáadva: 2026-06-16; CR-MVP-002 + CR-MVP-003: 2026-06-17
**Forrásdokumentum:** `AI-Agent-Platform-MVP-Terv-v1.0.md` (architektúra-teljes MVP / walking skeleton)
**Háttér:** `AI-Agent-Platform-Koncepcio.md` (v0.10)
**Olvasó:** a fejlesztő(k). Direkt, technikai. Feltételezi az MVP-terv ismeretét.
**Státusz:** kivitelezésre kész — a nyitott döntések (D1, D3, D4, D6) ebben a dokumentumban default-javaslattal **lezárva** (lásd 1. fejezet). A CR-MVP-001 új, levágható stretch elem; nem része az eredeti core MVP acceptance gate-nek. A **CR-MVP-002** (2026-06-17) a koncepció v0.8 → v0.9 változásait vezeti át — konfigurálható szerepek, per-agent önfejlesztési profil, Playbook-elsődleges végrehajtás; részletek a 0.1 CR-logban, a D8 döntésben és az 5.12 szakaszban. A **CR-MVP-003** (2026-06-17) a koncepció v0.9 → v0.10 interakciós-modell átkeretezését vezeti át — **beszélgetés-elsődleges interakció, a board opcionális koordinációs réteg, a kötelező jóváhagyási kapu leválik a ticketről, és új beszélgetés-/session-réteg**; részletek a 0.1 CR-logban, a D9 döntésben és az 5.13 szakaszban. **Scope:** az MVP-be csak olcsó séma-horgok és invariánsok kerülnek; a teljes multi-agent / orchestrator-flow, a BPMN-szerű Playbook és a kritikussági-szintezett (L0–L3) jóváhagyási kapu **Fázis 2**.

---

## 0. Mit ad ez a dokumentum

Az `AI-Agent-Platform-MVP-Terv-v1.0.md` eldönti **mit** építünk: egy architektúra-teljes, valódi (nem mockolt) walking skeletont, amelyben a platform minden komponense alapszinten összeáll, és az első "lakó" agent egy belső **tudás-asszisztens (wiki-agent)**. Ez a dokumentum azt adja meg, **hogyan** építjük meg: komponensenkénti API-k, teljes adatmodell, a Goose-recipe formátuma, a write-gate token protokollja, az állapotgép, a spike-protokollok és a sprintre bontott roadmap.

**Vezérelv (a tervből változatlanul):** az MVP célja **nem egy use case bizonyítása**, hanem hogy **minden architektúra-komponens egy alapszinten működjön és egy valódi végigfutásban összeálljon**. A wiki-agent cseppszabatos paraméterezés — a váz onnantól bármilyen agenttel feltölthető a kód érdemi átírása nélkül.

> **Fontos elhatárolás:** ez **nem** az `AI-Agent-Platform-Fazis1-Spec.md`-ben leírt rendszer. Az a régi v0.1 koncepcióra épült (kattintható mockup, könyvelő/számla-agent, Gemini/Claude modell). Ez a spec a **v1.0 walking skeletont** specifikálja: **wiki-agent**, **kizárólag ChatGPT OAuth** modellforrás, **Goose harness Cloud Run Jobban**, **Tool Broker + dispatcher**. A két anyag nem keverendő.

### 0.1 Change request log

Ez a fejezet fejlesztői olvasatra külön jelöli, ha az eredeti v1.0 MVP scope-hoz képest új elem került a specifikációba. Az érintett részekben a change request azonosítója szögletes zárójelben szerepel.

| CR | Dátum | Új elem | MVP-hatás | Fejlesztői státusz |
|---|---|---|---|---|
| **CR-MVP-001** | 2026-06-16 | Sandbox App Container / App Registry v0 | A wiki-riport A0 single-file HTML preview/export formája. Stretch / demo-bónusz; nem blokkolja a core MVP-t. | Csak akkor implementálandó, ha S1-S4/S2 zöld és a core wiki E2E nem csúszik. |
| **CR-MVP-002** | 2026-06-17 | Koncepció v0.9: (a) konfigurálható agent-szerepek (nincs beégetett „fő-agent", orchestrator = tool-less szerep); (b) per-agent önfejlesztési profil (write-gate kapu-erősség tárcsa); (c) Playbook-elsődleges végrehajtás (hozzárendelhető, verziózott, állapotgépre fordított Playbook) | **MVP:** olcsó séma-horgok + invariánsok (`self_evolution_profile`, `agents.role`, `playbooks`/`playbook_versions`, `tickets.playbook_ref`, „önmódosítás nem bővít jogosultságot" invariáns). **Fázis 2:** teljes orchestrator-flow + BPMN-szerű Playbook. | **Kész (2026-06-17, session 18):** MVP-horgok implementálva + acceptance zöld — scenario [27], **N6**. Részletek: 15.1. Teljes orchestrator-flow + BPMN-szerű Playbook = Fázis 2 (D8). |
| **CR-MVP-003** | 2026-06-17 | Koncepció v0.10: **beszélgetés-elsődleges interakciós modell** — a board opcionális koordinációs réteg (nem univerzális kötelező interfész); a governance forrása a kontrollált runtime, nem a ticket; a kötelező jóváhagyási kapu **leválik a ticketről** (kritikussági szint vezérli); új **beszélgetés-/session-réteg**; tenant-izoláció határa az agent | **MVP:** olcsó séma-horgok + invariánsok (`conversations`/`messages` tábla tenant-scope-pal és content/metadata szétválasztással; `askWiki` beszélgetés-elsődleges; „a kötelező kapu nem a ticket meglététől függ" invariáns; audit-lefedettség ticket nélkül is). **Fázis 2:** teljes beszélgetés-UI több agenttel, kritikussági-szintezett (L0–L3) kapu, activity feed. | **Kész (2026-06-17, session 18):** MVP-horgok implementálva + acceptance zöld — scenario [28], **N7**, **N8**; scenario [1] átállítva beszélgetés-elsődleges flow-ra. Részletek: 15.1. Teljes beszélgetés-UI + L0–L3 kapu = Fázis 2 (D9). |

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
| D7 | Sandbox App Container / App Registry **[CR-MVP-001]** | **Stretch / demo-bónusz** | A0 single-file HTML riportnézet + preview + `.html` export akkor fér bele, ha S1-S4/S2 nem csúszik; A1-A3 app-platform, adatmodell-generálás, deployment és graduation Fázis 2 |
| D8 | Koncepció v0.9 átvezetés **[CR-MVP-002]** | **MVP: séma-horgok + invariánsok; teljes flow = Fázis 2** | A walking skeletonban 1 agent fut, nincs multi-agent flow — ezért most csak a nem-ütköző horgokat építjük: konfigurálható `agents.role` (+ tool-less orchestrator séma), `self_evolution_profile`, `playbooks`/`playbook_versions` + `tickets.playbook_ref`, és a „önmódosítás nem bővít jogosultságot" kemény invariáns (N6). A tényleges orchestrator-agent és a többlépéses, BPMN-szerű Playbook-vezérlés Fázis 2. Indok: a kódbázis közel kész — a cél, hogy ne égessen be a v0.9-cel ütköző feltevést (egyetlen privilegizált agent, csak promptból vezérelt flow). |
| D9 | Koncepció v0.10 átvezetés **[CR-MVP-003]** | **MVP: beszélgetés-séma + kapu-leválasztási invariáns; teljes beszélgetés-UI és L0–L3 kapu = Fázis 2** | A walking skeleton wiki-flow-ja ne égesse be a „minden kérdés = ticket" feltevést. MVP-horgok: (1) `conversations`/`messages` tábla (tenant-scope, content/metadata szétválasztás a GDPR-törléshez — 4.10); (2) `askWiki` beszélgetés-elsődleges: a kérdés egy **conversation/message**, ticket csak határátlépéskor (jóváhagyásra küldés / delegálás / ütemezés) keletkezik (5.10, 5.13); (3) kemény invariáns: a kötelező jóváhagyási kapu **szerveroldali és nem a ticket meglététől függ** (write-gate token, Tool Broker `authorize()`, transition-szabályok — ezek ticket nélkül is élnek), bizonyíték N7; (4) audit + `verifyChain` ticket nélküli beszélgetésre/végrehajtásra is teljes, GDPR-törlés után is ép (N8). A kritikussági-szintezett (L0–L3) automatikus eszkaláció, a teljes multi-agent beszélgetés-UI és az activity feed **Fázis 2**. Indok: a kódbázis közel kész — a beszélgetés-szubsztrát és a kapu-leválasztás olcsó horog most, de drága utólag. |

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

---

## 4. Adatmodell (Postgres, részletes)

A v1.0 terv 3.12 entitásai kibontva. A mezők indikatívak; a migrációban finomítandók, de a kulcsmezők és kapcsolatok kötelezőek. Minden `id` UUID (pk), minden időbélyeg `timestamptz`, tárolás UTC.

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
role (enum: worker | orchestrator, default worker)   -- [CR-MVP-002] konfigurálható szerep; NINCS beégetett „fő-agent". orchestrator = tool-less, csak delegál (teljes flow Fázis 2)
self_evolution_profile (jsonb, nullable)    -- [CR-MVP-002] { scope:[memory|behavior|role], approval_mode: human|higher_role|eval_only|auto_after_eval, diff_limit } — a write-gate (5.8) kapu-erőssége. A verziózás+rollback+audit és a szerveroldali, egyszer használatos token MINDIG kötelező, nem kapcsolható ki. NULL = legszigorúbb (human).
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

> **[CR-MVP-003] A ticket nem kötelező belépőpont.** A ticket akkor keletkezik, ha a munka **határt lép át** (idő = `execute_after`/ütemezés; átadás = másik agent/ember; jóváhagyás/visszajelzés). Az egyszerű ember↔agent interakció ettől független: beszélgetés (4.10) + azonnali végrehajtás, ticket nélkül — a governance (audit, capability, write-gate) akkor is teljes (koncepció 4.2). Ha egy beszélgetésből ticket lesz, a `conversation_id`-re visszahivatkozik (4.10). A **kötelező jóváhagyási kapu nem a ticket-állapotgép meglététől függ** (5.13, N7).

### 4.6 Connector / capability

**`connectors`** *(first-class erőforrás)*
```
id, type (enum: knowledge_base | board | ...), name
scope (enum: global | single), secret_alias (text, nullable)
version (int), config (jsonb), tenant_id, created_at
```

**`agent_connectors`** *(many-to-many, access-mode)*
```
agent_id (fk), connector_id (fk), access_mode (enum: read | write)   -- pk(agent_id, connector_id)
```

**`capabilities`** *(deny-by-default eszközjog)*
```
agent_id (fk), tool_name (text), allowed (bool)                      -- pk(agent_id, tool_name)
```

> **[CR-MVP-002] Invariáns (kemény padló):** a `capabilities` és `agent_connectors` sorokat **kizárólag admin-aktus** írhatja az Agent Registryn (5.3) keresztül. Az önfejlesztési / tanítási útvonal (5.8) **soha** nem módosíthatja — egy agent önmódosítással **nem** bővítheti a saját jogosultságait / eszköz-hozzáférését (OWASP LLM06, Excessive Agency). Kötelező negatív teszt: **N6** (9.2).

### 4.7 Naplók

**`model_calls`** *(Model Gateway napló)*
```
id, ticket_id (fk, nullable), conversation_id (fk conversations, nullable)   -- [CR-MVP-003] ticket nélküli beszélgetésben ezen attribútálódik
agent_id (fk), agent_version (int)
model (text), prompt_tokens (int, nullable), completion_tokens (int, nullable)
cost_estimate (numeric, nullable)        -- flat-rate kvóta → becsült/aggregált
latency_ms (int), status (enum: ok | error | rate_limited)
created_at
```
> **Kvóta-megjegyzés (D2 következménye):** a ChatGPT OAuth flat-rate → a pontos per-call költség nem feltétlenül elérhető. A `cost_estimate` ezért **becsült/aggregált** mező; az MVP a hívásszámot és a token-becslést naplózza, a pontosság nem elvárás.

**`tool_calls`** *(Tool Broker napló)*
```
id, ticket_id (fk, nullable), conversation_id (fk conversations, nullable)   -- [CR-MVP-003]
agent_id (fk), agent_version (int)
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

**`sandbox_apps`** *(stretch App Registry — A0 single-file riportnézet, [CR-MVP-001])*
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

**`sandbox_app_versions`** *(verziózott, letölthető artefakt, [CR-MVP-001])*
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

**[CR-MVP-001] MVP-korlát:** ez stretch scope, nem hard acceptance gate. Nincs többfájlos build, nincs sandbox-adatmodell generálás, nincs automatikus deploy és nincs külső connector-hozzáférés az appból. A preview külön originről kiszolgált sandboxed iframe-ben fut szigorú CSP-vel; az export `.html` letöltés + hash.

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

> **[CR-MVP-003] GDPR-kompatibilis retenció (content/metadata szétválasztás).** Az `audit_log` **immutábilis metaadat** — esemény, hash, actor, ts —, ez **nem törölhető** (tamper-evidence). A törölhető **tartalom** (pl. a beszélgetés üzenetszövege) **nem** az `audit_log`-ban él, hanem a `messages.content_ref` mögött (4.10), külön törölhetőséggel. Így a GDPR-törlés a tartalmat viszi, az auditcsontváz és a hash-lánc **ép marad** (`verifyChain` zöld). Bizonyíték: **N8** (9.2). Szabály: nyers üzenet-/PII-tartalom **soha** nem kerül az `audit_log.payload`-ba (csak referencia/hash).

### 4.8b Ticket-független végrehajtás-napló (jegyzet)

> **[CR-MVP-003]** Mivel a beszélgetés-elsődleges interakció ticket nélkül is fut, a `model_calls` (4.7) és `tool_calls` (4.7) `ticket_id`-je **nullable** (már az is) — ezekhez a `conversation_id` (4.10) köthető, így a ticket nélküli végrehajtás is teljesen attribútálható és auditálható.

### 4.9 Playbook — a folyamat forrás-igazsága [CR-MVP-002]

> A koncepció v0.9 **Playbook-elsődleges** döntése (koncepció 4.10/4.10.6). MVP-ben **séma + 1 triviális, 1-szereplős wiki-Playbook**; a többlépéses, multi-agent vezérlés Fázis 2 (D8). A Playbook **nem** a recipe (6.) és **nem** az audit-forrás — a forrás-igazság a szándékolt flow, a tényleges flow az audit-logból jön.

**`playbooks`** + **`playbook_versions`** *(önálló, verziózott, hozzárendelhető dokumentum)*
```
playbooks:         id, name, process_type (text), tenant_id, created_at
playbook_versions: id, playbook_id (fk), version (int)
                   spec (jsonb)        -- GÉPIESEN OLVASHATÓ: [{ ticket_type, role, transitions, required_gates }]
                   status (enum: proposed | active | retired)
                   approved_by (fk users, nullable), created_at
```

A `tickets` tábla (4.5) **[CR-MVP-002]** kiegészül:
```
playbook_ref (text, nullable)     -- "playbook:<name>@vN" — folyamatindításkor PIN-elve, a lefutás alatt FIX; auditba kerül
```

**Elv (kötelező):** a kötelező jóváhagyási kapuk a `playbook_versions.spec`-ből **fordulnak** a ticket-állapotgép (5.1) konfigurációjába — a Playbook szövege az agent promptjában csak *puha* iránymutatás, a **kemény kapu szerveroldali** (egyezik a koncepció 4.10.4/4.10.6-tal). A flow-t a **determinisztikus állapotgép** lépteti, **nem LLM**. Folyamatindításkor a `playbook_ref` az audit-logba kerül (`process.start`), és a PIN-elt verzió a lefutás végéig nem cserélődik (reprodukálhatóság).

### 4.10 Beszélgetés / session [CR-MVP-003]

> A koncepció v0.10 **beszélgetés-elsődleges** döntése (koncepció 4.2/4.14). A beszélgetésszál a ticket és az agent mellett **harmadik first-class, control plane-birtokolt entitás** — **nem** azonos a Goose futtatási sessionnel (az efemer; ez tartós és sok futáson átível). MVP-ben séma + a wiki-flow erre kötése; a teljes többszálú beszélgetés-UI Fázis 2 (D9).

**`conversations`** *(tartós szál; tenant-scoped)*
```
id, tenant_id (uuid)              -- [CR-MVP-003] per-tenant zárt; nincs tenantok közti megosztás (10., koncepció 8.8)
agent_id (fk)                     -- melyik agenttel folyik (MVP: a wiki-agent)
title (text, nullable), created_by (fk users), status (enum: active | archived)
created_at, updated_at, last_message_at
```

**`messages`** *(fordulónkénti rekord; a tartalom külön törölhető)*
```
id, conversation_id (fk conversations), seq (int)        -- sorrend a szálon belül
role (enum: user | agent | system)
agent_version (int, nullable), model (text, nullable)    -- reprodukálhatóság (4.5); melyik verzió/modell kezelte a fordulót
content_ref (text, nullable)      -- a TÖRÖLHETŐ payload (szöveg/PII) — GCS/DB-blob, NEM az audit_logban (4.8 GDPR-szabály)
content_deleted_at (timestamptz, nullable)   -- GDPR-erasure: a tartalom törölve, a rekord-csontváz + audit marad
ticket_ref (fk tickets, nullable) -- ha ebből a fordulóból ticket lett (delegálás/jóváhagyás/ütemezés)
created_at
```

**Elvek (kötelező):**

- **Beszélgetés-memória ≠ agent-memória.** A `messages` előzmény **scratch-kontextus**; **soha** nem írja az agent tartós tudását (`memory_versions`, 4.4). Tudás-beemelés kizárólag a write-gate-en (5.8) át, tanítási ticketként — egyébként a koncepció 4.6/4.14 elhatárolása sérülne.
- **Kontextus-rehydration.** Mivel a harness állapotmentes, dispatch (5.7) előtt egy explicit *context assembly* lépés tölti vissza a releváns korábbi fordulókat + memóriát + dokumentumokat (nem a teljes előzményt — token-ökonómia, koncepció 4.8.3/4.11).
- **Tenant-izoláció.** A `conversations`/`messages` mindig `tenant_id`-scope-olt; mivel az agentek sem oszthatók meg tenantok között (10., koncepció 8.8), a beszélgetés-tér is per-tenant zárt.
- **GDPR-erasure.** A tartalom törlése a `content_ref`-et üríti és `content_deleted_at`-et állít; a `messages` rekord-csontváz és az `audit_log` (4.8) **marad** — `verifyChain` zöld (N8).

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
Authorizer.authorize(agentId, tool, args) -> { allowed: boolean, reason? }   -- MVP: AllowlistAuthorizer
ToolBroker.invoke({ agentId, agentVersion, ticketId, tool, args })
  -> { result, resultMeta, latencyMs }    -- nem engedélyezett → { denied, reason } + audit-flag
```
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
askWiki({ agentId, question, conversationId? })             [operator+]
  -> { conversationId, messageId, answer, sources[], rationale }
     -- [CR-MVP-003] BESZÉLGETÉS-ELSŐDLEGES: a kérdés egy conversation/message (4.10),
        nem automatikusan ticket. Új szál, ha conversationId nincs megadva.
promoteToTicket({ conversationId, type, reason })           [operator+]
  -> { ticketId }    -- [CR-MVP-003] határátlépéskor: jóváhagyásra küldés / delegálás / ütemezés
getConversation({ conversationId }) -> { messages[], state }   [viewer+]
generateReport({ agentId, templateId }) -> { ticketId }    [operator+]   -- 1 előre definiált riport-sablon
```

> **[CR-MVP-003] Beszélgetés-elsődleges wiki-flow.** Az alap kérdés→citált válasz interakció **ticket nélkül** fut (a wiki-retrieval read-only, alacsony kockázat — koncepció L0–L1). Ticket akkor keletkezik, ha a felhasználó **jóváhagyásra/megőrzésre** küldi az eredményt, vagy delegál/ütemez (`promoteToTicket`). A régi „minden kérdés = ticket" viselkedés visszafelé kompatibilis úton elérhető, de **nem** az alapértelmezés.

**Kipróbálható, ha:** a felhasználó végigvisz egy **beszélgetés**-alapú kérdés→citált válasz folyamatot **ticket nélkül**, és az minden lépése (model/tool-hívás) a `conversation_id`-n keresztül auditban látszik; külön, ha az eredményt jóváhagyásra küldi, abból ticket lesz, ami a `conversation_id`-re visszahivatkozik; mindkét út a boardon/auditban / activity-nézetben követhető.

#### 5.10.1 Sandbox App Container / App Registry — stretch / demo-bónusz [CR-MVP-001]

**Change request megjegyzés:** ez a rész a CR-MVP-001 új eleme. Igen, ebből tehető valami nagyon alap az MVP-be, de **stretchként**, nem kemény acceptance criteriaként. Csak **A0 single-file app** szinten fér bele, és a wiki-pilothoz kell kötni: az A0 app a generált riport önálló, megnyitható HTML-nézete. Ha S2 vagy a Goose-harness kritikus út csúszik, ez az első levágható elem.

**MVP in scope:**
- App Registry lista a sandboxban: név, státusz, verzió, létrehozó, létrehozó ticket/agent.
- Egyetlen app-típus: `single_html` (HTML/CSS/JS egy fájlban; külső dependency futását CSP blokkolja).
- Preview külön, cookieless originről; iframe `sandbox="allow-scripts"` **`allow-same-origin` nélkül**.
- Preview CSP minimum: `default-src 'none'; connect-src 'none'`; inline JS-hez kontrollált `script-src` policy. Ezzel nincs platform-session, nincs API-hozzáférés, nincs hálózat/secret/connector.
- Verzió létrehozása és aktiválása; régi verzió megtekinthető vagy visszaállítható.
- Export: `.html` letöltés + `content_hash` megjelenítése; export után a fájl biztonsági szintje olyan, mint bármely letöltött HTML fájlé.
- Audit: létrehozás, verziózás, preview/export és cross-tenant access-denied esemény.

**Out of scope MVP-ben:** többfájlos app bundle, npm build, app-saját adatmodell, külső API/connector az appból, deploy ügyfélkörnyezetbe, Docker/Git export, automatikus A1-A3 graduation.

**API:**
```
createSandboxApp({ name, description, createdFromTicketId? })
  -> { appId }                                           [operator+]
upsertSandboxAppVersion({ appId, html, changeSummary })
  -> { versionId, version, contentHash }                 [operator+ vagy agent toolon át]
listSandboxApps() -> { apps[] }                          [viewer+]
getSandboxAppPreviewUrl({ appId, version? })
  -> { previewUrl, contentHash }                         [viewer+] -- külön preview-origin
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
agent.self_evolution_profile_change | training.capability_escalation_denied   -- [CR-MVP-002]
playbook.create | playbook.version | playbook.approve | process.start   -- [CR-MVP-002] (process.start payload: playbook_ref pin)
conversation.create | message.append | message.content_deleted | conversation.promote_to_ticket   -- [CR-MVP-003] (tartalom NEM a payloadban, csak ref/hash; ticketless interakció is auditált)
sandbox_app.create | sandbox_app.version | sandbox_app.preview | sandbox_app.export | sandbox_app.access_denied   -- [CR-MVP-001]
```
**Kipróbálható, ha:** a demó végén egy adott eredményhez megmutatható a **teljes láncolat**: input → agent-/memória-/recipe-verzió → modell- és eszközhívások → jóváhagyó; és a `verifyChain()` zöld.

### 5.12 Konfigurálható szerepek, önfejlesztési profil és Playbook-elsődleges végrehajtás [CR-MVP-002]

A koncepció v0.8 → v0.9 három pontjának fejlesztői átvezetése. **Scope-fegyelem (D8):** a walking skeletonban egyetlen wiki-agent fut, ezért most a **nem-ütköző séma-horgokat és invariánsokat** építjük; a teljes multi-agent orchestrator-flow Fázis 2. A három horog olcsó, de a közel kész kódbázist megóvja a v0.9-cel ütköző feltevésektől.

#### 5.12.1 Konfigurálható agent-szerepek — nincs beégetett „fő-agent"

**Felelősség:** az agent-szerep konfiguráció, nem hardcode. Az `agents.role` (4.2) `worker | orchestrator`; a kód **nem** feltételezhet egyetlen privilegizált agentet.

- **MVP:** a wiki-agent `worker`. Kötelező: a registry/runtime ne égessen be „mester-agentet", és az `orchestrator` enum-érték + a **tool-less szabály** sémaszinten létezzen (orchestratornak nincs `capabilities` write-sora; egyetlen kimenő művelete a ticket-nyitás — 5.1).
- **Fázis 2:** tényleges orchestrator-agent, amely Playbookra hivatkozva delegál (koncepció 4.5.1), felhasználó-néző beszélgetési belépőpontként.

**Kipróbálható, ha:** létrehozható `orchestrator` szerepű agent, amelynek **nincs** eszközjoga; a rendszer sehol nem hivatkozik kódba-égetett „fő-agentre".

#### 5.12.2 Önfejlesztési profil — write-gate kapu-erősség per agent

**Felelősség:** az `agents.self_evolution_profile` (4.2) a write-gate (5.8) jóváhagyási útvonalát **agentenként** állítja. Az `approveTraining` a profil `approval_mode`-ja szerint választ kaput; a `scope`/`diff_limit` korlátozza, mit és mennyit érinthet egy ciklus.

- **Mindig kötelező (nem kapcsolható ki):** verziózás + rollback + audit (5.8) és a szerveroldali, egyszer használatos write-gate token.
- **Kemény padló:** az önfejlesztési / tanítási útvonal **soha** nem ír `capabilities` / `agent_connectors` sort (4.6 invariáns, N6).

**API-delta:**
```
getAgent(...) -> AgentDetail                                  -- kiegészül a self_evolution_profile-lal
updateAgentSelfEvolutionProfile({ agentId, profile }) -> Agent     [admin]
```

**Kipróbálható, ha:** `approval_mode='human'` agentnél a diff emberi jóváhagyás nélkül **nem** promótál; `eval_only`-nál fut az eval és a verziózás; egyik módban sem lehet a profillal jogosultságot bővíteni.

#### 5.12.3 Playbook-elsődleges végrehajtás

**Felelősség:** a többlépéses folyamat forrás-igazsága a `playbooks` / `playbook_versions` (4.9) dokumentum; a `tickets.playbook_ref` PIN-eli a verziót; a kötelező kapuk a `spec`-ből fordulnak az állapotgépbe (5.1).

- **MVP:** Playbook-entitás + `playbook_ref` mező + **1 triviális, 1-szereplős** wiki-Playbook seed; a folyamatindítás PIN-eli és auditálja a verziót (`process.start`). A flow-t továbbra is a determinisztikus állapotgép lépteti — **nem LLM**.
- **Fázis 2:** több szerep, elágazás, BPMN-szerű spec; orchestrator-vezérelt indítás.

**Kipróbálható, ha:** egy folyamat indításakor a `playbook_ref` az auditba kerül; a kötelező kapu az **állapotgépből** (nem az agent promptjából) kényszerül ki; a PIN-elt Playbook-verzió a lefutás alatt fix.

### 5.13 Beszélgetés-/session-kezelés és a jóváhagyási kapu leválasztása [CR-MVP-003]

A koncepció v0.9 → v0.10 interakciós-modell átkeretezésének fejlesztői átvezetése. **Scope-fegyelem (D9):** a walking skeletonban a beszélgetés-szubsztrátot és a kapu-leválasztási invariánst építjük be; a teljes többszálú beszélgetés-UI, a kritikussági-szintezett (L0–L3) automatikus eszkaláció és az activity feed Fázis 2.

#### 5.13.1 Beszélgetés / session store

**Felelősség:** a `conversations`/`messages` (4.10) mint control plane-birtokolt, tenant-scoped, verzió-attribútált tartós szál; a tartalom (`content_ref`) külön törölhető a metaadattól. A dispatch (5.7) előtti **context assembly** a releváns előzményt + memóriát tölti vissza (nem a teljeset).

**API:**
```
createConversation({ agentId, title? }) -> { conversationId }   [operator+]
appendMessage({ conversationId, role, content, agentVersion?, model? }) -> { messageId }   -- belső; auditol
getConversation({ conversationId }) -> { messages[], state }    [viewer+, tenant-scope kötelező]
deleteMessageContent({ messageId }) -> { ok }                    [admin]   -- GDPR-erasure: content_ref ürítés + content_deleted_at; audit-csontváz marad
```

- **Beszélgetés-memória ≠ agent-memória:** az `appendMessage` **soha** nem ír `memory_versions`-t; tudás-beemelés csak write-gate-en (5.8) át.
- **Tenant-izoláció:** minden olvasás `tenant_id`-scope-pal; cross-tenant hozzáférés szerveroldali elutasítás + audit.

**Kipróbálható, ha:** egy beszélgetés végigfut és visszaolvasható; egy üzenet tartalmának törlése után a rekord-csontváz és a `verifyChain` ép (N8); más tenant nem éri el a szálat.

#### 5.13.2 A kötelező jóváhagyási kapu nem a ticketben él (invariáns)

**Felelősség:** a kötelező human-in-the-loop / write kapu **szerveroldalon, a ticket meglététől függetlenül** kényszerül ki. A walking skeletonban ezt a meglévő, már szerveroldali kapuk adják:

- **rendszerbe-írás / memória-frissítés:** kizárólag a write-gate token (5.8) — beszélgetésből kért „tanuld meg" sem ír token nélkül (N3);
- **eszközhívás:** Tool Broker `authorize()` deny-by-default (5.5) — beszélgetésből kért jogosulatlan tool is blokk (N2);
- **ticket-átmenet (ha van ticket):** állapotgép-szabály (5.1).

**Invariáns [CR-MVP-003]:** egy magas kockázatú művelet **nem** válik megkerülhetővé azáltal, hogy direkt beszélgetésben (ticket nélkül) kérik — a kaput nem az „van-e kártya", hanem a szerveroldali policy dönti el. **Fázis 2:** a művelet **kritikussági szintje** (L0–L3, koncepció 5.6) automatikusan eszkalál jóváhagyási kapura; a jóváhagyás felülete inline a beszélgetésben **vagy** ticket. Kötelező negatív teszt: **N7** (9.2).

**Kipróbálható, ha:** egy beszélgetésben kért rendszerbe-író / memória-módosító lépés write-gate token / `authorize()` nélkül **nem** hajtódik végre, és a kísérlet auditba kerül — pontosan úgy, mintha ticketből kérték volna.

---

## 6. A Goose-recipe formátuma (MVP)

A recipe a **tickettípus szintű „hogyan végezd"** utasítás hordozója (agent-privát) — **nem** a folyamat-flow (azt a ticket-állapotgép kényszeríti ki). **[CR-MVP-002]** A *folyamat-flow* forrás-igazsága a **Playbook** (4.9), amely az állapotgépre fordul: a recipe a „hogyan", a Playbook a „milyen sorrendben, ki hagyja jóvá". A kettő nem keverendő. Verziózott, agenthez köthető, a `recipe_versions` táblában tárolt. Javasolt YAML-séma:

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

**Epik 7 — Sandbox use case (wiki) + App Registry stretch [CR-MVP-001]**
tudásfeltöltés; kérdés→citált válasz+indoklás UI; jóváhagyásra küldés; lezárás; 1 előre definiált riport-sablon. **Stretch:** a riport önálló A0 HTML sandbox appként megnyitható, verziózott és exportálható. *(S6.)*

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
| **4. Tanítás + Sandbox** | 7–9 (≈2) | Epik 6–7 (S5, S6) | B: Sandbox+tanítás-UI, A: write-gate+MemoryStore | Write-gate + rollback; citált wiki-válasz. Stretch, ha a kritikus út zöld: A0 riport preview/export |
| **5. Governance + mérés + demó** | 10 (≈1) | Epik 8 + negatív tesztek | Dev B (A: budget/kill-switch) | A 4. fejezet demó + 4 negatív teszt zöld |

> Az ütemezés a spike-eredménytől függ. Ha S2 (OAuth-mediáció) csúszik, az a kritikus út — azonnal eszkalálandó.
> **[CR-MVP-001] D7 scope guard:** az App Registry v0 nem blokkolhatja a walking skeleton DoD-t. Csúszás esetén levágandó stretch; a core MVP a 9.1/1–8 teljesülésével kész.

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

**Stretch / demo-bónusz [CR-MVP-001]:** az App Registry v0 akkor tekinthető bemutathatónak, ha a wiki-riportból legalább egy A0 sandbox app létrejön, külön origin + CSP mellett preview-ban megnyílik, verziózott, és `.html` exportként letölthető hash-sel. Ez nem blokkolja a core MVP elfogadását.

### 9.2 Kötelező negatív tesztek (governance-bizonyítékok)

| # | Teszt | Elvárt eredmény |
|---|---|---|
| N1 | `viewer` megpróbál jóváhagyni | Szerver elutasít + `ticket.transition.denied` audit |
| N2 | Agent egy nem engedélyezett toolt hív | Tool Broker blokk + `tool.call.denied` audit-flag |
| N3 | Külső „tanuld meg, hogy…" prompt | **Nem** ír memóriát (write-gate token nélkül nincs írás) |
| N4 | Goose-konténer közvetlen internet/rendszer-elérés kísérlete | Egress blokk; a kísérlet nem jut ki |
| N5 *(D7 / CR-MVP-001 stretch esetén)* | Tenant A appId-vel lekéri vagy exportálja tenant B sandbox appját | Szerver elutasít + `sandbox_app.access_denied` audit |
| N6 *(CR-MVP-002)* | Agent önmódosítással (tanítási úton) megpróbálja bővíteni a saját `capabilities` / connector-jogát | Az írás **blokk**; a jogosultság nem változik; `training.capability_escalation_denied` audit |
| N7 *(CR-MVP-003)* | Direkt **beszélgetésben** (ticket nélkül) kért rendszerbe-író / memória-módosító művelet | A kapu **ugyanúgy elsül**, mint ticketből: write-gate token / `authorize()` nélkül **nem** hajtódik végre; a kísérlet auditba kerül — a ticket hiánya nem megkerülési út (5.13.2) |
| N8 *(CR-MVP-003)* | GDPR-erasure: egy beszélgetés-üzenet tartalmának törlése | A `content_ref` ürül + `content_deleted_at`; a `messages` rekord-csontváz és az `audit_log` **marad**, `verifyChain()` **zöld** (4.8/4.10 content/metadata szétválasztás) |

N1-N4 a core MVP kötelező negatív tesztje. N5 akkor kötelező, ha a D7 App Registry stretch leszállításra kerül. **N6 kötelező, ha a `self_evolution_profile` (CR-MVP-002) MVP-be kerül** — ez az önfejlesztés „kemény padló" invariánsának bizonyítéka (4.6). **N7 és N8 kötelező, ha a beszélgetés-réteg (CR-MVP-003) MVP-be kerül** — N7 a kapu-leválasztás invariánsának bizonyítéka (5.13.2), N8 a GDPR-kompatibilis, tamper-evidence-t megőrző törlésé (4.8/4.10).

### 9.3 End-to-end demó-forgatókönyv

A v1.0 terv 4. fejezetének 11 lépése a demó-script alapja: belépés (IAM) → agent létrehozása → tudásfeltöltés → kérdés (**beszélgetés, ticket nélkül** — [CR-MVP-003]) → dispatch + `goose run` → citált válasz → **eredmény jóváhagyásra küldése = ticket** (`promoteToTicket`) → tanítás (write-gate) → rollback → audit-láncolat (a ticketless beszélgetés is benne) → negatív tesztek (N1–N4, és ha a beszélgetés-réteg bekerül: N7–N8).

**Stretch demó, ha D7 / CR-MVP-001 belefér:** a generált wiki-riport önálló A0 sandbox appként is megnyílik preview-ban, majd `.html` exportként letölthető.

---

## 10. Security baseline (MVP-minimum)

- **Secret:** soha a promptban/runtime-ban; alias + szerveroldali injektálás a Tool Brokerben; GCP Secret Manager. Az OAuth-token a Gatewaynél, szerveroldalon.
- **Egress:** harness-konténer deny-by-default; csak Gateway + Broker.
- **Audit:** append-only, hash-láncolt; `UPDATE/DELETE` megvonva; `verifyChain()`.
- **Human approval:** kötelező a tudásfrissítésnél és a kifelé menő/bizonytalan válasznál.
- **Rate/budget/kill-switch:** per-agent budget cap; eszköz-szintű rate limit; agent-felfüggesztés (`setAgentStatus(suspended)`).
- **Prompt injection:** a dokumentum-/web-tartalom **adat, nem utasítás**; a write-gate token nem csalható ki promptból.
- **Sandbox app preview (stretch, [CR-MVP-001]):** A0 app külön, cookieless preview-originről jön; iframe `sandbox="allow-scripts"` **`allow-same-origin` nélkül**; CSP minimum `default-src 'none'; connect-src 'none'`, kontrollált `script-src` policyvel. Így az AI által generált JS nem éri el a platform sessionjét/API-jait, nem tölthet külső dependencyt és nem hálózhat. Exportkor hash készül, az export auditált; az exportált `.html` biztonsági kockázata a letöltött HTML fájlok szintje.
- **Tenant izoláció (stretch, [CR-MVP-001]):** preview/export végpontok minden hívásnál tenant scope-ot ellenőriznek; cross-tenant appId `sandbox_app.access_denied` auditot ír.
- **Lock-out védelem:** utolsó aktív admin nem zárható ki; admin a saját szerepét nem írhatja át.

---

## 11. Mérés / observability (MVP-minimum)

| Dimenzió | MVP-metrika | Forrás |
|---|---|---|
| Hatékonyság | válaszidő / kérdés; becsült kézi keresési idő megtakarítása | `model_calls.latency_ms`, ticket időbélyegek |
| Minőség | citált válaszok aránya; forrás-lefedettség; emberi visszadobási arány | ticket payload + transitions |
| Kontroll | jóváhagyott vs. automatikus lépések; audit-lánc teljessége | `audit_log` + `verifyChain` |
| Költség | (becsült) token/költség per ticket; runtime-költség / nap | `model_calls`, Cloud Run Jobs metrikák |
| Sandbox app (stretch, [CR-MVP-001]) | létrehozott appok száma; preview/export/access-denied események; app-verziók száma | `sandbox_apps`, `sandbox_app_versions`, `audit_log` |

A dashboard MVP-ben egyszerű (Epik 8): aggregált számok + ticketenkénti lebontás. Eval: kis kérdéskészlet + manuális értékelő felület.

---

## 12. Kockázatok és figyelmeztetések

- **Az S2 (OAuth-mediáció) a kritikus út.** A Goose provider ↔ ChatGPT OAuth illeszkedés ismeretlen. Ha a flat-rate kvóta vagy a provider-csatorna nem fér össze a Gatewayjel, az az MVP modellforrását érinti → azonnal Gergő/Koordinátor.
- **A két átjáró nem opcionális.** Ha bármelyik komponens „kényelemből" közvetlenül elérné a modellt vagy egy eszközt, az MVP fő állítása sérül. A negatív tesztek (N1–N4) ezt fogják meg.
- **Scope-fegyelem.** A kísértés, hogy egy komponenst „rendesen" építsünk meg. Minden komponens a **legszűkebb működő formában** készül; a mélységet a use case-ek élesedése hajtja, nem az MVP.
- **[CR-MVP-001] App Registry v0 nem válhat rejtett platformépítéssé.** Ez stretch, nem hard gate. MVP-ben kizárólag a wiki-riport A0 single-file HTML preview/exportja fér bele. Ha adatmodell, build pipeline, külső API vagy deploy kell, az Fázis 2.
- **A v1.0 terv 5. epik-szövegének „OpenAI + Gemini" megjegyzése elavult** (D2 előtti maradvány). Mérvadó: **kizárólag ChatGPT OAuth**.
- **Elhalasztott komponensek (terv 1.4 / koncepció 10.B):** sensitivity router, OPA/Cedar, külső memory substrate, hibrid retrieval, saját model hosting — mind **cserepont mögé** építve, nem implementálva. Éles ügyfél előtt újra validálandók.

---

## 13. Definition of Done / átadási checklist

A fejlesztés akkor kész, ha:

- [ ] Mind a 8 core epik leszállítva; a 9.1 nyolc kritériuma valódi adaton stabil. D7 / CR-MVP-001 App Registry stretch nélkül is késznek tekinthető.
- [ ] A 9.2 négy negatív tesztje (N1–N4) zöld.
- [ ] A 9.3 end-to-end demó kattintható forgatókönyvként lefut.
- [ ] `verifyChain()` zöld egy teljes demó-futás után.
- [ ] Egy lezárt ticketről reprodukálható az agent-/memória-/recipe-verzió.
- [ ] A spike-eredmények (S1–S6) dokumentálva; az elhalasztott cserepontok a kódban jelölve.
- [ ] Rövid mérési riport (9.1/7) elkészült.
- [ ] Secret/egress/audit baseline (10.) auditálva.

---

## 14. Következő dokumentumok (a spec után)

- **Eval plan** — teszt-kérdéskészlet + elfogadási küszöbök a wiki-agentre (S6 kibontva).
- **Demo script** — a 9.3 forgatókönyv 3–5 perces, kattintható változata.
- **Fázis 2 spec** — governance/biztonsági keménység (write-gate-en túli hardening, observability, deny-by-default humán kapu), ha az MVP kilépési kritériuma teljesült.

---

## 15. Megvalósítási státusz a jelenlegi kódbázis alapján

**Frissítve:** 2026-06-17 (session 18)
**Állapotjelölés:** `Kész` = működő kód + build zöld; `Részben kész` = van alap, de nem teljesíti még a spec minden kipróbálhatósági kritériumát; `Hátra van` = érdemi implementáció hiányzik.

### 15.1 Elkészült / részben elkészült elemek

| Terület | Státusz | Megjegyzés |
|---|---:|---|
| Next.js App Router control plane + sandbox alap | Részben kész | Board, agent lista/részlet, audit oldal, training oldal és sandbox útvonalak léteznek. A sandbox wiki **`askWiki` beszélgetés-elsődleges** (CR-MVP-003): kérdés→válasz ticket nélkül, `promoteToTicket` határátlépéskor. A harness async path (`docker-local`/`cloud-run-job`) továbbra is ticket-alapú dispatch-et használ (`createQuestionTicket` + dispatcher). |
| Prisma/Postgres repository alap | Részben kész | Repository interfészek és Postgres implementációk vannak. A séma közel van a 4. fejezet táblájához: `users.status/tenant_id`, `invitations`, `ticket_transitions`, `recipes` + `recipe_versions`, `training_tickets`, **`conversations`/`messages`** (CR-MVP-003), **`playbooks`/`playbook_versions`** + `agents.role`/`self_evolution_profile` (CR-MVP-002). |
| Recipe-katalógus (`recipes` + `recipe_versions`) | **Kész (2026-06-15)** | First-class `recipes` + `recipe_versions` tábla (§4.3) verziózással, `status` (proposed/active/retired) és jóváhagyóval. `RecipeService` (create/propose/approve/getActive) — a jóváhagyás aktiválja az új verziót és **retire-eli a korábbi aktívat**, governance auditeseményekkel (`recipe.create`/`recipe.version`/`recipe.approve`, §6). `AgentVersion.recipe_version_id` link a reprodukálhatósághoz (§5.3). A seed felveszi a §6 `wiki-answer` recipe-t (aktív v1) és bekötu a Wiki Agent v1-éhez; az agent detail oldal „Recipe" kártyán mutatja. Verifikálva DB ellen. |
| Schema — IAM prep (Epik 2) | **Kész (2026-06-15)** | `users.status` (enum: pending/active/suspended), `users.tenant_id` mező és `Invitation` modell / `invitations` tábla bekerült a Prisma sémába. |
| Schema — document→connector link | **Kész (2026-06-15)** | `documents.connector_id` FK bekerült; `DocumentRepository.findByConnectorId` és `update(...connectorId)` megvalósítva. |
| Ticket-állapotgép | Részben kész | A kód át lett állítva a v1.0 állapotokra: `backlog → ready → in_progress → awaiting_human → approved/rejected → done`, illetve `rejected → ready`. Tiltott átmenet `ticket.transition.denied` auditot ír. |
| Ticket transition history (`ticket_transitions`) | **Kész (2026-06-15)** | First-class `ticket_transitions` tábla (§4.5): `from_state`, `to_state`, `actor_type`, `actor_id`, `agent_version`, `note`, `ts`. A `TicketService.transition` minden **sikeres** átmenetnél sort ír (tiltott átmenet csak auditba kerül, állapot nem változik). `recordTransition`/`findTransitions` repo-metódus, `getTicketTransitions` server action és „Állapot-előzmények" idővonal a ticket detail oldalon. Verifikálva DB ellen. |
| Ticket detail — Agent anatómia kártya | **Kész (2026-06-16)** | `TicketMeta` komponens megjeleníti az `agentVersion`, `memoryVersion`, **recipe (név + verzió)** és `model` mezőket. `getTicket` betölti az `agent_versions` snapshotot (`findVersionSnapshot`); wiki runtime a payloadba írja a `recipeName`/`recipeVersion` mezőket. |
| Dispatcher előfeltételek | Részben kész | … **GCP Cloud Run Job proof (2026-06-16, session 12):** közös `buildHarnessContainerEnv` (docker-local + Cloud Run override), `cloud-run-auth` (metadata token + execution poll), `infra/gcp/deploy-harness-job.sh` + `harness-job.env.example` (VPC connector + egress enforce), `npm run harness:cloud-run-deploy` / `harness:cloud-run-smoke`, acceptance `scenario23_cloudRunJobLauncher`. **Éles smoke ZÖLD (2026-06-16, `enterprise-ai-demo` / App Hosting / europe-west4):** a `wiki-harness` Cloud Run Job valódi executionje átment a Gateway-en (`modelCalls>0`) és a Tool Brokeren (`toolCalls>0`), a callback felszabadította a lockot és rögzítette a választ. Közben javítva 3 hiba: (a) image `linux/amd64` Cloud Build-del (Apple Silicon `docker build` arm64-et adott → „Application failed to start"); (b) callback dupla útvonal (launcher base URL-t ad át, a konténer fűzi rá egyszer); (c) `jobs:run` operation- vs execution-státusz poll. Hátra: **hálózati szintű** VPC firewall deny-by-default proof + valódi Goose MCP loop stub nélkül. |
| Append-only hash-láncolt audit | Részben kész | Van `AuditRepository.append()`, advisory lock, hash-számítás, `verifyChain()` és audit nézet. DB-szintű `UPDATE/DELETE` jogosultságmegvonás még nincs igazolva. |
| IAM/RBAC | **Kész (2026-06-16)** | Clerk/dev `AuthProvider`, 4 szerepkör és szerveroldali `requireRole()`. Új `IamService` (§5.2, §10): admin-meghívás lejáró, egyszer beváltható, **hashelt** tokennel (nyers token CSAK egyszer); `redeemInvitation` aktív userré váltja; `changeRole`/`setStatus`. **Lock-out védelem**: utolsó aktív admin nem demotálható és nem függeszthető fel; admin a saját szerepét nem írhatja át / magát nem függesztheti fel. **Kill-switch**: felfüggesztett fiók a `requireRole`/`assertActive` ágon elutasítva. Server actions (`inviteUser`/`redeemInvitation`/`changeUserRole`/`setUserStatus`/`listUsers`/`listInvitations`) + Zod sémák. Minden hozzáférési esemény auditba (`access.invite`/`redeem`/`role_change`/`suspend`). Acceptance e2e [10] (invite→redeem, replay/lejárt invitation, lock-out, self-protection, kill-switch) zöld. Admin IAM UI kész: `/control-plane/iam` user lista + szerep/státusz módosítás + egyszer látható tokenes meghívó, `/control-plane/iam/redeem` beváltó képernyő. **Clerk-natív meghívó + szerep-szinkron kész (2026-06-17, session 17):** `inviteUser` Clerk-engedélyezett környezetben `clerkClient().invitations.createInvitation`-t hív (`publicMetadata.role` hordozza a szerepkört, `notify`, `ignoreExisting`, `redirectUrl=/sign-up`), így a regisztráció Clerk-meghívóhoz kötött (Dashboard Restrictions: sign-ups restricted to invitations). A `user.created` webhook a `publicMetadata.role`-ból állítja be a szerepkört (`mapClerkRole`) **és** beváltottra állítja a megfelelő `pending` in-app meghívót (nincs külön token-beváltó lépés Clerk-módban). A token-alapú domain folyamat dev/fallback útként megmarad; az `inviteUser` `clerkInvited` flaget ad vissza, az IAM UI ennek megfelelően jelzi, hogy e-mail ment ki és a token csak belső fallback. *Hátra:* Clerk-szerepkör utólagos `changeRole` visszaírása Clerkbe (Fázis 2 cserepont). |
| Agent Registry alap | Részben kész | Agent, agent version, memória és API-kulcs alap létezik. A recipe-verzióhoz kötés bekerült (`agent_versions.recipe_version_id`, 2026-06-15). |
| Szerep-instrukció / viselkedés-profil külön verziózás (Epik 3, §4.2/§5.3) | **Kész (2026-06-16, session 15)** | A korábbi egyesített `system_prompt` szétbontva két, **egymástól függetlenül verziózott** mezőre: `roleInstruction` („mit csinál") és `behaviorProfile` („hogyan"), külön `currentRoleInstructionVersion` / `currentBehaviorProfileVersion` számlálóval (Agent), és `roleInstructionSnapshot` + `behaviorProfileSnapshot` + al-verziók az `AgentVersion`-ben (reprodukálhatóság). Új `AgentRepository.updateInstruction` — csak a ténylegesen változó összetevő al-verzióját lépteti, új `agent_versions` snapshotot fagyaszt (mindkét szöveg + modell + memória + recipe örökölve), lépteti az agent `currentVersion`-jét. `updateAgentInstruction` server action (`admin`) `agent.version` audittal (§6) és `changed` metaadattal. Runtime közös `composeSystemPrompt` (szerep + viselkedés) a wiki/könyvelő futtatóban. UI: agent detail külön „Szerep-instrukció (vN)" / „Viselkedés-profil (vN)" kártya + admin „Instrukció frissítése" űrlap; create-agent űrlap két mezőre bontva. Nem-destruktív oszlop-rename migráció (audit-lánc + ticketek megőrizve). Acceptance `scenario26_roleBehaviorVersioning` valós DB-n zöld (create → v1/v1, viselkedés-only → behavior v2 / role v1, szerep-only → role v2, régi snapshot immutábilis, üres frissítés elutasítva). |
| Agent detail — Eszközjogok és Connectorok kártyák | **Kész (2026-06-15)** | Az agent részlet oldal mostantól „Eszközjogok" (capabilities) és „Connectorok" kártyákat mutat, amelyek az agent governance állapotát tükrözik. `getAgentGovernance` server action hozzáadva. |
| Model Gateway provider-absztrakció | **Kész (2026-06-16, session 16)** | A Gemini-függőség ki lett vezetve az appból. A `ModelGateway` most csak `chatgpt-oauth` providert fogad, és belső `CHATGPT_OAUTH_PROVIDER_URL` / `CHATGPT_OAUTH_PROVIDER_KEY` adapteren át hív. **S2 stub kész (2026-06-16):** `CHATGPT_OAUTH_PROVIDER_URL=stub` beépített acceptance/dev stub; külön `npm run s2:stub` HTTP stub szerver. Éles App Hostingon `CHATGPT_OAUTH_STUB=true` env-vel a Gateway stub választ ad valódi OAuth nélkül. **OpenAI-kompatibilis Gateway API kész (2026-06-16):** `POST /api/v1/gateway/v1/chat/completions` agent API-kulccsal, `X-Ticket-Id` headerrel. **S2 VALÓDI ChatGPT OAuth mediáció ÉLES ZÖLD (2026-06-16, session 16):** új provider sidecar (`npm run s2:provider`, `scripts/chatgpt-oauth-provider.ts`) a „Sign in with ChatGPT" tokeneket (`~/.codex/auth.json`) **szerveroldalon** tartja (az agent/Goose sosem látja), lejárat előtt a `refresh_token`-nel frissít, és a ChatGPT Codex **Responses backendet** (`chatgpt.com/backend-api/codex/responses`, SSE) hívja. Tiszta híd-réteg `src/domain/gateway/chatgpt-oauth-bridge.ts` (üzenet→Responses input map, JWT-exp ellenőrzés, OAuth refresh, SSE-parse, token-usage). A modellt a provider oldja fel (`chatgpt-oauth-default`→`gpt-5.5`), és a **ténylegesen használt modell** kerül a `model_calls`/auditba. Élő E2E (`npm run s2:live-smoke`): valós wiki-flow `kb_search`→Gateway→sidecar→ChatGPT→`board_write`, valódi válasz (Plus-előfizetésen, `gpt-5.5`, 882+164 token, audit-lánc ép). *Megjegyzés (ToS):* a ChatGPT-előfizetés programozott használata a Codex-kliensen kívül OpenAI-ToS szürkezóna — éles üzem előtt Gergő/jogi jóváhagyás. Stub marad az alapértelmezett acceptance/CI path. **Multi-provider Gateway (2026-06-17):** a Gateway most provider-regiszter (`modelConfig.provider` → implementáció), nem egyetlen fix provider. `chatgpt-oauth` mellett `OpenAiCompatibleProvider` (`ollama`) — helyi modellek (pl. **Gemma** GGUF Ollamán, OpenAI-kompatibilis `/v1`, `OLLAMA_BASE_URL` default `localhost:11434/v1`); a create-agent űrlapon **agentenként választható** modellforrás + modell. Verifikálva: `provider=ollama` / `model=gemma-local` valós helyi választ + token-naplót ad. *(D2 továbbra is a felhős MVP-default; a helyi provider fejlesztői/önállósági opció.)*
| Model Gateway — latency/status + guardrail | **Kész (2026-06-15)** | `model_calls` kapott `latency_ms` + `status` (enum: ok/error/rate_limited) mezőt (§4.7). A Gateway minden hívásra latency-t és státuszt naplóz; a hibás/rate-limited hívás is `model_calls` rekordot + auditot kap. Ticketenkénti hívás-keret guardrail (`maxCallsPerTicket`, §5.4) túllépve `GatewayBudgetError` + `model.call.budget_blocked` audit. `getUsageForTicket` repo-metódus hozzáadva. Verifikálva stub providerrel. |
| Tool Broker alap | Részben kész | Bekerült a `connectors`, `agent_connectors`, `capabilities`, `tool_calls` adatmodell, `AllowlistAuthorizer`, `kb_search`, `board_write`, agent API route és pozitív/negatív acceptance smoke. **MCP bridge kész (2026-06-16):** `scripts/platform-mcp-bridge.ts` + `src/harness/platform-mcp-bridge.ts` stdio MCP → `/api/v1/agent/tools` proxy; Goose harness config `platform_broker` extensionnel (developer extension kikapcsolva). Hátra: valódi Goose image-ben end-to-end `goose run` proof; Secret Manager injektálás igazolása. |
| Tool Broker — repository metódusok | **Kész (2026-06-15)** | `ToolBrokerRepository` új metódusai: `findCapabilitiesForAgent`, `findConnectorsForAgent`, `findDocumentsForConnector`. |
| Tool Broker — kbSearch kiterjesztés | **Kész (2026-06-15)** | `ToolBrokerService.kbSearch` mostantól az agent KB-connectorához kapcsolt dokumentumokat is átkutatja a memória-tartalom mellett. |
| Sandbox — dokumentumfeltöltés és KB-linking | **Kész (2026-06-15)** | `/sandbox` oldal kapott dokumentumfeltöltés szekciót (fájl + szöveges beillesztés), KB-dokumentum listát és linking flow-t. Server actions: `processDocumentForWiki`, `listDocumentsForAgent`. |
| Sandbox App Registry v0 **[CR-MVP-001]** | **Kész stretch alap (2026-06-16)** | `sandbox_apps` + `sandbox_app_versions` modell, `SandboxAppService`, ticketből generált A0 single-file HTML wiki-riport, SHA-256 hash, verziózás, preview/export route (`/api/sandbox-apps/[appId]/preview|export`), sandboxolt iframe UI a proposal oldalon, audit (`sandbox_app.create/version/preview/export/access_denied`) és N5 cross-tenant deny acceptance smoke. Infra-szintű külön preview origin még hátra marad a deploy hardeningre; a lokális MVP route szigorú CSP-t és iframe sandboxot használ. |
| Seed / alapértelmezett agent | Kész alap | A seed most `Wiki Agent`-et hoz létre `chatgpt-oauth` modellkonfiggal és belső tudásbázis kezdőmemóriával. |
| Training / write-gate | **Kész (2026-06-15)** | Training ticket, diff, write-gate issue/consume (aláírt, egyszer használatos, diffhez kötött), memória verzió promóció, rollback és eval-kapu működik. First-class `training_tickets` tábla (§4.4) bekerült: `proposed_diff`, `write_gate_token_ref` (a kiállított token referenciája — nyers token sosem tárolt), `eval_result` és `target_memory_version`. A `TrainingService.createTrainingTicket` írja a sort a cél-verzióval; az `approveTraining` rögzíti a token-ref-et és az eval-eredményt. Az **S5/N3 negatív tesztek** (replay/kétszeres consume tiltva, lejárt token tiltva + `expired` státusz, hamisított aláírás tiltva) az acceptance e2e-ben zöldek. |
| Eval alap | Részben kész | Egyszerű eval definíció és futtatás van. Wiki-agentre szabott S6 eval plan még nincs. |
| Governance & mérés dashboard (Epik 8, §11) | **Kész (2026-06-16, session 13)** | `/control-plane/governance` oldal range-szelektorral (ma/7nap/30nap/összes): aggregált KPI-k a **két átjáróról** (Gateway-hívás + átlag latency + hiba/rate-limit státusz-bontás; Tool Broker hívás/tiltás/hiba), token/költség, kontroll-metrikák (átmenetek actor szerint, jóváhagyva/elutasítva, **emberi lépés-arány** és **visszadobási arány**), **audit-lánc integritás** (`verifyChain`) és sandbox-app események (create/version/preview/export/access_denied). **Ticketenkénti lebontás** táblázat (Gateway-hívás, tool-hívás, token, átlag latency, költség, ügyre linkelve). Új repo-aggregációk: `modelCalls.getGovernanceSummary` + `getPerTicketBreakdown`, `toolBroker.getToolCallCountsByTicket`, `tickets.getTransitionStats`, `audit.getActionCounts` (Prisma `groupBy`). `getGovernanceReport` server action (`viewer` szerep). Acceptance `scenario24_governanceReport` valós adaton zöld. |
| Mérési riport (§9.1/7, Epik 8) | **Kész (2026-06-16, session 14)** | Írott, exportálható **mérési riport** egy valódi futás adataiból (§9.1/7 elfogadási kritérium). Újrahasználható `buildMeasurementReport` + `renderMeasurementMarkdown` (`src/domain/governance/measurement-report.ts`) a négy dimenzióra: **válaszminőség** (citáció-arány a ticket-payload `sources`-ből + confidence-eloszlás), **átfutás** (átlag Gateway-latency + ügy-átfutás create→last update átlag/medián), **visszadobási arány** + emberi lépés-arány, **költség/ticket** — a §11 governance-aggregációkra építve, audit-lánc integritással. CLI generátor (`npm run report:measurement [-- --range=… --out=…]`, Markdown fájlba ír) és UI-letöltés a governance oldalról (`GET /control-plane/governance/report`, `viewer` szerep, attachment). Acceptance `scenario25_measurementReport` valós adaton zöld; a CLI lokálisan `app/reports/measurement-report.md`-be generál (gitignore-olt kimenet). |
| Negatív tesztek N1–N4 (governance-bizonyítékok, §9.2) | **Kész (2026-06-16, session 14)** | Mind a négy kötelező negatív teszt automatizálva és zöld: **N1** viewer nem hagyhat jóvá (`ticket.transition.denied`), **N2** agent nem engedélyezett toolt hív → Tool Broker **deny-by-default** (a capability-sor hiányában `capability_not_allowed`), a tool nem fut le, `tool.call.denied` audit (új `scenarioN2_unauthorizedTool`), **N3** write-gate token nélkül nincs memóriaírás, **N4** harness egress deny-by-default. |
| **CR-MVP-002 — konfigurálható szerepek, önfejlesztési profil, Playbook [D8]** | **Kész (2026-06-17, session 18)** | **`agents.role`** (`worker`/`orchestrator`) + orchestrator tool-less tiltás (`AllowlistAuthorizer` + `orchestrator_tool_less`). **`agents.self_evolution_profile`** + `updateAgentSelfEvolutionProfile` server action + UI (`update-self-evolution-profile-form`) + per-agent write-gate kapu-választás (`requiresHumanApproval`/`requiresEvalGate`). **`playbooks`/`playbook_versions`** + `PlaybookService` + `tickets.playbook_ref` PIN + `process.start` audit + wiki-interaction seed; Playbook gate az állapotgépen (`TicketService` + spec). **`SelfEvolutionGuard`** + **N6** (`training.capability_escalation_denied`). Audit: `agent.self_evolution_profile_change`, `playbook.create/version/approve`, `process.start`, `training.capability_escalation_denied`. Acceptance **scenario [27]** + **N6** zöld. *Hátra (Fázis 2):* tényleges orchestrator-agent delegálás, BPMN-szerű Playbook, több szerep. |
| **CR-MVP-003 — beszélgetés-elsődleges interakció [D9]** | **Kész (2026-06-17, session 18)** | **`conversations`/`messages`** séma (tenant-scope, `content_ref`/`content_deleted_at` GDPR szétválasztás). **`ConversationService`** + `PostgresConversationRepository`: create, append, get, `deleteMessageContent`, `promoteToTicket`. **`askWiki` beszélgetés-elsődleges** — ticket nélkül fut; `conversation_id` a `model_calls`/`tool_calls`/audit-on. Server actions: `promoteToTicket`, `getConversation`, `deleteMessageContent`. Sandbox UI: válasz inline + „Jóváhagyásra küldés (ticket)" gomb. Kapu-leválasztás: **`attemptUngatedMemoryWrite`** + **N7** (`memory.write_denied` ticket nélkül is). **N8** GDPR-erasure + `verifyChain` zöld. Audit: `conversation.create`, `message.append`, `message.content_deleted`, `conversation.promote_to_ticket`. Acceptance **scenario [1]** átállítva, **scenario [28]**, **N7**, **N8** zöld. *Hátra (Fázis 2):* teljes multi-agent beszélgetés-UI, L0–L3 kritikussági kapu, activity feed, harness conversation-alapú dispatch. |
| Build / lint állapot | Kész | `npm run lint`, `npm run build` és `npm run test:acceptance` zöld az `app/` könyvtárban (acceptance: **117 sikeres**, 2 kihagyva opcionális docker E2E, 0 sikertelen — 2026-06-17 session 18). **Idempotencia-fix (session 15):** a suite a futás elején nullázza a seed-agent aznapi `model_calls` telemetriáját. Az append-only audit-láncot nem érinti. |

### 15.2 Hátralévő feladatok epik szerint

| Epik | Státusz | Hátralévő munka |
|---|---:|---|
| Epik 1 — Control Plane mag | Részben kész | Admin tickettípus/átmenet CRUD. *(Agent anatómia + recipe snapshot kész 2026-06-16; N1 zöld 2026-06-16.)* |
| Epik 2 — IAM / RBAC | Részben kész | Hátra: agent scope-ok további szigorítása; `changeRole` visszaírása Clerkbe (Fázis 2). *(Admin meghívás+redeem flow, utolsó admin lock-out védelem, self-protection, suspended kill-switch, hozzáférési audit és negatív tesztek kész 2026-06-16; admin IAM UI + redeem képernyő kész 2026-06-16; **Clerk-natív meghívó + `publicMetadata.role` szerep-szinkron a `user.created` webhookban kész 2026-06-17 session 17**.)* |
| Epik 3 — Agent Registry + Model Gateway | **Kész (2026-06-16, session 16)** | *(latency/status + guardrail kész 2026-06-15; recipe snapshot kész 2026-06-15; OpenAI-kompatibilis Gateway API + stub provider kész 2026-06-16; `roleInstruction`/`behaviorProfile` külön mező + verziózás kész 2026-06-16 session 15; **S2 valódi ChatGPT OAuth mediáció éles E2E ZÖLD 2026-06-16 session 16** — sidecar + `~/.codex/auth.json` token, Responses backend, `npm run s2:live-smoke`.)* Üzemeltetési feltétel: ToS-jóváhagyás éles használat előtt. |
| Epik 4 — Tool Broker + connector | Részben kész | Valódi Goose image MCP E2E; Secret Manager injektálás igazolása. *(Connector UI + kbSearch kiterjesztés kész 2026-06-15; **stdio MCP bridge + Goose platform_broker extension kész 2026-06-16**.)* |
| Epik 5 — Harness (Goose) + Dispatcher | Részben kész | Hálózati szintű VPC firewall deny-by-default proof + valódi Goose E2E stub nélkül. *(… **Cloud Run Job éles smoke ZÖLD** `enterprise-ai-demo`/App Hosting-on — execution succeeded, Gateway+Broker átjáró + callback bizonyítva; Cloud Build amd64 + callback dupla-útvonal + operation-státusz fix; deploy/smoke + launcher refaktor + scenario23 kész 2026-06-16 session 12; docker-local path session 11; N4 acceptance zöld.)* |
| Epik 6 — Tanítás / memória | Részben kész | Hátra: retrieval-napló dedikált nézete; rollback UI finomítás. *(Spec szerinti `training_tickets` modell, write-gate token-ref külön kezelése és a token lejárat/újrajátszás/aláírás-hamisítás negatív tesztek kész 2026-06-15.)* |
| Epik 7 — Sandbox use case (wiki) + App Registry stretch **[CR-MVP-001]** | Részben kész | Valódi ChatGPT OAuth + Cloud Run Job teljes Goose E2E; GCS absztrakció `uploadDocument`-hez. *(Wiki E2E stub OAuth-tal zöld; dokumentumfeltöltés, App Registry v0, lokális dispatcher path kész 2026-06-16 session 11; **CR-MVP-003 beszélgetés-elsődleges sandbox UI + promoteToTicket kész session 18** — scenario [1] átállítva.)* |
| Epik 8 — Governance és mérés | **Kész** | *(**Governance & mérés dashboard `/control-plane/governance` kész session 13**; **írott mérési riport (9.1/7) kész session 14** — `buildMeasurementReport` + CLI `report:measurement` + governance-oldali letöltés, scenario25 zöld. **N1–N4 negatív tesztek mind zöld session 14** — N2 `scenarioN2_unauthorizedTool` deny-by-default + `tool.call.denied`; **N6/N7/N8 zöld session 18** — CR-MVP-002/003 invariáns-bizonyítékok.)* |
| **CR-MVP-002 — koncepció v0.9 átvezetés** | **Kész (MVP-horgok)** | MVP-horgok leszállítva session 18-ben (lásd 15.1). *Hátra (Fázis 2):* teljes orchestrator-flow + BPMN-szerű Playbook (D8). |
| **CR-MVP-003 — koncepció v0.10 átvezetés** | **Kész (MVP-horgok)** | MVP-horgok leszállítva session 18-ben (lásd 15.1). *Hátra (Fázis 2):* teljes beszélgetés-UI, L0–L3 kritikussági kapu, activity feed, harness conversation-dispatch (D9). |

### 15.3 Következő javasolt fejlesztési sorrend

1. **Éles GCP proof:** ~~`npm run harness:cloud-run-smoke` valódi projekten~~ ✅ ZÖLD (2026-06-16, `enterprise-ai-demo`). Hátra: **hálózati szintű** VPC connector + Cloud NAT + firewall deny-by-default (most app-szintű egress guard); production dispatcher launch-auth (App Hosting SA `run.developer` a jobon); valódi ChatGPT OAuth provider bekötésekor `CHATGPT_OAUTH_STUB` visszavétele.
2. ~~**S2 éles OAuth:** valódi ChatGPT OAuth provider~~ ✅ ÉLES ZÖLD lokálisan (session 16) — sidecar + `~/.codex/auth.json`, Responses backend, `npm run s2:live-smoke`. **Éles deploy path kész (session 16):** beágyazott in-process mediáció az App Hosting Gateway-ben (`CHATGPT_OAUTH_EMBEDDED`), tokenek **Secret Managerből** (`CHATGPT_OAUTH_TOKEN_SECRET`) **write-back refresh**szel (`oauth-token-store.ts`, metadata-token + REST minta); beágyazott módban lokálisan is verifikálva (`gpt-5.5`). **Aktiválás (NEM automatikus deploy után):** `npm run s2:secret-setup` (token feltöltés + IAM accessor/versionAdder), `apphosting.yaml` flip (stub ki / embedded be), **ToS-jóváhagyás**, deploy. Hátra: heti kvóta/budget cap valós terhelésen; refresh-token elhalásra re-login runbook.
3. **Tool Broker hardening:** Secret Manager injektálás; connector secret alias igazolása.
4. ~~**Negatív tesztek:** N1–N4 acceptance-ben~~ ✅ N1–N4 mind zöld (session 14). Hátra: éles egress probe Docker/GCP-n (`npm run harness:egress-probe`) valódi konténer ellen.
5. **Deploy hardening [CR-MVP-001]:** App Registry preview külön cookieless origin.
6. ~~**Governance mérés:** Tool Broker dashboard + rövid **írott** mérési riport (9.1/7)~~ ✅ `/control-plane/governance` dashboard (session 13) + írott mérési riport `npm run report:measurement` / governance-oldali letöltés (session 14) kész. N1–N4 negatív tesztek mind zöld (session 14) — **Epik 8 lezárva**.
7. ~~**Epik 3:** `roleInstruction` / `behaviorProfile` külön verziózás az agent registry-ben.~~ ✅ Kész (session 15) — külön mező + al-verzió + `updateInstruction` + `agent.version` audit + UI; scenario26 zöld. **Epik 3 lezárva (session 16): az S2 valódi ChatGPT OAuth mediáció éles E2E zöld** (`npm run s2:live-smoke`).
8. ~~**CR-MVP-002 + CR-MVP-003 MVP-horgok:** konfigurálható szerepek + önfejlesztési profil + Playbook séma; beszélgetés-elsődleges `askWiki` + `promoteToTicket` + kapu-leválasztás.~~ ✅ Kész (session 18) — scenario [27]/[28], **N6**/**N7**/**N8** zöld; acceptance **117** sikeres. *Hátra (Fázis 2):* orchestrator-flow, BPMN Playbook, teljes beszélgetés-UI, L0–L3 kapu.

---

*Forrásalap: `AI-Agent-Platform-MVP-Terv-v1.0.md` (2026-06-15) és `AI-Agent-Platform-Koncepcio.md` v0.10 (forrásellenőrzés: 2026-06-14; App Registry kiegészítés / CR-MVP-001: 2026-06-16; koncepció v0.9 átvezetés / CR-MVP-002: 2026-06-17; koncepció v0.10 átvezetés / CR-MVP-003: 2026-06-17). A modellstratégia eldöntve (D2: kizárólag ChatGPT OAuth); az OAuth-mediáció és kvótakezelés az S2 spike-on validálandó. A D1/D3/D4/D6 döntések ebben a specben default-javaslattal lezárva; D7 / CR-MVP-001 stretch, csúszás esetén levágható. A **CR-MVP-002** (konfigurálható szerepek, önfejlesztési profil, Playbook-elsődleges végrehajtás) MVP-be séma-horgokkal + invariánsokkal kerül, a teljes orchestrator/Playbook-flow Fázis 2 (D8). A **CR-MVP-003** (beszélgetés-elsődleges interakció, board mint opcionális réteg, jóváhagyási kapu leválasztása a ticketről, beszélgetés-/session-réteg, tenant-izoláció határa az agent) MVP-be beszélgetés-sémával + kapu-leválasztási invariánssal kerül, a kritikussági-szintezett kapu és a teljes beszélgetés-UI Fázis 2 (D9) — üzleti változás esetén az érintett fejezet újranyitandó.*
