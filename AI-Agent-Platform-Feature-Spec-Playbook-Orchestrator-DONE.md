# Feature-spec — Playbook Folyamat-Orchestrátor (Process Orchestration Engine)

**Készítette:** Excellence Pay KFT (Enterprise AI tanácsadás)
**Verzió:** 1.0
**Dátum:** 2026-06-22
**Forrásdokumentumok:** `AI-Agent-Platform-Koncepcio.md` (v0.11, §4.5.1, §4.10, §4.10.2–4.10.6, §4.11.1, §4.11.6), `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` (§5.1 állapotgép, §5.7 dispatcher, §15.4)
**Olvasó:** fejlesztő(k). Feltételezi a Ticket-állapotgép, a DispatcherService, az alapszintű PlaybookService és PlaybookSpec ismeretét.
**Státusz:** Fázis 2 — specifikált, nem implementált.

---

## 0. Mit ad ez a dokumentum

A platform jelenlegi állapotában az agenteknek és az embereknek csak **egylépéses, egyszerű interakcióra** van kialakított útja: egy ticket → egy agent dolgozik rajta → kész. Ha valami összetettebb folyamat kell (pl. számla beérkezik → agent kinyeri a mezőket → egyeztető agent ellenőrzi → emberi jóváhagyás → könyvelő agent javasolja a könyvelt tételt → vezető jóváhagyja), jelenleg nincs koordináló mechanizmus: minden lépéshez manuálisan kell ticketet nyitni.

Ez a feature azt az **automatikus, determinisztikus koordinátort** adja meg, ami egy lezárt ticketből a Playbook alapján **automatikusan elindítja a következő lépést** — emberi beavatkozás nélkül, de auditáltan és emberek által jóváhagyott folyamatterv szerint.

**A feature lényege** (koncepcióból, §4.10 Alapdöntés):

> A többlépéses folyamat forrás-igazsága egy **hozzárendelhető, verziózott Playbook-dokumentum**, nem az agentek implicit memóriája. A flow-t **determinisztikusan a ticket-állapotgép lépteti** (a Playbookból fordított átmenetek/kapuk szerint), nem LLM. Az orchestrátor csak *hivatkozik* a Playbookra — nem ő találja ki a lépéseket.

**Miért önmagában is értékes:**
- Egy meglévő üzleti folyamat (pl. reconciliation, chargeback feldolgozás, onboarding) azonnal Playbook-ba önthető és felügyelt módon automatizálható
- Az audit-nézőből látható a tervezett vs. ténylegesen futott folyamat — compliance-argumentum
- Nem igényel új LLM-logikát: a koordináció determinisztikus kód, nulla tokenköltség

---

## 1. Scope

### 1.1 In scope (ez a feature)

- **Kiterjesztett Playbook DSL** — elnevezett lépések, lépések közötti routing, feltételes elágazás, agent-szerep hozzárendelés
- **ProcessInstance entitás** — egy futó Playbook-példány nyilvántartása (melyik Playbook-verzió, melyik lépésnél jár, audit-pin)
- **PlaybookEngine service** (nem-LLM!) — amikor egy ticket `done` állapotba kerül, a motor a Playbook alapján meghatározza a következő lépést és létrehozza a szükséges ticketet
- **Dispatcher-integráció** — a process-driven ticketek ugyanúgy kerülnek a dispatcher-sorba, mint manuálisak; a motor meghívása az állapotváltás-hookba illeszkedik
- **Process-indítás** — server action, amely egy Playbookhoz létrehoz egy ProcessInstance-t és elindítja az első lépést
- **Process-dashboard UI** — futó folyamatok listája lépéssel/státusszal
- **Flow-vizualizáció** — tervezett folyamat (Playbookból) és tényleges folyamat (audit_log-ból) egymás mellé
- **Audit** — minden process-esemény (indítás, lépés-átmenet, leállás, hiba) az audit_log-ba

### 1.2 Out of scope (most NEM)

- LLM-alapú routing (melyik step aktiválódik, azt a Playbook struktúrája dönti el, nem LLM)
- Párhuzamos lépések / fork-join (`on_complete: [step_a, step_b]` — v2)
- Külső webhook trigger (process indítása külső rendszerből REST-en át — Fázis 3)
- Playbook sablon-csomag import/export (§4.8.6 — külön spec)
- Compensation / rollback (ha egy lépés hibázik, visszavonni a korábbit — Fázis 3)
- Komplex BPMN-modellek (párhuzam, timer, gateway — a könnyű Playbook §4.10.2 v1 célkitűzésének megfelelően)

### 1.3 Illeszkedés a meglévő architektúrához

A feature **nem épít párhuzamos rendszert**:

| Meglévő elem | Mit ad a feature-höz |
|---|---|
| `PlaybookService` + `PlaybookSpec` DSL | Kibővített DSL + `PlaybookEngine` ráteszi a routing-logikát |
| `TicketService` állapotgép + `transitionTicket` | A `done` állapotba lépés hook-ba illeszti a `PlaybookEngine.advance()` hívást |
| `DispatcherService` | A process-motor által létrehozott ticketek ugyanúgy kerülnek a sorba |
| `AuditService.append()` | Minden process-esemény ugyanarra a hash-láncolt naplóra kerül |
| `Playbook`/`PlaybookVersion` Prisma-modellek | Megmaradnak; schema-bővítés: `PlaybookStepSpec` elnevezett lépésekkel |

---

## 2. Kiterjesztett Playbook DSL

### 2.1 A jelenlegi DSL korlátai

A meglévő `playbookSpecSchema` (`app/src/lib/playbook-spec.ts`) csak ticket_type + role párokhoz rendel kapukat és átmenet-szabályokat. Nem fejezi ki:
- **Lépések nevét és sorrendjét** (mi az első lépés, mi jön utána)
- **Agent-szerep hozzárendelést** (melyik agent-konfiguráció végzi az adott lépést)
- **Elágazást** (ha a payload tartalmaz valamilyen értéket, másik lépés jön)
- **Terminálást** (melyik lépés az utolsó)
- **Emberi lépést** (assignee_type = human)

### 2.2 Kiterjesztett DSL séma (Zod + TypeScript)

A meglévő `app/src/lib/playbook-spec.ts` a következővel egészítendő ki. A régi `playbookSpecSchema` (array of steps) **megmarad** a visszafelé kompatibilitáshoz, az új `playbookProcessSchema` a folyamat-indításhoz szükséges.

```typescript
// Egyetlen lépés leírása a Playbook folyamatban
export const processStepSchema = z.object({
  /** Egyedi, gépiesen olvasható azonosító a lépésnek (pl. "extract_fields") */
  id: z.string().regex(/^[a-z0-9_-]+$/),

  /** Megjelenítési név a UI-ban */
  name: z.string(),

  /** Melyik ticket-típust hozza létre ez a lépés */
  ticket_type: z.enum(['interaction', 'training', 'monitor_alert']),

  /**
   * Ki végzi a lépést:
   * - "agent": a megnevezett agent_config_name-ű agenthez kerül
   * - "human": human approver/operator kapu
   */
  assignee_type: z.enum(['agent', 'human']),

  /**
   * Ha assignee_type="agent": az Agent Registry-ban lévő agent neve
   * (nem ID, hogy Playbook-verzió ne függjön egy konkrét agent-rekordon)
   */
  agent_name: z.string().optional(),

  /**
   * Ha assignee_type="human": melyik szerepkör kezeli (approver | operator | admin)
   * Default: "approver"
   */
  human_role: z.enum(['approver', 'operator', 'admin']).optional(),

  /**
   * Kemény kapuk, amelyek megakadályozzák az adott átmenetet a gate teljesítéséig.
   * Értelmezés: a "done" felé menő átmenetre rakott kapu emberi jóváhagyást vár.
   */
  gates: z
    .array(
      z.object({
        type: z.enum(['human_approval', 'eval_approval']),
        /** Melyik átmenetre vonatkozik. Default: in_progress → done */
        blocks: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .optional(),
        /** Feltétel, amely esetén a kapu nem alkalmazandó */
        unless_payload: z
          .object({
            field: z.string(),
            equals: z.union([z.string(), z.number(), z.boolean()]),
          })
          .optional(),
      }),
    )
    .optional(),

  /**
   * Mi jön ezután a lépés teljesülése esetén.
   * Egyszerű (nincs feltétel): on_complete: "next_step_id"
   * Elágazó: on_complete: { condition: ..., if_true: ..., if_false: ... }
   */
  on_complete: z
    .union([
      z.string(), // közvetlen következő lépés id-ja
      z.literal('end'), // a folyamat lezárul
      z.object({
        /**
         * Payload-mező alapú feltétel (determinisztikus, nem LLM).
         * field: payload mezőnév, operator: értékelési feltétel, value: elvárt érték
         */
        condition: z.object({
          field: z.string(),
          operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists']),
          value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        }),
        if_true: z.string(), // lépés id
        if_false: z.string(), // lépés id
      }),
    ])
    .default('end'),

  /**
   * Mi jön emberi elutasítás esetén (ha assignee_type="human" és gates tartalmaz
   * human_approval-t, de az approver "rejected"-re nyom).
   * Default: a folyamat hibás véget ér (process_instance: failed)
   */
  on_reject: z.string().optional(), // lépés id-ja, ahova visszaugrik
})

export const playbookProcessSchema = z.object({
  /** Egyedi verziónév-szerű azonosító (pl. "invoice-recon") — a Playbook.name mezővel egyezik */
  process_type: z.string(),

  /** Az első lépés id-ja */
  start: z.string(),

  /** A lépések definíciói */
  steps: z.array(processStepSchema),
})

export type ProcessStep = z.infer<typeof processStepSchema>
export type PlaybookProcess = z.infer<typeof playbookProcessSchema>
```

### 2.3 Példa Playbook spec (YAML-szerű JSON)

```json
{
  "process_type": "invoice-reconciliation",
  "start": "extract_fields",
  "steps": [
    {
      "id": "extract_fields",
      "name": "Mező-kinyerés",
      "ticket_type": "interaction",
      "assignee_type": "agent",
      "agent_name": "számla-feldolgozó",
      "on_complete": {
        "condition": { "field": "confidence", "operator": "gte", "value": 0.8 },
        "if_true": "reconcile",
        "if_false": "human_review"
      }
    },
    {
      "id": "reconcile",
      "name": "Egyeztetés",
      "ticket_type": "interaction",
      "assignee_type": "agent",
      "agent_name": "egyeztető-agent",
      "on_complete": "booking_proposal"
    },
    {
      "id": "human_review",
      "name": "Emberi ellenőrzés",
      "ticket_type": "interaction",
      "assignee_type": "human",
      "human_role": "approver",
      "gates": [{ "type": "human_approval" }],
      "on_complete": "reconcile",
      "on_reject": "extract_fields"
    },
    {
      "id": "booking_proposal",
      "name": "Könyvelési javaslat",
      "ticket_type": "interaction",
      "assignee_type": "agent",
      "agent_name": "könyvelő-agent",
      "gates": [
        {
          "type": "human_approval",
          "blocks": [{ "from": "awaiting_human", "to": "approved" }]
        }
      ],
      "on_complete": "end"
    }
  ]
}
```

### 2.4 DSL validáció-szabályok (build-time)

Az alábbi szabályokat a `validatePlaybookProcess()` helper kényszeríti ki (runtime hiba helyett admin-save pillanatában):

1. A `start` mezőnek léteznie kell a `steps` között
2. Minden `on_complete` és `on_reject` id-nak léteznie kell a `steps` között (vagy `"end"`)
3. Nincs holtpont: minden `agent`-típusú lépésnek van elérhető `on_complete`
4. Nincs végtelen ciklus (step graph aciklikus, kivéve az explicit `on_reject` visszaugrásoknál)
5. Az `agent_name` minden agent-lépésnél kitöltött
6. A `human_role` minden human-lépésnél kitöltött

---

## 3. Adatmodell-bővítés

### 3.1 Meglévő modellek változásai

**`PlaybookVersion.spec`** — a `Json` mező most `PlaybookProcess` formátumú JSON-t tartalmaz (visszafelé kompatibilis: a régi `PlaybookSpec[]` formátum is elfogadott, de az orchestrációhoz az új formátum szükséges).

**`Ticket`** — két új opcionális mező:
```prisma
processInstanceId String? @map("process_instance_id") @db.Uuid
stepId           String?  @map("step_id")   // a Playbook step id-ja, amelyhez ez a ticket tartozik
```

### 3.2 Új modell: `ProcessInstance`

```prisma
enum ProcessInstanceStatus {
  running
  completed
  failed
  cancelled
}

model ProcessInstance {
  id                 String                @id @default(uuid()) @db.Uuid
  tenantId           String?               @map("tenant_id") @db.Uuid
  playbookId         String                @map("playbook_id") @db.Uuid
  playbookVersionId  String                @map("playbook_version_id") @db.Uuid
  playbookRef        String                @map("playbook_ref")    // "playbook:name@v3" — audit-pin
  currentStepId      String?               @map("current_step_id") // null = completed/failed
  status             ProcessInstanceStatus @default(running)
  contextPayload     Json?                 @map("context_payload") // folyamat-szintű adatok (pl. forrás doc id)
  startedById        String?               @map("started_by_id") @db.Uuid
  startedAt          DateTime              @default(now()) @map("started_at") @db.Timestamptz
  completedAt        DateTime?             @map("completed_at") @db.Timestamptz

  playbook        Playbook        @relation(fields: [playbookId], references: [id])
  playbookVersion PlaybookVersion @relation(fields: [playbookVersionId], references: [id])
  startedBy       User?           @relation(fields: [startedById], references: [id])
  tickets         Ticket[]        @relation("ProcessTickets")
  transitions     ProcessTransition[]

  @@map("process_instances")
}

model ProcessTransition {
  id                String          @id @default(uuid()) @db.Uuid
  processInstanceId String          @map("process_instance_id") @db.Uuid
  fromStepId        String?         @map("from_step_id")  // null = process indulás
  toStepId          String?         @map("to_step_id")    // null = process vége/hiba
  ticketId          String?         @map("ticket_id") @db.Uuid  // a létrehozott ticket
  reason            String?         // "condition:confidence>=0.8" / "on_reject" / "human_approved" stb.
  ts                DateTime        @default(now()) @db.Timestamptz

  processInstance ProcessInstance @relation(fields: [processInstanceId], references: [id])

  @@map("process_transitions")
}
```

**Indexek:**
```prisma
@@index([processInstanceId, ts])   // ProcessTransition
@@index([processInstanceId])       // Ticket.processInstanceId
@@index([status, tenantId])        // ProcessInstance
```

---

## 4. PlaybookEngine service

**Fájl:** `app/src/domain/playbook/playbook-engine.ts`

A `PlaybookEngine` a fő koordináló logika. **Nem LLM-agent** — determinisztikus kód. Egyetlen feladata: egy lezárult ticket alapján a következő lépést meghatározni és elindítani.

```typescript
export class PlaybookEngine {
  constructor(
    private tickets: TicketRepository,
    private processInstances: ProcessInstanceRepository,
    private playbooks: PlaybookRepository,
    private agents: AgentRepository,
    private audit: AuditRepository,
  ) {}

  /**
   * Amikor egy ticket "done" vagy "rejected" állapotba lép, ezt hívja a TicketService.
   * Ha a ticket ProcessInstance-hoz tartozik, meghatározza a következő lépést.
   * Idempotens: ha a ProcessInstance már nem "running", nincs mellékhatás.
   */
  async advance(params: {
    ticket: Ticket
    outcome: 'done' | 'rejected'
    actorType: 'human' | 'agent' | 'system'
    actorId: string | null
  }): Promise<void> {
    if (!params.ticket.processInstanceId) return

    const instance = await this.processInstances.findById(params.ticket.processInstanceId)
    if (!instance || instance.status !== 'running') return

    const spec = await this._resolveSpec(instance.playbookRef)
    if (!spec) {
      await this._failInstance(instance, 'playbook_spec_not_found', params)
      return
    }

    const currentStep = spec.steps.find((s) => s.id === params.ticket.stepId)
    if (!currentStep) {
      await this._failInstance(instance, 'step_not_found', params)
      return
    }

    // Következő lépés meghatározása
    const nextStepId = this._resolveNextStep(currentStep, params.outcome, params.ticket)

    if (nextStepId === 'end' || nextStepId === null) {
      await this._completeInstance(instance, params)
      return
    }

    const nextStep = spec.steps.find((s) => s.id === nextStepId)
    if (!nextStep) {
      await this._failInstance(instance, `next_step_not_found:${nextStepId}`, params)
      return
    }

    await this._advanceToStep(instance, spec, currentStep.id, nextStep, params)
  }

  /**
   * Új ProcessInstance létrehozása és az első lépés ticket-jének megnyitása.
   */
  async startProcess(params: {
    playbookId: string
    contextPayload?: Record<string, unknown>
    startedById?: string
    tenantId?: string
  }): Promise<{ processInstance: ProcessInstance; ticket: Ticket }> {
    const activeVersion = await this.playbooks.getActiveVersionById(params.playbookId)
    if (!activeVersion) throw new Error('No active Playbook version found')

    const spec = parsePlaybookProcess(activeVersion.spec)
    const firstStep = spec.steps.find((s) => s.id === spec.start)
    if (!firstStep) throw new Error('Start step not found in Playbook spec')

    const playbookRef = formatPlaybookRef(activeVersion.playbook.name, activeVersion.version)

    const instance = await this.processInstances.create({
      playbookId: params.playbookId,
      playbookVersionId: activeVersion.id,
      playbookRef,
      currentStepId: firstStep.id,
      contextPayload: params.contextPayload ?? null,
      startedById: params.startedById ?? null,
      tenantId: params.tenantId ?? null,
    })

    const ticket = await this._createStepTicket(instance, firstStep, null)

    await this.audit.append({
      actorType: params.startedById ? 'human' : 'system',
      actorId: params.startedById ?? null,
      agentVersion: null,
      action: 'process.start',
      targetType: 'process_instance',
      targetId: instance.id,
      modelUsed: null,
      inputRef: playbookRef,
      outputRef: firstStep.id,
      policyDecision: 'pinned',
      metadata: { playbookRef, firstStepId: firstStep.id, ticketId: ticket.id },
    })

    return { processInstance: instance, ticket }
  }

  // ── Belső segédek ─────────────────────────────────────────────────────────

  private _resolveNextStep(
    step: ProcessStep,
    outcome: 'done' | 'rejected',
    ticket: Ticket,
  ): string | 'end' {
    if (outcome === 'rejected') {
      return step.on_reject ?? 'end'
    }

    const onComplete = step.on_complete
    if (typeof onComplete === 'string') return onComplete

    // Feltételes elágazás
    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null
        ? (ticket.payload as Record<string, unknown>)
        : {}

    return this._evalCondition(onComplete.condition, payload)
      ? onComplete.if_true
      : onComplete.if_false
  }

  private _evalCondition(
    condition: ProcessStep['on_complete'] extends { condition: infer C } ? C : never,
    payload: Record<string, unknown>,
  ): boolean {
    const value = payload[condition.field]
    switch (condition.operator) {
      case 'eq':       return value === condition.value
      case 'neq':      return value !== condition.value
      case 'gt':       return Number(value) > Number(condition.value)
      case 'gte':      return Number(value) >= Number(condition.value)
      case 'lt':       return Number(value) < Number(condition.value)
      case 'lte':      return Number(value) <= Number(condition.value)
      case 'exists':   return value !== undefined && value !== null
      case 'not_exists': return value === undefined || value === null
      default:         return false
    }
  }

  private async _createStepTicket(
    instance: ProcessInstance,
    step: ProcessStep,
    fromStepId: string | null,
  ): Promise<Ticket> {
    // Agent meghatározása (ha agent-lépés)
    let agentId: string | null = null
    if (step.assignee_type === 'agent' && step.agent_name) {
      const agent = await this.agents.findActiveByName(step.agent_name)
      agentId = agent?.id ?? null
    }

    const ticket = await this.tickets.create({
      type: step.ticket_type,
      title: step.name,
      state: 'ready',
      assigneeType: step.assignee_type === 'human' ? 'human' : 'agent',
      agentId,
      processInstanceId: instance.id,
      stepId: step.id,
      playbookRef: instance.playbookRef,
      payload: { processContext: instance.contextPayload },
    })

    await this.processInstances.recordTransition({
      processInstanceId: instance.id,
      fromStepId,
      toStepId: step.id,
      ticketId: ticket.id,
      reason: fromStepId ? `advance_from:${fromStepId}` : 'process_start',
    })

    return ticket
  }

  private async _advanceToStep(
    instance: ProcessInstance,
    spec: PlaybookProcess,
    fromStepId: string,
    nextStep: ProcessStep,
    params: { actorType: 'human' | 'agent' | 'system'; actorId: string | null },
  ): Promise<void> {
    await this.processInstances.updateCurrentStep(instance.id, nextStep.id)
    const ticket = await this._createStepTicket(instance, nextStep, fromStepId)

    await this.audit.append({
      actorType: params.actorType,
      actorId: params.actorId,
      agentVersion: null,
      action: 'process.advance',
      targetType: 'process_instance',
      targetId: instance.id,
      modelUsed: null,
      inputRef: fromStepId,
      outputRef: nextStep.id,
      policyDecision: 'deterministic',
      metadata: { playbookRef: instance.playbookRef, ticketId: ticket.id },
    })
  }

  private async _completeInstance(
    instance: ProcessInstance,
    params: { actorType: 'human' | 'agent' | 'system'; actorId: string | null },
  ): Promise<void> {
    await this.processInstances.complete(instance.id)
    await this.processInstances.recordTransition({
      processInstanceId: instance.id,
      fromStepId: instance.currentStepId,
      toStepId: null,
      ticketId: null,
      reason: 'process_end',
    })
    await this.audit.append({
      actorType: params.actorType,
      actorId: params.actorId,
      agentVersion: null,
      action: 'process.complete',
      targetType: 'process_instance',
      targetId: instance.id,
      modelUsed: null,
      inputRef: instance.playbookRef,
      outputRef: 'done',
      policyDecision: 'completed',
      metadata: { playbookRef: instance.playbookRef },
    })
  }

  private async _failInstance(
    instance: ProcessInstance,
    reason: string,
    params: { actorType: 'human' | 'agent' | 'system'; actorId: string | null },
  ): Promise<void> {
    await this.processInstances.fail(instance.id)
    await this.audit.append({
      actorType: params.actorType,
      actorId: params.actorId,
      agentVersion: null,
      action: 'process.fail',
      targetType: 'process_instance',
      targetId: instance.id,
      modelUsed: null,
      inputRef: instance.playbookRef,
      outputRef: reason,
      policyDecision: 'failed',
      metadata: { reason },
    })
  }

  private async _resolveSpec(playbookRef: string): Promise<PlaybookProcess | null> {
    const parsed = parsePlaybookRef(playbookRef)
    if (!parsed) return null
    const version = await this.playbooks.findVersionByNameAndVersion(parsed.name, parsed.version)
    if (!version) return null
    try {
      return parsePlaybookProcess(version.spec)
    } catch {
      return null
    }
  }
}
```

---

## 5. Integráció a TicketService-szel

**Bekötési pont:** `app/src/domain/ticket/ticket-service.ts` — a `transitionTicket()` metódus végén, ha az új állapot `done` vagy `rejected`.

```typescript
// ticket-service.ts — transitionTicket() metódus végén

if (toState === 'done' || toState === 'rejected') {
  // process-orchestráció nem-LLM hook — fire-and-forget, nem blokkolja a transition-t
  // Ha a PlaybookEngine hibázik, az audit-logba kerül, de a ticket átmenet nem gördül vissza
  void services.playbookEngine
    .advance({
      ticket: updatedTicket,
      outcome: toState === 'done' ? 'done' : 'rejected',
      actorType: params.actorType,
      actorId: params.actorId,
    })
    .catch((err) => {
      // Kritikus hiba: auditba, de ne állítsa le a ticket-átmenetet
      void services.audit.append({
        actorType: 'system',
        actorId: null,
        agentVersion: null,
        action: 'process.engine_error',
        targetType: 'ticket',
        targetId: updatedTicket.id,
        modelUsed: null,
        inputRef: updatedTicket.processInstanceId ?? 'unknown',
        outputRef: String(err?.message ?? 'unknown'),
        policyDecision: 'error',
        metadata: { error: String(err) },
      })
    })
}
```

**Fontos:** a `advance()` hívás `void` — a ticket-átmenet ne várjon rá. Az orchestrációs hiba audit-logba kerül, de nem gördíti vissza a ticket állapotát.

---

## 6. Repository interfész (`ProcessInstanceRepository`)

**Fájl:** `app/src/repositories/interfaces/index.ts` — kiegészítendő

```typescript
export interface ProcessInstanceRepository {
  create(input: {
    playbookId: string
    playbookVersionId: string
    playbookRef: string
    currentStepId: string
    contextPayload: Record<string, unknown> | null
    startedById: string | null
    tenantId: string | null
  }): Promise<ProcessInstance>

  findById(id: string): Promise<ProcessInstance | null>

  findAll(filter?: {
    tenantId?: string
    status?: ProcessInstanceStatus
    playbookId?: string
  }): Promise<(ProcessInstance & { transitions: ProcessTransition[] })[]>

  updateCurrentStep(id: string, stepId: string): Promise<void>

  complete(id: string): Promise<void>

  fail(id: string): Promise<void>

  cancel(id: string): Promise<void>

  recordTransition(input: {
    processInstanceId: string
    fromStepId: string | null
    toStepId: string | null
    ticketId: string | null
    reason: string
  }): Promise<ProcessTransition>

  getTransitions(processInstanceId: string): Promise<ProcessTransition[]>
}
```

---

## 7. Server actions API

**Fájl:** `app/src/app/actions/process.ts`

```typescript
// Folyamat indítása
startProcess(input: {
  playbookId: string
  contextPayload?: Record<string, unknown>
}) -> { processInstanceId: string; ticketId: string }
// [operator+] — audit: process.start

// Folyamat lemondása (csak running állapotban)
cancelProcess(input: { processInstanceId: string }) -> void
// [approver+] — audit: process.cancel; az aktuális ticket rejected-re, instance cancelled-re

// Futó folyamatok listája
listProcessInstances(filter?: {
  status?: ProcessInstanceStatus
  playbookId?: string
}) -> ProcessInstanceSummary[]
// [viewer+]

// Folyamat részletei + átmenetek + ticketek
getProcessInstance(input: { processInstanceId: string })
  -> { instance: ProcessInstance; transitions: ProcessTransition[]; tickets: Ticket[] }
// [viewer+]

// Playbook létrehozása / verziózása (meglévő PlaybookService-re épít)
createPlaybook(input: {
  name: string
  processType: string
  spec: PlaybookProcess   // az új, kiterjesztett formátum
}) -> { playbookId: string; versionId: string }
// [admin] — spec validáció: validatePlaybookProcess() futtatása + audit: playbook.create

approvePlaybookVersion(input: { versionId: string }) -> PlaybookVersion
// [approver+] — audit: playbook.approve

// Playbook lista + detail
listPlaybooks() -> PlaybookSummary[]
// [viewer+]

getPlaybook(input: { playbookId: string })
  -> { playbook: Playbook; versions: PlaybookVersion[]; activeSpec: PlaybookProcess | null }
// [viewer+]
```

---

## 8. Flow-vizualizáció (tervezett vs. tényleges)

### 8.1 Tervezett folyamat (Playbook-gráf)

A `PlaybookProcess` spec-ből generált, statikus gráf: lépések mint csomópontok, `on_complete` / `on_reject` mint élek. Ez a "hogyan kellene futnia" nézet.

**Megjelenítés:** SVG/HTML egyszerű folyamatábra — boxes + arrows. Nincs szükség külső diagramkönyvtárra: a lépések lineárisan, elágazásokkal jeleníthetők meg pure CSS-szel is (Flexbox + feltételes ágak).

```typescript
// Kliens-oldali helper: Playbook-spec → graph nodes + edges
export function playbookToGraph(spec: PlaybookProcess): {
  nodes: { id: string; label: string; type: 'agent' | 'human' | 'end' }[]
  edges: { from: string; to: string; label?: string }[]
}
```

### 8.2 Tényleges folyamat (audit-log / process transitions)

A `ProcessTransition` tábla minden lépés-átmenetet rögzít. A tényleges gráf ebből rajzolható:
- Lépett-e az eddig várt lépéstől eltérő irányba? → **eltérés kiemelve**
- Visszaugrásos kör (pl. human_review → extract_fields → human_review)? → Jelölve
- Melyik lépésnél tart jelenleg? → Aktív lépés kiemelve

```typescript
export function transitionsToGraph(transitions: ProcessTransition[]): {
  nodes: { id: string; label: string; visitCount: number }[]
  edges: { from: string; to: string; reason: string; ts: Date }[]
  currentStepId: string | null
}
```

### 8.3 Összehasonlítás a UI-ban

A `ProcessInstance` részletes oldalán két panel egymás mellett:
- **Bal:** tervezett folyamat (Playbook-gráf)
- **Jobb:** tényleges futás (transitions-gráf, aktív lépés kiemelve)
- Eltérések (pl. emberi review-ba terelés, visszaugrás) **narancssárgával** jelölve

Ez a "szándékolt vs. tényleges" nézet (§4.10.3) direkt compliance-argumentum: az auditor látja, hogy a rendszer pontosan a Playbooknak megfelelően futott, vagy ha nem, hol tért el és miért.

---

## 9. UI komponensek

### 9.1 Navigáció

Az `/control-plane/layout.tsx` bővítendő:
```
Playbooks → /control-plane/playbooks
Folyamatok → /control-plane/processes
```

### 9.2 Playbook lista + szerkesztő (`/control-plane/playbooks`)

| Oldal | Komponens | Tartalom |
|---|---|---|
| `/control-plane/playbooks` | `PlaybookList` | Playbook-ok listája (név, process_type, aktív verzió, státusz) + "Új Playbook" gomb |
| `/control-plane/playbooks/new` | `PlaybookEditorForm` | Név, process_type, spec JSON szerkesztő (Monaco/textarea) + validáció-feedback |
| `/control-plane/playbooks/[playbookId]` | `PlaybookDetail` | Verziólista, aktív spec vizualizáció, "Jóváhagyás" gomb |

**Spec-szerkesztő:** a PlaybookProcess JSON-t egy `<textarea>` + valós idejű Zod-validációval. Ha a JSON érvényes, megjelenik a tervezett folyamat gráfja. Szintaktikus hiba esetén hibaüzenet, nem menti.

### 9.3 Folyamat-dashboard (`/control-plane/processes`)

| Oldal | Komponens | Tartalom |
|---|---|---|
| `/control-plane/processes` | `ProcessInstanceList` | Futó / kész / hibás folyamatok listája (Playbook neve, indulás, aktuális lépés, státusz) |
| `/control-plane/processes/[instanceId]` | `ProcessInstanceDetail` | Flow-vizualizáció (tervezett + tényleges), ticket-lista, timeline |

**ProcessInstanceList táblázat oszlopai:**
- Playbook neve + verzió
- Indítva (mikor, ki)
- Aktuális lépés neve
- Státusz (futó / kész / hibás / lemondva)
- Eltelt idő
- Akció: "Részletek" / "Lemond"

### 9.4 Folyamat indítása

A folyamatindítás két helyről lehetséges:
1. **Playbook detail oldalról:** "Folyamat indítása" gomb → modal (opcionális context adat megadással)
2. **Sandwich-action a ticket boardon:** ha egy ticket típushoz van rendelt Playbook, a ticket card-on megjelenik "Folyamat indítása" opció

---

## 10. Audit követelmények

Minden process-esemény az `audit_log` hash-láncolt naplóba kerül. Kötelező event típusok:

| Esemény | `action` | `targetType` | Mikor |
|---|---|---|---|
| Folyamat indítása | `process.start` | `process_instance` | `startProcess()` első lépésnél |
| Lépés-előre | `process.advance` | `process_instance` | `advance()` sikeres következő lépésnél |
| Folyamat befejezése | `process.complete` | `process_instance` | Utolsó lépés `"end"` kimeneténél |
| Folyamat lemondása | `process.cancel` | `process_instance` | `cancelProcess()` |
| Folyamat hibája | `process.fail` | `process_instance` | `_failInstance()` — hiányzó step, séma hiba |
| Motor belső hibája | `process.engine_error` | `ticket` | A `catch` ágban, ha advance() kivételt dob |
| Playbook létrehozása | `playbook.create` | `playbook` | `createPlaybook()` |
| Playbook jóváhagyása | `playbook.approve` | `playbook` | `approvePlaybookVersion()` |

Az audit payload `metadata` mezőjébe minden esetben bekerül:
- `playbookRef` — `"playbook:name@vN"` (az adott futáshoz leszögezett verzió)
- Érintett `ticketId`, `stepId` ahol releváns

---

## 11. Implementációs fázisok

### PO-A — Adatmodell + Engine alap (nem-LLM, single-step advance)

**Scope:**
- `ProcessInstance` + `ProcessTransition` Prisma modellek és migration
- `Ticket` schema: `processInstanceId`, `stepId` opcionális mezők
- `PlaybookProcess` Zod séma + `validatePlaybookProcess()` + `parsePlaybookProcess()`
- `ProcessInstanceRepository` Postgres implementáció
- `PlaybookEngine` service — `startProcess()` + `advance()` + `_evalCondition()` + belső segédek
- `PlaybookEngine` bekötése a `TicketService.transitionTicket()`-be (fire-and-forget hook)
- `PlaybookEngine` + `startProcess()` server action
- Tesztek: `playbook-engine.test.ts` — legalább: linear 3-step flow, elágazásos flow, on_reject visszaugrás, engine-error nem gurítja vissza a ticket-átmenetet

**Elfogadási kritérium:** egy 3-lépéses lineáris folyamat manuálisan elindítható, és minden ticket-done esemény automatikusan létrehozza a következő lépés ticketjét, audit-logban nyomon követhető.

### PO-B — Playbook CRUD + Admin UI

**Scope:**
- `createPlaybook` / `approvePlaybookVersion` server actions
- `listPlaybooks` / `getPlaybook` server actions
- `PlaybookEditorForm` (spec-szerkesztő + validáció)
- `PlaybookDetail` oldal (verziólista + jóváhagyás)
- Tervezett folyamat gráf vizualizáció (statikus, Playbook-spec-ből)

**Elfogadási kritérium:** admin létrehozhat és jóváhagyhat egy Playbookat a UI-ból; a spec hibás esetén hibaüzenet jelenik meg mentés előtt.

### PO-C — Process Dashboard + Flow-vizualizáció

**Scope:**
- `listProcessInstances` / `getProcessInstance` server actions
- `ProcessInstanceList` + `ProcessInstanceDetail` UI oldalak
- Tényleges folyamat gráf (transitions-ból)
- Tervezett vs. tényleges összehasonlítás (eltérések jelölése)
- `cancelProcess` server action + UI

**Elfogadási kritérium:** az auditor meg tudja nyitni egy futó folyamat részleteit, és egymás mellett látja a tervezett és tényleges lépéseket; eltérések narancssárgával jelölve.

### PO-D — Elágazás + on_reject + multi-agent tesztforgatókönyv

**Scope:**
- A számla-reconciliation mintaforgatókönyv (2.3 példa spec) teljes körű tesztelése
- Minden elágazási ág és `on_reject` visszaugrás valódi ticketekkel
- Folyamat indítása a ticket board-ról (sandwich-action)
- Seed: minta Playbook a platformon (`invoice-reconciliation`)

**Elfogadási kritérium:** a 4-lépéses számla-reconciliation folyamat elejétől végig végigvihető — beleértve az emberi elutasítást visszaugrással, és az alacsony-konfidencia elágazást; minden átmenet audit-logban.

---

## 12. Biztonsági és governance szempontok

### 12.1 Playbook jóváhagyási kapu (kötelező)

A Playbook-verzió `status: proposed` állapotban születik; csak `approver+` szereppel kerülhet `active`-ra. Aktív Playbookot **nem lehet utólag módosítani** — új verziót kell létrehozni és jóváhagyni. Ez a `write-gate` / memória-jóváhagyási elv (§4.6.1) kiterjesztése a folyamat-specifikációra.

**Következmény:** futó ProcessInstance-ok mindig a **leszögezett verziót** (`playbookRef = "playbook:name@v3"`) használják. Ha a Playbookot frissítik a folyamat közben, az nem hat a már futó instance-okra.

### 12.2 Az Engine nem hoz LLM-döntést

A `_resolveNextStep()` kizárólag `payload` mező-összehasonlítást végez (`_evalCondition`). Ha a következő lépés meghatározásához LLM-re lenne szükség, **ez nem a `PlaybookEngine` dolga** — ilyen esetben a Playbook-step egy agent-ticketet hoz létre, amely az LLM-döntést elvégzi és a `payload.next_step`-be írja az eredményt; a következő advance() ezt olvassa ki. **Soha nem hív LLM-et maga az Engine.**

### 12.3 `cancelProcess` hatásköre

A folyamat lemondása:
1. A `ProcessInstance` `cancelled` státuszra vált
2. A jelenleg aktív ticket `rejected` állapotra vált (a `PlaybookEngine.advance()` hook ezután futna, de a `cancelled` instance-t nem lépteti tovább)
3. Audit-log bejegyzés: `process.cancel` + indoklás

Csak `approver+` szereppel lehetséges. Az admin saját magát **nem védheti** a saját folyamat-leállítása alól — a kill-switch globálisan érvényes (§PM-D minta alapján).

### 12.4 Injection-védelem

Mivel a `_evalCondition()` payload-értékeket hasonlít össze, és a payload agent által írt JSON, az injection vektora az lenne, ha egy agent a payload-ba olyan értéket ír, amely egy érzékeny kapun `if_true` ágat vált ki. **Ellenőrzés:** az agent által írható payload mezők körét a Ticket payload-séma (Zod) és a Tool Broker `board_write` scope korlátozza. A `_evalCondition()` csak a meglévő payload-értéket olvassa, nem hajt végre kódot — tisztán adatösszehasonlítás.

---

## 13. Nyitott döntések

| # | Kérdés | Jelenlegi javaslat |
|---|---|---|
| D-PO-1 | `processInstanceId` indexelés a Ticket táblán — szükséges-e külön FK-constraint? | Igen, FK a `process_instances` felé, soft-delete nélkül |
| D-PO-2 | Párhuzamos lépések (fork-join) mikor kerülnek be? | v2, nem ebben a spec-ben |
| D-PO-3 | Playbook-sablon importálás (YAML-fájlból) — admin felületen? | PO-D után, külön mini-spec |
| D-PO-4 | Mi történik, ha az engine-ben lévő `_createStepTicket` hibázik (pl. agent_name nem létező)? | `_failInstance()` + audit `process.fail`, az operator javít + újraindítás |
| D-PO-5 | Folyamat újraindítása (restart from step X)? | Out of scope / v2 — manuálisan cancelProcess + új startProcess a kívánt lépéstől |

---

## 14. Kapcsolódó dokumentumok

- `AI-Agent-Platform-Koncepcio.md` — §4.10.2 (kötelező Playbook), §4.10.3 (folyamat-vizualizáció), §4.10.5 (delegálási státusz-réteg), §4.10.6 (Playbook-elsődleges végrehajtás), §4.5.1 (orchestrátor-szerep)
- `AI-Agent-Platform-MVP-Dev-Spec-Roadmap-v1.0.md` — §5.1 állapotgép (transitionTicket hook), §5.7 dispatcher (process-ticketek ugyanúgy kerülnek a sorba)
- `AI-Agent-Platform-Feature-Spec-Proactive-Monitor.md` — párhuzam a determinisztikus motor-mintiával (PM-A non-LLM sweep engine)
- `app/src/lib/playbook-spec.ts` — a meglévő DSL (bővítendő, nem kell teljes cserélni)
- `app/src/domain/playbook/playbook-service.ts` — a meglévő service (PlaybookEngine erre épül)
