# Fázis 2 — Governance és biztonsági keménység: fejlesztői specifikáció

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 0.2 — fejlesztői spec (kiegészítve: emberi user-provisioning, 12.1 / 3.1 / 14 / 15 / 18 / 19 / 20)
**Dátum:** 2026-06-12
**Kapcsolódó:** `AI-Agent-Platform-Koncepcio.md`, `AI-Agent-Platform-MVP-Terv.md`, `AI-Agent-Platform-Fejlesztesi-Roadmap.md`, `AI-Agent-Platform-Fazis1-Spec.md`
**Olvasó:** a fejlesztő(k). Direkt, technikai. Feltételezi a roadmap és a Fázis 1 spec ismeretét.

---

## 1. Cél és scope

**Cél:** a Fázis 1 működő magját **enterprise-ready garanciaréteggé** tenni. A "kontrollált, auditálható autonómia" itt válik valódivá, nem látvánnyá (roadmap 4.). A Fázis 1-ben **vizuálisan jelölt** (badge, placeholder) governance- és biztonsági elemeket itt cseréljük **valódira**, úgy, hogy a UI nagyrészt marad — a szimulált logikát váltjuk ki szerveroldali kikényszerítéssel.

**Belépési feltétel (döntési kapu 1→2):** a Fázis 1 hat lépéses sztorija valódi adaton, stabilan megy; egy valódi agent megbízhatóan dolgozik (roadmap 8.).

### 1.1 In scope

| Terület | Mit teszünk valódivá | Roadmap / koncepció ref |
|---|---|---|
| Write-gate token | Memória-írás csak szerveroldali, aláírt, egyszer használatos, a jóváhagyott diffhez kötött tokennel | 4.1 / 4.6.1 |
| Secret-kezelés | Alias + futásidejű, szerveroldali injektálás; secret sosem a promptban | 4.1 / 4.9.2 |
| Capability-alapú eszközelérés | Agent csak az explicit engedélyezett eszközöket/connectorokat hívhatja; szerveroldali kikényszerítés | 4.1 / 8.2 |
| Guardrail a Gateway-en | PII-szűrés, tiltott tartalom, kimeneti validáció, gyanús minták flag-elése | 4.2 / 4.7, 8.2 |
| Tamper-evident audit log | Append-only, **hash-láncolt**, SIEM-exporttal; teljes naplóséma kitöltve | 4.2 / 8.5 |
| Observability valós adattal | Token/költség mérés agentenként-ticketenként, **eval-kapu**, drift-detektálás, per-agent budget cap | 4.2 / 8.6 |
| Eseményvezérelt dispatch | Nem-LLM orkesztrátor (work queue + worker); cron csak safety-net; időzített/ismétlődő ticketek | 4.1 / 4.11 |
| Playbook | Deklaratív folyamatleírás, **egy forrásból** generált kikényszerített állapotgép-konfig; szándékolt vs. tényleges nézet | 4.1 / 4.10 |
| RBAC + agent service account finomítás | Non-repudiation; finomszemcsés jogosultság a control plane-ben | 4.2 / 4.4 |
| **Emberi user-provisioning** | **Deny-by-default: regisztráció után nulla hozzáférés, amíg admin nem oszt szerepkört; admin által kiállított, lejáró meghívó** | 4.2 / 4.4 |
| Kill-switch + idempotencia | Agent/erőforrás azonnali revoke; ticket-lock a dupla végrehajtás ellen | 4.2 / 8.8 |

### 1.2 Out of scope (Fázis 3+)

Valódi connector éles külső rendszerhez, BOT-szállítás, ügyfélre szabott 2. app valódi adaton, több-lépéses Playbook valódi több-agentes folyamattal (roadmap 5.), on-prem / lokális modell / Keycloak / multi-tenancy (roadmap 6.). Ezek **architekturálisan előkészítettek** (absztrakciók, séma-hookok), de nem implementáltak.

> **Alapelv a scope-on:** Fázis 1 = "működik egy szelet". Fázis 2 = "ugyanaz a szelet **bizonyíthatóan biztonságos és auditálható**". Nem új use case-t építünk, hanem a meglévőt keményítjük ki úgy, hogy egy compliance-ember minden kérdésére legyen valódi, naplózott válasz (roadmap 4.3).

---

## 2. Architektúra — mi változik a Fázis 1-hez képest

A Fázis 1 rétegmodellje marad (UI → API → Domain → Repository → Postgres). A Fázis 2 **nem új rétegeket** húz be, hanem a meglévő rétegekbe épít be három kereszt-funkciót, és egy **új végrehajtási sávot** (dispatch).

```
┌─────────────────────────────────────────────────────────────┐
│  UI — badge/placeholder → valódi governance-állapot          │
├─────────────────────────────────────────────────────────────┤
│  API réteg — minden hívás: auth → guardrail → validáció →    │
│              capability-check → domain → audit(hash-lánc)     │
├─────────────────────────────────────────────────────────────┤
│  Domain szolgáltatások                                        │
│   + WriteGateService (token kiállítás/ellenőrzés)            │
│   + SecretService (alias-feloldás, futásidejű injektálás)    │
│   + CapabilityService (eszköz-engedély kikényszerítés)       │
│   + GuardrailService (a Gateway elé/mögé kötve)              │
│   + PlaybookService (deklaratív → állapotgép-konfig)         │
│   + ObservabilityService (eval, budget, drift)              │
│   + RevocationService (kill-switch, finomszemcsés revoke)   │
├─────────────────────────────────────────────────────────────┤
│  Dispatch-sáv (NEM-LLM): work queue + worker + cron-háló     │
├─────────────────────────────────────────────────────────────┤
│  Repository absztrakció (interfész)  →  Postgres (ORM)        │
└─────────────────────────────────────────────────────────────┘
```

**Két új architekturális szabály (a Fázis 1 két absztrakciója mellé):**

1. **A Gateway az egyetlen út a modellhez — most kötelezően guardraillel.** A Fázis 1-ben a Gateway már egyetlen belépési pont volt; itt elé/mögé kötjük a `GuardrailService`-t, hogy a szűrés **egy helyen, megkerülhetetlenül** történjen.
2. **A platform ír, nem a modell.** A write-gate, a secret-injektálás és a capability-check közös elve: a **modell legfeljebb javasol**, a privilegizált műveletet (memória-írás, secret-használat, eszközhívás) a control plane végzi, szerveroldali engedéllyel. Ez a termék fő ígérete.

### 2.1 Tech stack — kiegészítések

| Funkció | Javaslat | Indok | Alternatíva |
|---|---|---|---|
| Token-aláírás (write-gate) | **HMAC-SHA256** szerveroldali kulccsal, vagy Ed25519 | Egyszerű, gyors, nem hagyja el a szervert; a token rövid életű és egyszer használatos | KMS-alapú aláírás (Fázis 4 on-prem) |
| Secret-tárolás | **Dev:** env + szerveroldali rejtett mező; **pilot:** dedikált tábla titkosított értékkel (app-szintű AES-GCM) | A vault (HashiCorp/cloud KMS) a Fázis 4; most az alias-absztrakció a lényeg | Cloud Secret Manager |
| Work queue (dispatch) | **Postgres `LISTEN/NOTIFY` + `SELECT … FOR UPDATE SKIP LOCKED`** | Nincs új infra-függőség; egy DB; idempotens lock natívan | Redis/BullMQ, Pub/Sub (Fázis 3+ skálán) |
| Hash-lánc | **App-szintű SHA-256 láncolás** `prev_hash`-re, periodikus **anchor** | A séma már kész (Fázis 1); csak a kitöltés és verifikáció jön | DB-trigger alapú lánc |
| SIEM-export | **JSON-lines / CEF kimenet** fájlba vagy HTTP-collectorba | Szabványos, az ügyfél SIEM-je fogadja; pilotban fájl is elég | Syslog, OpenTelemetry |
| Guardrail / PII | **Determinisztikus szabály + regex/NER** belépő szinten, opcionális modell-alapú klasszifikátor | Olcsó, auditálható, gyors; a modell-alapú szűrés második kör | Külső moderation API |
| Eval | **Golden-set + assertion-futtató** (saját, könnyű) | A tanítás ne ronthasson regressziós teszten; nem kell nehéz eval-keretrendszer | Promptfoo / saját CI-job |

> **Döntés (validálandó):** a fenti a "ne hozz be új infrát, amíg a Postgres elég" elv mentén készült. Ha a pilot terhelése indokolja, a work queue és a secret-vault külön komponensre vihető — de a domain interfészek miatt ez nem újraírás.

---

## 3. Adatmodell — bővítések

A Fázis 1 sémája marad; az alábbiak **új táblák** vagy **meglévő mezők kitöltése/aktiválása**. Indikatív mezők, a migrációban finomítandók.

### 3.1 Új entitások

**`write_gate_tokens`** — memória-írás engedélyezése (4.6.1)
```
id (uuid, pk)
training_ticket_id (uuid, fk -> tickets)
agent_id (uuid, fk)
target_memory_id (uuid, fk -> memories)
expected_diff_hash (text)         -- a jóváhagyott diff hash-e, ehhez kötött
token_hash (text)                 -- a nyers token sosem tárolt; csak hash
signature (text)                  -- HMAC/Ed25519 aláírás
status (enum: issued | consumed | expired | revoked)
issued_at, expires_at, consumed_at (timestamptz)
```

**`secrets`** — secret valódi tárolás (alias → érték), a `resources` kiterjesztése (4.9.2)
```
id (uuid, pk)
resource_id (uuid, fk -> resources)   -- type = 'secret'
alias (text, unique)                  -- pl. "accounting_api"; ezt látja az agent
encrypted_value (bytea)               -- app-szintű titkosítás; sosem a promptba
version (int)
status (enum: active | rotated | revoked)
last_rotated_at (timestamptz)
```
> Az agent és a modell **csak az aliast** látja. A nyers értéket a `SecretService` oldja fel futásidőben, a tool-hívásba injektálva (5. szakasz).

**`capabilities`** + **`agent_capabilities`** — eszköz-/connector-engedély (8.2)
```
capabilities:        id (uuid, pk), name (text, unique),   -- pl. "tool.accounting.post", "connector.email.read"
                     description (text)
agent_capabilities:  agent_id (fk), capability_id (fk),
                     granted_by (fk -> users), granted_at (timestamptz),
                     status (enum: active | revoked)
                     -- pk(agent_id, capability_id)
```

**`playbooks`** + **`playbook_versions`** — deklaratív folyamat (4.10)
```
playbooks:         id (uuid, pk), name (text), status (enum: draft|active|retired),
                   current_version_id (fk)
playbook_versions: id (uuid, pk), playbook_id (fk), version (int),
                   definition (jsonb),         -- állapotok, átmenetek, szerep-kapuk, agent-szerepek
                   compiled_state_machine (jsonb),  -- a definícióból GENERÁLT, kikényszerített konfig
                   created_by (fk), created_at (timestamptz)
```
> **Egy forrás:** a `definition` az igazság; a `compiled_state_machine` belőle generált. A `TicketService` ezt a generált konfigot kényszeríti ki — kézzel nem írható felül.

**`work_queue`** — dispatch (4.11)
```
id (uuid, pk)
ticket_id (uuid, fk)
agent_id (uuid, fk)
state (enum: ready | claimed | running | done | failed | dead_letter)
lock_owner (text, nullable)       -- worker id; SELECT … FOR UPDATE SKIP LOCKED
attempts (int, default 0)
not_before (timestamptz)          -- execute_after leképezése
claimed_at, finished_at (timestamptz)
last_error (text, nullable)
```

**`guardrail_events`** — szűrés/gyanús minta (4.7, 8.2)
```
id (uuid, pk)
ticket_id (uuid, fk, nullable), agent_id (fk, nullable)
direction (enum: input | output)
rule (text)                       -- "pii.email", "prompt_injection.priv_escalation", "blocked.content"
severity (enum: info | warn | block)
action_taken (enum: allowed | redacted | blocked | flagged)
sample_ref (text, nullable)       -- redaktált minta hivatkozás
created_at (timestamptz)
```

**`evals`** + **`eval_runs`** — regressziós kapu (8.6)
```
evals:     id (uuid, pk), agent_id (fk), name (text),
           golden_set (jsonb),    -- input → elvárt assertion-ök
           status (enum: active | retired)
eval_runs: id (uuid, pk), eval_id (fk),
           trigger (enum: pre_training_approval | scheduled | manual),
           agent_version (int), memory_version_id (fk),
           passed (bool), score (numeric), details (jsonb),
           created_at (timestamptz)
```

**`agent_budgets`** — per-agent költségplafon (8.6, 4.11.4)
```
id (uuid, pk), agent_id (fk, unique),
window (enum: day | month), token_cap (bigint), cost_cap (numeric),
hard_stop (bool),                 -- true = plafonnál revoke; false = csak riaszt
current_usage (jsonb)             -- futó számláló (vagy nézet a model_calls-ból)
```

**`revocations`** — kill-switch napló (8.8, 4.9.4)
```
id (uuid, pk)
scope (enum: agent | capability | resource | all_agents)
target_id (uuid, nullable)
reason (text)
revoked_by (fk -> users)
created_at (timestamptz), restored_at (timestamptz, nullable)
```

**`user_invitations`** — admin által kiállított meghívó (12.1)
```
id (uuid, pk)
email (text)                          -- a meghívott címe
intended_role (enum: admin | approver | operator | viewer)  -- előre kiosztott szerep
invited_by (fk -> users)
token_hash (text)                     -- a nyers token sosem tárolt; csak hash (write-gate analógia, 4.)
status (enum: pending | accepted | expired | revoked)
expires_at (timestamptz)              -- rövid életű, egyszer használatos
accepted_user_id (uuid, fk -> users, nullable)
created_at, accepted_at (timestamptz)
```
> A meghívó **ugyanazt a token-filozófiát** követi, mint a write-gate (4.): hash-elve tárolt, lejáró, egyszer beváltható. A beváltás (`acceptInvitation`) köti a Clerk-identitást a már előre kiosztott szerephez.

### 3.2 Meglévő táblák kitöltése / bővítése

| Tábla | Fázis 1 állapot | Fázis 2 változás |
|---|---|---|
| `audit_log` | `prev_hash`/`hash` **üres** | **Kitöltjük**: minden új sor láncolva (8. szakasz); `policy_decision` valódi értéket kap |
| `tickets` | `execute_after`/`due_by` séma kész, opcionális | **Aktív**: a `Ready` predikátum és a dispatch használja; recurring sablon (4.11.6) |
| `memory_versions` | rollback működik, write-gate nélkül | A `status: active`-ra állítás **csak érvényes write-gate tokennel** (4. szakasz) |
| `agents` / `agent_versions` | verziózott | `status: retired` + revoke a kill-switchhez kötve |
| `model_calls` | token/költség rögzítve | Az `ObservabilityService` aggregálja; budget-ellenőrzés köti |
| `users` | `role` enum kitöltve, de regisztrációkor nincs kapu | **Bővül:** `status (enum: pending \| active \| suspended)`, default `pending`; `role` **nullable** és default `NULL` (nincs előjog). Aktívvá csak admin szerepkör-kiosztással válik (12.1) |

---

## 4. Write-gate token (memória-írás zárolása)

A "az AI nálunk nem driftel el, és a tanulás nem hamisítható" garancia szerveroldali megvalósítása (4.6.1). A Fázis 1 tanítás-folyamata (verziózás, diff, rollback) marad; **csak a tényleges írás kapuját** keményítjük ki.

### 4.1 Folyamat

1. **Tanítási ticket jóváhagyásra kerül** (`awaiting_human → approved`). Ekkor a platform kiszámolja a jóváhagyott diff hash-ét (`expected_diff_hash`).
2. A platform **maga generál** egy egyszer használatos, aláírt tokent (`write_gate_tokens`), amely **az adott tickethez ÉS az adott memória-verzióhoz ÉS a jóváhagyott diff hash-éhez van kötve**. A token rövid életű (`expires_at`).
3. A **token a szerveren marad** — az agent **nem birtokolja, nem adja tovább**. A modell sosem látja.
4. `approveTraining` → a `WriteGateService.consume(token)` ellenőrzi: érvényes aláírás, nem lejárt, `status = issued`, a tényleges diff hash == `expected_diff_hash`. Ha minden stimmel: új `memory_versions` rekord `active`-ra, a régi lezárul, a token `consumed`-re.
5. Token nélkül / hibás / lejárt / már felhasznált tokennel: **nincs írás**, `guardrail_events` + audit `memory.write.denied`.

### 4.2 Garancia

Egy külső prompt ("tanulj meg ezt…") **nem** vezethet memória-íráshoz, mert: (a) a modell nem birtokol tokent, (b) a token a konkrét jóváhagyott diffhez kötött, (c) egyszer használatos (nem visszajátszható). Audit: `memory.write` a token-id-vel, a jóváhagyóval, az agent- és memória-verzióval.

---

## 5. Secret-kezelés (futásidejű injektálás)

A secret **technikailag sosem kerül a modell kontextusába** (4.9.2). A Fázis 1 alias-látványát itt valódi mechanizmussá tesszük.

### 5.1 Mechanizmus

- Az agenthez kötött secret a `secrets` táblában él, **titkosított értékkel**; az agent és a modell **csak az aliast** (`accounting_api`) látja az erőforrás-anatómiában (C5).
- Tool-/connector-híváskor a `SecretService.resolve(alias, agentId)` ellenőrzi a capability-t (6. szakasz), feloldja az értéket, és **a tool-hívás határán, szerveroldalon injektálja** — a prompt-összeállító kód az aliasszal dolgozik, a nyers érték oda nem jut vissza.
- **Rotáció:** `rotateSecret(alias)` új `version`, a régi `rotated`. A megosztott secret új verziójára minden kötött agent azonnal vált (4.9.3). **Revoke:** azonnal elveszi a hozzáférést (finomszemcsés kill-switch, 4.9.4).

### 5.2 Garancia

Prompt injectionnel a kulcs **nem csalható ki**, mert a modell nem látja. A secret-feloldás minden esetben audit-esemény (`secret.resolve`, alias + agent, az **érték nélkül**).

---

## 6. Capability-alapú eszközelérés

Az agent **csak az explicit engedélyezett** eszközöket/connectorokat hívhatja, szerveroldali kikényszerítéssel (8.2). A jogosultság **soha nem a promptban** él.

- Minden tool-/connector-hívás a `CapabilityService.enforce(agentId, capability)` kapun megy. Nincs aktív `agent_capabilities` rekord → **a hívás elutasítva**, `guardrail_events` + audit `capability.denied`.
- A capability-k a control plane-ben élnek (nem a külső auth-providerben — 4.4.1), `granted_by`/`granted_at`-tel, auditálhatóan.
- **Gyanús minta:** ha a modell kimenete jogosultság-emelési kísérletre utal (olyan eszközt akar hívni, amire nincs joga), az nemcsak elutasítás, hanem **flag** az auditba (`prompt_injection.priv_escalation`).

> Fázis 2-ben a capability-k a meglévő (szimulált) eszközökre és a Fázis 3-ban érkező első connectorra előkészítve működnek. A valódi connector maga a Fázis 3, de a capability-kapu **most** megkerülhetetlen.

---

## 7. Guardrail a Gateway-en

A Model Gateway a Fázis 1 óta az egyetlen út a modellhez; ide kötjük be **egy helyen** a szűrést (4.7, 8.2).

### 7.1 Input-oldal (a modellhívás előtt)

- **PII-szűrés/redaktálás:** determinisztikus szabály + regex/NER a dokumentum-szövegen és a prompton; a PII redaktálva vagy maszkolva megy a modellnek (a szabály-szett konfigurálható).
- **Prompt injection minták:** ismert minták ("ignore previous instructions", jogosultság-emelés, secret-kicsalás) felismerése; `severity: warn|block`.

### 7.2 Output-oldal (a modellválasz után)

- **Kimeneti validáció:** a strukturált javaslat Zod-séma + tartalmi szabályok (pl. nincs benne nyers secret-szerű minta).
- **Tiltott tartalom / művelet:** ha a kimenet tiltott műveletet vagy capability-n kívüli eszközhívást javasol → block + flag.

### 7.3 Naplózás

Minden guardrail-döntés `guardrail_events` rekord **és** `audit_log` (`policy_decision` kitöltve). A blokkolt hívás nem fut le; a ticket `rejected`/`awaiting_human` marad, indoklással. A guardrail a Gateway egyetlen belépési pontján ül — megkerülhetetlen.

---

## 8. Tamper-evident audit log (hash-lánc + SIEM)

A Fázis 1 append-only logját **tamper-evidentté** tesszük (8.5). A séma már kész (`prev_hash`, `hash`); itt a kitöltés, a verifikáció és az export jön.

### 8.1 Hash-láncolás

- Új audit-sor írásakor: `hash = SHA256(seq || prev_hash || canonical(payload))`, ahol `prev_hash` az előző sor `hash`-e. Az első sor `prev_hash`-e fix genezis-érték.
- A lánc **append-only**; bármely sor utólagos módosítása megtöri a láncot a verifikációnál.
- **Periodikus anchor:** a lánc aktuális fej-hash-ét rögzített időközönként külön rögzítjük (külső naplóba / aláírt rekordba), hogy a "régi szakasz újraírása" is kiderüljön.

### 8.2 Verifikáció + export

- `verifyAuditChain(range)` újraszámolja a láncot és jelzi az első törést. Admin-felületről és CI-ből is futtatható.
- **SIEM-export:** JSON-lines/CEF kimenet (fájlba vagy HTTP-collectorba) a teljes naplósémával (ki/mi/agent-verzió, mit, mikor, modell, input/output-ref, policy-döntés). Pilotban fájl is elég; az interfész szabványos.

### 8.3 Naplóséma teljessége

A Fázis 1 audit-sémája bővül a valós `policy_decision`-nel és a guardrail-referenciával; minden privilegizált művelet (write-gate, secret-resolve, capability-check, dispatch, revoke) **kötelezően** naplózott.

---

## 9. Observability + eval-kapu

"Mennyibe kerül, és működik-e jól?" — beépített modul (8.6).

### 9.1 Token/költség

- `ObservabilityService` a `model_calls`-ból aggregál: token/költség **agentenként és ticketenként**, idősoros nézet (C1 dashboard valós adattal).
- **Per-agent budget cap** (`agent_budgets`): a dispatch a végrehajtás előtt ellenőrzi a plafont; `hard_stop = true` → plafonnál a `RevocationService` leállítja az agentet (8.8), különben riaszt.

### 9.2 Eval-kapu (regresszió-védelem)

- **A tanítás ne ronthasson regressziós teszten.** A tanítási ticket jóváhagyása előtt `eval_run` fut a `golden_set`-en az **új** memória-verzióval (`trigger: pre_training_approval`). Ha `passed = false`, a jóváhagyás **figyelmeztet/blokkol** (konfigurálható: kötelező zöld vagy felülbírálható, de naplózott).
- Ez köti össze a Fázis 1 tanítás-folyamatát a write-gate-tel: javaslat → eval → jóváhagyás → write-gate token → írás.

### 9.3 Drift + guardrail dashboard

- **Drift-detektálás:** kimeneti minőség/eloszlás időbeli elmozdulásának egyszerű jelzése (pl. eval-score trend, guardrail-sértés-arány).
- **Guardrail-sértések dashboardja** (`guardrail_events` aggregálva): mi blokkolódott, milyen gyakran, melyik agentnél.
- **SLA-k:** agent válaszidő, jóváhagyási átfutás — alap metrikák.

---

## 10. Eseményvezérelt dispatch (token-takarékos végrehajtás)

A Fázis 1 "klikkre indul" végrehajtását **eseményvezérelt, nem-LLM orkesztrátorra** cseréljük (4.11). Vezérelv: **olcsó (nem-LLM) figyelő dönt, drága (LLM) agent csak valódi munkára indul.**

### 10.1 Komponensek

- **Dispatcher (determinisztikus kód, NEM agent):** a `work_queue`-ból `SELECT … FOR UPDATE SKIP LOCKED`-kel kivesz egy `ready` elemet, meghívja az agent-runtime-ot, frissíti a ticketet, majd a worker **leáll** (üresben sosem fut).
- **Elsődleges trigger (push):** ticket-állapotváltás → `work_queue` bejegyzés Postgres `LISTEN/NOTIFY`-jal. Heartbeat gyakorlatilag nem kell.
- **Másodlagos trigger (cron-háló):** alacsony frekvenciás **egy SQL-lekérdezés** (nem LLM!) az elveszett események elkapására — gyakorlatilag ingyen.

### 10.2 `Ready` predikátum (teljes, Fázis 2)

```
végrehajtható = (state = 'approved')
              AND (execute_after IS NULL OR now() >= execute_after)
              AND minden függőség teljesült
              AND nincs aktív revoke az agentre/erőforrásra
              AND budget-plafon nincs túllépve (hard_stop esetén)
```
A Fázis 1 egyszerűsített predikátuma (csak `approved` + `execute_after`) így teljesedik ki.

### 10.3 Költségkontroll + idempotencia

Agentenkénti **rate-limit**, **max párhuzamos futás**, **debounce/batch**, prioritásos sor, per-agent **budget cap** (9.1). **Ticket-lock / idempotencia** (`work_queue.lock_owner` + `SKIP LOCKED`): két dispatcher nem indíthatja kétszer ugyanazt (8.8). Hibás futás → `attempts++`, végül `dead_letter`.

### 10.4 Időzített és ismétlődő végrehajtás

Az `execute_after`/`due_by` (Fázis 1-ben séma-szinten kész) itt aktív: az időpont **az egyik feltétel** a `Ready`-ben (4.11.6). Recurring sablon: lezáráskor a rendszer legenerálja a következő példányt (`not_before` a sablon szerint).

---

## 11. Playbook (deklaratív folyamat + két nézet)

A ticket marad a folyamat-szubsztrát; a Playbook **nem külön workflow-motor**, hanem deklaratív leírás, amely **egy forrásból** generálja a kikényszerített állapotgép-konfigurációt (4.10).

### 11.1 Mechanizmus

- A `playbook_versions.definition` (jsonb) leírja: állapotok, engedélyezett átmenetek, szerep-kapuk (ki válthat), agent-szerepek, kötelező emberi jóváhagyási pontok.
- Ebből generáljuk a `compiled_state_machine`-t, amelyet a `TicketService` **kikényszerít** — a Fázis 1 kézi átmenet-táblája helyett a Playbookból fordított konfig az igazság.
- **Magas hatókörű változás = jóváhagyás:** egy aktív Playbook módosítása több agent/folyamat viselkedését érinti → jóváhagyási láncon megy (mint a tanítás), és auditesemény (4.9.3 analógia).

### 11.2 Folyamat-vizualizáció — két nézet (4.10.3)

- **Szándékolt:** a Playbook-definícióból rajzolt folyamatábra (mi a tervezett út).
- **Tényleges:** az `audit_log`-ból rekonstruált valós út (mi történt ténylegesen). A kettő egymásra vetítve mutatja az eltéréseket — ez governance-érték (hol tér el a valóság a tervtől).

> Fázis 2-ben egy **egy-agentes** Playbook (a könyvelő-folyamat) elég a mechanizmus bizonyítására. A valódi több-agentes, több-lépéses Playbook a Fázis 3 (5.1).

---

## 12. RBAC finomítás + non-repudiation

A Fázis 1 RBAC-ja (admin/approver/operator/viewer) marad; itt finomítjuk (4.4).

- **Non-repudiation:** minden agent-művelet visszavezethető konkrét agentre **és annak konkrét verziójára** (a hash-láncolt auditon keresztül bizonyíthatóan).
- **Finomszemcsés jogosultság a control plane-ben:** capability-k (6.), erőforrás-hozzáférés (`agent_resources`), jóváhagyási láncok — nem a külső auth-providerben, hanem nálunk, auditálhatóan.
- **Agent-authz továbbra sem Clerkben** (4.4.1): a service-account-kulcsok scope-ja + a capability-k döntenek.
- **Human override mindenhol, naplózva** (8.8): bármely automatizált lépés emberi felülbírálhatósága audit-esemény.

### 12.1 Emberi user-provisioning (admin meghívás + jogosultság-kapu)

A Fázis 1-ben a `users.role` csak egy mező volt; itt valódi **zárt rendszerré** tesszük a belépést. Vezérelv: **deny-by-default** — ugyanaz a logika emberi oldalon, mint a capability-kapu az ageneknél (6.). Senki nem fér hozzá semmihez, amíg az admin nem dönt.

**Alapelv:** az **autentikáció** (ki ő) a Clerk dolga az `AuthProvider` absztrakció mögött (4.4.1); az **autorizáció** (mit szabad neki) a mi control plane-ünké, auditálhatóan. Ezért a Keycloak-csere (Fázis 4) ezt a réteget nem érinti.

**A `users.status` állapotgép:**

```
(nincs)  --regisztráció v. meghívó-beváltás-->  pending
pending  --admin szerepkört oszt (assignRole)-->  active
active   --admin felfüggeszt (suspendUser)----->  suspended
suspended --admin visszaállít (reactivateUser)-->  active
```

**Két belépési út, mindkettő `pending`-be vezet:**

1. **Admin-meghívás (elsődleges, javasolt):** `inviteUser({ email, intendedRole })` → `user_invitations` rekord, lejáró, egyszer beváltható tokennel (e-mailben kiküldve). A meghívott a Clerk-en hitelesít, majd `acceptInvitation(token)` → létrejön a `users` rekord, és **a meghívóban előre kiosztott szerep alapján rögtön `active`** lesz. Ez a gyors út: az admin egy lépésben hív és jogosít.

2. **Önregisztráció (másodlagos):** ha valaki magától regisztrál (Clerk sign-up), `users` rekord jön létre `status = pending`, `role = NULL`. **Nulla hozzáférés**: minden `requireRole()`-kapu elutasít, az UI csak egy "Várakozás admin-jóváhagyásra" képernyőt mutat. Az admin a `assignRole(userId, role)`-lal teszi `active`-vá. Opcionális **domain-allowlist** (pl. csak `@ügyfél.hu` regisztrálhat); allowlisten kívüli e-mail eleve elutasítva.

**Kikényszerítés (megkerülhetetlenség, 16.):** a Fázis 1 `requireRole(role)` mellé belép a `requireActiveUser()` ellenőrzés a server action-ök auth-lépésében (`auth → guardrail → …`). A predikátum:

```
hozzáfér = (users.status = 'active') AND (users.role IS NOT NULL) AND requireRole(elvárt_szerep)
```

`pending`/`suspended`/`NULL role` → **minden privilegizált action elutasítva**, `access.denied` audit-eseménnyel. A szerep **szerveroldalon** dől el minden kérésnél (a kliensoldali/cache-elt szerepben sosem bízunk); szerep- vagy státuszváltáskor a meglévő session jogai a következő kérésnél azonnal újraértékelődnek.

**Védőkorlátok:**

- **Utolsó-admin védelem:** az utolsó `active` admin nem fokozható le és nem függeszthető fel (lock-out elleni biztosíték).
- **Offboarding = emberi kill-switch:** `suspendUser(userId, reason)` azonnal megvonja a hozzáférést (a `suspended` státusz a `requireActiveUser`-en bukik), de a user-rekord és az auditnyom megmarad (non-repudiation). Ez a 13. agent-revoke emberi párja.
- **Önmódosítás tiltása:** admin a saját szerepét/státuszát nem írhatja át (négy-szem-elv minimuma).

**Audit (non-repudiation, 8.):** minden user-esemény hash-láncolt audit-bejegyzés — `user.invited`, `invitation.accepted`, `role.assigned` (ki, kinek, milyen szerepet, mikor), `user.suspended`, `user.reactivated`. Így a "ki adott kinek jogot, mikor" compliance-kérdés bizonyíthatóan megválaszolható (19.).

**Out of scope (Fázis 3+):** a szerepkörnél finomabb, **erőforrás-szintű** emberi hozzáférés (pl. egy user csak bizonyos agenteket/Playbookokat lát) — ezt a meglévő `agent_resources`/capability-modell emberi oldalra kiterjesztve lehet később megadni; most a 4 szerep + deny-by-default elég.

---

## 13. Kill-switch + idempotencia

Az incidens-válasz keménysége (8.8, 4.9.4).

- **Durva kill-switch:** `revokeAll()` → minden agent azonnali leállítása (a dispatch nem indít új futást; futó worker a következő ellenőrzési ponton áll le). `revocations` rekord `scope: all_agents`.
- **Finomszemcsés revoke:** `revoke(scope, targetId)` — egy agent, egy capability vagy egy erőforrás (pl. egy secret) azonnali visszavonása. Nem az egész agentet állítja le, csak egy konkrét képességét (4.9.4).
- **Idempotencia/konkurrencia:** ticket-lock (`work_queue` + `SKIP LOCKED`) és optimista konkurenciakezelés a ticket-állapotváltáson — két agent nem mozdulhat ugyanarra a ticketre (8.8).
- A revoke **azonnal hat** (a `Ready` predikátum ellenőrzi), és minden revoke/restore audit-esemény.

---

## 14. API / server actions — bővítések

A Fázis 1 mintája marad (**auth → guardrail → Zod-validáció → capability-check → domain → audit**). Új/bővített action-ök:

| Action | Input | Output | Jog |
|---|---|---|---|
| `issueWriteGateToken` *(belső)* | `{ trainingTicketId }` | `{ tokenId }` | system |
| `approveTraining` *(bővítve)* | `{ ticketId }` | `{ memoryVersion }` | approver+ — **eval-kapu + write-gate** |
| `resolveSecret` *(belső, tool-határon)* | `{ alias, agentId }` | injektált érték *(nem logolt)* | capability-függő |
| `rotateSecret` | `{ alias }` | `{ version }` | admin |
| `grantCapability` / `revokeCapability` | `{ agentId, capability }` | `{ status }` | admin |
| `inviteUser` | `{ email, intendedRole }` | `{ invitationId }` | admin |
| `acceptInvitation` | `{ token }` | `{ userId, status }` | meghívott (Clerk-hitelesített) |
| `assignRole` *(pending → active)* | `{ userId, role }` | `{ status }` | admin |
| `suspendUser` / `reactivateUser` | `{ userId, reason? }` | `{ status }` | admin |
| `listUsers` | `{ statusFilter? }` | `{ users[] }` | admin |
| `createPlaybook` / `publishPlaybookVersion` | `{ definition }` | `{ version }` | admin (jóváhagyással) |
| `getPlaybookViews` | `{ playbookId }` | `{ intended, actual }` | viewer+ |
| `runEval` | `{ evalId, memoryVersionId }` | `{ passed, score }` | approver+ / system |
| `setAgentBudget` | `{ agentId, caps }` | `{ budget }` | admin |
| `revoke` / `revokeAll` / `restore` | `{ scope, targetId?, reason }` | `{ revocationId }` | admin |
| `verifyAuditChain` | `{ range? }` | `{ ok, firstBreakSeq? }` | approver+ |
| `exportAuditSiem` | `{ range, format }` | `{ exportRef }` | admin |
| `getObservabilitySummary` *(bővítve)* | `{ range?, agentId? }` | `{ tokens, cost, drift, slaViolations, guardrailEvents }` | viewer+ |

A dispatch nem klasszikus user-action: a `work_queue` + worker eseményvezérelt (10.). A `transitionTicket` a generált Playbook-állapotgépet kényszeríti ki (11.).

---

## 15. UI — badge/placeholder → valódi governance-állapot

A Fázis 0/1 képernyői maradnak; a "Fázis 2" badge-ek mögé valódi adat kerül.

| Képernyő | Fázis 1 állapot | Fázis 2 |
|---|---|---|
| C5 Agent anatómia | secret = alias-látvány | valódi alias + rotáció/revoke gomb; capability-lista valós |
| C7 Tanítás + rollback | diff + rollback | + **eval-eredmény** a jóváhagyás előtt; write-gate jelzés (token kiállítva/felhasználva) |
| C8 Audit log | hash-lánc badge "Fázis 2" | valódi hash-lánc + **verify** gomb + SIEM-export; `policy_decision` oszlop |
| C1 Dashboard | élő számok | + budget-állapot, guardrail-sértés-szám, drift-jelzés, SLA |
| (új) Playbook nézet | — | szándékolt vs. tényleges folyamatábra |
| (új) Governance / incidens | — | revoke / kill-switch panel (admin), revoke-napló |
| (új) User-kezelés (admin) | — | user-lista státusszal, **Meghívás** gomb, szerepkör-kiosztás `pending` usernek, felfüggesztés/visszaállítás |
| (új) Várakozó-képernyő | — | `pending` usernek: "Hozzáférésed admin-jóváhagyásra vár" — semmilyen adat nem látszik |
| S1/S2 Sandbox | feltöltés + javaslat | + guardrail-jelzés (mi redaktálódott/blokkolódott) |

---

## 16. Nem-funkcionális követelmények (Fázis 2 szint)

- **Megkerülhetetlenség:** a guardrail, a capability-check és a write-gate **nem opcionális** — nincs olyan kódút a modellhez vagy a privilegizált műveletekhez, amely megkerüli őket. Ez teszt-kritérium is (17.).
- **Teljesítmény:** a hash-láncolás és a guardrail ne növelje érdemben a ticket-átfutást; a dispatch `SKIP LOCKED` legyen lock-mentes a párhuzamos workereknél.
- **Idempotencia (teljes):** ticket-lock + optimista konkurencia minden állapotváltáson és dispatchen (Fázis 1 csak `processDocument`-szintű volt).
- **Titoktartás:** secret nyers értéke **soha** nem kerül logba, auditba, promptba vagy hibákba.
- **Helyreállíthatóság:** az audit és a memória elvesztése kritikus → backup-eljárás (a teljes DR a Fázis 4, de a backup itt kötelező).
- **Időzóna:** tárolás UTC, megjelenítés lokál (Fázis 1 öröklött).

---

## 17. Projektstruktúra — bővítés (Fázis 1-re építve)

```
src/
  domain/
    writegate/      # WriteGateService (token kiállítás/consume)
    secret/         # SecretService (alias-feloldás, rotáció, injektálás)
    capability/     # CapabilityService (enforce)
    guardrail/      # GuardrailService (input/output szűrés)
    playbook/       # PlaybookService (definition → compiled state machine, két nézet)
    observability/  # ObservabilityService (aggregálás, eval, budget, drift)
    revocation/     # RevocationService (kill-switch, revoke/restore)
    user/           # UserProvisioningService (invite, accept, assignRole, suspend) + requireActiveUser
    dispatch/       # Dispatcher + worker (NEM-LLM), Ready-predikátum
    audit/          # (bővítve) hash-lánc + SIEM-export + verify
  lib/crypto/       # HMAC/Ed25519 aláírás, SHA-256 lánc, app-szintű titkosítás
  prisma/           # migrations: új táblák + audit-lánc aktiválás
```

---

## 18. Munkacsomagok és becslés

A két sáv (feature + hardening) **párhuzamosan** halad (roadmap 7.) — a hardening nem "majd később".

| # | Munkacsomag | Sáv | Tartalom | Becslés |
|---|---|---|---|---|
| WP1 | Audit-lánc + SIEM | hardening | Hash-láncolás aktiválása, `verifyAuditChain`, anchor, export, C8 | 1 hét | ✅ KÉSZ (2026-06-12) |
| WP2 | Write-gate + eval-kapu | feature+hard. | `write_gate_tokens`, token-kiállítás/consume, eval golden-set, `approveTraining` bővítés, C7 | 1–1,5 hét | ✅ KÉSZ (2026-06-12) |
| WP3 | Secret + capability | hardening | `secrets` (titkosítva), `SecretService` injektálás, `capabilities`, `CapabilityService.enforce`, C5 | 1 hét |
| WP4 | Guardrail a Gateway-en | hardening | Input/output szűrés, `guardrail_events`, gyanús-minta flag, Sandbox-jelzés | 1 hét |
| WP5 | Dispatch + idempotencia | feature | `work_queue`, `LISTEN/NOTIFY`, `SKIP LOCKED` worker, cron-háló, teljes `Ready`, időzített/recurring | 1–1,5 hét |
| WP6 | Playbook | feature | `playbooks`, definition → compiled state machine, két nézet, jóváhagyási lánc | 1 hét |
| WP7 | Observability + budget + kill-switch | hardening | Aggregálás, drift, budget cap, `revoke`/`revokeAll`/`restore`, governance-panel, C1 bővítés | 1 hét |
| WP8 | Integráció + acceptance | mindkettő | End-to-end összekötés, megkerülhetetlenség-tesztek, acceptance-forgatókönyvek | 0,5–1 hét |
| WP9 | Emberi user-provisioning | hardening | `users.status`/nullable role migráció, `user_invitations`, `requireActiveUser`, `inviteUser`/`acceptInvitation`/`assignRole`/`suspendUser`, admin user-kezelő UI + várakozó-képernyő, audit-események, utolsó-admin védelem | 0,5–1 hét |

**Összesen: ~6–8 hét**, 1–2 fejlesztő (a user-provisioning WP9 a korábbi ~5–7 hetes becslést kb. fél–egy héttel bővíti; e-mail-kiküldés meglévő szolgáltatással triviális, saját SMTP-vel +fél nap).

---

## 19. Kilépési kritérium (acceptance)

A Fázis 2 akkor kész, ha egy ügyfél **biztonsági/compliance embere** végig tudja kérdezni a rendszert, és **mindenre van valódi, naplózott, bizonyítható válasz** (roadmap 4.3). Konkrét, lefuttatandó forgatókönyvek:

1. **"Ki tanította az agentet, mivel, ki hagyta jóvá?"** — a tanítási ticket, a diff, a jóváhagyó, az agent- és memória-verzió visszakereshető; a memória-írás **csak érvényes write-gate tokennel** történt (token nélkül kísérlet → elutasítva + naplózva).
2. **"Vissza lehet-e vonni a tanítást?"** — rollback működik, és a write-gate nem akadályozza a kontrollált visszagörgetést; minden lépés auditban.
3. **"Ki látta a kulcsot?"** — bizonyíthatóan **senki/semmi a modell oldalán**: a secret aliasként jelenik meg, a nyers érték sehol (log/audit/prompt) nem szerepel; a feloldás audit-esemény az érték nélkül.
4. **"Mi történik prompt injectionnél?"** — a Gateway guardrailje blokkol/flag-el; a jogosultság-emelési kísérlet elutasítva a capability-kapun, és megjelenik a `guardrail_events`-ben.
5. **"Hamisítható-e a napló?"** — `verifyAuditChain` zöld; egy szándékosan módosított sor megtöri a láncot, és a verifikáció jelzi az első törést; SIEM-export előáll.
6. **"Mi történik incidensnél?"** — `revoke`/`revokeAll` azonnal leállítja az érintett agentet/capability-t/erőforrást; a `Ready` predikátum nem enged új futást; minden revoke/restore naplózott.
7. **"Nem szalad-e el a költség?"** — per-agent budget cap érvényesül; `hard_stop`-nál a plafon leállít; az observability valós token/költséget mutat agentenként-ticketenként.
8. **"Nem ronthat-e a tanítás?"** — a tanítás jóváhagyása előtt eval fut; bukott evalnál a jóváhagyás figyelmeztet/blokkol (konfiguráció szerint), és ez naplózott.
9. **"Megkerülhető-e bármelyik kapu?"** — teszt bizonyítja, hogy nincs kódút a modellhez guardrail nélkül, privilegizált művelethez capability/write-gate nélkül.
10. **Szándékolt vs. tényleges:** a Playbook két nézete egy valós lefutásnál összevethető; az eltérés látszik.
11. **"Ki fér hozzá az apphoz, és ki adott neki jogot?"** — frissen regisztrált user `pending` státuszban **semmihez nem fér** (minden privilegizált action elutasítva + naplózva); admin-meghívás vagy `assignRole` után válik `active`-vá; a `role.assigned`/`invitation.accepted` események az auditban visszakereshetők. Felfüggesztett (`suspended`) user azonnal elveszti a hozzáférést; az utolsó admin nem zárható ki.

---

## 20. Nyitott döntések (a fejlesztés előtt tisztázandó)

- **Eval-kapu szigorúsága:** kötelező zöld eval a tanítás-jóváhagyáshoz, vagy felülbírálható (de naplózott)? Javaslat: pilotban felülbírálható + kötelező indoklás; szabályozott ügyfélnél kötelező zöld.
- **Guardrail mélysége Fázis 2-ben:** csak determinisztikus (regex/NER) szűrés, vagy már modell-alapú klasszifikátor is? Javaslat: determinisztikus belépő szint most, modell-alapú második kör.
- **Secret-tárolás pilotban:** app-szintű titkosítás a Postgresben elég, vagy már most dedikált vault? Javaslat: app-szintű titkosítás + alias-absztrakció; valódi vault a Fázis 4 on-prem.
- **Work queue infra:** marad Postgres `LISTEN/NOTIFY` + `SKIP LOCKED`, vagy a pilot terhelése indokol külön queue-t (Redis/Pub/Sub)? Javaslat: Postgres, amíg a terhelés engedi.
- **Anchor-célpont:** a hash-lánc fej-hash-ének periodikus rögzítése hova menjen (külön DB, fájl, külső aláírt szolgáltatás)? Pilotban fájl/külön tábla; szabályozott ügyfélnél külső.
- **Playbook hatóköre Fázis 2-ben:** egy-agentes Playbook a könyvelő-folyamatra elég a mechanizmus bizonyítására (a több-agentes a Fázis 3) — megerősítendő.
- **Önregisztráció engedélyezett-e?** Javaslat: pilotban **csak admin-meghívás** (zártabb, egyszerűbb), az önregisztrációs `pending`-út opcionális. Szabályozott ügyfélnél domain-allowlist + admin-meghívás kötelező.
- **Default szerep meghíváskor:** kötelező-e `intendedRole` megadása, vagy lehet meghívni szerep nélkül (a beváltott user `pending` marad)? Javaslat: meghíváskor kötelező a szerep — egy lépés, gyorsabb onboarding.
- **Meghívó e-mail kézbesítése:** meglévő tranzakciós e-mail-szolgáltatás (pl. a Clerk beépített flow-ja vagy egy provider), vagy saját SMTP? Javaslat: a meglévő auth-stack e-mailje, ha van; különben provider.
- **Erőforrás-szintű emberi hozzáférés:** marad-e a 4 szerep Fázis 2-ben, vagy kell már most user↔agent/Playbook láthatóság? Javaslat: 4 szerep most; a finomabb láthatóság Fázis 3, ha ügyféligény.

---

*Ez a spec a Fázis 2-t fedi (governance + biztonsági keménység). A Fázis 3 (integráció + valódi use case élesben, BOT-modell) külön specet kap, ha a Fázis 2 kilépési kritériuma teljesült — azaz egy compliance-ember minden governance-kérdésére van valódi, bizonyítható válasz.*
