# Feature-spec — Agent Registry, életciklus és konfigurálható szerepek

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-29
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (§4.5 Agent Registry & életciklus, §4.5.1 konfigurálható szerepek / orchestrator, §4.6 tanítás-memória, §4.6.1 write-gate, §4.6.4 önfejlesztési profil, §4.7 modell-konfiguráció, §4.9.1 megosztott erőforrás, §8.2 capability/RBAC, §8.8 tenant-izoláció), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (v1.0, §4.2 `agents`/`agent_versions`/`agent_api_keys` séma, CR-MVP-002 szerep- és önfejlesztési horgok, §10 API: `createAgent`/`updateAgentInstruction`/`getAgent`, reprodukálhatóság), `AI-Agent-Platform-Feature-Spec-Playbook.md` (orchestrator → ticket-nyitás, állapotgép), `AI-Agent-Platform-Feature-Spec-ConversationSession.md` (v1.0, `agent_version` a fordulón), `AI-Agent-Platform-Feature-Spec-ModelGateway.md` (modell-konfiguráció routingja)
**Olvasó:** fejlesztő(k). Feltételezi az append-only audit (`verifyChain`), az RBAC (`requireRole`), a Tool Broker capability-modell (`authorize()`), a Model Gateway routing és a write-gate token ismeretét.
**Státusz:** **MVP-horgok kész, teljes feature Fázis 2.** Az `agents` / `agent_versions` / `agent_api_keys` séma, a `role` enum (`worker | orchestrator`), a `self_evolution_profile` jsonb-mező, a `roleInstruction` / `behaviorProfile` külön verziózása és a reprodukálhatósági snapshot az MVP-ben **be van kötve** (CR-MVP-002, Epik 3 lezárva). Ez a dokumentum a **teljes** Agent Registry réteget specifikálja: az életciklus-állapotgépet kapukkal, a konfigurálható szerep-sablonokat (orchestrator tool-less invariáns), az önfejlesztési profil kikényszerítését (kemény padló) és a megosztott viselkedés-profilt mint újrahasznosítható erőforrást.

---

## 0. Mit ad ez a dokumentum

Meghatározza, hogyan lesz az **agent** a platform első, gerinc-entitása (a beszélgetés és a ticket mellett — koncepció §4.14), és hogyan érvényesül rajta a koncepció központi állítása: *„az agentek nem tanulnak és nem módosulnak kontroll nélkül"* (§2). Az Agent Registry az a hely, ahol egy AI-munkatárs „megszületik", konfigurálódik, verziózódik, élesedik és nyugdíjazódik — minden lépés auditált és reprodukálható.

**A feature négy, élesen elhatárolt invariánsra épül:**

1. **Minden agent-futás verzió-attribútált.** Egy lezárt munka mindig egy `agent_versions` snapshotra mutat, amely befagyasztja a szerep-instrukciót, a viselkedés-profilt, a modell-konfigurációt, a memória-verziót és a recipe-verziót. A reprodukálhatóság nem opció: bármely ticketről / fordulóról visszakereshető, *melyik verzió* dolgozott rajta (§4.5).
2. **A szerep konfiguráció, nem kód.** A platform **nem ismer egyetlen privilegizált „mester-agentet"** (§4.5.1). Az „orchestrator" egy *opcionális*, *tool-less* szerep-sablon, amelynek egyetlen kimenő művelete a ticket-nyitás; nincs Tool Broker capability-je és nincs rendszerbe-író joga. A runtime sehol nem feltételezhet beégetett fő-agentet.
3. **Az önfejlesztés tárcsa, nem kapcsoló — és van kemény padlója.** A write-gate (§4.6.1) **minden** agentre érvényes; a kapu *erőssége* per-agent állítható (`self_evolution_profile`), de a verziózás + rollback + audit + szerveroldali, egyszer használatos token **sosem kapcsolható ki**. Agent önmódosítással **soha nem bővítheti** a saját jogosultságait / eszköz-hozzáférését.
4. **Az instrukció két, külön verziózott rétegből áll.** A *szerep-instrukció* (mit csinál) agent-egyedi; a *viselkedés-profil* (hogyan: hangnem, nyelv, formázás, citálás) **megosztott, újrahasznosítható erőforrásként** több agentre köthető (§4.5, §4.9.1). Mindkettő a write-gate hatálya alatt.

**Miért fontos feature:** az Agent Registry minden más réteg dependenciája. A Playbook-spec orchestrator szerepet feltételez; a ConversationSession-spec a fordulóhoz `agent_version`-t köt; a Model Gateway az agent `model_config`-ját routingolja; a write-gate / tanítási pipeline az agent `self_evolution_profile`-ja szerint választ jóváhagyási útvonalat. A formalizálás ezért keresztbe stabilizálja a meglévő rétegeket, és kódszinten zárja ki a privilege-escalationt (OWASP LLM06, §0.7).

---

## 1. Scope

### 1.1 In scope (teljes feature)

1. **`agents` registry** mint tenant-scoped, verzió-attribútált első-rendű entitás: identitás, státusz, kétrétegű instrukció-referencia (szerep + viselkedés), modell-konfiguráció, memória-verzió, szerep, önfejlesztési profil.
2. **Életciklus-állapotgép** explicit átmenetekkel és kapukkal: `draft → active → suspended → retired` (+ visszaút `suspended → active`), minden átmenet RBAC-kapuzott és auditált; az aktiválás opcionális eval-kapuhoz köthető.
3. **`agent_versions` snapshot-lánc** mint reprodukálhatósági gerinc: minden élesített konfiguráció befagyasztott, immutábilis verzióként él; minden agent-futás pontosan egy verzióra hivatkozik.
4. **Kétrétegű, külön verziózott instrukció:** `role_instruction` (agent-egyedi) és `behavior_profile` (megosztható erőforrás), mindkettő al-verziózva, mindkettő a write-gate hatálya alatt.
5. **Megosztott viselkedés-profil** mint újrahasznosítható erőforrás (`behavior_profiles`), amely több agentre köthető (egységes céges hangnem / output-szabvány); a profil módosítása jóváhagyott, auditált, és a hivatkozó agentek verziózását váltja.
6. **Konfigurálható szerep-sablonok** (`role_templates`): a `worker` és az `orchestrator` mint adat-konfiguráció; az orchestrator **tool-less** invariánsa sémaszinten és runtime-ban kikényszerítve.
7. **Önfejlesztési profil kikényszerítése:** a `self_evolution_profile` mint a write-gate kapu-erősség-tárcsája; a kemény padló (jogosultság-/eszköz-bővítés tiltása önfejlesztési útvonalon) kódszintű enforcement-tel.
8. **Scoped, rotálható service-account kulcsok** (`agent_api_keys`): hash-elt tárolás, capability-scope, rotáció és visszavonás (a per-user delegált hozzáférés külön spec — §4.12.1).
9. **Reprodukálhatósági API:** bármely ticket / forduló / audit-esemény visszavezethető a konkrét `agent_version` snapshotra (szerep + viselkedés + modell + memória + recipe).
10. **Control Plane UI:** agent-lista státusszal, agent-detail (anatómia: verzió, memória-verzió, recipe, modell), életciklus-műveletek, instrukció-szerkesztő diff+jóváhagyással, viselkedés-profil-katalógus, önfejlesztési-profil szerkesztő.

### 1.2 Out of scope (most NEM)

- **A tanítási / memória-író motor belső működése** (diff-generálás, eval-futtatás, write-token kiállítás) — külön memória / self-evolution spec (koncepció §0.10). Ez a dokumentum csak a **konfigurációs felületet** (`self_evolution_profile`) és a **kemény-padló invariánst** specifikálja, nem a pipeline-t.
- **A reflexiós feeder** (§4.6.3) — a reflexió mint tanítási-ticket javaslat-generátor a memória-spec hatóköre; itt csak annyi, hogy a javaslat az agent profilja szerinti kapun megy át.
- **A memória-retrieval / hibrid keresés** (§4.6.2, elhalasztott) — az agent `current_memory_version`-jét hivatkozzuk, de a visszakeresés motorja nem itt él.
- **A Model Gateway routing-logikája** (§4.7.1) — az agent `model_config`-ját *tároljuk és snapshotoljuk*, de a routing-döntés a Model Gateway-spec hatóköre.
- **A teljes multi-agent orchestrator-flow** (delegálás, Playbook-vezérelt indítás) — a Playbook-spec + Fázis 2; itt csak a szerep-sablon és a tool-less invariáns.
- **Per-user (delegált) connector-kredenciálok** (`connector_grants`, §4.12.1) — külön spec; az `agent_api_keys` itt csak a `service` auth-mode service-account kulcsát fedi.

### 1.3 Az MVP-re gyakorolt hatás

A feature **additív és nagyrészt már meglévő horgokra épül**. Az MVP (CR-MVP-002, Epik 3 lezárva) már tartalmazza: az `agents` / `agent_versions` / `agent_api_keys` táblát tenant-scope-pal, a `role` enumot (`worker | orchestrator`) a tool-less szabállyal, a `self_evolution_profile` jsonb-mezőt (NULL = legszigorúbb), a `role_instruction` / `behavior_profile` külön verziózását és al-verzióit, az `updateInstruction` API-t + `agent.version` audit-eseményt, valamint a reprodukálhatósági snapshotot (`findVersionSnapshot`, recipe-verzió-kötés). Ez a spec ezeket **kiegészíti** (teljes életciklus-állapotgép kapukkal, megosztott viselkedés-profil mint önálló entitás, önfejlesztési-profil end-to-end enforcement, eval-kapu az aktiváláskor, UI), nem írja át. A meglévő RBAC, audit, write-gate és Model Gateway változatlanul újrahasznosul.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

```
        ┌──────────────────────────── CONTROL PLANE (1. app) ─────────────────────────────┐
        │                                                                                  │
        │   ┌───────────────────────────┐        ┌──────────────────────────────────────┐ │
        │   │  AGENT REGISTRY            │        │  ÉLETCIKLUS-ÁLLAPOTGÉP               │ │
        │   │  agents (tenant-scoped)    │───────▶│  draft→active→suspended→retired       │ │
        │   │  role | self_evolution     │        │  RBAC-kapu + opc. eval-kapu (active)  │ │
        │   │  → role_instruction (egyedi)│        └──────────────────┬───────────────────┘ │
        │   │  → behavior_profile (közös) │                           │ aktiváláskor: snapshot│
        │   └─────────┬─────────────────┬┘                           ▼                       │
        │             │ hivatkozik       │ minden élesítés     ┌──────────────────────┐       │
        │             ▼                  ▼  befagy             │  agent_versions      │       │
        │   ┌──────────────────┐  ┌───────────────┐           │  (immutábilis lánc)  │       │
        │   │ behavior_profiles│  │ role_templates │           └──────────┬───────────┘       │
        │   │ (megosztott)     │  │ worker|orchestr│                      │ snapshot-ref       │
        │   └──────────────────┘  └───────────────┘                      │                    │
        │                                                                 ▼                    │
        │   self_evolution_profile ──▶ WRITE-GATE (§4.6.1) ──▶ kapu-erősség választás          │
        │   ▲ kemény padló: jogosultság-/eszköz-bővítés TILOS önfejlesztési úton               │
        │   │                                                                                  │
        │   agent.* életciklus + instrukció-változás ──▶ APPEND-ONLY AUDIT (§8.5)              │
        └──────────────────────────────────────────────────────────────────────────────────────┘
            │ agent_version            │ model_config            │ role=orchestrator
            ▼ (forduló/ticket)         ▼ (routing)               ▼ (egyetlen művelet)
      CONVERSATION / TICKET       MODEL GATEWAY (§4.7)        TICKET-NYITÁS (§4.2)
      (reprodukálhatóság)         (snapshotolt config)        (tool-less, delegál)
```

**Kulcselv:** az agent nem futásidőben „talál ki" magáról dolgokat — minden, ami a viselkedését meghatározza (szerep, hangnem, modell, memória, eszközjogok), **deklaratív, verziózott konfiguráció** a Control Plane-ben. A futás csak egy befagyasztott `agent_version`-t *olvas*. Ez teszi a driftet láthatóvá és a reprodukálhatóságot garantálttá.

---

## 3. Adatmodell

A meglévő MVP-séma (§4.2) kibővítve a teljes feature-höz szükséges mezőkkel/táblákkal. Prisma-szerű jelölés; a **dőlt** mezők az MVP-n túli, Fázis 2 kiegészítések.

### 3.1 `agents` — az élő agent-rekord (tenant-scoped)

```
id                                uuid  pk
tenant_id                         uuid  not null         -- izoláció határa az agent (§8.8); nincs cross-tenant megosztás
name                              text  not null
status                            enum(draft|active|suspended|retired) default draft
role_template_id                  fk role_templates not null   -- worker | orchestrator (3.5); NEM beégetett típus
current_role_instruction_version  int   not null         -- "mit csinál" (agent-egyedi)
current_behavior_profile_id       fk behavior_profiles nullable  -- "hogyan" (megosztott erőforrás, 3.4)
current_behavior_profile_version  int   nullable         -- a hivatkozott profil pinnelt al-verziója
model_config                      jsonb not null         -- { provider, model, temperature, max_tokens } (§4.7)
current_memory_version            int   nullable         -- a §4.6 memória aktuális verziója (olvasás-oldal)
self_evolution_profile            jsonb nullable         -- a write-gate kapu-erőssége (3.6); NULL = legszigorúbb (human)
created_by                        fk users not null
created_at                        timestamptz not null
updated_at                        timestamptz not null

-- Fázis 2 kiegészítések:
retired_at                        timestamptz nullable    -- nyugdíjazás időbélyege; retired agent nem dispatchelhető
suspended_reason                  text nullable
```

**Invariáns:** `role_template_id` = orchestrator ⇒ az agentnek **nem** lehet sora a Tool Broker capability-táblájában (§8.2), és a `model_config` csak a Model Gateway-hez ad jogot (3.5, N-AR-2). NULL `self_evolution_profile` = a legszigorúbb (emberi jóváhagyásos) kapu — a hiányzó konfiguráció soha nem jelent „szabad" tanulást (N-AR-4).

**Index:** `(tenant_id, status)` a lista-nézethez; `(tenant_id, role_template_id)` a szerep-szűréshez; `(current_behavior_profile_id)` a profil-hivatkozók felderítéséhez (kaszkád-verziózáshoz).

### 3.2 `agent_versions` — immutábilis reprodukálhatósági snapshot

```
id                        uuid  pk
agent_id                  fk agents not null
version                   int   not null          -- monoton, per-agent
role_instruction_snapshot text not null           -- befagyasztott szerep-instrukció szöveg
behavior_profile_snapshot text nullable           -- befagyasztott viselkedés-profil szöveg (a hivatkozott al-verzióból másolva)
model_config_snapshot     jsonb not null
memory_version_id         fk memory_versions nullable
recipe_version_id         fk recipe_versions nullable
self_evolution_snapshot   jsonb nullable           -- a futáskor érvényes kapu-profil (audithoz)
created_by                fk users not null
created_at                timestamptz not null
```

**Invariáns (immutabilitás):** a `agent_versions` sor **append-only** — soha nem `UPDATE`/`DELETE`. Minden élesítés (`activate`) vagy jóváhagyott instrukció-/profil-változás új `version` rekordot ír. Egy `tickets` / `messages` / `model_calls` / `tool_calls` sor `(agent_id, agent_version)` párja erre a snapshotra mutat — így a futás akkor is reprodukálható, ha az agent később megváltozik vagy nyugdíjazódik.

### 3.3 `role_instructions` *(al-verziózott, agent-egyedi „mit csinál")*

```
id            uuid pk
agent_id      fk agents not null
version       int  not null          -- per-agent al-verzió
body          text not null
change_note   text nullable          -- a jóváhagyott diff indoklása
approved_by   fk users nullable      -- write-gate jóváhagyó (§4.6.1)
created_at    timestamptz not null
```

### 3.4 `behavior_profiles` + `behavior_profile_versions` *(MEGOSZTOTT erőforrás — „hogyan")*

A viselkedés-profil **nem** agent-egyedi: önálló, tenant-scoped, újrahasznosítható erőforrás (§4.5, §4.9.1), amelyet több agent is hivatkozhat (egységes céges hangnem, nyelv, formázás, citálási kötelezettség).

```
behavior_profiles
  id          uuid pk
  tenant_id   uuid not null
  name        text not null          -- pl. "Excellence – magyar, tömör, citálás-kötelező"
  current_version int not null
  created_at  timestamptz not null

behavior_profile_versions
  id          uuid pk
  profile_id  fk behavior_profiles not null
  version     int  not null
  body        text not null
  approved_by fk users nullable      -- a write-gate alá esik (§4.6.1)
  created_at  timestamptz not null
```

**Kaszkád-verziózási szabály:** ha egy `behavior_profile` új al-verzióra promótálódik, az **nem** változtatja meg automatikusan a hivatkozó agentek élő viselkedését — a hivatkozó agentnek külön „profil-frissítés elfogadása" műveletet kell kapnia, amely **új `agent_versions` snapshotot** ír (a `behavior_profile_snapshot` az új profil-al-verzióból másolódik). Így a megosztott profil módosítása sem jelent kontrollálatlan, csendes drift-et a hivatkozó agenteken (N-AR-3).

### 3.5 `role_templates` *(konfigurálható szerep — nincs beégetett „fő-agent")*

```
id                  uuid pk
tenant_id           uuid nullable           -- NULL = rendszer-szintű beépített sablon
key                 enum(worker|orchestrator) not null
display_name        text not null
tool_access_allowed boolean not null         -- orchestrator = FALSE (tool-less by design)
allowed_outbound    jsonb not null           -- worker: tetszőleges capability; orchestrator: ["ticket:create"] kizárólag
self_evolution_allowed boolean not null      -- az orchestrator is a write-gate alatt áll (nincs kivételezett státusz)
created_at          timestamptz not null
```

**Az orchestrator szerep invariánsai (§4.5.1):**

- `tool_access_allowed = false` ⇒ a Tool Broker `authorize()` **megtagad** minden eszközhívást orchestrator-agentnek, függetlenül attól, mit kér a modell (N-AR-2). A capability-tábla írása orchestrator `agent_id`-re szerveroldali elutasítás + audit.
- `allowed_outbound = ["ticket:create"]` ⇒ az orchestrator egyetlen rendszerbe-író művelete a ticket-nyitás (worker-agenteknek, Playbookra hivatkozva — §4.10.6). Beszéd a felhasználóval a Model Gateway-en át történik, eszközjog nélkül.
- `self_evolution_allowed = true`, **de** a kemény padló (3.6) az orchestratorra is áll: önmódosítással ő sem kaphat eszközjogot.

### 3.6 `self_evolution_profile` — a write-gate kapu-erősség-tárcsája (jsonb-séma)

A `agents.self_evolution_profile` jsonb-objektum a §4.6.4 „tárcsa, nem kapcsoló" konfigurációja:

```jsonc
{
  "scope": ["memory"],                 // mit módosíthat magán: memory | behavior | role (bővülő = erősebb kapu indokolt)
  "approval_mode": "human",            // human | higher_role | eval_only | auto_after_eval
  "diff_limit": { "max_items": 5, "max_salience": 0.3 }  // egy ciklusban érinthető diff mérete/súlya
}
```

**Fix, nem konfigurálható (mindig kötelező — §4.6.4):** verziózás + rollback + teljes audit, valamint a platform kezében maradó, szerveroldali, egyszer használatos, aláírt write-token. Ezek a séma részei sem — kódszinten beégetett invariánsok, amelyeket a `self_evolution_profile` nem írhat felül.

**Kemény padló (sosem konfigurálható ki):** az önfejlesztési útvonalon **tilos** a `capabilities` (Tool Broker), az RBAC-szerepek és a `agent_api_keys.scopes` bővítése. A `scope` legfeljebb `memory | behavior | role` lehet — **eszköz/hatáskör nem szerepelhet benne**; a sémavalidáció elutasít minden ilyen kulcsot, és a tanítási pipeline a kapuhívás előtt másodszor is ellenőrzi (`capability_escalation_denied` audit-esemény, N-AR-5). Jogosultság-bővítés kizárólag külön emberi admin-aktus (3.1 RBAC), sosem self-service.

### 3.7 `agent_api_keys` — scoped, rotálható service-account kulcs

```
id          uuid pk
agent_id    fk agents not null
key_hash    text not null            -- a nyers kulcs SOSEM tárolt (csak hash)
scopes      jsonb not null           -- pl. ["ticket:read","tool:kb_search"] — orchestratornál csak ["ticket:create"]
status      enum(active|revoked) default active
rotated_at  timestamptz nullable
last_used_at timestamptz nullable
created_at  timestamptz not null
```

A `scopes` az önfejlesztési útvonalon **nem** bővíthető (3.6 kemény padló). A per-user (`user_delegated`) kredenciálok nem itt élnek — azokat a `connector_grants` kezeli (§4.12.1, külön spec).

---

## 4. Életciklus-állapotgép

```
            create (admin)                 activate                       suspend (admin/auto)
   ●  ───────────────────▶  draft  ──────────────────────▶  active  ◀──────────────────────  suspended
                              │         🔒 RBAC + opc.         │  │       resume (admin)            ▲
                              │            eval-kapu           │  └────────────────────────────────┘
                              │                                │  suspend
                              │ discard (admin)                │ retire (admin)
                              ▼                                ▼
                          (törölt draft)                    retired ── (terminális; nem dispatchelhető)
```

| Átmenet | Ki / mi váltja | Kapu | Mellékhatás |
|---|---|---|---|
| `→ draft` | admin (`createAgent`) | 🔒 RBAC `agent:create` | rekord létrejön, **nincs** `agent_versions` snapshot; draft nem dispatchelhető |
| `draft → active` | admin (`activateAgent`) | 🔒 RBAC `agent:activate` **+ opcionális eval-kapu** | **új `agent_versions` snapshot** befagyasztása (szerep+viselkedés+modell+memória+recipe); az agent ettől dispatchelhető |
| `active → suspended` | admin **vagy** automatikus (guardrail-trigger, pl. költség-/hibaarány) | 🔒 RBAC `agent:suspend` (kézi); auto-trigger naplózott | folyamatban lévő futások kifutnak, új dispatch tiltott |
| `suspended → active` | admin (`resumeAgent`) | 🔒 RBAC `agent:activate` | nincs új snapshot, ha a konfiguráció nem változott; ha igen → új verzió |
| `active/suspended → retired` | admin (`retireAgent`) | 🔒 RBAC `agent:retire` | terminális; `retired_at` beáll; a `agent_versions` lánc **megmarad** (reprodukálhatóság); a nyugdíjazott agent múltbeli futásai továbbra is visszakereshetők |
| `draft → (discard)` | admin | 🔒 RBAC `agent:create` | csak snapshot nélküli draft törölhető; aktivált agent **nem** törölhető, csak nyugdíjazható (audit-megőrzés) |

**Invariánsok:**

- Csak `active` agent dispatchelhető (a dispatcher §5.7 elutasít minden mást → audit).
- Aktiváláskor **mindig** keletkezik `agent_versions` snapshot — különben a futás nem lenne reprodukálható (N-AR-1).
- Aktivált / nyugdíjazott agent **soha nem törölhető fizikailag** — a múltbeli munkák attribútálhatósága megőrzendő (§4.5, §8.5).
- Az eval-kapu az aktiváláskor opcionális, de ha az agent `self_evolution_profile.approval_mode` ∈ {`eval_only`, `auto_after_eval`}, akkor a tanítás-vezérelt verzióváltáshoz az eval-kapu **kötelező** (a memória-spec futtatja).

---

## 5. Szolgáltatás-réteg / API

Az MVP API (§10) kibővítve. Minden mutáló hívás `requireRole`-kapuzott, append-only auditba ír, és tenant-scope-ot kényszerít.

```
-- Életciklus
createAgent({ name, roleTemplateKey, roleInstruction, behaviorProfileId?, modelConfig, selfEvolutionProfile? }) -> Agent          [admin]
activateAgent({ agentId, runEval? }) -> AgentVersion                                                                              [admin]   -- snapshot + opc. eval
suspendAgent({ agentId, reason }) -> Agent                                                                                        [admin|system]
resumeAgent({ agentId }) -> Agent                                                                                                 [admin]
retireAgent({ agentId }) -> Agent                                                                                                 [admin]

-- Instrukció (write-gate alatt — §4.6.1)
updateAgentInstruction({ agentId, roleInstruction?, behaviorProfileId? }) -> AgentVersion                                          [admin]   -- diff + jóváhagyás → új al-verzió
acceptBehaviorProfileUpdate({ agentId, profileId, profileVersion }) -> AgentVersion                                                [admin]   -- megosztott profil-frissítés befogadása (3.4 kaszkád)

-- Megosztott viselkedés-profil
createBehaviorProfile({ name, body }) -> BehaviorProfile                                                                          [admin]
updateBehaviorProfile({ profileId, body }) -> BehaviorProfileVersion                                                              [admin]   -- write-gate; NEM frissíti csendben a hivatkozókat

-- Önfejlesztési profil
setSelfEvolutionProfile({ agentId, scope, approvalMode, diffLimit }) -> Agent                                                      [admin]   -- séma-validáció: scope ⊆ {memory,behavior,role}; eszköz/hatáskör TILOS

-- Kulcsok
rotateAgentApiKey({ agentId }) -> { keyOnceVisible }                                                                              [admin]
revokeAgentApiKey({ keyId }) -> void                                                                                              [admin]

-- Olvasás / reprodukálhatóság
getAgent({ agentId }) -> AgentDetail                       -- anatómia: aktuális verzió, memória-verzió, recipe, modell, szerep, self_evolution_profile
listAgents({ status?, role? }) -> Agent[]
findVersionSnapshot({ agentId, version }) -> AgentVersion  -- bármely múltbeli futás visszafejtéséhez
```

**Reprodukálhatóság (kötelező):** minden agent-futás (`tickets`, `messages`, `model_calls`, `tool_calls`) pontosan egy `agent_versions` rekordra hivatkozik. Egy lezárt munkáról a `findVersionSnapshot` visszaadja a befagyasztott szerep + viselkedés + modell + memória + recipe állapotot — akkor is, ha az agent azóta változott vagy nyugdíjazódott.

---

## 6. Konfigurálható szerepek — az orchestrator mint tool-less sablon

A §4.5.1 architekturális elv kódszintű leképezése: **a runtime sehol nem feltételezhet egyetlen privilegizált „mester-agentet".** A szerep `role_templates` adat (3.5), nem `if (agent.isMaster)` típusú elágazás.

**Worker (alapértelmezett):** tetszőleges capability-vel felruházható (Tool Broker, §8.2), Playbook-lépéseket hajt végre, dokumentumot dolgoz fel, rendszert hív — minden a Tool Brokeren és a Model Gateway-en át, naplózva.

**Orchestrator (opcionális, felhasználó-néző, delegáló):**

- **Tool-less by design** — `tool_access_allowed = false`. Két dolgot tehet: (1) beszél a felhasználóval a Model Gateway-en (§4.7), (2) ticketet nyit worker-agenteknek (`allowed_outbound = ["ticket:create"]`). Mivel a beszélgetési felület a legnagyobb prompt-injection-felület (§0.7, §8.2), az eszköz-hozzáférés hiánya szándékos **blast-radius-csökkentés**: a chaten érkező támadás nem tud közvetlenül művelet té válni.
- **Csak delegál, nem mikromenedzsel** — egy többlépéses feladatot **Playbookra hivatkozva** indít („végezd el az X Playbook alapján" — §4.10.6); a lépések léptetése az állapotgépé, nem az orchestratoré.
- **Maga is verziózott, auditált, write-gate alatt** — nincs kivételezett, kapu nélküli státusza (§4.5.1). Tenantonként saját, verziózott viselkedés-profillal állítható elő (§8.8).

**Runtime-enforcement:** a Tool Broker `authorize(agent, tool)` **elsőként** a szerep-sablon `tool_access_allowed` mezőjét nézi; orchestrator esetén azonnal megtagad és auditál — még mielőtt a capability-táblát egyáltalán megnézné. Ez garantálja, hogy az orchestrator akkor sem szerez eszközt, ha valaki tévedésből capability-sort írna hozzá (defense-in-depth).

---

## 7. Önfejlesztési profil — enforcement és a kemény padló

A §4.6.4 „tárcsa, nem kapcsoló" elv leképezése. A `self_evolution_profile` (3.6) **csak a write-gate kapu-erősségét** állítja; a write-gate maga (§4.6.1) minden agentre fut.

**A kapu-erősség választása (a tanítási pipeline hívja, a memória-spec részletezi):**

| `approval_mode` | Mit jelent | Mi marad fix |
|---|---|---|
| `human` (NULL-default) | minden diffhez emberi jóváhagyás | verziózás + rollback + audit + write-token |
| `higher_role` | magasabb jogú szerep elég | ↑ ugyanaz |
| `eval_only` | csak eval-kapu (nincs ember), ha az eval zöld | ↑ ugyanaz + kötelező eval |
| `auto_after_eval` | eval után automatikus promóció | ↑ ugyanaz + kötelező eval |

**A kemény padló kétlépcsős kikényszerítése (N-AR-5):**

1. **Séma-validáció** (`setSelfEvolutionProfile`): a `scope` csak `{memory, behavior, role}` részhalmaza lehet. Bármely eszköz-/capability-/RBAC-/kulcs-kulcs a payloadban → `400` + `training.capability_escalation_denied` audit.
2. **Pipeline-ellenőrzés** (write-gate, a token kiállítása előtt): a jóváhagyott diff nem érinthet `capabilities` / `agent_api_keys.scopes` / RBAC sort, függetlenül a `scope`-tól. Ha mégis → a write-token **nem állítódik ki**, a tanítási ticket elutasítva + audit.

Így ugyanaz a mechanizmus szolgál ki egy szigorúan őrzött könyvelő agentet (`human`, `scope:["memory"]`) és egy szabadabban tanuló belső asszisztenst (`auto_after_eval`, `scope:["memory","behavior"]`) — **eltérő profillal, azonos write-gate-tel, azonos kemény padlóval.** A jogosultság-bővítés mindkettőnél kizárólag külön emberi admin-aktus.

---

## 8. Biztonsági invariánsok és audit

**Invariánsok (szerveroldalon kikényszerítve):**

| # | Invariáns | Hol |
|---|---|---|
| I1 | Csak `active` agent dispatchelhető | dispatcher (§5.7) |
| I2 | Minden aktiválás `agent_versions` snapshotot ír; a snapshot immutábilis | §4 állapotgép, 3.2 |
| I3 | Aktivált/nyugdíjazott agent fizikailag nem törölhető | §4, 3.1 |
| I4 | Orchestrator soha nem kap eszközhozzáférést (sablon-szintű megtagadás) | §6, Tool Broker |
| I5 | Önmódosítás nem bővíthet jogosultságot/eszközt/kulcsot (kemény padló) | §7, write-gate |
| I6 | `self_evolution_profile = NULL` ⇒ legszigorúbb (human) kapu, nem „szabad" | 3.1, 3.6 |
| I7 | Megosztott viselkedés-profil módosítása nem frissít csendben hivatkozó agentet | 3.4 kaszkád |
| I8 | Tenant-izoláció: az agent a határ; nincs cross-tenant agent-megosztás | 3.1, §8.8 |

**Audit-események (append-only, `verifyChain`-kompatibilis — §8.5):**

```
agent.created | agent.activated | agent.suspended | agent.resumed | agent.retired
agent.version_snapshot_created
agent.role_instruction_updated | agent.behavior_profile_updated
agent.behavior_profile_update_accepted        -- 3.4 kaszkád befogadás
agent.self_evolution_profile_change           -- [CR-MVP-002]
agent.api_key_rotated | agent.api_key_revoked
training.capability_escalation_denied         -- [CR-MVP-002] kemény padló megsértési kísérlet
agent.dispatch_denied_inactive                -- I1 megsértési kísérlet
tool.authorize_denied_orchestrator            -- I4 megsértési kísérlet
```

Minden esemény hordozza: `tenant_id`, `actor_type` (human|agent|system), `actor_id`, érintett `agent_id` + `agent_version`, időbélyeg, és a változás diff-referenciája (nem a nyers tartalom).

---

## 9. Tesztek (kötelező negatív tesztek)

| # | Teszt | Elvárt |
|---|---|---|
| N-AR-1 | `draft` agent dispatch-kísérlet; aktiválás snapshot nélkül | dispatch elutasítva (I1); aktiválás mindig ír snapshotot (I2) |
| N-AR-2 | orchestrator-agent eszközhívást kér (capability-sor is hozzáírva tévedésből) | Tool Broker megtagad sablon-szinten + `tool.authorize_denied_orchestrator` (I4) |
| N-AR-3 | megosztott `behavior_profile` új al-verzióra promótálása | hivatkozó agentek élő viselkedése **nem** változik, amíg `acceptBehaviorProfileUpdate` nem fut (I7) |
| N-AR-4 | `self_evolution_profile = NULL` melletti tanítási diff | a write-gate `human` kaput választ (I6); nincs automatikus promóció |
| N-AR-5 | `setSelfEvolutionProfile` `scope:["tool"]`-lal **és** tanítási diff, ami capability-t bővítene | séma-validáció `400` + pipeline-elutasítás + `training.capability_escalation_denied` (I5) |
| N-AR-6 | aktivált agent fizikai törlési kísérlet | elutasítva; csak `retire` engedett (I3) |
| N-AR-7 | cross-tenant `getAgent` / `findVersionSnapshot` | szerveroldali elutasítás + audit (I8) |
| N-AR-8 | múltbeli ticket reprodukálása nyugdíjazott agentről | `findVersionSnapshot` visszaadja a befagyasztott snapshotot (I2, I3) |

N-AR-1..3 a core invariánsok bizonyítéka. **N-AR-5 kötelező, ha a `self_evolution_profile` MVP-be kerül** — ez az önfejlesztés „kemény padló" invariánsának bizonyítéka (§4.6.4, CR-MVP-002 N6-tükör). N-AR-2 az orchestrator tool-less szabályának bizonyítéka (§4.5.1).

---

## 10. Fázisolás és nyitott kérdések

**MVP (kész / horog):** `agents` / `agent_versions` / `agent_api_keys` séma, `role` enum + tool-less szabály sémaszinten, `self_evolution_profile` jsonb (NULL=human), `role_instruction` / `behavior_profile` külön al-verziózás, `updateInstruction` + `agent.version` audit, reprodukálhatósági snapshot (`findVersionSnapshot`, recipe-kötés). A walking skeletonban egyetlen `worker` wiki-agent fut; a runtime már most sem feltételez beégetett mester-agentet.

**Fázis 2:** teljes életciklus-állapotgép kapukkal és eval-kapuval az aktiváláshoz; `behavior_profiles` mint önálló, megosztott entitás kaszkád-verziózással; tényleges orchestrator-agent Playbook-vezérelt delegálással; önfejlesztési-profil end-to-end enforcement a tanítási pipeline-nal; Control Plane UI (anatómia-kártya, instrukció-diff-szerkesztő, profil-katalógus).

**Nyitott kérdések (ügyfélinterjún / további döntésen validálandó):**

1. **Eval-kapu tartalma az aktiváláshoz** — milyen tesztkészlet/küszöb minősül „zöldnek"? (Tény: a kapu helye eldöntött; a *tartalom* a memória/eval-spec hatóköre.)
2. **Megosztott viselkedés-profil kaszkád-frissítés ergonómiája** — kötegelt „mind elfogadom" admin-művelet kell-e sok hivatkozó agentnél, vagy mindig egyenként? (Feltételezés: egyenkénti, audit-tisztaság miatt; validálandó.)
3. **Auto-suspend trigger-küszöbök** (költség, hibaarány) — agentenként vagy tenant-szinten konfigurált? (Kapcsolódik a Model Gateway guardrail-spec-hez.)
4. **`role_templates` bővíthetősége** — a `worker | orchestrator` enumon túl engedünk-e ügyfél-egyedi szerep-sablonokat Fázis 3-ban, vagy a kettő + capability-kompozíció elég?

---

*Ez a dokumentum a koncepció §4.5–§4.5.1 és §4.6.4 fejlesztői átvezetése. A tanítási/memória-író pipeline, a reflexiós feeder és a memória-retrieval külön (javasolt memória / self-evolution) spec hatóköre — lásd koncepció §0.10.*
