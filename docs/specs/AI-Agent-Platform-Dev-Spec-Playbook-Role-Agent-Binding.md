# Fejlesztői specifikáció – Playbook → Folyamat → Futás életciklus

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0 (fejlesztői spec)
**Dátum:** 2026-07-03
**Forrás feature-spec:** `AI-Agent-Platform-Feature-Spec-Playbook-Role-Agent-Binding.md` (v0.2)
**Olvasó:** a feature-t implementáló fejlesztő(k). Feltételezi a repository ismeretét (`app/src/domain/playbook/*`, `app/src/lib/playbook-v2/*`, `app/prisma/schema.prisma`).
**Státusz:** implementálható. A feature-spec §-jaira normatív módon hivatkozik; ahol a feature-spec nyitva hagyott egy döntést (§10), ott a jelen dokumentum **kötelező mérnöki döntést** rögzít.

---

## Megvalósítási állapot (2026-07-03)

> Jelmagyarázat: ✅ **KÉSZ** (kód + teszt zöld, nincs commitolva) · 🟡 **RÉSZBEN KÉSZ** · 🔜 **HÁTRA** · ⏸️ **HALASZTVA**

| WP | Terület | Állapot |
|---|---|---|
| WP-1 | `ProcessDefinition` + `ProcessTrigger` séma | ✅ KÉSZ (db push dev+test) |
| WP-2 | `PlaybookAssignment` leépítés | ✅ KÉSZ (agent_role roster írás tiltva; runtime nem olvassa) |
| WP-3 | Tipizált input-rések + sablonos utasítás (spec) | ✅ KÉSZ |
| WP-4 | Validátor: rés- és template-integritás | ✅ KÉSZ |
| WP-5 | Compiler: rés-metaadat átvezetés | ✅ KÉSZ |
| WP-6 | `ProcessDefinitionService` + `isAgentSuitable` + megelőző kapu | ✅ KÉSZ |
| WP-7 | `startProcess` átkötése Folyamatra + futásidejű `blocked` | ✅ KÉSZ |
| WP-8 | `buildEffectivePrompt` | ✅ KÉSZ |
| WP-9 | Négy trigger (manual/ticket/chat/monitor_cron) | ✅ KÉSZ (manual + monitor_cron + ticket backend/action/UI + chat runtime/API + chat Folyamat-választó UI + LLM slot-filling fallback) |
| WP-10 | Playbook-szerző agent | ✅ KÉSZ |
| WP-11 | Folyamat- és trigger-API-végpontok | ✅ KÉSZ |
| WP-12 | Folyamat-összeállító UI + terminológia | ✅ KÉSZ (publikált Playbook-verzióból draft létrehozás, szerep→agent kötés, config-rések, trigger, aktiválás + Futás-nézet meta/blokk-ok) |

**Fázis 1 (adat + spec alap) ✅, Fázis 2 (Folyamat-réteg + indítás) ✅, WP-2 (roster-leépítés) ✅, WP-9 (négy trigger) ✅, WP-10 (Playbook-szerző agent) ✅, WP-11 (REST API) ✅ és WP-12 (Folyamat-összeállító UI + terminológia) ✅ kész.** WP-9 mind a négy triggerrel kész: a manual Futás-indítás, a Monitor-cron sweep→Futás triggerintegráció, a ticket `fieldMap`→`inputPayload` feloldás + ticketből Futás-indító action/UI, valamint a chat `slotNames`/alias→`inputPayload` feloldás + `conversationId`-vel linkelt Futás-indítás működik. A chat-oldalon a `AgentChatPanel` most már Folyamat-választót kínál (`listChatTriggerableProcessDefinitions` — a tenant aktív, chat-triggeres és az adott agenthez kötött Folyamatai), és a determinisztikus (JSON / kulcs:érték) feloldás mellé egy LLM-alapú slot-filling fallback került (`extractChatTriggerSlotsWithLlm`): ha a determinisztikus parse után marad kötelező, hiányzó rés, egy szűk, szigorúan-JSON kimenetet kérő modellhívás próbálja kinyerni azokat a szabad szöveges üzenetből, mielőtt a rendszer visszakérdezne. A Folyamat-összeállító UI publikált Playbook-verzióból draftot hoz létre, alkalmas-agent választót kínál szerepenként, config-réseket kezel, triggert csatol és aktiválást indít. A célzott Folyamat tesztek és a teljes `tsc --noEmit` zöldek.

**WP-10 (Playbook-szerző agent, §5.A/§6) lezárva:** új `PlaybookAuthorAgent` domain-osztály (`app/src/domain/playbook/playbook-author-agent.ts`) — NL leírás → JSON-draft kinyerés a modellből (a provisioning-asszisztens `extractJsonObject`-jét újrahasználva), majd a meglévő `PlaybookValidator.validateSpec` átfuttatása (`knownCapabilities` a tenant agentjeinek ténylegesen engedélyezett tool-jaiból). PROPOSE-NOT-APPLY: az osztály sosem ír DB-be, sosem publikál — mindig visszaadja a nyers spec-et + a validációs eredményt, hogy a hibákra a beszélgetés visszacsatolhasson. Seedelt `Playbook Author` agent (Agent Registry `worker`, Tool Broker capability nélkül — least-privilege, mint a provisioning-asszisztens/web-egress role). Új admin-only server action: `draftPlaybookFromDescription` (`app/src/app/actions/playbook.ts`) — a visszaadott draftot a hívó a MEGLÉVŐ `createPlaybookV2`/`createPlaybookVersionV2` action-nel menti (a szerző-agent nem kap saját perzisztencia-utat). UI: `PlaybookAuthorPanel` (`app/src/components/playbooks/playbook-author-panel.tsx`) a Playbook Registry és a Playbook-detail oldalon — leírás → draft → a meglévő `PlaybookFlowGraph` read-only diagramja + validációs hiba/warning-lista → emberi „Mentés draft-verzióként”. A diagram-komponens már létező infrastruktúra volt (`PlaybookFlowGraph`), újrahasznosítva. 9 determinisztikus unit-teszt (`npm run test:playbook-author`, DB/hálózat nélkül, fake modell) zöld; `tsc --noEmit` és `eslint` tiszta az érintett fájlokon. Élő preview-verifikáció NEM történt (a platform dev-szervere ebben a munkamenetben nem futott a szokásos porton, és a control-plane oldalak bejelentkezést igényelnek) — a lefedettség tsc+eslint+unit-teszt szinten áll.

**Fázis 2 follow-up lezárva:** a `blocked` Futás riasztó adaptere (`MonitorProcessAlertNotifier`) be van kötve a meglévő allowlistolt monitor-notifier útvonalra; `PROCESS_BLOCKED_NOTIFY_CHANNEL=chat:<kulcs>` mellett webhookot küld, különben audit-only fallbackkel marad best-effort.

---

## 0. Hogyan olvasd

A feature-spec a **mit és miért** kérdést válaszolja meg; ez a dokumentum a **hogyan**-t. A munka **munkacsomagokra (WP)** bontva. Minden WP-hez tartozik: érintett fájlok, konkrét séma/típus/aláírás-változás, elfogadási kritérium. A WP-k függőségi sorrendben állnak — felülről lefelé implementálhatók.

**Terminológiai leképezés (feature-spec §1.1) — a kódban végig ezt használjuk:**

| Feature-spec fogalom | Kód-entitás | Állapot |
|---|---|---|
| Playbook (recept, 1. szint) | `PlaybookV2` / `PlaybookVersionV2` | ✅ létezik |
| **Folyamat** (konfigurált def., 2. szint) | **`ProcessDefinition`** | ✅ létezik; API + összeállító UI alapútvonal kész |
| Futás (run, 3. szint) | `ProcessInstance` | ✅ létezik, UI-nyelven „Futás" |

> **Vigyázat (feature-spec §1.1):** a kód ma a `ProcessInstance`-t hívja „Process"-nek. A jelen specben **Folyamat = `ProcessDefinition` (2. szint)**, **Futás = `ProcessInstance` (3. szint)**. Az UI-cimkéket ehhez kell igazítani (WP-12).

---

## 1. Jelenlegi állapot (kód-leltár)

Amire építünk, és amit módosítunk:

| Terület | Fájl | Ma | Ami hiányzik |
|---|---|---|---|
| Playbook-spec típusok | `app/src/lib/playbook-v2/spec.ts` | szerepek, lépések, kapuk, átmenetek Zod-sémái | **tipizált input-rések**, **sablonos lépés-utasítás** (§4.7) |
| Compiler | `app/src/domain/playbook/playbook-compiler.ts` | `CompiledSpec` (`ticketRules`, `gates`, `routingRules`) | rés-metaadat átvezetése, cron-feloldhatóság-jelzés |
| Futás-indítás | `app/src/domain/playbook/process-service.ts` `startProcess()` | verziót `resolveDefaultVersionId`-ből old fel; step-ticketet **agent nélkül** hoz létre (`assignedAgentId: null`, `assigneeId: null`, `agentId: null`) | **Folyamatból** való indítás, **szerep→agent feloldás**, **rés-kitöltés** |
| Lépés-ticket | `process-service.ts` `createStepWithTicket()` | `assignedRole`-t ír, agentet nem | tényleges agent kötése a ticketre |
| Playbook szolgáltatás | `app/src/domain/playbook/playbook-v2-service.ts` | draft→validál→publish; `PlaybookAssignment` (roster) kezelés | — (a roster leépül, lásd WP-2) |
| Validátor | `app/src/domain/playbook/playbook-validator.ts` | szemantikai keresztref-ellenőrzés | rés-referenciák + template-változók ellenőrzése |
| Monitor (cron) | `MonitorDefinition` (schema.prisma:1196) | ütemezett collector→filter→eszkaláció ticketbe | Folyamat-trigger kimenet |
| UI | `app/src/components/processes/*`, `app/src/app/control-plane/processes/*` | Futás-lista/-detail, `start-process-form` | Folyamat-összeállító, trigger-konfig, agent-választó |

**Kulcs-megfigyelés a kódból:** a `createStepWithTicket` (`process-service.ts:311`) **már most is** minden szükséges körítést létrehoz (step-instance, ticket, delegációs él, audit), csak az `assignedAgentId`/`assigneeId`/`agentId` mezőket hagyja `null`-on. A feature lényegében **ezt a három mezőt tölti meg értelmesen** — plusz a hozzá vezető Folyamat-réteget és rés-feloldást építi ki köré.

---

## 2. Adatmodell-változások (Prisma)

Fájl: `app/prisma/schema.prisma`. Migráció: `prisma migrate dev --name process_definition_layer` (dev+test DB-re egyaránt; l. memória: Neon connection leak, ne ad-hoc tsx-szkriptek).

### WP-1 — `ProcessDefinition` entitás (feature-spec §1, §4.1, §7) — ✅ KÉSZ

Új enum + két új tábla:

```prisma
enum ProcessDefinitionStatus {
  draft
  active
  archived
}

/// Folyamat (2. szint): egy publikált Playbook-verzióra PIN-elt, konfigurált,
/// nevesített, újrahasználható definíció. Feature-spec §1, §4.1.
model ProcessDefinition {
  id                String                  @id @default(uuid()) @db.Uuid
  tenantId          String?                 @map("tenant_id") @db.Uuid
  name              String
  description       String?
  status            ProcessDefinitionStatus @default(draft)
  // PIN a publikált Playbook-verzióra (§4.10). A verzió cseréje tudatos, külön aktus.
  playbookId        String                  @map("playbook_id") @db.Uuid
  playbookVersionId String                  @map("playbook_version_id") @db.Uuid
  // roleKey -> agentId leképezés a Folyamaton (§4.1, §1.2). { "reviewer": "<uuid>", ... }
  roleBindings      Json                    @default("{}") @map("role_bindings")
  // config-forrású rések értékei (§4.7). { "sablon": "...", ... }
  configValues      Json                    @default("{}") @map("config_values")
  createdById       String                  @map("created_by_user_id") @db.Uuid
  approvedById      String?                 @map("approved_by_user_id") @db.Uuid
  approvedAt        DateTime?               @map("approved_at") @db.Timestamptz
  createdAt         DateTime                @default(now()) @map("created_at") @db.Timestamptz
  updatedAt         DateTime                @updatedAt @map("updated_at") @db.Timestamptz
  archivedAt        DateTime?               @map("archived_at") @db.Timestamptz

  playbook        PlaybookV2               @relation(fields: [playbookId], references: [id])
  playbookVersion PlaybookVersionV2        @relation(fields: [playbookVersionId], references: [id])
  triggers        ProcessTrigger[]
  instances       ProcessInstance[]

  @@index([tenantId, status])
  @@map("process_definitions")
}

enum ProcessTriggerType {
  manual      // Folyamatok-UI (kézi/teszt)
  ticket
  chat
  monitor_cron
}

/// Egy Folyamathoz kötött trigger (§4.4). Egy Folyamatnak több triggere lehet.
model ProcessTrigger {
  id                  String             @id @default(uuid()) @db.Uuid
  tenantId            String?            @map("tenant_id") @db.Uuid
  processDefinitionId String             @map("process_definition_id") @db.Uuid
  type                ProcessTriggerType
  enabled             Boolean            @default(true)
  // trigger-input -> deklarált rés leképezés (§4.4). Alakja triggertípus-függő:
  //  ticket:       { fieldMap: { "<slotName>": "<ticketFieldKey>" } }
  //  chat:         { slotNames: ["cég", ...] }
  //  monitor_cron: { monitorDefinitionId, contextMap: { "<slotName>": "now()" | "<collectorField>" } }
  //  manual:       {}  (az operátor űrlapon tölt)
  inputMap            Json               @default("{}") @map("input_map")
  // monitor_cron esetén a forrás MonitorDefinition (opcionális FK-ként is tükrözve)
  monitorDefinitionId String?            @map("monitor_definition_id") @db.Uuid
  createdById         String             @map("created_by_user_id") @db.Uuid
  createdAt           DateTime           @default(now()) @map("created_at") @db.Timestamptz
  revokedAt           DateTime?          @map("revoked_at") @db.Timestamptz

  processDefinition ProcessDefinition @relation(fields: [processDefinitionId], references: [id], onDelete: Cascade)

  @@index([tenantId, type])
  @@index([processDefinitionId])
  @@map("process_triggers")
}
```

Ezzel párhuzamosan bővül a `ProcessInstance` és a `PlaybookV2`/`PlaybookVersionV2` **relation-oldala**:

```prisma
// ProcessInstance-be:
  processDefinitionId String? @map("process_definition_id") @db.Uuid
  triggerType         ProcessTriggerType? @map("trigger_type")
  processDefinition   ProcessDefinition?  @relation(fields: [processDefinitionId], references: [id])
// (a conversationId, rootTicketId, inputPayload, startedByType mezők MÁR léteznek – §7)

// PlaybookV2-be:  processDefinitions ProcessDefinition[]
// PlaybookVersionV2-be:  processDefinitions ProcessDefinition[]
```

**Elfogadás:** `prisma migrate` lefut dev+test-en; `prisma generate` zöld; a `ProcessInstance.processDefinitionId` opcionális (visszafelé kompatibilis a meglévő rekordokkal).

### WP-2 — `PlaybookAssignment` sorsa (feature-spec §4.2, §7, PB-1 döntés) — ✅ KÉSZ

**Mérnöki döntés:** a `PlaybookAssignment` **NEM** funkcionál át Folyamattá (a szemantikája — `assignmentType`/`assignmentKey`/`isDefault` roster — nem fedi a Folyamat-modellt). A tábla **marad, de leépül**:

- A `resolveDefaultVersionId` (`process-service.ts:422`) által használt `process_type` default-assignment megmarad **átmeneti kompatibilitásként**, amíg a régi `startProcess(processType)` hívók léteznek.
- Az `assignmentType: 'agent_role'` roster-ág **deprecált**: futásidejű szerep-feloldásra **tilos** használni (§4.2 „a roster elhal"). A feloldás egyetlen forrása a `ProcessDefinition.roleBindings` (§4.4 feloldási sorrend).
- Új kód nem ír `agent_role` assignmentet: az action-validátor és a service-védelem már csak `process_type` / `ticket_type` assignmentet enged, regressziós teszt védi.

**Elfogadás:** grep-pel igazolható, hogy futásidejű agent-feloldás sehol nem olvas `PlaybookAssignment`-ből (kizárólag a `ProcessDefinition.roleBindings`-ből).

---

## 3. Spec- és compiler-változások

### WP-3 — Tipizált input-rések + sablonos utasítás a Playbook-specben (feature-spec §2, §4.7, §7) — ✅ KÉSZ

Fájl: `app/src/lib/playbook-v2/spec.ts`. **Additív, kompatibilis** bővítés (a mezők opcionálisak → a meglévő published specek érvényesek maradnak, `content_hash` csak új mezők jelenlétekor változik).

```ts
// --- Tipizált input-rés (§2, §4.7) ---
export const inputSlotSourceSchema = z.enum(['config', 'trigger'])
export type InputSlotSource = z.infer<typeof inputSlotSourceSchema>

export const inputSlotTypeSchema = z.enum(['string', 'number', 'boolean', 'freeform'])

export const playbookInputSlotSchema = z.object({
  name: z.string().min(1),           // template-változó neve: {{name}}
  type: inputSlotTypeSchema,
  required: z.boolean().default(true),
  source: inputSlotSourceSchema,     // 'config' = Folyamat tölti | 'trigger' = futás-bemenet
  description: z.string().optional(),
})
export type PlaybookInputSlot = z.infer<typeof playbookInputSlotSchema>
```

A `playbookStepSchema` (spec.ts:61) bővül:

```ts
  // §4.7: sablonos lépés-utasítás tipizált résekkel. A {{slot}} tokenek a
  // step.inputSlots név-listájából oldódnak fel (config ill. trigger forrásból).
  instructionTemplate: z.string().optional(),
  inputSlots: z.array(playbookInputSlotSchema).optional(),
```

**Kanonikalizáció:** a `computePlaybookContentHash` (spec.ts:173) rekurzív rendezése ezeket automatikusan lefedi — nincs külön teendő, csak az új mezők bekerülnek a hashbe.

**Elfogadás:** `parsePlaybookSpecV2` elfogad egy `instructionTemplate` + `inputSlots` mezőt hordozó lépést; a régi (mezők nélküli) spec továbbra is érvényes; a content-hash determinisztikus.

### WP-4 — Validátor: rés- és template-integritás (feature-spec §4.8, §6) — ✅ KÉSZ

Fájl: `app/src/domain/playbook/playbook-validator.ts`. Új szemantikai szabályok (a meglévő keresztref-ellenőrzések mintájára, strukturált hibaként):

1. **Template ↔ rés konzisztencia:** minden `{{token}}` az `instructionTemplate`-ben szerepeljen a lépés `inputSlots[].name` halmazában, és fordítva minden `required` rés jelenjen meg a template-ben (figyelmeztetés, ha nem-required rés kimarad).
2. **Forrás-particionálás:** egy rés `source` értéke lépésen belül egyértelmű.
3. **Capability-szótár (§4.8):** a `roles[].requiredCapabilities` értékei ismert tool-nevek legyenek (a `Capability.toolName` vokabulár), a `requiredPermissions` az IAM/RBAC modellben létező jog. Ezt a validátor **publikáláskor** ellenőrzi (a feature-spec §4.8 szerint már itt kizárja a hibát).

**Elfogadás:** hibás template-token / ismeretlen capability esetén a publish-validáció strukturált hibát ad; a beszélgetés (WP-8) ezekre visszacsatol.

### WP-5 — Compiler: rés-metaadat + cron-feloldhatóság (feature-spec §4.5, §7) — ✅ KÉSZ

Fájl: `app/src/domain/playbook/playbook-compiler.ts`. A `CompiledTicketRule` (compiler.ts:23) bővül, hogy a runtime ne kényszerüljön a nyers specet újraolvasni:

```ts
export type CompiledInputSlot = {
  name: string
  type: string
  required: boolean
  source: 'config' | 'trigger'
}

export type CompiledTicketRule = {
  stepId: string
  stepName: string
  ticketType: string
  assignedRole: string
  allowedTransitions: CompiledTransition[]
  instructionTemplate?: string          // ÚJ
  inputSlots: CompiledInputSlot[]        // ÚJ (üres tömb, ha nincs)
}
```

Ezen felül a compiler számítson ki egy Folyamat-szintű **cron-feloldhatósági segédet** (WP-6 használja): mely `trigger`-forrású rések vannak, amelyeket cronnál ember nélkül kell feloldani.

**Elfogadás:** a `compiledSpec.ticketRules[].inputSlots` kitöltött; a meglévő compiler-tesztek zöldek (üres `inputSlots` a régi specekre).

---

## 4. Domain: Folyamat-szolgáltatás és a futás-indítás átkötése

### WP-6 — `ProcessDefinitionService` (ÚJ) (feature-spec §4.1, §4.5, §4.8, §4.11, §5.B) — ✅ KÉSZ

Új fájl: `app/src/domain/playbook/process-definition-service.ts`. Repository-mintát követi (konstruktorba injektált repók), mint a `ProcessService`.

**Metódusok:**

```ts
class ProcessDefinitionService {
  // §4.1, §5.B – draft létrehozás publikált verzióra PIN-elve
  async createDraft(input: {
    tenantId: string | null
    name: string
    playbookVersionId: string       // MUST be status === 'published'
    createdBy: { userId: string }
  }): Promise<ProcessDefinition>

  // §4.1 – szerep-kötés + config-rés szerkesztése (draft állapotban)
  async updateBindings(input: {
    tenantId, processDefinitionId,
    roleBindings: Record<string /*roleKey*/, string /*agentId*/>,
    configValues: Record<string, unknown>,
    actorUserId,
  }): Promise<ProcessDefinition>

  // §4.4 – trigger csatolása/leválasztása; monitor_cron esetén a §4.5 megelőző kaput futtatja
  async attachTrigger(input: { ...; type; inputMap; monitorDefinitionId? }): Promise<ProcessTrigger>
  async detachTrigger(...): Promise<void>

  // §4.1, §5.B/4 – aktiválás: MINDEN kötelező kapu (§4.5, §4.8) átmegy, majd active + audit
  async activate(input: { tenantId, processDefinitionId, actorUserId }): Promise<ProcessDefinition>

  async archive(...): Promise<ProcessDefinition>
  // §4.10 – verzió-áthúzás = szerkesztés + újra-jóváhagyás (draftba visszavesz)
  async rebindToVersion(input: { ...; newPlaybookVersionId }): Promise<ProcessDefinition>
}
```

**Megelőző kapu (`activate` és `attachTrigger`) — feature-spec §4.5, §4.8, §4.11:**

- **Alkalmasság (§4.8):** minden `agent_role` szerephez kötött agent **aktív** (`status` nem retired/suspended), **azonos tenant**, és `Capability`-i (`allowed === true` tool-nevek) **lefedik** a `role.requiredCapabilities`-t. Hiányzó fedés → tiltó hiba, a hiányzó capability megnevezésével.
- **Kötelező config-rés (§4.1):** minden `source==='config'` + `required` rés kitöltve a `configValues`-ban.
- **Emberi szerep (§4.3, §4.8):** a `requiredPermissions` létezik az IAM/RBAC modellben.
- **Cron-kapu triggerenként (§4.5):** ha `monitor_cron` triggert csatolnak, MINDEN `source==='trigger'` + `required` rés ember nélkül feloldható legyen az `inputMap.contextMap`-ből (config-érték, `now()`-származtatás, vagy collector-mező). Ha nem → **a cron nem csatolható**, a hiba a szerkesztésnél csattan, nem futáskor. A validáció **triggerenként** fut (egy Folyamat cron-triggere elbukhat, miközben a ticket-triggere érvényes).

Az alkalmasság-ellenőrzés kiemelése tiszta függvénybe (tesztelhetőség):

```ts
// process-definition-service.ts vagy külön suitability.ts
export function isAgentSuitable(
  agent: { status: string; tenantId: string | null; capabilities: { toolName: string; allowed: boolean }[] },
  role: { requiredCapabilities?: string[] },
  defTenantId: string | null,
): { ok: true } | { ok: false; missing: string[]; reason: string }
```

**Elfogadás:** hiányos kötés / inaktív agent / fedetlen capability / feloldhatatlan cron-rés esetén `activate`/`attachTrigger` `ProcessDefinitionServiceError`-t dob megnevezett okkal; sikeres aktiválás audit-eseményt ír (`process_definition.activate`).

### WP-7 — `ProcessService.startProcess` átkötése Folyamatra (feature-spec §4.4, §4.6, §5.C, §7) — ✅ KÉSZ

Fájl: `app/src/domain/playbook/process-service.ts`.

**7.a – Új indítási bemenet.** A `startProcess` (process-service.ts:65) elsődleges útja mostantól **Folyamatból** indul; a régi `processType`-alapú út deprecált, de megmarad (WP-2 kompat).

```ts
async startProcess(input: {
  tenantId: string | null
  processDefinitionId: string          // ÚJ elsődleges belépő
  triggerType: 'manual' | 'ticket' | 'chat' | 'monitor_cron'
  inputPayload: Record<string, unknown> // FELOLDOTT trigger-rések (§4.4)
  startedBy: ProcessActor
  conversationId?: string | null
  rootTicketId?: string | null          // ticket-trigger esetén a trigger-ticket
}): Promise<ProcessInstance>
```

Az implementáció:
1. Betölti a `ProcessDefinition`-t (MUST `active`), abból a PIN-elt `playbookVersionId`-t és a `compiledSpec`-et.
2. **Rés-validáció (§4.4):** a `trigger`-forrású kötelező réseket a `inputPayload` ellen ellenőrzi; hiány → `blocked` + riasztás (§4.5, l. 7.c), nem néma dobás cron esetén.
3. `createProcess`-be átadja: `processDefinitionId`, `triggerType`, `conversationId`, `rootTicketId`, `inputPayload`, `startedBy*`.
4. Belépő step + root ticket a **feloldott agenttel** (7.b).
5. Audit: a `process.start` metadatába bekerül a `process_definition_id`, `trigger_type` (§4.9).

**7.b – Szerep→agent feloldás a lépés-ticketen (a feature magja).** A `createStepWithTicket` (process-service.ts:311) ma `assignedAgentId`/`assigneeId`/`agentId` = `null`. Új feloldás (§4.4 feloldási sorrend):

```
1. rule.assignedRole  ->  ProcessDefinition.roleBindings[assignedRole]  (egyetlen forrás)
2. ha nincs érvényes, alkalmas kötés  ->  Futás `blocked` + riasztás a felelősnek
```

Konkrétan agent-lépésnél:
- `agentId = def.roleBindings[rule.assignedRole]`; újra-ellenőrzés `isAgentSuitable` (az agent időközben inaktívvá válhatott → §4.8, §4.11 alkalmassági hiba).
- `createStep({ ..., assignedAgentId: agentId })` (a séma `ProcessStepInstance.assignedAgentId` már létezik).
- `tickets.create({ ..., assigneeType: 'agent', assigneeId: null, agentId })` — a ticket **tényleges agenthez** kötve.

Emberi lépésnél változatlanul **jogosultság-alapú** (§4.3): `assignedAgentId`/`assigneeId` marad null, a kapu a `requiredPermissions` alapján kezelhető bárki által.

**7.c – Futásidejű blokk (§4.5, §4.11) – „néma megállás tilos":** ha (2)-ben nincs alkalmas kötés, vagy egy kötelező trigger-rés futáskor nem oldható fel:
- `updateProcess(status: 'blocked')` (a `ProcessStatus.blocked` enum már létezik, schema.prisma:661),
- **kötelező riasztás** egy felelősnek (admin/owner): a meglévő Monitor/notifikációs adapter allowlistolt chat-webhookján keresztül (l. memória: Proactive Monitor értesítő-governance; gmail_send emberi-jóváhagyás-köteles → chat-webhook),
- audit `process.blocked` a blokk-okkal; a Futás-nézet megjeleníti az elakadás-okot.

**Elfogadás:** Folyamatból indított Futás belépő lépés-ticketje a kötött agenthez jön létre (`agentId != null`); hiányzó/alkalmatlan kötés → `blocked` + riasztás + audit; a régi `processType`-út továbbra is zöld a meglévő teszteken.

### WP-8 — Effektív prompt összeállítása (feature-spec §4.7) — ✅ KÉSZ

Új tiszta függvény (a dispatcher/agent-runtime fogyasztja; itt csak a bemenetet állítjuk elő és tesztelhetővé tesszük). Javasolt hely: `app/src/lib/playbook-v2/effective-prompt.ts`.

```ts
// §4.7 rétegzés: perszóna additív, lépés-utasítás mérvadó a feladatra.
export function buildEffectivePrompt(input: {
  agentPersona: string                 // az agent role_instruction + persona (NEM íródik felül)
  instructionTemplate?: string         // a lépésé; a {{slot}}-ok kitöltve
  slots: Record<string, unknown>       // config + trigger rések feloldott értékei
  runInput: Record<string, unknown>    // a futás-bemenet nyers része
}): string
```

Szabályok a specből:
- **Rés-behelyettesítés:** `{{slot}}` → érték; `config` rések a `ProcessDefinition.configValues`-ból, `trigger` rések a Futás `inputPayload`-jából.
- **Sorrend/precedencia:** `agent-perszóna + lépés-utasítás + futás-input`; tartalmi ütközésnél a **lépés-utasítás nyer** arra, hogy MIT csináljon; a perszóna az identitás/eszköz/stílus. A perszónát **nem írjuk felül**.

**Elfogadás:** unit-teszt igazolja a behelyettesítést, a rétegsorrendet és hogy a perszóna szövege sértetlen marad.

---

## 5. Trigger-integrációk (feature-spec §4.4, §4.6, §5.C)

### WP-9 — Négy belépési pont — 🟡 RÉSZBEN KÉSZ

| Trigger | Bekötés | Fájlok |
|---|---|---|
| **Manual (UI/teszt)** | ✅ KÉSZ — az operátor aktív Folyamatból, `triggerType:'manual'` értékkel indít Futást; a payload JSON-ként megadható. | `app/src/components/processes/start-process-form.tsx`, `app/src/app/actions/process.ts`, `POST /api/v1/process-definitions/[id]/runs` |
| **Ticket** | ✅ KÉSZ — a `ProcessTrigger.inputMap.fieldMap` ticket payload/top-level mezőkből `inputPayload`-ot old fel, majd `triggerType:'ticket'` értékkel Futást indít; a trigger-ticket lesz a `rootTicketId`. A ticket detail nézetben operátor indítópanel mutatja az aktív ticket-triggeres Folyamatokat és a feloldott input-előnézetet. | `app/src/lib/playbook-v2/trigger-input.ts`, `app/src/app/actions/process.ts`, `app/src/components/tickets/ticket-detail.tsx`, `app/src/app/control-plane/tickets/[ticketId]/page.tsx`, `app/scripts/playbook-process-definition.test.ts` |
| **Chat** | ✅ KÉSZ — a chat panelben megjelenő Folyamat-választó (`listChatTriggerableProcessDefinitions` action) az adott agenthez kötött, aktív, chat-triggeres Folyamatokat kínálja fel; kiválasztás után a `processDefinitionId` az üzenettel megy a stream route-ra. A runtime a `slotNames`/`aliases` alapján feloldja az inputot; ha ezután is marad kötelező hiányzó rés, egy LLM-alapú fallback (`extractChatTriggerSlotsWithLlm`) próbálja kinyerni a szabad szöveges üzenetből, mielőtt visszakérdezne. Siker esetén `startProcess({ triggerType:'chat', conversationId })` hívással Futást indít és státuszt ír vissza a beszélgetésbe; a UI ekkor törli a Folyamat-választást. | `app/src/domain/agent/agent-chat-runtime.ts`, `app/src/lib/playbook-v2/trigger-input.ts`, `app/src/app/api/v1/agent-chat/stream/route.ts`, `app/src/app/actions/process.ts`, `app/src/components/agents/agent-chat-panel.tsx` |
| **Monitor-cron** | ✅ KÉSZ — a meglévő **`MonitorDefinition`** a scheduler (nem új). A sweep a `ProcessTrigger.inputMap.contextMap` szerint ember nélkül oldja fel a réseket (`now()`, monitor/signal/payload/dedup mezők) és `startProcess({ triggerType:'monitor_cron', startedBy:{type:'system'} })` hívással Futást indít. Ha nincs aktív Folyamat-trigger, a legacy ticket-eszkaláció változatlanul működik. | `app/src/domain/monitor/monitor-service.ts`, `app/src/repositories/postgres/process-definition-repository.ts`, `app/scripts/monitor-engine.test.ts` |

**Chat/ticket input-feloldás alakja** a `ProcessTrigger.inputMap`-ben (WP-1 kommentek szerint) — a triggertípus dönti el, hogyan tölti a `startProcess` `inputPayload`-ját.

**Elfogadás:** mind a négy trigger létrehoz egy Futást a helyesen feloldott `inputPayload`-dal; a chat-triggernél a Futás `conversationId`-vel linkelt és a beszélgetés csak státuszt mutat.

---

## 6. A Playbook-szerző agent (feature-spec §5.A, §6)

### WP-10 — Természetes nyelv → validált Playbook-draft + diagram — ✅ KÉSZ

**Hatókör:** kizárólag az **1. szint** (Playbook). A Folyamatot (2.) v1-ben ember állítja össze (§3.2, §6).

- **Bekötött (nem üres) LLM:** ismeri a capability-vokabulárt (a `Capability.toolName` halmaza) és a spec-sémát (WP-3). v1-ben a Playbook absztrakt marad — **konkrét agentet nem drótoz**.
- **Governance (a provisioning-agent mintája):** a kimenet a meglévő `draft → validál → ember jóváhagy → publish` láncba megy (`playbook-v2-service.ts`). Az agent **draftol**, a `playbook-validator` + `playbook-compiler` ellenőrzi, a validációs hibákra a beszélgetés **visszacsatol**. **Az agent soha nem publikál** — jóváhagyás/publish emberi aktus.
- **Kimenet:** tipizált réseket, éleket, kapukat, capability-igényeket hordozó draft, ami átmegy a validátoron/compileren, mielőtt menthető.
- **Diagram:** read-only folyamat-diagram (nincs drag-and-drop editor, §3.2). Rendering a meglévő playbook-detail nézetben.
- **Szerkesztés:** meglévő Playbook módosítása **új draft-verziót** szül a verzió-életcikluson belül; végül ember menti.

**Elfogadás:** a szerző-agent egy NL-leírásból validált, compile-álható draftot állít elő; publish nélkül; a hibákra visszacsatol; a szerkesztés új draft-verziót hoz létre.

---

## 7. API-végpontok

A projekt Next.js-alapú (l. `app/AGENTS.md`: **nem a megszokott Next.js — a `node_modules/next/dist/docs/` irányadó az adott route-konvencióra; kód írása előtt olvasandó**). A meglévő route-minta: `app/src/app/api/v1/...`.

### WP-11 — Folyamat- és trigger-végpontok — ✅ KÉSZ

| Metódus + útvonal | Cél | Auth (IAM/RBAC) |
|---|---|---|
| `POST /api/v1/process-definitions` | Folyamat-draft (createDraft) | operátor/admin |
| `PATCH /api/v1/process-definitions/[id]` | kötések/rések (updateBindings) | operátor/admin |
| `POST /api/v1/process-definitions/[id]/triggers` | trigger csatolás (megelőző kapu) | operátor/admin |
| `DELETE /api/v1/process-definitions/[id]/triggers/[tid]` | trigger leválasztás | operátor/admin |
| `POST /api/v1/process-definitions/[id]/activate` | aktiválás (teljes megelőző kapu) | jóváhagyó jog |
| `POST /api/v1/process-definitions/[id]/archive` | archiválás | admin |
| `GET /api/v1/process-definitions?status=` | lista (összeállító UI) | operátor |
| `POST /api/v1/process-definitions/[id]/runs` | Futás indítása (manual/ticket/chat) | trigger-jog |
| `GET /api/v1/agents/suitable?roleKey=&playbookVersionId=` | alkalmas agentek listája egy szerephez (§4.1 agent-választó) | operátor |

A cron-trigger nem HTTP-ből indul, hanem a Monitor-sweepből (WP-9).

Action-validátorok: `app/src/lib/validators/actions.ts` (a meglévő `assignmentType`-minta mellé Folyamat-sémák). A régi `agent_role` assignment-action deprecálandó (WP-2).

**Elfogadás:** a végpontok az IAM/RBAC middleware-en át hitelesítenek; a hibák strukturáltak; a `suitable` endpoint csak alkalmas, aktív, azonos-tenant agenteket ad vissza.

---

## 8. UI (feature-spec §5, §9.2 mintanézetek)

### WP-12 — Folyamat-összeállító + terminológia-igazítás — ✅ KÉSZ

- **Folyamat-összeállító** (`/control-plane/processes` alá új „Folyamatok" szekció, elkülönítve a Futásoktól):
  1. publikált Playbook-verzió választó,
  2. szerep-lista → **agent-választó** szerepenként, ami a `/agents/suitable` végpontból **csak alkalmas agenteket** kínál; ha egy szerephez nincs alkalmas agent → **egyértelmű hiba** + link az Agent Registry-hez (§4.11),
  3. config-rés űrlap,
  4. trigger-panel (manual/ticket/chat/monitor_cron + input-térkép),
  5. „Aktiválás" gomb → megelőző kapu; bukásnál a hiányzó/feloldhatatlan elemek megnevezve.
- **Terminológia (§1.1):** ✅ KÉSZ — a meglévő `ProcessInstance`-nézetek UI-cimkéje **„Futás"**, az új `ProcessDefinition`-nézet **„Folyamat"**. A Folyamat-összeállító alapútvonal, a Futás-lista/detail és a manual indító ezt követi.
- **Futás-nézet:** ✅ KÉSZ — mutatja a forrás-Folyamatot, a triggert, a feloldott kötést (§4.9), és `blocked` állapotban az **elakadás-okot** (§4.11).
- **Chat:** a Futás státusza a beszélgetésben jelenik meg (státusz/kapu-kérdés/eredmény), részletek a Futás-nézetben (PB-3 nyitott UX, minimál-megoldás elég).

**Elfogadás:** operátor végig tud menni az 5.B folyamaton; alkalmatlan konfiguráció nem aktiválható; a Futás-nézet mutatja a Folyamatot/triggert/kötést és a blokk-okot.

---

## 9. Tesztterv (feature-spec §9 DoD-hoz kötve)

Minta: a meglévő domain-tesztek (Vitest). Kritikus, hogy **ne** ad-hoc `tsx -e` szkriptekkel piszkáljuk a DB-t (memória: Neon connection leak) — a repo teszt-harnessét használjuk.

| Teszt | Fedi |
|---|---|
| `spec.test` — input-rés + template parse, content-hash stabilitás | WP-3 |
| `playbook-validator.test` — template↔rés integritás, ismeretlen capability | WP-4 |
| `playbook-compiler.test` — `inputSlots` átvezetés, régi spec üres slots | WP-5 |
| `process-definition-service.test` — createDraft/updateBindings/activate; **megelőző kapu** minden ága (alkalmatlan agent, hiányzó config-rés, feloldhatatlan cron-rés triggerenként) | WP-6 |
| `suitability.test` — `isAgentSuitable` capability-fedés, inaktív/idegen-tenant agent | WP-6 |
| `process-service.startProcess.test` — Folyamatból indít, belépő ticket a **kötött agenthez**; `blocked` + riasztás alkalmatlan kötésnél; régi processType-út zöld marad | WP-7 |
| `effective-prompt.test` — rétegsorrend, rés-behelyettesítés, perszóna sértetlen | WP-8 |
| trigger-integrációs tesztek — négy belépő helyes `inputPayload`-ot ad; chat csak trigger-felület | WP-9 |
| author-agent teszt — NL→validált draft, nincs publish, hibára visszacsatol | WP-10 |

---

## 10. Megvalósítási fázisok (ajánlott sorrend)

1. ✅ **Adat + spec alap:** WP-1, WP-3, WP-4, WP-5 (séma, típusok, validátor, compiler). Külön PR — nincs viselkedésváltás, csak kapacitás. — **KÉSZ**
2. ✅ **Folyamat-réteg + indítás:** WP-6, WP-7, WP-8. Ez a feature magja (szerep→agent kötés, futásidejű feloldás, blokk, prompt). — **KÉSZ**
3. ✅ **Triggerek:** WP-9 kész (manual + monitor_cron + ticket backend/action/UI + chat runtime/API + Folyamat-választó UI + LLM slot-filling fallback).
4. ✅ **UI + API:** WP-11 ✅, WP-12 ✅ (Folyamat-összeállító alapútvonal + Futás-nézet).
5. 🔜 **Szerző-agent:** WP-10 (a legönállóbb; párhuzamosítható a 2–4-gyel).
6. ✅ **Roster-leépítés:** WP-2 kivezetés megtörtént; az `agent_role` roster-írás tiltott, a régi `process_type` default kompatibilitási út maradt.

> A memória szerint a repo-workflow **main-only** (ne nyiss feature branch-et); commit/push csak explicit kérésre. A fázisokat külön commitokban érdemes leszállítani.

---

## 11. Definition of Done → WP leképezés (feature-spec §9)

| Feature-spec DoD | Teljesítő WP | Állapot |
|---|---|---|
| Létezik a **Folyamat** entitás (PIN + kötés + config-rés + trigger, draft/active/archived, emberi jóváhagyás) | WP-1, WP-6 | ✅ KÉSZ |
| A lépések **tipizált input-réseket** + **sablonos utasítást** hordoznak, forrás deklarált | WP-3, WP-4, WP-5 | ✅ KÉSZ |
| A **négy trigger** működik; input triggertípusonként helyesen feloldva; chat csak trigger-felület | WP-9 | ✅ KÉSZ (manual + monitor_cron + ticket backend/action/UI + chat runtime/API + Folyamat-választó UI + LLM slot-filling fallback) |
| **Monitor-cron** átmegy a megelőző kapun; futásidejű elakadás → `blocked` + kötelező riasztás; néma megállás nincs | WP-6 (kapu), WP-7 (blokk), WP-9 (sweep bekötés) | ✅ cron-kapu + sweep→Futás + `blocked`+audit + riasztó adapter KÉSZ |
| A lépés-ticketek a Folyamat kötéséből **tényleges agenthez** jönnek létre | WP-7 | ✅ KÉSZ |
| Effektív prompt a §4.7 rétegzés szerint (perszóna additív, lépés-utasítás mérvadó) | WP-8 | ✅ KÉSZ (fogyasztó dispatcher-bekötés: WP-9-nél) |
| **Playbook-szerző agent** NL→validált draft+diagram; jóváhagyás emberé; szerkesztés új draftot szül | WP-10 | ✅ KÉSZ |
| Folyamat/trigger/kötés az indítási audit-eseményben és a Futás-nézetben | WP-7 (audit), WP-12 (nézet) | ✅ audit KÉSZ; ✅ Futás-nézet meta/blokk-ok KÉSZ; ✅ Folyamat-összeállító alapútvonal KÉSZ |
| Emberi szerepek jóváhagyása jogosultság-alapú a kapunál | WP-6, WP-7 (human-step ág) | ✅ KÉSZ |

---

## 12. Mérnöki döntések a feature-spec nyitott pontjaira (§10)

| ID | Feature-spec kérdés | Dev-döntés |
|---|---|---|
| PB-1 | `PlaybookAssignment` sorsa | **Nem** funkcionál át; külön `ProcessDefinition` tábla, a roster leépül (WP-1, WP-2). |
| RB-2 | Emberi szerephez konkrét user indításkor? | Nem (v1); `human_role` jogosultság-alapú a kapunál (WP-7 human-ág). |
| RB-3 | Több agent egy szerepben? | Nem (v1); `roleBindings` egy-egy leképezés. Séma `Json`, ezért későbbi bővítés (tömb) törésmentes. |
| RB-4 | Dispatch-idejű auto-választás? | Nem (v1); a Folyamat-kötés elsőbbség. A `resolveRoleBinding` külön függvény, hogy később becsúsztatható legyen egy 3. szint. |
| PB-4 | Folyamat-szintű szerző-agent? | Nem (v1); a `ProcessDefinitionService` API-ja viszont draft-barát, hogy később ráültethető legyen. |
| PB-5 | Tenant-szintű kötés-javaslat? | Opcionális; ha bevezetjük, kizárólag **előkitöltési javaslat** az összeállító UI-ban (WP-12), sosem futásidejű feloldási forrás. |
