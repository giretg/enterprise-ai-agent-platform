# Feature-spec — Tanítás, memória, write-gate és önfejlesztési pipeline

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.1
**Dátum:** 2026-08-25
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (§4.6 tanítás és memória, §4.6.1 write-gate / aláírt token, §4.6.2 retrieval / hibrid keresés — elhalasztott, §4.6.3 reflexiós feeder, §4.6.4 önfejlesztési profil, §4.5 reprodukálhatóság, §4.13/4.14 `MemoryStore` cserepont és session-elhatárolás, §8.1 memória mint legnagyobb kockázat és érték, §8.2 prompt injection, §8.5 append-only audit), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (v1.0, §4.4 `memories`/`memory_versions`/`training_tickets` séma, §5.8 write-gate token protokoll + API, §5.11 `MemoryStore` interfész, §5.12.2 önfejlesztési profil, §11 audit-események), `AI-Agent-Platform-Feature-Spec-AgentRegistry.md` (v1.0, `self_evolution_profile`, `current_memory_version`, kemény padló), `AI-Agent-Platform-Feature-Spec-ModelGateway.md` (eval-futás modellhívásai), `AI-Agent-Platform-Feature-Spec-ConversationSession.md` (working memory ≠ tartós memória), `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md` (embedding-hívás a Tool Brokeren át)
**Olvasó:** fejlesztő(k). Feltételezi az append-only audit (`verifyChain`), az RBAC (`requireRole`), a Tool Broker capability-modell (`authorize()`), a Model Gateway routing és az Agent Registry (`agent_versions`, `self_evolution_profile`) ismeretét.
**Státusz:** **MVP-horgok kész, teljes pipeline részben Fázis 2; a v1.1 termékdöntések még implementálandók.** A `memories` / `memory_versions` / `training_tickets` séma, a write-gate token protokoll (`createTrainingTicket` / `approveTraining` / `rollbackMemory`) és a runtime memóriaolvasás alapjai be vannak kötve. A v1.1-ben rögzített teljes javasolt szabályverzió, ticketen belüli revíziók, agent-szintű `durable_memory_approval_policy`, policy-alapú UI és a betanított szabályverzió/projektmemória-manifeszt szétválasztása **célállapot, nem jelenlegi kódkész állapot**. Ez a dokumentum a **teljes** tanítási-memória réteget specifikálja: a memória-verziózás állapotgépét, a write-gate token életciklusát kapuról kapura, a retrievalt, a reflexiós feedert mint javaslat-generátort, és az önfejlesztési profil end-to-end kikényszerítését a kemény padlóval.

---

## 0. Mit ad ez a dokumentum

Meghatározza, hogyan „tanul" egy agent a platformon — vagyis hogyan íródik, olvasódik, verziózódik és görgethető vissza a **tartós tudása (memóriája)** úgy, hogy a koncepció központi ígérete sértetlen marad: *„az AI nálunk nem driftel el észrevétlenül"* (§8.1). A tanítás a platform **legérzékenyebb és legértékesebb** mechanizmusa: ha bárki, bármikor, kontroll nélkül átírhatná az agent tudását, a rendszer megbízhatatlanná és mérgezhetővé válna (knowledge poisoning). Ezért a tanulás itt nem szabad szöveg-betáplálás, hanem **verziózott, jóváhagyott, visszavonható és teljesen auditált** állapotátmenet.

**A feature öt, élesen elhatárolt invariánsra épül:**

1. **A memóriába kizárólag a platform ír, szerveroldali, aláírt, egyszer használatos tokennel.** Az agent (a modell) legfeljebb *javasol* egy tudásfrissítést (a `proposed_diff` tartalmát); a tényleges írást a platform végzi, miután a javaslat átment a jóváhagyáson. A token **soha nem kerül az agent/Goose birtokába** — különben egy prompt injection kicsalná vagy újrajátszaná (§4.6.1).
2. **Minden tudásfrissítés diff, verzió és rollback.** A memória nem felülíródik, hanem új `memory_versions` rekordra promótálódik; a régi lezárul, de megmarad. Bármely korábbi verzió **bármikor visszaállítható**, és bármely ticket-futásról visszakereshető, *melyik memória-verzió* volt érvényes.
3. **Az írás (write-gate) és az olvasás (retrieval) ortogonális.** A write-gate kizárólag azt szabályozza, *hogyan kerül be új tudás*; a retrieval tisztán olvasás-oldali, és sosem érinti a write-gate-et. A retrieval **maga is naplózott esemény**: visszakereshető, *mely memória-elemeket* húzta be egy futás a kontextusába.
4. **A reflexió javaslat-generátor, nem önmódosítás.** Az agent reflektálhat a munkájára és *javasolhat* tudásfrissítést, de a javaslat **automatikusan tanítási ticketként** a write-gate elé kerül — semmi nem lép életbe jóváhagyás nélkül (§4.6.3).
5. **Az önfejlesztés tárcsa, nem kapcsoló — és van kemény padlója.** A write-gate kapu *erőssége* per-agent állítható (`self_evolution_profile`), de a verziózás + rollback + audit + szerveroldali token **sosem kapcsolható ki**, és egy agent önmódosítással **soha nem bővítheti** a jogosultságait vagy eszköz-hozzáférését (§4.6.4).
6. **Egy agentnek egyszerre egy aktuális, jóváhagyásra váró betanított-szabály verziója lehet.** Az új tanítás ezt vagy továbbépíti, vagy lecseréli; mindkét esetben új javaslat-revízió készül, és kizárólag a legutolsó revízió aktiválható (§4.4).
7. **A tartós memória aktiválási szintje és a négy szem elv agentenként állítható, de jogosultságot nem teremt.** Az agent profilja eldönti, hogy approver kell-e, operator is aktiválhat-e, illetve szükséges-e a kezdeményezőtől különböző jóváhagyó; a UI csak a szerveroldali RBAC és az agent profil metszete által engedett műveleteket mutatja (§4.5–4.6).

**Miért ez a feature a legfontosabb:** a koncepció maga jelöli meg a tanítást/memóriát mint *„a legnagyobb kockázat és a legnagyobb érték"* (§8.1). Ez az a réteg, amely a platform fő differenciátorát — a kontrollált, nem-driftelő, auditálható AI-munkatársat — kódszinten bizonyíthatóvá teszi. Az Agent Registry spec ezt a réteget explicit out-of-scope-ként a *„külön memória / self-evolution spec"-re* utalta (§0.10); ez a dokumentum tölti be azt a helyet.

---

## 1. Scope

### 1.1 In scope (teljes feature)

1. **Betanított működési szabályok verziólánca** mint az agent tartós munkavégzési utasításainak egyetlen forrása: immutábilis, append-only verziók, `proposed → active → rolled_back` státusszal, diff-fel és szülő-verzió hivatkozással. A projektmemória ettől külön kanonikus forrás és verziólánc (§2.1).
2. **`training_tickets` és a write-gate token protokoll** end-to-end: token-kiállítás (HMAC-aláírás, ticket+cél-verzió kötés), szerveroldali tárolás (a nyers token sosem perszisztált), egyszeri felhasználás, lejárat, és a platform-írás kizárólagossága.
3. **Tanítási állapotgép kapukkal:** `proposed → (eval) → approved → written → active` (+ `rejected`, + `rolled_back`), minden átmenet RBAC-kapuzott és auditált; az eval-kapu opcionális, az önfejlesztési profil szerint.
4. **Eval-kapu** mint regressziós védőháló: a frissített memóriájú agent egy rögzített tesztkészleten nem romlik-e; az eredmény (`eval_result`) a tickethez kötve, a promóció feltétele (profiltól függően).
5. **Olvasási stratégia memóriafajtánként:** a betanított működési szabályok aktív verziója teljes egészében, stabil rendszerutasításként kerül a kontextusba; a projektmemória a `MemoryStore` cserepont mögött relevanciaalapú retrievallel olvasódik; a tudástár külön `kb_search` útvonal (§2.1, §6).
6. **Reflexiós feeder** (§4.6.3, Fázis 2): determinisztikus, eseményhez kötött trigger a ticket-futás végén, amely tudásfrissítés-javaslatot generál és **automatikusan tanítási ticketet nyit** — soha nem ír közvetlenül.
7. **Önfejlesztési profil enforcement** (`self_evolution_profile`): a profil `durable_memory_approval_policy` / `approval_mode` / `scope` / `diff_limit` mezői a write-gate jóváhagyási útvonalát és hatókörét vezérlik; a **kemény padló** (jogosultság-/eszköz-bővítés tiltása) kódszintű invariáns.
8. **Working / epizodikus memória elhatárolása:** a Goose-session munkamemóriája csak a ticket-futásig él, és **soha nem keveredik** a tartós tudással; átkerülés kizárólag tanítási ticketként (§4.6, §4.14).
9. **Audit és reprodukálhatóság:** minden írás, jóváhagyás, rollback, megtagadott írás és retrieval append-only audit-eseményként; a `verifyChain()` zöld marad GDPR-törlés után is.
10. **Control Plane UI:** tanítási ticket-lista és -detail (diff-nézet, eval-eredmény, jóváhagyás/elutasítás), memória-verzió-idővonal rollback-gombbal, önfejlesztési-profil szerkesztő (az Agent Registry detail-jéből).
11. **Javasolt teljes verzió és revíziók:** a tanítási ticket nem egy elszigetelt mondatot, hanem az aktív verzióból összeállított teljes következő betanított-szabály verziót hordozza; a ticket revíziótörténete megőrzi, mit váltott fel az aktuális javaslat.
12. **Jogosultságalapú, közérthető tanítási UI:** az operátor és az approver eltérő, szerepéhez illő műveleteket lát; technikai fogalmak (`write-gate`, token, diff-hash) nem jelennek meg elsődleges akciófeliratként.

### 1.2 Out of scope (most NEM)

- **Az `agents` / `agent_versions` / `self_evolution_profile` séma és UI** — az Agent Registry spec hatóköre. Itt a memória-verziót *hivatkozzuk* (`current_memory_version`) és a profilt *olvassuk*, de nem mi definiáljuk.
- **A Model Gateway routing-logikája** — az eval-futás és a (opcionális) embedding-számítás *modellhívásai* a Gateway-en mennek át, de a routing-döntés a Model Gateway-spec hatóköre (§4.7.1).
- **Az érzékenység-tudatos modellválasztó** (§4.7.2, elhalasztott) — nem érinti a tanítási pipeline-t.
- **A connector-réteg / tudásbázis-betöltés** (`kb_search`, wiki ingestion) — a Per-user Connector és az App Registry spec hatóköre; a retrieval *forrását* hivatkozzuk, de a betöltést nem itt specifikáljuk.
- **A teljes beszélgetés-UI és a ticket-állapotgép általános rétege** — a ConversationSession / Playbook spec; itt csak a `type: training` ticket sajátosságait írjuk le.
- **A lokális embedding-modell hostingja** — Fázis 2, csak konkrét ügyfélkérésnél (§4.6.2, §10.B).

### 1.3 Az MVP-re gyakorolt hatás

A kritikus mag már be van kötve: a `memories` / `memory_versions` / `training_tickets` séma, a write-gate token protokoll, a `createTrainingTicket` / `approveTraining` / `rollbackMemory` műveletek és az audit-események léteznek. A v1.1 ezekre épít, de a jelenlegi kettős célú `MemoryVersion` modellt **migrálja**: a betanított működési szabályok teljes verzióját és a projektmemória scope-manifesztjét külön logikai verzióláncra választja (§2.1). A meglévő RBAC, audit, Model Gateway és szerveroldali write-gate újrahasznosul; a revíziós és policy-modell célzottan lecseréli a mai „egy kattintás → teljes szöveg ticket/azonnali approve” tanítási útvonalat.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

```
        ┌──────────────────────────── CONTROL PLANE (1. app) ──────────────────────────────┐
        │                                                                                   │
        │   Agent Registry ──current_memory_version──►┌─────────────────────────────┐       │
        │   (self_evolution_profile)                  │   MEMÓRIA / TANÍTÁS RÉTEG    │       │
        │        │ memory approval policy/scope/limit  │  (ez a spec)                │       │
        │        ▼                                     │                             │       │
        │   ┌─────────────────┐   proposed_diff        │  memories                   │       │
        │   │ Reflexiós feeder │──────────────────────►│  memory_versions (lánc)     │       │
        │   │ (F2, determ.)    │   tanítási ticket      │  training_tickets           │       │
        │   └─────────────────┘                        │                             │       │
        │        ▲ trigger a futás végén                │  ┌──── WRITE-GATE ────┐     │       │
        │        │                                      │  │ token kiállítás     │     │       │
        │   ┌────┴───────┐    createTrainingTicket      │  │ (HMAC, 1x, szerver) │     │       │
        │   │ Operátor / │───────────────────────────►  │  │ jóváhagyás + eval   │     │       │
        │   │ Approver   │    activateTraining/rollback  │  │ platform ír         │     │       │
        │   └────────────┘                              │  └─────────┬───────────┘     │       │
        │                                               │            │ MemoryStore     │       │
        │                                               └────────────┼─────────────────┘       │
        │   Append-only AUDIT ◄── memory.update/rollback/write_denied/retrieval                 │
        └───────────────────────────────────────────────┼──────────────────────────────────────┘
                                                         │ retrieval (READ-ONLY, naplózott)
        ┌────────────────────── EXECUTION / SANDBOX PLANE (2. app) ─┼──────────────────────────┐
        │   Goose-session (working memory — efemer, NEM tartós)     ▼                          │
        │   reasoning-loop ──► betanított szabályok (teljes) + projektmemória (retrieval) + KB    │
        │   a session vége: working memory eldobva; megőrzendő tanulság → tanítási ticket        │
        └───────────────────────────────────────────────────────────────────────────────────────┘
```

**Kulcs-elhatárolás:** az **írás** mindig a Control Plane-ben, a write-gate-en át, emberi/szerep-jóváhagyással történik. Az **olvasás** futásidőben, a `MemoryStore` cserepont mögött, naplózva. A Goose-session **working memory**-ja (a §4.8.3 efemer munkaterülete) szándékosan külön réteg: nem írja a tartós tudást, a végén eldobódik.

### 2.1 A párhuzamosan élő „memóriák” kanonikus térképe

A termékben több olyan réteg él, amelyet hétköznapi nyelven memóriának lehet nevezni, de **nem azonos életciklusú és nem azonos igazságforrás**. A felületen és a kódban ezeket külön néven kell kezelni:

| Kanonikus fogalom | Mit tartalmaz? | Scope | Olvasás | Írás / jóváhagyás |
|---|---|---|---|---|
| **Betanított működési szabályok** | Az agent tartós munkavégzési utasításai, pl. adatforrás, kimeneti forma, kötelező ellenőrzések | agent-szintű | stabil rendszerutasításként minden releváns futásban | ez a tanítási UI; teljes új szabályverzió, §4.4–4.6 |
| **Projektmemória** | Egy projekt döntései, nyitott feladatai, megállapításai és folytonossági állapota | tenant + agent + projekt (+ workstream) | relevanciaalapú retrieval | `MemoryCandidate` → jóváhagyott `MemoryChunk`; külön projektmemória-életciklus |
| **Tudástár** | Forrásdokumentumok és belőlük kereshető tényanyag | tenant/agent KB | `kb_search`, lehetőleg forráshivatkozással | dokumentum-publikálási folyamat; nem a működési szabályok tanítása |
| **Beszélgetési munkakontextus** | Az aktuális beszélgetés/futás ideiglenes előzménye | conversation/run | közvetlen kontextus | efemer; tartóssá csak külön javaslattal válhat |
| **Agent-definíció és hatáskör** | Szerep, munkaköri leírás, modell- és eszközjogosultság | agent/config | stabil rendszerkonfiguráció | adminisztratív konfiguráció; tanítással nem módosítható |

**Termék-invariáns:** a runtime ezeket egyetlen agent-kontextussá állíthatja össze, de egyik réteg írása sem írhatja felül egy másik réteg kanonikus adatait. A „teljes új memória-verzió” kifejezés ebben a specben a **betanított működési szabályok teljes új verzióját** jelenti; nem másolja bele a projektmemóriát, a KB dokumentumait vagy a beszélgetési előzményt.

**Verziózási invariáns:** a betanított működési szabályok és a projektmemória külön logikai verziólánc. A mai kódban a `MemoryVersion.content` (betanított szabályok) és a `MemoryVersion.activeChunkIds` (projektmemória-manifeszt) ugyanazon modellen osztozik; ez átmeneti implementációs adósság. A célállapotban külön `InstructionMemoryVersion` és `ProjectMemoryManifest` logikai entitás — vagy legalább explicit típus és külön aktuális-verzió mutató — szükséges. Egy projektmemória-frissítés nem léptetheti és nem cserélheti le a betanított szabályok aktív verzióját, és fordítva.

**Mit jelent a szétválasztás a gyakorlatban:** ha a betanított szabály `v4 → v5` változik, a projektmemória például `P12` állapota érintetlen marad; ha a projektmemória `P12 → P13` változik, a betanított szabály továbbra is `v5`. A két forrás együtt hat az agent következő válaszára, mert a runtime mindkettőt beolvassa, de **nem írják át, nem verziózzák és nem rollbackelik egymást**. Ezért a közös jóváhagyási policy nem jelent közös tartalmat vagy közös verziót.

**UI-invariáns:** a Tanítás fül kizárólag a betanított működési szabályokat kezeli. A projektmemória „Projektelőzmények / Munkamemória”, a dokumentumalapú tudás „Tudástár” néven, külön felületen jelenik meg. A usernek nem kell a tárolási technológiát vagy a retrieval működését ismernie.

---

## 3. Adatmodell

Az MVP-séma (Roadmap §4.4) a magot adja; ez a spec a státusz-enumokat, valamint az eval- és reflexió-horgokat pontosítja. Minden tábla **tenant-scoped** (`tenant_id`), és a verzió-táblák **append-only** (UPDATE csak a `status` lezáró átmeneteire).

### 3.1 `memories` — átmeneti közös gyökér (agentenként egy)

```
id              uuid pk
tenant_id       uuid (fk tenants)            -- tenant-izoláció (§8.8)
agent_id        uuid (fk agents)             -- 1:1 az agenttel
current_version_id  uuid (fk memory_versions, nullable)  -- az AKTÍV verzió mutatója
created_at      timestamptz
```

A `current_version_id` a mai sémában a betanított működési szabályok aktív verzióját jelöli. A projektmemória scope-manifesztjének aktuális állapota ettől külön vezetendő (§2.1); a két jelentés ugyanazon mutatóban nem egyesíthető. Maga a tudás soha nem a gyökérrekordban él, hanem a megfelelő verzió- vagy chunk-rekordokban.

### 3.2 Betanított szabályverziók — immutábilis verziólánc

```
id                  uuid pk
memory_id           uuid (fk memories)
version             int                      -- monoton, memóriánként
content_ref         text                     -- a jóváhagyott tudás (GCS objektum-ref vagy inline)
diff_from_previous  jsonb                     -- mi változott az előző verzióhoz képest
status              enum: proposed | active | rolled_back
source              text                      -- 'human' | 'reflection' | 'import' + szabad indok
approved_by         uuid (fk users, nullable) -- ki hagyta jóvá (auto_after_eval esetén NULL + rendszer-jelölés)
parent_version      int (nullable)            -- melyik verzióból ágazott (rollback-célhoz)
created_at          timestamptz
```

**Invariáns:** a betanított működési szabályoknak egyszerre **pontosan egy** `active` verziója van (az instruction-current mutató arra mutat). A `proposed` verzió a jóváhagyásra váró teljes szabályállapot; a `rolled_back` a leváltott (de megőrzött) verzió. Verzió **soha nem törlődik** (kivéve GDPR-célzott tartalom-törlés a `content_ref` mögött — a metaadat-lánc ép marad, §8). A projektmemória-manifeszt nem használhatja ezt az active/current állapotgépet.

A `salience` nem betanított-szabály verziómező: az atomi `MemoryChunk` projektmemória-elemek retrieval-rangsorolásához tartozik. A két fogalom összekeverése azt a téves benyomást keltené, hogy a kötelező működési szabályok közül a runtime csak néhány relevánsat alkalmazhat.

### 3.3 `training_tickets` — a write-gate horgony (a `tickets` 1:1 kiterjesztése)

```
ticket_id            uuid pk (fk tickets, type='training')
current_revision_id  uuid (nullable)           -- az egyetlen jóváhagyható javaslat-revízió
eval_result          jsonb (nullable)         -- { passed: bool, score, baseline, suite_version, runs }
eval_required        bool                     -- a self_evolution_profile alapján számolva
origin               enum: human | reflection -- ki kezdeményezte (reflexió → §4.6.3)
scope_class          enum: memory | behavior | role  -- mit érint (a profil scope-ja ellen ellenőrizve)
created_at           timestamptz
```

> A `tickets` közös mezői (state, assignee, agent_id, payload, conversation_id) a ConversationSession/Playbook spec szerint; a `type='training'` ticket csak a fenti kiterjesztést kapja. A modell kizárólag javaslatszöveget adhat a platformnak, amelyből a platform javaslat-revíziót épít — közvetlen memória-írás nincs.

### 3.4 `memory_eval_suites` — regressziós tesztkészlet (eval-kapu)

```
id            uuid pk
tenant_id     uuid
agent_id      uuid (fk agents, nullable)      -- NULL = tenant-szintű alap-suite
version       int
cases_ref     text                            -- { input, expected/rubric } esetek (GCS)
baseline_score numeric (nullable)             -- az aktuális aktív verzió referencia-pontszáma
created_at    timestamptz
```

Az eval-suite **adat, nem kód**: a Control Plane-ben karbantartható. Az eval-futás a Model Gateway-en át hív modellt (a frissített memória-verzióval), és a `passed = score >= baseline - tolerancia` szabály dönt (a tolerancia tenant-konfig).

### 3.5 Önfejlesztési profil (hivatkozott, nem itt definiált)

A `self_evolution_profile` az `agents` tábla `jsonb` mezője (Agent Registry spec §3.6):

```
{ scope: ["memory" | "behavior" | "role"],
  durable_memory_approval_policy: {
    activation_mode: "approver_required" | "operator_can_activate",
    four_eyes_required: boolean
  },
  approval_mode: "human" | "higher_role" | "eval_only" | "auto_after_eval",
  diff_limit: { max_chars, max_items, max_salience } }
-- NULL = legszigorúbb (approver_required, four_eyes_required=true, human, scope=[memory])
```

Ez a spec a profilt **olvassa és kikényszeríti** (§8), nem írja. A NULL-default mindig a legszigorúbb értelmezés. A `durable_memory_approval_policy` közös agent-szintű szabály a user által kezdeményezett **betanított működési szabály** aktiválására és a **projektmemória-javaslat** elfogadására. A két memória UI-ja és verziólánca ettől még külön marad. A régi, általános `approval_mode` az agent-/rendszer-kezdeményezett önfejlesztési és eval-automatizmusokat vezérli; user-kezdeményezett tartós memóriaírásnál nem írhatja felül a `durable_memory_approval_policy` értékét. A KB-publikálás, rollback, hard delete és capability-változtatás külön jogosultsági folyamat marad.

### 3.6 `training_proposal_revisions` — a ticketen belüli javaslattörténet

Egy tanítási ticket egy készülő következő szabályverzió jóváhagyási folyamata. A ticketen belül minden operátori pontosítás új, immutábilis revízió:

```
id                    uuid pk
training_ticket_id    uuid fk
revision              int                       -- monoton a ticketen belül
base_version_id       uuid                      -- melyik aktív szabályverzióból készült
proposed_version_ref  text                      -- a teljes javasolt új szabályverzió
change_summary        jsonb                     -- közérthető: mi marad, mi változik, mi szűnik meg
impact_result         jsonb                     -- ütközések, regressziós/eval eredmény, figyelmeztetések
composition_mode      enum: build_on_pending | replace_pending
status                enum: current | superseded
target_memory_version int                       -- melyik következő instruction-verzió készül
write_gate_token_ref  text (nullable)           -- csak hash/referencia; nyers token soha
token_status          enum: unissued | issued | consumed | expired | revoked
token_expires_at      timestamptz (nullable)
created_by            uuid
created_at            timestamptz
```

**Invariáns:** ticketenként pontosan egy `current` revízió lehet. A régi revízió megmarad audit- és összehasonlítási célra, de token nem állítható ki rá és nem aktiválható.

---

## 4. Write-gate token protokoll és állapotgép

A koncepció §4.6.1 és a Roadmap §5.8 pontosan rögzíti a protokollt; itt formalizáljuk állapotgéppé és invariánsokká.

### 4.1 A tanítási ticket állapotgépe

```
                                       eval_required && !passed
                                      ┌───────────────────────────┐
                                      ▼                           │
  [proposed] ──submit──► [pending_approval] ──(eval)──► [eval_failed] ──► [rejected]
       │                       │                                          ▲
       │ reject                │ approve (RBAC + training policy szerint)  │ reject
       ▼                       ▼                                          │
  [rejected]            [approved] ──platform ír a tokennel──► [written] ─┘ (sikertelen írás)
                                                                  │
                                                                  ▼
                                                              [active]  (current_version_id frissül)

  [active] ──rollbackMemory(toVersion)──► a korábbi verzió újra [active], a leváltott [rolled_back]
```

**Minden átmenet:** RBAC-kapuzott (`requireRole`), append-only auditba ír, és a `token_status`-t lépteti. A manuális tanítás `pending_approval → approved` kapu erőssége az érintett agent `durable_memory_approval_policy` mezőjéből jön (§4.5); `operator_can_activate` esetén az operator előnézetből közvetlenül az `approved → written → active` útvonalra léphet. `four_eyes_required=true` esetén az aktiváló user nem lehet a jelenlegi javaslat-revízió kezdeményezője. Az általános `approval_mode` csak az agent-/rendszer-kezdeményezett önfejlesztési ág kapuerősségét vezérli (§8.1).

### 4.2 A token életciklusa (kemény invariánsok)

1. **Kiállítás** csak a legutolsó javaslat-revízió review-ra rögzítésekor vagy közvetlen aktiválásakor: a platform **maga generál** egy egyedi, egyszer használatos, HMAC-aláírt tokent szerveroldali kulccsal. A token **az adott `ticket_id`-re, a `proposal_revision_id`-re, a `base_version_id`-re ÉS a `target_memory_version`-re van kötve**. Új revízió a korábbi revízióhoz kiállított tokent azonnal visszavonja; puszta ticket-létrehozás még nem állít ki írható tokent.
2. **Tárolás:** a legutolsó `training_proposal_revisions.write_gate_token_ref` **csak hash-t/referenciát** tárol — a nyers token sosem perszisztált és **sosem hagyja el a szervert**. Az agent/Goose **nem birtokolja, nem látja, nem adja tovább**.
3. **Felhasználás:** a memória-író szolgáltatás **kizárólag** érvényes, nem lejárt, nem felhasznált, a cél-verzióra kötött tokent fogad el. Hibás/lejárt/`consumed`/`revoked` token → **nem ír**, `memory.write_denied` audit-esemény.
4. **A modell csak javasol:** a `proposed_diff` az egyetlen, amit a modell ad; a tényleges írást a platform végzi a jóváhagyás után. **Nincs olyan kódút, amelyen a modell kimenete tokenhez jutna.**
5. **Sikeres írás:** új `memory_versions` (`status: active`), a régi `active` lezárul, a `current_version_id` átáll, a token `consumed`, és `memory.update` audit (diff + jóváhagyó + verzió).

### 4.3 Miért nem hamisítható / nem ismételhető

A garancia három, egymástól független pillérre épül: (a) a token **szerveroldalon marad** (nem csalható ki promptból), (b) **ticket+revízió+alapverzió+célverzió-kötött** (más kontextusban érvénytelen, így nem replay-elhető), (c) **egyszer használatos** (a `consumed` után újra nem játszható). Ez a háromszoros zár az, ami a tanulást *nem hamisíthatóvá* teszi — pontosan az a bizonyíték, amit egy szabályozott (bank/PSP) ügyfél elvár (§8.1).

### 4.4 Teljes javasolt verzió, egy nyitott ticket és revíziók

1. **Egy aktív betanított-szabály verzió:** például `v3`.
2. **Agentenként legfeljebb egy nyitott tanítási ticket:** ez a készülő `v4` jóváhagyási folyamata.
3. **Új tanítás nyitott ticket mellett:** a user két, közérthető lehetőséget kap:
   - **„Beépítem a meglévő javaslatba”** — a jelenlegi javasolt `v4` + az új tanítás alapján készül új revízió;
   - **„Lecserélem a meglévő javaslatot”** — az aktív `v3` + csak az új tanítás alapján készül új revízió.
4. **Nem keletkezik `v5`, amíg `v4` nem aktív:** a ticket revíziói `v4/r1`, `v4/r2`, …; a jóváhagyott aktuális revízió válik `v4`-gyé.
5. **Csak a teljes végállapot hagyható jóvá:** a ticket a teljes javasolt szabályverziót, az érintett régi szabályokat és a hatásösszefoglalót mutatja.
6. **Csak a legutolsó revízió aktiválható:** új revízió minden korábbi review-t/jóváhagyást érvénytelenít. Elavult böngészőnézetből érkező aktiválás szerveroldalon elutasítandó.
7. **Optimista konkurenciavédelem:** aktiváláskor `base_version_id` kötelezően egyezzen az aktuális aktív szabályverzióval. Eltéréskor a javaslatot újra kell állítani és ismét át kell nézni; csendes újraalapozás és felülírás tilos.
8. **Több operátor:** tanítás-javaslati joggal bárki ráépíthet a függő javaslatra. Saját javaslatát a kezdeményező lecserélheti; más kezdeményező javaslatát lecserélni vagy visszavonni csak approver/admin tudja. Minden ilyen művelet új revízió és audit-esemény.

#### 4.4.1 Az impact preview legyen döntéstámogatás, ne második jóváhagyó

Az ellenőrző elem az aktív teljes szabályverzióhoz — „Beépítem” esetén a függő javaslathoz is — illeszti az új tanítást, majd három, üzleti nyelvű csoportot ad vissza:

| Eredmény | Mit lát a user? | Következmény |
|---|---|---|
| **Kiegészíti** | milyen új szabály kerül be, a meglévők változtatása nélkül | információ; folytatható |
| **Megváltoztatja** | mely régi szabályok íródnak át vagy szűnnek meg, és mi lesz helyettük | figyelmeztetés és explicit átnézés; önmagában nem tiltás |
| **Nem engedhető meg** | pl. jogosultság-, capability- vagy tenant-határ módosítása | blokkolás, konkrét indokkal és következő lépéssel |

A szemantikus ütközés felismerése **nem önálló igazságdöntés**: a rendszer megmutatja, hogyan oldotta fel az ellentmondást a javasolt teljes verzióban, de az operator/approver dönt arról, ez tükrözi-e a kívánt működést. Hard policy-sértést viszont a platform determinisztikusan blokkol. Az alapnézet csak az érintett szabályokat és a „mi lesz helyette” összefoglalót mutatja; a teljes javasolt verzió egy „Teljes új verzió megtekintése” részben nyitható le.

### 4.5 Agent-szintű tartós memória-jóváhagyás és négy szem elv

Az agent `durable_memory_approval_policy` beállítása a user által kezdeményezett betanított-szabály és projektmemória-változások közös jóváhagyási küszöbe. Az aktiválási mód kétértékű, hogy az admin és a user számára egyértelmű maradjon:

| Mód | Operator | Approver/Admin | Ticket viselkedése |
|---|---|---|---|
| `approver_required` | összeállíthatja és jóváhagyásra küldheti a legújabb javaslatot, de nem aktiválhatja | átnézheti és aktiválhatja | `awaiting_human`, majd jóváhagyás után `done` |
| `operator_can_activate` | az előnézet után maga is aktiválhatja | szintén aktiválhatja | nincs várakozó approval; az auditált tanítási rekord/ticket közvetlenül `done` állapotba jut |

Szabályok:

- Default és hiányzó érték: `approver_required`.
- A `four_eyes_required` külön agent-szintű szabály. Ha igaz, a jóváhagyó személyazonosítója nem egyezhet a legutolsó javaslat-revízió `created_by` értékével; az approver szerep önmagában nem enged önjóváhagyást.
- A `four_eyes_required=true` és az `operator_can_activate` együtt érvénytelen konfiguráció. A UI nem kínálhatja fel ezt a kombinációt, a backend pedig elutasítja; a négy szem elv bekapcsolása `approver_required` aktiválási módot feltételez.
- A beállítást csak admin módosíthatja, és a módosítás auditált.
- A mód **nem ad tenant-hozzáférést és nem emel szerepet**. Az operator csak olyan agentet taníthat, amelyhez eleve hozzáfér, és rendelkezik tanítás-javaslati joggal.
- Az `operator_can_activate` UX-rövidítés: ugyanaz a teljes verziózás, impact check, write-gate, audit és rollback fut, mint approveres aktiválásnál.
- Ugyanez a policy dönt a user által elfogadott projektmemória-javaslatokról is, de a projektmemória külön felületen, külön adatokkal és külön verzióláncban marad.
- Rollback, végleges törlés, capability-/connector-/RBAC-változtatás nem lazítható ezzel a beállítással; ezek külön adminisztratív jogot igényelnek.
- Az aktiválás pillanatában az aktuális agent-beállítás és az aktuális user-jogosultság dönt; korábban megnyitott képernyő vagy ticket nem őriz meg lazább jogosultságot.

### 4.6 Jogosultságalapú, közérthető tanítási UI

A UI a szerveroldali policy döntésének vetülete, nem önálló biztonsági kapu. A backend minden műveletet újraengedélyez; a gomb elrejtése önmagában nem védelem.

| User helyzete | Látható elsődleges művelet |
|---|---|
| nincs tanítás-javaslati joga | nincs szerkesztő vagy változtatási gomb; olvasási jog esetén csak aktuális tudás és státusz |
| operator + `approver_required` | „Megnézem, mit változtat” → „Jóváhagyásra küldöm” |
| operator + `operator_can_activate` | „Megnézem, mit változtat” → „Aktiválom az új verziót” |
| approver/admin + függő javaslat | „Jóváhagyom és aktiválom” + „Visszaküldöm” |
| approver/admin + saját javaslat + négy szem elv | nincs jóváhagyó gomb; „Másik jóváhagyóra vár” státusz |
| admin | a fentieken túl agent-szintű jóváhagyási mód beállítása; külön jogosultsággal rollback/törlés |

UX-követelmények:

- Csak használható akciógomb jelenjen meg; jogosultság hiányában ne legyen megtévesztő, folyton disabled gomb.
- A státusz és a következő lépés akkor is látszódjon, ha a user nem cselekedhet: pl. „Approver jóváhagyására vár”.
- Feliratok üzleti nyelven jelenjenek meg; `write-gate`, tokenazonosító, diff-hash és nyers állapotkód nem elsődleges UI-szöveg.
- Minden aktiválás előtt ugyanaz a teljes új verzió és közérthető változásösszefoglaló legyen látható.
- Függő javaslatnál a „Beépítem” / „Lecserélem” választás csak tanítás-javaslati joggal jelenjen meg.
- Hibák konkrét következő lépést adjanak: „A javaslat időközben frissült — nézd át a legújabb változatot”, ne belső hibakódot.

---

## 5. A tanítási modul interfésze

A külső seam szándékosan kicsi: a hívónak nem kell ismernie a konfliktuskeresést, a teljesverzió-összeállítást, a revíziózást, az evalt vagy a write-gate tokent. Minden művelet tenant-scoped, RBAC-kapuzott és auditált.

```
getTrainingWorkspace({ agentId })
    -> { activeVersion, pendingProposal?, allowedActions }
    -- az allowedActions a szerveroldali RBAC + agent policy kész eredménye;
    --   a UI ebből renderel, nem maga találja ki a gombokat
    [viewer+]

previewTrainingChange({ agentId, instruction, compositionMode? })
    -> { previewId, baseVersionId, proposedVersion, changeSummary, impactResult }
    -- mellékhatásmentes előnézet; nyitott javaslatnál compositionMode kötelező
    [operator+]

submitTrainingProposal({ previewId })
    -> { ticket, currentRevision }
    -- új ticketet vagy a meglévő ticket új revízióját rögzíti;
    --   approver_required esetén awaiting_human, operator_can_activate esetén még aktiválható
    [operator+]

runMemoryEval({ ticketId })
    -> { passed, score, baseline, suiteVersion }
    -- a legutolsó teljes javaslat-revízióval futtatja a suite-ot; eval_result-ba ír
    [operator+]   (eval_required && approval_mode∈{eval_only,auto_after_eval} esetén kötelező)

activateTraining({ ticketId, revisionId })
    -> { memoryVersion }
    -- ellenőrzi: legújabb revízió, friss alapverzió, RBAC + durable memory policy,
    --   four_eyes_required esetén actor != revision.created_by,
    --   scope ⊆ profil.scope, diff ≤ profil.diff_limit,
    --   (ha eval_required) eval passed; majd a PLATFORM ír a tokennel -> új active verzió
    [operator+ vagy approver+]   (`durable_memory_approval_policy` + RBAC metszete szerint)

rejectTraining({ ticketId, reason })
    -> void
    -- a token revoked, a ticket rejected, audit
    [approver+]

rollbackMemory({ agentId, toVersion })
    -> { memoryVersion }
    -- a current_version visszaáll egy korábbi active verzióra; a leváltott rolled_back; audit
    [approver+]

getInstructionTimeline({ agentId })
    -> [{ version, status, source, approvedBy, createdAt, diffSummary }]
    [viewer+]
```

Az implementáció a mai `createTrainingTicket` / `approveTraining` műveleteket átmeneti adapterként megtarthatja, de a UI és az új tesztek a fenti, mélyebb modul interfészén menjenek át.

**Hard guardok az `activateTraining`-ben (sorrendben, bármelyik bukás → `write_denied` + reject):**
`requireActivationRight(durable_memory_approval_policy, actor)` → `four_eyes_required ? actor.id != revision.created_by` → `latest_revision` → `base_version_id == current_version_id` → `scope_class ⊆ profile.scope` → `diff ≤ profile.diff_limit` → `eval_required ? eval.passed` → **kemény padló:** a diff **nem érint** jogosultságot/eszköz-hozzáférést (§8.3) → token érvényes és cél-verzióra kötött → platform ír.

---

## 6. Olvasás és runtime kontextus-összeállítás

A runtime három külön tartós forrást állít egymás mellé; ezek olvasása **tisztán olvasás**, nem érinti a write-gate-et:

1. **Betanított működési szabályok:** a teljes aktív instruction-verzió stabil rendszerutasításként mindig bekerül. Ezek nem relevanciafüggő tények, hanem kötelező munkavégzési szabályok; retrieval nem rejtheti el őket.
2. **Projektmemória:** az aktuális tenant+agent+projekt scope-ból a `MemoryStore` interfész mögötti retrieval ad `project_state` nézetet és top-K atomi chunkot. Ez a `agent-memory-persistent-cross-conversation-spec.md` kanonikus olvasási útja.
3. **Tudástár:** külön `kb_search` útvonalon, dokumentum- és forráshivatkozási szerződéssel olvasódik. Nem kerül be a betanított szabályverzióba.

**Projektmemória retrieval skálázása:** a jelenlegi kulcsszavas keresés később hibrid kereséssé bővíthető, ha a memória mérete vagy ügyfélkérés indokolja:

1. **Kulcsszavas full-text** (Postgres FTS) — pontos a konkrét terminusokra (azonosító, fájlnév, döntéscímke).
2. **Vektor- / szemantikus keresés lokális embeddinggel** — a hasonló jelentésű projektmemóriát is megtalálja. A számítás a Tool Brokeren át, explicit eszközjoggal és naplózva fut.
3. **Hibrid összefűzés Reciprocal Rank Fusion-nal (RRF)** — a kulcsszavas és szemantikus találati listát egy rangsorba olvasztja.
4. **Salience + recency:** az atomi projektmemória-elemek fontossága és frissessége befolyásolja a rangsort, de automatikusan nem törli őket.

**Auditálhatóság:** futásonként visszakereshető a betanított szabályverzió azonosítója, a projektmemóriából visszaadott chunkok/manifeszt és a felhasznált KB-találatok. Így nemcsak az látszik, mely verziók voltak érvényesek, hanem az is, mely tartós forrásból mi került ténylegesen a kontextusba.

---

## 7. Reflexiós feeder — governance-konform „öntanulás" (Fázis 2)

A marveen automatikus öntanulása (auto-skill generálás) nálunk **közvetlen formában tilos** — jóváhagyás nélkül változtatná az agentet. A *mechanizmust* átvesszük, de a write-gate **elé** kötjük javaslat-generátorként (§4.6.3).

1. **Reflexiós trigger** — determinisztikus, **eseményhez kötött** (nem pollozó), ticketenként legfeljebb egyszer: a ticket-futás végén (vagy a Goose-session lezárásakor) egy feltétel dönt, érdemes-e reflexióra — pl. szokatlanul sok eszközhívás, hiba utáni sikeres recovery, felhasználói korrekció, ismétlődő minta.
2. **Javaslat, nem írás** — a reflexió kimenete **kizárólag** egy javasolt tudásfrissítés (diff), amely **automatikusan `createTrainingTicket(..., origin='reflection')`-t hív**. Semmi nem íródik a memóriába ezen a ponton.
3. **A meglévő kapu fut tovább** — innen a §4 write-gate folyamata megy: jóváhagyási lánc → opcionális eval → verzió-promóció a platform tokenjével → rollback-lehetőség. A kapu erősségét az érintett agent `self_evolution_profile`-ja adja (§8).

| | marveen | A mi modellünk |
|---|---|---|
| Mit csinál a reflexió | közvetlenül megírja/patcheli a skillt | tanítási ticketet **javasol** |
| Mikor lép életbe | azonnal, automatikusan | csak **jóváhagyás után** |
| Visszavonható | nincs explicit rollback | **verziózott + rollback** |
| Auditnyom | nincs | minden javaslat és döntés naplózott |

---

## 8. Önfejlesztési profil — enforcement és a kemény padló

A write-gate **minden agentre érvényes**; a kapu *erőssége* per-agent állítható (`self_evolution_profile`), de sosem kapcsolható ki. Ez teszi lehetővé, hogy szigorúan őrzött (pl. könyvelő) és szabadabban tanuló (pl. belső asszisztens) agentek **azonos write-gate-tel, eltérő profillal** együtt éljenek.

### 8.1 A profil tárcsái (az `activateTraining`, ma adapterként az `approveTraining`, érvényesíti)

- **Scope (mit módosíthat magán):** `memory` / `+ behavior` / `+ role`. A tágabb scope erősebb kaput indokol. A `scope_class` a tárolt profil `scope`-ja ellen ellenőrződik — kívül eső scope → reject.
- **Tartós memória aktiválása:** `approver_required` / `operator_can_activate`. A user által kezdeményezett betanított-szabály és projektmemória-változások közös küszöbe (§4.5); nem egyesíti a két memória tartalmát vagy verzióláncát.
- **Négy szem elv:** `four_eyes_required`. Bekapcsolva a legutolsó javaslat-revízió kezdeményezője saját approver jogosultságával sem aktiválhat; külön személy szükséges.
- **Approval mode (a tárcsa „laza" vége):** `human` (ember kötelező) / `higher_role` (magasabb jogú szerep elég) / `eval_only` (eval-kapu elég) / `auto_after_eval` (eval után automatikus promóció). Minden módban **fut a verziózás és az audit**; `eval_only` és `auto_after_eval` esetén az eval **kötelező**.
- **Diff-limit (hatókör-limit):** `max_chars` / `max_items` / `max_salience` — mekkora és milyen tömegű/súlyú tudás érinthető egy ciklusban. Túllépés → reject.

### 8.2 Mindig fix, nem konfigurálható ki

Verziózás + rollback + teljes audit, valamint a platform kezében maradó, szerveroldali, egyszer használatos write-token — **minden módban kötelező**. A `NULL` profil = legszigorúbb (`approver_required`, `four_eyes_required=true`, `human`, `scope=[memory]`).

### 8.3 Kemény padló (privilege-escalation kizárása)

Egy agent **önmódosítással soha nem bővítheti** a saját jogosultságait vagy eszköz-hozzáférését (Tool Broker capability, RBAC, scoped kulcsok). Az önfejlesztés **tudáshoz és viselkedéshez** nyúlhat, **hatáskörhöz nem** — a jogosultság-bővítés kizárólag emberi adminisztratív aktus a Control Plane-ben (Agent Registry). Az `activateTraining` ezért **kódszinten** ellenőrzi: ha a javasolt változás capability-t / RBAC-szerepet / kulcs-scope-ot érintene, **azonnali reject** (`write_denied`), függetlenül a profiltól. Ez zárja ki az OWASP LLM06 (Excessive Agency) kockázatot, és ez különbözteti meg a „könnyített tanulást" a „kontrollálatlan önfejlesztéstől": *a tudás tárcsázható, a hatáskör nem*.

---

## 9. Biztonsági invariánsok és audit

| # | Invariáns | Kikényszerítés |
|---|---|---|
| I1 | Memóriába csak a platform ír, szerveroldali tokennel | a memória-író szolgáltatás csak érvényes tokent fogad; nincs kódút az agenttől tokenig |
| I2 | A token soha nem hagyja el a szervert | nyers token nem perszisztált (`write_gate_token_ref` = hash); nem kerül promptba/válaszba |
| I3 | Külső prompt („tanuld meg…") nem ír memóriát | minden írás `type='training'` tickethez + jóváhagyáshoz kötött (negatív teszt T1) |
| I4 | Minden frissítés diff + verzió + rollback | append-only `memory_versions`; `rollbackMemory` bármely korábbi verzióra |
| I5 | Önmódosítás nem bővít jogosultságot | `activateTraining` kemény-padló guard (§8.3); negatív teszt T4 |
| I6 | Retrieval nem érinti az írást, de naplózott | `MemoryStore` read-path külön; `memory.retrieval` audit-esemény |
| I7 | Working memory ≠ tartós memória | a session-memória a futás végén eldobódik; átkerülés csak tanítási ticketként |
| I8 | Tenant-izoláció | minden tábla `tenant_id`-scoped; cross-tenant olvasás/írás tiltott |
| I9 | Csak a legújabb javaslat-revízió aktiválható | ticketenként egy `current` revízió; régi revízió tokenkiállítása és aktiválása tiltott |
| I10 | Elavult alapverzió nem írható felül | aktiváláskori `base_version_id == current_version_id` compare-and-set |
| I11 | Agent-beállítás nem teremt jogosultságot | aktiválás csak RBAC + agent `durable_memory_approval_policy` metszetével |
| I12 | UI-gombkészlet a szerverpolicy vetülete | backend authz minden akción; kliens csak az engedett műveleteket rendereli |
| I13 | A memóriafajták verziólánca nem írja felül egymást | betanított szabályverzió és projektmemória-manifeszt külön logikai current/version chain |
| I14 | Négy szem elvnél nincs önjóváhagyás | ha `four_eyes_required`, akkor `activated_by != current_revision.created_by` |

**Audit-események** (append-only, `verifyChain()`-be láncolt): `memory.update`, `memory.rollback`, `memory.write_denied`, `training.proposed`, `training.approved`, `training.rejected`, `training.eval`, `memory.retrieval`. Minden esemény hordozza a `tenant_id`-t, az `agent_version`-t, a memória-verziót, a döntéshozót és a diff-összefoglalót. **GDPR:** a `content_ref` mögötti tartalom célzottan törölhető (jogszerű kérésre), de a metaadat-lánc és a hash-ek épek maradnak — `verifyChain()` törlés után is zöld (§8.5).

---

## 10. Tesztek (kötelező negatív tesztek)

| ID | Teszt | Elvárt eredmény |
|---|---|---|
| T1 | Külső beszélgetés/prompt arra utasít: „tanuld meg, hogy X" | **Nem** íródik memória; legfeljebb tanítási ticket-javaslat keletkezhet, ami a kapun megy át |
| T2 | Replay: egy már `consumed` write-gate token újrahasználata | Elutasítva, `memory.write_denied` |
| T3 | Token egy másik (nem a `target_memory_version`) verzión | Elutasítva (verzió-kötés), `write_denied` |
| T4 | `proposed_diff` capability-/RBAC-/kulcs-scope bővítést tartalmaz | Azonnali reject a kemény padlónál, profiltól függetlenül |
| T5 | `scope_class='role'`, de a profil `scope=[memory]` | Reject (scope-túllépés) |
| T6 | Diff meghaladja a `diff_limit`-et | Reject (hatókör-limit) |
| T7 | `eval_only` mód, az eval **bukik** | A promóció elmarad, ticket `eval_failed → rejected` |
| T8 | `rollbackMemory` egy korábbi verzióra | A `current_version_id` visszaáll, a leváltott `rolled_back`, audit ép |
| T9 | Reflexiós trigger (Fázis 2) | Tanítási ticket keletkezik (`origin='reflection'`), **közvetlen írás nincs** |
| T10 | Retrieval egy ticket-futásnál | A behúzott memória-verzió(k) és -elemek visszakereshetők az auditból |
| T11 | Cross-tenant: A tenant agentje B memóriáját olvasná/írná | Elutasítva (tenant-izoláció) |
| T12 | GDPR-tartalomtörlés egy verzió `content_ref`-jén | Tartalom törölve, `verifyChain()` zöld marad |
| T13 | Operator tanít `approver_required` agentet | Javaslat létrejön és `awaiting_human`; operator direkt aktiválási kérése szerveroldalon tiltott |
| T14 | Operator tanít `operator_can_activate` agentet | Impact preview után ugyanazon write-gate útvonalon aktiválhat; audit és rollback-verzió létrejön |
| T15 | Viewer megnyitja a Tanítás UI-t | Csak olvasható állapot; szerkesztő/aktiváló/rollback gomb nincs, direkt action-hívás tiltott |
| T16 | Új tanítás érkezik nyitott `v4/r1` mellett „Beépítem” választással | `v4/r2` a függő javaslat + új tanítás teljes végállapota; `r1` superseded |
| T17 | Új tanítás érkezik nyitott `v4/r1` mellett „Lecserélem” választással | `v4/r2` az aktív `v3` + új tanítás alapján készül; `r1` superseded |
| T18 | Approver régi böngészőnézetből `v4/r1`-et aktiválna | Elutasítva mint elavult revízió; a legújabb `r2` új review-t igényel |
| T19 | A ticket alapja `v3`, de közben `v4` aktívvá vált más úton | Aktiválás elutasítva; újraösszeállítás és új review szükséges, csendes felülírás nincs |
| T20 | Projektmemória-manifeszt frissül | A betanított működési szabályok aktív verziója és current pointere változatlan marad |
| T21 | Approver a saját javaslatát aktiválná `four_eyes_required=true` agentnél | Szerveroldalon elutasítva; „Másik jóváhagyóra vár” státusz; a javaslat függőben marad |
| T22 | Másik approver aktiválja ugyanazt a javaslatot | Sikeres aktiválás, mindkét személy az auditban |
| T23 | User projektmemória-javaslatot fogadna el | Ugyanaz a `durable_memory_approval_policy` dönt, de csak a projektmemória-manifeszt kap új verziót |

---

## 11. Fázisolás és nyitott kérdések

**Meglévő alap:** `memories` / `memory_versions` / `training_tickets` séma; write-gate token protokoll; `createTrainingTicket` / `approveTraining` / `rollbackMemory`; betanított szabályblokk + projektmemória-retrieval runtime-bekötés; `memory.update` / `rollback` / `write_denied` audit; önfejlesztési-profil olvasás + kemény padló.

**v1.1 kötelező implementáció:** tanítási impact preview; teljes javasolt instruction-verzió; ticketen belüli revíziók; egy nyitott ticket/agent; közös `durable_memory_approval_policy` négy szem opcióval; policy-alapú gombkészlet; legújabb revízió + base-version compare-and-set; betanított szabályverzió és projektmemória-manifeszt külön logikai version/current chain.

**Fázis 2:** (a) **hibrid retrieval** (FTS + lokális embedding + RRF + salience/decay) — csak ha a tudásbázis mérete vagy ügyfélkérés indokolja (§4.6.2, §10.B); (b) **reflexiós feeder** (§4.6.3, Roadmap D5) — a write-gate enélkül is teljes, ezért nem MVP; (c) **`auto_after_eval` mód éles használata** — eval-suite-érettséget feltételez.

**Rögzített termékdöntések:** (a) a négy szem elv agent-szintű, és tiltja a saját javaslat jóváhagyását; (b) a user által kezdeményezett betanított-szabály és projektmemória-változások közös agent-szintű jóváhagyási policyból élnek, miközben tartalmuk és verzióláncuk külön marad; (c) függő javaslatra minden javaslati jogú user ráépíthet, de más javaslatát csak approver/admin cserélheti le vagy vonhatja vissza; (d) a két tartós memória külön current/version chain, ezért egyik frissítése és rollbackje sem módosítja a másikat. A fizikai megvalósítás lehet külön tábla vagy explicit típussal szeparált tárolás, de ezt az invariánst mindkettőnek garantálnia kell.

**Nyitott kérdések (validálandó):**
1. **Eval-tolerancia és suite-karbantartás:** mekkora pontszám-csökkenés még elfogadható, és ki gondozza a suite-okat? (ügyfél-specifikus; alap-tolerancia tenant-konfig)
2. **Salience-decay paraméterezése:** a decay-ütem és a „soha nem törlődik automatikusan" határa — Fázis 2, a tudásbázis méretével együtt szabandó.
3. **Lokális embedding-modell választása és hostingja:** csak a projektmemória/KB retrieval konkrét skálázási igényénél; a betanított működési szabályok ettől függetlenül mindig teljes egészükben kerülnek a kontextusba.
4. **Reflexiós trigger-feltételek hangolása:** túl gyakori reflexió = ticket-zaj; a determinisztikus feltételek küszöbei pilot-adatból kalibrálandók.

---

*Forrás és ellenőrzés: a dokumentum a `AI-Agent-Platform-Koncepcio.md` (§4.6–4.6.4, §8.1) és a `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (§4.4, §5.8, §5.11, §5.12.2, §11) alapján készült, és illeszkedik az Agent Registry / Model Gateway / ConversationSession / Per-user Connector feature-specekhez. Utolsó termék- és kódellenőrzés: 2026-08-25.*
