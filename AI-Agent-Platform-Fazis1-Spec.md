# Fázis 1 — Működő mag: fejlesztői specifikáció

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.1 — fejlesztői spec
**Dátum:** 2026-06-12
**Kapcsolódó:** `AI-Agent-Platform-Koncepcio.md`, `AI-Agent-Platform-MVP-Terv.md`, `AI-Agent-Platform-Fejlesztesi-Roadmap.md`
**Olvasó:** a fejlesztő(k). Direkt, technikai. Feltételezi a roadmap ismeretét.

---

## Implementációs állapot (2026-06-12, éjjeli frissítés)

**Kódbázis:** `app/` (Next.js App Router)

| Jel | Jelentés |
|---|---|
| ✅ | Kész / bekötve |
| 🟡 | Részben kész |
| ⬜ | Még nincs |

| Terület | Állapot | Megjegyzés |
|---|---|---|
| Next.js projekt + mappastruktúra (12. szakasz) | ✅ | `app/src/` |
| Postgres + Prisma séma (3. szakasz) | ✅ | Minden entitás definiálva |
| **Neon Postgres** hosting | ✅ | `DATABASE_URL` (pooled) + `DIRECT_URL` (migrate) |
| Repository absztrakció (2.1) | ✅ | `repositories/interfaces/` + `postgres/` |
| AuthProvider absztrakció (6. szakasz) | ✅ | Clerk impl + Dev fallback; `ClerkAuthProvider` upsert |
| **Clerk UI + middleware** (6. szakasz) | ✅ | `ClerkProvider`, `clerkMiddleware`, sign-in/up, shell auth gombok |
| Clerk env kulcsok | ✅ | `.env.local`: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |
| Clerk RBAC szinkron | ✅ | Login upsert + **webhook** (`/api/webhooks/clerk`, `user.created`/`updated`) |
| Ticket állapotgép (4. szakasz) | ✅ | `TicketService.transition()` |
| Server actions (5. szakasz) | ✅ | Core actions + `createAgent` (admin) |
| Agent API-kulcs auth (5. szakasz) | ✅ | `POST/GET /api/v1/agent/tickets`, scoped Bearer auth |
| Model Gateway + Gemini (7. szakasz) | ✅ | `@google/genai`, audit + `model_calls` |
| Gemini env | ✅ | `GEMINI_API_KEY` beállítva `.env.local`-ban |
| Könyvelő agent flow (8. szakasz) | ✅ | Runtime + acceptance E2E zöld |
| Tanítás v1 + rollback (9. szakasz) | ✅ | `TrainingService` + **C7** `/control-plane/training` |
| Audit log v1 (3.1, 5. szakasz) | ✅ | Append-only, hash mezők üresen |
| UI bekötés (10. szakasz) | ✅ | C1–C5, **C7**, C8, S1–S2 ✅; **Kanban drag** ✅; mockup polish ⬜ |
| Agent wizard UI | ✅ | `/control-plane/agents/new` (admin) |
| Seed (Könyvelő Agent) | ✅ | `npm run db:seed` |
| DB migráció Neon-on | ✅ | Séma + seed futott (2026-06-12) |
| Production build | ✅ | `npm run build` zöld (2026-06-12) |
| Acceptance (14. szakasz) | ✅ | `npm run test:acceptance` — 22/22 zöld (2026-06-12) |

**Következő lépés:** Production deploy (Vercel/Firebase App Hosting), Clerk webhook endpoint regisztrálása Dashboard-on, UI polish (mockup finomhangolás).

**Acceptance futtatás:** `cd app && npm run test:acceptance`

**Clerk integráció — összefoglaló (2026-06-12):**
- ✅ Szerver: `ClerkAuthProvider` — `currentUser()` → Prisma `users` upsert, RBAC `publicMetadata.role`
- ✅ UI: `AuthProviders` (root layout), `/sign-in`, `/sign-up`, header auth gombok
- ✅ Middleware: `clerkMiddleware` + route protection (agent API + webhook publikus)
- ✅ Dev fallback: Clerk kulcs nélkül `DevAuthProvider` + „Dev auth” badge
- ✅ Webhook: `POST /api/webhooks/clerk` — `verifyWebhook`, `user.created`/`user.updated` → Prisma upsert
- ⬜ Hiányzik: org support (Fázis 2+)

---

## 1. Cél és scope

**Cél:** a kattintható mockup 6 lépéses demó-sztorija (MVP terv 3. szakasz) **valódi backenddel fusson** — Postgres, szerveroldali ticket-állapotgép, valódi auth, **egy valódi agent**, amely valódi LLM-hívással dolgozik. Minden más szándékosan mockolva marad (lásd roadmap 3.2).

### 1.1 In scope

| Terület | Mit építünk |
|---|---|
| Perzisztencia | Postgres, repository-absztrakció mögött |
| Ticket | Szerveroldali állapotgép, validált átmenetek |
| Auth (ember) | Clerk, OIDC-absztrakció mögött, RBAC |
| Agent | 1 db service account + scoped API-kulcs, verziózott rekord |
| Model Gateway | 1 külső modell (Claude), minden hívás naplózva |
| Könyvelő agent | Valódi mező-kinyerés + javaslat dokumentumból |
| Jóváhagyás | Valódi human-in-the-loop kapu |
| Audit log v1 | Append-only, perzisztált (hash-lánc még nem) |
| Tanítás v1 | Memória-verziózás, diff, működő rollback |

### 1.2 Out of scope (Fázis 2+)

Write-gate token, secret futásidejű injektálás, guardrail/PII-szűrés, hash-láncolt tamper-evidence, eval-kapu, valós observability-mérés, eseményvezérelt dispatch, valódi connector, on-prem/lokális modell. Ezek **vizuálisan jelölhetők** (badge, placeholder), de nem implementáltak.

> **Alapelv a scope-on:** Fázis 1 = "működik egy szelet", nem "biztonságos". A keményítés a Fázis 2. Itt a cél a végigvihető, valódi folyamat — egy agenttel, kifogástalanul.

---

## 2. Architektúra

### 2.1 Rétegek

```
┌─────────────────────────────────────────────┐
│  UI (React + Tailwind, a mockupból portolva) │  Control Plane + Sandbox képernyők
├─────────────────────────────────────────────┤
│  API réteg (server actions / route handlers) │  auth-check + input-validáció + audit
├─────────────────────────────────────────────┤
│  Domain szolgáltatások                        │  TicketService, AgentService,
│  (üzleti logika, állapotgép, gateway)         │  TrainingService, ModelGateway, AuditService
├─────────────────────────────────────────────┤
│  Repository absztrakció (interfész)           │  *Repository interfészek
├─────────────────────────────────────────────┤
│  Postgres implementáció (ORM)                 │  cserélhető on-premre (8.7)
└─────────────────────────────────────────────┘
```

**Két absztrakció kötelező már most**, hogy a Fázis 4 cseréi ne legyenek újraírás:

1. **Repository-absztrakció** — a domain szolgáltatások interfészt látnak, nem konkrét ORM-et. (Postgres → később on-prem Postgres / más store.)
2. **AuthProvider-absztrakció** — a domain `getCurrentUser()` / `requireRole()` interfészt lát, nem közvetlen Clerk-hívást. (Clerk → később Keycloak.)

Plusz a **Model Gateway** maga is absztrakció (külső modell → később lokális).

### 2.2 Tech stack — javaslat

| Réteg | Javaslat | Indok | Alternatíva |
|---|---|---|---|
| Keret | **Next.js (App Router)** ✅ | A mockup React-komponensei portolhatók; server actions a ticket-logikára | Külön Node/Express API + React SPA |
| ORM | **Prisma 6** ✅ | Gyors séma-fejlesztés, migrációk, típusbiztos | Drizzle |
| Auth | **Clerk** | Gyors Next.js-integráció, kész UI (4.4.1) | — (OIDC-absztrakció mögött bárcsak cserélhető) |
| Modell | **Google Gemini API** (`@google/genai`) | Van API-kulcs + kész minta a posnavigatorban; egy ökoszisztéma a Firebase/GCP-vel. Anthropic később, a Gateway mögött | Anthropic Claude / OpenAI a Gateway mögött |
| Validáció | **Zod** | Minden API-input sémázva | — |

> **Döntés (2026-06-12):** Next.js full-stack + Prisma + **Neon Postgres** + Gemini + **Clerk** (dev fallback: `DevAuthProvider`).

**Neon env:**
- `DATABASE_URL` — pooled connection (`-pooler` host, `?sslmode=require`)
- `DIRECT_URL` — direct connection (Prisma migrate / seed)

---

## 3. Adatmodell

Az alábbi entitások a Postgres-séma magja. A mezők indikatívak; a migrációban finomítandók.

### 3.1 Entitások

**`users`** — emberi felhasználók (Clerk-höz kötve)
```
id (uuid, pk)
external_auth_id (text, unique)   -- Clerk user id
email (text)
name (text)
role (enum: admin | approver | operator | viewer)
created_at (timestamptz)
```

**`agents`** — agent service account + konfiguráció
```
id (uuid, pk)
name (text)
role_description (text)           -- "Könyvelő agent"
system_prompt (text)
model_config (jsonb)              -- { provider, model, temperature, max_tokens }
status (enum: draft | active | retired)
current_version (int)
memory_id (uuid, fk -> memories)
created_at (timestamptz)
```

**`agent_versions`** — reprodukálhatóság (4.5): bármely ticketre visszakereshető, mivel dolgozott
```
id (uuid, pk)
agent_id (uuid, fk)
version (int)
system_prompt_snapshot (text)
model_config_snapshot (jsonb)
memory_version_id (uuid, fk)
created_at (timestamptz)
```

**`agent_api_keys`** — scoped service-account kulcs (4.4, 4.9)
```
id (uuid, pk)
agent_id (uuid, fk)
key_hash (text)                   -- a nyers kulcs sosem tárolt
scopes (jsonb)                    -- pl. ["ticket:read","ticket:create"]
status (enum: active | revoked)
created_at, last_used_at (timestamptz)
```

**`memories`** + **`memory_versions`** — verziózott tudás (4.6)
```
memories:        id (uuid, pk), agent_id (fk), current_version_id (fk -> memory_versions)
memory_versions: id (uuid, pk), memory_id (fk), version (int),
                 content (text), diff_from_previous (jsonb),
                 status (enum: proposed | active | rolled_back),
                 source (text), approved_by (fk -> users, nullable),
                 created_at (timestamptz)
```

**`resources`** + **`agent_resources`** — first-class erőforrás, many-to-many (4.9)
```
resources:       id (uuid, pk), type (enum: secret|policy|file|dataset|connector|tool),
                 name (text), scope (enum: global|group|single), version (int),
                 data_ref (text), created_at (timestamptz)
agent_resources: agent_id (fk), resource_id (fk), access_mode (enum: read|use)   -- pk(agent_id,resource_id)
```
> Fázis 1-ben elég 1–2 erőforrás (pl. egy "Számlajóváhagyási szabályzat" policy) az anatómia-képernyőhöz (C5). A secret valódi injektálása Fázis 2.

**`tickets`** — a folyamat-szubsztrát (4.2)
```
id (uuid, pk)
type (enum: interaction | training)
title (text)
state (enum: backlog | in_review | approved | in_progress | awaiting_human | done | rejected)
assignee_type (enum: human | agent, nullable)
assignee_id (uuid, nullable)
agent_id (uuid, fk, nullable)     -- melyik agent hozta létre / dolgozik rajta
payload (jsonb)                   -- kinyert mezők, javaslat, indoklás, diff stb.
source_document_id (uuid, fk -> documents, nullable)
execute_after (timestamptz, nullable)   -- séma kész, de Fázis 1-ben opcionális
due_by (timestamptz, nullable)
created_by (uuid)
created_at, updated_at (timestamptz)
```

**`documents`** — sandbox feltöltések (data plane)
```
id (uuid, pk)
filename (text)
storage_ref (text)                -- lokális/objektumtár hivatkozás
extracted_text (text, nullable)
status (enum: uploaded | processing | processed | failed)
uploaded_by (uuid)
created_at (timestamptz)
```

**`audit_log`** — append-only (4.2, 8.5)
```
id (uuid, pk)
seq (bigserial)                   -- monoton sorrend
actor_type (enum: human | agent | system)
actor_id (uuid, nullable)
agent_version (int, nullable)
action (text)                     -- pl. "ticket.transition", "model.call", "memory.rollback"
target_type (text), target_id (uuid, nullable)
model_used (text, nullable)
input_ref (text, nullable), output_ref (text, nullable)
policy_decision (text, nullable)  -- Fázis 1-ben jellemzően "n/a"
prev_hash (text, nullable), hash (text, nullable)   -- séma kész; a lánc kitöltése Fázis 2
created_at (timestamptz)
```
> A `prev_hash`/`hash` mezők **most üresek**, de a séma tartalmazza őket, hogy a Fázis 2 tamper-evidence ne igényeljen migrációt.

**`model_calls`** — token/költség (8.6 előképe)
```
id (uuid, pk), agent_id (fk), ticket_id (fk, nullable),
provider (text), model (text),
prompt_tokens (int), completion_tokens (int), cost_estimate (numeric),
created_at (timestamptz)
```

---

## 4. Ticket-állapotgép (szerveroldali)

A UI **nem** dönti el az átmenetet — a `TicketService.transition()` validál (4.2–4.3).

### 4.1 Engedélyezett átmenetek

| From | To | Ki válthat | Megjegyzés |
|---|---|---|---|
| `backlog` | `in_review` | system / agent | Az agent javaslata bekerül review-ba |
| `in_review` | `awaiting_human` | system | Emberi jóváhagyásra vár |
| `awaiting_human` | `approved` | approver / admin | Human-in-the-loop kapu |
| `awaiting_human` | `rejected` | approver / admin | Visszadobás, indoklással |
| `approved` | `in_progress` | system | Végrehajtás (Fázis 1-ben szimulált "integráció") |
| `in_progress` | `done` | system | Lezárás |
| `rejected` | `in_review` | operator | Javítás után újra |

Minden átmenet **audit-bejegyzést** ír (`action: "ticket.transition"`, from/to, actor). Tiltott átmenet → hiba + nincs állapotváltás.

### 4.2 `Ready` predikátum (egyszerűsített, Fázis 1)

```
végrehajtható = (execute_after IS NULL OR now() >= execute_after)
              AND (state = 'approved')
```
A teljes predikátum (függőségek, jóváhagyási kapuk, dispatch) a Fázis 2 (4.11). Fázis 1-ben az `approved → in_progress → done` triggerelhető egyszerű szerverhívással/gombbal.

---

## 5. API / server actions

Mind **auth-check → Zod-validáció → domain hívás → audit** mintát követ. Standard válasz: `{ success, data?, error? }`.

| Action | Input | Output | Jog |
|---|---|---|---|
| `listTickets` | `{ filter? }` | `Ticket[]` | viewer+ |
| `getTicket` | `{ id }` | `Ticket` | viewer+ |
| `transitionTicket` | `{ id, toState, note? }` | `Ticket` | szerep-függő (4.1) |
| `createInteractionTicket` | `{ agentId, payload, sourceDocumentId? }` | `Ticket` | system/agent-key |
| `listAgents` | `—` | `Agent[]` | viewer+ |
| `getAgent` | `{ id }` | `AgentDetail` (anatómia) | viewer+ |
| `createAgent` | `{ name, role, systemPrompt, modelConfig }` | `Agent` | admin |
| `uploadDocument` | `{ file }` | `Document` | operator+ (sandbox) |
| `processDocument` | `{ documentId, agentId }` | `{ ticketId }` | operator+ |
| `createTrainingTicket` | `{ agentId, proposedContent, source }` | `Ticket` | operator+ |
| `approveTraining` | `{ ticketId }` | `{ memoryVersion }` | approver+ |
| `rollbackMemory` | `{ agentId, toVersion }` | `{ memoryVersion }` | approver+ |
| `listAuditLog` | `{ filter? }` | `AuditEntry[]` | approver+ |
| `getModelCostSummary` | `{ range? }` | `{ tokens, cost }` | viewer+ |

**Agent API (külső kulccsal, scoped):** a `createInteractionTicket` és `getTicket` elérhető agent-API-kulccsal is — a kulcs `scopes` mezője dönt (4.8 board-interakció). Fázis 1-ben az agent-runtime belső (megbízható), de a kulcs-mechanizmus már él.

---

## 6. Auth és jogosultság

- **Clerk** az emberi belépésre, **`AuthProvider` interfész mögött**: `getCurrentUser()`, `requireRole(role)`. A domain réteg sosem hív közvetlen Clerk-et.
- **RBAC szerepek:** `admin` (mindent), `approver` (jóváhagyás, audit, tanítás-jóváhagyás), `operator` (ticket/dokumentum létrehozás, tanítás-javaslat), `viewer` (csak olvas).
- **Agent-authz NEM Clerkben** (4.4.1): az agent kulcsos service account, a jogai a `agent_api_keys.scopes`-ban, a control plane-ben kikényszerítve.

---

## 7. Model Gateway v1

Egyetlen belépési pont a modellhez (4.7). Interfész:

```
ModelGateway.call({
  agentId, ticketId?, messages, modelConfig
}) -> { content, usage: { promptTokens, completionTokens } }
```

**Első provider: Google Gemini.** Van API-kulcs, és a posnavigatorban már van kész minta — azt a hívásmintát hasznosítjuk újra (nem a Mongo-függő konfigot).

Felelőssége Fázis 1-ben:
- a megfelelő provider (**Gemini**) hívása a `modelConfig` szerint,
- **minden hívás naplózása**: `audit_log` (`action: "model.call"`) + `model_calls` (token, becsült költség),
- hiba- és timeout-kezelés, **429/RESOURCE_EXHAUSTED retry** (a posnavigator mintája szerint).

**Gemini-integráció konkrétumok (posnavigator `gemini-actions.ts` alapján):**
- SDK: `@google/genai` (`GoogleGenAI`), kulcs `GEMINI_API_KEY` env-ből.
- Hívás: `genAI.models.generateContent({ model, contents })`; a `model` a `modelConfig`-ból jön.
- Modellek: `gemini-2.5-flash-lite` (gyors/olcsó, alapértelmezett), `gemini-2.5-flash`, `gemini-2.5-pro` (összetettebb kinyerésre).
- **Fontos eltérés a posnavigatortól:** a modell-konfig nálunk **nem** Mongo-ból jön, hanem az `agents.model_config` (jsonb) mezőből — a control plane Postgres a forrás. Csak a hívásmintát vesszük át, a perzisztenciát nem.
- A token-használatot a Gemini válasz `usageMetadata` mezőjéből olvassuk ki a `model_calls`-hoz.

**Provider-csere (Anthropic később):** a Gateway interfész provider-független; az Anthropic/Claude egy plusz adapter ugyanazon `ModelGateway.call()` mögött, az agent kódja nem változik (4.7).

Guardrail/PII-szűrés **nincs** itt még (Fázis 2) — de a Gateway az egyetlen út a modellhez, hogy oda később egy helyen beköthető legyen.

---

## 8. A könyvelő agent — végrehajtási folyamat

A demó-sztori motorja (5.2, 11.1). Lépések:

1. **Feltöltés (S1):** `uploadDocument` → `documents` rekord, `status: uploaded`. Fázis 1-ben elfogadunk szöveges/PDF-ből kinyert szöveget (`extracted_text`); a robusztus OCR Fázis 2+.
2. **Indítás:** `processDocument(documentId, agentId)` → `status: processing`, és meghívja az **agent-runtime**-ot (belső szolgáltatás).
3. **Agent dolgozik:** a runtime összeállítja a promptot (system_prompt + memória + dokumentum-szöveg), hívja a **Model Gateway**-t, és **strukturált javaslatot** kap: kinyert mezők (szállító, összeg, dátum, tételek), könyvelési javaslat, rövid indoklás. Kimenet Zod-dal validálva.
4. **Ticket létrehozása:** `createInteractionTicket` — `type: interaction`, `state: in_review` → `awaiting_human`, `payload`-ban a javaslat + `source_document_id`. `documents.status: processed`.
5. **Emberi kapu (C3):** approver megnyitja, látja a javaslatot + forrásdokumentumot + indoklást → `transitionTicket(approved)` vagy `rejected`.
6. **Lezárás:** `approved → in_progress → done`. Fázis 1-ben a "tényleges könyvelésbe töltés" **szimulált** (nincs valódi connector — az Fázis 3). Minden lépés audit-bejegyzés.

---

## 9. Tanítás v1 (verziózás + rollback)

A "az AI nálunk nem driftel el" sztori (4.6, 8.1) — write-gate token **nélkül** (az Fázis 2).

1. `createTrainingTicket(agentId, proposedContent, source)` → `type: training` ticket; a rendszer kiszámolja a **diffet** a jelenlegi `memory_versions.current` tartalmához képest, `payload`-ba teszi.
2. A ticket az emberi jóváhagyási kapun megy (`awaiting_human → approved`).
3. `approveTraining(ticketId)` → új `memory_versions` rekord (`status: active`), a `memories.current_version_id` rámutat; a régi `active` lezárul. Audit: `memory.update`.
4. `rollbackMemory(agentId, toVersion)` → a `current_version_id` visszaáll egy korábbi verzióra; új audit-bejegyzés (`memory.rollback`). A UI-n egy gomb.

> A tényleges memória-írást **a platform végzi** (nem az agent saját döntéséből) — ez a Fázis 2 write-gate token előképe már most helyes szervezésben.

---

## 10. UI — a mockup képernyők bekötése valódi adatra

A Fázis 0 képernyői (MVP terv 4. szakasz) maradnak; a mock-adat réteget valódi API-hívás váltja.

| Képernyő | Adatforrás | Megjegyzés |
|---|---|---|
| C1 Dashboard | `listAgents`, `listTickets`, `getModelCostSummary` | Élő számok |
| C2 Kanban board | `listTickets` + `transitionTicket` | ✅ Drag-and-drop, szerver validál |
| C3 Ticket részlet | `getTicket` + `transitionTicket` | Jóváhagyás-gombok |
| C4 Agent registry | `listAgents` | ✅ + `/agents/new` wizard |
| C5 Agent anatómia | `getAgent` | Erőforrások, memória-verzió, modell |
| C7 Tanítás + rollback | `createTrainingTicket`, `approveTraining`, `rollbackMemory` | ✅ `/control-plane/training`, diff-nézet |
| C8 Audit log | `listAuditLog` | Szűrhető; hash-lánc badge "Fázis 2" |
| S1 Könyvelő munkatér | `uploadDocument`, `processDocument` | Sandbox |
| S2 Javaslat-részlet | `getTicket` (payload) | "Küldés jóváhagyásra" |

---

## 11. Nem-funkcionális követelmények (Fázis 1 szint)

- **Hibakezelés:** strukturált hibák, standard `{ success, error }` válasz; a UI értelmes hibát mutat.
- **Idempotencia (alap):** `processDocument` ne induljon kétszer ugyanarra a dokumentumra (`status` ellenőrzés). Teljes ticket-lock Fázis 2.
- **Konfiguráció/titkok (dev):** API-kulcsok env-ből; még **nincs** valódi secret-vault (Fázis 2).
- **Időzóna:** tárolás UTC, megjelenítés lokál.
- **Naplózás teljessége:** minden állapotváltás, modellhívás, tanítás és rollback audit-bejegyzés — ez a fázis lényege.

---

## 12. Projektstruktúra (javaslat, Next.js)

```
src/
  app/                      # UI + route handlers / server actions
    control-plane/          # C1–C8 képernyők
    sandbox/                # S1–S2 képernyők
    api/ (vagy server-actions/)
  domain/
    ticket/                 # TicketService, állapotgép
    agent/                  # AgentService, runtime
    training/               # TrainingService
    gateway/                # ModelGateway
    audit/                  # AuditService
  repositories/
    interfaces/             # *Repository interfészek
    postgres/               # Prisma-implementáció
  auth/                     # AuthProvider absztrakció (Clerk-impl)
  lib/validators/           # Zod sémák
  prisma/                   # schema.prisma, migrations
```

---

## 13. Munkacsomagok és becslés

| # | Munkacsomag | Tartalom | Becslés | Állapot |
|---|---|---|---|---|
| WP1 | Alapváz | Next.js projekt, Neon+Prisma, Clerk, repository+auth absztrakció, mockup UI portolása | 1 hét | ✅ |
| WP2 | Ticket-mag | Séma, állapotgép, `listTickets`/`getTicket`/`transitionTicket`, C2–C3 bekötve | 1 hét | ✅ |
| WP3 | Agent + Gateway | Agent registry, `agent_versions`, Model Gateway + Gemini, `model_calls`, C4–C5, `createAgent`, agent API | 1–1,5 hét | ✅ |
| WP4 | Könyvelő agent flow | Dokumentum-feltöltés, runtime, kinyerés+javaslat, ticket-létrehozás, S1–S2 | 1–1,5 hét | ✅ |
| WP5 | Audit + tanítás | Audit log v1, C8, tanítás-verziózás, rollback, C7 | 1 hét | ✅ |
| WP6 | Integráció + acceptance | End-to-end összekötés, acceptance-forgatókönyvek, hibajavítás | 0,5–1 hét | ✅ |
| WP7 | UI + auth polish | Kanban drag, C7 oldal, agent wizard, Clerk webhook | 0,5 hét | ✅ |

**Összesen: ~5–7 hét**, 1–2 fejlesztő (egybevág a roadmap becslésével).

---

## 14. Kilépési kritérium (acceptance)

A fázis akkor kész, ha az alábbi forgatókönyvek **valódi adaton, stabilan** lefutnak:

1. **End-to-end:** operator feltölt egy számlát → a könyvelő agent valódi LLM-hívással javaslatot ad → ticket keletkezik `awaiting_human`-ban → approver jóváhagyja → `done` → minden lépés megjelenik az audit logban (agent-verzióval, modellel, tokennel).
2. **Visszadobás:** approver `rejected`-be teszi indoklással → operator javít → újra review.
3. **Tanítás:** operator tanítási tickettet hoz létre → approver jóváhagyja → új memória-verzió aktív → az agent következő futása ezt használja.
4. **Rollback:** approver visszagörgeti a memóriát egy korábbi verzióra → audit rögzíti → az agent újra a régi tudással dolgozik.
5. **Tiltott átmenet:** a UI/szerver elutasít egy nem engedélyezett állapotváltást, és nem módosul az állapot.
6. **Reprodukálhatóság:** egy lezárt ticketnél visszakereshető, melyik agent-verzió + memória-verzió + modell dolgozott rajta.

---

## 15. Nyitott döntések

- ~~**Tech stack véglegesítése**~~ → ✅ Next.js + Prisma + Neon + Gemini
- ~~**Postgres hosting**~~ → ✅ Neon (pooled + direct URL)
- **Dokumentum-bemenet köre Fázis 1-ben:** csak szöveg/egyszerű PDF-text, vagy már most kép-OCR? (Javaslat: szöveg/PDF-text, OCR Fázis 2.) — 🟡 szöveg implementálva
- **Első demó use case megerősítése:** könyvelő/számla marad — ✅ seed + runtime erre kész
- **Tárolás dokumentumokra:** lokális FS dev-re (`app/uploads/`) — 🟡 pilot; objektumtár Fázis 3

---

*Ez a spec a Fázis 1-et fedi. A Fázis 2 (governance + biztonsági keménység) külön specet kap, ha a Fázis 1 kilépési kritériuma teljesült.*
