# Chat Agent-forduló ellenállóság + leállítás — fejlesztői specifikáció

Státusz: **DRAFT / kód nincs** · Verzió: v0.1 · Dátum: 2026-07-08
Scope: az interaktív **chat** (agent-chat) ág. A ticket/Folyamat (dispatcher) ág
külön, DB-perzisztált állapotgépen fut és nem tárgya ennek a specnek — csak
mintaként hivatkozunk rá.

---

## 1. Cél

Három, egymással összefüggő probléma megoldása az agent-chatben:

1. **Ne vesszenek el a beszélgetések.** Ha a felhasználó bezárja az ablakot,
   navigál, vagy hard-refresht csinál, miközben az agent dolgozik: a háttérmunka
   fusson tovább, a végeredmény kerüljön az adatbázisba, és visszatéréskor
   (előzmény-betöltéskor vagy reconnect-tel) legyen látható.
2. **Ne kerüljön a rendszer végtelen ciklusba.** A tool-loop legyen több
   dimenzióban korlátozott (kör, faliórai idő, tool-hívás-büdzsé, ismétlés,
   előrehaladás), és a beragadt futásokat egy watchdog zárja le.
3. **Legyen leállítás a chat képernyőn.** A felhasználó egy Stop gombbal
   megszakíthatja a futó agent-fordulót; a részeredmény őrződjön meg.

---

## 2. Jelenlegi állapot (kódalapú diagnózis)

### 2.1 Az agent-forduló a SSE-kapcsolathoz kötött

- Végpont: `app/src/app/api/v1/agent-chat/stream/route.ts` — `ReadableStream`
  `start(controller)` egy `for await (const event of gen)` ciklussal olvassa a
  `AgentChatRuntime.sendMessageStream` generátort, és `controller.enqueue`-val
  továbbítja a `data:` eventeket.
- `sendMessageStream` (`app/src/domain/agent/agent-chat-runtime.ts`, ~407–652):
  - a **user üzenet DB-be írása azonnal** megtörténik (`appendMessage`, ~466),
    tehát a kérdés soha nem vész el;
  - a tool-loop (`runAgentToolLoop`) egy **eagerly indított promise**
    (`resultPromise`, ~571) — a tényleges tool-mellékhatások (gmail_send,
    file_write, ticket_create…) a generátor `yield`-jeitől függetlenül lefutnak;
  - **DE a záró agent-üzenet DB-írása** (`appendMessage`, ~640) a generátor
    végén, több `yield` UTÁN történik. Ha a kliens lecsatlakozik, a route
    `for await`-ja megszakad → `gen.return()` → a generátor a soron lévő
    `yield`-nél véglegesen felfügged, a ~640 sori írás **soha nem fut le**.

**Következmény:** ablakbezárás / hard-refresh közben a tool-mellékhatások
megtörténnek, de a **végleges agent-válasz elveszhet** (nem íródik a `messages`
táblába), így visszatéréskor nem látszik. Az `activities` (agent-aktivitás
panel) is csak kliens-oldali React state — reconnect nélkül elvész.

### 2.2 Loop-védelem — ami már van

`runAgentToolLoop` (`chat-tool-loop.ts`, ~1338–1738):
- **`maxTurns`** — `resolveToolLoopMaxTurns`: `maxToolTurns` clamp [5,80], vagy
  40 ha `repo_prepare` engedélyezett, egyébként a belső default 20.
- **Repeated-call guard** — `REPEAT_LIMIT = 3` per `(toolName, JSON(args))`.
- **Kimerülés** — `TOOL_LOOP_EXHAUSTED_MESSAGE` + `status:'exhausted'`.

**Hiányzik:** faliórai időkorlát, globális tool-hívás-büdzsé (a kör-limit nem
fedi, mert egy körben több tool is hívható), előrehaladás-figyelés (nincs új
szöveg + ismétlődő eredmény), költség/token-plafon, és infra-szintű watchdog a
beragadt futásra.

### 2.3 Leállítás — nincs

- A `fetch` (`agent-chat-panel.tsx`, ~584) mögött **nincs `AbortController`**.
- `isAgentTyping` csak letiltja a szerkesztőt; nincs Stop gomb, nincs
  cancel-végpont, a loopnak nincs megszakítási jele.

---

## 3. Tervezési elvek és döntések

> A megoldás magja: **az agent-forduló váljon első osztályú, perzisztált,
> újracsatlakoztatható „futássá" (AgentTurn)** — ahogy a ticket/Folyamat ág is
> DB-perzisztált. Az SSE ne a munka *hajtóereje* legyen, hanem *nézet* a futás
> fölött.

| # | Döntés | Választás | Indok |
|---|--------|-----------|-------|
| **D1** | Mi a perzisztencia egysége? | Új **`AgentTurn`** rekord fordulónként | A `messages` végállapot; kell egy köztes, élő rekord a progress/kontroll tárolásához. |
| **D2** | A végeredmény DB-írása mihez kötött? | A **loop-lezáró finalizerhez**, NEM a stream-fogyasztáshoz | Ez zárja le a 2.1 rést. A finalizer a `resultPromise` completion-jén fut, kliens nélkül is. |
| **D3** | Ki „birtokolja" a végrehajtást? | **Detached run-manager**, a kéréstől függetlenül | Ablakbezárás ne állítsa le a munkát. |
| **D4** | Reconnect hogyan? | Új **GET SSE** végpont, ami előbb *snapshotot* küld (perzisztált partialText+activities+status), majd élő deltát | Hard-refresh után folytatólagos nézet. |
| **D5** | A kliens-lecsatlakozás == cancel? | **NEM.** Csak az explicit Stop gomb cancel | A cél épp a háttér-folytatás; a véletlen disconnect nem szándéknyilvánítás. |
| **D6** | Stop szemantika | **Kooperatív**: a loop a `cancelRequested` flaget ellenőrzi kör-határon és tool-hívás előtt; a részeredményt megőrzi | Determinisztikus, nincs félbehagyott tool. Egy már elindult tool-hívás befejeződik, új nem indul. |
| **D7** | Egy beszélgetésen egyszerre hány aktív forduló? | **Egy.** Második POST aktív forduló alatt elutasítva (409) | Egyszerű mentális modell; nincs versengő írás a `messages`/`seq`-re. |
| **D8** | Deployment-topológia | **Tier-1 (in-process)** először, **Tier-2 (dispatcher-birtokolt, DB-lock+heartbeat)** a robusztus célállapot | Fázisozható; a Tier-2 tükrözi a meglévő ticket-dispatchert (lock_token+stale reclaim). |
| **D9** | Token-perzisztencia granularitás | Throttle-flush (`partialText` ~1 mp / N token), activity-nként upsert, terminálkor teljes írás | Reconnect-snapshot DB-túlterhelés nélkül. |
| **D10** | Beragadt futás | **Watchdog**: `heartbeatAt` régebbi a küszöbnél → `failed`/`exhausted` + finalizálás | Infra-szintű végtelen-ciklus / crash-védelem. |
| **D11** | Visszamenőleges kompatibilitás | ~~A `sendMessage` (nem-stream) útvonal is a finalizeren keresztül ír~~ → **a `sendMessage` út törölve** (2026-07-18) | Egységes írási pont, ne duplázódjon a logika. A felülvizsgálat kimutatta, hogy a nem-stream útnak *soha* nem volt hívója (se UI, se API route — csak a hálózatról elérhető `sendAgentMessage` server action és egy teszt), viszont párhuzamos életciklust tartott életben. A törlés a D11 célját közvetlenebbül éri el. |

---

## 4. Adatmodell — `AgentTurn`

Új Prisma modell (`prisma/schema.prisma`). A mezőnév-konvenció a meglévő
`Ticket`/`ScheduledTask` mintát követi (`lock_token`, `locked_at`).

```prisma
enum AgentTurnStatus {
  queued        // létrejött, még nem indult a loop
  running       // tool-loop fut
  streaming     // loop kész, a záró szöveg streamelése zajlik (opcionális átmenet)
  completed     // sikeres, assistant üzenet perzisztálva
  exhausted     // guard állította le (max_turns / wallclock / budget), részválasz megőrizve
  cancelled     // felhasználó Stop- olta
  failed        // hiba / watchdog általi lezárás
}

model AgentTurn {
  id                 String   @id @default(uuid()) @db.Uuid
  conversationId     String   @map("conversation_id") @db.Uuid
  tenantId           String?  @map("tenant_id") @db.Uuid
  agentId            String   @map("agent_id") @db.Uuid
  agentVersion       Int      @map("agent_version")
  createdById        String   @map("created_by") @db.Uuid

  status             AgentTurnStatus @default(queued)
  userMessageId      String?  @map("user_message_id") @db.Uuid  // foglaláskor még üres (#61)
  assistantMessageId String?  @map("assistant_message_id") @db.Uuid

  // Progress / reconnect-snapshot
  partialText        String   @default("") @map("partial_text")
  activities         Json     @default("[]")           // ToolLoopActivityEvent[]

  // Loop-elszámolás
  turnCount          Int      @default(0) @map("turn_count")
  toolCallCount      Int      @default(0) @map("tool_call_count")
  deniedCount        Int      @default(0) @map("denied_count")

  // Kontroll
  cancelRequested    Boolean  @default(false) @map("cancel_requested")
  cancelRequestedById String? @map("cancel_requested_by") @db.Uuid
  cancelRequestedAt  DateTime? @map("cancel_requested_at") @db.Timestamptz

  // Életciklus / lock (Tier-2)
  lockToken          String?  @map("lock_token")
  lockedAt           DateTime? @map("locked_at") @db.Timestamptz
  heartbeatAt        DateTime @default(now()) @map("heartbeat_at") @db.Timestamptz
  startedAt          DateTime @default(now()) @map("started_at") @db.Timestamptz
  finishedAt         DateTime? @map("finished_at") @db.Timestamptz
  reason             String?                            // max_turns_exhausted | wallclock_timeout | tool_budget | no_progress | cancelled | watchdog | error
  error              String?

  createdAt          DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt          DateTime @updatedAt @map("updated_at") @db.Timestamptz

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)

  @@index([conversationId, status])
  @@index([status, heartbeatAt])       // watchdog
  @@map("agent_turns")
}
```

> **Állapot (2026-07-18, issue #59 — MEGÉPÜLT).** A modell, a
> `0009_agent_turn` migráció, az `AgentTurnRepository` (létrehozás, lock,
> heartbeat, terminális lezárás, stale-lekérdezés) és a chat-runtime rekord-írása
> kész. Az aktív-forduló invariánst a migráció `agent_turns_active_per_conversation_key`
> RÉSZLEGES EGYEDI INDEXE kényszeríti ki (valódi Postgres ellen tesztelve:
> `scripts/agent-turn-repository.test.ts`, a CI `migrations` jobjában).
> A forduló-rekord írása **fail-soft**: ez a lépés megfigyelhetőséget szállít, a
> chat viselkedése változatlan — a finalizer (D2) és a reconnect (D4) a lánc
> további tiketjei.
>
> **Állapot (2026-07-18, issue #61 — MEGÉPÜLT).** A D7 kikényszerítése a
> kérés-úton kész. A forduló-rekord létrehozása FELCSERÉLŐDÖTT a user-üzenet
> perzisztálásával: előbb a foglalás (ezen csattan a részleges egyedi index),
> csak utána az üzenet, amit a `attachUserMessage` köt a rekordhoz — így az
> elutasított küldés nem hagy árva üzenetet. Az `agent_turns.user_message_id`
> ezért NULLABLE lett (`0010_agent_turn_reservation`). Ütközéskor a runtime
> `conflict` eseményt ad, amit a stream-route a SSE-válasz megnyitása ELŐTT
> (a generátor első eseményét lehúzva) `409 { activeTurnId, conversationId }`-ra
> fordít. A NEM-ütközéses rekord-hibák továbbra is fail-softak.
> Tesztek: E5 párhuzamos küldés a stub-suite-ban (`agent-chat-turn-record.test.ts`)
> és valódi Postgres ellen (`agent-turn-repository.test.ts`, `Promise.allSettled`).

Kapcsolódás: `Conversation` kap egy `agentTurns AgentTurn[]` relációt.
A `messages` tábla változatlan; a `Message` a végállapot, az `AgentTurn` a
lezáráskor `assistantMessageId`-vel mutat rá.

**Aktív-forduló invariáns (D7):** legfeljebb egy `AgentTurn` lehet
`queued|running|streaming` státuszban egy `conversationId`-hez. Kényszerítés:
részleges egyedi index vagy tranzakciós ellenőrzés a létrehozáskor.

---

## 5. Végrehajtási életciklus

### 5.1 Indítás — `POST /api/v1/agent-chat/stream` (módosított)

1. Auth (mint ma).
2. **Aktív-forduló ellenőrzés = FOGLALÁS (D7):** az `AgentTurn` létrehozása
   (`status: running`) MAGA az ellenőrzés — a részleges egyedi index dönt, nem egy
   előzetes lekérdezés. Ütközésnél `409` + `{ activeTurnId }` (a kliens erre
   reattach-el, l. 6.3).
3. `AgentChatRuntime`: user üzenet perzisztálása, majd `userMessageId` bekötése a
   lefoglalt fordulóhoz. A sorrend (foglalás → üzenet) szándékos: az elutasított
   küldés így nem hagy árva felhasználói üzenetet a beszélgetésben.
4. **Detached indítás:** a `AgentTurnRunner.start(turnId)` beteszi a futást egy
   in-process registrybe (`Map<turnId, RunHandle>`), és **nem** `await`-eli a
   loop teljes lefutását a kérés-scope-ban.
5. A POST-válasz SSE **feliratkozik** a futás in-process event-buszára és relézi
   az eventeket (`activity`/`token`/`done`/`error`). Ha a kliens lecsatlakozik,
   a feliratkozás megszűnik, **de a futás megy tovább** (D3/D5).

### 5.2 A runner és a loop

- `AgentTurnRunner` egy `EventEmitter`-szerű buszt tart fordulónként; a
  `runAgentToolLoop` `onActivity`-je ide push-ol, és bevezetünk egy `onToken`
  callbacket a záró szöveg streameléséhez (ma a szó-chunkolás a runtime-ban van;
  átkerül a runnerbe).
- **Finalizer (D2):** a `resultPromise` completion-jén (siker/hiba egyaránt) a
  runner:
  1. `appendMessage(role:'agent', content: reply)` — a végleges üzenet (a
     content a meglévő content-store úton, `contentRef`/`contentHash`);
  2. `AgentTurn` → `completed|exhausted|cancelled|failed`, `assistantMessageId`,
     `finishedAt`, `reason` beállítása;
  3. `done` event a buszra (ha van feliratkozó);
  4. registry-ből törlés.
  Ez a pont **kliens-független** → a válasz sosem vész el.
- **Heartbeat (Tier-2, D10):** a loop minden kör elején `heartbeatAt = now()`.

> **Állapot (2026-07-18, issue #60 — MEGÉPÜLT).** A futás leválik a kérésről:
> `AgentTurnRunner` (`src/domain/agent/agent-turn-runner.ts`) tartja a futásonkénti
> buszt, a `AgentChatRuntime.beginTurn` a kérés-scope-ban előkészít és **claimeli**
> a fordulót (a rekord a `lockToken`-nel jön létre), majd a `executeTurn` a
> kérés-scope-on KÍVÜL fut. A végleges assistant-üzenet írása és a rekord terminális
> lezárása az `executeTurn` `finally`-ágában van — akkor is lefut, ha senki nem
> olvassa a streamet (E1-regresszió: `scripts/agent-chat-turn-record.test.ts`).
> A `sendMessage` (nem-stream) ugyanezen a ponton ír (D11). A stream legelső
> eseménye `{ type:'turn', turnId }` (§6.1). A heartbeat a tool-loop új
> `onTurnStart` horgán megy körönként.
> Eltérések a fenti tervtől: (a) a szó-chunkolás a runtime-ban maradt (a runner
> eseménytípus-agnosztikus busz, nem tud a tokenekről); (b) a `turnId` a
> perzisztált rekordé, de ha a rekord nem jött létre (nincs bekötött tár vagy
> DB-zavar), folyamat-lokális azonosítót kap, hogy a stream-szerződés alakja stabil
> legyen; (c) a route `after()`-rel tartja életben a futást a válasz lezárása után
> is, hogy menedzselt futtatókörnyezetben se fagyjon be az instance.
> Nyitva marad: a fordulóhoz kötött Stop (#65), a visszacsatlakozás (#66) és a kliens (#67).

### 5.3 Perzisztencia-granularitás (D9)

- `activities`: minden `emitActivity`-nél upsert az `AgentTurn.activities`-be
  (kis frekvencia, tool-hívásonként).
- `partialText`: throttle-flush — max ~1 mp-enként vagy ~200 karakterenként.
- Terminálkor: teljes `partialText` + `messages` írás.

> **Állapot (2026-07-19, issue #63 — MEGÉPÜLT).** A futó forduló köztes
> snapshotja innentől DB-ből visszaolvasható. `TurnSnapshotFlusher`
> (`agent-turn-snapshot.ts`) tartja a fojtást (`PARTIAL_TEXT_FLUSH_INTERVAL_MS=1000`,
> `PARTIAL_TEXT_FLUSH_CHARS=200`) és a tartalom-őrt (`guardTurnPartialText` =
> `redactSensitiveText`, Q4). Az `AgentTurnRepository.updateProgress` a lock
> birtokosának ír aktív fordulóra; a runtime az aktivitásokat eseményenként, a
> részszöveget fojtva, terminálkor a teljes őrizett szöveget írja. A
> visszacsatlakozó felület (#66) még nyitott — ez a tiket a visszaolvasható
> állapotot szállítja.
> Tesztek: `npm run test:agent-turn-snapshot`, bővített
> `test:agent-turn-record` (mid-run visszaolvasás, PAN-őr, írási frekvencia).

---

## 6. SSE / API felület

### 6.1 `POST /api/v1/agent-chat/stream` — indít + tail (élő)
Mint 5.1. Új eventtípus: `{ type: 'turn'; turnId }` legelöl, hogy a kliens
ismerje a `turnId`-t (a Stop és a reconnect ehhez kell).

### 6.2 `POST /api/v1/agent-chat/turns/[turnId]/cancel` — Stop (D6)
- Auth + tulajdon-ellenőrzés (a forduló `createdById`/tenant).
- `cancelRequested=true`, `cancelRequestedBy/At` beállítása.
- Ha a runner in-process elérhető: azonnali in-memory jelzés is (gyorsabb, mint
  a DB-poll). Tier-2-ben a loop DB-ből is olvassa a flaget.
- Válasz: `202 Accepted`. A tényleges leállás a loop következő ellenőrzési
  pontján történik; a `done` event `reason:'cancelled'`-del jön.

### 6.3 `GET /api/v1/agent-chat/turns/[turnId]/stream` — reconnect (D4)
- Első event: **snapshot** — `{ type:'snapshot', status, partialText, activities }`.
- Ha a forduló még aktív: feliratkozás az élő buszra (Tier-1), majd ha az élő
  stream terminális `done`/`error` nélkül zárul, DB-poll fallback a
  `partialText`/`activities`/`status` deltájára (~750 ms). Tier-2-ben a
  reconnect közvetlenül DB-pollból indul.
- Ha már terminál: snapshot + `done`, majd zárás.

### 6.4 `GET /api/v1/agent-chat/turns?conversationId=…&active=1` — van-e futó?
- A kliens a beszélgetés betöltésekor ezzel dönti el, kell-e reattach.

---

## 7. Loop-védelem (2. pillér)

Egyetlen, tesztelhető döntéshozó a loop tetején és minden tool-hívás előtt:

```ts
type StopDecision =
  | { continue: true }
  | { continue: false; reason: 'max_turns_exhausted' | 'wallclock_timeout'
        | 'tool_budget' | 'no_progress' | 'cancelled' }

function evaluateLoopContinuation(state): StopDecision
```

Ellenőrzött feltételek:

1. **`cancelled`** — `cancelRequested` (in-memory jel vagy DB-flag).
2. **`max_turns_exhausted`** — meglévő `maxTurns` (változatlan).
3. **`wallclock_timeout`** — `Date.now() - startedAt > maxWallClockMs`
   (konfigurálható; default ~180_000 ms). Kör elején és hosszú tool-hívás után
   is ellenőrizve.
4. **`tool_budget`** — `toolCallCount >= maxToolCalls` (default ~60), a kör-limittől
   függetlenül (egy körben több tool is futhat).
5. **`no_progress`** — N (default 3) egymást követő kör, amelyben nincs új
   asszisztens-szöveg ÉS csak már látott eredményt adó tool-hívás van. A meglévő
   `REPEAT_LIMIT`-et kiegészíti (az per-args, ez per-kör aggregált).
6. **(opcionális) `cost_budget`** — ha a gateway usage-t ad vissza, kumulált
   token/költség-plafon.

Leálláskor a loop **gráceful finalizál**: a `messages` közé kerül a részleges
válasz + állapot-jelölő (pl. „⏹️ Leállítva — a részeredmény megőrizve", ill.
kimerülésnél a meglévő `TOOL_LOOP_EXHAUSTED_MESSAGE`), és a `reason` az
`AgentTurn`-re íródik.

### 7.1 Megvalósítva (2026-07-19, issue #62)

- Döntéshozó: `app/src/domain/agent/loop-stop-decision.ts` —
  `evaluateLoopContinuation` (tiszta függvény: nincs I/O, nincs `Date.now()`),
  mellette `trackTurnProgress` az előrehaladás-mérleghez és `describeLoopStop`
  a hétköznapi nyelvű jelöléshez.
- A loop (`chat-tool-loop.ts`) a **kör elején** és **minden tool-hívás előtt**
  megkérdezi. Tool-hívás közbeni leálláskor a már kiadott, de le nem futott
  hívásokra kimaradás-jelző tool-üzenet megy (a modell-előzmény konzisztens marad).
- Leálláskor gráceful finalizálás: záró modellhívás → a részválasz **megmarad**,
  és alá kerül az önmagyarázó jelölés (mi ért véget, mi maradt, hogyan tovább).
  A `max_turns_exhausted` ág szövege és viselkedése **változatlan**.
- A leállás indoka a forduló-rekordra (`AgentTurn.status='exhausted'` +
  `reason`) íródik az `agent-chat-runtime`-ból; a ticket-ág a meglévő
  `TOOL_LOOP_EXHAUSTED` hibakódot kapja a pontosabb `reason`-nel.
- Küszöbök (agent-szintű `modelConfig` mező → env → alapérték, clamp-elve):

  | Küszöb | `modelConfig` | Env | Alapérték |
  |---|---|---|---|
  | faliórai idő | `maxToolWallClockMs` | `AGENT_LOOP_MAX_WALLCLOCK_MS` | 180 000 ms |
  | tool-büdzsé | `maxToolCalls` | `AGENT_LOOP_MAX_TOOL_CALLS` | 60 hívás |
  | előrehaladás-hiány | `maxNoProgressTurns` | `AGENT_LOOP_MAX_NO_PROGRESS_TURNS` | 3 kör |

- Teszt: `npm run test:loop-stop` (`scripts/loop-stop-decision.test.ts`) —
  determinisztikus, hamis modell-kapuval és injektált órával, mindhárom új
  feltételre plusz a változatlan kör-limit ágra. CI-ben fut.
- **Nyitva marad:** a `cost_budget` (opcionális 6. feltétel).

**Watchdog (D10):** a meglévő dispatch-ciklus reclaim-fázisa az
`AgentTurn` táblát is nézi: `status ∈ {queued,running,streaming}` ÉS
`heartbeatAt < now() - staleMs` → `failed`, `reason:'watchdog'`,
`finishedAt=now()`, lock elengedés, és lezáró agent-üzenet a beszélgetésbe
(részszöveg megőrzésével). Küszöb: `AGENT_TURN_STALE_MS` (alapértelmezés
120_000 ms). A ciklus-összegzés `reclaimedAgentTurns` mezője az admin
dispatcher-felületen látszik.

> **Állapot (2026-07-19, issue #64 — MEGÉPÜLT).** `reclaimStaleAgentTurns`
> (`agent-turn-watchdog.ts`) a `runDispatchCycle` reclaim-fázisában fut
> (ticket- és scheduled-task reclaim után). A lazy reclaim az indítási úton
> (`agent-chat-runtime`) ugyanazt a `resolveStaleTurnMs()` küszöböt használja.
> Teszt: `npm run test:agent-turn-watchdog` (E6 + friss heartbeat ellenpróba).

---

## 8. Frontend változások (`agent-chat-panel.tsx`)

### 8.1 Stop gomb (3. pillér)
- Futás alatt (`isAgentTyping`) a **Küldés** gomb helyén/mellett **Stop**
  (`⏹️ Leállítás`) jelenik meg.
- Kattintás → `POST …/turns/{activeTurnId}/cancel`. `activeTurnId` a stream
  első `turn` eventjéből (6.1).
- A gomb `pending` állapotot mutat, amíg a `done`(cancelled) meg nem érkezik.
- A `fetch`-hez **`AbortController`** is kell — de csak a *kliens-oldali*
  olvasás megszakítására (pl. bezárás), ami **nem** cancel-eli a szervert (D5).
  A szerver-cancel kizárólag a Stop-végponton át.

### 8.2 Reconnect visszatéréskor (1. pillér UI-oldala)
- A beszélgetés megnyitásakor / `selectSession` után:
  1. `getConversationMessages` betölti a perzisztált előzményt (mint ma);
  2. `GET …/turns?conversationId=…&active=1` — ha van aktív forduló, a kliens
     `GET …/turns/{turnId}/stream`-mel reattach-el: snapshot (partialText +
     activities) a megfelelő agent-buborékba, majd élő delta a `done`-ig.
- Ha nincs aktív forduló: a végállapot már a `messages`-ben van, nincs teendő.

### 8.3 Optimista buborék egyeztetése
- A jelenlegi `optimistic-agent-*` buborékot a `turn` event `turnId`-jével
  társítjuk, hogy reconnect és Stop után is a helyes buborék frissüljön.

### 8.4 Megvalósított átmeneti lépés — kliens-oldali finalizálás (utólagos kiegészítés — 2026-07-12)

A teljes D2/D4 (szerver-oldali `AgentTurn` + loop-finalizer + reconnect GET-SSE) még nem épült meg. Előtte **átmeneti, kizárólag kliens-oldali** védelem került az `agent-chat-panel.tsx`-be: `finalizeInterruptedStream()`.

- **Mit csinál:** ha a stream terminál-esemény (`done`) nélkül szakad meg, **és** a felhasználói üzenet már perzisztálódott (`persistedUserMessageId` megvan), akkor az optimista agent-buborékot nem dobja el (`removeFailedOptimisticMessages`), hanem **megtartja** a részleges szöveget / activity-ket; ha nincs részszöveg de van activity, egy „⏳ A válaszfolyam megszakadt…" jelzőt tesz be.
- **Mit NEM old meg:** ez a §2.1-ben leírt rést csak a **még nyitott panelen** enyhíti; hard-refresh / navigáció után a részeredmény továbbra is elvész, mert a §2.1 végén jelzett módon a partial csak kliens-React-state. A tartós megoldás továbbra is a **D2 loop-finalizer** (szerver-oldali perzisztencia) + **D4 reconnect** — ezt ez a lépés **nem** váltja ki, csak áthidalja.
- **DoD-viszony:** a §4 `AgentTurn` tábla, a §5.2 finalizer és a §6.3 reconnect-végpont **nyitott** marad; a 8.4 nem zárja azokat.

---

## 9. Edge case-ek

| # | Eset | Elvárt viselkedés |
|---|------|-------------------|
| E1 | Ablakbezárás loop közben | Loop tovább fut; finalizer perzisztál; visszatéréskor `messages`-ből látszik. |
| E2 | Hard-refresh loop közben | 8.2 reattach: snapshot + élő delta; ha épp lezárult, a kész üzenet a historyban. |
| E3 | Stop kattintás | Következő ellenőrzési ponton leáll; részeredmény + jelölő perzisztálva; `cancelled`. |
| E4 | Stop egy már elindult tool-hívás közben | Az adott tool befejeződik (mellékhatás megtörténhet); új tool nem indul; utána finalize. |
| E5 | Dupla küldés / két tab | Második POST `409` + `activeTurnId`; a kliens reattach-el, nem indít újat (D7). |
| E6 | Szerver-crash loop közben | Watchdog lezárja (`failed`); a beszélgetés nem marad örökké „gépel" állapotban. |
| E7 | Végtelen tool-ciklus | 7. guard (turns/wallclock/budget/no_progress) leállítja `exhausted`-del. |
| E8 | Reconnect terminál futásra | Snapshot + `done` azonnal; nincs lógó SSE. |
| E9 | Tenant/tulajdon-idegen cancel/reattach | 403; a forduló `createdById`+tenant ellenőrzött. |
| E10 | Több app-instance (Tier-1) | Reattach csak azonos instance-en él; ezért Tier-2 a skálázható cél (8. WP). Tier-1-ben fallback: perzisztált snapshot poll. |
| E11 | Folyamat-trigger ág (`tryStartChatTriggeredProcess`) | Változatlan: az már a Folyamat-futásra delegál, a válasz rövid; forduló-perzisztencia nem szükséges, de a finalizer-út közös. |

---

## 10. Deployment-topológia (D8)

- **Tier-1 (in-process runner).** A runner-registry + event-busz a Node
  processben él. „Háttér folytatódik" = amíg a process él. Reattach csak azonos
  instance-en élő buszról; több instance esetén a reattach a perzisztált
  snapshotra + DB-pollra esik vissza. Elég a jelenlegi (jellemzően single-node /
  self-host) üzemhez, és ez az első szállítható increment.
- **Tier-2 (dispatcher-birtokolt).** A forduló futtatását egy worker veszi fel
  `lock_token` + `heartbeatAt` alapon (ahogy a ticket-dispatcher), a DB az
  igazság forrása; bármely instance ki tudja szolgálni a reattach SSE-t
  DB-pollból. A watchdog reclaim-eli a stale futásokat. Ez a horizontálisan
  skálázható, crash-túlélő célállapot (a web-process újraindulása után is
  folytatható/lezárható a forduló).

---

## 11. Munkacsomagok

**1. hullám — perzisztencia + no-loss (Tier-1)**
- **WP-1** `AgentTurn` modell + migráció + repository. — **KÉSZ (#59)**
- **WP-2** `AgentTurnRunner` (registry, busz, **finalizer** = D2 rés lezárása);
  `sendMessageStream` átkötése a finalizerre (a `sendMessage` út törölve — lásd D11). — **KÉSZ (#60)**
- **WP-3** `POST stream` átalakítás detached indításra + `turn` event. — **KÉSZ (#60)**

**2. hullám — védelem**
- **WP-4** `evaluateLoopContinuation` (wallclock + tool_budget + no_progress) a
  meglévő maxTurns/REPEAT_LIMIT mellé.
- **WP-5** Watchdog (stale `AgentTurn` reclaim) + gráceful finalize. — **KÉSZ (#64)**

**3. hullám — kontroll + reconnect UI**
- **WP-6** `cancel` végpont + loop cancel-ellenőrzés (D6).
- **WP-7** `GET turns/[id]/stream` (snapshot+delta) + `GET turns?active=1`.
- **WP-8** Frontend: Stop gomb, AbortController, reattach a session-betöltésbe.

**4. hullám — skálázás (opcionális, ha kell)**
- **WP-9** Tier-2: dispatcher-birtokolt futtatás lock+heartbeat, DB-poll reattach.

---

## 12. Tesztelési terv

- **Finalizer-perzisztencia:** loop lefut, a fogyasztó (generátor/subscriber)
  eldobva → az agent-üzenet mégis a `messages`-ben (E1).
- **Guardok:** wallclock/tool_budget/no_progress unit-teszt determinisztikus
  fake gateway-jel; `exhausted` + `reason` helyes.
- **Cancel:** `cancelRequested` → a loop a következő ponton leáll, részszöveg
  megőrizve, `cancelled` (E3); tool-közbeni cancel nem hagy félbe tool-t (E4).
- **Aktív-forduló invariáns:** párhuzamos POST → `409` (E5).
- **Watchdog:** heartbeat-elöregített forduló → `failed` (E6).
- **Reattach:** aktív fordulóra GET stream snapshot+delta; terminálra azonnali
  `done` (E2/E8).
- **Jogosultság:** idegen tenant cancel/reattach → 403 (E9).

---

## 13. Nyitott kérdések

- **Q1 (D8):** Elég-e most a **Tier-1** (single-node feltételezés), vagy
  rögtön a **Tier-2** dispatcher-birtokolt futtatás kell? (Prod topológia kérdése.)
- **Q2:** A záró szöveg streamelése is a fordulóhoz kötött legyen-e (streaming
  státusz), vagy elég a loop-eredményt egyben perzisztálni és a reattach csak a
  kész szöveget mutatja? (Élmény vs. egyszerűség.)
- **Q3:** Kell-e a felhasználónak **explicit „folytatom a háttérben" jelzés**
  bezáráskor (pl. toast), vagy legyen néma a háttér-folytatás?
- **Q4:** A `partialText` perzisztálás alóli kivétel — tartalom-guard /
  redakció (a `messages` content-store úton megy; a `partial_text` nyers). Kell-e
  ugyanaz a content-guard a köztes snapshotra is?
  → **LEZÁRVA (issue #63):** igen — `guardTurnPartialText` / `redactSensitiveText`
  a köztes és a terminális `partialText` íráson is.

---

## 14. Futás-diagnosztika (issue #180 — MEGÉPÜLT, 2026-08-02)

**Üzleti probléma.** Egy elszaladt agent-futás után a kérdés mindig ugyanaz:
*mi történt, és miért ennyibe került?* A mért esetben (2026-07-29,
`/tulajdoni-lap-egyeztetés`) a válasz a DB-ből **nem volt kikövetkeztethető** —
a diagnózist a beszélgetés-export activity-naplójából kellett kinyerni. Ennek két
következménye volt: egy drága futás okát kézi nyomozás derítette fel, és nem volt
mire riasztást tenni, tehát ugyanaz a hiba hat futáson át csendben megismétlődött.

### 14.1 Forduló-számlálók (WP-1)

- A `turn_count` / `tool_call_count` / `denied_count` a lezáráskor **és menet
  közben** is íródik: a `runAgentToolLoop` `onTurnStart` horga a kör eleji állást
  is átadja, a runtime pedig `updateProgress`-szel írja ki. Egy FUTÓ forduló így
  nem mutat nullát — épp akkor látszik, min megy el a keret, amikor még be lehet
  avatkozni.
- Elfogadás: `npm run test:tool-loop` („WP-1: az onTurnStart a kör eleji
  számlálókat is átadja").

### 14.2 `ModelCall` forduló-kötés és cache-számok (WP-2)

- Migráció: `0023_model_call_turn_binding` — `model_calls.agent_turn_id`
  (nullable FK, `ON DELETE SET NULL`) és `model_calls.cached_prompt_tokens`.
- A forduló azonosítója a `ToolLoopContext.agentTurnId` mezőn át megy a
  gateway-hívásokba (a tool nélküli `callStream` ág is megkapja), és mind a négy
  `modelCalls.create` hívási hely kitölti.
- Ezután a per-forduló költség és a cache-találat **egyetlen lekérdezés**:

  ```sql
  select agent_turn_id, sum(prompt_tokens), sum(cached_prompt_tokens)
    from model_calls group by 1;
  ```

- `cached_prompt_tokens IS NULL` = a provider nem ad cache-telemetriát
  („nincs adat" ≠ „nem volt találat").

### 14.3 Belső eszközhívások naplózása (WP-3)

- A `tool_result_read` és a `load_skill` nem a brokeren megy át, ezért eddig
  egyáltalán nem került a `tool_calls` táblába — a mért futásban 244 olyan hívás
  futott, amiről a DB nem tudott, és épp ezek okozták a kárt.
- Mindkettő (a fékbe futott, kimaradt visszaolvasás is) `tool_calls` sort ír,
  `policy_decision: 'internal'` jelöléssel, `args_meta`-ban az útvonallal /
  skill-verzióval és a visszaadott karakterszámmal.
- Metrika: `agent_internal_tool_calls_total{tool,status}`.

### 14.4 Forrás-újraolvasási arány és riasztás (WP-4)

- Döntéshozó: `app/src/domain/agent/turn-cost-signals.ts` —
  `evaluateTurnCostSignals` (tiszta függvény), a `loop-stop-decision.ts`
  forrás-számvitelére épülve, ezért **tool-független**: a fájl-újraolvasásra és a
  dokumentum-lapozásra ugyanúgy érvényes, mint az archívum-visszaolvasásra.
- Kör záráskor `agent.tool_loop.turn_cost_signals` (info) vagy
  `agent.tool_loop.turn_cost_alert` (**warn**) megy a naplóba, a becsült
  újraolvasási token-költséggel.
- Riasztási okok és küszöbök (env-ből hangolhatók, kikapcsolni nem lehet):

  | Ok | Küszöb | Env |
  |---|---|---|
  | `source_reread_ratio` | > 50% (min. 6 eszközhívás a körben) | `AGENT_TURN_REREAD_RATIO_ALERT`, `AGENT_TURN_MIN_TOOL_CALLS_FOR_RATIO` |
  | `compaction_steps` | > 10 tömörítési lépés | `AGENT_TURN_COMPACTION_STEPS_ALERT` |
  | `missing_tool_results` | kiadott hívás, nulla könyvelt eredmény | — |

- Metrikák: `agent_turn_source_reread_ratio` (hisztogram),
  `agent_turn_cost_alerts_total{reason,mode}`.
- Elfogadás: `npm run test:turn-cost` — a mért eset (132/149 = 89%) riaszt, egy
  normál, 3–5 eszközhívásos forduló nem.

## 15. Tartós bemenet és közös futtatómag (issue #516 / #508 WP-1+WP-2 — MEGÉPÜLT, 2026-09-17)

A forduló futása többé nem a kérés-scope-ban előkészített memóriabeli `PreparedTurn`-ből, hanem a rekordra mentett, verziózott bemenetből indul — így másik processzben is rekonstruálható.

| Elem | Hol | Mit csinál |
|---|---|---|
| `AgentTurn.input` (JSONB) | `0049_agent_turn_input` | `chat-turn-input.ts` `v: 1` séma: szöveg, csatolmány-id-k, projektkulcs, folyamat-bemenet, briefing, folytatás-jelzők, privát `modelContextPrefix`. Titok/token NEM kerül bele. A kliens-snapshot (`GET turns`, reconnect `snapshot`) mezőnként válogat, az `input`-ot sosem adja ki. |
| Gyors fogadás | `AgentChatRuntime.beginTurn` | agent/tenant/access-ellenőrzés → rekord `queued` + `input` (D7 részleges egyedi index) → user-üzenet → `attachUserMessage` (NEM fail-soft) → `launcher.launch`. DB-hiba = `error` esemény `turn`/`meta` nélkül; rekord nélkül nincs futás. |
| `ChatTurnLauncher` | `chat-turn-launcher.ts` | Indítási határ; `launchId` ≠ tulajdonos-token. v1: `in-process` (Tier-1 runner). `CHAT_TURN_LAUNCHER_MODE` ismeretlen értéke bootkor hiba. |
| Közös mag | `AgentChatRuntime.runReservedTurn({ turnId, launchId }, emit?)` | DB-ből tölt → `parseStoredTurnInput` (ismeretlen verzió → `StoredTurnInputError`, nem claimel) → atomi `claim` (`queued → running`, saját `ownerToken`) → tenant-újraellenőrzés, csatolmány/workspace előkészítés → `executeTurn` → tokenes `finalize`. Vesztes claim mellékhatás nélkül kilép. |
| Tulajdonosság | `AgentTurnRepository.claim / heartbeat / updateProgress / finalize(…, lockToken)` | Mind feltételes írás. `null` → `ownershipLost`; a következő checkpoint (`onTurnStart` — MÉG a kör modellhívása előtt) `TurnOwnershipLostError`-ral áll le: nincs új modell-/tool-hívás, nincs lezáró üzenet a beszélgetésbe (az a tényleges tulajdonosé), a rekord végállapotát nem írja felül. |

Ismert korlát: a tool-hívás AbortSignal-ja még nem végigvezetett a broker minden handlerén — a modellhívást a maradék falióra megszakítja (`AbortSignal.timeout(remaining)` a `gateway.call`-on). A tool-eredményt a broker `ToolCall` rekordja őrzi akkor is, ha a tulajdonjog közben elveszett.

Tesztek: `test:chat-turn-input` (séma, leak, launcher-mód), `test:agent-turn-record` (új processz rekonstrukció, dupla indítás, ismeretlen verzió, tulajdonvesztés), `test:agent-turn` (valódi Postgres: párhuzamos claim, régi tulajdonos, tokenes finalize).
