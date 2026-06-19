# Kontrollált Enterprise AI Agent Platform — MVP fejlesztési terv (walking skeleton)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0 — architektúra-teljes MVP (walking skeleton)
**Dátum:** 2026-06-15
**Kapcsolódó anyag:** `AI-Agent-Platform-Koncepcio.md` (v0.7)
**Státusz:** Fejlesztési specifikáció alapja — kivitelezésre
**Felváltja:** `AI-Agent-Platform-MVP-Terv.md` (v0.1, kattintható mockup terv — elavult, mert a koncepció v0.1-re épült, és a számla-agentet vette első use case-nek)
**Frissítés (2026-06-15):** modellstratégia **eldöntve** — az MVP **kizárólag ChatGPT OAuth-bekötést** használ (előfizetés, „Sign in with ChatGPT" / Codex-provider), **más modellforrás nincs** (sem külön OpenAI API, sem Gemini API). A korábbi D2 nyitott döntés ezzel lezárva (lásd 3.4 és 10.).
**Frissítés (2026-06-19):** a fejlesztés során néhány Fázis 2 / MVP-feletti cserepont már bekerült a kódbázisba. Ezek **nem bővítik az MVP elfogadási scope-ját**: opcionális, kikapcsolható vagy külön feature-spechez tartozó képességek, amelyeket a 1.5 szakasz külön elhatárol.

---

## 0. Mit dönt el ez a dokumentum

A koncepció (v0.7, 1566 sor) leírja a teljes víziót. Ez a terv arra ad választ: **hogyan építsünk belőle egy architektúra-teljes, valódi (nem mockolt) MVP-t**, amelyben a platform minden lényeges eleme **alapszinten összeáll és end-to-end kipróbálható**. Ez a dokumentum a fejlesztési specifikáció közvetlen alapja.

**A vezérelv (a felhasználói döntés szerint):** az MVP célja **nem egy konkrét use case bizonyítása**, hanem hogy az **architektúra minden eleme egy alapszinten működjön és összeálljon**. Az első paraméterezett agent egy **belső tudás-asszisztens (wiki-agent)** — de ez a spec szempontjából **csere­szabatos paraméterezés**: a wiki-agent a legalacsonyabb kockázatú, leggyorsabban felépíthető "első lakó" a kész vázban, nem a termék lényege. A váz onnantól bármilyen agenttel (számlafeldolgozó, reconciliation, monitor) feltölthető a kód érdemi átírása nélkül.

**Három eldöntött alapparaméter (ezen épül a terv):**

| Paraméter | Döntés | Következmény |
|---|---|---|
| Mélység | **Valódi, vékony függőleges szelet (walking skeleton)** | Nem mockup. Minden komponens valódi, de a legszűkebb működő formában. Egy agent ténylegesen fut kontrollált runtime-ban, valódi modellhívással és valódi audittal. |
| Architektúra-lefedettség | **Teljes (minden komponens jelen van)** | A scope-ot nem a feature-mélység, hanem a komponens-teljesség hajtja: minden architektúra-elem legalább "happy path" szinten összeáll. |
| Első agent | **Belső tudás-asszisztens (wiki-agent), RAG** | A legkisebb kockázatú belépő (kifelé nem ír, citált választ ad); a tanítási ciklus természetes human-in-the-loop pontja. |

> **Névütközés-elhatárolás (változatlan a v0.1-ből):** a posnavigator repóban lévő `agent-platform` / `038-agent-first-platform` modul **nem ez** — az az „Agent-First POSnavigator". A jelen termék önálló, új tanácsadói termék. Közös kód nincs.

---

## 1. Az MVP célja és határai

### 1.1 Mit bizonyít az MVP

Egyetlen, de a teljes architektúrát átvágó állítást:

> **Egy feltöltött belső dokumentumtól / felhasználói kérdéstől indulva egy AI-agent kontrolláltan dolgozik — minden modellhívása a Model Gateway-en, minden eszközhívása a Tool Brokeren megy át —, citált, ellenőrizhető eredményt ad, a tudásfrissítés emberi jóváhagyáson (write-gate) keresztül történik, és minden lépés tickethez kötött, naplózott és visszakereshető.**

A walking skeleton akkor sikeres, ha **minden architektúra-komponens egyszer „életre kel" egy valódi végigfutásban**, és bármelyik komponens önállóan is demonstrálható.

### 1.2 Az MVP két sikertengelye

1. **Funkcionális tengely (a use case):** a wiki-agent valós belső dokumentumokból citált választ ad, és egy jóváhagyott tanítási ticketen bővíthető a tudása.
2. **Architektúra tengely (a fő cél):** a Control Plane, a harness (Goose), a Model Gateway, a Tool Broker, a dispatcher, az IAM/RBAC, az Agent Registry, a tanítás/memória, a connector-réteg, a Sandbox és az append-only audit **mind jelen van és összjátékban kipróbálható**.

### 1.3 Scope — mi VAN benne (in scope, valódi megvalósítás)

A komponensenkénti minimum a 3. fejezetben részletes; összefoglalva valódi (nem szimulált) formában készül:

- **Control Plane:** Kanban-board + ticket-állapotgép (szerveroldali validáció), admin-paraméterezés (tickettípus, átmenetek), append-only hash-láncolt audit log.
- **IAM/RBAC:** humán auth (Clerk) + 4 szerepkör (admin/approver/operator/viewer) + agent service account scoped API-kulccsal.
- **Agent Registry:** egy agent (wiki) verziózott rekordja, szerep- és viselkedés-instrukció szétválasztva, modell-konfig.
- **Model Gateway:** valódi wrapper **egyetlen modellforrás, a ChatGPT OAuth-bekötés** felé (előfizetés, Codex-provider), routing-/token-mediációval, költség- és használat-naplóval, alap guardraillel.
- **Tool Broker:** MCP-proxy, capability-kikényszerítéssel, szerveroldali secret-injektálással, hívás-naplóval — legalább 2 eszközzel (dokumentum-olvasás/RAG-retrieval + a board írása).
- **Harness:** Goose `goose run` headless módban, ticketenkénti Cloud Run Jobként a dispatcher mögött, recipe-vel; deny-by-default egress; developer-extension lezárva.
- **Dispatcher:** eseményvezérelt, nem-LLM work-queue + worker; `Ready` = predikátum.
- **Tanítás/memória:** verziózott `MemoryStore`, write-gate (aláírt, egyszer használatos token), jóváhagyási lánc, rollback.
- **Sandbox/Execution Plane:** egyetlen reprezentatív felület — a wiki-agent munkatere (kérdés + citált válasz + forráslista + jóváhagyásra küldés).
- **Mérés:** token/költség/ticket dashboard minimum; egyszerű eval-felület.

### 1.4 Scope — mi NINCS benne (out of scope, szándékosan)

- **Elhalasztott koncepció-komponensek (10.B):** sensitivity-aware router (4.7.2), külső policy engine / OPA-Cedar (4.13), külső memory substrate / Zep-Graphiti (4.13), hibrid retrieval FTS5+vektor+RRF+salience (4.6.2), saját model hosting / lokális GPU (4.7). Mind **cserepont mögé** építve, de nem implementálva.
- **Multi-tenant kemény izoláció:** az architektúra multi-tenant by design (koncepció 8.8), de az MVP **egy tenant** (Excellence Pay belső, majd Ostoros-Novaj) — a tenant-szeparáció adatmodell-szinten előkészítve, nem élesen tesztelve.
- **On-prem / Keycloak deployment:** a banki upgrade-path (8.7); MVP felhő-alapértelmezett, Clerk.
- **Erőforrás-szintű emberi hozzáférés (4.4.2 Fázis 3):** marad a 4 globális szerepkör.
- **Több connector, valódi ERP/könyvelő integráció:** az MVP connector-készlete a wiki use case-hez szükséges minimum.
- **Proaktív monitor (4.11.7), recurring ütemezés (4.11.6):** a dispatcher `execute_after` predikátuma előkészíti, de a monitor-feature a következő iteráció.

> **A scope-határ a legfontosabb fegyelmező eszköz.** A walking skeletonnál a kísértés az, hogy egy-egy komponenst „rendesen" építsünk meg. Az MVP-ben minden komponens a **legszűkebb működő formában** készül; a mélységet a use case-ek élesedése hajtja, nem az MVP.

### 1.5 Már meglévő, de MVP-feletti elemek elhatárolása

A jelenlegi kódbázisban több olyan képesség is van, amely a későbbi termékirányhoz hasznos, de **nem része az MVP elfogadási feltételeinek**. Ezeket nem kell visszabontani, de a további fejlesztésnél külön scope-ként kell kezelni:

| Terület | Jelenlegi helyzet | MVP-scope értelmezés |
|---|---|---|
| **Gemini / Ollama modelladapterek** | A Model Gateway mögött cserepontként megjelentek. | Az MVP hivatalos modellforrása továbbra is **ChatGPT OAuth**. Más provider csak kísérleti / Fázis 2 adapter; a wiki-agent MVP-demója nem támaszkodhat rá. |
| **Per-user delegated connector / Gmail** | A séma- és runtime-ág, token-vault és S7 smoke részben elkészült. | Fázis 2 feature a `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md` alapján. Az MVP-ben a Tool Broker `actingUserId` paramétere csak előkészítő cserepont. |
| **File editor / workspace file tools** | Külön feature-spec és E2E teszt tartozik hozzá. | Nem core MVP-követelmény; külön feature-scope. Az MVP csak a wiki tudásfeltöltéshez és citált válaszhoz szükséges dokumentumkezelést várja el. |
| **Scheduled / recurring tasks** | A `scheduled_tasks` domain és UI irány megjelent. | Az MVP-ben az `execute_after` mező és a dispatcher ready-predikátuma előkészítés. Recurring/proaktív monitor nem MVP acceptance. |

**Szabály:** ha egy új munka ezek valamelyikét mélyítené, azt Fázis 2 / külön feature feladatként kell kezelni, és az MVP-lezárási sorrend elé csak külön döntéssel kerülhet.

---

## 2. Miért a walking skeleton a helyes első lépés

| Szempont | Kattintható mockup (régi v0.1) | **Walking skeleton (ez a terv)** | Use-case-mély MVP |
|---|---|---|---|
| Mit bizonyít | sales-sztori, UX | **az architektúra valóban összeáll és kontrollált** | egy use case üzleti értéke |
| Kockázat, amit kivesz | félreértés | **technikai integrációs kockázat (a legnagyobb)** | üzleti illeszkedés |
| Idő | napok–2 hét | **6–10 hét** | hónapok |
| Mire jó utána | demó | **bármely use case ráépíthető, spec alapja** | egy ügyfél |

A walking skeleton azért helyes most, mert a koncepció legnagyobb bizonytalansága **nem üzleti, hanem integrációs**: működik-e a Goose a routolt modellel a dispatcher mögött, tényleg minden hívás a két átjárón megy-e, kikényszeríthető-e a write-gate. Ezt csak valódi (nem mockolt) végigfutás bizonyítja — és pont ez a termék fő differenciátora (kontrollált, auditálható autonómia).

---

## 3. Komponensenkénti MVP-szint (a spec magja)

Minden komponensnél: **mi a minimum**, **mi valódi / mi cserepont mögött egyszerűsített**, **mi a kipróbálhatósági kritérium**.

### 3.1 Control Plane — ticket-modell és állapotgép (koncepció 4.2–4.3)

- **Minimum:** Kanban-board UI; két tickettípus: (1) **interakciós ticket** (wiki-kérdés / riport-kérés), (2) **tanítási ticket** (tudásfrissítés). Szerveroldali állapotgép: `Backlog → Ready → In Progress → Awaiting Human → Approved → Done` (+ `Rejected`). Az átmeneteket **a szerver kényszeríti ki**, nem az agent.
- **Cserepont:** az állapotgép-definíció admin-konfigból jön (tickettípus → engedélyezett átmenetek), de az MVP-ben fix, beégetett két típussal indul; az admin-szerkesztő alap CRUD.
- **Kipróbálható, ha:** a board-on egy ticket végigvihető, és tiltott átmenet (pl. `Backlog → Done`) szerveroldalon elutasításra kerül + auditba kerül.

### 3.2 IAM / RBAC (koncepció 4.4)

- **Minimum:** Clerk-alapú humán login (a 4.4.1 OIDC-absztrakció mögött). 4 szerepkör: **admin / approver / operator / viewer**, mező a user-rekordon. Agent = **service account** scoped API-kulccsal (a wiki-agent kulcsa csak a board olvasására + ticket írására + a wiki-connectorra jogosít).
- **Cserepont:** a humán auth OIDC-absztrakció mögött (Clerk ↔ Keycloak csere fájdalommentes). Az **agent-authz a saját control plane-ben**, nem a Clerkben.
- **MVP-egyszerűsítés:** a deny-by-default user-provisioning kemény kapuja (4.4.2) **Fázis 2** — az MVP a szerepkör-mezőt és az agent-authz-t valódira építi, de a humán önregisztrációs kaput még nem zárja keményen.
- **Kipróbálható, ha:** egy `viewer` nem tud jóváhagyni; az agent API-kulccsal csak a jogosult eszközöket éri el; minden hozzáférési esemény auditba kerül.

### 3.3 Agent Registry & életciklus (koncepció 4.5)

- **Minimum:** egy agent-rekord (wiki-asszisztens): név, **szerep-instrukció** (mit csinál) és **viselkedés-profil** (magyar, tömör, citálás-kötelezettség) — külön verziózva; jogosultságkészlet; modell-konfig (4.7); memória-állapot-verzió (4.6); scoped API-kulcs.
- **Cserepont:** a viselkedés-profil megosztott erőforrásként előkészítve (4.9.1), de MVP-ben egy agenthez kötve.
- **Kipróbálható, ha:** bármely lezárt ticketről visszakereshető, **melyik agent-verzió + melyik memória-verzió + melyik recipe-verzió** dolgozott rajta (reprodukálhatóság).

### 3.4 Model Gateway (koncepció 4.7)

- **Minimum:** valódi wrapper-szolgáltatás, amelyre a Goose provider-rétege **egyetlen végpontként** van kötve. **Egyetlen modellforrás eldöntve: ChatGPT OAuth-bekötés** (előfizetés, „Sign in with ChatGPT" / Codex-provider) — **más modell nincs** (sem külön OpenAI API, sem Gemini). A Gateway az OAuth-tokent **szerveroldalon mediálja** (az agent és a Goose sosem birtokolja), és minden hívást **naplóz** (modell, használat, latency, státusz). Routing-döntés szerveroldalon megmarad (ticket → agent → globális), de MVP-ben egyetlen célra mutat. Alap guardrail: használati keret/ticket + kimenet-validáció.
- **Cserepont:** a Gateway thin saját adapter; a routing-absztrakció megmarad, így ha később mégis több modell (API) kell, az **kódváltás nélkül** beköthető. LiteLLM/Portkey és a sensitivity router (4.7.2) elhalasztott — helyük a kódban jelölve.
- **Validálandó (a döntés következménye — lásd S2 és 10.):** (a) a ChatGPT OAuth a Gateway mögött **service-account helyett emberi előfizetői identitáshoz** kötődik → az agent-verzió szintű attribútáláshoz a Gateway-nek külön kell naplóznia, melyik agent hívott; (b) **flat-rate kvóta = korlátozott hívásonkénti token/költség-telemetria** → a költségmérés (8.) becsült/aggregált lesz, nem pontos per-call; (c) **heti használati plafon** → a dispatcher budget-/rate-cap (3.7) kötelező, hogy ne fogyjon el a kvóta; (d) a Goose provider ↔ OAuth-csatorna illeszkedését az **S2 spike** igazolja.
- **Kipróbálható, ha:** az agent nem birtokolja az OAuth-tokent (a Gateway mediálja); a használat/költség ticketenként legalább aggregáltan látszik; a futás a Gateway naplójában megjelenik.

### 3.5 Tool Broker — MCP-proxy (koncepció 4.8.4)

- **Minimum:** MCP-proxy, amelyre a Goose extension-konfigurációja mutat. Legalább **két eszköz (capability):** (a) `kb_search` / dokumentum-retrieval a wiki tudásbázisból, (b) `board_write` a ticket frissítésére. **Capability-kikényszerítés** (deny-by-default `authorize(agent, tool, args)` — egyszerű allowlist/`if`). **Secret szerveroldali injektálás** alias mögött. Minden hívás (agent-verzió, tool, argumentum, eredmény-meta) append-only auditba.
- **Cserepont:** `authorize()` egyetlen függvény → később OPA/Cedar (4.13), most allowlist.
- **Kipróbálható, ha:** az agent egy nem engedélyezett toolt hívva **blokkot + audit-flaget** kap; a secret sosem jelenik meg a promptban/runtime-ban/logban.

### 3.6 Harness — Goose (koncepció 4.8)

- **Minimum:** Goose-konténer, **`goose run` headless** (`--no-session`, `GOOSE_MODE`), **ticketenkénti Cloud Run Jobként** indítva a dispatcherből; a tickethez tartozó **recipe** betöltése; strukturált (json/stream-json) kimenet visszaírása a ticketre. A Goose **provider-rétege a Model Gateway-re**, **extension-konfigurációja a Tool Brokerre** kötve.
- **Kritikus lezárás:** **deny-by-default egress** (a konténer csak a Gateway + Broker felé mehet ki); a beépített **developer-extension lezárva** (shell/fájl csak az efemer munkaterületre); az agent **nem deploy-olhat** közvetlenül.
- **Cserepont:** Goose az egyedüli harness (nincs OpenCode fallback). Coding-igénynél a Gateway routol erős coding-modellt — MVP-ben nem releváns (wiki nem kódol).
- **Kipróbálható, ha:** egy ticket lefuttat egy valódi `goose run`-t, a futás a két átjárón megy, és igazolható, hogy a konténer **nem ér el** közvetlen internetet/rendszert.

### 3.7 Dispatcher — eseményvezérelt indítás (koncepció 4.11)

- **Minimum:** **nem-LLM** backend work-queue + worker. `Ready` ticketnél a dispatcher elindítja a Goose Cloud Run Jobot. Eseményvezérelt trigger (state-change) + alacsony frekvenciás cron-söprés safety netként. `Ready = predikátum` (`now >= execute_after` ÉS blokkolók készek ÉS jóváhagyási kapuk teljesültek). **Ticket-lock / idempotencia** a dupla-indítás ellen. Per-agent budget cap + max párhuzamosság.
- **Cserepont:** az `execute_after` mező előkészíti az ütemezett/recurring (4.11.6) és proaktív monitor (4.11.7) bővítést — MVP-ben csak az azonnali indítás aktív.
- **Kipróbálható, ha:** a dispatcher üresben **nulla LLM-tokent** fogyaszt; egy ticket pontosan egyszer fut (nincs duplázódás).

### 3.8 Tanítás és memória — write-gate (koncepció 4.6)

- **Minimum:** verziózott `MemoryStore` (a wiki tudásbázisa = jóváhagyott memória). **Tanítási ticket** → javasolt diff → **jóváhagyási lánc** (approver) → a platform **szerveroldali, aláírt, egyszer használatos write-gate tokennel** ír → új verzió + **rollback**. Olvasás-oldal: MVP-ben **teljes beinjektálás** (kis tudásbázis) vagy egyszerű kulcsszavas retrieval a `kb_search` toolon át.
- **Cserepont:** `MemoryStore` interfész mögött; hibrid keresés (4.6.2) elhalasztott. A reflexió-feeder (4.6.3) opcionális extra — ha belefér, a tanítási ticketet az agent saját javaslata is generálhatja.
- **Kipróbálható, ha:** külső prompt („tanuld meg, hogy…") **nem** ír memóriát; csak jóváhagyott tanítási ticket ír; a frissítés visszagörgethető, és a retrieval naplózza, mely memória-verziót olvasta.

### 3.9 Connector-réteg (koncepció 4.12)

- **Minimum:** a wiki tudásbázis mint **first-class connector-erőforrás** (verziózott, scope-olt, az agenthez kötve); a board mint connector. Secret alias mögött, szerveroldali injektálással.
- **Cserepont:** a connector-könyvtár újrahasznosítható IP — MVP-ben 1-2 connector, de a sablon a következő ügyfélnél kész.
- **Kipróbálható, ha:** a connector definíciója a control plane-ben, a forgalom a data plane-ben; az agent csak a jogosult connectort éri el.

### 3.10 Execution / Sandbox Plane (koncepció 5.x)

- **Minimum:** egyetlen reprezentatív Next.js-felület: **dokumentum-/tudásfeltöltés**, **kérdés-válasz a wiki-agenttől citált forrással + indoklással**, **jóváhagyásra küldés** (tanítási vagy kifelé menő válasznál), **jóváhagyott eredmény lezárása**. Request/response, állapotmentes — az agent **nem ebben fut** (3.1 koncepció).
- **Cserepont:** a sandbox mint agent-által fejleszthető appplatform (5.4) és graduation (5.8) **nem MVP** — csak a UI + data plane szelet.
- **Kipróbálható, ha:** a felhasználó végigvisz egy kérdés→válasz→(opcionálisan tanítás)→jóváhagyás folyamatot, és minden a boardon/auditban látszik.

### 3.11 Audit (koncepció 4.8 / 8.5)

- **Minimum:** **append-only, hash-láncolt** auditesemény-modell. Minden naplózandó: ticket-átmenet, modellhívás (modell, token, költség, latency, státusz), eszközhívás (tool, argumentum-meta, eredmény-meta), hozzáférési esemény (meghívás, szerepkiosztás), memória-írás (diff, jóváhagyó, verzió), agent-verzió.
- **Kipróbálható, ha:** a demó végén megmutatható egy **teljes láncolat** egy adott eredményhez: melyik input, melyik agent-/memória-/recipe-verzió, mely modell- és eszközhívások, ki hagyta jóvá.

### 3.12 Adatmodell-vázlat (fejlesztési spec input)

Központi entitások (MVP, egyszerűsített):

| Entitás | Kulcsmezők | Megjegyzés |
|---|---|---|
| `User` | id, auth_subject (Clerk), role, status, tenant_id | role: admin/approver/operator/viewer |
| `Agent` | id, name, role_instruction_version, behavior_profile_version, model_config, memory_version, status | verziózott |
| `AgentApiKey` | id, agent_id, scopes[], hash, rotated_at | scoped, rotálható |
| `Ticket` | id, type, state, assignee (user/agent), execute_after, due_by, payload, links[] | állapotgép szerveroldalon |
| `TicketTransition` | id, ticket_id, from, to, actor, ts | auditforrás |
| `MemoryVersion` | id, agent_id, version, content_ref, parent_version, approved_by | rollbackolható |
| `TrainingTicket` | ticket_id, proposed_diff, write_gate_token_ref, eval_result | write-gate köti |
| `Connector` | id, type, scope, secret_alias, version | first-class erőforrás |
| `Capability` | agent_id, tool_name, allowed | deny-by-default |
| `ModelCall` | id, ticket_id, agent_version, model, tokens, cost, latency, status | Model Gateway naplója |
| `ToolCall` | id, ticket_id, agent_version, tool, args_meta, result_meta | Tool Broker naplója |
| `AuditEvent` | id, prev_hash, hash, type, actor, payload, ts | append-only hash-lánc |

### 3.13 Tech stack döntések (MVP)

| Réteg | MVP-döntés | Indok / cserepont |
|---|---|---|
| Control + Sandbox app | **Next.js (App Router)** | csapat ismeri (posnavigator); a Sandbox amúgy is Next.js (koncepció 3.1) |
| Humán auth | **Clerk** (OIDC-absztrakció mögött) | gyors; Keycloak az on-prem upgrade-path (4.4.1) |
| Adatbázis | **Postgres** (Cloud SQL) — alt.: Firestore | `LISTEN/NOTIFY` a dispatchernek (4.11.2); relációs audit-lánc |
| Dispatcher trigger | state-change esemény + cron safety net | nem-LLM (4.11.1) |
| Harness | **Goose** (Apache-2.0, AAIF/LF), `goose run` | Cloud Run Job ticketenként (4.8.3) |
| Harness futtatás | **Cloud Run Jobs** | pay-per-run, scale-to-zero (4.8.3) |
| Model Gateway | saját thin adapter, OAuth-token-mediációval | **csak ChatGPT OAuth** (Codex-provider); több modell / LiteLLM elhalasztott (4.13) |
| Tool Broker | saját MCP-proxy | Goose extension ráköt; OPA elhalasztott (4.13) |
| Memória | verziózott DB-rekord + write-gate token | `MemoryStore` interfész mögött (4.13) |

> **Megnyitandó döntés (lásd 8.):** Postgres vs. Firestore. A koncepció mindkettőt említi; a `LISTEN/NOTIFY` és a relációs hash-lánc miatt a Postgres a default javaslatom, de ez tenant-/infra-függő.

---

## 4. End-to-end demó-forgatókönyv (a walking skeleton bizonyítéka)

A demó egyetlen összefüggő történet, amelyben **minden komponens egyszer szerepel**:

1. **Belépés (IAM):** admin meghívja az operatort és az approvert; mindenki a saját szerepével lép be. *(3.2)*
2. **Agent létrehozása (Registry):** admin létrehozza a wiki-agentet, beállítja a szerep-/viselkedés-instrukciót, a modellt (**ChatGPT OAuth — az egyetlen forrás**), a wiki-connectort és a 2 capabilityt. *(3.3, 3.4, 3.5, 3.9)*
3. **Tudásbázis feltöltés (Sandbox + connector):** az operator feltölt néhány belső szabályzatot. *(3.10)*
4. **Kérdés (interakciós ticket):** az operator kérdést tesz fel → ticket jön létre → `Ready`. *(3.1)*
5. **Dispatch + futás (Dispatcher + Harness):** a dispatcher elindítja a Goose Cloud Run Jobot a recipe-vel; a Goose a Model Gateway-en gondolkodik és a Tool Brokeren át keres a tudásbázisban. *(3.6, 3.7)*
6. **Citált válasz (Sandbox):** az agent **forráshivatkozott** választ ír a ticketre; kifelé menő/bizonytalan válasznál `Awaiting Human`. *(3.10, 3.11)*
7. **Jóváhagyás (human-in-the-loop):** az approver jóváhagyja; a ticket `Done`. *(3.1, 3.2)*
8. **Tanítás (write-gate):** kiderül egy hiányzó tény → tanítási ticket → javasolt diff → approver jóváhagyja → a platform **write-gate tokennel** új memória-verziót ír. *(3.8)*
9. **Rollback-demó:** a tanítást visszagörgetjük egy korábbi verzióra. *(3.8)*
10. **Audit-bizonyíték:** megmutatjuk az adott válasz **teljes láncolatát** (input → agent-/memória-/recipe-verzió → modell- és eszközhívások → jóváhagyó), plusz a **token/költség/ticket** értéket. *(3.11, 5.)*
11. **Negatív tesztek:** (a) `viewer` nem hagyhat jóvá; (b) tiltott eszközhívás blokk + flag; (c) külső „tanuld meg…" prompt **nem** ír memóriát; (d) a Goose-konténer nem ér el közvetlen internetet. *(governance bizonyítékok)*

---

## 5. MVP backlog (epikek)

**Epik 1 — Control Plane mag**
- ticket board + ticket-részlet UI; ticket-állapotgép szerveroldali validációval; 2 tickettípus; admin tickettípus/átmenet CRUD (alap); append-only hash-láncolt audit event-modell + audit-nézet.

**Epik 2 — IAM / RBAC**
- Clerk-integráció OIDC-absztrakció mögött; 4 szerepkör; admin-meghívás; agent service account + scoped API-kulcs; hozzáférési események auditálása.

**Epik 3 — Agent Registry + Model Gateway**
- agent-rekord (szerep/viselkedés szétválasztva, verziózva); modell-konfig; Model Gateway wrapper (OpenAI + Gemini), routing-döntés, token/költség/latency napló, költségplafon-guardrail.

**Epik 4 — Tool Broker + connector**
- MCP-proxy; `authorize()` allowlist; secret-alias szerveroldali injektálás; `kb_search` + `board_write` capability; wiki-connector + board-connector; hívás-napló.

**Epik 5 — Harness (Goose) + Dispatcher**
- Goose-konténer; `goose run` recipe-vel; provider→Gateway, extension→Broker bekötés; deny-by-default egress + developer-extension lezárás; Cloud Run Job; nem-LLM dispatcher (esemény + cron); `Ready` predikátum; ticket-lock/idempotencia; per-agent budget cap.

**Epik 6 — Tanítás / memória**
- verziózott `MemoryStore`; tanítási ticket + javasolt diff; jóváhagyási lánc; write-gate token (aláírt, egyszer használatos, diffhez kötött); verzió-promóció + rollback; retrieval-napló. *(Opcionális: reflexió-feeder, 4.6.3.)*

**Epik 7 — Sandbox use case (wiki)**
- tudásfeltöltés; kérdés→citált válasz+indoklás UI; jóváhagyásra küldés; lezárás; 1 előre definiált riport-sablon generálása a tudásbázisból.

**Epik 8 — Governance és mérés**
- human-in-the-loop kapu; token/költség dashboard minimum; hibás/bizonytalan eset eszkaláció; egyszerű eval dataset + manuális értékelő felület; a 4. fejezet negatív tesztjei.

> **Függőség:** Epik 1–2 → Epik 3–4 → Epik 5 → Epik 6–7 → Epik 8. A Goose-spike (7.) az Epik 5 előtt fusson.

---

## 6. Elfogadási kritériumok

A koncepció 9.2 kritériumai + a walking skeleton extra feltétele (minden komponens kipróbálható):

- A wiki use case-re végigmegy egy teljes folyamat kérdéstől jóváhagyott, citált eredményig.
- **Legalább egy agent ténylegesen fut kontrollált runtime-ban** (valódi Goose `goose run`, nem szimuláció).
- Minden agent-művelet **tickethez kötött és visszakereshető**.
- Van **Model Gateway napló** (modell, token/költség, latency, státusz) és **Tool Broker napló** (eszköz, jogosultság).
- A kritikus lépés **emberi jóváhagyáson** megy át; bizonytalan eset emberhez eszkalálódik.
- A demó végén megmutatható, **melyik agent-/memória-/recipe-verzió + input** alapján született az eredmény.
- Van **rövid mérési riport** (válaszminőség, átfutás, visszadobás, költség/ticket).
- **Architektúra-teljesség (extra):** mind a 3.1–3.11 komponens legalább egyszer szerepel egy valódi végigfutásban, és a 4. fejezet 4 negatív tesztje sikeres.

---

## 7. Validálandó spike-ok (a fejlesztés előtt / közben — koncepció 10.A)

| # | Spike | Mit bizonyít | Kockázat, ha elmarad |
|---|---|---|---|
| S1 | `goose run` + recipe a dispatcher (Cloud Run Job) mögött | a headless futás API-vezérelhető | a teljes harness-modell |
| S2 | Goose provider → Model Gateway, mögötte **ChatGPT OAuth-mediáció** | minden modellhívás brokerált + az OAuth-token szerveroldalon marad | audit-vakság, token-szivárgás, illeszkedési kockázat |
| S3 | Goose extension → Tool Broker MCP-proxy | minden eszközhívás brokerált | secret-szivárgás |
| S4 | developer-extension lezárás + deny-by-default egress | a konténer nem szökik ki | governance-állítás összeomlik |
| S5 | write-gate token end-to-end (aláírás, egyszer-használat, rollback) | a tanulás nem hamisítható | fő differenciátor |
| S6 | retrieval-minőség kis tudásbázison (teljes beinjektálás vs. kulcsszavas) | a citált válasz használható | use-case érték |

> A S1–S4 a **legkockázatosabb** — ezek a Goose-integráció ismeretlenjei. Javaslat: az Epik 5 előtt egy idődobozolt (pl. 1 hetes) integrációs spike fusson e négyre.

---

## 8. Mérési modell (koncepció 12.4 / 9.2)

| Dimenzió | MVP-metrika | Cél |
|---|---|---|
| Hatékonyság | válaszidő / kérdés; kézi keresési idő megtakarítása | csökkenés kimutatása kis mintán |
| Minőség | citált válaszok aránya; forrás-lefedettség; emberi visszadobási arány | hibák láthatóvá tétele |
| Kontroll | jóváhagyott vs. automatikus lépések; audit-lánc teljessége | minden kritikus lépés visszakereshető |
| Költség | token/költség per ticket; runtime-költség / nap | költségplafon és trend látszik |

---

## 9. Security baseline (MVP-minimum — koncepció 12.1 / 8.)

- **Secret-kezelés:** secret soha a promptban/runtime-ban; alias + szerveroldali injektálás (Tool Broker). Secret Manager.
- **Egress:** harness-konténer deny-by-default; csak Gateway + Broker felé.
- **Audit:** append-only, hash-láncolt; nem törölhető a normál folyamatból.
- **Human approval:** kötelező a tudásfrissítésnél és a kifelé menő válasznál.
- **Rate limit / budget / kill-switch:** per-agent budget cap; eszköz-szintű rate limit; agent-felfüggesztés (kill-switch).
- **Prompt injection:** a dokumentum-/web-tartalom **adat, nem utasítás**; a write-gate token nem csalható ki promptból.
- **Lock-out védelem:** utolsó admin nem zárható ki; admin a saját szerepét nem írhatja át.

---

## 10. Nyitott döntések — ezekre választ kérek, mielőtt a spec véglegesül

| # | Döntés | Opciók | Default-javaslatom |
|---|---|---|---|
| D1 | Adatbázis | Postgres (Cloud SQL) vs. Firestore | **Postgres** (`LISTEN/NOTIFY`, relációs audit-lánc) |
| ~~D2~~ | ~~Modellforrás~~ | — | **ELDÖNTVE: kizárólag ChatGPT OAuth-bekötés** (Codex-provider), más modellforrás nincs. Lásd 3.4. |
| D3 | Tudásbázis forrása az MVP-hez | Excellence Pay belső dokumentumok vs. Ostoros-Novaj anyagok | **belső dokumentumok** elsőre (nincs ügyfélfüggőség) |
| D4 | Hosting | GCP (Cloud Run + Cloud SQL) vs. Firebase | a Cloud Run Jobs miatt **GCP** koherens |
| D5 | Reflexió-feeder (4.6.3) | MVP-be vagy következő iteráció | **következő iteráció** (a write-gate demo enélkül is teljes) |
| D6 | Időkeret / csapat | hány fejlesztő, mennyi idő | a 6–10 hetes becslés ettől függ |

> **D2 — eldöntve:** az MVP modellforrása **kizárólag a ChatGPT OAuth-bekötés** (előfizetés, „Sign in with ChatGPT" / Codex-provider) — sem külön OpenAI API, sem Gemini. Ez a Goose providerét egyetlen, OAuth-mediált Gateway-végpontra köti. A döntés három következménye, amit a fejlesztésnek kezelnie kell (lásd 3.4 és S2): (1) emberi előfizetői identitás → az agent-szintű attribútálást a Gateway naplózza külön; (2) flat-rate kvóta → a költségmérés aggregált, nem pontos per-call; (3) heti használati plafon → kötelező dispatcher budget-/rate-cap (3.7). A routing-absztrakció megmarad, így ha később mégis kell több modell, az kódváltás nélkül beköthető.

---

## 11. Ütemezés (indikatív, D6 függvénye)

| Fázis | Tartalom | Idő (becslés) |
|---|---|---|
| 0. Spike | S1–S4 Goose-integráció | ~1 hét |
| 1. Control Plane + IAM | Epik 1–2 | ~2 hét |
| 2. Gateway + Broker + Registry | Epik 3–4 | ~2 hét |
| 3. Harness + Dispatcher | Epik 5 | ~1.5 hét |
| 4. Tanítás + Sandbox | Epik 6–7 | ~2 hét |
| 5. Governance + mérés + demó | Epik 8 + negatív tesztek | ~1 hét |

Összesen **~9–10 hét** egy kis csapattal; spike-eredménytől és D6-tól függően szűkíthető.

---

## 12. Következő dokumentumok (a spec felé — koncepció 12.6)

Ez a terv közvetlenül a következőkbe bomlik:

- **MVP technical design** — komponensenkénti API-k, a 3.12 adatmodell részletezve, a recipe formátuma.
- **Security & compliance baseline** — a 9. fejezet kibontva.
- **Eval plan** — teszt-kérdéskészlet + elfogadási küszöbök a wiki-agentre.
- **Demo script** — a 4. fejezet 3–5 perces, kattintható forgatókönyvvé.

---

*Forrásalap: `AI-Agent-Platform-Koncepcio.md` v0.7 (forrásellenőrzés: 2026-06-14). A modellstratégia eldöntve (D2: kizárólag ChatGPT OAuth); az ehhez kötődő OAuth-mediáció és kvótakezelés az S2 spike-on validálandó. Az elhalasztott komponensek (koncepció 10.B) éles ügyfélanyag előtt újra validálandók.*
