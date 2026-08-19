/**
 * ProcessService (Feature-spec — Playbook §8.2, §7.3, §12 F2-C).
 *
 * A Fázis 2 process runtime: folyamatinditas Playbook-verzio PIN-eléssel, a
 * következő step/ticket determinisztikus létrehozása a pin-elt `compiled_spec`
 * routing szabályai alapján, és a delegacios él-lánc (pending → delivered → done).
 *
 * KULCS-INVARIÁNSOK, amelyeket KÓDSZINTEN véd (§2):
 *  - egy folyamatinditas pontosan EGY `playbook_version_id`-t pin-el, és az a
 *    folyamat végéig nem cserélhető (§2.1, §2.2, P9);
 *  - a runtime SOHA nem a draft Playbookot olvassa, hanem a pin-elt verzió
 *    `compiled_spec`-jét (§15, P9);
 *  - a kötelező kapukat NEM itt, hanem a `TicketStateMachine` ticket-szinten
 *    kényszeríti ki; ez a réteg csak a routingot és a step/delegacio-vezetést végzi.
 *
 * A determinisztikus döntéseket a `@/lib/playbook-v2/runtime` (`evaluateAdvance`)
 * tiszta magja hozza; ez a service köti DB-hez és audithoz.
 */
import type { Prisma, ProcessInstance, ProcessTriggerType, TicketState } from '@prisma/client'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import { evaluateAdvance, type AdvanceDecision } from '@/lib/playbook-v2/runtime'
import { stringifyValue } from '@/lib/playbook-v2/effective-prompt'
import {
  humanReviewTicketTitle,
  missingRequiredInputSlots,
  normalizeAgentStepResult,
  readStepOutcome,
  resolveStepInputPayload,
} from '@/lib/playbook-v2/process-step-payload'
import { ADVANCEABLE_PROCESS_STATUSES } from '@/lib/playbook-v2/process-status'
import { formatPlaybookRefV2, parsePlaybookSpecV2, type PlaybookRole } from '@/lib/playbook-v2/spec'
import { isAgentSuitable } from '@/domain/playbook/suitability'
import type { AgentAccessService } from '@/domain/agent-access/agent-access-service'
import { isHumanUserSuitable } from '@/domain/playbook/human-role-suitability'
import type {
  AgentRepository,
  AuditRepository,
  PlaybookV2Repository,
  ProcessDefinitionRepository,
  ProcessRepository,
  TenantMembershipRepository,
  TicketRepository,
  ToolBrokerRepository,
  UserRepository,
  CreateTicketAttachmentInput,
} from '@/repositories/interfaces'

export type ProcessActor = { type: 'user' | 'agent' | 'system'; id?: string | null }

export type ProcessServiceErrorCode =
  | 'NOT_FOUND_OR_FORBIDDEN'
  | 'NO_PLAYBOOK_ASSIGNED'
  | 'VERSION_NOT_PUBLISHED'
  | 'COMPILED_SPEC_MISSING'
  | 'INVALID_STATE'
  | 'PROCESS_DEFINITION_DEPS_MISSING'

export class ProcessServiceError extends Error {
  constructor(
    readonly code: ProcessServiceErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'ProcessServiceError'
  }
}

/**
 * Belső jelzés: egy lépés-ticket nem hozható létre, mert a szerep→agent kötés
 * hiányzik vagy alkalmatlan (§4.5, §4.11). A hívó (start/advance) elkapja és a
 * Futást `blocked`-be viszi + riaszt — néma megállás tilos.
 */
class ProcessBlockedError extends Error {
  constructor(
    readonly stepId: string,
    readonly reason: string,
  ) {
    super(reason)
    this.name = 'ProcessBlockedError'
  }
}

/**
 * Szűk, dedikált riasztó-adapter a `blocked` Futáshoz (§4.5, §4.11). A
 * governance-elv szerint (l. Proactive Monitor) allowlistolt chat-webhookon megy,
 * NEM gmail_send-en. Best-effort: a `process.blocked` AUDIT mindig megtörténik,
 * a riasztás hibája nem nyeli el a blokk tényét.
 */
export interface ProcessAlertNotifier {
  processBlocked(input: {
    tenantId: string | null
    processInstanceId: string
    stepId: string
    reason: string
  }): Promise<void>
}

/**
 * Eseményvezérelt jóváhagyás előfeltétele (Telegram feature-spec #70/#76, prefactor): amikor egy
 * ticket `awaiting_human`-ba lép, a runtime CSAK ESEMÉNYT jelez — NEM hív közvetlenül semmilyen
 * csatornát (D11). Az esemény felvevője (pl. a Telegram jóváhagyó-szolgáltatás) dönti el, kinek és
 * hogyan küld jogosultság-tudatos gombokat. A kibocsátás BEST-EFFORT: a hibája nem buktathatja a
 * folyamat-léptetést (az `awaiting_human` tényét az audit már rögzítette), és a négyórás
 * elakadás-figyelő biztonsági hálóként FÜGGETLENÜL megmarad. Alapból nincs bekötve (a régi
 * viselkedés változatlan) — a setter köti be.
 */
export interface AwaitingHumanEventSink {
  awaitingHuman(event: {
    ticketId: string
    tenantId: string | null
    processInstanceId: string
    stepId: string
    /** A kötelező kapu azonosítója, ha kapu-ághoz tartozik (különben `null` = általános review). */
    gateId: string | null
  }): Promise<void>
}

/** A szerep→agent feloldás kontextusa egy Folyamatból indított Futáshoz. */
type RoleResolution = {
  roleBindings: Record<string, string>
  roleByKey: Map<string, PlaybookRole>
}

export type ProcessAdvanceResult =
  | { kind: 'next_step'; stepId: string; ticketId: string }
  | { kind: 'await_gate'; gateId: string; ticketId: string }
  // WP-7 §10.2 — implicit hiba-él (kezeletlen blocked/failed) → emberi felülvizsgálat.
  | { kind: 'await_human'; reason: string; ticketId: string }
  | { kind: 'completed' }
  | { kind: 'blocked'; stepId: string; reason: string }
  // Idempotens no-op: az advance egy már NEM tovább-léptethető (lezárt/blokkolt)
  // folyamatra futott — pl. egy már done ticket újra-dispatch-elése miatt.
  | { kind: 'noop'; status: ProcessInstance['status'] }

/**
 * Hibapolicy spec §9 — melyik réteg döntött a hiba-ág kiválasztásáról (audit).
 * `null`, ha a döntés nem hiba-él (happy path / decision / transition).
 */
function errorRouteSourceOf(
  decision: AdvanceDecision,
): 'step' | 'playbook_default' | 'tenant_default' | 'await_human_fallback' | null {
  if (decision.kind === 'await_human') return 'await_human_fallback'
  if (decision.kind === 'next_step' || decision.kind === 'await_gate') {
    const edgeType = decision.rule.edgeType
    if (edgeType === 'error' || edgeType === 'blocked') {
      return decision.rule.errorRouteSource ?? 'step'
    }
  }
  return null
}

export class ProcessService {
  constructor(
    private readonly processes: ProcessRepository,
    private readonly playbooks: PlaybookV2Repository,
    private readonly tickets: TicketRepository,
    private readonly audit: AuditRepository,
    // §7 Folyamat-alapú indításhoz szükséges opcionális függőségek. Ha nincsenek
    // bekötve, csak a régi processType-út működik (visszafelé kompatibilis).
    private readonly defs?: ProcessDefinitionRepository,
    private readonly agents?: AgentRepository,
    private readonly toolBroker?: ToolBrokerRepository,
    private readonly users?: UserRepository,
    // §4.3/§4.8 — az emberi (`human_role`) szereplő tenant-tagságát a membership-modell
    // dönti el (nem a `user.tenantId`); enélkül a resolveUserForRole cross-tenant usert
    // is felold. A #153 agent-oldali kapu emberi párja. Ha hiányzik és a Folyamatnak
    // valós tenantja van, a feloldás fail-closed módon blokkol.
    private readonly tenantMemberships?: TenantMembershipRepository,
    private readonly alertNotifier?: ProcessAlertNotifier,
    // Azonnali dispatch-gyorsítóút (§5.7 kiegészítés): a belépő/soron következő
    // agent-step ticketjét ugyanabban a kérésben elindítja, ahelyett hogy a
    // NOTIFY/cron-safety-net külön workerére várna. Launcher-mód-független —
    // docker-local/cloud-run-job/local-wiki esetén a launch() fire-and-forget,
    // a tényleges eredmény a harness-callbacken / háttérfutáson jön vissza. Ha hiányzik (pl.
    // tesztekben), a ticket a régi módon 'ready'-ben marad a worker/cron számára.
    private readonly dispatchTicket?: (ticketId: string) => Promise<unknown>,
  ) {}

  /**
   * Az `awaiting_human` esemény felvevője (#76 prefactor). Setter-injektálás (mint a
   * `toolBrokerService.setPlaybookTransitioner`), hogy a késői wiring ne bővítse a pozicionális
   * konstruktort. Alapból nincs — a régi viselkedés változatlan.
   */
  private awaitingHumanSink?: AwaitingHumanEventSink

  setAwaitingHumanSink(sink: AwaitingHumanEventSink): void {
    this.awaitingHumanSink = sink
  }

  /**
   * #142 — az agent-hozzáférési gráf SHADOW ellenőrzője. Setter-injektálás (mint az
   * `awaitingHumanSink`), hogy a késői wiring ne bővítse a pozicionális konstruktort.
   * Ha nincs bekötve, a folyamat pontosan úgy fut, mint eddig, csak nem keletkezik
   * `agent.access.bypass` esemény.
   */
  private agentAccess?: AgentAccessService

  setAgentAccessService(service: AgentAccessService): void {
    this.agentAccess = service
  }

  /**
   * A folyamat agent-elérésének SHADOW ellenőrzése (a spec „Playbook- és Monitor-
   * megkerülő út" fejezete). A folyamat-definíció maga a runtime principal
   * jogosítványa, ezért NEM blokkolunk — csak auditálunk, ha az ad-hoc gráf
   * elutasítaná ezt az utat.
   *
   * Az alany a delegáló ELŐZŐ lépés agentje (agent→agent), különben a Futást indító
   * ember (user→agent). Best-effort: a shadow-check hibája nem állíthatja meg a
   * folyamatot — az megfordítaná a „auditál, nem blokkol" szabályt.
   */
  private async recordProcessAccessShadow(params: {
    tenantId: string | null
    process: ProcessInstance
    delegationFrom?: { fromStepId: string; fromTicketId: string | null }
    targetAgentId: string
  }): Promise<void> {
    if (!this.agentAccess || !params.tenantId) return
    try {
      const previousAgentId = params.delegationFrom
        ? (await this.processes.findStep(params.process.id, params.delegationFrom.fromStepId))
            ?.assignedAgentId ?? null
        : null

      const subject = previousAgentId
        ? ({ kind: 'agent', agentId: previousAgentId, tenantId: params.tenantId } as const)
        : params.process.startedByUserId
          ? ({ kind: 'user', userId: params.process.startedByUserId, tenantId: params.tenantId } as const)
          : params.process.startedByAgentId
            ? ({ kind: 'agent', agentId: params.process.startedByAgentId, tenantId: params.tenantId } as const)
            : null
      if (!subject) return
      if (subject.kind === 'agent' && subject.agentId === params.targetAgentId) return

      await this.agentAccess.recordProcessBypass({
        subject,
        targetAgentId: params.targetAgentId,
        verb: 'address',
        processInstanceId: params.process.id,
        processDefinitionId: params.process.processDefinitionId,
        playbookVersionId: params.process.playbookVersionId,
      })
    } catch {
      // Szándékosan néma: a shadow-audit sosem állíthat meg egy futó folyamatot.
    }
  }

  /**
   * Az `awaiting_human` esemény BEST-EFFORT kibocsátása. A runtime NEM hív közvetlenül csatornát
   * (D11) — csak jelez; a hiba nem buktathatja a folyamat-léptetést.
   */
  private async emitAwaitingHuman(event: {
    ticketId: string
    tenantId: string | null
    processInstanceId: string
    stepId: string
    gateId: string | null
  }): Promise<void> {
    if (!this.awaitingHumanSink) return
    try {
      await this.awaitingHumanSink.awaitingHuman(event)
    } catch {
      // best-effort — az `awaiting_human` tényét az audit már rögzítette; a négyórás
      // elakadás-figyelő biztonsági hálóként úgyis felveszi.
    }
  }

  /** Best-effort azonnali dispatch — bukása nem hiúsíthatja meg a step/ticket létrehozását. */
  private async triggerImmediateDispatch(tenantId: string | null, ticketId: string): Promise<void> {
    if (!this.dispatchTicket) return
    try {
      await this.dispatchTicket(ticketId)
    } catch (error) {
      await this.append(tenantId, { type: 'system' }, {
        action: 'process.step.dispatch_deferred',
        targetType: 'ticket',
        targetId: ticketId,
        policyDecision: 'deferred',
        metadata: {
          error: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  // --- §8.2 startProcess -----------------------------------------------------

  async startProcess(input: {
    tenantId: string | null
    processType?: string
    playbookVersionId?: string
    // §7.a — a Folyamat-alapú indítás elsődleges belépője (ÚJ).
    processDefinitionId?: string | null
    triggerType?: ProcessTriggerType | null
    inputPayload: Record<string, unknown>
    startedBy: ProcessActor
    conversationId?: string | null
    rootTicketId?: string | null
    /** Chat-trigger: a csatolt fájlok a belépő ticket bemeneti csatolmányai lesznek. */
    attachments?: CreateTicketAttachmentInput[]
  }): Promise<ProcessInstance> {
    if (input.processDefinitionId) {
      return this.startFromDefinition({
        tenantId: input.tenantId,
        processDefinitionId: input.processDefinitionId,
        triggerType: input.triggerType ?? 'manual',
        inputPayload: input.inputPayload,
        startedBy: input.startedBy,
        conversationId: input.conversationId ?? null,
        rootTicketId: input.rootTicketId ?? null,
        attachments: input.attachments,
      })
    }
    if (!input.processType) {
      throw new ProcessServiceError('INVALID_STATE', 'processType vagy processDefinitionId megadása kötelező.')
    }
    return this.startFromProcessType({
      tenantId: input.tenantId,
      processType: input.processType,
      playbookVersionId: input.playbookVersionId,
      inputPayload: input.inputPayload,
      startedBy: input.startedBy,
      conversationId: input.conversationId ?? null,
    })
  }

  /** §8.2 (legacy) — indítás process_type default-assignmentből vagy explicit verzióból. */
  private async startFromProcessType(input: {
    tenantId: string | null
    processType: string
    playbookVersionId?: string
    inputPayload: Record<string, unknown>
    startedBy: ProcessActor
    conversationId?: string | null
  }): Promise<ProcessInstance> {
    // §8.2 — explicit verzió, vagy default assignment a process_type-hoz.
    const versionId = input.playbookVersionId ?? (await this.resolveDefaultVersionId(input.tenantId, input.processType))
    const version = await this.playbooks.findVersion(input.tenantId, versionId)
    if (!version) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A Playbook-verzió nem található vagy nincs jogosultság.')
    }
    if (version.status !== 'published') {
      throw new ProcessServiceError('VERSION_NOT_PUBLISHED', 'Csak published Playbook-verzióval indítható folyamat.')
    }
    const playbook = await this.playbooks.findPlaybook(input.tenantId, version.playbookId)
    if (!playbook) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A Playbook nem található.')
    }
    const compiled = this.requireCompiled(version.compiledSpec)
    const playbookRef = formatPlaybookRefV2(playbook.key, version.version)

    // §4.5 — process_instance létrehozás a PIN-elt verzióval.
    const process = await this.processes.createProcess({
      tenantId: input.tenantId,
      processType: input.processType,
      playbookId: playbook.id,
      playbookVersionId: version.id,
      playbookRef,
      playbookContentHash: version.contentHash,
      startedByType: input.startedBy.type,
      startedByUserId: input.startedBy.type === 'user' ? input.startedBy.id ?? null : null,
      startedByAgentId: input.startedBy.type === 'agent' ? input.startedBy.id ?? null : null,
      conversationId: input.conversationId ?? null,
      inputPayload: input.inputPayload as Prisma.InputJsonValue,
    })

    await this.append(input.tenantId, input.startedBy, {
      action: 'process.start',
      targetType: 'process_instance',
      targetId: process.id,
      inputRef: playbookRef,
      outputRef: version.contentHash,
      policyDecision: 'started',
      metadata: {
        process_instance_id: process.id,
        process_type: input.processType,
        playbook_id: playbook.id,
        playbook_version_id: version.id,
        playbook_ref: playbookRef,
        playbook_content_hash: version.contentHash,
        started_by_type: input.startedBy.type,
        conversation_id: input.conversationId ?? null,
      },
    })

    // Belépő step + root ticket létrehozása (§7.3 entryStepId).
    const entryRule = compiled.ticketRules.find((r) => r.stepId === compiled.entryStepId)
    if (!entryRule) {
      throw new ProcessServiceError('COMPILED_SPEC_MISSING', 'A compiled spec nem tartalmaz belépő stepet.')
    }
    let ticket
    try {
      ticket = await this.createStepWithTicket(
        input.tenantId,
        process,
        compiled,
        entryRule.stepId,
        input.startedBy,
        { processInput: input.inputPayload },
      )
    } catch (e) {
      if (e instanceof ProcessBlockedError) {
        return this.blockProcess(input.tenantId, process.id, e.stepId, e.reason, input.startedBy)
      }
      throw e
    }

    await this.processes.updateProcess(process.id, { status: 'running', rootTicketId: ticket.id })
    return this.processes.findProcess(input.tenantId, process.id) as Promise<ProcessInstance>
  }

  /**
   * §7.a — indítás egy AKTÍV Folyamatból (ProcessDefinition). A szerep→agent kötést
   * a Folyamat adja (§4.4 egyetlen forrás); a belépő lépés-ticket a feloldott
   * tényleges agenthez jön létre. Feloldhatatlan/alkalmatlan kötés vagy hiányzó
   * kötelező trigger-rés → a Futás `blocked` + riasztás (§4.5, §4.11) — nem néma.
   */
  private async startFromDefinition(input: {
    tenantId: string | null
    processDefinitionId: string
    triggerType: ProcessTriggerType
    inputPayload: Record<string, unknown>
    startedBy: ProcessActor
    conversationId: string | null
    rootTicketId: string | null
    attachments?: CreateTicketAttachmentInput[]
  }): Promise<ProcessInstance> {
    if (!this.defs || !this.agents || !this.toolBroker) {
      throw new ProcessServiceError(
        'PROCESS_DEFINITION_DEPS_MISSING',
        'A Folyamat-alapú indításhoz nincsenek bekötve a szükséges repository-k.',
      )
    }
    const def = await this.defs.findById(input.tenantId, input.processDefinitionId)
    if (!def) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A Folyamat nem található vagy nincs jogosultság.')
    }
    if (def.status !== 'active') {
      throw new ProcessServiceError('INVALID_STATE', 'Csak AKTÍV Folyamatból indítható Futás.')
    }
    const version = await this.playbooks.findVersion(input.tenantId, def.playbookVersionId)
    if (!version) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A PIN-elt Playbook-verzió nem található.')
    }
    const playbook = await this.playbooks.findPlaybook(input.tenantId, version.playbookId)
    if (!playbook) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A Playbook nem található.')
    }
    const compiled = this.requireCompiled(version.compiledSpec)
    const spec = parsePlaybookSpecV2(version.spec)
    const playbookRef = formatPlaybookRefV2(playbook.key, version.version)
    const resolution: RoleResolution = {
      roleBindings: this.asStringRecord(def.roleBindings),
      roleByKey: new Map(spec.roles.map((r) => [r.key, r])),
    }

    // §4.7 — a Folyamat `configValues`-ai a `config`-forrású input-réseket töltik.
    // A futás inputPayloadja a Folyamat configja + a trigger-input uniója; ütközéskor
    // az explicit trigger-input nyer. Enélkül a `config`-slotok sosem oldódnának fel,
    // és a folyamat az első config-slotos lépésnél blokkolna.
    const runInput: Record<string, unknown> = {
      ...this.asRecord(def.configValues),
      ...input.inputPayload,
    }

    const process = await this.processes.createProcess({
      tenantId: input.tenantId,
      processType: playbook.processType,
      playbookId: playbook.id,
      playbookVersionId: version.id,
      playbookRef,
      playbookContentHash: version.contentHash,
      processDefinitionId: def.id,
      triggerType: input.triggerType,
      startedByType: input.startedBy.type,
      startedByUserId: input.startedBy.type === 'user' ? input.startedBy.id ?? null : null,
      startedByAgentId: input.startedBy.type === 'agent' ? input.startedBy.id ?? null : null,
      conversationId: input.conversationId,
      rootTicketId: input.rootTicketId,
      inputPayload: runInput as Prisma.InputJsonValue,
    })

    await this.append(input.tenantId, input.startedBy, {
      action: 'process.start',
      targetType: 'process_instance',
      targetId: process.id,
      inputRef: playbookRef,
      outputRef: version.contentHash,
      policyDecision: 'started',
      metadata: {
        process_instance_id: process.id,
        process_type: playbook.processType,
        process_definition_id: def.id,
        trigger_type: input.triggerType,
        playbook_id: playbook.id,
        playbook_version_id: version.id,
        playbook_ref: playbookRef,
        playbook_content_hash: version.contentHash,
        started_by_type: input.startedBy.type,
        conversation_id: input.conversationId,
      },
    })

    const entryRule = compiled.ticketRules.find((r) => r.stepId === compiled.entryStepId)
    if (!entryRule) {
      throw new ProcessServiceError('COMPILED_SPEC_MISSING', 'A compiled spec nem tartalmaz belépő stepet.')
    }
    let ticket
    try {
      ticket = await this.createStepWithTicket(
        input.tenantId,
        process,
        compiled,
        entryRule.stepId,
        input.startedBy,
        { processInput: runInput, attachments: input.attachments },
        undefined,
        resolution,
      )
    } catch (e) {
      if (e instanceof ProcessBlockedError) {
        return this.blockProcess(input.tenantId, process.id, e.stepId, e.reason, input.startedBy)
      }
      throw e
    }

    await this.processes.updateProcess(process.id, {
      status: 'running',
      rootTicketId: input.rootTicketId ?? ticket.id,
    })
    return this.processes.findProcess(input.tenantId, process.id) as Promise<ProcessInstance>
  }

  // --- §8.2 advance ----------------------------------------------------------

  /**
   * §7.3 — a befejezett step routing-szabályai alapján létrehozza a következő
   * stepet/ticketet, vagy kaput nyit, vagy lezárja a folyamatot. A determinisztikus
   * választást az `evaluateAdvance` tiszta mag hozza a pin-elt compiled spec ellen.
   */
  async advance(input: {
    tenantId: string | null
    processInstanceId: string
    completedStepId: string
    completedGateId?: string | null
    actor: ProcessActor
    resultPayload?: Record<string, unknown>
  }): Promise<ProcessAdvanceResult> {
    const process = await this.processes.findProcess(input.tenantId, input.processInstanceId)
    if (!process) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A folyamat nem található vagy nincs jogosultság.')
    }
    // Idempotencia-őr: lezárt (completed/cancelled/failed) vagy blokkolt folyamatra
    // az advance NEM lép és NEM ír státuszt. Ez zárja ki, hogy egy már done ticket
    // újra-dispatch-elése a `next_step` ágon keresztül visszaírja `running`-ra a
    // korábban `blocked`-ba tett folyamatot (§7.3, dispatcher double-dispatch).
    if (!ADVANCEABLE_PROCESS_STATUSES.has(process.status)) {
      return { kind: 'noop', status: process.status }
    }
    const version = await this.playbooks.findVersion(input.tenantId, process.playbookVersionId)
    const compiled = this.requireCompiled(version?.compiledSpec)
    // §7.b — Folyamatból indított Futásnál a következő lépések agentje is a
    // Folyamat kötéséből oldódik fel; legacy (processDefinitionId nélküli) Futásnál null.
    const resolution = version ? await this.loadResolution(process, version) : null

    const completedStep = await this.processes.findStep(process.id, input.completedStepId)
    // Idempotencia-őr (2. réteg): ha EZ a step már korábban lezárult (`completed`)
    // vagy már kapura/emberi felülvizsgálatra lett irányítva (`awaiting_gate` —
    // ezt KIZÁRÓLAG az advance() await_gate/await_human ága állítja), akkor egy
    // sima (nem kapu-jóváhagyási) advance-hívás egy késő/duplikált dispatch
    // visszhangja (harness timeout reclaim vagy dupla ready-poll). Egy ilyen
    // visszhang a `next_step` ágon át felülírná a folyamat közben már beállt
    // `awaiting_human`/`blocked` státuszát `running`-ra (lásd
    // [[process-config-slot-stuck-running]]) — ezért itt, ÚJRA-feldolgozás
    // nélkül, no-op-ot adunk. A `completedGateId`-vel érkező hívás (emberi
    // jóváhagyó nyitja a kaput) NEM duplikátum — a step SZÁNDÉKOSAN
    // `awaiting_gate`-ben van, ezt kell tovább-léptetnie.
    if (
      !input.completedGateId &&
      completedStep &&
      (completedStep.status === 'completed' || completedStep.status === 'awaiting_gate')
    ) {
      return { kind: 'noop', status: process.status }
    }
    if (completedStep && completedStep.status !== 'completed') {
      await this.processes.updateStep(completedStep.id, {
        status: 'completed',
        completedAt: new Date(),
        resultPayload: (input.resultPayload ?? {}) as Prisma.InputJsonValue,
      })
    }
    await this.append(input.tenantId, input.actor, {
      action: 'process.step.complete',
      targetType: 'process_step_instance',
      targetId: completedStep?.id ?? input.completedStepId,
      inputRef: process.playbookRef,
      policyDecision: 'completed',
      metadata: { process_instance_id: process.id, step_id: input.completedStepId },
    })

    // Az ebbe a stepbe vezető delegacios él(ek) lezárása (done).
    await this.closeIncomingDelegations(process.id, input.completedStepId)

    const decision = input.completedGateId
      ? this.evaluateGateAdvance(compiled, input.completedStepId, input.completedGateId)
      : evaluateAdvance(compiled, input.completedStepId, input.resultPayload ?? {})
    // Hibakezelési policy spec §9 — a step gépi outcome-ja audit-visszakereshető legyen
    // minden ágon (miért ment arra a döntésre), routing-viselkedés módosítása nélkül.
    const {
      status: outcomeStatus,
      reason: outcomeReason,
      message: outcomeMessage,
    } = readStepOutcome(input.resultPayload)

    if (decision.kind === 'complete') {
      const finalized = await this.processes.updateProcessIfStatusIn(
        process.id,
        [...ADVANCEABLE_PROCESS_STATUSES],
        {
          status: 'completed',
          completedAt: new Date(),
          outputPayload: (input.resultPayload ?? {}) as Prisma.InputJsonValue,
        },
      )
      if (!finalized) {
        const fresh = await this.processes.findProcess(input.tenantId, process.id)
        return { kind: 'noop', status: fresh?.status ?? process.status }
      }
      await this.append(input.tenantId, input.actor, {
        action: 'process.complete',
        targetType: 'process_instance',
        targetId: process.id,
        inputRef: process.playbookRef,
        policyDecision: 'completed',
        metadata: { process_instance_id: process.id },
      })
      return { kind: 'completed' }
    }

    if (decision.kind === 'await_gate') {
      // §7.3 — kötelező kapu ág: a step kapura vár, a folyamat emberi jóváhagyásra.
      if (completedStep) {
        await this.processes.updateStep(completedStep.id, { status: 'awaiting_gate' })
      }
      const gate = compiled.gates.find((g) => g.gateId === decision.gateId)
      const gateTicket = await this.tickets.create({
        tenantId: input.tenantId,
        type: 'interaction',
        title: `Kapu jóváhagyás: ${decision.gateId}`,
        state: 'awaiting_human',
        assigneeType: 'human',
        assigneeId: null,
        agentId: null,
        payload: (input.resultPayload ?? {}) as Prisma.JsonObject,
        sourceDocumentId: null,
        executeAfter: null,
        dueBy: null,
        createdById: this.systemUserId(process),
        processInstanceId: process.id,
        playbookRef: process.playbookRef,
        playbookVersionId: process.playbookVersionId,
        playbookStepId: input.completedStepId,
        requiredGateId: decision.gateId,
      })
      await this.processes.updateProcess(process.id, { status: 'awaiting_human' })
      await this.append(input.tenantId, input.actor, {
        action: 'process.step.await_gate',
        targetType: 'process_instance',
        targetId: process.id,
        inputRef: process.playbookRef,
        policyDecision: 'awaiting_gate',
        metadata: {
          process_instance_id: process.id,
          completed_step_id: input.completedStepId,
          gate_id: decision.gateId,
          selected_outcome: decision.selectedOutcome ?? null,
          matched_condition: decision.rule.condition ?? null,
          edge_type: decision.rule.edgeType ?? null,
          required_actor_role: gate?.requiredActorRole ?? null,
          ticket_id: gateTicket.id,
          playbook_version_id: process.playbookVersionId,
          outcome_status: outcomeStatus ?? null,
          outcome_reason: outcomeReason ?? null,
          error_route_source: errorRouteSourceOf(decision),
        },
      })
      // #76 prefactor — eseményvezérelt jóváhagyás: a kapu-ticket `awaiting_human`-ba lépett,
      // jelezzük (NEM hívunk közvetlenül csatornát, D11).
      await this.emitAwaitingHuman({
        ticketId: gateTicket.id,
        tenantId: input.tenantId,
        processInstanceId: process.id,
        stepId: input.completedStepId,
        gateId: decision.gateId,
      })
      return { kind: 'await_gate', gateId: decision.gateId, ticketId: gateTicket.id }
    }

    if (decision.kind === 'await_human') {
      // WP-7 §10.2 — kezeletlen blocked/failed step: implicit BPMN error boundary.
      // A tartalmi kudarc SOHA nem propagál sikerként; emberi felülvizsgálatra vár.
      // #33/#39 — a felülvizsgáló közérthető magyarázatot kap (outcome.message), nem
      // nyers `unhandled_blocked` címet.
      if (completedStep) {
        await this.processes.updateStep(completedStep.id, { status: 'awaiting_gate' })
      }
      const displayReason = outcomeMessage ?? decision.reason
      const reviewTicket = await this.tickets.create({
        tenantId: input.tenantId,
        type: 'interaction',
        title: humanReviewTicketTitle(input.completedStepId, outcomeMessage),
        state: 'awaiting_human',
        assigneeType: 'human',
        assigneeId: null,
        agentId: null,
        payload: (input.resultPayload ?? {}) as Prisma.JsonObject,
        sourceDocumentId: null,
        executeAfter: null,
        dueBy: null,
        createdById: this.systemUserId(process),
        processInstanceId: process.id,
        playbookRef: process.playbookRef,
        playbookVersionId: process.playbookVersionId,
        playbookStepId: input.completedStepId,
        requiredGateId: null,
      })
      await this.processes.updateProcess(process.id, { status: 'awaiting_human' })
      await this.append(input.tenantId, input.actor, {
        action: 'process.blocked',
        targetType: 'process_instance',
        targetId: process.id,
        inputRef: process.playbookRef,
        policyDecision: 'blocked',
        metadata: {
          process_instance_id: process.id,
          completed_step_id: input.completedStepId,
          reason: displayReason,
          routing_reason: decision.reason,
          human_summary: outcomeMessage ?? null,
          outcome_status: decision.outcomeStatus,
          outcome_reason: outcomeReason ?? null,
          error_route_source: errorRouteSourceOf(decision),
          ticket_id: reviewTicket.id,
          playbook_version_id: process.playbookVersionId,
        },
      })
      if (this.alertNotifier) {
        try {
          await this.alertNotifier.processBlocked({
            tenantId: input.tenantId,
            processInstanceId: process.id,
            stepId: input.completedStepId,
            reason: displayReason,
          })
        } catch {
          // best-effort riasztás (§4.5) — a blokk tényét az audit már rögzítette.
        }
      }
      // #76 prefactor — a review-ticket `awaiting_human`-ba lépett; eseményt jelzünk (a felvevő
      // dönti el, kap-e valaki jogosultság-tudatos gombot; általános review-nál nincs kapu → null).
      await this.emitAwaitingHuman({
        ticketId: reviewTicket.id,
        tenantId: input.tenantId,
        processInstanceId: process.id,
        stepId: input.completedStepId,
        gateId: null,
      })
      return { kind: 'await_human', reason: displayReason, ticketId: reviewTicket.id }
    }

    // decision.kind === 'next_step'
    const freshProcess = await this.processes.findProcess(input.tenantId, process.id)
    if (!freshProcess || !ADVANCEABLE_PROCESS_STATUSES.has(freshProcess.status)) {
      return { kind: 'noop', status: freshProcess?.status ?? process.status }
    }

    await this.append(input.tenantId, input.actor, {
      action: 'process.step.advance',
      targetType: 'process_instance',
      targetId: process.id,
      inputRef: process.playbookRef,
      policyDecision: 'advanced',
      metadata: {
        process_instance_id: process.id,
        completed_step_id: input.completedStepId,
        target_kind: 'next_step',
        target_id: decision.toStepId,
        selected_outcome: decision.selectedOutcome ?? null,
        matched_condition: decision.rule.condition ?? null,
        edge_type: decision.rule.edgeType ?? null,
        outcome_status: outcomeStatus ?? null,
        outcome_reason: outcomeReason ?? null,
        error_route_source: errorRouteSourceOf(decision),
        playbook_version_id: process.playbookVersionId,
        playbook_content_hash: version?.contentHash ?? null,
      },
    })
    // Csak created/awaiting_human-ból emeljük running-ra — terminális (pl. completed)
    // állapotot SOHA nem írhatunk felül (verseny: késő, párhuzamos next_step advance).
    await this.processes.updateProcessIfStatusIn(process.id, ['created', 'awaiting_human'], {
      status: 'running',
    })
    let nextTicket
    try {
      const stillAdvanceable = await this.processes.findProcess(input.tenantId, process.id)
      if (!stillAdvanceable || !ADVANCEABLE_PROCESS_STATUSES.has(stillAdvanceable.status)) {
        return { kind: 'noop', status: stillAdvanceable?.status ?? freshProcess.status }
      }
      const completedRule = compiled.ticketRules.find((r) => r.stepId === input.completedStepId)
      const previousStepResult = normalizeAgentStepResult(
        completedRule,
        input.resultPayload ?? {},
      )
      nextTicket = await this.createStepWithTicket(
        input.tenantId,
        process,
        compiled,
        decision.toStepId,
        input.actor,
        {
          processInput: this.asRecord(process.inputPayload),
          previousStepResult,
        },
        { fromStepId: input.completedStepId, fromTicketId: completedStep?.ticketId ?? null },
        resolution,
      )
    } catch (e) {
      if (e instanceof ProcessBlockedError) {
        await this.blockProcess(input.tenantId, process.id, e.stepId, e.reason, input.actor)
        return { kind: 'blocked', stepId: e.stepId, reason: e.reason }
      }
      throw e
    }
    return { kind: 'next_step', stepId: decision.toStepId, ticketId: nextTicket.id }
  }

  private evaluateGateAdvance(
    compiled: CompiledSpec,
    completedStepId: string,
    completedGateId: string,
  ): Exclude<ReturnType<typeof evaluateAdvance>, { kind: 'await_gate' }> {
    const gateRule = compiled.routingRules.find(
      (r) => r.fromStepId === completedStepId && r.gateId === completedGateId,
    )
    if (!gateRule?.toStepId) return { kind: 'complete' }
    return { kind: 'next_step', toStepId: gateRule.toStepId, rule: gateRule }
  }

  // --- §8.2 cancelProcess ----------------------------------------------------

  async cancelProcess(input: {
    tenantId: string | null
    processInstanceId: string
    reason: string
    actorUserId: string
  }): Promise<ProcessInstance> {
    const process = await this.processes.findProcess(input.tenantId, input.processInstanceId)
    if (!process) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A folyamat nem található vagy nincs jogosultság.')
    }
    if (process.status === 'completed' || process.status === 'cancelled') {
      throw new ProcessServiceError('INVALID_STATE', `Lezárt folyamat nem vonható vissza (${process.status}).`)
    }
    const updated = await this.processes.updateProcess(process.id, {
      status: 'cancelled',
      completedAt: new Date(),
    })
    await this.append(input.tenantId, { type: 'user', id: input.actorUserId }, {
      action: 'process.cancel',
      targetType: 'process_instance',
      targetId: process.id,
      inputRef: process.playbookRef,
      policyDecision: 'cancelled',
      metadata: { process_instance_id: process.id, reason: input.reason },
    })
    return updated
  }

  async getProcess(tenantId: string | null, processInstanceId: string) {
    const detail = await this.processes.findProcessDetail(tenantId, processInstanceId)
    if (!detail) {
      throw new ProcessServiceError('NOT_FOUND_OR_FORBIDDEN', 'A folyamat nem található vagy nincs jogosultság.')
    }
    return detail
  }

  async listProcesses(
    tenantId: string | null,
    opts?: { limit?: number; offset?: number; unbounded?: boolean },
  ) {
    return this.processes.listProcesses(tenantId, opts)
  }

  // --- Belső segédek ---------------------------------------------------------

  /** Step instance + a hozzá tartozó ticket létrehozása, opcionális delegacios éllel. */
  private async createStepWithTicket(
    tenantId: string | null,
    process: ProcessInstance,
    compiled: CompiledSpec,
    stepId: string,
    actor: ProcessActor,
    slotContext: {
      processInput: Record<string, unknown>
      previousStepResult?: Record<string, unknown>
      attachments?: CreateTicketAttachmentInput[]
    },
    delegationFrom?: { fromStepId: string; fromTicketId: string | null },
    resolution?: RoleResolution | null,
  ) {
    const rule = compiled.ticketRules.find((r) => r.stepId === stepId)
    if (!rule) {
      throw new ProcessServiceError('COMPILED_SPEC_MISSING', `Nincs compiled szabály a(z) '${stepId}' stephez.`)
    }
    const ticketPayload = this.stepTicketPayload(rule, slotContext)
    const attachments = slotContext.attachments ?? []
    if (attachments.length > 0) {
      ticketPayload.attachmentDocumentIds = attachments.map((attachment) => attachment.documentId)
    }
    const isHuman = this.isHumanStep(rule)
    const requiredGateId = isHuman
      ? compiled.gates.find((g) => g.stepId === stepId && g.blocking)?.gateId ?? null
      : null

    // §4.4/§7.b — agent/human lépésnél a tényleges szereplő a Folyamat kötéséből oldódik fel
    // (ha Folyamatból indult a Futás). Feloldhatatlan/alkalmatlan kötés → ProcessBlockedError,
    // amit a hívó (start/advance) `blocked`-be fordít. A szereplő-feloldás a step/ticket
    // létrehozása ELŐTT történik, hogy blokk esetén ne maradjon részleges rekord.
    const resolvedAgentId =
      !isHuman && resolution
        ? await this.resolveAgentForRole(tenantId, resolution, rule.assignedRole, rule.stepId)
        : null
    const resolvedUserId =
      isHuman && resolution
        ? await this.resolveUserForRole(tenantId, resolution, rule.assignedRole, rule.stepId)
        : null

    // #142 — SHADOW ellenőrzés. A folyamat-definíció MAGA a runtime principal
    // jogosítványa, ezért a Playbook-út NEM áll meg az ad-hoc gráf deny döntésén; de
    // ha az ad-hoc út elutasítaná ezt a lépést, `agent.access.bypass` eseményt írunk.
    // Így a compliance-felelős látja, hol használ egy folyamat olyan agent-utat,
    // amit egy ember vagy egy agent ad hoc nem járhatna be.
    if (resolvedAgentId) {
      await this.recordProcessAccessShadow({
        tenantId,
        process,
        delegationFrom,
        targetAgentId: resolvedAgentId,
      })
    }

    const step = await this.processes.createStep({
      tenantId,
      processInstanceId: process.id,
      stepId: rule.stepId,
      stepName: rule.stepName,
      status: 'ready',
      assignedRole: rule.assignedRole,
      assignedAgentId: resolvedAgentId,
      assignedUserId: resolvedUserId,
    })

    // A belépő agent-step azonnal dispatch-elhető (ready); az emberi step awaiting_human.
    const ticketState: TicketState = isHuman ? 'awaiting_human' : 'ready'
    const ticket = await this.tickets.create(
      {
        tenantId,
        type: 'interaction',
        title: rule.stepName,
        state: ticketState,
        assigneeType: isHuman ? 'human' : 'agent',
        assigneeId: resolvedUserId,
        agentId: resolvedAgentId,
        payload: ticketPayload as Prisma.JsonObject,
        sourceDocumentId: attachments[0]?.documentId ?? null,
        executeAfter: null,
        dueBy: null,
        createdById: this.systemUserId(process),
        processInstanceId: process.id,
        playbookRef: process.playbookRef,
        playbookVersionId: process.playbookVersionId,
        playbookStepId: rule.stepId,
        requiredGateId,
        conversationId: process.conversationId,
      },
      attachments.length > 0 ? { attachments } : undefined,
    )

    await this.processes.updateStep(step.id, { ticketId: ticket.id, startedAt: new Date() })

    await this.append(tenantId, actor, {
      action: 'process.step.create',
      targetType: 'process_step_instance',
      targetId: step.id,
      inputRef: process.playbookRef,
      policyDecision: 'ready',
      metadata: {
        process_instance_id: process.id,
        step_id: rule.stepId,
        ticket_id: ticket.id,
        assignee_type: isHuman ? 'human' : 'agent',
        assigned_agent_id: resolvedAgentId,
        assigned_user_id: resolvedUserId,
        required_gate_id: requiredGateId,
      },
    })

    if (delegationFrom) {
      const delegation = await this.processes.createDelegation({
        tenantId,
        processInstanceId: process.id,
        fromStepId: delegationFrom.fromStepId,
        toStepId: rule.stepId,
        fromTicketId: delegationFrom.fromTicketId,
        toTicketId: ticket.id,
        fromActorType: actor.type,
        fromAgentId: actor.type === 'agent' ? actor.id ?? null : null,
        fromUserId: actor.type === 'user' ? actor.id ?? null : null,
        toActorType: isHuman ? 'user' : 'agent',
        toAgentId: resolvedAgentId,
        toUserId: resolvedUserId,
      })
      // A ready ticket egyúttal "delivered" a fogadó szereplőnek (§4.7 delegacios státusz).
      await this.processes.updateDelegation(delegation.id, {
        status: 'delivered',
        deliveredAt: new Date(),
      })
      await this.append(tenantId, actor, {
        action: 'delegation.create',
        targetType: 'delegation_edge',
        targetId: delegation.id,
        inputRef: process.playbookRef,
        policyDecision: 'delivered',
        metadata: {
          process_instance_id: process.id,
          from_step_id: delegationFrom.fromStepId,
          to_step_id: rule.stepId,
          to_ticket_id: ticket.id,
        },
      })
    }

    // Azonnali dispatch: agent-step ready ticketje ugyanabban a kérésben elindul,
    // ahelyett hogy a NOTIFY-t figyelő workerre / cron-safety-netre várna.
    if (!isHuman) {
      await this.triggerImmediateDispatch(tenantId, ticket.id)
    }

    return ticket
  }

  private stepTicketPayload(
    rule: CompiledSpec['ticketRules'][number],
    slotContext: {
      processInput: Record<string, unknown>
      previousStepResult?: Record<string, unknown>
    },
  ): Record<string, unknown> {
    const resolved = resolveStepInputPayload(rule, {
      processInput: slotContext.processInput,
      previousStepResult: slotContext.previousStepResult ?? {},
    })
    const missing = missingRequiredInputSlots(rule, resolved)
    if (missing.length > 0) {
      throw new ProcessBlockedError(
        rule.stepId,
        `A(z) '${rule.stepId}' step ticketjéhez hiányzó kötelező input-rés(ek): ${missing.join(', ')}.`,
      )
    }
    const payload: Record<string, unknown> = { ...resolved }
    if (rule.instructionTemplate) {
      payload.question = rule.instructionTemplate.replace(/\{\{(\w+)\}\}/g, (_, token: string) => {
        const v = resolved[token]
        return v !== undefined && v !== null ? stringifyValue(v) : ''
      })
    }
    return payload
  }

  /** Az adott stepbe vezető nyitott delegacios él(eke)t done-ra állítja (§4.7). */
  private async closeIncomingDelegations(processInstanceId: string, toStepId: string) {
    const delegations = await this.processes.listDelegations(processInstanceId)
    for (const d of delegations) {
      if (d.toStepId === toStepId && d.status !== 'done' && d.status !== 'failed') {
        await this.processes.updateDelegation(d.id, { status: 'done', doneAt: new Date() })
      }
    }
  }

  /**
   * §7.b — a szerep→agent feloldás EGYETLEN forrása a Folyamat `roleBindings`-je.
   * A kötött agentet újra ellenőrzi (`isAgentSuitable`), mert időközben inaktívvá
   * válhatott (§4.8, §4.11). Hiány/alkalmatlanság → ProcessBlockedError.
   */
  private async resolveAgentForRole(
    tenantId: string | null,
    resolution: RoleResolution,
    roleKey: string,
    stepId: string,
  ): Promise<string> {
    const agentId = resolution.roleBindings[roleKey]
    if (!agentId) {
      throw new ProcessBlockedError(stepId, `A(z) '${roleKey}' szerephez nincs agent kötve a Folyamaton.`)
    }
    if (!this.agents || !this.toolBroker) {
      throw new ProcessBlockedError(stepId, 'Nincs agent-repository az alkalmasság-ellenőrzéshez.')
    }
    const agent = await this.agents.findById(agentId)
    if (!agent) {
      throw new ProcessBlockedError(stepId, `A(z) '${roleKey}' szerephez kötött agent nem található.`)
    }
    const capabilities = await this.toolBroker.findCapabilitiesForAgent(agentId)
    const role = resolution.roleByKey.get(roleKey)
    // A tenant-határt a Futás (Folyamat) tenantjához mérjük, NEM az agent saját
    // tenantjához — különben a cross-tenant kötés önmagával egyezne és sosem bukna el.
    const suitability = isAgentSuitable(
      { status: agent.status, tenantId: agent.tenantId, capabilities },
      { requiredCapabilities: role?.requiredCapabilities },
      tenantId,
    )
    if (!suitability.ok) {
      throw new ProcessBlockedError(
        stepId,
        `A(z) '${roleKey}' szerephez kötött agent alkalmatlan: ${suitability.reason}`,
      )
    }
    return agentId
  }

  private async resolveUserForRole(
    tenantId: string | null,
    resolution: RoleResolution,
    roleKey: string,
    stepId: string,
  ): Promise<string> {
    const userId = resolution.roleBindings[roleKey]
    if (!userId) {
      throw new ProcessBlockedError(stepId, `A(z) '${roleKey}' emberi szerephez nincs user kötve a Folyamaton.`)
    }
    if (!this.users) {
      throw new ProcessBlockedError(stepId, 'Nincs user-repository az emberi szerep feloldásához.')
    }
    const user = await this.users.findById(userId)
    if (!user) {
      throw new ProcessBlockedError(stepId, `A(z) '${roleKey}' szerephez kötött user nem található.`)
    }
    // §4.3/§4.8 — a tenant-határt a FOLYAMAT tenantjához mérjük (nem a user sajátjához),
    // a valódi tagságot a membership-modell dönti el. Valós tenant → aktív tagság kötelező;
    // null (platform) Folyamatnál nincs tagság-fogalom, csak a status/role kapu él. Membership-repo
    // nélkül, valós tenantnál FAIL-CLOSED: nem oldunk fel ellenőrizetlenül cross-tenant usert.
    let membership: { status: string } | null = null
    if (tenantId) {
      if (!this.tenantMemberships) {
        throw new ProcessBlockedError(
          stepId,
          `A(z) '${roleKey}' emberi szerep tenant-tagsága nem ellenőrizhető (nincs membership-repository).`,
        )
      }
      membership = await this.tenantMemberships.findByTenantAndUser(tenantId, userId)
    }
    const suitability = isHumanUserSuitable({ status: user.status, role: user.role }, membership, tenantId)
    if (!suitability.ok) {
      throw new ProcessBlockedError(stepId, `A(z) '${roleKey}' szerephez kötött ${suitability.reason}`)
    }
    return userId
  }

  /** A Folyamatból indított Futáshoz betölti a szerep→agent feloldás kontextusát. */
  private async loadResolution(
    process: ProcessInstance,
    version: { spec: unknown },
  ): Promise<RoleResolution | null> {
    if (!process.processDefinitionId || !this.defs) return null
    const def = await this.defs.findById(process.tenantId, process.processDefinitionId)
    if (!def) return null
    const spec = parsePlaybookSpecV2(version.spec)
    return {
      roleBindings: this.asStringRecord(def.roleBindings),
      roleByKey: new Map(spec.roles.map((r) => [r.key, r])),
    }
  }

  /**
   * §4.5, §4.11 — a Futást `blocked`-be viszi, KÖTELEZŐ `process.blocked` auditot ír
   * (a Futás-nézet ebből mutatja az elakadás-okot), és best-effort riasztást küld.
   * Néma, gazdátlan megállás tilos: az audit mindig megtörténik, a riasztás hibája
   * nem nyeli el a blokk tényét.
   */
  private async blockProcess(
    tenantId: string | null,
    processInstanceId: string,
    stepId: string,
    reason: string,
    actor: ProcessActor,
  ): Promise<ProcessInstance> {
    await this.processes.updateProcess(processInstanceId, { status: 'blocked' })
    await this.append(tenantId, actor, {
      action: 'process.blocked',
      targetType: 'process_instance',
      targetId: processInstanceId,
      policyDecision: 'blocked',
      metadata: { process_instance_id: processInstanceId, step_id: stepId, reason },
    })
    if (this.alertNotifier) {
      try {
        await this.alertNotifier.processBlocked({ tenantId, processInstanceId, stepId, reason })
      } catch {
        // A blokk tényét az audit már rögzítette; a riasztás best-effort (§4.5).
      }
    }
    return this.processes.findProcess(tenantId, processInstanceId) as Promise<ProcessInstance>
  }

  private asStringRecord(value: unknown): Record<string, string> {
    const out: Record<string, string> = {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
    }
    return out
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  }

  private async resolveDefaultVersionId(tenantId: string | null, processType: string): Promise<string> {
    const assignment = await this.playbooks.findDefaultAssignment(tenantId, 'process_type', processType)
    if (!assignment) {
      throw new ProcessServiceError(
        'NO_PLAYBOOK_ASSIGNED',
        `Nincs default Playbook a(z) '${processType}' folyamattípushoz.`,
      )
    }
    return assignment.playbookVersionId
  }

  private requireCompiled(compiledSpec: unknown): CompiledSpec {
    if (!compiledSpec || typeof compiledSpec !== 'object') {
      throw new ProcessServiceError('COMPILED_SPEC_MISSING', 'A pin-elt verziónak nincs compiled spec-je.')
    }
    return compiledSpec as CompiledSpec
  }

  private isHumanStep(rule: CompiledSpec['ticketRules'][number]): boolean {
    // A compiler a human role-os step átmeneteit kizárólag 'user' actornak engedi.
    const first = rule.allowedTransitions[0]
    if (!first) return false
    return first.allowedActorTypes.length === 1 && first.allowedActorTypes[0] === 'user'
  }

  private systemUserId(process: ProcessInstance): string {
    // A ticket.created_by NOT NULL; a folyamat indítóját (ha user) használjuk, különben rendszer-aktor.
    return process.startedByUserId ?? process.startedByAgentId ?? SYSTEM_ACTOR_ID
  }

  private async append(
    tenantId: string | null,
    actor: ProcessActor,
    entry: {
      action: string
      targetType: string
      targetId: string
      inputRef?: string | null
      outputRef?: string | null
      policyDecision?: string | null
      metadata?: Record<string, unknown>
    },
  ) {
    const actorType = actor.type === 'user' ? 'human' : actor.type
    await this.audit.append({
      actorType,
      actorId: actor.id ?? null,
      agentVersion: null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      modelUsed: null,
      inputRef: entry.inputRef ?? null,
      outputRef: entry.outputRef ?? null,
      policyDecision: entry.policyDecision ?? null,
      metadata: { tenantId, ...(entry.metadata ?? {}) },
    })
  }
}

/** Rendszer-aktor placeholder, ha nincs emberi/agent indító user-id (pl. system-trigger). */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000'
