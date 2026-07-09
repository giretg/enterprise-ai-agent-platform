# Feature-spec — Tanítás, memória, write-gate és önfejlesztési pipeline

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-30
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (§4.6 tanítás és memória, §4.6.1 write-gate / aláírt token, §4.6.2 retrieval / hibrid keresés — elhalasztott, §4.6.3 reflexiós feeder, §4.6.4 önfejlesztési profil, §4.5 reprodukálhatóság, §4.13/4.14 `MemoryStore` cserepont és session-elhatárolás, §8.1 memória mint legnagyobb kockázat és érték, §8.2 prompt injection, §8.5 append-only audit), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (v1.0, §4.4 `memories`/`memory_versions`/`training_tickets` séma, §5.8 write-gate token protokoll + API, §5.11 `MemoryStore` interfész, §5.12.2 önfejlesztési profil, §11 audit-események), `AI-Agent-Platform-Feature-Spec-AgentRegistry.md` (v1.0, `self_evolution_profile`, `current_memory_version`, kemény padló), `AI-Agent-Platform-Feature-Spec-ModelGateway.md` (eval-futás modellhívásai), `AI-Agent-Platform-Feature-Spec-ConversationSession.md` (working memory ≠ tartós memória), `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md` (embedding-hívás a Tool Brokeren át)
**Olvasó:** fejlesztő(k). Feltételezi az append-only audit (`verifyChain`), az RBAC (`requireRole`), a Tool Broker capability-modell (`authorize()`), a Model Gateway routing és az Agent Registry (`agent_versions`, `self_evolution_profile`) ismeretét.
**Státusz:** **MVP-horgok kész, teljes pipeline részben Fázis 2.** A `memories` / `memory_versions` / `training_tickets` séma, a write-gate token protokoll (`createTrainingTicket` / `approveTraining` / `rollbackMemory`) és a teljes-beinjektálásos retrieval az MVP-ben **be van kötve** (Roadmap §4.4, §5.8). Ez a dokumentum a **teljes** tanítási-memória réteget specifikálja: a memória-verziózás állapotgépét, a write-gate token életciklusát kapuról kapura, a retrieval kétfázisú kiépítését (teljes beinjektálás → hibrid keresés salience-szel), a reflexiós feedert mint javaslat-generátort, és az önfejlesztési profil end-to-end kikényszerítését a kemény padlóval. A reflexiós feeder (§4.6.3 / Roadmap D5) és a hibrid retrieval (§4.6.2) **Fázis 2** — itt specifikáltan, de horgokkal előkészítve.

---

## 0. Mit ad ez a dokumentum

Meghatározza, hogyan „tanul" egy agent a platformon — vagyis hogyan íródik, olvasódik, verziózódik és görgethető vissza a **tartós tudása (memóriája)** úgy, hogy a koncepció központi ígérete sértetlen marad: *„az AI nálunk nem driftel el észrevétlenül"* (§8.1). A tanítás a platform **legérzékenyebb és legértékesebb** mechanizmusa: ha bárki, bármikor, kontroll nélkül átírhatná az agent tudását, a rendszer megbízhatatlanná és mérgezhetővé válna (knowledge poisoning). Ezért a tanulás itt nem szabad szöveg-betáplálás, hanem **verziózott, jóváhagyott, visszavonható és teljesen auditált** állapotátmenet.

**A feature öt, élesen elhatárolt invariánsra épül:**

1. **A memóriába kizárólag a platform ír, szerveroldali, aláírt, egyszer használatos tokennel.** Az agent (a modell) legfeljebb *javasol* egy tudásfrissítést (a `proposed_diff` tartalmát); a tényleges írást a platform végzi, miután a javaslat átment a jóváhagyáson. A token **soha nem kerül az agent/Goose birtokába** — különben egy prompt injection kicsalná vagy újrajátszaná (§4.6.1).
2. **Minden tudásfrissítés diff, verzió és rollback.** A memória nem felülíródik, hanem új `memory_versions` rekordra promótálódik; a régi lezárul, de megmarad. Bármely korábbi verzió **bármikor visszaállítható**, és bármely ticket-futásról visszakereshető, *melyik memória-verzió* volt érvényes.
3. **Az írás (write-gate) és az olvasás (retrieval) ortogonális.** A write-gate kizárólag azt szabályozza, *hogyan kerül be új tudás*; a retrieval tisztán olvasás-oldali, és sosem érinti a write-gate-et. A retrieval **maga is naplózott esemény**: visszakereshető, *mely memória-elemeket* húzta be egy futás a kontextusába.
4. **A reflexió javaslat-generátor, nem önmódosítás.** Az agent reflektálhat a munkájára és *javasolhat* tudásfrissítést, de a javaslat **automatikusan tanítási ticketként** a write-gate elé kerül — semmi nem lép életbe jóváhagyás nélkül (§4.6.3).
5. **Az önfejlesztés tárcsa, nem kapcsoló — és van kemény padlója.** A write-gate kapu *erőssége* per-agent állítható (`self_evolution_profile`), de a verziózás + rollback + audit + szerveroldali token **sosem kapcsolható ki**, és egy agent önmódosítással **soha nem bővítheti** a jogosultságait vagy eszköz-hozzáférését (§4.6.4).

**Miért ez a feature a legfontosabb:** a koncepció maga jelöli meg a tanítást/memóriát mint *„a legnagyobb kockázat és a legnagyobb érték"* (§8.1). Ez az a réteg, amely a platform fő differenciátorát — a kontrollált, nem-driftelő, auditálható AI-munkatársat — kódszinten bizonyíthatóvá teszi. Az Agent Registry spec ezt a réteget explicit out-of-scope-ként a *„külön memória / self-evolution spec"-re* utalta (§0.10); ez a dokumentum tölti be azt a helyet.

---

## 1. Scope

### 1.1 In scope (teljes feature)

1. **`memories` + `memory_versions` verziólánc** mint az agent tartós tudásának egyetlen forrása: immutábilis, append-only verziók, `proposed → active → rolled_back` státusszal, diff-fel és szülő-verzió hivatkozással.
2. **`training_tickets` és a write-gate token protokoll** end-to-end: token-kiállítás (HMAC-aláírás, ticket+cél-verzió kötés), szerveroldali tárolás (a nyers token sosem perszisztált), egyszeri felhasználás, lejárat, és a platform-írás kizárólagossága.
3. **Tanítási állapotgép kapukkal:** `proposed → (eval) → approved → written → active` (+ `rejected`, + `rolled_back`), minden átmenet RBAC-kapuzott és auditált; az eval-kapu opcionális, az önfejlesztési profil szerint.
4. **Eval-kapu** mint regressziós védőháló: a frissített memóriájú agent egy rögzített tesztkészleten nem romlik-e; az eredmény (`eval_result`) a tickethez kötve, a promóció feltétele (profiltól függően).
5. **Retrieval (olvasás) kétfázisú kiépítése a `MemoryStore` cserepont mögött:** (a) MVP — **teljes beinjektálás**; (b) skálázódáskor — **hibrid keresés** (FTS5 + lokális embedding + RRF) **salience-súlyozással és decay-jel** (Fázis 2, §4.6.2).
6. **Reflexiós feeder** (§4.6.3, Fázis 2): determinisztikus, eseményhez kötött trigger a ticket-futás végén, amely tudásfrissítés-javaslatot generál és **automatikusan tanítási ticketet nyit** — soha nem ír közvetlenül.
7. **Önfejlesztési profil enforcement** (`self_evolution_profile`): a profil `approval_mode` / `scope` / `diff_limit` mezői a write-gate jóváhagyási útvonalát és hatókörét vezérlik; a **kemény padló** (jogosultság-/eszköz-bővítés tiltása) kódszintű invariáns.
8. **Working / epizodikus memória elhatárolása:** a Goose-session munkamemóriája csak a ticket-futásig él, és **soha nem keveredik** a tartós tudással; átkerülés kizárólag tanítási ticketként (§4.6, §4.14).
9. **Audit és reprodukálhatóság:** minden írás, jóváhagyás, rollback, megtagadott írás és retrieval append-only audit-eseményként; a `verifyChain()` zöld marad GDPR-törlés után is.
10. **Control Plane UI:** tanítási ticket-lista és -detail (diff-nézet, eval-eredmény, jóváhagyás/elutasítás), memória-verzió-idővonal rollback-gombbal, önfejlesztési-profil szerkesztő (az Agent Registry detail-jéből).

### 1.2 Out of scope (most NEM)

- **Az `agents` / `agent_versions` / `self_evolution_profile` séma és UI** — az Agent Registry spec hatóköre. Itt a memória-verziót *hivatkozzuk* (`current_memory_version`) és a profilt *olvassuk*, de nem mi definiáljuk.
- **A Model Gateway routing-logikája** — az eval-futás és a (opcionális) embedding-számítás *modellhívásai* a Gateway-en mennek át, de a routing-döntés a Model Gateway-spec hatóköre (§4.7.1).
- **Az érzékenység-tudatos modellválasztó** (§4.7.2, elhalasztott) — nem érinti a tanítási pipeline-t.
- **A connector-réteg / tudásbázis-betöltés** (`kb_search`, wiki ingestion) — a Per-user Connector és az App Registry spec hatóköre; a retrieval *forrását* hivatkozzuk, de a betöltést nem itt specifikáljuk.
- **A teljes beszélgetés-UI és a ticket-állapotgép általános rétege** — a ConversationSession / Playbook spec; itt csak a `type: training` ticket sajátosságait írjuk le.
- **A lokális embedding-modell hostingja** — Fázis 2, csak konkrét ügyfélkérésnél (§4.6.2, §10.B).

### 1.3 Az MVP-re gyakorolt hatás

A feature **additív, és a kritikus magja már be van kötve.** Az MVP (Roadmap §4.4, §5.8) tartalmazza: a `memories` / `memory_versions` / `training_tickets` táblát tenant-scope-pal, a write-gate token protokollt (HMAC, egyszeri felhasználás, szerveroldali tárolás), a `createTrainingTicket` / `approveTraining` / `rollbackMemory` API-t, a `memory.update` / `memory.rollback` / `memory.write_denied` audit-eseményeket, és a teljes-beinjektálásos retrievalt a `PostgresMemoryStore` mögött. Ez a spec ezeket **kiegészíti** (explicit állapotgép, eval-kapu enforcement, önfejlesztési-profil end-to-end, retrieval skálázási út, reflexiós feeder, UI), **nem írja át**. A meglévő RBAC, audit és Model Gateway változatlanul újrahasznosul. A Fázis 2 elemek (hibrid retrieval, reflexiós feeder) **csak az olvasás-oldalt és a javaslat-generálást** bővítik — a write-gate invariáns mindkettőn változatlanul érvényes.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

```
        ┌──────────────────────────── CONTROL PLANE (1. app) ──────────────────────────────┐
        │                                                                                   │
        │   Agent Registry ──current_memory_version──►┌─────────────────────────────┐       │
        │   (self_evolution_profile)                  │   MEMÓRIA / TANÍTÁS RÉTEG    │       │
        │        │ approval_mode/scope/diff_limit      │  (ez a spec)                │       │
        │        ▼                                     │                             │       │
        │   ┌─────────────────┐   proposed_diff        │  memories                   │       │
        │   │ Reflexiós feeder │──────────────────────►│  memory_versions (lánc)     │       │
        │   │ (F2, determ.)    │   tanítási ticket      │  training_tickets           │       │
        │   └─────────────────┘                        │                             │       │
        │        ▲ trigger a futás végén                │  ┌──── WRITE-GATE ────┐     │       │
        │        │                                      │  │ token kiállítás     │     │       │
        │   ┌────┴───────┐    createTrainingTicket      │  │ (HMAC, 1x, szerver) │     │       │
        │   │ Operátor / │───────────────────────────►  │  │ jóváhagyás + eval   │     │       │
        │   │ Approver   │    approveTraining/rollback   │  │ platform ír         │     │       │
        │   └────────────┘                              │  └─────────┬───────────┘     │       │
        │                                               │            │ MemoryStore     │       │
        │                                               └────────────┼─────────────────┘       │
        │   Append-only AUDIT ◄── memory.update/rollback/write_denied/retrieval                 │
        └───────────────────────────────────────────────┼──────────────────────────────────────┘
                                                         │ retrieval (READ-ONLY, naplózott)
        ┌────────────────────── EXECUTION / SANDBOX PLANE (2. app) ─┼──────────────────────────┐
        │   Goose-session (working memory — efemer, NEM tartós)     ▼                          │
        │   reasoning-loop ──► kontextusba: aktív memory_version (teljes beinjektálás / kb_search)│
        │   a session vége: working memory eldobva; megőrzendő tanulság → tanítási ticket        │
        └───────────────────────────────────────────────────────────────────────────────────────┘
```

**Kulcs-elhatárolás:** az **írás** mindig a Control Plane-ben, a write-gate-en át, emberi/szerep-jóváhagyással történik. Az **olvasás** futásidőben, a `MemoryStore` cserepont mögött, naplózva. A Goose-session **working memory**-ja (a §4.8.3 efemer munkaterülete) szándékosan külön réteg: nem írja a tartós tudást, a végén eldobódik.

---

## 3. Adatmodell

Az MVP-séma (Roadmap §4.4) a magot adja; ez a spec a státusz-enumokat, az eval- és reflexió-horgokat, valamint a salience-mezőket pontosítja. Minden tábla **tenant-scoped** (`tenant_id`), és a verzió-táblák **append-only** (UPDATE csak a `status` lezáró átmeneteire).

### 3.1 `memories` — az agent tudás-gyökere (agentenként egy)

```
id              uuid pk
tenant_id       uuid (fk tenants)            -- tenant-izoláció (§8.8)
agent_id        uuid (fk agents)             -- 1:1 az agenttel
current_version_id  uuid (fk memory_versions, nullable)  -- az AKTÍV verzió mutatója
created_at      timestamptz
```

A `current_version_id` az egyetlen mutált mező — ez vált verziót promóciónál és rollbacknél. Maga a tudás soha nem itt él, hanem a verzió-rekordokban.

### 3.2 `memory_versions` — immutábilis verziólánc

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
salience_index      jsonb (nullable)          -- [F2] elem-szintű fontossági súlyok (retrieval-rangsoroláshoz)
created_at          timestamptz
```

**Invariáns:** egy memóriának egyszerre **pontosan egy** `active` verziója van (a `current_version_id` arra mutat). A `proposed` verzió a jóváhagyásra váró diff anyaga; a `rolled_back` a leváltott (de megőrzött) verzió. Verzió **soha nem törlődik** (kivéve GDPR-célzott tartalom-törlés a `content_ref` mögött — a metaadat-lánc ép marad, §8).

### 3.3 `training_tickets` — a write-gate horgony (a `tickets` 1:1 kiterjesztése)

```
ticket_id            uuid pk (fk tickets, type='training')
proposed_diff        jsonb                    -- a modell/operátor/reflexió JAVASLATA (csak tartalom)
proposed_content_ref text (nullable)          -- a teljes javasolt új tudás (ha nem csak diff)
write_gate_token_ref text                     -- a kiállított token HASH-e/referenciája (nyers token SOHA nem itt)
token_status         enum: issued | consumed | expired | revoked
token_expires_at     timestamptz
eval_result          jsonb (nullable)         -- { passed: bool, score, baseline, suite_version, runs }
eval_required        bool                     -- a self_evolution_profile alapján számolva
target_memory_version int                     -- melyik verzióra köt a token (replay-védelem)
origin               enum: human | reflection -- ki kezdeményezte (reflexió → §4.6.3)
scope_class          enum: memory | behavior | role  -- mit érint (a profil scope-ja ellen ellenőrizve)
created_at           timestamptz
```

> A `tickets` közös mezői (state, assignee, agent_id, payload, conversation_id) a ConversationSession/Playbook spec szerint; a `type='training'` ticket csak a fenti kiterjesztést kapja. A `proposed_diff` az **egyetlen** csatorna, amin a modell tudást javasolhat — közvetlen memória-írás nincs.

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
  approval_mode: "human" | "higher_role" | "eval_only" | "auto_after_eval",
  diff_limit: { max_chars, max_items, max_salience } }
-- NULL = legszigorúbb (human, scope=[memory])
```

Ez a spec a profilt **olvassa és kikényszeríti** (§8), nem írja. A NULL-default mindig a legszigorúbb értelmezés.

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
       │ reject                │ approve (RBAC: approval_mode szerint)     │ reject
       ▼                       ▼                                          │
  [rejected]            [approved] ──platform ír a tokennel──► [written] ─┘ (sikertelen írás)
                                                                  │
                                                                  ▼
                                                              [active]  (current_version_id frissül)

  [active] ──rollbackMemory(toVersion)──► a korábbi verzió újra [active], a leváltott [rolled_back]
```

**Minden átmenet:** RBAC-kapuzott (`requireRole`), append-only auditba ír, és a `token_status`-t lépteti. A `pending_approval → approved` kapu erőssége az érintett agent `self_evolution_profile.approval_mode`-jából jön (§8.2).

### 4.2 A token életciklusa (kemény invariánsok)

1. **Kiállítás** a tanítási ticket létrejöttekor: a platform **maga generál** egy egyedi, egyszer használatos, HMAC-aláírt tokent szerveroldali kulccsal. A token **az adott `ticket_id`-re ÉS a `target_memory_version`-re van kötve** (replay-védelem: másik verzión nem érvényes).
2. **Tárolás:** a `training_tickets.write_gate_token_ref` **csak hash-t/referenciát** tárol — a nyers token sosem perszisztált és **sosem hagyja el a szervert**. Az agent/Goose **nem birtokolja, nem látja, nem adja tovább**.
3. **Felhasználás:** a memória-író szolgáltatás **kizárólag** érvényes, nem lejárt, nem felhasznált, a cél-verzióra kötött tokent fogad el. Hibás/lejárt/`consumed`/`revoked` token → **nem ír**, `memory.write_denied` audit-esemény.
4. **A modell csak javasol:** a `proposed_diff` az egyetlen, amit a modell ad; a tényleges írást a platform végzi a jóváhagyás után. **Nincs olyan kódút, amelyen a modell kimenete tokenhez jutna.**
5. **Sikeres írás:** új `memory_versions` (`status: active`), a régi `active` lezárul, a `current_version_id` átáll, a token `consumed`, és `memory.update` audit (diff + jóváhagyó + verzió).

### 4.3 Miért nem hamisítható / nem ismételhető

A garancia három, egymástól független pillérre épül: (a) a token **szerveroldalon marad** (nem csalható ki promptból), (b) **ticket+verzió-kötött** (más kontextusban érvénytelen, így nem replay-elhető), (c) **egyszer használatos** (a `consumed` után újra nem játszható). Ez a háromszoros zár az, ami a tanulást *nem hamisíthatóvá* teszi — pontosan az a bizonyíték, amit egy szabályozott (bank/PSP) ügyfél elvár (§8.1).

---

## 5. Szolgáltatás-réteg / API

A magot a Roadmap §5.8 rögzíti; itt kiegészítjük az eval- és reflexió-úttal. Minden végpont tenant-scoped, RBAC-kapuzott, auditált.

```
createTrainingTicket({ agentId, proposedContent | proposedDiff, source, origin })
    -> Ticket
    -- kiszámolja a diffet a current memóriához, payloadba teszi, write-gate tokent állít ki,
    --   az agent self_evolution_profile-ja alapján beállítja eval_required-et és validálja a scope_class-t
    [operator+]   (origin='reflection' esetén rendszer-hívó, lásd §6)

runMemoryEval({ ticketId })
    -> { passed, score, baseline, suiteVersion }
    -- a proposed_diff szerinti memóriával lefuttatja a suite-ot a Model Gateway-en át; eval_result-ba ír
    [operator+]   (eval_required && approval_mode∈{eval_only,auto_after_eval} esetén kötelező)

approveTraining({ ticketId })
    -> { memoryVersion }
    -- ellenőrzi: RBAC az approval_mode szerint, scope ⊆ profil.scope, diff ≤ profil.diff_limit,
    --   (ha eval_required) eval passed; majd a PLATFORM ír a tokennel -> új active verzió
    [approver+]   (auto_after_eval esetén a rendszer hívja eval-pass után, approved_by=NULL+rendszer-jelölés)

rejectTraining({ ticketId, reason })
    -> void
    -- a token revoked, a ticket rejected, audit
    [approver+]

rollbackMemory({ agentId, toVersion })
    -> { memoryVersion }
    -- a current_version visszaáll egy korábbi active verzióra; a leváltott rolled_back; audit
    [approver+]

getMemoryTimeline({ agentId })
    -> [{ version, status, source, approvedBy, createdAt, diffSummary }]
    [viewer+]
```

**Hard guardok az `approveTraining`-ben (sorrendben, bármelyik bukás → `write_denied` + reject):**
`requireRole(approval_mode)` → `scope_class ⊆ profile.scope` → `diff ≤ profile.diff_limit` → `eval_required ? eval.passed` → **kemény padló:** a diff **nem érint** jogosultságot/eszköz-hozzáférést (§8.3) → token érvényes és cél-verzióra kötött → platform ír.

---

## 6. Retrieval (olvasás) — a `MemoryStore` cserepont mögött

A retrieval **tisztán olvasás**, nem érinti a write-gate-et. A `MemoryStore` interfész (Roadmap §5.11) egyetlen impl mögött indul, és skálázáskor cserélhető — az agent kódja nem változik.

**Fázis 1 (MVP) — teljes beinjektálás.** Kis memóriánál a teljes aktív (`active`) verzió tartalma bemegy az agent kontextusába futásidőben. Determinisztikus, semmilyen keresési hiba nem rejt el releváns tudást. Impl: `PostgresMemoryStore`.

**Fázis 2 — relevancia-alapú hibrid keresés** (a marveen működő mintája szerint, §4.6.2), ha a tudásbázis mérete vagy ügyfélkérés indokolja:

1. **Kulcsszavas full-text** (SQLite FTS5 / Postgres FTS) — pontos a konkrét terminusokra (számlaszám, főkönyvi szám, ügyfélnév).
2. **Vektor- / szemantikus keresés lokális embeddinggel** (pl. Ollama + `nomic-embed-text`) — a hasonló *jelentésű* tudást is megtalálja. A számítás **a Tool Brokeren át** (explicit eszközjoggal, naplózva), **lokálisan** fut — az adat nem hagyja el a céget (§4.6.2, §8.7).
3. **Hibrid összefűzés Reciprocal Rank Fusion-nal (RRF)** — a két találati listát egy rangsorba olvasztja.
4. **Salience-súlyozás + decay:** minden memória-elem fontossági súlyt kap (`salience_index`); a gyakran visszakeresett tudás felértékelődik, a régóta nem használt **elhalványul (decay), de soha nem törlődik automatikusan**. Determinisztikus, **nem-LLM** mechanizmus (nulla token) — illeszkedik a token-ökonómiához (§4.11).

**Auditálhatóság (mindkét fázisban kötelező):** a retrieval **naplózott esemény** — visszakereshető, hogy egy adott ticket-futásnál *melyik memória-verziókat és -elemeket* húzta be az agent. Ez a reprodukálhatóság (§4.5) része: nemcsak az látszik, *melyik* verzió volt érvényes, hanem az is, *mit olvasott ki* belőle.

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

### 8.1 A profil három tárcsája (az `approveTraining` érvényesíti)

- **Scope (mit módosíthat magán):** `memory` / `+ behavior` / `+ role`. A tágabb scope erősebb kaput indokol. A `scope_class` a tárolt profil `scope`-ja ellen ellenőrződik — kívül eső scope → reject.
- **Approval mode (a tárcsa „laza" vége):** `human` (ember kötelező) / `higher_role` (magasabb jogú szerep elég) / `eval_only` (eval-kapu elég) / `auto_after_eval` (eval után automatikus promóció). Minden módban **fut a verziózás és az audit**; `eval_only` és `auto_after_eval` esetén az eval **kötelező**.
- **Diff-limit (hatókör-limit):** `max_chars` / `max_items` / `max_salience` — mekkora és milyen tömegű/súlyú tudás érinthető egy ciklusban. Túllépés → reject.

### 8.2 Mindig fix, nem konfigurálható ki

Verziózás + rollback + teljes audit, valamint a platform kezében maradó, szerveroldali, egyszer használatos write-token — **minden módban kötelező**. A `NULL` profil = legszigorúbb (`human`, `scope=[memory]`).

### 8.3 Kemény padló (privilege-escalation kizárása)

Egy agent **önmódosítással soha nem bővítheti** a saját jogosultságait vagy eszköz-hozzáférését (Tool Broker capability, RBAC, scoped kulcsok). Az önfejlesztés **tudáshoz és viselkedéshez** nyúlhat, **hatáskörhöz nem** — a jogosultság-bővítés kizárólag emberi adminisztratív aktus a Control Plane-ben (Agent Registry). Az `approveTraining` ezért **kódszinten** ellenőrzi: ha a `proposed_diff` capability-t / RBAC-szerepet / kulcs-scope-ot érintene, **azonnali reject** (`write_denied`), függetlenül a profiltól. Ez zárja ki az OWASP LLM06 (Excessive Agency) kockázatot, és ez különbözteti meg a „könnyített tanulást" a „kontrollálatlan önfejlesztéstől": *a tudás tárcsázható, a hatáskör nem*.

---

## 9. Biztonsági invariánsok és audit

| # | Invariáns | Kikényszerítés |
|---|---|---|
| I1 | Memóriába csak a platform ír, szerveroldali tokennel | a memória-író szolgáltatás csak érvényes tokent fogad; nincs kódút az agenttől tokenig |
| I2 | A token soha nem hagyja el a szervert | nyers token nem perszisztált (`write_gate_token_ref` = hash); nem kerül promptba/válaszba |
| I3 | Külső prompt („tanuld meg…") nem ír memóriát | minden írás `type='training'` tickethez + jóváhagyáshoz kötött (negatív teszt T1) |
| I4 | Minden frissítés diff + verzió + rollback | append-only `memory_versions`; `rollbackMemory` bármely korábbi verzióra |
| I5 | Önmódosítás nem bővít jogosultságot | `approveTraining` kemény-padló guard (§8.3); negatív teszt T4 |
| I6 | Retrieval nem érinti az írást, de naplózott | `MemoryStore` read-path külön; `memory.retrieval` audit-esemény |
| I7 | Working memory ≠ tartós memória | a session-memória a futás végén eldobódik; átkerülés csak tanítási ticketként |
| I8 | Tenant-izoláció | minden tábla `tenant_id`-scoped; cross-tenant olvasás/írás tiltott |

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

---

## 11. Fázisolás és nyitott kérdések

**MVP (kész/kötött):** `memories` / `memory_versions` / `training_tickets` séma; write-gate token protokoll; `createTrainingTicket` / `approveTraining` / `rollbackMemory`; teljes-beinjektálásos retrieval (`PostgresMemoryStore`); `memory.update` / `rollback` / `write_denied` audit; önfejlesztési-profil olvasás + kemény padló. Ez a spec ezekhez ad **explicit állapotgépet, eval-kaput, UI-t és a kemény-padló kódszintű guardot**.

**Fázis 2:** (a) **hibrid retrieval** (FTS + lokális embedding + RRF + salience/decay) — csak ha a tudásbázis mérete vagy ügyfélkérés indokolja (§4.6.2, §10.B); (b) **reflexiós feeder** (§4.6.3, Roadmap D5) — a write-gate enélkül is teljes, ezért nem MVP; (c) **`auto_after_eval` mód éles használata** — eval-suite-érettséget feltételez.

**Nyitott kérdések (validálandó):**
1. **Eval-tolerancia és suite-karbantartás:** mekkora pontszám-csökkenés még elfogadható, és ki gondozza a suite-okat? (ügyfél-specifikus; alap-tolerancia tenant-konfig)
2. **Salience-decay paraméterezése:** a decay-ütem és a „soha nem törlődik automatikusan" határa — Fázis 2, a tudásbázis méretével együtt szabandó.
3. **Lokális embedding-modell választása és hostingja:** csak konkrét (bank/PSP) ügyfélkérésnél; addig a teljes beinjektálás elég.
4. **Reflexiós trigger-feltételek hangolása:** túl gyakori reflexió = ticket-zaj; a determinisztikus feltételek küszöbei pilot-adatból kalibrálandók.

---

*Forrás és ellenőrzés: a dokumentum a `AI-Agent-Platform-Koncepcio.md` (§4.6–4.6.4, §8.1) és a `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (§4.4, §5.8, §5.11, §5.12.2, §11) alapján készült, és illeszkedik az Agent Registry / Model Gateway / ConversationSession / Per-user Connector feature-specekhez. Ellenőrzés dátuma: 2026-06-30.*
