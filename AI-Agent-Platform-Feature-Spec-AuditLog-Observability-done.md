# Feature-spec — Audit Log & Observability (append-only, tamper-evident napló + mérési alaplap)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-07-01
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, 0.5, 3.1–3.2.1, 4.2, 4.14, 6., 7., 8.3, 8.5, 8.6, 8.8), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (4.7 `model_calls`/`tool_calls`, 4.8 `audit_log` + hash-lánc, 4.8b ticket-független napló, 4.10 `conversations`/`messages`, 5.11 eseménytípus-lista, 9.2 N1–N8 negatív tesztek, 11. mérési minimum). A már elkészült feature-specek (`ModelGateway`, `ToolBroker`, `MemoryTraining`, `AgentRegistry`, `IAM-RBAC`, `Playbook`, `ConversationSession`, `AppRegistry`) mind erre a naplórétegre írnak — ez a dokumentum a **közös írási és lekérdezési szerződésüket** rögzíti.
**Olvasó:** fejlesztő(k), architect, product owner, security/compliance reviewer. Feltételezi az Agent Registry, IAM/RBAC, Model Gateway, Tool Broker, ticket-állapotgép és a beszélgetés-réteg alapmodell-ismeretét.
**Státusz:** tervezet — önálló feature-spec. Az MVP-ben a hash-láncolt `audit_log` + `verifyChain()` **VALÓDI, nem halasztott** (roadmap 4.8); ez a dokumentum az MVP-magot (append-only tamper-evident napló, content/metadata szétválasztás, mérési alaplap) **és** a Fázis 2-t (SIEM-export, WORM-archívum, drift/eval-dashboard, retenciós motor) egy helyen adja meg, fázis-címkékkel.

---

## 0. Mit ad ez a dokumentum

Ez a specifikáció meghatározza a platform **egyetlen igazság-forrás naplórétegét** és a rá épülő **mérési/observability alaplapot**: hogyan keletkezik minden governance-releváns esemény **egy dedikált, append-only, hash-láncolt** csatornán úgy, hogy utólag **bizonyíthatóan nem módosítható** (tamper-evident), **GDPR-kompatibilis** (a törölhető tartalom külön él), és **ticket nélkül is teljes** (a beszélgetéseket és azonnali végrehajtásokat is fedi).

A koncepció központi állítása (0.5, 8.3, 8.5): a governance forrása nem a ticket, hanem a **kontrollált runtime** — minden modell- és eszközhívás a Model Gateway-en és a Tool Brokeren át, naplózva. Az audit-log ezért **nem utólagos adminisztráció, hanem a működés alapmechanizmusa**. Ez teszi a kész, nyílt forráskódú harnesst (Goose) is enterprise-kompatibilissé: még ha a harness belső lépéseibe nem is látunk mindenbe, attól, hogy **minden hívás a két átjárón megy**, visszanyerjük az üzletileg és compliance szempontból számító auditálhatóságot — *milyen adathoz fért hozzá, milyen műveletet tett, mennyit költött, ki hagyta jóvá*.

A feature két, szorosan összetartozó rétegből áll:

| Réteg | Mit ad | Kemény garancia |
|---|---|---|
| **Audit Log** (8.5) | Append-only, hash-láncolt eseménynapló minden governance-műveletről | tamper-evidence (`verifyChain` zöld), content/metadata szétválasztás, ticket-független lefedettség |
| **Observability / mérési alaplap** (8.6, 11) | Token/költség, latency, siker/hiba, emberi visszadobás, audit-lánc teljessége | a naplókból **származtatott**, nem külön írt igazság — minden metrika visszavezethető egy audit- vagy call-sorra |

A két réteg viszonya egyirányú: **az observability az audit- és call-naplók olvasásából származik**, sosem külön, párhuzamos igazságforrásból. Így nem lehet „szép dashboard, hamis alap".

---

## 1. Scope

### 1.1 In scope — MVP-mag

- **`AuditService.append()`** — az **egyetlen** belépési pont az `audit_log`-ba: tranzakcióban olvassa az utolsó `hash`-t, kiszámítja az újat (`SHA-256(prev_hash || canonical_json(payload_without_hash))`), beilleszt.
- **`verifyChain()`** — a teljes lánc (vagy egy szegmens) integritásának ellenőrzése; a demó és a negatív tesztek használják (N-esetek, 9.2).
- **Kötelező eseménytípus-katalógus** (5.11 leképezése) — minden governance-művelet pontosan egy audit-eseményt ír.
- **Content/metadata szétválasztás** — nyers üzenet-/PII-/dokumentum-/secret-tartalom **soha** nem kerül az `audit_log.payload`-ba, csak referencia/hash/metaadat.
- **Ticket-független lefedettség** — a beszélgetéseket és azonnali végrehajtásokat is naplózza (`conversation_id`-attribútálás), táplálja az **activity feedet** (a board opcionális, az idővonal mindig megy).
- **GDPR-kompatibilis retenció** — az immutábilis audit-metaadat marad, a törölhető tartalom-payload (`messages.content_ref`) külön törölhető; törlés után `verifyChain` **zöld** (N8).
- **Adatbázis-szintű append-only kényszer** — az alkalmazás-szerepkörnek az `audit_log`-ra csak `INSERT`/`SELECT`; `UPDATE`/`DELETE` **megvonva**.
- **Mérési alaplap (11.)** — a `model_calls`, `tool_calls`, ticket-átfutás és audit-lánc olvasásából származtatott minimum-metrikák + írott mérési riport (`buildMeasurementReport`).
- **Governance & activity-feed nézet** — `/control-plane/governance`: audit-lánc böngészés, `verifyChain` státusz, mérési riport letöltés.

### 1.2 In scope — Fázis 2 (címkézve, nem MVP-gate)

- **SIEM-export** — az immutábilis eseményfolyam kiszervezése a vállalat saját biztonsági monitorozásába (Splunk/Sentinel/Elastic; push vagy pull, szűrt/redaktált payloaddal).
- **WORM / külső horgony** — periodikus lánc-„checkpoint" külső, write-once tárolóba (pl. object-lock bucket vagy időbélyeg-szolgáltatás), hogy még a DB-admin se tudja észrevétlenül átírni a teljes láncot.
- **Retenciós motor** — típusonkénti megőrzési/törlési policy (tartalom-erasure ütemezetten, audit-csontváz megtartásával).
- **Drift- és eval-dashboard** — minőségi metrikák, regresszió-detektálás, guardrail-sértések trendje (a MemoryTraining eval-kapujával összekötve).
- **SLA-monitor + riasztás** — agent válaszidő, jóváhagyási átfutás, budget-küszöb; küszöbátlépésnél proaktív jelzés (Proactive Monitor felé).
- **Anomália-flag** — gyanús minták (jogosultság-emelési kísérlet, szokatlan tool-mix) kiemelése az auditba (8.2 hivatkozás).
- **Multi-tenant audit-particionálás skálán** — tenant-szeparált láncok / partíciók, tenant-szintű export-jog.

### 1.3 Out of scope — most nem

- Az egyes események **kiváltása** — azt a forrás-komponensek végzik (Model Gateway írja a `model.call`-t, Tool Broker a `tool.call`-t stb.); ez a spec az **írás szerződését és a lánc-invariánst** adja, nem a hívási logikát.
- A `messages`/`documents` tartalom tárolása és törlési UI — a ConversationSession, illetve FileEditor spec felelőssége; itt csak a **hivatkozási szabályt** rögzítjük (tartalom sosem a payloadban).
- Teljes AIOps / APM rendszer (trace-propagáció, flame-graph) — MVP-ben mérési alaplap, nem elosztott tracing.
- Külső jogi/compliance-vélemény (7. elhatárolás: ez termékarchitektúra, nem jogi opinion).

### 1.4 Feature-szintű döntés

Az Audit & Observability **Control Plane komponens** (a control plane-en belüli, dedikált `AuditService` + read-only lekérdező réteg), **nem** Sandbox artefakt és **nem** a harness része. Ennek oka:

- az audit a **bizalmi réteg** (koncepció 1., 3.1) — a compliance-garancia forrása, ezért nem lehet a szabadon fejleszthető sandboxban vagy az auditvak külső runtime-ban (8.3);
- minden más komponens (Gateway, Broker, Registry, write-gate, állapotgép, beszélgetés-réteg) **ide ír** — az egyetlen írási pont csak akkor tartható, ha egy helyen, szerveroldalon él;
- a tamper-evidence és a törölhetőség feszültségét (GDPR ↔ immutabilitás) csak központi, kikényszerített séma oldja fel helyesen;
- a mérési riport az ügyfélnek szóló **értékbizonyíték** (11.) — ez governance-kimenet, nem sandbox-funkció.

---

## 2. Fő invariánsok

Ezeket **kódszinten és adatbázis-szinten** kell védeni, nem UI-szinten.

1. **Egyetlen írási pont.** Az `audit_log`-ba **kizárólag** az `AuditService.append()` ír; közvetlen `INSERT` az `audit_log`-ba az alkalmazás-kódból tilos (code review + DB-jog). Ez garantálja a hash-lánc folytonosságát.
2. **Append-only DB-szinten.** Az alkalmazás-szerepkörnek az `audit_log` táblára csak `INSERT` + `SELECT`; `UPDATE`/`DELETE` **megvonva** (grant szinten). Így egy alkalmazás-hiba vagy kompromittált szolgáltatás sem tud eseményt átírni/törölni.
3. **Hash-lánc.** Minden sor `hash = SHA-256(prev_hash || canonical_json(payload_without_hash))`; a genezis `prev_hash = null`. A `canonical_json` **determinisztikus** (rendezett kulcsok, rögzített szám-/UTF-8-normalizálás) — különben `verifyChain` hamisan bukna.
4. **Monoton sorrend.** A `seq` (bigserial) szigorúan növekvő; a lánc sorrendje a `seq` szerinti. Egyidejű `append` hívások **szerializálódnak** (lásd 4.2 konkurrencia).
5. **Content/metadata szétválasztás (kemény).** Nyers üzenet-, PII-, dokumentum-, argumentum- vagy secret-tartalom **soha** nem kerül az `audit_log.payload`-ba — csak referencia (`content_ref`, `storage_ref`, `secret_alias`), metaadat (`args_meta`, `result_meta`) vagy hash. Bizonyíték: N8 (9.2).
6. **Ticket-független teljesség.** Minden governance-esemény attribútált akkor is, ha nincs ticket: `actor` + (`ticket_id` **vagy** `conversation_id`) mindig kitölthető. Ticket nélküli beszélgetés/azonnali végrehajtás is **teljesen auditált** (N7, roadmap 4.8b).
7. **Agent-attribútálás verzióval.** Ahol az actor agent, ott `agent_version` **kötelező** a payloadban/oszlopban — a „melyik agent-verzió tette" reprodukálhatóság alapja (koncepció 4.5).
8. **GDPR-erasure sértetlen láncot hagy.** A tartalom törlése a `messages.content_ref`-et üríti + `content_deleted_at`-et állít; az `audit_log` metaadat-csontváz **marad**, `verifyChain()` **zöld** (N8). Az audit-eseménybe a törlés maga is bejegyzésként kerül (`message.content_deleted`).
9. **Observability = származtatott igazság.** Minden metrika a `model_calls` / `tool_calls` / `tickets` / `audit_log` **olvasásából** jön; nincs külön, párhuzamosan írt metrika-igazságforrás, amely eltérhetne az audittól.
10. **Tenant-izoláció.** Cross-tenant audit-, call- vagy metrika-elérés **tiltott**; a tenant-határ az agent (koncepció 8.8). Minden lekérdezés tenant-scope-olt.
11. **A napló nem blokkolhatja a láncot csendben.** Ha az `append()` meghiúsul (DB-hiba), a kiváltó governance-művelet **nem tekinthető sikeresen lezártnak** — az audit-írás a művelet tranzakciójának része, nem „best effort" mellékhatás (lásd 4.3).
12. **Fázis 2 invariáns (WORM-horgony).** Külső checkpoint bevezetése után a lokális lánc bármely szegmense a **külső horgonyhoz** is verifikálható; a horgony-rekord maga is `INSERT`-only és exportált.

---

## 3. Adatmodell

### 3.1 Meglévő táblák — változatlan használat

A feature a roadmap meglévő tábláira épül; a `model_calls` és `tool_calls` **forrás-naplók**, az `audit_log` a **governance-lánc**.

**`audit_log`** *(roadmap 4.8 — a tamper-evidence MVP-ben VALÓDI)*
```
audit_log
  id, seq (bigserial)               -- monoton sorrend; a lánc a seq szerint
  prev_hash (text, nullable)        -- az előző esemény hash-e (genezis: null)
  hash (text)                       -- = SHA-256( prev_hash || canonical_json(payload_without_hash) )
  type (text)                       -- eseménytípus (5.11 / e dok. 5. fejezet)
  actor_type (enum: human | agent | system), actor_id (nullable), agent_version (int, nullable)
  target_type (text, nullable), target_id (nullable)
  ticket_id (fk, nullable), conversation_id (fk conversations, nullable)   -- ticket-független attribútálás
  payload (jsonb)                   -- típusfüggő METAADAT (model, token, tool, diff, jóváhagyó, ref/hash) — NYERS TARTALOM SOHA
  tenant_id (uuid)                  -- tenant-scope (8.8)
  ts (timestamptz)
```

> **Megjegyzés a séma-horgokhoz:** a roadmap 4.8 alap-sémája a `ticket_id`/`conversation_id`/`tenant_id` mezőket a `payload`-ban vagy a `target`-en keresztül is hordozhatja; e spec **javasolja ezek explicit oszloppá emelését** a hatékony, indexelt, tenant-scope-olt lekérdezéshez. Ha az MVP-implementáció ezeket a payloadban tartja, a lekérdező réteg (6.) generált oszlopon/indexen keresztül éri el — a **lánc-hash számítása szempontjából mindegy**, mert a `canonical_json` a teljes payloadot fedi.

**`model_calls`** *(roadmap 4.7 — Model Gateway napló, forrás az observabilityhez)*
```
id, ticket_id (nullable), conversation_id (nullable), agent_id, agent_version
model, prompt_tokens (nullable), completion_tokens (nullable)
cost_estimate (numeric, nullable)   -- flat-rate → becsült/aggregált (D2)
latency_ms, status (enum: ok | error | rate_limited), created_at
```

**`tool_calls`** *(roadmap 4.7 — Tool Broker napló, forrás az observabilityhez)*
```
id, ticket_id (nullable), conversation_id (nullable), agent_id, agent_version
tool, args_meta (jsonb), result_meta (jsonb)
authorized (bool), denied_reason (text, nullable), latency_ms, created_at
```

**`messages`** *(roadmap 4.10 — a törölhető tartalom itt él, NEM az audit_logban)*
```
id, conversation_id, seq, role, agent_version (nullable), model (nullable)
content_ref (text, nullable)          -- TÖRÖLHETŐ payload (szöveg/PII) — GCS/DB-blob
content_deleted_at (timestamptz, nullable)   -- GDPR-erasure jele; a csontváz + audit marad
ticket_ref (nullable), created_at
```

### 3.2 Új / kiegészítő elemek

**`audit_checkpoints`** *(Fázis 2 — WORM-horgony)*
```
audit_checkpoints
  id, tenant_id (uuid, nullable)     -- null = globális lánc-checkpoint
  from_seq (bigint), to_seq (bigint)
  chain_hash (text)                  -- a [from_seq..to_seq] szegmens verifikált vég-hash-e
  anchored_ref (text)                -- külső WORM/időbélyeg referencia (object-lock / TSA)
  created_at
```

**`retention_policies`** *(Fázis 2 — típusonkénti megőrzés)*
```
retention_policies
  id, tenant_id, content_class (enum: message | document | model_io_meta | ...)
  retain_days (int), action (enum: purge_content | anonymize)
  enabled (bool), created_at, updated_at
```

**Származtatott nézetek (materialized view vagy lekérdezés, nem új igazságforrás):**
```
v_measurement_ticket   -- ticketenként: token-összeg, cost_estimate-összeg, futásidő, siker/hiba, humán visszadobás
v_activity_feed        -- audit_log idővonal: ts, type, actor, target, ticket/conversation — a board-független feed
v_chain_status         -- verifyChain eredménye szegmensenként (utolsó ellenőrzés ts + zöld/piros)
```

> **Elv:** ezek a nézetek **kizárólag olvasnak** a forrás-táblákból. Sosem tárolnak olyan tényt, ami nincs benne az auditban vagy a call-naplókban (9. invariáns).

---

## 4. Írási út (append) és garanciák

### 4.1 `AuditService.append(event)` — szerződés

```
append(event: {
  type, actorType, actorId?, agentVersion?,
  targetType?, targetId?, ticketId?, conversationId?,
  tenantId, payload   // csak metaadat/ref/hash — nyers tartalom TILOS (validált)
}) -> { id, seq, hash }
```

Lépések (egyetlen DB-tranzakcióban):

1. **Payload-sanitizáció / guard.** A service ellenőrzi, hogy a payload nem tartalmaz tiltott mezőt (pl. `content`, `raw`, `secret`, nagy bináris) — ha igen, **elutasít** (fejlesztői hiba, fail-fast). Ez a content/metadata invariáns kódszintű őre (5. invariáns).
2. **Utolsó hash olvasása.** `SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1 FOR UPDATE` (soralapú szerializáció, lásd 4.2). Genezisnél `prev_hash = null`.
3. **Canonical JSON + hash.** `canonical = canonicalJson(payloadWithoutHash)`; `hash = sha256(prev_hash ?? '' || canonical)`.
4. **Insert.** A sor beszúrása `prev_hash`, `hash`, `seq` (bigserial), `ts = now()` értékekkel.
5. **Return.** `{ id, seq, hash }` a hívónak (a hívó ezt beteheti a saját válaszába, pl. a UI „audit-igazolás" linkje).

### 4.2 Konkurrencia és sorrend

Az egyidejű `append` hívásokat **szerializálni kell**, különben két sor ugyanarra a `prev_hash`-re épülne (fork). Két elfogadható megoldás:

- **Advisory lock / soralapú `FOR UPDATE`** a lánc-fejre (MVP-alapértelmezés): egyszerű, elég a walking skeleton terheléséhez.
- **Dedikált egyszálú append-worker / sorozatosító** (Fázis 2, skálán): az `append` kérések egy sorba kerülnek, egy writer dolgozza fel — így a lock-kontenció eltűnik.

A `seq` monotonitása + a `prev_hash`-fej lock együtt garantálja, hogy a lánc **egyenes** (nincs elágazás). Ezt a `verifyChain()` is ellenőrzi (minden sor `prev_hash`-e az előző sor `hash`-e; a `seq` hézagmentes vagy legalább szigorúan növekvő és folytonos a láncban).

### 4.3 Tranzakcionalitás a kiváltó művelettel

A koncepció 11. invariánsa szerint az audit nem „best effort". Két minta megengedett, komponenstől függően:

- **Közös tranzakció (preferált, ahol a governance-írás és az audit ugyanabban a DB-ben van):** a művelet (pl. `ticket.transition`, `memory.update`) és az `append()` **egy tranzakcióban** commitál — vagy mindkettő megvan, vagy egyik sem. Ez zárja ki a „megtörtént, de nem naplózódott" állapotot.
- **Outbox-minta (ahol a művelet külső hatású, pl. tényleges rendszerbe írás):** a művelet-szándék és az audit-esemény egy `outbox` sorba kerül a művelet tranzakciójában; a tényleges külső hívás után az audit véglegesül. A cél változatlan: **ne lehessen naplózatlan governance-hatás**.

> **Fail-mode:** ha az `append()` bukik, a hívó governance-művelet **hibára fut** (a tranzakció rollbackel). Ez tudatos választás: inkább egy meghiúsult művelet, mint egy naplózatlan.

---

## 5. Kötelező eseménytípus-katalógus

A roadmap 5.11 listájának leképezése, forrás-komponens és kötelező payload-metaadat szerint. **Minden governance-művelet pontosan egy audit-eseményt ír** (a `veryfyChain` teljessége ezen múlik). A `payload` mindig **metaadat/ref**, sosem nyers tartalom.

| Eseménytípus | Forrás-komponens | Kötelező payload-metaadat |
|---|---|---|
| `ticket.transition` / `ticket.transition.denied` | Ticket-állapotgép (Playbook) | from→to állapot, tickettípus, `playbook_ref` (pin), döntési ok |
| `process.start` | Playbook-motor | `playbook_ref` (pin), process_type |
| `model.call` | Model Gateway | model, token-becslés, latency, status, routing-ok, `agentVersion` |
| `tool.call` / `tool.call.denied` | Tool Broker | tool, connector-ref, `args_meta`/`result_meta` (nem nyers), authorized, denied_reason |
| `memory.update` / `memory.rollback` / `memory.write_denied` | Write-gate (MemoryTraining) | memória-verzió, diff-hash, jóváhagyó, eval-eredmény-ref |
| `agent.create` / `agent.version` / `agent.key_rotate` / `agent.suspend` | Agent Registry | agent-id, verzió, változás-ref, admin actor |
| `agent.self_evolution_profile_change` | Agent Registry | profil-diff, admin actor |
| `training.capability_escalation_denied` | Write-gate | kísérelt jog, blokk-ok (kemény padló bizonyítéka — N6) |
| `recipe.create` / `recipe.version` / `recipe.approve` | Recipe-réteg | recipe-id, verzió, jóváhagyó |
| `playbook.create` / `playbook.version` / `playbook.approve` | Playbook Registry | playbook-id, verzió, jóváhagyó |
| `access.invite` / `access.redeem` / `access.role_change` / `access.suspend` | IAM/RBAC | user-ref, szerep, admin actor |
| `dispatch.start` / `dispatch.budget_blocked` | Dispatcher | ticket/conversation-ref, budget-döntés |
| `conversation.create` / `message.append` / `message.content_deleted` / `conversation.promote_to_ticket` | ConversationSession | conversation-id, message-seq, **content-ref/hash (nem szöveg)**, promóció-ok |
| `sandbox_app.create` / `.version` / `.preview` / `.export` / `.access_denied` | App Registry | app-id, verzió, `content_hash`, actor |

> **Bővítési szabály:** új eseménytípus bevezetése **kódszintű regisztráció** (típus-enum + kötelező-payload-séma) — így nem keletkezik „szabad szöveg" típus, és a lekérdező/riport-réteg tudja értelmezni. A payload-séma validációja az `append()` guardjában fut.

---

## 6. Lekérdezés, activity feed és governance-nézet

### 6.1 Activity feed (a board-független idővonal)

A koncepció 0.5/8.5 elve: az AI **ne legyen láthatatlan háttérfolyamat**. Ezt az **audit-log + activity feed** garantálja — minden interakció megjelenik, akkor is, ha nincs ticket. A `v_activity_feed` a `audit_log`-ból ad idővonalat (ts, type, actor, target, ticket/conversation link), tenant-scope-olt, szűrhető (agent, típus, időszak). A Kanban/ticket board ehhez képest **opcionális koordinációs réteg** az összetartozó, delegált vagy ütemezett munkára.

### 6.2 Audit-lánc böngészés + `verifyChain`

A `/control-plane/governance` nézet:

- eseménylista szűrőkkel (típus, actor, agent-verzió, ticket/conversation, időszak);
- egy adott eredményhez a **teljes láncolat** kibontása: input → agent-/memória-/recipe-/playbook-verzió → modell- és eszközhívások → jóváhagyó (a demó „kipróbálható, ha" kritériuma, roadmap 5.11);
- **`verifyChain()` státusz** (zöld/piros) + utolsó ellenőrzés időpontja (`v_chain_status`).

`verifyChain(fromSeq?, toSeq?)`: végigmegy a szegmensen, minden sorra újraszámolja a `hash`-t a `prev_hash + canonical_json(payload)` alapján, és összeveti a tárolttal; ellenőrzi a `prev_hash`-láncolást és a `seq` folytonosságát. Bármely eltérés → **piros** + az első eltérő `seq` visszaadása. Fázis 2-ben a szegmens a `audit_checkpoints` külső horgonyához is verifikálható.

### 6.3 Lekérdezési teljesítmény

Indexek: `audit_log(seq)`, `audit_log(tenant_id, ts)`, `audit_log(type, ts)`, `audit_log(agent_id, ts)` (ha oszlop), `audit_log(ticket_id)`, `audit_log(conversation_id)`. A `verifyChain` teljes láncra költséges — MVP-ben a demó- és tesztméret elég; Fázis 2-ben a **checkpoint-alapú részleges verifikáció** (utolsó horgonytól) tartja alacsonyan a költséget.

---

## 7. Observability / mérési alaplap (8.6, 11.)

MVP-nél a minimum **nem** teljes AIOps, hanem egy **mérési alaplap**, amely bizonyítja, hogy az AI üzleti értéket termel (nem csak látványos demó). Minden metrika a forrás-naplókból **származtatott** (9. invariáns).

### 7.1 MVP-minimum metrikák

| Metrika | Forrás | Cél |
|---|---|---|
| Token/költség ticketenként és agentenként | `model_calls` (token, `cost_estimate`) | költség-elszállás elkerülése, ROI |
| Futásidő / latency | `model_calls.latency_ms`, `tool_calls.latency_ms`, ticket-átfutás | SLA-alap |
| Siker/hiba státusz | `model_calls.status`, `tool_calls.authorized`, ticket-végállapot | megbízhatóság |
| Emberi visszadobási arány | ticket-átmenetek (`ticket.transition` humán-visszadobás) | agent-javaslat minősége |
| Jóváhagyási átfutás | `ticket.transition` időbélyegek (kapu → jóváhagyás) | human-in-the-loop hatékonyság |
| Kontroll: jóváhagyott vs. automatikus lépések | `audit_log` (kapu-események) | governance-bizonyíték |
| Audit-lánc teljessége | `verifyChain()` | tamper-evidence bizonyíték |

> **Kvóta-megjegyzés (roadmap D2):** a flat-rate ChatGPT OAuth miatt a pontos per-call költség nem mindig elérhető; a `cost_estimate` **becsült/aggregált**. Az MVP a hívásszámot és a token-becslést naplózza — a pontosság nem elvárás, a **trend és attribútálás** igen.

### 7.2 Írott mérési riport

`buildMeasurementReport(tenantId, period)` → strukturált riport a fenti metrikákból + `verifyChain` státusz; letölthető a governance-oldalról, és CLI-ből is futtatható (`report:measurement`). Ez az ügyfélnek szóló **értékbizonyíték** (van-e mérhető üzleti érték), és a pilot kilépési kritériumainak alátámasztása (koncepció 9.).

### 7.3 Fázis 2 observability

- **Drift/eval-dashboard** — minőségi metrikák és regresszió-detektálás a MemoryTraining eval-kapujával összekötve (a „nem driftel el észrevétlenül" ígéret műszerfala, 8.1).
- **Guardrail-sértések dashboardja** — Gateway/Broker deny-események trendje, anomália-flag (8.2).
- **SLA-monitor + riasztás** — küszöbátlépésnél proaktív jelzés (Proactive Monitor felé), pl. budget-küszöb, válaszidő-degradáció.

---

## 8. Biztonság, GDPR és compliance-leképezés

### 8.1 GDPR — törölhetőség vs. immutabilitás

A feszültséget a **content/metadata szétválasztás** oldja fel (5., 8. invariáns): az `audit_log` immutábilis metaadat (esemény, hash, actor, ts) — **nem törölhető**; a törölhető tartalom (üzenetszöveg, PII, dokumentum) a `messages.content_ref` / `documents.storage_ref` mögött él, **külön törölhetőséggel**. A GDPR-erasure a tartalmat viszi (`content_ref` ürül + `content_deleted_at`), az auditcsontváz és a hash-lánc **ép marad** (`verifyChain` zöld). A törlés maga is auditesemény (`message.content_deleted`, csak ref/hash a payloadban). Bizonyíték: **N8** (9.2).

### 8.2 PCI DSS / secret-védelem

PAN/kártyaadat és secret **soha** nem kerül a payloadba (5. invariáns) — a Tool Broker secret-injektálás szerveroldali és alias mögötti (4.9.2 hivatkozás); az audit csak `secret_alias`/ref-et lát. Minden tool-hívás auditált (`tool.call`), a hozzáférés-kontroll és naplózás PCI-alapelvei (hozzáférés-kontroll, naplózás, adatszegregáció) így közvetlenül teljesülnek.

### 8.3 Külső kontrollkeretek (7.)

| Keret | Mit fed le ez a feature |
|---|---|
| **EU AI Act** | naplózás/nyomonkövethetőség + transzparencia mint működési alapréteg (nem extra modul) — „AI Act readiness" pozíció |
| **NIST AI RMF** | `Measure` = evalok + observability; `Manage` = incident-nyom, rollback-audit |
| **ISO/IEC 42001 / 27001** | auditnapló, változáskezelés, hozzáférés-kezelés dokumentálható kontrollként |
| **PCI DSS** | naplózás, adatszegregáció, secret ki nem szivárgása (8.2) |
| **DORA** | audit-export, incident-nyom, provider-kiesési nyomonkövethetőség |
| **OWASP LLM** | LLM06 (Excessive Agency) — `training.capability_escalation_denied` flag; deny-események auditja |

> **Elhatárolás (7.):** ez nem jogi megfelelőségi vélemény. A cél, hogy a kritikus kontrollpontok — ki fér hozzá, mit lát az agent, milyen eszközt hív, ki hagyott jóvá, milyen modell futott, mennyibe került, visszagörgethető-e — már az MVP-től **mérhető és dokumentálható** módon jelenjenek meg.

---

## 9. Tesztelés — kötelező negatív és lánc-tesztek

A roadmap 9.2 negatív tesztjei közül ez a feature felel a lánc- és tartalom-invariánsokért.

| Teszt | Forgatókönyv | Elvárt eredmény |
|---|---|---|
| **verifyChain-happy** | Több vegyes esemény beírása, majd `verifyChain()` | **zöld**; a teljes lánc verifikál |
| **verifyChain-tamper** | Egy sor `payload`-jának közvetlen DB-módosítása (teszt-hook) | **piros**; az első eltérő `seq` visszaadva |
| **append-only enforce** | `UPDATE`/`DELETE` kísérlet az `audit_log`-on az alkalmazás-szerepkörrel | DB-jog **megtagadja** |
| **N7** *(CR-MVP-003)* | Ticket nélküli beszélgetés-forduló + azonnali végrehajtás | teljes audit `conversation_id`-attribútálással; a feed mutatja |
| **N8** *(CR-MVP-003)* | Egy beszélgetés-üzenet tartalmának GDPR-törlése | `content_ref` ürül + `content_deleted_at`; `messages` csontváz + `audit_log` **marad**; `verifyChain()` **zöld** |
| **N2** *(kapcsolt)* | Agent nem engedélyezett toolt hív | `tool.call.denied` audit-flag megjelenik (a Broker írja, a lánc fedi) |
| **N6** *(CR-MVP-002)* | Agent önmódosítással jogot próbál bővíteni | `training.capability_escalation_denied` audit; a jog nem változik |
| **content-guard** | `append()` hívás nyers `content`/`secret` mezővel a payloadban | **elutasítás** (fail-fast, fejlesztői hiba) |
| **concurrency** | Párhuzamos `append()` hívások | egyenes lánc, nincs fork; `seq` szigorúan növekvő; `verifyChain` zöld |

**Kipróbálható, ha:** a demó végén egy adott eredményhez megmutatható a **teljes láncolat** (input → verziók → modell-/eszközhívások → jóváhagyó), a `verifyChain()` **zöld**, és a mérési riport letölthető.

---

## 10. Cserepontok és evolúció (koncepció 4.13, 8.7)

Platformfüggetlenség: a Firebase csak teszt-host (8.7). A perzisztencia absztrakció mögött cserélhető.

| Elem | MVP | Csereút (Fázis 2 / on-prem) |
|---|---|---|
| Audit-tár | Postgres append-only tábla + DB-grant | + WORM object-lock checkpoint / TSA-időbélyeg (`audit_checkpoints`) |
| `AuditService` | in-process service, közös tranzakció | dedikált append-worker / sorozatosító skálán |
| Export | governance-oldali riport-letöltés | SIEM push/pull (Splunk/Sentinel/Elastic), redaktált payload |
| Retenció | manuális / nincs auto-purge | `retention_policies` motor, ütemezett tartalom-erasure |
| Observability | származtatott nézetek + írott riport | drift/eval + SLA-dashboard + riasztás |

Az absztrakció (az `AuditService` interfész + a `verifyChain` szerződés) **a miénk marad**; a mögöttes tár és export cserélhető anélkül, hogy a hívó komponensek (Gateway, Broker, Registry, write-gate) változnának.

---

## 11. Nyitott kérdések / döntést igénylő pontok

1. **Explicit oszlop vs. payload** a `ticket_id`/`conversation_id`/`tenant_id`/`agent_id` mezőkre — e spec az explicit, indexelt oszlopot javasolja (6.3 teljesítmény); ha az MVP payloadban tartja, generált oszlop + index kell. **Döntés a séma-tulajdonosé.**
2. **Közös tranzakció vs. outbox** komponensenként (4.3) — a tisztán DB-hatású műveleteknél közös tranzakció; a külső rendszerbe írásnál outbox. **Komponensenként kell rögzíteni.**
3. **WORM-horgony trigger** (Fázis 2) — időalapú (pl. óránként) vagy eseményszám-alapú checkpoint? Compliance-igénytől függ (bank/PSP szigorúbb).
4. **SIEM-formátum** (Fázis 2) — CEF/LEEF/ECS közül melyik az elsődleges célügyfél SOC-jához? Ügyfélfüggő; a redakciós szabály (payload-szűrés export előtt) viszont közös.
5. **Retenciós default** — MVP-ben nincs auto-purge; az első pilotnál kell egy alap tartalom-megőrzési policy (pl. üzenet-tartalom N nap), a **csontváz mindig marad**.

---

*Ez a dokumentum a `AI-Agent-Platform-Koncepcio.md` 0.10 lefedettségi táblázatában „Még nem készült önálló feature-spec" státuszú **„Append-only, tamper-evident audit log és observability" (7., 8.5–8.6)** feature-t fedi le. A táblázat sora ennek megfelelően „Készült"-re frissíthető, e dokumentumra hivatkozva.*
