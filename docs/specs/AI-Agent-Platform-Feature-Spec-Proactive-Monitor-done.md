# Feature-spec — Proaktív Monitor-Agent (szűrt, csendes figyelés)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-21
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (§4.11.4, §4.11.6, §4.11.7, §8.6, §11.5), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (v1.0, §5.7 dispatcher, §15.4 scheduled tasks), `AI-Agent-Platform-Feature-Spec-PerUser-Connector.md` (v1.0)
**Olvasó:** fejlesztő(k). Feltételezi a Ticket-állapotgép, a `DispatcherService`, a `ScheduledTask` runtime, a Tool Broker + Model Gateway és az append-only audit ismeretét.
**Státusz:** **Fázis 2 — kész.** A **PM-A…PM-H elkészült** (a valós értesítő adapterrel együtt). Az „Implementációs állapot” szekció naprakész.

---

## Implementációs állapot (2026-06-29)

**Összefoglaló:** A **PM-A + PM-B + PM-C + PM-D + PM-E (UI) + PM-F (értesítési adapter alap) + PM-G (`mailbox_count` Tool Broker capability) elkészült**. A teljes kétlépcsős söprés-motor (deadline + board-backlog + connector-count Tool Broker collector), a determinisztikus szűrő-DSL, a dedup/cooldown, a dispatcher kill-switch + intervallum + concurrency `PlatformSetting`-en át, a globális monitor kill-switch (`monitor.kill_switch`), a tenant-izolált monitor collectorok és monitor-ticketek, a teljes Control Plane UI (`/control-plane/monitors` lista + szerkesztő + dry-run + futásnapló + jel-cooldown tábla), a server actions, a rendszer-oldal monitor-vezérlő panel, az auditált, alapértelmezésben audit-only értesítési adapter és a Gmail-alapú read-only postafiók-darabszám capability. `npm run test:monitor` + lint + tsc zöld.

### Fázisok

| Fázis | Leírás | Állapot |
|---|---|---|
| **PM-A** | Adatmodell + determinisztikus söprés-motor (nem-LLM, 1. lépcső) + deadline-collector + dedup/catch-up/dupla-fire + worker | ✅ Kész |
| **PM-B** | További collectorok (`board-backlog` — elakadt ticketek, `connector-count` stub) | ✅ Kész |
| **PM-C** | LLM-eszkaláció (`escalateAgentId`) end-to-end + dispatch-budget cap (meglévő dispatcher-en át) | ✅ Kész |
| **PM-D** | Globális kill-switch + intervallum + concurrency-cap a `PlatformSetting`-ben + dispatcher worker kill-switch check | ✅ Kész |
| **PM-E** | Control Plane UI (lista + szerkesztő + dry-run + futásnapló + jel-cooldown) + rendszer-oldal vezérlő panel | ✅ Kész |
| **PM-F** | Opcionális értesítési adapter interfész + audit-only referencia + `monitor.notify.sent/failed` audit | ✅ Kész |
| **PM-G** | Dedikált read-only Tool Broker `mailbox_count` capability + `connector_count` collector bekötés | ✅ Kész |
| **PM-H** | Valós értesítő adapter (allowlistolt chat-webhook) + provider-routing a `notify` interfész mögé | ✅ Kész |

### Elkészült fájlok (PM-A)

- `app/prisma/schema.prisma` — `MonitorDefinition`, `MonitorRun`, `MonitorSignal`, `MonitorKind/Status/RunOutcome/CatchupPolicy` enumok, `TicketType.monitor_alert`
- `app/src/domain/monitor/monitor-service.ts` — `MonitorService` (sweepDue, runSweep, computeNextSweepAt, reclaimStaleLocks)
- `app/src/domain/monitor/filter-eval.ts` — determinisztikus szűrő-DSL kiértékelő
- `app/src/domain/monitor/collectors/types.ts`, `collectors/deadline-collector.ts`
- `app/src/repositories/postgres/monitor-repository.ts` + `interfaces/index.ts` (`MonitorRepository`)
- `app/src/repositories/postgres/index.ts`, `app/src/domain/index.ts` — bekötés (`services.monitors`)
- `app/scripts/dispatcher-worker.ts` — söprés-tick a dispatch-ciklusban
- `app/scripts/monitor-engine.test.ts` + `package.json` `test:monitor`
- `app/prisma/seed.ts` — minta `deadline` monitor
- `app/src/domain/ticket/ticket-type-config.ts`, `system/ticket-type-config-panel.tsx`, `lib/validators/actions.ts`, `actions/platform.ts` — `monitor_alert` típus átvezetés
- `app/prisma/schema.prisma`, `app/src/repositories/postgres/ticket-repository.ts` — `Ticket.tenantId` + tenant-szűrt ticket-listázás a monitor izolációhoz

### Elkészült fájlok (PM-B…PM-E)

- `app/src/domain/monitor/collectors/board-collector.ts` — elakadt awaiting_human/ready ticketek (belső, read-only)
- `app/src/domain/monitor/collectors/connector-count-collector.ts` — Tool Broker `mailbox_count` capability-n át működő postafiók-darabszám collector
- `app/src/repositories/interfaces/index.ts` — `StaleBacklogTicket`, `UpdateMonitorInput` típusok; `update`, `findRuns`, `findSignalsByMonitor`, `collectStaleBacklogTickets` metódusok
- `app/src/repositories/postgres/monitor-repository.ts` — fenti metódusok implementálva
- `app/src/domain/monitor/monitor-service.ts` — `getById`, `update`, `revoke`, `listRuns`, `listSignals`, `dryRun` metódusok
- `app/src/domain/platform-settings/platform-settings-service.ts` — `MonitorControls`, `getMonitorControls`, `isMonitorEnabled`, `setMonitorControls`
- `app/scripts/dispatcher-worker.ts` — `isMonitorEnabled()` kill-switch check beágyazva
- `app/src/domain/index.ts` — `BoardBacklogCollector` + `ConnectorCountCollector` regisztrálva
- `app/src/app/actions/monitor.ts` — server action-ök (CRUD, dry-run, controls)
- `app/src/lib/validators/actions.ts` — monitor sémák: `createMonitorSchema`, `updateMonitorSchema`, `monitorIdSchema`, `monitorDryRunSchema`, `setMonitorControlsSchema`
- `app/src/app/control-plane/monitors/page.tsx` — monitor lista oldal
- `app/src/app/control-plane/monitors/new/page.tsx` — új monitor létrehozás
- `app/src/app/control-plane/monitors/[monitorId]/page.tsx` — részletek + szerkesztő + dry-run + futásnapló
- `app/src/components/monitors/monitor-list.tsx` — lista + toggle/revoke
- `app/src/components/monitors/monitor-run-log.tsx` — futásnapló táblázat
- `app/src/components/monitors/monitor-editor-form.tsx` — CRUD form (JSON DSL szerkesztő)
- `app/src/components/monitors/dry-run-panel.tsx` — próba-futás UI
- `app/src/app/control-plane/system/monitor-control-panel.tsx` — kill-switch + intervallum + concurrency vezérlő
- `app/src/app/control-plane/system/page.tsx` — MonitorControlPanel bekötve
- `app/src/app/control-plane/layout.tsx` — „Monitorok” nav item
- `app/scripts/dispatcher-worker.ts` — monitor `killSwitch`, `sweepIntervalSec`, `maxConcurrent` runtime betartása; kill-switch esetén `monitor.sweep.skipped` audit
- `app/scripts/monitor-engine.test.ts` — szűrő/catch-up unit-tesztek + deadline/board-backlog collector tenant-izolációs tesztek
- `app/src/lib/notify/monitor-notifier.ts` — értesítési adapter interfész + audit-only referencia implementáció
- `app/src/domain/monitor/monitor-service.ts` — `notifyChannel` eszkaláció utáni bekötés, `monitor.notify.sent/failed` audit, `monitorRunId` + `dedupKey` provenance a ticket payloadban
- `app/scripts/monitor-engine.test.ts` — értesítési adapter unit-teszt
- `app/src/domain/tool-broker/tool-broker-service.ts` — `mailbox_count` capability, policy + audit + Gmail végrehajtás
- `app/src/domain/connector-grant/gmail-api-client.ts`, `gmail-scopes.ts` — Gmail darabszám lekérdezés + read-only scope ellenőrzés
- `app/src/harness/platform-mcp-bridge.ts`, `app/src/lib/validators/actions.ts`, `app/prisma/seed.ts` — `mailbox_count` tool schema, MCP-lista és seed capability
- `app/scripts/monitor-engine.test.ts` — `connector_count` collector Tool Broker unit-teszt

### Elkészült fájlok (PM-H — valós értesítő adapter)

- `app/src/lib/notify/monitor-notifier.ts` — `providerFromChannel` + `targetFromChannel` export, `RoutingMonitorNotifier` (csatorna-provider szerinti útválasztás, audit-only fallback)
- `app/src/lib/notify/webhook-chat-notifier.ts` — valós chat-értesítő (Slack/Teams/Google Chat incoming-webhook `{text}` JSON POST). A webhook URL **allowlistolt env-ből** (`MONITOR_NOTIFY_WEBHOOK_<KULCS>`) jön, nem a channel-stringből (SSRF-védelem, deny-by-default egress); csak `https`; board-ticket link a `NEXT_PUBLIC_APP_URL`-ből; best-effort timeout
- `app/src/domain/index.ts` — `RoutingMonitorNotifier({ chat: WebhookChatNotifier }, AuditOnlyMonitorNotifier)` bekötve a `MonitorService`-be
- `app/src/components/monitors/monitor-editor-form.tsx` — `chat:<kulcs>` formátum súgó az értesítési csatorna mezőnél
- `app/scripts/monitor-engine.test.ts` — webhook chat (env-allowlist POST + board-link, be nem kötött kulcs hibázik, nem-https tiltott) + routing (chat→webhook, email→fallback) unit-tesztek

> **Governance megjegyzés:** a Tool Broker `gmail_send` capability **emberi jóváhagyást** követel (`approved` ticket + `gmailSendApproved` egyezés), ezért autonóm monitor-értesítésre szándékosan nem alkalmas. Az értesítés ezért külön, platform-szintű, allowlistolt webhook-csatornán megy (best-effort, board-ra mutató figyelemfelhívás — §7), az agent-akciók jóváhagyási kapuja érintetlen marad.

### Hátralévő / nyitott

- Nincs ismert blokk. (Opcionális jövőbeli bővítés: SMTP e-mail adapter `nodemailer`-rel a `MonitorNotifier` interfész mögé, ha a chat-webhook mellé közvetlen e-mail is kell.)

---

## 0. Mit ad ez a dokumentum

Meghatározza, hogyan kap a platform **proaktív, csendes figyelő képességet**: determinisztikus, ütemezett söprés gyűjti és szűri a jeleket (közelgő határidők, várakozó/elakadt ticketek, eltérés-számlálók, postafiók-darabszám), és **csak ténylegesen fontos esemény esetén** nyit naplózott, jóváhagyás-köteles tickettet a boardon (és opcionálisan küld értesítést). A feature az `AI-Agent-Platform-Koncepcio.md` §4.11.7 „Proaktív monitor (heartbeat) — szűrt, csendes figyelés” és a §11.5 use case dev-ready lebontása.

**A feature lényege a token-ökonómia megtartása (§4.11.1 elv):** kétlépcsős felépítés — az 1. lépcső **nulla LLM-token** (sima SQL + szabály), a drága LLM csak releváns jelnél indul.

**Miért ez az első Fázis-2 feature:**
- **Önmagában eladható** a mid-market szegmensnek: „az agent figyeli a határidőket / a postaládát / az eltéréseket, és magától szól, ha beavatkozás kell.”
- **Keresztbe erősíti** a §11.2 (e-mail-triage) és §11.3 (agrár határidő-asszisztens) use case-eket — gyakran azok proaktív „motorja”.
- **A meglévő architektúrára épül**, nem épít párhuzamos rendszert: a `ScheduledTask` recurrence-motor, a `DispatcherService` claim/budget logika és az audit újrahasznosul.

---

## 1. Scope

### 1.1 In scope (a feature teljes megvalósítása — Fázis 2)

1. **Monitor-definíció** mint elsőrendű, verziózott, admin által paraméterezhető entitás (mit figyel, milyen küszöbbel, milyen frekvenciával, mit tesz találatkor).
2. **Kétlépcsős söprés-motor:**
   - 1. lépcső: determinisztikus, nem-LLM **signal collector** + **szűrő-kiértékelés**.
   - 2. lépcső: csak találatnál **ticket-nyitás** (`source = system`) és/vagy **LLM-összefoglaló agent** indítása a `DispatcherService`-en át.
3. **Signal collectorok** (MVP-kör): board-jelek (várakozó/elakadt ticket), határidő-jelek (`due_by`, scheduled task `next_run_at`), connector-darabszám (postafiók-elemszám) — mind a **Tool Brokeren át**.
4. **Riasztás-fáradtság elleni kontroll:** konfigurálható küszöb, csendes alapállapot, **dedup / cooldown** (ugyanaz a jel ne nyisson ismételt tickettet egy ablakon belül).
5. **Üzemi finomságok (§4.11.7):** catch-up ablak újraindításkor, catch-up policy, **dupla-fire védelem** (utolsó-futás nyilvántartás + lock), jitter + concurrency-cap, UTC tárolás / lokális megjelenítés.
6. **Költségkorlát:** monitor-frekvencia + per-futás budget cap (§4.11.4 / §8.6) — a 2. lépcső LLM-futása a meglévő dispatch-budget alá esik.
7. **Értesítési csatorna** (opcionális, kiegészítő): e-mail/chat jelzés a ticketre — az **elsődleges, auditált felület a board** marad.
8. **Control Plane UI:** monitor-lista, szerkesztő, próba-futás (dry-run), futásnapló.
9. **Audit:** minden söprés, minden szűrő-döntés (eszkalált / elnyomott), minden nyitott ticket az append-only láncba kerül.

### 1.2 Out of scope (most NEM)

- **Általános anomália-detektálás / ML-alapú jelszűrés** — az MVP szűrő **determinisztikus szabály** (küszöb/összehasonlítás), nem tanuló modell.
- **Új connector típusok** (pl. ERP, naptár) tényleges integrációja — a collectorok a **meglévő** connectorokra építenek; új connector külön spec.
- **Real-time push (webhook-alapú azonnali trigger)** külső rendszerből — az MVP **pull/sweep** alapú (§4.11.2 cron „valódi funkcióvá”). Webhook-bemenet a Fázis 3.
- **Önálló értesítési termék** (Telegram-bot, mobil push) — az MVP egy **egyszerű adapter-interfész** + e-mail referencia-implementáció; a csatornák bővítése külön munka.
- **Cross-tenant aggregált monitor** — minden monitor egy tenanthez kötött.

### 1.3 Az MVP-re gyakorolt hatás

A feature **additív**: nem módosítja az MVP wiki-agent flow-t, és nem lazítja a governance-t. Új táblák, egy új nem-LLM söprő worker (vagy a meglévő dispatcher worker mellé szerelt ütemezett job), és új UI-route. A meglévő dispatch-lánc, budget cap és audit változatlanul újrahasznosul. A monitor által nyitott ticket **ugyanaz a jóváhagyás-köteles entitás**, mint bármely más ticket.

---

## 2. Hogyan illeszkedik a meglévő architektúrához

```
            ┌──────────────────────────────────────────────────────────┐
            │  Monitor Sweep Worker  (nem-LLM, ütemezett — §4.11.6)     │
            │  intervallum: PlatformSetting (runtime állítható)         │
            └──────────────────────────────────────────────────────────┘
                                   │  minden esedékes MonitorDefinition-re
                                   ▼
        ┌─────────────── 1. LÉPCSŐ (nulla LLM-token) ───────────────┐
        │  collectorok (Tool Brokeren át) → MonitorSignal[]          │
        │  filter-eval (determinisztikus küszöb/DSL)                 │
        │  dedup / cooldown ellenőrzés                               │
        └────────────────────────────┬──────────────────────────────┘
                       nincs találat  │  van „fontos” találat
                  (csendes — MonitorRun=quiet)
                                      ▼
        ┌─────────────── 2. LÉPCSŐ (csak releváns jelnél) ──────────┐
        │  Ticket létrehozása (source=system, type=monitor_alert)   │
        │     ├─ execute_after / due_by a jel alapján               │
        │     └─ opcionális: agent hozzárendelés → DispatcherService│
        │  (LLM-token csak itt, a meglévő budget cap alatt)         │
        │  opcionális értesítés (e-mail/chat) → a ticketre mutat    │
        └───────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                 Board (elsődleges, auditált felület)  +  AuditLog (lánc)
```

**Kulcs-újrahasznosítások:**

| Meglévő elem | Mire használja a monitor |
|---|---|
| `ScheduledTask` recurrence-motor (`addRecurrence`, `next_run_at`, lock) | A monitor-definíció ütemezése ugyanazon a `next_run_at` + lock mintán; nincs új cron-infra. |
| `DispatcherService` (claim, budget cap, audit, kill-switch) | A 2. lépcső LLM-agentje a meglévő dispatch-láncon fut, a meglévő budgettel. |
| `Ticket` (`source = system`, `execute_after`, `due_by`, `lock_token`) | A monitor által nyitott ticket — semmi új mező nem kell a tickethez. |
| `Tool Broker` (`platform-mcp-bridge`, capability-policy) | Minden signal-gyűjtés a Tool Brokeren át (nincs közvetlen rendszer-elérés — §4.11.7 kötelező kontroll). |
| `AuditLog` (hash-láncolt) | Söprés, szűrő-döntés, ticket-nyitás, értesítés — mind naplózott. |
| `PlatformSetting` (kill-switch + intervallum) | Globális monitor kill-switch + söprés-frekvencia runtime állítása a `/control-plane/system` oldalról. |

---

## 3. Adatmodell (Postgres / Prisma)

### 3.1 Új enumok

```prisma
enum MonitorKind {
  board_backlog      // várakozó/elakadt ticketek figyelése
  deadline           // közelgő due_by / scheduled task határidők
  connector_count    // postafiók / forrás darabszám küszöb
  composite          // több collector AND/OR kombinációja (Fázis 2.5)
}

enum MonitorStatus {
  active
  paused
  revoked
}

enum MonitorRunOutcome {
  quiet              // lefutott, nem talált említésre méltót (csendes alapállapot)
  escalated          // találat → ticket nyílt (és/vagy agent indult)
  suppressed         // találat volt, de cooldown/dedup elnyomta
  skipped            // kill-switch / paused / budget miatt nem futott érdemben
  error              // collector vagy kiértékelés hibázott
}

enum MonitorCatchupPolicy {
  run_late           // kihagyott ablak késve lefut
  skip               // kihagyott ablak elhagyandó (pl. elavult napi zárás)
}
```

`TicketType`-hez (meglévő enum) hozzáadandó: **`monitor_alert`** — a proaktívan nyitott ticket típusa, hogy a board szűrhető legyen és külön playbook köthető hozzá.

### 3.2 `MonitorDefinition` (a figyelő-szabály)

```prisma
model MonitorDefinition {
  id                String                @id @default(uuid()) @db.Uuid
  tenantId          String                @map("tenant_id") @db.Uuid
  kind              MonitorKind
  status            MonitorStatus         @default(active)
  version           Int                   @default(1)        // verziózott (mint az agent role/behavior)
  title             String
  description       String?

  // Ütemezés (§4.11.6) — UTC-ben tárolva
  intervalSeconds   Int                   @map("interval_seconds")        // söprés-frekvencia
  nextSweepAt       DateTime              @map("next_sweep_at") @db.Timestamptz
  lastSweepAt       DateTime?             @map("last_sweep_at") @db.Timestamptz
  activeWindowCron  String?               @map("active_window_cron")      // pl. csak munkaidőben (opc.)
  catchupPolicy     MonitorCatchupPolicy  @default(run_late) @map("catchup_policy")
  catchupWindowSec  Int                   @default(900) @map("catchup_window_sec")  // 15 perc

  // 1. lépcső — szűrő-konfiguráció (determinisztikus DSL, lásd §5)
  collectorConfig   Json                  @default("{}") @map("collector_config")
  filterConfig      Json                  @default("{}") @map("filter_config")

  // Riasztás-fáradtság elleni kontroll
  cooldownSeconds   Int                   @default(86400) @map("cooldown_seconds")  // ugyanaz a jel ne ismétlődjön (24h)
  dedupKeyTemplate  String?               @map("dedup_key_template")                // pl. "deadline:{ticketId}"

  // 2. lépcső — eszkalációs akció
  openTicketType    TicketType            @default(monitor_alert) @map("open_ticket_type")
  escalateAgentId   String?               @map("escalate_agent_id") @db.Uuid        // ha van: LLM-összefoglaló agent
  perRunBudgetUsd   Decimal?              @map("per_run_budget_usd") @db.Decimal(10, 4)  // 2. lépcső budget cap
  notifyChannel     String?               @map("notify_channel")                    // pl. "email:ops@..." (opc.)

  // Lock (dupla-fire védelem — §4.11.7)
  lockToken         String?               @map("lock_token")
  lockedAt          DateTime?             @map("locked_at") @db.Timestamptz

  createdById       String                @map("created_by") @db.Uuid
  createdAt         DateTime              @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime              @updatedAt @map("updated_at") @db.Timestamptz

  escalateAgent     Agent?                @relation(fields: [escalateAgentId], references: [id])
  createdBy         User                  @relation(fields: [createdById], references: [id])
  runs              MonitorRun[]
  signals           MonitorSignal[]

  @@index([status, nextSweepAt])
  @@index([tenantId, status])
  @@map("monitor_definitions")
}
```

### 3.3 `MonitorRun` (egy söprés végrehajtás — audit-mag)

```prisma
model MonitorRun {
  id                 String             @id @default(uuid()) @db.Uuid
  monitorId          String             @map("monitor_id") @db.Uuid
  outcome            MonitorRunOutcome
  startedAt          DateTime           @default(now()) @map("started_at") @db.Timestamptz
  finishedAt         DateTime?          @map("finished_at") @db.Timestamptz
  scheduledFor       DateTime           @map("scheduled_for") @db.Timestamptz   // melyik periódus-példányt zárta le
  signalCount        Int                @default(0) @map("signal_count")        // összegyűjtött jelek
  matchedCount       Int                @default(0) @map("matched_count")       // küszöböt átlépő jelek
  suppressedCount    Int                @default(0) @map("suppressed_count")    // cooldown miatt elnyomott
  openedTicketIds    String[]           @map("opened_ticket_ids") @db.Uuid
  llmInvoked         Boolean            @default(false) @map("llm_invoked")     // futott-e a 2. lépcső LLM
  costUsd            Decimal?           @map("cost_usd") @db.Decimal(10, 4)
  error              String?

  monitor            MonitorDefinition  @relation(fields: [monitorId], references: [id], onDelete: Cascade)

  @@index([monitorId, startedAt])
  @@unique([monitorId, scheduledFor])   // dupla-fire védelem: egy periódus-példány csak egyszer
  @@map("monitor_runs")
}
```

> **`@@unique([monitorId, scheduledFor])`** a §4.11.7 „dupla-fires védelem (kritikus)” adatbázis-szintű garanciája: ugyanaz a periódus-példány nem futhat kétszer, akkor sem, ha két worker versenyez vagy a cron-háló is elkapja.

### 3.4 `MonitorSignal` (cooldown / dedup nyilvántartás)

```prisma
model MonitorSignal {
  id              String            @id @default(uuid()) @db.Uuid
  monitorId       String            @map("monitor_id") @db.Uuid
  dedupKey        String            @map("dedup_key")            // pl. "deadline:<ticketId>"
  firstSeenAt     DateTime          @default(now()) @map("first_seen_at") @db.Timestamptz
  lastSeenAt      DateTime          @default(now()) @map("last_seen_at") @db.Timestamptz
  lastEscalatedAt DateTime?         @map("last_escalated_at") @db.Timestamptz
  escalatedTicketId String?         @map("escalated_ticket_id") @db.Uuid
  severity        Int               @default(0)                  // a kiértékelt súlyosság (rendezéshez)
  payload         Json              @default("{}")               // a jel pillanatképe (audithoz)

  monitor         MonitorDefinition @relation(fields: [monitorId], references: [id], onDelete: Cascade)

  @@unique([monitorId, dedupKey])
  @@index([monitorId, lastEscalatedAt])
  @@map("monitor_signals")
}
```

> A **cooldown** logika: a 2. lépcső csak akkor eszkalál egy jelet, ha `lastEscalatedAt` `NULL`, vagy `now - lastEscalatedAt > cooldownSeconds`. Így ugyanaz a közelgő határidő nem nyit naponta új tickettet.

---

## 4. A söprés-motor (`monitor-service.ts`)

### 4.1 Worker-illesztés (1. lépcső ütemezése)

A determinisztikus söprést **nem új cron-rendszer** futtatja, hanem a meglévő dispatcher worker mintáját követő ütemezett job (`monitor-sweep-worker.ts`). Két opció (D-PM-1 döntés, lásd §11):

- **(A) A `wiki-dispatcher` Cloud Run service-be ágyazva** — a meglévő `LISTEN/NOTIFY + cron` worker mellé egy második, alacsony frekvenciás tick. Előny: nincs új deploy-artefakt, közös health-szerver és kill-switch.
- **(B) Külön Cloud Run Job/Scheduler** — tisztább izoláció, de új infra.

**Javaslat: (A)** az MVP-hez — a monitor söprés ugyanolyan olcsó SQL-tick, mint a scheduled-task materializáció, és a §15 szerint a production dispatcher már always-on (`minScale=1`).

A tick algoritmusa (nulla LLM-token):

```
minden T tick-nél (intervallum = PlatformSetting 'monitor.sweep_interval_sec', default 60):
  ha PlatformSetting 'monitor.kill_switch' == true: return (audit: monitor.sweep.skipped)
  due = SELECT * FROM monitor_definitions
        WHERE status='active' AND next_sweep_at <= now()
        ORDER BY next_sweep_at
        LIMIT batch  FOR UPDATE SKIP LOCKED      // claim + dupla-fire védelem
  minden M in due:
     claim(M)  → lockToken + lockedAt
     runSweep(M, now)
     release(M)  → next_sweep_at = computeNext(M, now)  (jitter + catchup, §4.4)
```

`FOR UPDATE SKIP LOCKED` + `lock_token` a két-worker verseny ellen (a `ScheduledTask` repository ugyanezt a mintát használja).

### 4.2 `runSweep(M, now)` — a kétlépcsős mag

```
function runSweep(M, now):
  scheduledFor = M.nextSweepAt (a lezárandó periódus-példány)

  // dupla-fire: ha erre a periódusra már van MonitorRun, kilépünk (idempotencia)
  if exists MonitorRun(M.id, scheduledFor): return  // unique kulcs garancia

  run = createMonitorRun(M, scheduledFor, outcome=quiet)

  try:
    // ---- 1. LÉPCSŐ (nem-LLM) ----
    signals = collect(M)                       // §5 — Tool Brokeren át
    matched = filterEval(M.filterConfig, signals)   // determinisztikus küszöb
    run.signalCount = signals.length
    run.matchedCount = matched.length

    if matched.empty:
        run.outcome = quiet                    // CSENDES — a feature lényege
        return finalize(run)

    // ---- cooldown / dedup ----
    toEscalate = []
    for s in matched:
        key = renderDedupKey(M.dedupKeyTemplate, s)
        sig = upsertSignal(M, key, s)          // first/last seen frissítés
        if sig.lastEscalatedAt == null OR (now - sig.lastEscalatedAt) > M.cooldownSeconds:
            toEscalate.push((s, sig))
        else:
            run.suppressedCount++

    if toEscalate.empty:
        run.outcome = suppressed
        return finalize(run)

    // ---- 2. LÉPCSŐ (csak itt mehet el token) ----
    for (s, sig) in toEscalate:
        ticket = openTicket(M, s)              // source=system, type=monitor_alert
        run.openedTicketIds.push(ticket.id)
        sig.lastEscalatedAt = now; sig.escalatedTicketId = ticket.id

        if M.escalateAgentId:                  // opcionális LLM-összefoglaló
            assignAndDispatch(ticket, M.escalateAgentId, budget=M.perRunBudgetUsd)
            run.llmInvoked = true

        if M.notifyChannel:
            notify(M.notifyChannel, ticket)     // kiegészítés; a board az elsődleges

    run.outcome = escalated
    return finalize(run)

  catch e:
    run.outcome = error; run.error = e.message
    audit('monitor.sweep.error', M, e)
    return finalize(run)
```

**Megjegyzés a token-ökonómiához:** ha `escalateAgentId` üres, a monitor **LLM nélkül** is teljes értékű — pusztán tickettet nyit a board-jellel. Az LLM-összefoglaló opcionális dúsítás (pl. „3 számla eltérése: …”), és a meglévő dispatch-budget cap alatt fut.

### 4.3 Eszkaláció → ticket (`openTicket`)

A monitor-ticket a **meglévő Ticket-entitás**, semmi új mező:

| Ticket mező | Érték |
|---|---|
| `source` | `system` (meglévő enum-érték) |
| `type` | `M.openTicketType` (alapból `monitor_alert`) |
| `title` | a jel sablonjából (pl. „Közelgő határidő: <ticketcím> (<dueBy>)”) |
| `payload` | a jel pillanatképe + `monitorId` + `monitorRunId` + `dedupKey` (provenance) |
| `execute_after` | a jel alapján (pl. azonnal, vagy a releváns időpont előtt) |
| `due_by` | a jel `due_by`-ja, ha van (öröklődik a figyelt entitástól) |
| `createdById` | a monitor-definíció `createdById`-ja (rendszer-aktor proxy) |
| `state` | `backlog` → a normál állapotgépen halad tovább, **jóváhagyás-köteles marad** |

A ticket a normál állapotgépen megy (`backlog → ready → ...`); a „proaktív” csak az **indítás** módja. Az emberi jóváhagyási kapuk nem lazulnak (§4.11.7 kötelező kontroll).

### 4.4 Catch-up, jitter, dupla-fire (üzemi finomságok — §4.11.7)

**`computeNext(M, now)`** a következő söprés időpontját számolja:

```
base = M.nextSweepAt + M.intervalSeconds
if base < now - M.catchupWindowSec:
    // a rendszer leállt, a periódus-példány az ablakon kívülre csúszott
    if M.catchupPolicy == skip:  base = next aligned slot >= now   // kihagyjuk
    else (run_late):             base = now                        // késve, de egyszer lefut
jitter = random(0, min(intervalSeconds * 0.1, 30s))   // terheléscsúcs simítás
return base + jitter
```

- **Catch-up ablak:** újraindításkor a `next_sweep_at <= now` feltétel automatikusan elkapja az esedékes, de kimaradt söpréseket; az ablakon kívüli példányokra a `catchupPolicy` dönt.
- **Dupla-fire:** `@@unique([monitorId, scheduledFor])` a `MonitorRun`-on + `FOR UPDATE SKIP LOCKED` a definíción → ugyanaz a periódus nem futhat kétszer, párhuzamos worker mellett sem.
- **Concurrency-cap:** a batch-méret és a `PlatformSetting 'monitor.max_concurrent'` korlátozza az egyszerre futó söpréseket; a jitter szétteríti az azonos időpontra eső monitorokat.
- **Időzóna:** minden timestamp `Timestamptz` (UTC); a UI lokálisan jelenít meg.

---

## 5. Signal collectorok és a szűrő-DSL

### 5.1 Collector-interfész

```ts
export interface MonitorCollector {
  kind: MonitorKind
  collect(ctx: { tenantId: string; config: Json; now: Date }): Promise<MonitorSignalDraft[]>
}

export type MonitorSignalDraft = {
  dedupKeyParts: Record<string, string>   // a template kitöltéséhez
  severity: number                          // 0..100, a küszöb-összevetéshez
  title: string                             // ember-olvasható (ticket cím alapja)
  dueBy?: Date
  payload: Record<string, unknown>          // a jel pillanatképe (audithoz)
}
```

**Kötelező kontroll (§4.11.7):** minden collector, amely külső rendszert (pl. postafiók) olvas, **a Tool Brokeren át** hív (`kb_search`, jövőbeli `mailbox_count` capability), soha nem közvetlenül. A belső board/DB collectorok közvetlen (read-only) repository-lekérdezést használhatnak, mert nem hagyják el a control plane határát.

### 5.2 MVP collectorok

| Collector | `kind` | Mit gyűjt | Forrás | `severity` heurisztika |
|---|---|---|---|---|
| **Board backlog** | `board_backlog` | `awaiting_human` / `ready` ticketek, amelyek > N órája nem mozdultak | `TicketRepository` (read-only) | életkor és `due_by` közelség alapján |
| **Deadline** | `deadline` | `Ticket.due_by` és `ScheduledTask.next_run_at`, amely < N óra múlva esedékes és nincs kész | `TicketRepository`, `ScheduledTaskRepository` | hátralévő idő invertálva |
| **Connector count** | `connector_count` | egy connector-forrás (pl. postafiók) feldolgozatlan elemszáma | Tool Broker capability | (count − küszöb) skálázva |

A `composite` kind (Fázis 2.5) több collector eredményét AND/OR-ral kombinálja.

### 5.3 Szűrő-DSL (`filter-eval.ts`) — determinisztikus, nem-LLM

A `filterConfig` egy egyszerű, **kiértékelhető és auditálható** szabály-objektum (nincs szabad kódfuttatás):

```jsonc
{
  "op": "and",
  "rules": [
    { "field": "severity", "cmp": ">=", "value": 60 },
    { "field": "payload.openCount", "cmp": ">", "value": 5 },
    { "op": "or", "rules": [
        { "field": "businessHours", "cmp": "==", "value": false, "andSeverity": 90 },
        { "field": "businessHours", "cmp": "==", "value": true }
    ]}
  ]
}
```

- Támogatott `cmp`: `>=, >, <=, <, ==, !=`, `between`, `in`.
- A `field` pontozott útvonal a `MonitorSignalDraft`-on (`severity`, `dueBy`, `payload.*`) + származtatott mezők (`businessHours`, `ageHours`).
- **A „csak ha fontos” küszöb itt konfigurálható** (§4.11.7): pl. munkaidőn kívül csak `severity >= 90`. A csendes alapállapot az alapértelmezett: ha egy jel sem teljesíti a szabályt, a `MonitorRun` `quiet`.
- A kiértékelő **tiszta függvény** (input: szabály + jel → bool + indok), unit-tesztelhető, és minden döntés (miért lett elnyomva/eszkalálva) bekerül a `MonitorRun` / audit indoklásba.

---

## 6. Költségkontroll (§4.11.4 / §8.6)

| Kontroll | Hol | Hogyan |
|---|---|---|
| **Söprés-frekvencia** | `MonitorDefinition.intervalSeconds` + globális `PlatformSetting 'monitor.sweep_interval_sec'` | runtime állítható; az 1. lépcső nulla token, így a frekvencia főleg DB-terhelés. |
| **Per-futás budget** | `MonitorDefinition.perRunBudgetUsd` | a 2. lépcső LLM-agentje a meglévő `DispatcherService` budget cap mechanizmusán fut (`dispatch.budget_blocked` audit). |
| **Concurrency-cap** | `PlatformSetting 'monitor.max_concurrent'` | egyszerre futó söprések száma korlátozott; jitter simít. |
| **Kill-switch** | `PlatformSetting 'monitor.kill_switch'` | globális leállítás a `/control-plane/system` oldalról (a dispatcher kill-switch mintájára). |
| **LLM-mentes mód** | `escalateAgentId = null` | a monitor LLM nélkül is működik (csak ticket-nyitás) → nulla token. |

A kétlépcsős felépítés garantálja, hogy **drága LLM sosem fut üresben** (§4.11.1) — a token csak valódi, küszöböt átlépő jelnél megy el.

---

## 7. Értesítési csatorna (opcionális, kiegészítő)

- A `notify-` adapter interfész: `notify(channelSpec: string, ticket: Ticket): Promise<void>`.
- MVP referencia-implementáció: **e-mail** (a meglévő Gmail/connector infrán át, ha elérhető) vagy egyszerű SMTP/no-op stub teszthez.
- **Elv (§4.11.7):** az értesítés **csak figyelemfelhívás** a ticketre — a link a board-ticketre mutat; az auditált, jóváhagyás-köteles felület a board marad. Az értesítés kudarca **nem** bukatja a söprést (best-effort, naplózott).
- Az értesítés ténye auditált (`monitor.notify.sent` / `monitor.notify.failed`).

---

## 8. Security / governance baseline (a feature-re)

1. **Nincs közvetlen rendszer-elérés:** minden külső-forrás collector a Tool Brokeren és (LLM esetén) a Model Gateway-en át megy (§4.11.7). A board/DB collectorok read-only, tenant-szűrt lekérdezések.
2. **Tenant-izoláció:** minden `MonitorDefinition`, `MonitorRun`, `MonitorSignal` és nyitott ticket egy `tenantId`-hoz kötött; cross-tenant jel nem keletkezhet.
3. **A prompt-injection határ tartva (§8.2 / koncepció 6. fejezet):** a collector által beolvasott tartalom (pl. e-mail törzs) **adat, nem utasítás**. Az 1. lépcső soha nem ad LLM-nek vezérlést; a 2. lépcső LLM-agentje a meglévő guardrail (20-hívás cap, Tool Broker capability-policy) alatt fut, és kimenete jóváhagyás-köteles ticket.
4. **Governance nem lazul:** a proaktívan nyitott ticket ugyanaz a naplózott, állapotgépen futó, jóváhagyás-köteles entitás, mint bármely más (§4.11.7).
5. **Append-only audit:** minden söprés (`monitor.sweep.start/quiet/escalated/suppressed/error`), minden szűrő-döntés indoklással, minden ticket-nyitás és értesítés a hash-láncolt `AuditLog`-ba kerül.
6. **Run-as / jogosultság:** ha a 2. lépcső agentje egy felhasználó nevében hív connectort, a `ScheduledTask` `run-as` mintáját követi (explicit authorizáció, `buildRunAsAuthorization`) — autonóm futásnál csak service-módú vagy előre engedélyezett grant használható (lásd Per-User Connector spec §6.1).

---

## 9. Control Plane UI (PM-E)

**Új route:** `/control-plane/monitors`

- **Lista:** monitor-definíciók (`title`, `kind`, `status`, `nextSweepAt`, utolsó `outcome`, eszkalációk száma az elmúlt 7 napban). Kill-switch állapot jelző.
- **Szerkesztő:** `kind` választó → kind-specifikus collector-config űrlap; szűrő-DSL szerkesztő (kezdő: küszöb-csúszka + „munkaidőn kívül csak kritikus” kapcsoló; haladó: nyers JSON); cooldown, intervallum, eszkalációs agent (opc.), per-futás budget, értesítési csatorna.
- **Dry-run (próba-futás):** „Futtasd most, ticket-nyitás nélkül” gomb → lefuttatja az 1. lépcsőt, megmutatja a gyűjtött jeleket, a szűrő-döntést (mi lenne eszkalálva / elnyomva) és a becsült 2. lépcső költséget. **Nem** nyit ticketet, nem hív LLM-et. Kulcs a riasztás-fáradtság hangolásához.
- **Futásnapló:** `MonitorRun` lista (időbélyeg, outcome, signal/matched/suppressed count, nyitott ticketek linkje, költség). Drill-down a `MonitorSignal` cooldown-állapotra.
- **Rendszer-oldal kiegészítés** (`/control-plane/system`): `monitor.kill_switch`, `monitor.sweep_interval_sec`, `monitor.max_concurrent` runtime állítása (a meglévő `PlatformSetting` panelbe).

---

## 10. Megvalósítási terv

### PM-A — Adatmodell + söprés-motor váza
- Prisma migráció: `MonitorDefinition`, `MonitorRun`, `MonitorSignal`, enumok, `TicketType.monitor_alert`.
- `monitor-repository.ts` (claim `FOR UPDATE SKIP LOCKED`, `computeNext`, run upsert idempotensen).
- `monitor-service.ts` `runSweep` váz, collector nélkül (üres jel → `quiet`).
- Worker-tick beágyazása a dispatcher workerbe (`monitor.sweep_interval_sec`).

### PM-B — Collectorok
- `board-collector.ts`, `deadline-collector.ts` (belső, read-only).
- `connector-count-collector.ts` (Tool Brokeren át; ha nincs élő connector, stub forrás teszthez).

### PM-C — Szűrő + eszkaláció
- `filter-eval.ts` tiszta függvény + unit tesztek (küszöb, business-hours, AND/OR).
- `openTicket` (`source=system`, provenance payload) + opcionális `assignAndDispatch` a `DispatcherService`-en.

### PM-D — Dedup / catch-up / budget
- `MonitorSignal` cooldown logika, `dedupKeyTemplate` renderelés.
- catch-up policy + jitter a `computeNext`-ben; `@@unique` dupla-fire teszt.
- per-futás budget bekötés a dispatch-budget cap-be; kill-switch + concurrency-cap `PlatformSetting`.

### PM-E — UI + értesítés
- `/control-plane/monitors` lista + szerkesztő + dry-run + futásnapló.
- `notify` adapter interfész + e-mail/stub referencia.
- rendszer-oldal kill-switch/intervallum panel.

---

## 11. Nyitott döntések

| ID | Kérdés | Javaslat |
|---|---|---|
| **D-PM-1** | A söprő a dispatcher service-be ágyazva (A) vagy külön Job (B)? | **(A)** az MVP-hez — közös always-on worker, kill-switch, health. |
| **D-PM-2** | A 2. lépcső alapból nyit-e LLM-agentet, vagy alapból LLM-mentes? | **LLM-mentes alap** (`escalateAgentId=null`); az LLM-dúsítás opt-in, hogy a költség kiszámítható maradjon. |
| **D-PM-3** | A `connector_count` collector saját capability-t kap (`mailbox_count`) vagy a meglévő `kb_search`-öt feszíti? | Új, **dedikált read-only capability** a Tool Brokerben — tisztább policy és audit. |
| **D-PM-4** | A szűrő-DSL JSON-szabály vagy egyszerűsített kifejezés-nyelv? | **JSON-szabály** (auditálható, nincs kódfuttatás); a haladó nyelv Fázis 3. |
| **D-PM-5** | Webhook-alapú azonnali trigger (push) belefér a Fázis 2-be? | Nem — MVP **pull/sweep**; a webhook-bemenet külön Fázis 3 spec. |
| **D-PM-6** | Cooldown alapértelmezett értéke? | 24h (`86400s`) a határidő-monitorra; connector-count-ra rövidebb (pl. 4h) — kind-specifikus default. |

---

## 12. Elfogadási kritériumok (összesített)

### 12.1 Funkcionális

| ID | Kritérium |
|---|---|
| PM1 | Aktív `deadline` monitor egy < N órán belül esedékes `due_by` ticketre → **egy** `monitor_alert` ticket nyílik (`source=system`), provenance payloaddal. |
| PM2 | Nincs küszöböt átlépő jel → `MonitorRun.outcome=quiet`, **nincs** ticket, **nincs** LLM-hívás (csendes alapállapot). |
| PM3 | Ugyanaz a jel a cooldown ablakon belül újra megjelenik → `outcome=suppressed`, **nincs** új ticket. |
| PM4 | `escalateAgentId` beállítva → a 2. lépcső agentje a `DispatcherService`-en fut, a `perRunBudgetUsd` cap alatt; `MonitorRun.llmInvoked=true`. |
| PM5 | Dry-run gomb → jelek + szűrő-döntés + becsült költség, **ticket és LLM nélkül**. |
| PM6 | Kill-switch bekapcsolva → minden söprés `skipped`, audit-nyommal. |
| PM7 | A nyitott `monitor_alert` ticket a normál állapotgépen halad és jóváhagyás-köteles marad. |

### 12.2 Kötelező negatív tesztek (governance-bizonyítékok)

| ID | Negatív teszt | Elvárt |
|---|---|---|
| PM-N1 | **Dupla-fire:** két párhuzamos worker ugyanarra a `scheduledFor` periódusra → **egy** `MonitorRun` (`@@unique` ütközés a másodikat eldobja), **egy** ticket. |
| PM-N2 | **Cross-tenant:** A tenant monitora nem gyűjt B tenant jeleit; B ticket sosem nyílik A monitorából. |
| PM-N3 | **Token-ökonómia:** `quiet` és `suppressed` outcome-nál a Model Gateway **nem** kap hívást (LLM-token = 0). |
| PM-N4 | **Budget:** ha a 2. lépcső agentje túllépné a `perRunBudgetUsd`-t → `dispatch.budget_blocked`, az agent nem fut tovább. |
| PM-N5 | **Riasztás-fáradtság:** azonos jelből cooldown ablakon belül legfeljebb egy ticket; a futásnapló a `suppressedCount`-tal bizonyítja. |
| PM-N6 | **Tool Broker határ:** a `connector_count` collector közvetlen connector-hívása tiltott — csak a Tool Broker capability-n át megy (policy-deny audit, ha kísérlik). |

### 12.3 Observability (§8.6 / MVP-minimum)

- Metrikák: söprések száma, `quiet/escalated/suppressed/error` arány monitoronként, eszkaláció-ráta, false-positive becslés (eszkalált, de emberi `rejected` ticket aránya), 2. lépcső átlag-költség.
- Minden `MonitorRun` és audit-esemény exportálható a meglévő mérési riportba.

---

## 13. Definition of Done

- [x] Prisma séma + seed (egy minta `deadline` monitor).
- [x] `monitor-service.ts` kétlépcsős `runSweep` + 3 collector + `filter-eval` unit-tesztekkel.
- [x] Worker-tick a dispatcherben, runtime kill-switch + intervallum + concurrency-cap.
- [x] Dedup/cooldown + catch-up + `@@unique` dupla-fire védelem.
- [x] Monitor-ticket tenant-izoláció + deadline/board-backlog collector tenant-szűrés (PM-N2).
- [x] 2. lépcsős agent-indítás a meglévő dispatcher budget/guardrail alatt.
- [x] `/control-plane/monitors` lista + szerkesztő + dry-run + futásnapló.
- [x] Audit-lánc kiterjesztve a monitor-eseményekre (`monitor.sweep.*`, lock reclaim, kill-switch skip).
- [x] `npm run test:monitor` + `npm run lint` + `npx tsc --noEmit --incremental false` + `npm run build` zöld.
- [x] Opcionális értesítési adapter (`app/src/lib/notify/`) audit-only referencia + valós allowlistolt chat-webhook implementációval és provider-routinggal.
- [x] Dedikált Tool Broker `mailbox_count` capability és `connector_count` collector bekötés.
