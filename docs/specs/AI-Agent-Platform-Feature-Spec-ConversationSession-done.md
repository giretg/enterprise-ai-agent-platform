# Feature-spec — Beszélgetés- és session-kezelés (Conversation / Session)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-29
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (§4.2, §4.14, §4.6/§4.6.1 write-gate, §5.6 kritikussági szint, §8.5 audit, §8.8 tenant-izoláció), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (v1.0, §4.10 `conversations`/`messages` séma, §4.8 audit, §5.7 dispatcher, §5.8 write-gate, §5.13 session store + kapu-leválasztás, §10 API), `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md` (v1.0, acting user a sessionben), `AI-Agent-Platform-Feature-Spec-Proactive-Monitor.md` (v1.0, ticket-forrás minta)
**Olvasó:** fejlesztő(k). Feltételezi a Ticket-állapotgép, a `DispatcherService`, a Tool Broker + Model Gateway, az append-only audit (`verifyChain`), az RBAC (`requireRole`) és a write-gate token ismeretét.
**Státusz:** **MVP-horgok kész, teljes feature Fázis 2.** A `conversations`/`messages` séma, a `tenant_id`-scope, a content/metadata szétválasztás és a beszélgetés-elsődleges wiki-flow (`askWiki`) az MVP-ben **be van kötve** (CR-MVP-003, D9). Ez a dokumentum a **teljes** beszélgetés-/session-réteget specifikálja: context assembly, retenció/GDPR-erasure end-to-end, activity feed, többszálú beszélgetés-UI és a kritikussági-szintezett (L0–L3) kapu-eszkaláció.

---

## 0. Mit ad ez a dokumentum

Meghatározza, hogyan lesz az **ember↔agent beszélgetés** a platform harmadik, first-class, Control Plane-birtokolt entitása a ticket és az agent mellett (koncepció §4.14). A v0.10 interakciós-modell óta a **beszélgetés az alapinterakció**, a board/ticket pedig opcionális koordinációs réteg (§4.2) — ezért a session-kezelés nem implementációs részlet, hanem koncepcionális elem, amelynek saját tárolása, retenciója, GDPR-törlési útja, tenant-izolációja és kontextus-rehydrationje van.

**A feature három, élesen elhatárolt invariánsra épül:**

1. **Beszélgetés ≠ Goose-session.** A harness futtatási sessionje **efemer** (egy feladat lefutása, állapotmentes, eldobódik); a beszélgetésszál **tartós**, sok harness-futáson átível, és a Control Plane-ben él — nem a sandboxban, nem a harnessben.
2. **Beszélgetés-memória ≠ agent-memória.** A beszélgetés-előzmény **scratch-kontextus**; soha nem írja csendben az agent tartós tudását (`memory_versions`). Tudás-beemelés kizárólag a write-gate-en át, tanítási ticketként (koncepció §4.6.1).
3. **A kötelező jóváhagyási kapu nem a ticketen él.** Egy magas kockázatú művelet attól, hogy direkt beszélgetésben (ticket nélkül) kérik, **nem** válik megkerülhetővé — a kaput a szerveroldali policy (write-gate token, Tool Broker `authorize()`, transition-szabály), nem a „van-e kártya" kérdés dönti el.

**Miért fontos feature:** a beszélgetés a legnagyobb PII-felület (§0.7), és más feature-ek dependenciája — a Per-user Connector spec szerint a session **hordozza az acting user identitását** (delegált connector-feloldáshoz), a Proaktív Monitor és a Playbook pedig a beszélgetésből született ticketre hivatkozik vissza. A formalizálás ezért keresztbe erősíti a meglévő rétegeket.

---

## 1. Scope

### 1.1 In scope (teljes feature)

1. **Beszélgetés / session store** mint elsőrendű, tenant-scoped, verzió-attribútált tartós entitás (`conversations` + `messages`), a tartalom-payload és az audit-metaadat **külön törölhetőségével**.
2. **Fordulónkénti reprodukálhatóság:** minden üzenethez a fordulót kezelő `agent_version` + `model`, a kapcsolódó audit-események referenciája és az esetleges `ticket_ref` visszahivatkozás.
3. **Context assembly (rehydration):** explicit, dispatch (§5.7) előtti lépés, amely a *releváns* korábbi fordulókat + memóriát + dokumentumokat tölti vissza a harness-kontextusba — nem a teljes előzményt (token-ökonómia).
4. **Acting user a sessionben:** a beszélgetés hordozza a belépett felhasználó identitását, amelyet a Tool Broker a `user_delegated` connectorok feloldásához használ (Per-user Connector spec).
5. **Retenció + GDPR-erasure end-to-end:** konfigurálható megőrzési idő, törlési jog, az immutábilis audit-metaadat (megtörtént + hash) és a törölhető tartalom-payload szétválasztásával — `verifyChain` a törlés után is zöld (N8).
6. **Tenant-izoláció:** a beszélgetés-tér per-tenant zárt; az izoláció határa az agent (§8.8). Cross-tenant olvasás szerveroldali elutasítás + audit.
7. **Activity feed** mint a session-store **olvasónézete** (nem külön rendszer): minden interakció megjelenik, ticket nélkül is.
8. **Beszélgetésből ticket (promote):** ha egy chatből delegálás / ütemezés / jóváhagyás lesz, a ticket a forrás-`conversation_id`-re mutat, és az átmenet auditált.
9. **Kapu-leválasztási invariáns (N7):** a kötelező kapu szerveroldali, ticket-független kikényszerítése + a Fázis 2 kritikussági-szintezett (L0–L3) automatikus eszkaláció.
10. **Control Plane UI:** beszélgetés-lista, szál-nézet, többszálú/több-agentes beszélgetés-felület, tartalom-törlés admin-művelet, activity feed nézet.

### 1.2 Out of scope (most NEM)

- **Az agent tartós memória/tanítás motorja** — az `appendMessage` soha nem ír `memory_versions`-t; a write-gate / tanítási pipeline külön spec (javasolt memória / self-evolution spec, koncepció §0.10).
- **A Goose futtatási session belső állapotkezelése** — efemer, a harness sajátja; itt csak az határ, hogy a beszélgetés **nem** abban él.
- **Real-time multi-user co-editing / élő jelenlét (presence)** egy szálon — a beszélgetés egy `created_by` userhez kötött MVP-ben; több néző Fázis 3 erőforrás-szintű láthatósággal.
- **Általános keresés/szemantikus visszakeresés a teljes beszélgetés-archívumban** — a context assembly a *folyó* szálra + memóriára épül; a kereszt-beszélgetés szemantikus keresés a memória-substrate (koncepció §4.6.2, elhalasztott) hatóköre.
- **A kritikussági-osztályozó (L0–L3) tartalomelemző modellje** — a szintek konfigurált hozzárendelésből jönnek; a tanuló osztályozó későbbi munka.

### 1.3 Az MVP-re gyakorolt hatás

A feature **additív és nagyrészt már meglévő horgokra épül**. Az MVP (CR-MVP-003, D9) már tartalmazza: a `conversations`/`messages` táblát tenant-scope-pal és content/metadata szétválasztással, az `askWiki` beszélgetés-elsődleges flow-t, a kapu-leválasztási invariánst (N7) és a GDPR-törlési invariánst (N8). Ez a spec ezeket **kiegészíti** (context assembly explicit lépéssé emelése, retenció-policy, activity feed, többszálú UI), nem írja át. A meglévő dispatch-lánc, write-gate, Tool Broker és audit változatlanul újrahasznosul.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

```
        ┌──────────────────────────── CONTROL PLANE (1. app) ─────────────────────────────┐
        │                                                                                  │
        │   ┌──────────────────────────┐      ┌───────────────────────────────────────┐   │
        │   │  SESSION STORE           │      │  CONTEXT ASSEMBLY  (dispatch előtt)    │   │
        │   │  conversations / messages│─────▶│  releváns fordulók + memória-snapshot  │   │
        │   │  tenant-scoped, verzió-  │      │  + dokumentum-ref → harness-kontextus  │   │
        │   │  attribútált, content_ref│      └──────────────────┬────────────────────┘   │
        │   └─────────┬────────────────┘                         │                        │
        │             │ olvasónézet                              │ assembled context      │
        │             ▼                                          ▼                        │
        │   ┌──────────────────┐   acting_user      ┌────────────────────────┐            │
        │   │  ACTIVITY FEED   │   ↓ (session hordoz) │   DISPATCHER (§5.7)    │── dispatch ─┼──▶ HARNESS
        │   └──────────────────┘                     └────────────────────────┘            │   (Goose,
        │                                                                                  │    efemer
        │   minden message.append / model_call / tool_call ──▶ APPEND-ONLY AUDIT (§8.5)    │    session)
        │   tartalom NEM a payloadban (csak ref/hash) ─ GDPR-erasure: content_ref ürítés   │
        └──────────────────────────────────────────────────────────────────────────────────┘
                         │ promote (delegálás / ütemezés / jóváhagyás)
                         ▼
                 TICKET (opcionális) ── ticket.conversation_id ──▶ vissza a forrás-szálra
```

**Kulcselv:** a governance forrása **nem a ticket, hanem a kontrollált runtime** — minden modell- és eszközhívás a Model Gateway-en, illetve a Tool Brokeren át, naplózva, verziózott agenttel. Ez **ticket nélkül is teljes**: a `model_calls` / `tool_calls` `ticket_id`-je nullable, és a `conversation_id`-n keresztül attribútálódik (MVP-spec §4.8).

---

## 3. Adatmodell

A meglévő MVP-séma (§4.10) kibővítve a teljes feature-höz szükséges mezőkkel. Prisma-szerű jelölés; a **dőlt** mezők az MVP-n túli, Fázis 2 kiegészítések.

### 3.1 `conversations` — tartós szál (tenant-scoped)

```
id              uuid  pk
tenant_id       uuid  not null            -- per-tenant zárt; nincs cross-tenant megosztás (§8.8)
agent_id        fk agents not null         -- melyik agenttel folyik (MVP: 1 agent/szál)
title           text  nullable
created_by      fk users not null          -- a beszélgetés tulajdonosa (acting user default)
status          enum(active|archived) default active
created_at      timestamptz not null
updated_at      timestamptz not null
last_message_at timestamptz nullable       -- listázás/rendezés; activity feed kurzor

-- Fázis 2 kiegészítések:
retention_policy_id   fk retention_policies nullable   -- ha nincs, a tenant default érvényes
retain_until          timestamptz nullable              -- számított hard-delete határidő (3.4)
legal_hold            boolean default false             -- ha true, a retenció nem törölhet (felülírja a retain_until-t)
```

**Index:** `(tenant_id, agent_id, last_message_at desc)` a lista- és feed-lekérdezésekhez; `(tenant_id, created_by)` a „saját beszélgetéseim" nézethez; `(retain_until)` parciális index a törlő-job sweepjéhez (`legal_hold = false AND retain_until is not null`).

### 3.2 `messages` — fordulónkénti rekord (a tartalom külön törölhető)

```
id                 uuid  pk
conversation_id    fk conversations not null
seq                int   not null           -- monoton sorrend a szálon belül (per-conversation)
role               enum(user|agent|system|tool) not null
acting_user_id     fk users nullable        -- KI nevében ment a forduló (user-üzenetnél = küldő; agent-fordulónál a session acting userje) → Tool Broker delegált feloldás
agent_version      int   nullable           -- reprodukálhatóság: melyik verzió kezelte (§4.5)
model              text  nullable           -- melyik modell kezelte a fordulót
content_ref        text  nullable           -- TÖRÖLHETŐ payload (szöveg/PII): GCS/DB-blob, NEM az audit_logban
content_hash       text  nullable           -- a payload hash-e; az auditba ez kerül, nem a szöveg (§8.5)
content_deleted_at timestamptz nullable     -- GDPR-erasure: tartalom törölve, a csontváz + audit marad
ticket_ref         fk tickets nullable      -- ha ebből a fordulóból ticket lett (promote)
audit_event_ref    text nullable            -- a fordulóhoz tartozó message.append audit-esemény id-je
created_at         timestamptz not null

-- Fázis 2 kiegészítés:
criticality        enum(L0|L1|L2|L3) nullable   -- a fordulóból indított művelet kritikussági szintje (§5.6); kapu-eszkalációhoz
```

**Index:** `(conversation_id, seq)` unique — a szálon belüli sorrend és az idempotens append; `(content_deleted_at)` parciális a GDPR-audithoz.

**Egyediségi invariáns:** `(conversation_id, seq)` unique → az `appendMessage` idempotens kulcsa (3.3), két párhuzamos append nem kaphat azonos `seq`-et.

### 3.3 `retention_policies` (Fázis 2) — tenant-szintű megőrzési szabály

```
id            uuid pk
tenant_id     fk   not null
name          text not null
ttl_days      int  not null            -- last_message_at + ttl_days = retain_until
applies_to    enum(all|agent) default all
agent_id      fk agents nullable        -- ha applies_to = agent
created_at, updated_at
```

A tenantnak van egy default policy-ja; egy beszélgetés `retention_policy_id`-vel felülírható. A `retain_until` a `last_message_at` minden frissítésekor újraszámolódik (a szál „él, amíg beszélnek vele").

### 3.4 Enumok és állapotok

- `conversations.status`: `active` → `archived` (visszafordítható admin-művelettel). Az `archived` szál olvasható, de új üzenet nem fűzhető hozzá (`appendMessage` elutasít).
- `messages.role`: `user` | `agent` | `system` | `tool` — a `tool` a Tool Broker-fordulók explicit megjelenítéséhez (Fázis 2; MVP-ben `system`-ként összevonva is elfogadható).
- `messages.criticality` (Fázis 2): `L0` (olvasás/triviális) … `L3` (rendszerbe-írás/szabályozási hatás) — a kapu-eszkaláció bemenete (§5.6, 6.3).

---

## 4. Domain API / interfész

Standard válasz: `{ success: boolean, data?, error? }`. Minden belépés mintája: **auth-check (`requireRole`) → Zod-validáció → tenant-scope assert → domain-hívás → audit**. A `[szerep+]` a minimális RBAC-szint.

```
createConversation({ agentId, title? })
  -> { conversationId }                                   [operator+]
  -- új tartós szál; tenant_id és created_by a session-kontextusból; audit: conversation.create

appendMessage({ conversationId, role, content, actingUserId?, agentVersion?, model?, criticality? })
  -> { messageId, seq }                                   [belső; operator+ a user-üzenethez]
  -- seq szerveroldal allokálja (conversation_id, seq unique); content → content_ref + content_hash
  -- SOHA nem ír memory_versions-t (write-gate megkerülésének tilalma)
  -- audit: message.append (tartalom NEM a payloadban, csak ref/hash)

getConversation({ conversationId, limit?, beforeSeq? })
  -> { conversation, messages[], state }                  [viewer+, tenant-scope KÖTELEZŐ]
  -- lapozható visszaolvasás; törölt tartalmú üzenet csontvázként jön (content_deleted_at kitöltve)

listConversations({ agentId?, status?, mine?, limit?, cursor? })
  -> { conversations[], nextCursor? }                     [viewer+]
  -- tenant-scope; last_message_at desc; az activity feed alaplekérdezése (8.)

archiveConversation({ conversationId })
  -> { ok }                                               [operator+]
  -- status=archived; további appendMessage tiltott; audit: conversation.archive

deleteMessageContent({ messageId, reason })
  -> { ok }                                               [admin]
  -- GDPR-erasure: content_ref ürítés + content_deleted_at; csontváz + audit marad (N8)
  -- audit: message.content_deleted (ref/hash marad, payload nem)

deleteConversationContent({ conversationId, reason })
  -> { deletedCount }                                     [admin]
  -- a szál összes üzenetének tartalom-erasure-je egy tranzakcióban; audit per üzenet + összegző

promoteToTicket({ conversationId, fromMessageId?, type, reason })
  -> { ticketId }                                         [operator+]
  -- a beszélgetésből delegálás/ütemezés/jóváhagyás → ticket; ticket.conversation_id = forrás
  -- a forrás-message.ticket_ref beáll; audit: conversation.promote_to_ticket

assembleContext({ conversationId, agentId, budgetTokens? })   (belső, §5 motor)
  -> { messages[], memorySnapshotRef, documentRefs[], estimatedTokens }
  -- dispatch (§5.7) ELŐTTI lépés; NEM publikus művelet
```

**Megjegyzés az `askWiki`-hez (MVP, megmarad):** a beszélgetés-elsődleges wiki-flow változatlan — `askWiki({ agentId, question, conversationId? })` egy `conversation`/`message`-et hoz létre (új szál, ha `conversationId` nincs), nem automatikusan ticketet; ticket csak `promoteToTicket`-tel keletkezik. Ez a spec az `askWiki`-t nem írja át, csak a mögötte lévő store-t formalizálja.

---

## 5. Context assembly (rehydration) — a feature érdemi motorja

Mivel a harness **állapotmentes** (minden Goose-futás után eldobja magát), a beszélgetés folytonosságát minden dispatch elején a Control Plane store-jából **vissza kell tölteni**. A teljes előzmény visszatöltése drága és felesleges — ez közvetlenül token-ökonómia (koncepció §4.11) és progressive disclosure (§4.8.3) kérdés.

### 5.1 Mit állít össze

Az `assembleContext` három forrásból épít egy kontextus-csomagot, `budgetTokens` korlát alatt:

1. **Beszélgetés-fordulók (recency + relevancia):** az utolsó *N* forduló mindig (recency-ablak); efölött opcionálisan a korábbi, releváns fordulók behúzása. MVP-default: tiszta recency-ablak (utolsó N forduló), determinisztikus. Fázis 2: salience/relevancia-súlyozott válogatás (koncepció §4.6 salience-elv) — de a beszélgetés-előzmény **így sem** válik agent-memóriává.
2. **Agent-memória snapshot (read-only):** a `memory_versions` aktuális, jóváhagyott verziójának referenciája — **olvasásra**, a write-gate-en kívül. A context assembly soha nem ír memóriát.
3. **Dokumentum-referenciák:** a szálhoz/feladathoz kötött feltöltött dokumentumok aliasai (a Tool Brokeren át olvashatók, nem inline a promptban).

### 5.2 Token-budget és levágás

- A budget forrása: a ticket-/agent-szintű per-futás budget cap (§8.6) levezetett része. Ha a kontextus a budget fölé nőne, a **levágás determinisztikus és naplózott**: recency-ablak megtartása → korábbi fordulók kiesése → összefoglalt fordulók (Fázis 2: rolling summary) → audit-flag `context.truncated`.
- A levágás **soha nem dobja el** a kötelező rendszer-instrukciót (role + behavior profile) és a folyó user-kérést.

### 5.3 Reprodukálhatóság

Minden dispatch elején az összeállított kontextus **leírása** (mely `message.seq`-ek, mely `memory_version`, mely dokumentum-aliasok, becsült token) auditba kerül (`context.assembled`), így a futás utólag rekonstruálható — anélkül, hogy a (törölhető) tartalom az auditba kerülne. Ez a `model`/`agent_version` fordulónkénti rögzítésével együtt adja a teljes reprodukálhatóságot (§4.5).

### 5.4 Az acting user átadása

A `assembleContext` a sessionből kiolvasott `acting_user_id`-t **átadja a dispatchnek**, amely továbbadja a Tool Brokernek. A Broker a `user_delegated` connectorokat `(acting_user, connector)` függvényeként oldja fel (Per-user Connector spec §4.12.1). **Autonóm (scheduled/proaktív/agent→agent) futásnál** a per-user grant csak explicit, tárolt, visszavonható „run-as" felhatalmazással használható — a context assembly ilyenkor a `run_as` grantből, nem egy élő session-userből veszi az acting usert.

---

## 6. Invariánsok (kemény padlók)

### 6.1 Beszélgetés-memória ≠ agent-memória

Az `appendMessage` **soha** nem ír `memory_versions`-t. A beszélgetés folyó kontextusa scratch-kontextus; ha valamit be akarsz tanítani belőle az agentbe, az **tanítási ticket + jóváhagyás** (write-gate, §5.8). Ez kódszinten kikényszerített: az `appendMessage` domain-művelet nem kap memória-író repository-t. **Negatív teszt: N3** (beszélgetésből kért „tanuld meg" write-gate token nélkül nem ír).

### 6.2 A kötelező kapu nem a ticketen él

A magas kockázatú művelet attól, hogy direkt beszélgetésben (ticket nélkül) kérik, nem válik megkerülhetővé. A kaput szerveroldali policy dönti el:

- **rendszerbe-írás / memória-frissítés:** kizárólag write-gate token (§5.8) — beszélgetésből kért módosítás token nélkül blokk (N3);
- **eszközhívás:** Tool Broker `authorize()` deny-by-default (§5.5) — beszélgetésből kért jogosulatlan tool blokk (N2);
- **ticket-átmenet (ha van ticket):** állapotgép-szabály (§5.1).

**Negatív teszt: N7** — egy beszélgetésben (ticket nélkül) kért rendszerbe-író / memória-módosító lépés write-gate token / `authorize()` nélkül nem hajtódik végre, és a kísérlet auditba kerül — pontosan úgy, mintha ticketből kérték volna.

### 6.3 Kritikussági-szintezett eszkaláció (Fázis 2)

A `messages.criticality` (L0–L3, §5.6) alapján a magas szintű (L2/L3) művelet **automatikusan** jóváhagyási kapura eszkalál — a jóváhagyás felülete inline a beszélgetésben **vagy** ticket. Ez nem lazítja a 6.2 invariánst: a kemény kapuk (write-gate, Broker) akkor is élnek, ha a kritikussági-osztályozó téved; az L0–L3 csak **hozzáad** egy automatikus eszkalációs réteget.

### 6.4 Tenant-izoláció

Minden `conversations`/`messages` olvasás `tenant_id`-scope-olt; mivel az agentek sem oszthatók meg tenantok között (§8.8), a beszélgetés-tér is per-tenant zárt. Cross-tenant hozzáférési kísérlet szerveroldali elutasítás + `access.denied` audit. **Negatív teszt:** más tenant nem éri el a szálat.

---

## 7. Megőrzés, hozzáférés, GDPR-törlés

A beszélgetés a legnagyobb PII-felület (§0.7), ezért a retenció és a törlés first-class.

### 7.1 Megőrzés (retenció)

- A `retention_policies` (3.3) tenant-szintű default TTL-t ad; a `retain_until` a `last_message_at`-ből számolódik és minden új üzenetnél frissül.
- Egy **törlő-job** (a dispatcher-worker mellé szerelt ütemezett sweep, a Proaktív Monitor mintájára) periodikusan keresi a `retain_until < now() AND legal_hold = false` szálakat, és a tartalom-erasure-t (7.2) futtatja rájuk. A sweep **nem-LLM**, determinisztikus SQL.
- `legal_hold = true` esetén a retenció **nem törölhet** (jogi megőrzési kötelezettség) — felülírja a `retain_until`-t.

### 7.2 GDPR-erasure (a törlés mechanikája)

Az immutábilis audit és a törlési jog feszültségét a §8.5 szerint oldjuk fel: az **audit-metaadat** (megtörtént + hash-lánc) elválik a **törölhető tartalom-payloadtól**.

- `deleteMessageContent` / `deleteConversationContent`: a `content_ref` ürül, `content_deleted_at` beáll, de a `messages` rekord-csontváz (`id`, `seq`, `role`, `agent_version`, `model`, `content_hash`, `audit_event_ref`) és az `audit_log` **marad**.
- A `content_hash` megmarad: bizonyítja, hogy *volt* tartalom és mi volt a hash-e, de a szöveg már nem visszaállítható.
- **Invariáns (N8):** a tartalom-törlés után a `verifyChain` **zöld** — az audit-lánc integritása sértetlen, mert a payload sosem volt a láncban (csak a hash).

### 7.3 Hozzáférés

- Ki olvashat vissza egy szálat: RBAC szerint (`requireRole`), MVP-ben `viewer+` a tenanton belül.
- **Fázis 3:** erőforrás-szintű láthatóság — egy szál csak a `created_by` usernek + explicit megosztottaknak + adminnak látszik (presence/megosztás Fázis 3, ld. 1.2).

---

## 8. Activity feed — a session-store olvasónézete

Az activity feed **nem külön rendszer**, hanem a `conversations`/`messages` (+ a hozzájuk linkelt `model_calls`/`tool_calls`/audit) **olvasónézete**. A board (opcionális, követett munka) és a feed (mindig-megy, minden interakció) ugyanarra az auditált alaprétegre épül.

- **Lekérdezés:** `listConversations` + per-szál legutóbbi fordulók, `tenant_id`-scope, `last_message_at desc` kurzor.
- **Cél (üzleti):** az AI ne legyen láthatatlan háttérfolyamat (§0.5) — a feed garantálja, hogy minden interakció megjelenik, ticket nélkül is.
- **Teljesítmény:** a feed lapozott (kurzoros), nem tölt teljes előzményt; a törölt tartalmú üzenet a feedben is csontvázként jelenik meg.

---

## 9. Audit események

Az append-only, hash-láncolt audit (§8.5) a beszélgetés-rétegre kötelezően kiterjed. A **tartalom soha nem a payloadban** — csak ref/hash. Eseménytípusok:

```
conversation.create               { conversationId, agentId, tenantId, createdBy }
message.append                    { messageId, conversationId, seq, role, agentVersion?, model?, contentHash, actingUserId? }
context.assembled                 { conversationId, messageSeqs[], memoryVersion, documentAliases[], estimatedTokens }
context.truncated                 { conversationId, droppedSeqs[], reason, budgetTokens }
conversation.archive              { conversationId, by }
message.content_deleted           { messageId, conversationId, reason, by }      -- payload NEM, csak ref/hash marad
conversation.content_deleted      { conversationId, deletedCount, reason, by }
conversation.promote_to_ticket    { conversationId, fromMessageId?, ticketId, type, by }
access.denied                     { conversationId, attemptedBy, reason: cross_tenant | rbac }   -- tenant/RBAC sértés
retention.sweep                   { sweptCount, deletedCount }                   -- törlő-job (7.1)
```

Minden ticketless beszélgetés-végrehajtás is teljesen attribútálható: a `model_calls` / `tool_calls` `conversation_id`-n keresztül köthető (MVP-spec §4.8), `ticket_id` nélkül is.

---

## 10. RBAC összefoglaló

| Művelet | Min. szerep | Megjegyzés |
|---|---|---|
| `createConversation`, `appendMessage` (user-üzenet), `archiveConversation`, `promoteToTicket` | operator | tenant-scope kötelező |
| `getConversation`, `listConversations` (activity feed) | viewer | csak saját tenant; Fázis 3 erőforrás-szintű szűkítés |
| `deleteMessageContent`, `deleteConversationContent` | admin | GDPR-erasure; auditált |
| retenció-policy CRUD, `legal_hold` állítás | admin | tenant-szintű |

Cross-tenant hozzáférés minden szerepnél szerveroldali elutasítás + `access.denied` audit (6.4).

---

## 11. Hibakezelés és peremesetek

- **Párhuzamos append ugyanarra a szálra:** a `(conversation_id, seq)` unique constraint + szerveroldali `seq`-allokáció (SELECT … FOR UPDATE vagy szekvencia) → nincs duplikált sorrend; ütközéskor retry.
- **Archivált szálra append:** elutasítás (`conversation_archived`), nem hoz létre üzenetet.
- **Törölt tartalmú üzenet újraolvasása:** a `getConversation` csontvázat ad (`content_deleted_at` kitöltve), a kliens „[törölt tartalom]"-ként jeleníti meg; a context assembly a törölt fordulót kihagyja.
- **Context assembly üres szálon:** csak a rendszer-instrukció + folyó kérés kerül a kontextusba; nincs hiba.
- **Acting user nélküli autonóm futás `user_delegated` connectort hívna:** ha nincs `run_as` grant, a Tool Broker `authorize()` blokkol (Per-user Connector spec) — a beszélgetés-réteg nem ad implicit acting usert.
- **Legal hold alatt álló szál törlési kérése:** a retenció-sweep kihagyja; explicit admin GDPR-erasure esetén a rendszer figyelmeztet a legal hold ütközésére (Fázis 2: külön jóváhagyás).

---

## 12. Tesztterv

### 12.1 Kötelező negatív tesztek (governance-bizonyíték, §9.2)

- **N3** — beszélgetésből kért „tanuld meg" / memória-módosítás write-gate token nélkül **nem** ír `memory_versions`-t (6.1).
- **N7** — beszélgetésben (ticket nélkül) kért rendszerbe-író / memória-módosító lépés write-gate token / `authorize()` nélkül **nem** hajtódik végre; a kísérlet auditba kerül (6.2).
- **N8** — egy üzenet tartalmának törlése után a rekord-csontváz és a `verifyChain` ép; a `content_hash` megmarad, a payload nem (7.2).
- **Cross-tenant** — másik tenant `getConversation`/`listConversations` hívása elutasítás + `access.denied` audit (6.4).

### 12.2 Unit / acceptance

- `appendMessage` idempotencia és `seq` monotonitás párhuzamos hívásnál (11.).
- `assembleContext` recency-ablak + budget-levágás determinisztikus, és `context.assembled` / `context.truncated` auditot ad (5.2–5.3).
- Retenció-sweep: `retain_until` lejár → tartalom-erasure; `legal_hold = true` → kihagyva (7.1).
- `promoteToTicket`: a ticket `conversation_id`-je és a forrás `message.ticket_ref` helyesen linkel; audit (4., 9.).
- Activity feed kurzoros lapozása tenant-izolációval; törölt tartalom csontvázként (8.).

### 12.3 End-to-end (kipróbálható, ha)

A felhasználó végigvisz egy **beszélgetés-alapú** kérdés→válasz folyamatot **ticket nélkül**; minden lépése (model/tool-hívás) a `conversation_id`-n át auditban látszik; külön, ha az eredményt jóváhagyásra küldi, abból ticket lesz, ami a `conversation_id`-re visszahivatkozik; egy üzenet tartalmának törlése után a szál csontváza és a `verifyChain` ép; más tenant a szálat nem éri el.

---

## 13. Fázisok és szállítási sorrend

| Fázis | Leírás | Állapot |
|---|---|---|
| **CS-0 (MVP-horog)** | `conversations`/`messages` séma, tenant-scope, content/metadata szétválasztás, `askWiki` beszélgetés-elsődleges, N7/N8 invariáns | ✅ Kész (CR-MVP-003, D9) |
| **CS-A** | Teljes session-store API (`getConversation`, `listConversations`, `archiveConversation`, `deleteMessageContent`/`deleteConversationContent`, `promoteToTicket`) + audit-események | ⬜ Fázis 2 |
| **CS-B** | Explicit `assembleContext` motor: recency-ablak + budget-levágás + `context.assembled`/`context.truncated` audit + acting user átadás | ⬜ Fázis 2 |
| **CS-C** | Retenció: `retention_policies`, `retain_until`, `legal_hold`, törlő-sweep job | ⬜ Fázis 2 |
| **CS-D** | Activity feed olvasónézet (kurzoros, tenant-izolált) + Control Plane UI (lista, szál-nézet, tartalom-törlés) | ⬜ Fázis 2 |
| **CS-E** | Többszálú / több-agentes beszélgetés-UI + kritikussági-szintezett (L0–L3) automatikus kapu-eszkaláció + inline jóváhagyás | ⬜ Fázis 2 |
| **CS-F** | Fázis 3: erőforrás-szintű láthatóság / megosztás / presence; salience-súlyozott context assembly | ⬜ Fázis 3 |

---

## 14. Nyitott döntések

| # | Kérdés | Javasolt default | Validálandó |
|---|---|---|---|
| D-CS-1 | A `messages.role = tool` külön szerepként vagy `system`-ként összevonva? | MVP: `system`-ben összevonva; Fázis 2: külön `tool` szerep a Broker-fordulók explicit megjelenítéséhez | UI-igény az activity feedben |
| D-CS-2 | Context assembly válogatás: tiszta recency vagy salience-súlyozott? | MVP/CS-B: determinisztikus recency-ablak; salience Fázis 2, a memória-substrate döntésével együtt | Token-költség vs. minőség mérés egy valós szálon |
| D-CS-3 | Default retenció-TTL hossza | Tenant-konfigurálható; iparági default 90 nap, fizetési/szabályozott ügyfélnél felülírva | Ügyfél-DPA / GDPR-jogi review |
| D-CS-4 | A kritikussági-szint (L0–L3) forrása | MVP: nincs (kemény kapuk elégségesek, 6.2); Fázis 2: konfigurált hozzárendelés tickettípus/tool szerint; tanuló osztályozó később | Fázis 2 kapu-eszkaláció tervezésekor |
| D-CS-5 | `content_ref` tárhely (DB-blob vs. GCS) | GCS objektum tenant-prefixszel, a hash a DB-ben; nagy payloadhoz olcsóbb + külön törölhető | Infra-költség + erasure-garancia |

---

## 15. Definition of Done

A feature kész, ha: a teljes session-store API (4.) él és auditált; az `assembleContext` determinisztikus, budget-korlátos és reprodukálható (5.); a retenció + GDPR-erasure end-to-end működik és az N8 zöld (7.); az N3/N7/cross-tenant negatív tesztek zöldek (12.1); az activity feed és a beszélgetés-UI tenant-izoláltan lapoz (8., 13/CS-D); és a beszélgetésből promote-olt ticket a `conversation_id`-re visszahivatkozik (4.). Build + lint + tsc zöld, unit/acceptance tesztek zöldek.
