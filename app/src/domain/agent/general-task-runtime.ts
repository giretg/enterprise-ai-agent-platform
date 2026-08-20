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
import { pollCancelRequested } from '@/lib/cancel-flag-poll'
import { formatOrgRoster } from '@/lib/agent-org-roster'
import { assertDocumentsReachableFromTenant } from '@/lib/document-tenant-access'
import type { AgentAccessService } from '@/domain/agent-access/agent-access-service'
import { resolveAddressableColleagues } from '@/domain/agent-access/addressable-colleagues'
import { buildEffectivePrompt } from '@/lib/playbook-v2/effective-prompt'
import {
  agentAnswerStructuredFromPayload,
  computeStepOutcome,
  DEFAULT_DELIVERABLE_FIELD,
  DELIVERABLE_TOOL_BY_FORMAT,
  extractAgentAnswerDisplayBody,
  formatDeliverableInstruction,
  formatOutputContractInstruction,
  isFilledOutputValue,
  outputRequiredFieldsForStep,
  parseAgentStepOutput,
  pickDeliverableFile,
  playbookSlotValuesFromTicketPayload,
  requireDeliverableFile,
} from '@/lib/playbook-v2/process-step-payload'
import {
  compileContract,
  runStrictContract,
  structuringModelFromEnv,
  toStructuringModelConfig,
  classifyContractOutcome,
  buildContractEvaluateAuditMetadata,
  type ContractField,
  type CriticalityLevel,
  type StructuringModelSetting,
} from '@/domain/contract-runtime'
import { contractEvaluationsTotal, contractRepairCostEur } from '@/lib/observability/metrics'
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
  trainedRulesSystemMessages,
} from '../memory/memory-runtime-helper'
import type { MemoryRetrievalService } from '../memory/memory-retrieval-service'
import type { ModelGateway, ModelConfig } from '../gateway/model-gateway'
import type { ToolBrokerService } from '../tool-broker/tool-broker-service'
import type { WorkspaceStorage } from '../file-editor/workspace-storage'
import { formatAttachmentBlock } from './agent-chat-runtime'
import { listAllowedChatTools, resolveToolLoopMaxTurns, runAgentToolLoop, AgentToolLoopCancelledError, type LoadSkillFn } from './chat-tool-loop'
import { formatTaskWorkspaceFilesPrompt } from '@/lib/task-workspace-prompt'
import { formatSkillParameterValuesPrompt } from '@/lib/skill/skill-context'
import {
  isInternalWorkspaceFile,
  referencedWorkspaceFiles,
} from '@/lib/workspace-file-visibility'
import type { SkillService } from '../skill/skill-service'
import type { ConsequenceApprovalService } from '../tool-broker/consequence-approval-service'
import { formatPreapprovedRunSummary } from '../tool-broker/consequence-gate-policy'
import { describeConnectorGrantTargets } from '@/domain/connector-grant/connector-grant-needed'
import type { PromptSegments } from './prompt-assembler'
import {
  TicketProgressFlusher,
  mergeRuntimeProgressIntoPayload,
} from './ticket-runtime-progress'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readAttachmentIds(payload: Record<string, unknown>): string[] {
  const ids = payload.attachmentDocumentIds
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === 'string')
}

function readPreferredSkillVersionIds(payload: Record<string, unknown>): string[] {
  const ids = payload.preferredSkillVersionIds
  if (!Array.isArray(ids)) return []
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
}

/**
 * A feladat indításakor kitöltött skill-paraméter-értékek (#199). A kulcsok
 * érvényességét a `createBoardTicket` már ellenőrizte a skill `parameters[]`
 * neveihez képest; itt csak a tárolt alakot olvassuk vissza fail-safe módon.
 */
function readSkillParameterValues(payload: Record<string, unknown>): Record<string, string> {
  const raw = payload.skillParameterValues
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && value.trim()) values[key] = value
  }
  return values
}

function formatDueByPrompt(dueBy: Date | null | undefined): string | null {
  if (!dueBy || Number.isNaN(dueBy.getTime())) return null
  return `Határidő: ${dueBy.toISOString()}. A feladatot a határidő figyelembevételével tervezd és hajtsd végre.`
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
  outputContractFields?: ContractField[]
  maxRepairAttempts?: number
  criticality?: CriticalityLevel
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
    /** #33 — platform-szintű strukturáló modell felolvasó (settings / env). */
    private getStructuringModel?: () => Promise<StructuringModelSetting | null>,
    /**
     * Agent-hozzáférési gráf (#142). A prompt-roster ezen keresztül szűr: csak
     * MEGSZÓLÍTHATÓ, aktív, azonos tenantos kollégák kerülhetnek a system promptba.
     * Ha nincs bekötve, a roster ÜRES (fail-closed) — nem a teljes agent-lista.
     */
    private agentAccess?: AgentAccessService,
    /** Következmény-kapu (http_api_request write) — task ticketen is kell gomb. */
    private consequenceApprovals?: ConsequenceApprovalService,
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

    const agentDetails = await this.agents.findByIdForRuntime(params.agentId)
    if (!agentDetails) throw new Error('Agent not found')

    const modelConfig = agentDetails.agent.modelConfig as ModelConfig
    const agentVersion = agentDetails.agent.currentVersion

    const attachmentDocs = await this.loadDocuments(attachmentIds, ticket.tenantId)
    const attachmentBlock = formatAttachmentBlock(attachmentDocs)
    const conversationContext = await this.loadConversationContext(ticket)
    const wsTenant = ticket.tenantId ?? 'global'
    const workspaceFiles = await this.workspaceStorage
      .listUserFacing(wsTenant, ticket.id)
      .catch(() => [] as string[])

    const threadComments = await this.tickets.listComments(ticket.id)
    const threadPrompt = threadComments.length > 0
      ? buildThreadContextPrompt({
          comments: threadComments,
          originalTask: question,
          workspaceFiles,
        })
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

    const dueByPrompt = formatDueByPrompt(ticket.dueBy)
    const preferredSkillVersionIds = readPreferredSkillVersionIds(payload)
    let preloadedSkillPrompts: string[] = []
    // issue #161 — a ticketre kért skill futási kerete a task-ágon is éljen
    // (a chat-promócióval idekerült hosszú skill különben az alap task-keretet
    // kapná, épp azt veszítve el, amiért a boardra került).
    let skillRuntimeHints: { maxWallClockMs?: number; maxToolCalls?: number } | undefined
    let skillToolScope: string[] | undefined
    // #199 — a korlátozott feladatkörű agentnél NINCS szabad szöveges leírás: a
    // bemenetet a skill deklarált paraméterei és a csatolt fájlok adják. A megadott
    // értékek külön, jól elkülönített blokkban mennek a modellhez, a paraméter
    // leírásával együtt — enélkül a modell nem tudná, mit jelent az érték.
    let skillParameterPrompt = ''
    if (this.skills && preferredSkillVersionIds.length > 0) {
      const preloaded = await this.skills.preloadSkillsByVersionIds({
        agentId: params.agentId,
        skillVersionIds: preferredSkillVersionIds,
        actor: {
          actorId: null,
          actorTenantId: ticket.tenantId ?? null,
          isPlatformAdmin: false,
        },
        reason:
          'A ticket létrehozója explicit módon kérte ennek a skillnek a betöltését. Kövesd az alábbi instrukciót:',
      })
      // Futásidejű readiness-kapu a board-ágon is: a `preferredMode: task`
      // promóció miatt a hosszú skillek ITT futnak, tehát a néma félrefutást is
      // itt kell megállítani. A ticket hangosan bukjon, ne adjon félkész eredményt.
      if (preloaded.blocked.length > 0) {
        throw new Error(preloaded.blocked.map((b) => b.reason).join(' '))
      }
      preloadedSkillPrompts = preloaded.preloadedPrompts
      skillRuntimeHints = preloaded.runtimeHints
      skillToolScope = preloaded.requiredTools
      skillParameterPrompt = formatSkillParameterValuesPrompt(
        preloaded.parameters ?? [],
        readSkillParameterValues(payload),
      )
    }

    const messages = await this.buildTaskMessages({
      agentDetails,
      question: taskPrompt,
      attachmentBlock,
      workspaceFiles,
      kbSearch,
      processStep,
      conversationContext,
      memoryContextBlock: memoryContext.block,
      dueByPrompt,
      skillParameterPrompt,
    })

    const allowedTools = await listAllowedChatTools(this.toolCaps, params.agentId)

    // §4.7b — deliverable-lépés: a formátumhoz tartozó fájl-eszköz kötelező. Ha az
    // agentnek nincs grantolva, a fájl nem jöhet létre → a lépés hangosan bukjon,
    // ne néma szöveg-kimenettel záruljon (opt-in lépés, tudatos konfig-hiba).
    const deliverable = processStep?.stepRule.deliverable
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

    const progress = new TicketProgressFlusher()
    let dbCancelRequested = false
    let lastCancelCheckAt = 0
    const refreshCancel = async () => {
      const now = Date.now()
      if (now - lastCancelCheckAt < 1000 && lastCancelCheckAt > 0) return dbCancelRequested
      lastCancelCheckAt = now
      dbCancelRequested = await pollCancelRequested({
        read: () => this.tickets.isCancelRequested(ticket.id),
        previous: dbCancelRequested,
      })
      return dbCancelRequested
    }
    const persistProgress = async (force = false) => {
      const snap = force ? progress.takeSnapshot() : progress.snapshotIfDue()
      if (!snap) return
      try {
        const current = await this.tickets.findById(ticket.id)
        const base =
          current && isRecord(current.payload)
            ? (current.payload as Record<string, unknown>)
            : payload
        await this.tickets.update(ticket.id, {
          payload: mergeRuntimeProgressIntoPayload(base, snap) as Prisma.JsonValue,
        })
      } catch {
        // Telemetria soha ne törje el a futást.
      }
    }

    let loopResult: Awaited<ReturnType<typeof runAgentToolLoop>>
    // issue #180 WP-1 — a MEGKEZDETT körök száma. A `ToolLoopResult` csak a
    // tool-számlálókat adja vissza; a kör-szám az `onTurnStart` horogból jön, hogy
    // a ticket-kimeneten is látszódjon, hány körön át futott a lépés.
    let loopTurnCount = 0
    try {
      loopResult = await runAgentToolLoop({
        gateway: this.gateway,
        toolBroker: this.toolBroker,
        toolCaps: this.toolCaps,
        agentId: params.agentId,
        agentVersion,
        context: {
          ticketId: ticket.id,
          ...(ticket.tenantId ? { tenantId: ticket.tenantId } : {}),
        },
        mode: 'task',
        promptSegments: messages,
        modelConfig,
        allowedTools,
        maxTurns: resolveToolLoopMaxTurns(modelConfig, allowedTools, 'task'),
        skillIndexPrompt,
        preloadedSkillPrompts,
        ...(skillRuntimeHints ? { initialSkillRuntimeHints: skillRuntimeHints } : {}),
        ...(skillToolScope ? { initialSkillToolScope: skillToolScope } : {}),
        loadSkill,
        archiveLargeToolResult: (input) =>
          this.archiveLargeToolResult(wsTenant, ticket.id, input),
        writeWorkspaceFile: async (path, content, audience = 'internal') => {
          try {
            const bytes = Buffer.from(content, 'utf8')
            await this.workspaceStorage.write(wsTenant, ticket.id, path, bytes)
            await this.workspaceStorage.setFileAudience(wsTenant, ticket.id, path, audience)
            return { bytes: bytes.length }
          } catch {
            return null
          }
        },
        listWorkspaceFiles: async () => {
          try {
            return await this.workspaceStorage.list(wsTenant, ticket.id)
          } catch {
            return []
          }
        },
        readWorkspaceFile: async (path) => {
          try {
            const buf = await this.workspaceStorage.read(wsTenant, ticket.id, path)
            return buf ? buf.toString('utf8') : null
          } catch {
            return null
          }
        },
        ...(this.consequenceApprovals
          ? {
              createConsequenceApproval: async (invoke: import('../tool-broker/tool-broker-types').ToolBrokerInvokeInput) =>
                this.consequenceApprovals!.createFromBlocked({
                  invoke: {
                    ...invoke,
                    ticketId: invoke.ticketId ?? ticket.id,
                  },
                  tenantId: ticket.tenantId ?? null,
                }),
            }
          : {}),
        shouldCancel: () => {
          if (dbCancelRequested) return true
          void refreshCancel()
          return dbCancelRequested
        },
        onTurnStart: async (turnIndex: number) => {
          loopTurnCount = turnIndex + 1
          await refreshCancel()
        },
        onActivity: async (activity) => {
          // due=true → interval lejárt; snapshotIfDue a dirty flaget fogyasztja.
          if (progress.pushActivity(activity)) await persistProgress(false)
        },
      })
    } catch (error) {
      await persistProgress(true)
      if (error instanceof AgentToolLoopCancelledError) {
        const current = await this.tickets.findById(ticket.id)
        const base =
          current && isRecord(current.payload)
            ? (current.payload as Record<string, unknown>)
            : payload
        const cancelledPayload = {
          ...base,
          cancelled: true,
          cancelNote: 'Felhasználói leállítás — a részeredmény megőrizve.',
        }
        await this.tickets.update(ticket.id, {
          state: 'awaiting_human',
          payload: cancelledPayload as Prisma.JsonValue,
          lockToken: null,
          lockedAt: null,
          cancelRequested: false,
        })
        await this.tickets.recordTransition({
          ticketId: ticket.id,
          fromState: ticket.state,
          toState: 'awaiting_human',
          actorType: 'human',
          actorId: ticket.cancelRequestedById ?? ticket.createdById,
          agentVersion,
          note: 'Agent futás leállítva (emergency stop).',
        })
        await this.tickets.appendComment({
          ticketId: ticket.id,
          kind: 'system_note',
          authorType: 'human',
          authorUserId: ticket.cancelRequestedById ?? ticket.createdById,
          body: '⏹️ A ticket feldolgozása le lett állítva. A részeredmény megőrződött; folytathatod vagy újraindíthatod.',
        })
        return {
          ticketId: ticket.id,
          ticket: await this.tickets.findById(ticket.id),
          cancelled: true,
        }
      }
      throw error
    }

    await persistProgress(true)
    const { toolCallCount } = loopResult
    const deniedCount = loopResult.deniedCount
    // issue #220 — utólagos futás-összesítő (N író hívás, trust mód, limit).
    const preapprovedNotice = formatPreapprovedRunSummary(loopResult.preapprovedWriteSummary ?? [])
    const answer = preapprovedNotice
      ? `${loopResult.content.trim()}\n\n---\n\n_${preapprovedNotice}_`
      : loopResult.content
    await this.publishReferencedWorkspaceFiles(wsTenant, ticket.id, answer)

    if (loopResult.awaitingConnectorGrant) {
      const grantNeeds = loopResult.connectorGrantNeeds ?? []
      const grantTargets = describeConnectorGrantTargets(grantNeeds)
      const grantNotice =
        grantNeeds.length > 0
          ? `\n\n---\n\n**${grantTargets} hozzáférés kell.** ` +
            'Az alábbi „Hozzáférés megadása" gombbal összekötheted a fiókodat; ' +
            'OAuth után a feladat magától folytatódik — nem kell újraindítanod.'
          : `\n\n---\n\n⚠️ A(z) ${grantTargets} hozzáférés hiányzik, de a gomb nem jött létre. ` +
            'Kösd össze a fiókot a Kapcsolatoknál, majd indítsd újra a feladatot.'
      const answerWithGrant = `${answer.trim()}${grantNotice}`
      await this.appendAgentAnswerComment({
        ticketId: ticket.id,
        agentId: params.agentId,
        agentName: agentDetails.agent.name,
        agentVersion,
        answerPayload: {
          answer: answerWithGrant,
          toolCallCount,
          turnCount: loopTurnCount,
          deniedCount,
          awaitingConnectorGrant: grantNeeds.length > 0,
          connectorGrantNeeds: grantNeeds,
          agentVersion,
          model: modelConfig.model,
          memoryVersion: agentDetails.memoryVersion,
        },
        extraStructured: {
          model: modelConfig.model,
          toolCallCount,
          turnCount: loopTurnCount,
          deniedCount,
          awaitingConnectorGrant: grantNeeds.length > 0,
          status: 'awaiting_human',
        },
      })
      const write = await this.toolBroker.invoke({
        agentId: params.agentId,
        agentVersion,
        ticketId: ticket.id,
        tool: 'board_write',
        args: {
          ticketId: ticket.id,
          patch: {
            state: 'awaiting_human',
            payload: {
              answer: answerWithGrant,
              toolCallCount,
              turnCount: loopTurnCount,
              deniedCount,
              awaitingConnectorGrant: grantNeeds.length > 0,
              connectorGrantNeeds: grantNeeds,
              agentVersion,
              model: modelConfig.model,
              memoryVersion: agentDetails.memoryVersion,
            },
          },
        },
      })
      if (write.denied) {
        throw new Error(`board_write denied: ${write.reason}`)
      }
      return {
        ticketId: ticket.id,
        answer: answerWithGrant,
        toolCallCount,
        ticket: await this.tickets.findById(ticket.id),
      }
    }

    // Következmény-kapu: a http_api_request (write) gombra vár — a ticket NEM lehet
    // done, amíg a felhasználó a ticket UI-n nem hagyja jóvá a műveleteket.
    // A feltétel szándékosan NEM köti a `status === 'completed'`-et: a függő
    // jóváhagyás erősebb jelzés, mint a loop leállásának módja. Ha van nyitott
    // kártya, a ticket a gombra vár — nem eshet se hibaágra (a kapu miatti
    // `deniedCount > 0` „failed" outcome-ra), se `done`-ra.
    if (loopResult.awaitingConsequenceApproval) {
      const approvalIds = loopResult.consequenceApprovalIds ?? []
      if (approvalIds.length === 0) {
        // Kapu blokkolt, de kártya nincs — ne ígérjünk gombot (cade35e7 repro).
        const failedAnswer =
          `${answer.trim()}\n\n` +
          '⚠️ Platform hiba: a következmény-kapu blokkolta az író műveletet, ' +
          'de nem jött létre jóváhagyó kártya a ticketen. Indítsd újra a feladatot, ' +
          'vagy jelezd a hibát — ticket-szintű „Jóváhagyás” NEM futtatja le a Föld API hívást.'
        await this.tickets.appendComment({
          ticketId: ticket.id,
          kind: 'system_note',
          authorType: 'system',
          body:
            'Következmény-kapu: jóváhagyó kártya létrehozása sikertelen (üres consequenceApprovalIds).',
        })
        await this.appendAgentAnswerComment({
          ticketId: ticket.id,
          agentId: params.agentId,
          agentName: agentDetails.agent.name,
          agentVersion,
          answerPayload: {
            answer: failedAnswer,
            toolCallCount,
            turnCount: loopTurnCount,
            deniedCount,
            awaitingConsequenceApproval: false,
            consequenceApprovalIds: [],
            consequenceApprovalCreateFailed: true,
            agentVersion,
            model: modelConfig.model,
            memoryVersion: agentDetails.memoryVersion,
          },
          extraStructured: {
            model: modelConfig.model,
            toolCallCount,
            turnCount: loopTurnCount,
            deniedCount,
            status: 'awaiting_human',
            consequenceApprovalCreateFailed: true,
          },
        })
        const write = await this.toolBroker.invoke({
          agentId: params.agentId,
          agentVersion,
          ticketId: ticket.id,
          tool: 'board_write',
          args: {
            ticketId: ticket.id,
            patch: {
              state: 'awaiting_human',
              payload: {
                answer: failedAnswer,
                toolCallCount,
                turnCount: loopTurnCount,
                deniedCount,
                awaitingConsequenceApproval: false,
                consequenceApprovalIds: [],
                consequenceApprovalCreateFailed: true,
                agentVersion,
                model: modelConfig.model,
                memoryVersion: agentDetails.memoryVersion,
              },
            },
          },
        })
        if (write.denied) {
          throw new Error(`board_write denied: ${write.reason}`)
        }
        return {
          ticketId: ticket.id,
          answer: failedAnswer,
          toolCallCount,
          ticket: await this.tickets.findById(ticket.id),
        }
      }
      // A gombra vonatkozó mondat PLATFORM-szöveg, nem a modellé. A kapuzott
      // hívások eredménye szándékosan már nem szólítja fel a modellt, hogy
      // minden egyes tételnél a felhasználóhoz forduljon (attól hagyta abba a
      // terv feldolgozását) — így viszont a záró szövegéből kimaradhatna, hogy
      // MIT kell tennie a felhasználónak. Ez a mondat determinisztikusan ott lesz.
      const approvalNotice =
        `\n\n---\n\n**${approvalIds.length} külső rendszerbe író művelet vár jóváhagyásra.** ` +
        'Az alábbi „Mind jóváhagyom" gombbal egyszerre engedélyezheted mindet; ' +
        'a műveletek lefutnak, és a feladat magától folytatódik — nem kell újraindítanod.'
      const answerWithNotice = `${answer.trim()}${approvalNotice}`
      await this.appendAgentAnswerComment({
        ticketId: ticket.id,
        agentId: params.agentId,
        agentName: agentDetails.agent.name,
        agentVersion,
        answerPayload: {
          answer: answerWithNotice,
          toolCallCount,
          turnCount: loopTurnCount,
          deniedCount,
          awaitingConsequenceApproval: true,
          consequenceApprovalIds: approvalIds,
          agentVersion,
          model: modelConfig.model,
          memoryVersion: agentDetails.memoryVersion,
        },
        extraStructured: {
          model: modelConfig.model,
          toolCallCount,
          turnCount: loopTurnCount,
          deniedCount,
          awaitingConsequenceApproval: true,
          status: 'awaiting_human',
        },
      })
      const write = await this.toolBroker.invoke({
        agentId: params.agentId,
        agentVersion,
        ticketId: ticket.id,
        tool: 'board_write',
        args: {
          ticketId: ticket.id,
          patch: {
            state: 'awaiting_human',
            payload: {
              answer: answerWithNotice,
              toolCallCount,
              turnCount: loopTurnCount,
              deniedCount,
              awaitingConsequenceApproval: true,
              consequenceApprovalIds: approvalIds,
              agentVersion,
              model: modelConfig.model,
              memoryVersion: agentDetails.memoryVersion,
            },
          },
        },
      })
      if (write.denied) {
        throw new Error(`board_write denied: ${write.reason}`)
      }
      return {
        ticketId: ticket.id,
        answer: answerWithNotice,
        toolCallCount,
        ticket: await this.tickets.findById(ticket.id),
      }
    }

    if (loopResult.status === 'exhausted') {
      const updated = await this.routeNonOkStepOutcome({
        ticket,
        processStep,
        agentId: params.agentId,
        agentName: agentDetails.agent.name,
        agentVersion,
        answer,
        toolCallCount,
        turnCount: loopTurnCount,
        deniedCount: loopResult.deniedCount,
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

    // Hibapolicy spec §5.1/WP-3 + Contract Runtime (#33): a lépés kimenetét a
    // lefordított contract ellen validáljuk. Érvényes első válasz → nincs extra
    // modellhívás; bukásnál kötött javító próba a kapun át; korlát után blocked.
    let structuredOutput: Record<string, unknown> | null = null
    let missingOutputFields: string[] = []
    let contractHumanSummary: string | undefined

    if (processStep && processStep.outputRequiredFields.length > 0) {
      const contract = compileContract({
        fields: processStep.outputContractFields,
        requiredFields: processStep.outputRequiredFields,
      })
      const structuringModel = toStructuringModelConfig(
        (await this.getStructuringModel?.()) ?? structuringModelFromEnv(),
        modelConfig,
      )
      const strict = await runStrictContract({
        gateway: this.gateway,
        contract,
        rawContent: answer,
        modelConfig,
        structuringModel,
        agentId: params.agentId,
        agentVersion,
        ticketId: ticket.id,
        tenantId: ticket.tenantId ?? undefined,
        criticality: processStep.criticality,
        maxRepairAttempts: processStep.maxRepairAttempts,
      })
      if (strict.ok) {
        structuredOutput = strict.value
        missingOutputFields = []
      } else {
        structuredOutput = parseAgentStepOutput(answer, processStep.outputRequiredFields)
        missingOutputFields = strict.errors
          .map((e) => e.field)
          .filter((f, i, arr) => f && arr.indexOf(f) === i)
        if (missingOutputFields.length === 0) {
          missingOutputFields = processStep.outputRequiredFields.filter(
            (field) => !isFilledOutputValue(structuredOutput![field]),
          )
        }
        contractHumanSummary = strict.humanSummary
      }

      // #46 — contract megfigyelhetőség: audit + in-process metrika.
      const outcome = classifyContractOutcome(strict)
      contractEvaluationsTotal.inc({ outcome })
      if (strict.repairCostEstimate > 0) {
        contractRepairCostEur.inc({}, strict.repairCostEstimate)
      }
      if (this.audit) {
        try {
          await this.audit.append({
            actorType: 'agent',
            actorId: params.agentId,
            agentVersion,
            action: 'contract.evaluate',
            targetType: 'ticket',
            targetId: ticket.id,
            tenantId: ticket.tenantId ?? null,
            ticketId: ticket.id,
            modelUsed: null,
            inputRef: processStep.stepRule.stepId,
            outputRef: outcome,
            policyDecision: outcome,
            metadata: buildContractEvaluateAuditMetadata({
              outcome,
              repairAttempts: strict.repairAttempts,
              repairCostEstimate: strict.repairCostEstimate,
              stepId: processStep.stepRule.stepId,
              playbookRef: ticket.playbookRef ?? null,
              errorCodes: strict.ok ? [] : strict.errors.map((e) => e.code),
            }) as Prisma.JsonObject,
          })
        } catch {
          // best-effort — a lépés lezárása fontosabb a telemetriánál
        }
      }
    } else if (processStep) {
      structuredOutput = parseAgentStepOutput(answer, processStep.outputRequiredFields)
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
      contractErrorMessage: contractHumanSummary,
    })

    // Process-lépésnél a nem-`ok` outcome SOHA nem lesz happy-path `done`-ként némán
    // elfogadva: a hibapolicy spec (§4/§7) útján a step.onError/onBlocked / Playbook-default
    // hibaágra (vagy végső háló esetén emberi felülvizsgálatra) tereljük.
    if (processStep && stepOutcome.status !== 'ok') {
      const reviewNote =
        contractHumanSummary ??
        `step outcome ${stepOutcome.status} (${stepOutcome.reason ?? 'n/a'}); human review required`
      const updated = await this.routeNonOkStepOutcome({
        ticket,
        processStep,
        agentId: params.agentId,
        agentName: agentDetails.agent.name,
        agentVersion,
        answer,
        toolCallCount,
        turnCount: loopTurnCount,
        deniedCount,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
        payload,
        stepOutcome,
        note: reviewNote,
      })
      return {
        ticketId: ticket.id,
        answer,
        toolCallCount,
        ticket: updated,
      }
    }

    // issue #180 WP-1 — a kör- és elutasítás-szám a ticket kimenetén is látszik:
    // e nélkül egy drága lépésről csak a tool-hívások száma derült ki, az nem,
    // hogy hány körön át és hány elutasítással jutott el idáig.
    const completionPayload = processStep
      ? {
          ...structuredOutput,
          toolCallCount,
          turnCount: loopTurnCount,
          deniedCount,
          agentVersion,
          model: modelConfig.model,
          memoryVersion: agentDetails.memoryVersion,
          outcome: stepOutcome,
          ...deliverableMeta,
        }
      : {
          answer,
          toolCallCount,
          turnCount: loopTurnCount,
          deniedCount,
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
        turnCount: loopTurnCount,
        deniedCount,
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
    /** issue #180 WP-1 — a lépés kör- és elutasítás-száma a ticket kimenetén. */
    turnCount: number
    deniedCount: number
    model: string
    memoryVersion: number | null
    payload: Record<string, unknown>
    stepOutcome: StepOutcome
    extraPayload?: Record<string, unknown>
    extraStructured?: Record<string, unknown>
    note: string
  }) {
    const { ticket, processStep, agentId, agentVersion, stepOutcome } = input
    const current = await this.tickets.findById(ticket.id)
    const basePayload =
      current && isRecord(current.payload)
        ? (current.payload as Record<string, unknown>)
        : input.payload
    const outcomePayload = {
      ...basePayload,
      answer: input.answer,
      outcome: stepOutcome,
      toolCallCount: input.toolCallCount,
      turnCount: input.turnCount,
      deniedCount: input.deniedCount,
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
        turnCount: input.turnCount,
        deniedCount: input.deniedCount,
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
      outputContractFields: stepRule.outputContractFields,
      maxRepairAttempts: stepRule.maxRepairAttempts,
      criticality: compiled.criticality,
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

  private async loadDocuments(ids: string[], tenantId: string | null) {
    if (ids.length === 0) return []
    const docs = await this.documents.findByIds(ids)
    await assertDocumentsReachableFromTenant(docs, ids, tenantId)
    return docs
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
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdForRuntime']>>>
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

  private async publishReferencedWorkspaceFiles(
    tenantId: string,
    ticketId: string,
    answer: string,
  ): Promise<void> {
    try {
      const workspaceFiles = await this.workspaceStorage.list(tenantId, ticketId)
      await Promise.all(
        referencedWorkspaceFiles(answer, workspaceFiles)
          .filter((path) => !isInternalWorkspaceFile(path))
          .map((path) => this.workspaceStorage.setFileAudience(tenantId, ticketId, path, 'user')),
      )
    } catch {
      // A fájl publikálási metaadata nem szakíthatja meg a már kész választ.
    }
  }

  private async archiveLargeToolResult(
    tenantId: string,
    ticketId: string,
    input: { toolName: string; callId: string; turn: number; content: string; path?: string },
  ): Promise<{ path: string; bytes: number } | null> {
    const bytes = Buffer.from(input.content, 'utf8')
    // Kötött útvonal a kontextus-tömörítéstől: a modellnek adott stub már ezt
    // az útvonalat nevezte meg, a fájlnak ott kell keletkeznie.
    const path =
      input.path ??
      [
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
    agentDetails: NonNullable<Awaited<ReturnType<AgentRepository['findByIdForRuntime']>>>
    question: string
    attachmentBlock: string
    workspaceFiles: string[]
    kbSearch: { enabled: boolean; hits: KbHit[] }
    processStep: ProcessStepContext | null
    conversationContext: string | null
    memoryContextBlock?: string | null
    dueByPrompt?: string | null
    /** #199 — a feladat indításakor kitöltött skill-paraméter-értékek blokkja. */
    skillParameterPrompt?: string
  }) {
    // #142: a roster a hívó agent SAJÁT `address` jogán szűrt lista (a korábbi
    // szűretlen `findMany()` tenantközi neveket is a promptba írt).
    const orgRoster = formatOrgRoster(
      await resolveAddressableColleagues(this.agentAccess, params.agentDetails.agent),
    )

    // A Tanítás felületen betanított, jóváhagyott szabályok (`MemoryVersion.content`)
    // a szerep- és viselkedés-prompt után, a STABIL preamble-ben — ugyanaz a blokk,
    // mint a chatben, hogy a tiketes/folyamat-úton se vesszen el a betanítás.
    const trainedRules = trainedRulesSystemMessages({
      content: params.agentDetails.memoryContent,
      version: params.agentDetails.memoryVersion,
    })

    const stablePreamble: PromptSegments['stablePreamble'] = [
      { role: 'system', content: composeSystemPrompt(params.agentDetails.agent) },
      ...trainedRules.messages,
      { role: 'system', content: orgRoster },
    ]
    const stablePostamble: PromptSegments['stablePostamble'] = []
    const variableContext: PromptSegments['variableContext'] = []

    // agent-memory-persistent-cross-conversation-spec.md §10.3 — retrieval-only:
    // a legacy `agentDetails.memoryContent` teljes-inject helyett a
    // `MemoryRetrievalService`-ből épített `Project memory context` blokk.
    if (params.memoryContextBlock) {
      const [capturePolicy, memoryData] = memoryContextSystemMessages(params.memoryContextBlock)
      if (capturePolicy) stablePostamble.push(capturePolicy)
      stablePostamble.push({ role: 'system', content: MEMORY_RETRIEVAL_USAGE_PROMPT })
      if (memoryData) variableContext.push(memoryData)
    }

    if (params.dueByPrompt) {
      variableContext.push({ role: 'system', content: params.dueByPrompt })
    }

    if (params.conversationContext) {
      variableContext.push({
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
        variableContext.push({ role: 'system', content: formatDeliverableInstruction(deliverable) })
      } else {
        const outputInstruction = formatOutputContractInstruction(
          params.processStep.outputRequiredFields,
        )
        if (outputInstruction) {
          variableContext.push({ role: 'system', content: outputInstruction })
        }
      }
    }

    if (params.kbSearch.enabled) {
      const answerInstruction = kbSearchAnswerInstruction({
        hitCount: params.kbSearch.hits.length,
        hasMemoryContext: Boolean(params.memoryContextBlock),
        mode: 'task',
      })
      stablePostamble.push({ role: 'system', content: answerInstruction })
      variableContext.push({
        role: 'system',
        content: `Tudásbázis találatok (kb_search):\n${formatHitsForPrompt(params.kbSearch.hits)}`,
      })
    }

    variableContext.push({
      role: 'system',
      content: formatTaskWorkspaceFilesPrompt(params.workspaceFiles),
    })

    if (params.skillParameterPrompt) {
      variableContext.push({ role: 'system', content: params.skillParameterPrompt })
    }

    const userContent = params.attachmentBlock
      ? `${params.question || '(csatolmányok)'}${params.attachmentBlock}`.trim()
      : params.question
    return {
      stablePreamble,
      stablePostamble,
      variableContext,
      history: [{ role: 'user', content: userContent }],
    } satisfies PromptSegments
  }
}
