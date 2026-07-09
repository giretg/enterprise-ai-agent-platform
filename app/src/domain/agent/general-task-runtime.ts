import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
  PlaybookV2Repository,
  ProcessRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import type { Prisma } from '@prisma/client'
import type { CompiledSpec } from '@/domain/playbook/playbook-compiler'
import type { ConversationService, ConversationMessageView } from '@/domain/conversation/conversation-service'
import type { StepOutcome } from '@/lib/playbook-v2/spec'
import { composeSystemPrompt } from '@/lib/agent-prompt'
import { formatOrgRoster } from '@/lib/agent-org-roster'
import { buildEffectivePrompt } from '@/lib/playbook-v2/effective-prompt'
import {
  agentAnswerStructuredFromPayload,
  computeStepOutcome,
  DEFAULT_DELIVERABLE_FIELD,
  DELIVERABLE_TOOL_BY_FORMAT,
  extractAgentAnswerDisplayBody,
  formatDeliverableInstruction,
  formatOutputContractInstruction,
  outputRequiredFieldsForStep,
  parseAgentStepOutput,
  pickDeliverableFile,
  playbookSlotValuesFromTicketPayload,
  requireDeliverableFile,
} from '@/lib/playbook-v2/process-step-payload'
import { readTicketPromptText } from '@/lib/wiki-ticket-payload'
import { formatHitsForPrompt, type KbHit } from '@/lib/kb-format'
import { distillKbSearchQuery } from '@/lib/kb-query'
import { buildThreadContextPrompt, latestHumanTicketComment } from '@/lib/ticket-thread-prompt'
import { buildMemoryRetrievalQuery } from '../conversation/context-assembly'
import { MEMORY_RETRIEVAL_USAGE_PROMPT, kbSearchAnswerInstruction } from '@/lib/memory-prompt'
import {
  buildMemoryRetrievalRequest,
  loadProjectMemoryContext,
  memoryContextSystemMessages,
} from '../memory/memory-runtime-helper'
import type { MemoryRetrievalService } from '../memory/memory-retrieval-service'
import type { ModelGateway, ModelConfig } from '../gateway/model-gateway'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../file-editor/workspace-storage'
import { formatAttachmentBlock } from './agent-chat-runtime'
import { listAllowedChatTools, resolveToolLoopMaxTurns, runAgentToolLoop, type LoadSkillFn } from './chat-tool-loop'
import type { SkillService } from '../skill/skill-service'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAttachmentIds(payload: Record<string, unknown>): string[] {
  const ids = payload.attachmentDocumentIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

function safeToolResultName(value: string): string {
  const cleaned = value.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '')
  return cleaned.slice(0, 80) || 'tool-result'
}

function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n[levagva]`
}

function formatConversationForPrompt(messages: ConversationMessageView[]): string | null {
  const relevant = messages.filter((m) => m.content?.trim())
  if (relevant.length === 0) return null
  const rendered = relevant
    .map((m) => `[${m.seq}] ${m.role}: ${clipText(m.content!.trim(), 1200)}`)
    .join('\n')
  return clipText(rendered, 8000)
}

type ProcessStepContext = {
  compiled: CompiledSpec
  stepRule: CompiledSpec['ticketRules'][number]
  outputRequiredFields: string[]
}

/**
 * A sikeres (`ok`) lépés happy-path cél-állapota a compiled state-machine-ből, nem beégetve.
 * Emberi kapuval védett lépésen az agent kimenete SOHA nem léphet `done`-ra (§2.5): ott csak
 * `in_progress → awaiting_human` engedélyezett, ahol a jóváhagyó dönt. Normál (kapu nélküli)
 * lépésen `in_progress → done` az agent útja. Nem-Folyamat (chat/delegálás) ticketnél nincs
 * compiled szabály → `done` a visszamenőleg kompatibilis alapértelmezés.
 */
function resolveHappyPathCompletionState(
  processStep: ProcessStepContext | null,
): 'done' | 'awaiting_human' {
  if (!processStep) return 'done'
  const fromInProgress = processStep.stepRule.allowedTransitions.filter(
    (t) => t.fromState === 'in_progress' && t.allowedActorTypes.includes('agent'),
  )
  if (fromInProgress.some((t) => t.toState === 'done')) return 'done'
  if (fromInProgress.some((t) => t.toState === 'awaiting_human')) return 'awaiting_human'
  return 'done'
}

/**
 * Kontextus-agnosztikus feladat-runtime: chatből, delegálásból vagy agent-tool
 * útján létrehozott ticketeket dolgoz fel az egységes {@link runAgentToolLoop}-pal,
 * majd az eredményt `board_write`-tal visszaírja a ticketbe. A wiki-specifikus
 * `WikiAgentRuntime`-ot váltja ki minden nem-wiki forrásnál.
 */
export class GeneralTaskRuntime {
  constructor(
    private agents: AgentRepository,
    private documents: DocumentRepository,
    private tickets: TicketRepository,
    private gateway: ModelGateway,
    private toolBroker: ToolBrokerService,
    private toolCaps: ToolBrokerRepository,
    private workspaceStorage: WorkspaceStorage,
    private playbooks?: PlaybookV2Repository,
    private processes?: ProcessRepository,
    private conversations?: ConversationService,
    private skills?: SkillService,
    private audit?: AuditRepository,
    private memoryRetrieval?: MemoryRetrievalService,
  ) {}

  async processTicket(params: { ticketId: string; agentId: string }) {
    const ticket = await this.tickets.findById(params.ticketId)
    if (!ticket) throw new Error('Ticket not found')
    if (ticket.agentId !== params.agentId) throw new Error('Ticket not assigned to this agent')

    const payload = isRecord(ticket.payload) ? ticket.payload : {}
    const processStep = await this.loadProcessStepContext(ticket)
    let question = readTicketPromptText(payload) || ticket.title
    if (processStep) {
      const { prompt } = buildEffectivePrompt({
        agentPersona: '',
        instructionTemplate: processStep.stepRule.instructionTemplate,
        slots: playbookSlotValuesFromTicketPayload(payload),
      })
      if (prompt.trim()) question = prompt.trim()
    }
    const attachmentIds = readAttachmentIds(payload)
    if (!question && attachmentIds.length === 0) {
      throw new Error('Ticket payload is missing question')
    }

    const agentDetails = await this.agents.findByIdWithDetails(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const modelConfig = agentDetails.agent.modelConfig as ModelConfig
    const agentVersion = agentDetails.agent.currentVersion

    const attachmentDocs = await this.loadDocuments(attachmentIds)
    const attachmentBlock = formatAttachmentBlock(attachmentDocs)
    const conversationContext = await this.loadConversationContext(ticket)
    const threadComments = await this.tickets.listComments(ticket.id)
    const threadPrompt = threadComments.length > 0
      ? buildThreadContextPrompt({ comments: threadComments, originalTask: question })
      : null
    const taskPrompt = threadPrompt ?? question
    const kbQuery = [question, latestHumanTicketComment(threadComments)]
      .filter((part): part is string => Boolean(part?.trim()))
      .join('\n')

    // A pre-fetch keresési query-jét desztilláljuk (fájlnév-említések + zaj-szűrés):
    // a teljes, zajos feladat-utasítás felhígítaná a kulcsszavas retrievalt, és a
    // keresett dokumentum kieshetne a top-k-ból. A modellnek adott feladat-prompt
    // (lásd `buildTaskMessages`) továbbra is a teljes `question` marad.
    const kbSearch = await this.fetchKbSearchContext({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      query: distillKbSearchQuery(kbQuery || question),
    })

    const memoryContext = await this.retrieveProjectMemoryContext({
      agentDetails,
      ticket,
      taskPrompt,
    })

    const messages = await this.buildTaskMessages({
      agentDetails,
      question: taskPrompt,
      attachmentBlock,
      kbSearch,
      processStep,
      conversationContext,
      memoryContextBlock: memoryContext.block,
    })

    const allowedTools = await listAllowedChatTools(this.toolCaps, params.agentId)

    // §4.7b — deliverable-lépés: a formátumhoz tartozó fájl-eszköz kötelező. Ha az
    // agentnek nincs grantolva, a fájl nem jöhet létre → a lépés hangosan bukjon,
    // ne néma szöveg-kimenettel záruljon (opt-in lépés, tudatos konfig-hiba).
    const deliverable = processStep?.stepRule.deliverable
    const wsTenant = ticket.tenantId ?? 'global'
    if (deliverable) {
      const requiredTool = DELIVERABLE_TOOL_BY_FORMAT[deliverable.format]
      if (!allowedTools.includes(requiredTool as (typeof allowedTools)[number])) {
        throw new Error(
          `Deliverable lépés (${deliverable.format}) a(z) '${requiredTool}' eszközt igényli, de az agentnek (${params.agentId}) nincs grantolva.`,
        )
      }
    }
    const filesBefore = deliverable
      ? await this.workspaceStorage.list(wsTenant, ticket.id).catch(() => [] as string[])
      : null

    // Level-0 skill-index + load_skill a task-ághoz is (WP-5/D9).
    const skillIndexPrompt = this.skills
      ? await this.skills.buildSkillIndexPrompt(params.agentId)
      : ''
    const loadSkill: LoadSkillFn | undefined =
      this.skills && skillIndexPrompt
        ? (skillVersionId) =>
            this.skills!.loadSkillForAgent({
              agentId: params.agentId,
              skillVersionId,
              actor: { actorId: null, actorTenantId: ticket.tenantId ?? null, isPlatformAdmin: false },
            })
        : undefined
    // Futásidejű skill-snapshot perzisztálás a ticket-futáshoz kötve (WP-5/D9/D12).
    if (this.skills && skillIndexPrompt) {
      await this.skills.recordRunSkillSnapshot({
        agentId: params.agentId,
        context: { ticketId: ticket.id },
        actorTenantId: ticket.tenantId ?? null,
      })
    }

    const loopResult = await runAgentToolLoop({
      gateway: this.gateway,
      toolBroker: this.toolBroker,
      toolCaps: this.toolCaps,
      agentId: params.agentId,
      agentVersion,
      context: { ticketId: ticket.id },
      mode: 'task',
      messages,
      modelConfig,
      allowedTools,
      maxTurns: resolveToolLoopMaxTurns(modelConfig, allowedTools),
      skillIndexPrompt,
      loadSkill,
      archiveLargeToolResult: (input) =>
        this.archiveLargeToolResult(wsTenant, ticket.id, input),
    })
    const { content: answer, toolCallCount } = loopResult

    if (loopResult.status === 'exhausted') {
      const updated = await this.routeNonOkStepOutcome({
        ticket,
        processStep,
        agentId: params.agentId,
        agentName: agentDetails.agent.name,
        agentVersion,
        answer,
        toolCallCount,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
        payload,
        stepOutcome: { status: 'failed', reason: 'tool_loop_exhausted' },
        extraPayload: {
          error: {
            code: 'TOOL_LOOP_EXHAUSTED',
            reason: loopResult.reason,
            message:
              'Az agent kimerítette a rendelkezésre álló eszközhasználati köröket, ezért a lépés nem zárható sikeresként.',
          },
        },
        extraStructured: { errorCode: 'TOOL_LOOP_EXHAUSTED' },
        note: 'tool loop exhausted before completing task; human review required',
      })
      return {
        ticketId: ticket.id,
        answer,
        toolCallCount,
        ticket: updated,
      }
    }

    // A kész deliverable fájl felismerése a munkaterület before/after diffjéből.
    let deliverableFile: string | null = null
    if (deliverable && filesBefore) {
      const filesAfter = await this.workspaceStorage
        .list(wsTenant, ticket.id)
        .catch(() => [] as string[])
      deliverableFile = pickDeliverableFile(filesBefore, filesAfter, deliverable.format)
      deliverableFile = requireDeliverableFile(deliverable, deliverableFile)
    }

    const deliverableMeta: Record<string, unknown> = {}
    if (deliverable) {
      deliverableMeta.deliverableFormat = deliverable.format
      deliverableMeta[DEFAULT_DELIVERABLE_FIELD] = deliverableFile
      // A megadott outputContract-mezőbe a fájlnév-referencia kerül (a szöveg helyett).
      if (deliverable.field && deliverableFile) {
        deliverableMeta[deliverable.field] = deliverableFile
      }
    }

    // Hibapolicy spec §5.1/WP-3 — a lépés outputContract-ja is hard-signal: ha a kötelező
    // mezők hiányoznak a parse-olt kimenetből, a step NEM zárható néma `ok`-ként (különben a
    // `done`-ra írás az evaluateTicketTransition OUTPUT_CONTRACT_VIOLATION DENY-jébe futna).
    const structuredOutput = processStep
      ? parseAgentStepOutput(answer, processStep.outputRequiredFields)
      : null
    let missingOutputFields = processStep
      ? processStep.outputRequiredFields.filter(
          (field) => structuredOutput![field] === undefined || structuredOutput![field] === null,
        )
      : []

    // Sok modell a tool-loop UTÁN nem teszi vissza a kért záró JSON-blokkot, pedig a
    // tényleges tartalmi válasz (`answer`) helyes — ilyenkor a hibás formázás miatt NE
    // essen a step azonnal await_human-ra: egyetlen, célzott (tool nélküli) "strukturálj
    // JSON-ra" javító hívással próbáljuk a már meglévő szöveges válaszból kinyerni a
    // hiányzó mezőket, mielőtt hard-signal `blocked`-nek minősítenénk a lépést.
    if (processStep && missingOutputFields.length > 0 && answer.trim()) {
      const repaired = await this.repairStructuredOutput({
        agentId: params.agentId,
        agentVersion,
        ticketId: ticket.id,
        modelConfig,
        answer,
        requiredFields: missingOutputFields,
      })
      if (repaired) {
        for (const field of missingOutputFields) {
          if (repaired[field] !== undefined && repaired[field] !== null) {
            structuredOutput![field] = repaired[field]
          }
        }
        missingOutputFields = processStep.outputRequiredFields.filter(
          (field) => structuredOutput![field] === undefined || structuredOutput![field] === null,
        )
      }
    }

    // WP-7 / §10.1 — determinisztikus step-outcome hard runtime hibákból és az
    // outputContractből. A KB prefetch 0-hit csak kontextusjel: önmagában nem bizonyítja,
    // hogy a lépés nem teljesíthető más forrásból.
    const stepOutcome = computeStepOutcome({
      loopStatus: loopResult.status,
      toolCallCount,
      // Ha a broker BÁRMELY tool-hívást megtagadott (grant/policy DENY), a lépés hard-signal
      // `failed` — az agent nem tudta elvégezni a rábízott műveletet (pl. hiányzó Gmail-olvasási
      // jog), akkor sem, ha a záró prózája ezt „ok"-ként tünteti fel. Így a Folyamat a hibaágra
      // (onError/onBlocked → emberi felülvizsgálat) kerül, nem némán „completed"-ként zárul.
      toolDenied: loopResult.deniedCount > 0,
      kbZeroHit: kbSearch.enabled && kbSearch.hits.length === 0,
      missingOutputFields,
    })

    // Process-lépésnél a nem-`ok` outcome SOHA nem lesz happy-path `done`-ként némán
    // elfogadva: a hibapolicy spec (§4/§7) útján a step.onError/onBlocked / Playbook-default
    // hibaágra (vagy végső háló esetén emberi felülvizsgálatra) tereljük.
    if (processStep && stepOutcome.status !== 'ok') {
      const updated = await this.routeNonOkStepOutcome({
        ticket,
        processStep,
        agentId: params.agentId,
        agentName: agentDetails.agent.name,
        agentVersion,
        answer,
        toolCallCount,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
        payload,
        stepOutcome,
        note: `step outcome ${stepOutcome.status} (${stepOutcome.reason ?? 'n/a'}); human review required`,
      })
      return {
        ticketId: ticket.id,
        answer,
        toolCallCount,
        ticket: updated,
      }
    }

    const completionPayload = processStep
      ? {
          ...structuredOutput,
          toolCallCount,
          agentVersion,
          model: modelConfig.model,
          memoryVersion: agentDetails.memoryVersion,
          outcome: stepOutcome,
          ...deliverableMeta,
        }
      : {
          answer,
          toolCallCount,
          agentVersion,
          model: modelConfig.model,
          memoryVersion: agentDetails.memoryVersion,
        }

    // A sikeres (happy-path) lépés agent-válaszát is a ticket-szálba írjuk `agent_answer`
    // kommentként — különben a válasz csak a payloadban élne, és a ticket-thread UI üres
    // maradna (a hiba-ág `routeNonOkStepOutcome` már ír kommentet; itt szimmetrikusan
    // pótoljuk a happy-path-on). A `answer` mezőt explicit átadjuk, hogy a strukturált
    // completionPayload mellett a szöveges válaszból is ki tudja nyerni a megjelenítendő body-t.
    await this.appendAgentAnswerComment({
      ticketId: ticket.id,
      agentId: params.agentId,
      agentName: agentDetails.agent.name,
      agentVersion,
      answerPayload: { ...completionPayload, answer },
      outputRequiredFields: processStep?.outputRequiredFields,
      extraStructured: {
        model: modelConfig.model,
        toolCallCount,
        memoryVersion: agentDetails.memoryVersion,
        status: stepOutcome.status,
      },
    })

    // A happy-path cél-állapotot a compiled state-machine-ből vezetjük le, NEM égetjük be
    // `done`-ra: egy emberi kapuval (requiredGateIds) védett lépésen az agent kimenete SOHA
    // nem léphet `done`-ra (§2.5), csak `awaiting_human`-ra, ahol a jóváhagyó dönt. Enélkül
    // a beégetett `board_write('done')` `TRANSITION_NOT_ALLOWED`-ba futott, a runtime a nem-
    // `denied` hibát elnyelte, és a Folyamat némán, láthatatlanul megállt a kapunál.
    const completionState = resolveHappyPathCompletionState(processStep)
    const write = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion,
      ticketId: ticket.id,
      tool: 'board_write',
      args: {
        ticketId: ticket.id,
        patch: {
          payload: completionPayload,
          state: completionState,
        },
      },
    })
    if (write.denied) {
      throw new Error(`board_write denied: ${write.reason}`)
    }

    const updated = await this.tickets.findById(ticket.id)
    return {
      ticketId: ticket.id,
      answer,
      toolCallCount,
      ticket: updated,
    }
  }

  /**
   * Hibapolicy spec (§4/§7) — egy `blocked`/`failed` step-outcome-ot Playbook-folyamat
   * ticketnél `board_write('done')`-ként ír vissza, hogy a `TicketStateMachine` →
   * `ProcessService.advance` → `evaluateAdvance` ténylegesen kiértékelje a
   * `step.onError`/`onBlocked` / Playbook-default hibaágat, mielőtt a beégetett
   * `await_human` végső hálóra esne (egy közvetlen ticket-írás megkerülné ezt a routingot).
   * Nem Playbook-folyamat ticketnél (nincs compiled routing) közvetlen emberi felülvizsgálatra megy.
   */
  private async routeNonOkStepOutcome(input: {
    ticket: NonNullable<Awaited<ReturnType<TicketRepository['findById']>>>
    processStep: ProcessStepContext | null
    agentId: string
    agentName: string
    agentVersion: number
    answer: string
    toolCallCount: number
    model: string
    memoryVersion: number | null
    payload: Record<string, unknown>
    stepOutcome: StepOutcome
    extraPayload?: Record<string, unknown>
    extraStructured?: Record<string, unknown>
    note: string
  }) {
    const { ticket, processStep, agentId, agentVersion, stepOutcome } = input
    const outcomePayload = {
      ...input.payload,
      answer: input.answer,
      outcome: stepOutcome,
      toolCallCount: input.toolCallCount,
      agentVersion,
      model: input.model,
      memoryVersion: input.memoryVersion,
      ...(input.extraPayload ?? {}),
    }

    await this.appendAgentAnswerComment({
      ticketId: ticket.id,
      agentId,
      agentName: input.agentName,
      agentVersion,
      answerPayload: outcomePayload,
      outputRequiredFields: processStep?.outputRequiredFields,
      extraStructured: {
        model: input.model,
        toolCallCount: input.toolCallCount,
        memoryVersion: input.memoryVersion,
        status: stepOutcome.status,
        reason: stepOutcome.reason,
        ...(input.extraStructured ?? {}),
      },
    })

    if (processStep) {
      const write = await this.toolBroker.invoke({
        agentId,
        agentVersion,
        ticketId: ticket.id,
        tool: 'board_write',
        args: {
          ticketId: ticket.id,
          patch: { payload: outcomePayload, state: 'done' },
        },
      })
      if (write.denied) {
        throw new Error(`board_write denied: ${write.reason}`)
      }
      return this.tickets.findById(ticket.id)
    }

    const awaitingReview = await this.tickets.update(ticket.id, {
      state: 'awaiting_human',
      payload: outcomePayload as Prisma.JsonValue,
    })
    await this.tickets.recordTransition({
      ticketId: ticket.id,
      fromState: ticket.state,
      toState: 'awaiting_human',
      actorType: 'agent',
      actorId: agentId,
      agentVersion,
      note: input.note,
    })
    return awaitingReview
  }

  private async appendAgentAnswerComment(input: {
    ticketId: string
    agentId: string
    agentName: string
    agentVersion: number
    answerPayload: Record<string, unknown>
    outputRequiredFields?: string[]
    extraStructured?: Record<string, unknown>
  }): Promise<void> {
    const body =
      extractAgentAnswerDisplayBody(input.answerPayload, input.outputRequiredFields ?? []) ??
      (typeof input.answerPayload.answer === 'string' ? input.answerPayload.answer.trim() : null)
    if (!body) return

    const existing = await this.tickets.listComments(input.ticketId)
    const lastAgent = [...existing].reverse().find((comment) => comment.kind === 'agent_answer')
    if (lastAgent && lastAgent.body.trim() === body.trim()) return

    await this.tickets.appendComment({
      ticketId: input.ticketId,
      kind: 'agent_answer',
      authorType: 'agent',
      authorAgentId: input.agentId,
      authorDisplayName: input.agentName,
      agentVersion: input.agentVersion,
      body,
      structured: {
        ...agentAnswerStructuredFromPayload(input.answerPayload),
        ...(input.extraStructured ?? {}),
      } as Prisma.JsonObject,
    })
  }

  /**
   * Egyetlen, tool nélküli javító hívás: a modell saját (már megszületett) szöveges
   * válaszát térképezi le a hiányzó outputContract mezőkre. Nem a fő feladatot ismétli
   * meg — csak formázási/kinyerési feladat, ezért megbízhatóbban betartja a szigorú
   * JSON-only elvárást, mint a fő (tool-loopos) válasz. Ha ez a hívás is hibázik vagy
   * hiányos, a hívó a normál hard-signal `blocked`/`await_human` útra esik — nincs
   * végtelen retry, legfeljebb egy plusz modellhívás történik lépésenként.
   */
  private async repairStructuredOutput(input: {
    agentId: string
    agentVersion: number
    ticketId: string
    modelConfig: ModelConfig
    answer: string
    requiredFields: string[]
  }): Promise<Record<string, unknown> | null> {
    try {
      const keys = input.requiredFields.join(', ')
      const result = await this.gateway.call({
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        ticketId: input.ticketId,
        messages: [
          {
            role: 'system',
            content: [
              'Kizárólag adat-strukturáló feladatod van, ne végezz semmilyen új kutatást vagy eszközhívást.',
              `A user üzenete egy korábbi agent-válasz. Alakítsd át EGYETLEN JSON objektummá, PONTOSAN ezekkel a kulcsokkal: ${keys}.`,
              'A válaszod KIZÁRÓLAG a JSON objektum legyen, más szöveg, magyarázat vagy code fence nélkül.',
              'Ha egy kulcs értékét nem találod a szövegben, az adott kulcs értéke legyen üres string.',
            ].join('\n'),
          },
          { role: 'user', content: input.answer },
        ],
        modelConfig: input.modelConfig,
      })
      const parsed = parseAgentStepOutput(result.content, input.requiredFields)
      const hasAny = input.requiredFields.some(
        (field) => parsed[field] !== undefined && parsed[field] !== null,
      )
      return hasAny ? parsed : null
    } catch {
      // A javító hívás hibája nem eshet vissza a fő lépés kimenetére — a hívó
      // egyszerűen a hiányzó mezőkkel, hard-signal `blocked`-ként folytatja.
      return null
    }
  }

  private async loadProcessStepContext(
    ticket: NonNullable<Awaited<ReturnType<TicketRepository['findById']>>>,
  ): Promise<ProcessStepContext | null> {
    if (
      !ticket.processInstanceId ||
      !ticket.playbookVersionId ||
      !ticket.playbookStepId ||
      !this.playbooks
    ) {
      return null
    }

    const version = await this.playbooks.findVersion(ticket.tenantId, ticket.playbookVersionId)
    const compiled = version?.compiledSpec as CompiledSpec | undefined
    if (!compiled) return null

    const stepRule = compiled.ticketRules.find((r) => r.stepId === ticket.playbookStepId)
    if (!stepRule) return null

    return {
      compiled,
      stepRule,
      outputRequiredFields: outputRequiredFieldsForStep(stepRule, compiled.outputRequiredFields),
    }
  }

  /**
   * Chatből indított Folyamat lépés-ticketjéhez a kiváltó beszélgetés kivonata:
   * a `ticket.conversationId` a Folyamat indító beszélgetésére mutat (l.
   * process-service.ts `createStepWithTicket`), de az instructionTemplate-ek
   * jellemzően "a promptban" szövegre hivatkoznak anélkül, hogy maguk
   * tartalmaznák azt — enélkül az agent látótere üres, és tévesen azt
   * jelentheti, hogy a felhasználó semmit nem adott meg.
   */
  private async loadConversationContext(
    ticket: NonNullable<Awaited<ReturnType<TicketRepository['findById']>>>,
  ): Promise<string | null> {
    if (!ticket.conversationId || !this.conversations) return null
    try {
      const { messages } = await this.conversations.getConversation(
        ticket.conversationId,
        ticket.tenantId,
      )
      return formatConversationForPrompt(messages)
    } catch {
      return null
    }
  }

  private async loadDocuments(ids: string[]) {
    const docs = await Promise.all(ids.map((id) => this.documents.findById(id)))
    return docs.filter((doc): doc is NonNullable<(typeof docs)[number]> => Boolean(doc))
  }

  /**
   * agent-memory-persistent-cross-conversation-spec.md §2.1 — task/process-run
   * `projectKey` = a Folyamat-DEFINÍCIÓ (`ProcessDefinition.id`), nem az
   * instance; process nélküli ad-hoc ticketnél `__general__` (soha nem néma
   * fail-closed).
   */
  private async resolveProjectKeyForTicket(
    ticket: NonNullable<Awaited<ReturnType<TicketRepository['findById']>>>,
  ): Promise<string> {
    if (ticket.processInstanceId && this.processes) {
      const process = await this.processes.findProcess(ticket.tenantId, ticket.processInstanceId)
      if (process?.processDefinitionId) return process.processDefinitionId
    }
    return '__general__'
  }

  /** agent-memory-persistent-cross-conversation-spec.md §10.3 — retrieval-only memória-blokk task-ágon. */
  private async retrieveProjectMemoryContext(params: {
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdWithDetails']>>>
    ticket: NonNullable<Awaited<ReturnType<TicketRepository['findById']>>>
    taskPrompt: string
  }) {
    if (!this.memoryRetrieval || !this.audit) {
      return { block: null, tokens: 0, memoryMode: 'degraded' as const }
    }
    const projectKey = await this.resolveProjectKeyForTicket(params.ticket)
    return loadProjectMemoryContext({
      memoryRetrieval: this.memoryRetrieval,
      audit: this.audit,
      actorId: params.agentDetails.agent.id,
      agentVersion: params.agentDetails.agent.currentVersion,
      tenantId: params.ticket.tenantId,
      ticketId: params.ticket.id,
      conversationId: params.ticket.conversationId ?? null,
      request: buildMemoryRetrievalRequest({
        agentId: params.agentDetails.agent.id,
        memoryId: params.agentDetails.agent.memoryId,
        tenantId: params.ticket.tenantId,
        projectKey,
        query: buildMemoryRetrievalQuery({
          queryKind: 'task',
          ticketTitle: params.ticket.title,
          stepInstruction: params.taskPrompt,
        }),
        queryKind: 'task',
        runRef: { ticketId: params.ticket.id },
      }),
    })
  }

  private async archiveLargeToolResult(
    tenantId: string,
    ticketId: string,
    input: { toolName: string; callId: string; turn: number; content: string },
  ): Promise<{ path: string; bytes: number } | null> {
    const bytes = Buffer.from(input.content, 'utf8')
    const path = [
      '.tool-results',
      `${String(input.turn + 1).padStart(2, '0')}-${safeToolResultName(input.toolName)}-${safeToolResultName(input.callId)}.json`,
    ].join('/')

    try {
      await this.workspaceStorage.write(tenantId, ticketId, path, bytes)
      return { path, bytes: bytes.length }
    } catch {
      return null
    }
  }

  private async fetchKbSearchContext(params: {
    agentId: string
    agentVersion: number
    ticketId: string
    query: string
  }): Promise<{ enabled: boolean; hits: KbHit[] }> {
    const capability = await this.toolCaps.findCapability(params.agentId, 'kb_search')
    if (!capability?.allowed || !params.query.trim()) {
      return { enabled: false, hits: [] }
    }

    const search = await this.toolBroker.invoke({
      agentId: params.agentId,
      agentVersion: params.agentVersion,
      ticketId: params.ticketId,
      tool: 'kb_search',
      args: { query: params.query.trim(), k: 6 },
    })

    if (search.denied || !('hits' in search.result) || !Array.isArray(search.result.hits)) {
      return { enabled: true, hits: [] }
    }

    return { enabled: true, hits: search.result.hits as KbHit[] }
  }

  private async buildTaskMessages(params: {
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdWithDetails']>>>
    question: string
    attachmentBlock: string
    kbSearch: { enabled: boolean; hits: KbHit[] }
    processStep: ProcessStepContext | null
    conversationContext: string | null
    memoryContextBlock?: string | null
  }) {
    const allAgents = await this.agents.findMany()
    const orgRoster = formatOrgRoster(allAgents)

    const messages: Array<{ role: 'user' | 'system'; content: string }> = [
      { role: 'system', content: composeSystemPrompt(params.agentDetails.agent) },
    ]

    // agent-memory-persistent-cross-conversation-spec.md §10.3 — retrieval-only:
    // a legacy `agentDetails.memoryContent` teljes-inject helyett a
    // `MemoryRetrievalService`-ből épített `Project memory context` blokk.
    if (params.memoryContextBlock) {
      messages.push(...memoryContextSystemMessages(params.memoryContextBlock))
      messages.push({ role: 'system', content: MEMORY_RETRIEVAL_USAGE_PROMPT })
    }

    if (params.conversationContext) {
      messages.push({
        role: 'system',
        content: `Ez a lépés egy chatből indított Folyamat része. A lenti utasítás "a promptra" hivatkozhat — az alább idézett, a Folyamatot elindító beszélgetés a forrás, ebből olvasd ki a szükséges adatokat:\n\n${params.conversationContext}`,
      })
    }

    if (params.processStep) {
      const deliverable = params.processStep.stepRule.deliverable
      if (deliverable) {
        // Deliverable-lépésnél a fájl a végtermék: az outputContract JSON-kényszere
        // helyett a valódi fájl-előállítást írjuk elő (§4.7b), különben a modell a
        // tartalmat szövegként a mezőbe ömlesztené.
        messages.push({ role: 'system', content: formatDeliverableInstruction(deliverable) })
      } else {
        const outputInstruction = formatOutputContractInstruction(
          params.processStep.outputRequiredFields,
        )
        if (outputInstruction) {
          messages.push({ role: 'system', content: outputInstruction })
        }
      }
    }

    if (params.kbSearch.enabled) {
      const answerInstruction = kbSearchAnswerInstruction({
        hitCount: params.kbSearch.hits.length,
        hasMemoryContext: Boolean(params.memoryContextBlock),
        mode: 'task',
      })
      messages.push({
        role: 'system',
        content: `${answerInstruction}\n\nTudásbázis találatok (kb_search):\n${formatHitsForPrompt(params.kbSearch.hits)}`,
      })
    }

    messages.push({ role: 'system', content: orgRoster })

    const userContent = params.attachmentBlock
      ? `${params.question || '(csatolmányok)'}${params.attachmentBlock}`.trim()
      : params.question
    messages.push({ role: 'user', content: userContent })

    return messages
  }
}
