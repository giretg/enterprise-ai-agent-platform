'use server'

import { z } from 'zod'
import type {
  ConnectorAccessMode,
  ConnectorType,
  ModelBudgetPeriod,
  Prisma,
  Ticket,
  UserRole,
} from '@prisma/client'
import { mkdir, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { clerkClient } from '@clerk/nextjs/server'
import { getCurrentUser } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { requirePlatformRole, requireTenantPermission, requireTenantRole } from '@/auth/tenant-context'
import { getAuthContext, type TenantAuthContext } from '@/auth/context'
import { isSuperadmin } from '@/lib/tenant-policy'
import { services } from '@/domain'
import type { TrainingActor } from '@/domain/training/training-service'
import type { GitHubRepositoryAccess } from '@/domain/connector/github-repository-access'
import { buildTenantAccessAuditFilter } from '@/domain/iam/access-audit'
import { SandboxAppError } from '@/domain/sandbox/errors'
import { dispatchBudgetFromEnv } from '@/domain/dispatcher/dispatcher-service'
import {
  currentTicketCallCapLimit,
  formatTicketCallCapUserMessage,
  isTicketCallCapReason,
  ticketCallCapExceededMessage,
} from '@/lib/ticket-call-cap'
import {
  getSchedulerJobStatus,
  setSchedulerJobIntervalMinutes,
  setSchedulerJobPaused,
} from '@/domain/dispatcher/cloud-scheduler-admin'
import { runDispatchCycle, type DispatchCycleSummary } from '@/domain/dispatcher/run-dispatch-cycle'
import type { DispatchCycleRunRecord } from '@/domain/platform-settings/platform-settings-service'
import { repositories } from '@/repositories/postgres'
import { isClerkEnabled } from '@/lib/clerk-config'
import { prisma, ensureActiveDatabaseMode } from '@/lib/db'
import { logger } from '@/lib/observability'
import { resolveBoardDateRange } from '@/lib/board-date-range'
import { BOARD_LIST_LIMIT, DEFAULT_LIST_LIMIT } from '@/lib/list-pagination'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
import { assertAgentTenantReachable } from '@/lib/agent-tenant-access'
import { assertDocumentReachableFromTenant, assertDocumentsReachableFromTenant } from '@/lib/document-tenant-access'
import { shouldExcludeHiddenAgents } from '@/lib/agent-operator-visibility'
import {
  buildTaskOnlyTaskPrompt,
  buildTaskOnlyTicketTitle,
  validateTaskOnlyTaskInput,
} from '@/lib/task-only-ticket'
import { buildTicketDiscussionHistory } from '@/lib/ticket-thread-prompt'
import { readTicketPromptText } from '@/lib/wiki-ticket-payload'
import { skillDisplayLabel } from '@/lib/skill/skill-name'
import { isAgentAccessError } from '@/domain/agent-access/agent-access-errors'
import { isTenantAdmin, tenantUserSubject } from '@/domain/agent-access/tenant-user-subject'
import { canOpenRunAnalystWorkspace, resolveRunAnalysisEntry } from '@/lib/run-analysis-entry'
import { mergeRunAnalystIntoCatalogIds } from '@/lib/run-analysis-shared'
import { getReportTemplate, listReportTemplates } from '@/domain/report/report-templates'
import { computePlaybookGovernance } from '@/domain/governance/measurement-report'
import {
  extractStructured,
  extractTextContent,
  toExtractionMetadata,
  type StructuredExtraction,
} from '@/lib/kb-extraction'
import {
  buildTicketDisplayExtras,
  enrichTicketsForBoard,
  extractCreatorAgentId,
  formatTicketCreator,
} from '@/lib/ticket-display'
import {
  buildTicketScheduleStamp,
  isScheduleSeriesTicket,
  stampTicketSchedule,
} from '@/lib/ticket-schedule'
import { buildOriginalDocumentMetadata } from '@/lib/document-storage'
import { listTicketInputAttachments } from '@/domain/ticket/ticket-input-attachment-service'
import { fail, ok, type ActionResult } from '@/lib/result'
import { applyAgentModelConfigUpdate } from '@/app/actions/agent-model-config-update'
import type { AgentModelConfigInput } from '@/app/actions/agent-model-config-update'
import { isRuleExhausted, pickPeakAgent } from '@/lib/budget-rule-usage'
import { NORMAL_TOOL_CAPABILITY_NAMES } from '@/lib/tool-capability-catalog'
import {
  PROVISIONING_ASSISTANT_AGENT_NAME,
  RUN_ANALYST_SYSTEM_ROLE,
} from '@/lib/platform-agent-registry'
import {
  RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE,
  RUN_ANALYST_CONNECTOR_LOCKED_MESSAGE,
  RUN_ANALYST_ROLE_CAPABILITIES,
} from '@/domain/agents/run-analyst-role'
import { agentScaffoldUserMessage, selectScaffoldConnectors, selectScaffoldPeerAgents } from '@/domain/agents/agent-scaffold-agent'
import { toolsRequiringConnector } from '@/domain/tool-broker/tool-broker-authorizer'
import {
  agentIdSchema,
  approveTrainingSchema,
  createEvalSchema,
  runEvalSchema,
  costSummarySchema,
  createSandboxReportSchema,
  createSandboxAppSchema,
  upsertSandboxAppVersionSchema,
  listSandboxAppsSchema,
  getSandboxAppSchema,
  sandboxAppPreviewUrlSchema,
  activateSandboxAppVersionSchema,
  archiveSandboxAppSchema,
  listAuditLogSchema,
  createAgentSchema,
  draftAgentFromDescriptionSchema,
  agentApiKeyIdSchema,
  suspendAgentSchema,
  createBehaviorProfileSchema,
  updateBehaviorProfileSchema,
  acceptBehaviorProfileUpdateSchema,
  setAgentBehaviorProfileSchema,
  behaviorProfileIdSchema,
  updateAgentInstructionSchema,
  updateAgentModelConfigSchema,
  updateAgentPersonaSchema,
  updateAgentAvatarSchema,
  updateAgentSelfEvolutionProfileSchema,
  updateAgentSensitivityPolicySchema,
  updateAgentOperatorVisibilitySchema,
  updateAgentTaskOnlySchema,
  createHttpApiConnectorSchema,
  createTrainingSchema,
  askWikiSchema,
  generateReportSchema,
  createAgentTaskTicketSchema,
  createScheduledAgentTaskSchema,
  loadAgentChatSchema,
  listAgentChatSessionsSchema,
  conversationIdSchema,
  promoteToTicketSchema,
  messageIdSchema,
  scheduledTaskIdSchema,
  processDocumentSchema,
  processDocumentForWikiSchema,
  requestKbDocumentSchema,
  kbTicketSchema,
  shareKnowledgeBaseSchema,
  deleteKbDocumentSchema,
  kbArtifactReviewSchema,
  rollbackMemorySchema,
  proposeMemoryItemChangeSchema,
  listTrainingMemoryVersionsSchema,
  memoryCandidateIdSchema,
  consequenceApprovalIdSchema,
  rejectMemoryCandidateSchema,
  modifyMemoryCandidateSchema,
  approveMemoryCandidateTicketSchema,
  memoryScopeSchema,
  rollbackMemoryVersionSchema,
  ticketFilterSchema,
  ticketIdSchema,
  ticketTypeConfigSchema,
  transitionTicketSchema,
  addTicketCommentSchema,
  listTicketCommentsSchema,
  modelPolicyEntrySchema,
  createBoardTicketSchema,
  dispatchBoardTicketSchema,
  deleteBoardTicketSchema,
  inviteUserSchema,
  provisionUserSchema,
  redeemInvitationSchema,
  revokeInvitationSchema,
  approveUserSchema,
  changeUserRoleSchema,
  suspendUserSchema,
  reactivateUserSchema,
  setUserJobDescriptionSchema,
  updateRolePermissionSchema,
  setDispatcherControlsSchema,
  setDatabaseModeSchema,
  syncTestDatabaseSchema,
} from '@/lib/validators/actions'

function safeUploadFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-() ]+/g, '_')
  if (!base || base === '.' || base === '..') return 'upload.txt'
  return base.slice(0, 200)
}

function resolveUploadTarget(filename: string): { storageRef: string; absolutePath: string } {
  const uploadDir = path.resolve(process.cwd(), 'uploads')
  const safeName = `${Date.now()}-${safeUploadFilename(filename)}`
  const absolutePath = path.resolve(uploadDir, safeName)
  const uploadRoot = uploadDir.endsWith(path.sep) ? uploadDir : `${uploadDir}${path.sep}`
  if (!absolutePath.startsWith(uploadRoot)) {
    throw new Error('Invalid upload path')
  }
  return { storageRef: path.join('uploads', safeName), absolutePath }
}

const imageFilenamePattern = /\.(jpg|jpeg|png|gif|webp)$/i
const imageDataMarkerPattern = /^(\[image:([^\]]+)\])([\s\S]*)$/

function parseStoredChatMessage(content: string): { text: string; attachmentIds: string[] } {
  try {
    const parsed = JSON.parse(content) as { text?: string; attachmentIds?: string[] }
    if (typeof parsed.text === 'string') {
      return {
        text: parsed.text,
        attachmentIds: Array.isArray(parsed.attachmentIds)
          ? parsed.attachmentIds.filter((id): id is string => typeof id === 'string')
          : [],
      }
    }
  } catch {
    // Legacy messages are stored as plain text.
  }
  return { text: content, attachmentIds: [] }
}

function decodeInlineConversationContent(contentRef: string | null | undefined): string | null {
  if (!contentRef) return null
  if (contentRef.startsWith('inline:')) return contentRef.slice('inline:'.length)
  return contentRef
}

function decodeConversationPreview(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: string }
    if (typeof parsed.text === 'string') return parsed.text
  } catch {
    // Legacy messages are stored as plain text.
  }
  return content
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  const candidate = fenced?.[1]?.trim() || trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function formatConversationForTicketPrompt(
  messages: Array<{
    role: 'user' | 'agent' | 'system' | 'tool'
    content: string | null
    contentDeletedAt?: Date | null
    createdAt: Date
  }>,
): string {
  return messages
    .map((message, index) => {
      const roleLabel =
        message.role === 'user'
          ? 'Felhasználó'
          : message.role === 'agent'
            ? 'AI'
            : message.role === 'tool'
              ? 'Eszköz'
              : 'Rendszer'
      const rawContent =
        message.contentDeletedAt || !message.content
          ? '[törölt vagy üres üzenet]'
          : message.role === 'user'
            ? parseStoredChatMessage(message.content).text || '[üres user üzenet]'
            : message.content
      return `${index + 1}. ${roleLabel} (${message.createdAt.toISOString()}): ${rawContent}`
    })
    .join('\n')
}

function buildTicketGenerationPrompt(input: {
  transcript: string
  agents: Array<{ id: string; name: string; role?: string | null }>
  users: Array<{ id: string; name: string | null; role?: string | null; jobDescription?: string | null }>
}): string {
  const agentList =
    input.agents.length > 0
      ? input.agents.map((agent) => `- ${agent.id} | ${agent.name} | role=${agent.role ?? 'n/a'}`).join('\n')
      : '- nincs elérhető agent'
  const userList =
    input.users.length > 0
      ? input.users
          .map(
            (user) =>
              `- ${user.id} | ${user.name ?? 'Névtelen'} | role=${user.role ?? 'n/a'} | job=${user.jobDescription ?? 'n/a'}`,
          )
          .join('\n')
      : '- nincs elérhető humán munkatárs'

  return [
    'Feladat: elemezd a beszélgetést, és döntsd el, kell-e belőle ticketet nyitni.',
    'Ha NEM egyértelmű, hogy pontosan mi a feladat vagy ki a felelős, NE találgass: tegyél fel 1 rövid tisztázó kérdést.',
    'Ha egyértelmű, hozz létre EGY ticket-javaslatot.',
    'A felelőst kizárólag a megadott agent/user listából választhatod, pontos assigneeId-val.',
    'Humán feladatnál assigneeType="human", AI/agent feladatnál assigneeType="agent".',
    'A `title` legyen rövid, a `description` pedig 2-6 mondatban foglalja össze a konkrét elvárt eredményt és releváns kontextust.',
    'Válaszolj KIZÁRÓLAG JSON-nal, más szöveg nélkül.',
    'A JSON egyik alakja:',
    '{"status":"needs_clarification","question":"..."}',
    'vagy:',
    '{"status":"create_ticket","title":"...","description":"...","assigneeType":"human|agent","assigneeId":"uuid","rationale":"..."}',
    '',
    'Elérhető agentek:',
    agentList,
    '',
    'Elérhető humán munkatársak:',
    userList,
    '',
    'Beszélgetés:',
    input.transcript,
  ].join('\n')
}

export async function listTickets(input?: { filter?: unknown; limit?: number; offset?: number }) {
  try {
    const user = await requireTenantRole('viewer')
    const filter = input?.filter ? ticketFilterSchema.parse(input.filter) : undefined
    const page = await repositories.tickets.listPage({
      ...(filter ?? {}),
      tenantId: user.activeTenantId,
      limit: input?.limit,
      offset: input?.offset,
    })
    return ok(page.items)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list tickets')
  }
}

export async function listBoardAssignees() {
  try {
    const user = await requireTenantRole('operator')
    // #142 — a felelős-választó `address` alapján szűr (nem `view`): a UI nem
    // kínálhat olyan agentet, akit a rendszer a ticket felvételekor elutasítana.
    // Ez az a hibaosztály, ahol a felhasználó „kiválaszt valakit, aztán nem megy".
    const subject = tenantUserSubject(user)
    const [agents, memberships] = await Promise.all([
      subject
        ? services.agentAccess.listAccessibleAgents(subject, 'address', {
            subjectIsTenantAdmin: isTenantAdmin(user),
            activeOnly: true,
          })
        : Promise.resolve([]),
      prisma.tenantMembership.findMany({
        where: {
          tenantId: user.activeTenantId,
          status: 'active',
          user: { status: 'active' },
        },
        include: { user: { select: { id: true, name: true } } },
        orderBy: { user: { name: 'asc' } },
      }),
    ])

    return ok({
      agents: agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          avatarUrl: agent.avatarUrl,
          personaNickname: agent.personaNickname,
          personaTrait: agent.personaTrait,
          status: agent.status,
          taskOnly: agent.taskOnly,
        })),
      users: memberships.map((membership) => ({
        id: membership.user.id,
        name: membership.user.name,
        role: membership.role,
      })),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list board assignees')
  }
}

async function runAgentTicketDispatch(
  ticketId: string,
  agentId: string,
  options?: { bypassDispatcherEnabledCheck?: boolean },
): Promise<{ warning?: string; error?: string }> {
  // Azonnali dispatch minden launcher módban (§5.7): a launch() docker-local,
  // cloud-run-job ÉS local-wiki esetén is fire-and-forget (a futás a háttérben
  // folytatódik) — a UI create / pontosítás-visszaadás nem várja meg a végét.
  try {
    const dispatchResult = await services.dispatcher.dispatchTicket(ticketId, new Date(), {
      bypassEnabledCheck: options?.bypassDispatcherEnabledCheck,
    })
    if (dispatchResult.status === 'budget_blocked') {
      if (isTicketCallCapReason(dispatchResult.reason)) {
        const usage = await repositories.modelCalls.getUsageForTicket(ticketId)
        return {
          warning:
            ticketCallCapExceededMessage(usage) ??
            formatTicketCallCapUserMessage({
              calls: usage.calls,
              maxCalls: currentTicketCallCapLimit(),
            }),
        }
      }
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      const usage = await repositories.modelCalls.getUsageForAgentSince(agentId, since)
      const budget = dispatchBudgetFromEnv()
      return {
        warning:
          `Ticket létrejött (ready), de a napi keret betelt: ${usage.tokens.toLocaleString('hu-HU')}/${budget.maxTokensPerDay.toLocaleString('hu-HU')} token, ${usage.calls}/${budget.maxCallsPerDay} hívás. ` +
          'Emeld a keretet a System → Napi keret / Model Gateway panelen, vagy a DISPATCH_MAX_* env-eken — vagy várd meg a holnapi resetet.',
      }
    }
    if (dispatchResult.status === 'blocked') {
      return {
        warning:
          `Feldolgozás leállítva (permanens hiba): ${dispatchResult.reason ?? 'ismeretlen hiba'}. ` +
          'A ticket emberi válaszra vár — javítsd a konfigurációt, majd próbáld újra, vagy nyiss új ticketet.',
      }
    }
    if (dispatchResult.status === 'paused') {
      return {
        warning:
          'A ticket ready állapotban van, de a dispatcher ki van kapcsolva — System → Dispatcher panelen kapcsold be, vagy indítsd kézzel.',
      }
    }
    if (dispatchResult.status === 'skipped') {
      return {
        warning:
          'A ticket ready állapotban van, de a feldolgozás most nem indult el — a cron safety-net vagy egy kézi dispatch veszi fel.',
      }
    }
    return {}
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Ticket létrejött, de a feldolgozás elbukott: ${error.message}`
          : 'Ticket létrejött, de a feldolgozás elbukott',
    }
  }
}

function assertTicketTenantScope(ticket: { tenantId: string | null }, tenantId: string | null) {
  if (ticket.tenantId !== tenantId) throw new Error('Ticket not found')
}

/**
 * A tanítási / memória-írási útvonal aktora (MemoryTraining spec I8). Mindig az
 * AKTÍV tenant-kontextusból épül: a tenant-tagsághoz tartozó szerep az igazság
 * forrása, nem a legacy `User.role`. A `TrainingService` ebből dönti el, hogy a
 * cél-agent egyáltalán elérhető-e a hívó tenantjából.
 */
function trainingActor(user: TenantAuthContext): TrainingActor {
  return { id: user.user.id, tenantId: user.activeTenantId, role: user.activeTenantRole }
}

function canWriteTicketComment(
  ticket: { createdById: string },
  user: { user: { id: string }; activeTenantRole: UserRole },
) {
  return hasMinimumRole(user.activeTenantRole, 'operator') || ticket.createdById === user.user.id
}

function metadataRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function allowedTicketAttachment(file: File): boolean {
  const mime = file.type || 'application/octet-stream'
  const allowedMime =
    mime.startsWith('image/') ||
    [
      'application/pdf',
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ].includes(mime)
  const allowedExtension = /\.(txt|md|csv|pdf|docx|xlsx|png|jpe?g|webp|gif)$/i.test(file.name)
  return allowedMime || allowedExtension
}

/** Feltöltött (untrusted) fájl legnagyobb mérete — zip-bomba / OOM elleni közös plafon. */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Egységes feltöltés-kapu (méret + típus) MINDEN feltöltési úthoz (ticket-csatolmány
 * ÉS KB-dokumentum). Egy helyen tartja a korlátot, hogy a két út ne tudjon szétcsúszni.
 * Elutasítási okot ad vissza, vagy `null`-t, ha a fájl rendben van.
 */
function uploadRejectionReason(file: File): string | null {
  if (file.size > MAX_UPLOAD_BYTES) return 'A fájl legfeljebb 25 MB lehet'
  if (!allowedTicketAttachment(file)) return 'Nem támogatott fájltípus'
  return null
}

async function requireCommentWritableTicket(ticketId: string) {
  const user = await requireTenantRole(['viewer', 'operator', 'approver', 'admin'])
  const ticket = await repositories.tickets.findById(ticketId)
  if (!ticket) throw new Error('Ticket not found')
  assertTicketTenantScope(ticket, user.activeTenantId)
  if (!canWriteTicketComment(ticket, user)) throw new Error('Insufficient permissions')
  return { user, ticket }
}

export async function createBoardTicket(input: {
  title: string
  description?: string
  assigneeType: 'human' | 'agent'
  assigneeId: string
  skillVersionIds?: string[]
  dueBy?: string | null
  deferDispatch?: boolean
  skillParameterValues?: Record<string, string>
  scheduleMode?: 'none' | 'once' | 'recurring'
  runAt?: string
  recurrence?: 'hourly' | 'daily' | 'weekly' | 'monthly'
  intervalHours?: number
  maxRuns?: number | null
}) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = createBoardTicketSchema.parse(input)

    let promptText = parsed.description?.trim() || parsed.title.trim()
    let ticketTitle = parsed.title
    const dueBy = parsed.dueBy ? new Date(parsed.dueBy) : null
    if (dueBy && Number.isNaN(dueBy.getTime())) return fail('Invalid dueBy')

    if (parsed.assigneeType === 'agent') {
      // #142 — a lista (listBoardAssignees) már `address`-szűrt, de a server action
      // önmagában is kaput kell tegyen: kézzel megadott assigneeId ne kerülhesse meg.
      const subject = tenantUserSubject(user)
      if (!subject) return fail('Agent not found')
      try {
        await services.agentAccess.assertCanAccessAgent({
          subject,
          targetAgentId: parsed.assigneeId,
          verb: 'address',
          subjectIsTenantAdmin: isTenantAdmin(user),
          audit: {
            channel: 'ticket',
            initiatingUserId: user.user.id,
          },
        })
      } catch (error) {
        if (isAgentAccessError(error)) return fail(error.message)
        throw error
      }

      const agentDetails = await repositories.agents.findByIdForRuntime(
        parsed.assigneeId,
        user.activeTenantId,
      )
      if (!agentDetails) return fail('Agent not found')
      if (agentDetails.agent.status !== 'active') return fail('Agent is not active')

      const requestedSkillIds = [...new Set(parsed.skillVersionIds ?? [])]
      let assignedSkillIndex: Awaited<
        ReturnType<typeof services.skills.getAssignedSkillIndex>
      > = []
      if (requestedSkillIds.length > 0) {
        assignedSkillIndex = await services.skills.getAssignedSkillIndex(parsed.assigneeId)
        const enabledIds = new Set(assignedSkillIndex.map((row) => row.skillVersionId))
        const invalid = requestedSkillIds.filter((id) => !enabledIds.has(id))
        if (invalid.length > 0) {
          return fail('One or more selected skills are not enabled for this agent')
        }
      }

      // Feladatkör-korlátozás (#199). A korlátozott agent felülete egyetlen
      // skill-kötött gombra egyszerűsödik: se cím, se szabad szöveges leírás nem
      // érkezhet a klienstől. A hibát KIMONDJUK — a csendes eldobás azt a hamis
      // képet adná a hívónak, hogy a leírása eljutott a modellhez.
      let taskOnlySkillParameterValues: Record<string, string> = {}
      if (agentDetails.agent.taskOnly) {
        const skillEntry = assignedSkillIndex.find(
          (row) => row.skillVersionId === requestedSkillIds[0],
        )
        const skillContent =
          requestedSkillIds.length === 1
            ? await services.skills.getSkillContentForVersion(requestedSkillIds[0])
            : null
        const validation = validateTaskOnlyTaskInput({
          description: parsed.description,
          skillVersionIds: requestedSkillIds,
          skillParameterValues: parsed.skillParameterValues,
          declaredParameterNames: (skillContent?.parameters ?? []).map((p) => p.name),
        })
        if (!validation.ok) return fail(validation.error)
        if (!skillEntry) return fail('One or more selected skills are not enabled for this agent')
        taskOnlySkillParameterValues = validation.parameterValues

        // A cím szerveroldalon generált; a kliens `title` bemenete nem érvényesül.
        // Megjelenített név (ha van), különben a technikai slug.
        ticketTitle = buildTaskOnlyTicketTitle(skillDisplayLabel(skillEntry), new Date())
        // A generált cím NE váljon rejtett prompttá: a runtime a `question`
        // hiányában a címre esne vissza. Determinisztikus feladat-szöveget írunk.
        // A promptban a technikai név marad — ez egyezik a betöltött skill `name`-jével.
        promptText = buildTaskOnlyTaskPrompt(skillEntry.name)
      } else if (parsed.skillParameterValues) {
        return fail('Skill-paraméterek csak korlátozott feladatkörű agentnél adhatók meg')
      }

      const modelConfig = agentDetails.agent.modelConfig as {
        provider: string
        model: string
        temperature?: number
        maxTokens?: number
      }

      const payload: Record<string, unknown> = {
        question: promptText,
        task: promptText,
        source: 'board',
        agentVersion: agentDetails.agent.currentVersion,
        model: modelConfig.model,
        memoryVersion: agentDetails.memoryVersion,
      }
      if (requestedSkillIds.length > 0) {
        payload.preferredSkillVersionIds = requestedSkillIds
      }
      if (agentDetails.agent.taskOnly) {
        payload.taskOnly = true
        if (Object.keys(taskOnlySkillParameterValues).length > 0) {
          payload.skillParameterValues = taskOnlySkillParameterValues
        }
      }

      const scheduleMode = parsed.scheduleMode ?? 'none'
      const executeAfter =
        scheduleMode === 'once' || scheduleMode === 'recurring'
          ? new Date(parsed.runAt as string)
          : null
      if (executeAfter && Number.isNaN(executeAfter.getTime())) return fail('Invalid runAt')
      if (executeAfter) {
        const stamp = buildTicketScheduleStamp({
          kind: scheduleMode === 'recurring' ? 'recurring' : 'once',
          runAt: executeAfter,
          recurrence: parsed.recurrence,
          intervalHours: parsed.intervalHours,
          maxRuns: parsed.maxRuns,
          role: scheduleMode === 'recurring' ? 'series' : undefined,
        })
        Object.assign(
          payload,
          stampTicketSchedule(
            payload,
            stamp,
            scheduleMode === 'recurring' ? { role: 'series' } : undefined,
          ),
        )
      }

      const ticket = await repositories.tickets.create({
        tenantId: user.activeTenantId,
        type: 'interaction',
        title: ticketTitle,
        state: 'ready',
        assigneeType: 'agent',
        assigneeId: parsed.assigneeId,
        agentId: parsed.assigneeId,
        payload: payload as Prisma.JsonValue,
        sourceDocumentId: null,
        executeAfter,
        dueBy,
        createdById: user.user.id,
      })

      if (scheduleMode === 'recurring' && executeAfter && parsed.recurrence) {
        const scheduledTask = await services.scheduledTasks.createAgentTask({
          tenantId: user.activeTenantId,
          agentId: parsed.assigneeId,
          title: ticketTitle,
          content: promptText,
          createdById: user.user.id,
          nextRunAt: executeAfter,
          recurrence: parsed.recurrence,
          intervalHours: parsed.intervalHours,
          maxRuns: parsed.maxRuns,
          payload: {
            source: 'board',
            seriesTicketId: ticket.id,
            preferredSkillVersionIds: requestedSkillIds,
            ...(agentDetails.agent.taskOnly ? { taskOnly: true } : {}),
            ...(Object.keys(taskOnlySkillParameterValues).length > 0
              ? { skillParameterValues: taskOnlySkillParameterValues }
              : {}),
          },
        })
        await repositories.tickets.update(ticket.id, {
          payload: stampTicketSchedule(
            payload,
            buildTicketScheduleStamp({
              kind: 'recurring',
              runAt: executeAfter,
              recurrence: parsed.recurrence,
              intervalHours: parsed.intervalHours,
              maxRuns: parsed.maxRuns,
              role: 'series',
            }),
            { scheduledTaskId: scheduledTask.id, role: 'series' },
          ) as Prisma.JsonObject,
        })
      }

      const scheduled = Boolean(executeAfter)
      let warning: string | undefined
      if (!parsed.deferDispatch && !scheduled) {
        const dispatchOutcome = await runAgentTicketDispatch(ticket.id, parsed.assigneeId)
        if (dispatchOutcome.error) return fail(dispatchOutcome.error)
        warning = dispatchOutcome.warning
      }

      const updated = await repositories.tickets.findById(ticket.id)
      return ok({ ticket: updated ?? ticket, warning })
    }

    const payload: Record<string, unknown> = { source: 'board' }
    if (parsed.description) payload.task = parsed.description

    const assigneeMembership = await prisma.tenantMembership.findUnique({
      where: {
        tenantId_userId: {
          tenantId: user.activeTenantId,
          userId: parsed.assigneeId,
        },
      },
      include: { user: { select: { status: true } } },
    })
    if (!assigneeMembership || assigneeMembership.status !== 'active') return fail('User not found')
    if (assigneeMembership.user.status !== 'active') return fail('User is not active')

    const ticket = await repositories.tickets.create({
      tenantId: user.activeTenantId,
      type: 'interaction',
      title: parsed.title,
      state: 'awaiting_human',
      assigneeType: 'human',
      assigneeId: parsed.assigneeId,
      agentId: null,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: null,
      executeAfter: null,
      dueBy,
      createdById: user.user.id,
    })

    return ok({ ticket })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create board ticket')
  }
}

export async function dispatchBoardTicket(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { ticketId } = dispatchBoardTicketSchema.parse(input)
    const ticket = await repositories.tickets.findById(ticketId)
    if (!ticket) return fail('Ticket not found')
    assertTicketTenantScope(ticket, user.activeTenantId)
    if (ticket.assigneeType !== 'agent' || !ticket.agentId) {
      return fail('Ticket is not assigned to an agent')
    }
    if (ticket.state !== 'ready') return fail('Ticket is not in ready state')
    if (isScheduleSeriesTicket(ticket)) {
      return fail('Recurring series tickets are not dispatched; a run copy is created at the scheduled time')
    }

    const dispatchOutcome = await runAgentTicketDispatch(ticketId, ticket.agentId, {
      bypassDispatcherEnabledCheck: true,
    })
    if (dispatchOutcome.error) return fail(dispatchOutcome.error)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'dispatch.manual',
      targetType: 'ticket',
      targetId: ticketId,
      modelUsed: null,
      inputRef: ticket.agentId,
      outputRef: dispatchOutcome.warning ? 'warning' : 'started',
      policyDecision: 'allowed',
      metadata: { warning: dispatchOutcome.warning ?? null },
      tenantId: ticket.tenantId,
      ticketId,
    })

    const updated = await repositories.tickets.findById(ticketId)
    return ok({ ticket: updated ?? ticket, warning: dispatchOutcome.warning })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to dispatch board ticket')
  }
}

export async function deleteBoardTicket(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { ticketId } = deleteBoardTicketSchema.parse(input)
    const ticket = await repositories.tickets.findById(ticketId)
    if (!ticket) return fail('Ticket not found')
    assertTicketTenantScope(ticket, user.activeTenantId)

    const isAdmin = hasMinimumRole(user.activeTenantRole, 'admin')
    if (!isAdmin && !canWriteTicketComment(ticket, user)) {
      return fail('Insufficient permissions')
    }

    const tenantId = ticket.tenantId ?? user.activeTenantId
    // Workspace előbb — ha a GCS törlés elbukik, a ticket sor még megvan (újrapróbálható).
    await services.workspaceLifecycle.purgeTicketWorkspace(tenantId, ticketId)
    await repositories.tickets.deleteTicket(ticketId, { force: isAdmin })
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'ticket.delete',
      targetType: 'ticket',
      targetId: ticketId,
      modelUsed: null,
      inputRef: ticket.state,
      outputRef: 'deleted',
      policyDecision: 'allowed',
      metadata: {
        force: isAdmin,
        title: ticket.title,
        assigneeType: ticket.assigneeType,
        assigneeId: ticket.assigneeId,
      },
      tenantId: ticket.tenantId,
      ticketId,
    })

    return ok({ ticketId })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete board ticket')
  }
}

export async function listBoardTickets(input?: {
  updatedFrom?: string
  updatedTo?: string
  involvedAgentId?: string
}) {
  try {
    const user = await requireTenantRole('viewer')
    const range = resolveBoardDateRange({ from: input?.updatedFrom, to: input?.updatedTo })
    const involvedAgentId = input?.involvedAgentId
      ? agentIdSchema.parse({ id: input.involvedAgentId }).id
      : undefined
    const page = await repositories.tickets.listPage({
      excludeTest: true,
      tenantId: user.activeTenantId,
      limit: BOARD_LIST_LIMIT,
      updatedAtGte: range.updatedAtGte,
      updatedAtLte: range.updatedAtLte,
      ...(involvedAgentId ? { involvedAgentId } : {}),
    })
    const tickets = page.items

    const agentIds = new Set<string>()
    const userIds = new Set<string>()
    const processInstanceIds = new Set<string>()
    for (const ticket of tickets) {
      userIds.add(ticket.createdById)
      if (ticket.assigneeType === 'agent' && ticket.assigneeId) agentIds.add(ticket.assigneeId)
      if (ticket.assigneeType === 'human' && ticket.assigneeId) userIds.add(ticket.assigneeId)
      if (ticket.agentId) agentIds.add(ticket.agentId)
      if (ticket.processInstanceId) processInstanceIds.add(ticket.processInstanceId)
      const creatorAgentId = extractCreatorAgentId(ticket.payload)
      if (creatorAgentId) agentIds.add(creatorAgentId)
    }

    const [agents, users, processes] = await Promise.all([
      agentIds.size > 0
        ? prisma.agent.findMany({
            where: { id: { in: [...agentIds] } },
            select: { id: true, name: true, personaNickname: true },
          })
        : Promise.resolve([]),
      userIds.size > 0
        ? prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      processInstanceIds.size > 0
        ? prisma.processInstance.findMany({
            where: { id: { in: [...processInstanceIds] } },
            select: { id: true, processType: true, status: true },
          })
        : Promise.resolve([]),
    ])

    const enriched = enrichTicketsForBoard(tickets, {
      agents: new Map(
        agents.map((agent) => [
          agent.id,
          { name: agent.name, personaNickname: agent.personaNickname },
        ]),
      ),
      users: new Map(users.map((u) => [u.id, u.name])),
      processes: new Map(processes.map((p) => [p.id, { processType: p.processType, status: p.status }])),
    })

    return ok({ tickets: enriched, hasMore: page.hasMore })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list board tickets')
  }
}

export async function listScheduledTasks() {
  try {
    const user = await requireTenantRole('operator')
    const tasks = await services.scheduledTasks.list({
      tenantId: user.activeTenantId,
      limit: 100,
    })
    return ok(tasks)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list scheduled tasks')
  }
}

export async function revokeScheduledTask(input: { id: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { id } = scheduledTaskIdSchema.parse(input)
    const task = await services.scheduledTasks.revoke({
      scheduledTaskId: id,
      actorId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(task)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke scheduled task')
  }
}

export async function getTicket(input: { id: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id } = ticketIdSchema.parse(input)
    const ticket = await repositories.tickets.findById(id)
    if (!ticket) return fail('Ticket not found')
    assertTicketTenantScope(ticket, user.activeTenantId)

    let reproduction: {
      agentVersion: number
      memoryVersion: number | null
      model: unknown
      recipe: { name: string; version: number; status: string } | null
    } | null = null

    const payload =
      typeof ticket.payload === 'object' && ticket.payload !== null && !Array.isArray(ticket.payload)
        ? (ticket.payload as Record<string, unknown>)
        : null
    const payloadAgentVersion =
      typeof payload?.agentVersion === 'number' ? payload.agentVersion : null

    if (ticket.agentId && payloadAgentVersion !== null) {
      reproduction = await repositories.agents.findVersionSnapshot(ticket.agentId, payloadAgentVersion)
    }

    const assigneeAgent =
      ticket.assigneeType === 'agent' && ticket.assigneeId
        ? await repositories.agents.findById(ticket.assigneeId)
        : null
    const responsibleAgent = ticket.agentId
      ? await repositories.agents.findById(ticket.agentId)
      : null
    const creatorAgentId = extractCreatorAgentId(ticket.payload)
    const [assigneeUser, creatorUser, creatorAgent, process, inputAttachments] = await Promise.all([
      ticket.assigneeType === 'human' && ticket.assigneeId
        ? prisma.user.findUnique({ where: { id: ticket.assigneeId }, select: { name: true } })
        : Promise.resolve(null),
      prisma.user.findUnique({ where: { id: ticket.createdById }, select: { name: true } }),
      creatorAgentId
        ? repositories.agents.findById(creatorAgentId)
        : Promise.resolve(null),
      ticket.processInstanceId
        ? prisma.processInstance.findUnique({
            where: { id: ticket.processInstanceId },
            select: { id: true, processType: true, status: true },
          })
        : Promise.resolve(null),
      listTicketInputAttachments(ticket.id),
    ])

    const display = buildTicketDisplayExtras(ticket, {
      assigneeAgentName: assigneeAgent?.name ?? null,
      assigneeAgentNickname: assigneeAgent?.personaNickname ?? null,
      assigneeUserName: assigneeUser?.name ?? null,
      responsibleAgentName:
        responsibleAgent && responsibleAgent.id !== ticket.assigneeId
          ? responsibleAgent.name
          : assigneeAgent?.name ?? responsibleAgent?.name ?? null,
      responsibleAgentNickname:
        responsibleAgent && responsibleAgent.id !== ticket.assigneeId
          ? responsibleAgent.personaNickname
          : assigneeAgent?.personaNickname ?? responsibleAgent?.personaNickname ?? null,
    })

    const agents = new Map<string, { name: string; personaNickname?: string | null }>()
    if (creatorAgent) {
      agents.set(creatorAgent.id, {
        name: creatorAgent.name,
        personaNickname: creatorAgent.personaNickname,
      })
    }

    const pendingConsequenceApprovals = await services.consequenceApproval.listOpenForTicket(
      id,
      {
        id: user.user.id,
        tenantId: user.activeTenantId,
        role: user.activeTenantRole,
      },
    )
    const { readConnectorGrantNeedsFromPayload } = await import(
      '@/domain/connector-grant/connector-grant-needed'
    )
    const pendingConnectorGrants = await services.connectorGrants.listOpenGrantNeeds({
      userId: user.user.id,
      tenantId: user.activeTenantId,
      ticketId: id,
      payloadCards: readConnectorGrantNeedsFromPayload(ticket.payload),
    })

    return ok({
      ...ticket,
      reproduction,
      ...display,
      process,
      inputAttachments,
      pendingConsequenceApprovals,
      pendingConnectorGrants,
      creator: formatTicketCreator({
        createdById: ticket.createdById,
        payload: ticket.payload,
        agents,
        userNames: new Map([[ticket.createdById, creatorUser?.name ?? 'Ismeretlen']]),
      }),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get ticket')
  }
}

export async function getTicketTransitions(input: { id: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id } = ticketIdSchema.parse(input)
    const ticket = await repositories.tickets.findById(id)
    if (!ticket) return fail('Ticket not found')
    assertTicketTenantScope(ticket, user.activeTenantId)
    const transitions = await repositories.tickets.findTransitions(id)
    return ok(transitions)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get ticket transitions')
  }
}

export async function listTicketComments(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = listTicketCommentsSchema.parse(input)
    const ticket = await repositories.tickets.findById(parsed.ticketId)
    if (!ticket) return fail('Ticket not found')
    assertTicketTenantScope(ticket, user.activeTenantId)
    return ok(await repositories.tickets.listComments(parsed.ticketId))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list ticket comments')
  }
}

export async function uploadTicketCommentAttachment(formData: FormData) {
  try {
    const ticketId = formData.get('ticketId')
    const kindRaw = formData.get('kind')
    const file = formData.get('file')
    if (typeof ticketId !== 'string') return fail('ticketId is required')
    const { user, ticket } = await requireCommentWritableTicket(ticketId)
    if (!(file instanceof File)) return fail('No file provided')
    const attachmentRejection = uploadRejectionReason(file)
    if (attachmentRejection) return fail(attachmentRejection)

    const kind = kindRaw === 'screenshot' ? 'screenshot' : 'file'
    const filename = safeUploadFilename(file.name || (kind === 'screenshot' ? 'screenshot.png' : 'upload.bin'))
    const mimeType = file.type || null
    const buffer = Buffer.from(await file.arrayBuffer())
    let extractedText = ''
    let extraction: StructuredExtraction | null = null

    if (mimeType?.startsWith('image/')) {
      extractedText = `[image:${mimeType}]${buffer.toString('base64')}`
    } else {
      extraction = await extractStructured({ buffer, filename, mimeType })
      extractedText = extraction.markdown
    }

    const { storageRef, absolutePath } = resolveUploadTarget(filename)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    // A Document.extractedText a kereshető/LLM-olvasható reprezentáció, a
    // storageRef viszont az ember által letölthető EREDETI fájl bájtjait őrzi.
    await writeFile(absolutePath, buffer)

    const document = await repositories.documents.create({
      filename,
      storageRef,
      extractedText,
      status: 'uploaded',
      connectorId: null,
      uploadedById: user.user.id,
      mimeType,
      metadata: buildOriginalDocumentMetadata(file.size, {
        tenantId: ticket.tenantId,
        ticketCommentDraft: true,
        ticketId: ticket.id,
        kind,
        ...(extraction ? { extraction: toExtractionMetadata(extraction) } : {}),
      }),
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'ticket.comment.attachment.uploaded',
      targetType: 'document',
      targetId: document.id,
      modelUsed: null,
      inputRef: ticket.id,
      outputRef: filename,
      policyDecision: 'allowed',
      metadata: { filename, mimeType, byteSize: file.size, kind },
      tenantId: ticket.tenantId,
      ticketId: ticket.id,
    })

    return ok({
      documentId: document.id,
      filename: document.filename,
      mimeType: document.mimeType,
      kind,
      byteSize: file.size,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Attachment upload failed')
  }
}

export async function addTicketComment(input: {
  ticketId: string
  body?: string
  attachmentDocumentIds?: string[]
  handBackToAgent?: boolean
}) {
  try {
    const parsed = addTicketCommentSchema.parse(input)
    const { user, ticket } = await requireCommentWritableTicket(parsed.ticketId)
    const body = parsed.body.trim()
    const attachmentIds = [...new Set(parsed.attachmentDocumentIds)]
    if (!body && attachmentIds.length === 0) return fail('Komment vagy csatolmány megadása kötelező')
    if (parsed.handBackToAgent && !ticket.agentId) return fail('A ticket nincs agenthez rendelve')
    if (parsed.handBackToAgent && ticket.processInstanceId) {
      return fail('Folyamat-ticketet v1-ben nem lehet agentnek visszaadni')
    }
    if (parsed.handBackToAgent && !['done', 'awaiting_human'].includes(ticket.state)) {
      return fail('Csak kész vagy emberi válaszra váró ticket adható vissza agentnek')
    }

    const documents = attachmentIds.length
      ? await prisma.document.findMany({ where: { id: { in: attachmentIds } } })
      : []
    const byId = new Map(documents.map((document) => [document.id, document]))
    const usedAttachmentCount = attachmentIds.length
      ? await prisma.ticketCommentAttachment.count({ where: { documentId: { in: attachmentIds } } })
      : 0
    if (usedAttachmentCount > 0) return fail('Egy csatolmány már hozzá van kötve egy kommenthez')

    const attachments = attachmentIds.map((documentId) => {
      const document = byId.get(documentId)
      if (!document) throw new Error('Attachment not found')
      const meta = metadataRecord(document.metadata)
      if (document.uploadedById !== user.user.id) throw new Error('Attachment owner mismatch')
      if (document.connectorId !== null) throw new Error('Attachment is already attached to a connector')
      if (meta.ticketCommentDraft !== true || meta.ticketId !== ticket.id) {
        throw new Error('Attachment is not a draft for this ticket')
      }
      return {
        documentId,
        kind: meta.kind === 'screenshot' ? 'screenshot' as const : 'file' as const,
        filename: document.filename,
        mimeType: document.mimeType,
        byteSize: typeof meta.byteSize === 'number' ? meta.byteSize : null,
      }
    })

    const recentDuplicate = await prisma.ticketComment.findFirst({
      where: {
        ticketId: ticket.id,
        authorUserId: user.user.id,
        kind: 'human_comment',
        body,
        createdAt: { gte: new Date(Date.now() - 15_000) },
      },
      orderBy: { createdAt: 'desc' },
    })
    if (recentDuplicate) {
      return ok({ comment: recentDuplicate, warning: 'Dupla beküldés kihagyva.' })
    }

    const comment = await repositories.tickets.appendComment({
      ticketId: ticket.id,
      kind: 'human_comment',
      authorType: 'human',
      authorUserId: user.user.id,
      authorDisplayName: user.user.name,
      body,
      attachments,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'ticket.comment.add',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: null,
      outputRef: String(comment.seq),
      policyDecision: 'allowed',
      metadata: { attachmentCount: attachments.length },
      tenantId: ticket.tenantId,
      ticketId: ticket.id,
    })

    let warning: string | undefined
    if (parsed.handBackToAgent) {
      const callCapWarning = ticketCallCapExceededMessage(
        await repositories.modelCalls.getUsageForTicket(ticket.id),
      )
      if (callCapWarning) {
        return ok({ comment, warning: callCapWarning })
      }

      await services.tickets.transition({
        ticketId: ticket.id,
        toState: 'needs_info',
        actor: { type: 'human', userId: user.user.id, role: user.activeTenantRole },
        note: body || 'Pontosítás csatolmányban',
      })
      await services.tickets.transition({
        ticketId: ticket.id,
        toState: 'ready',
        actor: { type: 'system' },
      })
      await repositories.tickets.appendComment({
        ticketId: ticket.id,
        kind: 'system_note',
        authorType: 'system',
        body: 'Visszaadva újrafeldolgozásra',
      })
      await repositories.audit.append({
        actorType: 'human',
        actorId: user.user.id,
        agentVersion: null,
        action: 'ticket.handback',
        targetType: 'ticket',
        targetId: ticket.id,
        modelUsed: null,
        inputRef: ticket.state,
        outputRef: 'ready',
        policyDecision: 'allowed',
        metadata: { commentId: comment.id },
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
      })
      if (!ticket.agentId) return fail('A ticket nincs agenthez rendelve')
      // User-intent handback: ne a cron/dispatcher enable-re várjunk.
      const dispatchOutcome = await runAgentTicketDispatch(ticket.id, ticket.agentId, {
        bypassDispatcherEnabledCheck: true,
      })
      warning = dispatchOutcome.error ?? dispatchOutcome.warning
    }

    return ok({ comment, warning })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to add ticket comment')
  }
}

export async function transitionTicket(input: {
  id: string
  toState: string
  note?: string
}): Promise<ActionResult<unknown>> {
  try {
    const user = await requireTenantRole(['viewer', 'operator', 'approver', 'admin'])
    const parsed = transitionTicketSchema.parse(input)

    const existing = await repositories.tickets.findById(parsed.id)
    if (!existing) return fail('Ticket not found')
    assertTicketTenantScope(existing, user.activeTenantId)

    if (
      existing.type === 'training' &&
      (parsed.toState === 'approved' || parsed.toState === 'done') &&
      existing.state === 'awaiting_human'
    ) {
      if (!hasMinimumRole(user.activeTenantRole, 'approver')) {
        return fail('Tanítás jóváhagyása approver jogosultságot igényel')
      }
      const result = await services.training.approveTraining(parsed.id, trainingActor(user))
      return ok(result)
    }

    if (parsed.toState === 'ready' && existing.agentId) {
      const callCapError = ticketCallCapExceededMessage(
        await repositories.modelCalls.getUsageForTicket(existing.id),
      )
      if (callCapError) return fail(callCapError)
    }

    const ticket = await services.tickets.transition({
      ticketId: parsed.id,
      toState: parsed.toState,
      actor: { type: 'human', userId: user.user.id, role: user.activeTenantRole },
      note: parsed.note,
    })

    if (parsed.note?.trim()) {
      await repositories.tickets.appendComment({
        ticketId: parsed.id,
        kind: 'human_comment',
        authorType: 'human',
        authorUserId: user.user.id,
        authorDisplayName: user.user.name,
        body: parsed.note.trim(),
      })
    }

    if (parsed.toState === 'approved') {
      const done = await services.tickets.transition({
        ticketId: parsed.id,
        toState: 'done',
        actor: { type: 'system' },
      })
      return ok(done ?? ticket)
    }

    if (parsed.toState === 'ready' && existing.agentId) {
      // „Újra feldolgozás" user-intent — ne a dispatcher enable-re várjunk.
      await runAgentTicketDispatch(parsed.id, existing.agentId, {
        bypassDispatcherEnabledCheck: true,
      })
    }

    return ok(ticket)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Transition failed')
  }
}

export async function listAgents(input?: { limit?: number; offset?: number }) {
  try {
    const user = await requireTenantRole('viewer')
    // #142 — az operátori agent-katalógus a felhasználó `view` jogán szűr. A
    // `hiddenFromOperators` katalógus-szabály a gráf ELŐTT szűr (non-admin), és
    // grant nem írja felül. Tenant-kontextus nélkül nincs gráf-alany → üres lista.
    const subject = tenantUserSubject(user)
    if (!subject) return ok([])
    const accessible = await services.agentAccess.listAccessibleAgents(subject, 'view', {
      subjectIsTenantAdmin: isTenantAdmin(user),
    })
    // A Futás-elemző a napi sínben is kell: tenant admin granttel a gráf adja,
    // assume-tenant superadmin (nincs membership-grant) az `analysis.run` kapun át.
    // Nincs `userId` — a 5 mp-es sín-poll nem materializál.
    let catalogIds = accessible.map((a) => a.id)
    if (isTenantAdmin(user)) {
      const entry = await resolveRunAnalysisEntry({
        tenantId: user.activeTenantId,
        role: user.activeTenantRole,
      })
      catalogIds = mergeRunAnalystIntoCatalogIds(catalogIds, entry)
    }
    // A lapozás a gráf által ENGEDÉLYEZETT halmazon fut (DB-szintű `ids` szűrő), így
    // egy oldal sem lesz „lyukas", és nem kell a teljes tenant-listát memóriába húzni.
    const page = await repositories.agents.listPage({
      tenantId: user.activeTenantId,
      ids: catalogIds,
      limit: input?.limit ?? DEFAULT_LIST_LIMIT,
      offset: input?.offset,
    })
    return ok(page.items)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list agents')
  }
}

export async function getAgent(input: { id: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id } = agentIdSchema.parse(input)
    const subject = tenantUserSubject(user)
    if (!subject) return fail('Agent not found')
    const runAnalystOk = await canOpenRunAnalystWorkspace({
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
      userId: user.user.id,
      agentId: id,
    })
    if (!runAnalystOk) {
      // #142 — közvetlen URL ne fedje fel a gráf szerint elrejtett agentet.
      const decision = await services.agentAccess.canAccessAgent(subject, id, 'view', {
        subjectIsTenantAdmin: isTenantAdmin(user),
      })
      if (!decision.allowed) return fail('Agent not found')
    }
    const detail = await repositories.agents.findByIdForDisplay(id, user.activeTenantId)
    if (!detail) return fail('Agent not found')
    return ok(detail)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get agent')
  }
}

export async function getAgentGovernance(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const subject = tenantUserSubject(user)
    if (!subject) return fail('Agent not found')
    const decision = await services.agentAccess.canAccessAgent(subject, agentId, 'view', {
      subjectIsTenantAdmin: isTenantAdmin(user),
    })
    if (!decision.allowed) return fail('Agent not found')
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const [capabilities, connectors] = await Promise.all([
      repositories.toolBroker.findCapabilitiesForAgent(agentId),
      repositories.toolBroker.findConnectorsForAgent(agentId),
    ])
    return ok({ capabilities, connectors })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get agent governance')
  }
}

/** Szóköz/vessző-elválasztott scope-listát tömbbé bont (OAuth2 authorization request). */
function parseOAuthScopes(scope: string | undefined): string[] {
  if (!scope) return []
  return [...new Set(scope.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]
}

function httpApiConnectorConfig(input: {
  baseUrl: string
  authScheme: 'header' | 'bearer' | 'oauth2' | 'oauth2_delegated'
  authHeader?: string
  tokenUrl?: string
  clientId?: string
  scope?: string
  authUrl?: string
  userInfoUrl?: string
  description?: string
  authProfiles?: Record<
    string,
    {
      secretAlias: string
      auth?: { scheme: 'bearer' } | { scheme: 'header'; header: string }
    }
  >
  defaultAuthProfile?: string
  requestHeaders?: Record<string, string>
  writeHeaders?: Record<string, string>
  restrictToEndpoints?: boolean
  defaultRisk?: 'read' | 'write' | 'danger'
  githubRepositoryAccess?: GitHubRepositoryAccess
  endpoints?: Array<{
    method: string
    path: string
    description?: string
    idempotent?: boolean
    profile?: string
    risk?: 'read' | 'write' | 'danger'
  }>
}) {
  return {
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    // oauth2_delegated: a runtime a per-user grant access tokent injektálja
    // Bearerként, ezért a client-oldali séma egyszerű bearer; a consent-flow
    // paramétereit a config.oauth blokk tartja (ConnectorGrantService olvassa).
    auth:
      input.authScheme === 'header'
        ? { scheme: 'header', header: input.authHeader! }
        : input.authScheme === 'oauth2'
          ? {
              scheme: 'oauth2',
              tokenUrl: input.tokenUrl!,
              clientId: input.clientId!,
              ...(input.scope ? { scope: input.scope } : {}),
            }
          : { scheme: 'bearer' },
    ...(input.authScheme === 'oauth2_delegated'
      ? {
          oauth: {
            authUrl: input.authUrl!,
            tokenUrl: input.tokenUrl!,
            clientId: input.clientId!,
            scopes: parseOAuthScopes(input.scope),
            ...(input.userInfoUrl ? { userInfoUrl: input.userInfoUrl } : {}),
          },
        }
      : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.authProfiles && Object.keys(input.authProfiles).length > 0
      ? { authProfiles: input.authProfiles }
      : {}),
    ...(input.defaultAuthProfile ? { defaultAuthProfile: input.defaultAuthProfile } : {}),
    ...(input.requestHeaders && Object.keys(input.requestHeaders).length > 0
      ? { requestHeaders: input.requestHeaders }
      : {}),
    ...(input.writeHeaders && Object.keys(input.writeHeaders).length > 0
      ? { writeHeaders: input.writeHeaders }
      : {}),
    ...(input.endpoints && input.endpoints.length > 0 ? { endpoints: input.endpoints } : {}),
    ...(input.defaultRisk ? { defaultRisk: input.defaultRisk } : {}),
    restrictToEndpoints: input.restrictToEndpoints,
    ...(input.githubRepositoryAccess ? { githubRepositoryAccess: input.githubRepositoryAccess } : {}),
  }
}

async function syncHttpApiCapabilities(agentId: string, connectorId: string, accessMode: 'read' | 'write') {
  for (const toolName of ['http_api_get', 'http_api_get_all'] as const) {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName } },
      create: { agentId, toolName, allowed: true },
      update: { allowed: true },
    })
  }

  if (accessMode === 'write') {
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId, toolName: 'http_api_request' } },
      create: { agentId, toolName: 'http_api_request', allowed: true },
      update: { allowed: true },
    })
    return
  }

  const writeConnectorCount = await prisma.agentConnector.count({
    where: {
      agentId,
      connectorId: { not: connectorId },
      accessMode: 'write',
      connector: { type: 'http_api' },
    },
  })
  if (writeConnectorCount === 0) {
    await prisma.capability.updateMany({
      where: { agentId, toolName: 'http_api_request' },
      data: { allowed: false },
    })
  }
}

export async function createHttpApiConnectorForAgent(input: {
  agentId: string
  name: string
  baseUrl: string
  authScheme: 'header' | 'bearer' | 'oauth2' | 'oauth2_delegated'
  authHeader?: string
  tokenUrl?: string
  clientId?: string
  scope?: string
  authUrl?: string
  userInfoUrl?: string
  apiKey?: string
  clientSecret?: string
  refreshToken?: string
  description?: string
  authProfiles?: Record<
    string,
    {
      secretAlias: string
      auth?: { scheme: 'bearer' } | { scheme: 'header'; header: string }
    }
  >
  defaultAuthProfile?: string
  requestHeaders?: Record<string, string>
  writeHeaders?: Record<string, string>
  accessMode?: 'read' | 'write'
  restrictToEndpoints?: boolean
  defaultRisk?: 'read' | 'write' | 'danger'
  githubRepositoryAccess?: GitHubRepositoryAccess
  endpoints?: Array<{
    method: string
    path: string
    description?: string
    idempotent?: boolean
    profile?: string
    risk?: 'read' | 'write' | 'danger'
  }>
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createHttpApiConnectorSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    if (agent.systemRole === RUN_ANALYST_SYSTEM_ROLE) {
      return fail(RUN_ANALYST_CONNECTOR_LOCKED_MESSAGE)
    }
    if (agent.role === 'orchestrator') {
      return fail('Orchestrator agent nem kaphat HTTP API connectort vagy Tool Broker capability-t.')
    }

    const existing = await prisma.connector.findFirst({
      where: { type: 'http_api', name: parsed.name, tenantId: user.activeTenantId ?? null },
    })
    if (existing) return fail(`Már létezik „${parsed.name}" nevű API-kapcsolat — adj egyedi nevet.`)

    const config = httpApiConnectorConfig(parsed)

    // 1. Connector létrehozása secret nélkül; 2. a pasted kulcs a secret-store
    //    mögé kerül (NEM a DB-be); 3. az alias secret-ref:<id>-re frissül.
    // oauth2_delegated: a connector user_delegated — a felhasználó adja a
    // hozzájárulást (authorization-code consent), az agent az ő tokenjével jár el.
    const isDelegated = parsed.authScheme === 'oauth2_delegated'
    const { withConnectorPrivacySlot } = await import('@/lib/privacy-slot')
    const connector = await prisma.connector.create({
      data: await withConnectorPrivacySlot(prisma, {
        type: 'http_api',
        name: parsed.name,
        authMode: isDelegated ? 'user_delegated' : 'service',
        scope: 'global',
        config: config as Prisma.InputJsonValue,
        secretAlias: null,
        tenantId: user.activeTenantId ?? null,
      }),
    })

    const { saveConnectorApiKey, buildConnectorSecretRef } = await import(
      '@/domain/connector/connector-secret-store'
    )
    // oauth2 sémánál a secret-store mögé NEM a nyers kulcs, hanem a refresh_token
    // grant-hoz szükséges JSON blob kerül: {"clientSecret","refreshToken"} — a
    // http_api runtime (§oauth2) ezt olvassa vissza a connector secretAlias-ából.
    // oauth2_delegated esetén csak a client_secret kerül a store mögé (a consent
    // token-cseréhez); a refresh_token per-user a grant-vaultba kerül a callbacknél.
    const secretPayload =
      parsed.authScheme === 'oauth2'
        ? JSON.stringify({ clientSecret: parsed.clientSecret, refreshToken: parsed.refreshToken })
        : isDelegated
          ? parsed.clientSecret!
          : parsed.apiKey!
    await saveConnectorApiKey(connector.id, secretPayload)
    await prisma.connector.update({
      where: { id: connector.id },
      data: { secretAlias: buildConnectorSecretRef(connector.id) },
    })

    // Agent ↔ connector kötés + a két http_api capability engedélyezése.
    await prisma.agentConnector.upsert({
      where: { agentId_connectorId: { agentId: parsed.agentId, connectorId: connector.id } },
      create: { agentId: parsed.agentId, connectorId: connector.id, accessMode: parsed.accessMode },
      update: { accessMode: parsed.accessMode },
    })

    await syncHttpApiCapabilities(parsed.agentId, connector.id, parsed.accessMode)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'connector.create',
      targetType: 'connector',
      targetId: connector.id,
      modelUsed: null,
      inputRef: parsed.agentId,
      outputRef: parsed.name,
      policyDecision: 'allowed',
      metadata: {
        type: 'http_api',
        baseUrl: config.baseUrl,
        accessMode: parsed.accessMode,
        endpointCount: parsed.endpoints?.length ?? 0,
      },
    })

    return ok({ connectorId: connector.id, name: connector.name })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create API connector')
  }
}

/**
 * WP-5 (B4) — KÖTÉS-szintű (agent↔connector) szerkesztés. Ez az egyetlen biztonságos
 * agent-szintű művelet a külső kapcsolatokon: CSAK az `AgentConnector` sort érinti
 * (hozzáférés + opcionális per-agent kulcs), a connector strukturális configját (baseUrl,
 * auth, fejlécek, endpointok) SOHA nem írja — azt a provisioning kezeli (WP-4). Így az
 * agent-nézetből egy „csak új kulcs" mentés semmi mást nem változtat, és a módosítás
 * nem hat ki a connectort osztó többi agentre.
 */
export async function updateAgentConnectorBinding(input: {
  agentId: string
  connectorId: string
  accessMode: 'read' | 'write'
  /** Per-agent kulcs (opcionális). Üresen hagyva a jelenlegi marad. */
  apiKey?: string
  /** Ha true: a per-agent kulcs törlődik, az agent a tenant-szintű kulcsra esik vissza. */
  clearApiKey?: boolean
  /**
   * issue #220 — írási bizalom. Csak admin; `preapproved` esetén kötelező a
   * laza/szigorú módválasztás (nincs előjelölt default).
   */
  writeApproval?: 'per_call' | 'preapproved'
  preapprovedTrustMode?: 'lax' | 'strict' | null
  preapprovedExpiresAt?: string | null
  preapprovedWriteLimit?: number | null
  dangerPreapproved?: boolean
  /** Opcionális connector-címke (nem kapcsolja a kaput). */
  consequenceBoundary?: 'external_draft' | 'platform' | null
}) {
  try {
    const user = await requireTenantRole('admin')
    const accessMode = input.accessMode === 'write' ? 'write' : 'read'

    const link = await prisma.agentConnector.findUnique({
      where: {
        agentId_connectorId: { agentId: input.agentId, connectorId: input.connectorId },
      },
      include: { connector: true, agent: true },
    })
    if (!link) return fail('API-kapcsolat nincs ehhez az agenthez rendelve.')
    if (link.connector.type !== 'http_api') return fail('Csak API-kapcsolat köthető itt.')
    // Tenant-izoláció: az agentnek (és így a kötésnek) az aktív tenantban kell lennie.
    if (link.agent.tenantId !== (user.activeTenantId ?? null)) {
      return fail('Az agent nem érhető el ebben a tenantban.')
    }

    // Per-agent kulcs kezelése. user_delegated (auto-consent) connectoron a per-agent
    // kulcs futásidőben NEM érvényesül (a per-user grant token megy ki) — ezért nem
    // engedjük megadni (csendes elnyelés tilos, WP-2 közös követelmény).
    let nextSecretAlias: string | null | undefined // undefined = változatlan
    const { saveConnectorApiKey, buildConnectorSecretRef, deleteConnectorApiKey, isConnectorSecretRef } =
      await import('@/domain/connector/connector-secret-store')
    const scopedSecretId = `${input.agentId}_ac_${input.connectorId}`

    if (input.clearApiKey) {
      if (link.secretAlias && isConnectorSecretRef(link.secretAlias)) {
        await deleteConnectorApiKey(scopedSecretId).catch(() => {})
      }
      nextSecretAlias = null
    } else if (input.apiKey?.trim()) {
      if (link.connector.authMode === 'user_delegated') {
        return fail(
          'Ez egy automatikus-hozzájárulású (user-delegált) kapcsolat — a per-agent kulcs futásidőben nem érvényesül. A hitelesítést az „Összekötött fiókok" oldalon kezeld.',
        )
      }
      await saveConnectorApiKey(scopedSecretId, input.apiKey.trim())
      nextSecretAlias = buildConnectorSecretRef(scopedSecretId)
    }

    // issue #220 — read módban nincs értelme a preapproved trustnak; mindig per_call.
    const { validateWriteApprovalBinding } = await import(
      '@/domain/tool-broker/write-approval-trust'
    )
    const writeApprovalInput =
      accessMode === 'read'
        ? { writeApproval: 'per_call' as const }
        : {
            writeApproval: input.writeApproval === 'preapproved' ? ('preapproved' as const) : ('per_call' as const),
            preapprovedTrustMode: input.preapprovedTrustMode,
            preapprovedExpiresAt: input.preapprovedExpiresAt,
            preapprovedWriteLimit: input.preapprovedWriteLimit,
            dangerPreapproved: input.dangerPreapproved,
          }
    const trustValidated = validateWriteApprovalBinding(writeApprovalInput)
    if (!trustValidated.ok) return fail(trustValidated.error)
    const trust = trustValidated.trust

    const requestedBoundary =
      input.consequenceBoundary === 'external_draft' || input.consequenceBoundary === 'platform'
        ? input.consequenceBoundary
        : input.consequenceBoundary === null
          ? null
          : undefined

    // A címke a CONNECTOR sorára megy, az pedig platformszintű (tenantId = null)
    // is lehet — ilyet több tenant használ, egy tenant-admin nem írhatja át
    // mások alatt. A kötés-mentő űrlap minden mentésnél küldi a mezőt, ezért
    // csak a TÉNYLEGES változtatást utasítjuk vissza (és hangosan, nem némán).
    const currentBoundary = link.connector.consequenceBoundary ?? null
    const boundaryChanged = requestedBoundary !== undefined && requestedBoundary !== currentBoundary
    if (boundaryChanged && link.connector.tenantId !== (user.activeTenantId ?? null)) {
      return fail(
        'Ez a kapcsolat platformszintű (több tenant használja) — a következmény-határ címkéjét itt nem lehet átírni. Az írási bizalom (kötés-szintű) továbbra is állítható.',
      )
    }

    await prisma.$transaction(async (tx) => {
      await tx.agentConnector.update({
        where: {
          agentId_connectorId: { agentId: input.agentId, connectorId: input.connectorId },
        },
        data: {
          accessMode,
          ...(nextSecretAlias !== undefined ? { secretAlias: nextSecretAlias } : {}),
          writeApproval: trust.mode,
          preapprovedTrustMode: trust.trustMode,
          preapprovedExpiresAt: trust.expiresAt,
          preapprovedWriteLimit: trust.writeLimitPerRun,
          dangerPreapproved: trust.dangerPreapproved,
        },
      })
      if (boundaryChanged) {
        await tx.connector.update({
          where: { id: input.connectorId },
          data: { consequenceBoundary: requestedBoundary },
        })
      }
    })

    await syncHttpApiCapabilities(input.agentId, input.connectorId, accessMode)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: link.agent.currentVersion,
      action: 'connector.binding.update',
      targetType: 'connector',
      targetId: input.connectorId,
      modelUsed: null,
      inputRef: input.agentId,
      outputRef: link.connector.name,
      policyDecision: 'allowed',
      metadata: {
        accessMode,
        writeApproval: trust.mode,
        preapprovedTrustMode: trust.trustMode,
        preapprovedExpiresAt: trust.expiresAt?.toISOString() ?? null,
        preapprovedWriteLimit: trust.writeLimitPerRun,
        dangerPreapproved: trust.dangerPreapproved,
        ...(boundaryChanged ? { consequenceBoundary: requestedBoundary } : {}),
        perAgentKeyRotated: Boolean(input.apiKey?.trim()),
        perAgentKeyCleared: Boolean(input.clearApiKey),
      },
    })

    return ok({ connectorId: input.connectorId, name: link.connector.name })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update connector binding')
  }
}

export async function createAgent(input: {
  name: string
  roleInstruction: string
  behaviorProfile: string
  role?: 'worker' | 'orchestrator'
  modelConfig: {
    provider: string
    model: string
    modelType?: 'luna' | 'terra' | 'sol'
    temperature?: number
    maxTokens?: number
  }
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createAgentSchema.parse(input)
    await services.platformSettings.assertModelAllowed(
      parsed.modelConfig.provider,
      parsed.modelConfig.model,
    )
    const result = await repositories.agents.create({
      ...parsed,
      createdById: user.user.id,
      tenantId: user.activeTenantId,
      status: 'draft',
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.create',
      targetType: 'agent',
      targetId: result.agent.id,
      modelUsed: null,
      inputRef: null,
      outputRef: result.agent.name,
      policyDecision: 'allowed',
      metadata: { role: result.agent.role, status: result.agent.status },
    })

    // Kiinduló jog: a tenant minden tagja láthatja / megszólíthatja az új agentet.
    // Az agent már létrejött — grant-hiba ne mutasson „létrehozás sikertelen”-t.
    if (user.activeTenantId) {
      try {
        const { materializeDefaultUserAgentGrants } = await import(
          '@/domain/agent-access/default-user-agent-grants'
        )
        await materializeDefaultUserAgentGrants({
          tenantId: user.activeTenantId,
          actorUserId: user.user.id,
          agentId: result.agent.id,
        })
      } catch (err) {
        logger.error(
          {
            event: 'agent_access.default_grants.materialize_failed',
            agentId: result.agent.id,
            tenantId: user.activeTenantId,
            error: String(err),
          },
          'Default user→agent grants failed after agent.create',
        )
      }
    }

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create agent')
  }
}

/**
 * Provisioning Assistant (§13 agent-scaffold): NL leírás → agent-vázlat.
 * Propose-not-apply — nem hoz létre agentet; a create-agent varázsló tölti fel,
 * az ember átnézi / módosítja, majd a meglévő `createAgent`-tel jóváhagyja.
 */
export async function draftAgentFromDescription(input: unknown) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = draftAgentFromDescriptionSchema.parse(input)

    const agents = await repositories.agents.findMany()
    const assistant = agents.find((a) => a.name === PROVISIONING_ASSISTANT_AGENT_NAME)
    if (!assistant) {
      return fail(agentScaffoldUserMessage('MISSING_ASSISTANT'))
    }

    const skillCatalog = await services.skills.listReferenceCatalog(user.activeTenantId)
    const tenant = await repositories.tenants.findById(user.activeTenantId!)
    const { readTenantLanguage } = await import('@/lib/tenant-language')
    const outputLanguage = readTenantLanguage(tenant?.settings)

    const tenantAgents = user.activeTenantId
      ? await repositories.agents.findMany({ tenantId: user.activeTenantId })
      : []
    const connectorCatalog = user.activeTenantId
      ? await repositories.connectorDrafts.listActiveCatalog(user.activeTenantId)
      : []
    const existingAgents = selectScaffoldPeerAgents(tenantAgents)
    const knownConnectors = selectScaffoldConnectors(connectorCatalog)

    const result = await services.agentScaffoldAgent.draftFromDescription({
      agentId: assistant.id,
      agentVersion: assistant.currentVersion,
      agentModelConfig: assistant.modelConfig,
      tenantId: user.activeTenantId,
      description: parsed.description,
      knownCapabilities: [...NORMAL_TOOL_CAPABILITY_NAMES],
      knownSkills: skillCatalog.map((s) => ({
        name: s.name,
        description: s.description,
        requiredTools: s.requiredTools,
      })),
      existingAgents,
      knownConnectors,
      outputLanguage,
    })

    if (!result.ok) {
      return fail(agentScaffoldUserMessage(result.error, result.detail))
    }

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.scaffold.propose',
      targetType: 'agent',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: result.draft.name,
      policyDecision: 'allowed',
      metadata: {
        assistantAgentId: assistant.id,
        role: result.draft.role,
        suggestedCapabilities: result.draft.suggestedCapabilities,
        suggestedCapabilityCount: result.draft.suggestedCapabilities.length,
        suggestedSkills: result.draft.suggestedSkills,
        suggestedSkillCount: result.draft.suggestedSkills.length,
        suggestedConnectors: result.draft.suggestedConnectors,
        suggestedConnectorCount: result.draft.suggestedConnectors.length,
        warningCodes: result.validation.warnings.map((w) => w.code),
        warningCount: result.validation.warnings.length,
        peerAgentCount: existingAgents.length,
        connectorCatalogCount: knownConnectors.length,
      },
    })

    return ok({
      draft: result.draft,
      validation: result.validation,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Nem sikerült az agent-vázlatot generálni')
  }
}

export async function updateAgentInstruction(input: {
  agentId: string
  roleInstruction?: string
  behaviorProfile?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentInstructionSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const result = await repositories.agents.updateInstruction(parsed)

    const changed = [
      result.roleChanged ? 'roleInstruction' : null,
      result.behaviorChanged ? 'behaviorProfile' : null,
    ].filter(Boolean)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: result.agentVersion,
      action: 'agent.version',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: `v${result.agentVersion}`,
      policyDecision: 'allowed',
      metadata: {
        changed,
        roleInstructionVersion: result.roleInstructionVersion,
        behaviorProfileVersion: result.behaviorProfileVersion,
      },
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent instruction')
  }
}

/**
 * Sensitivity router per-agent felmentés — DEPRECATED boolean (APG-11).
 * A kategória-policy a kanonikus forrás; ez a kapcsoló csak akkor él, ha az
 * agentnek nincs explicit overlay-je (read-time migráció). Tenant admin
 * (és a tenantban eljáró superadmin) írhatja.
 */
export async function updateAgentSensitivityPolicy(input: {
  agentId: string
  allowSensitiveExternalModel: boolean
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentSensitivityPolicySchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    if (agent.allowSensitiveExternalModel === parsed.allowSensitiveExternalModel) {
      return ok({ allowSensitiveExternalModel: agent.allowSensitiveExternalModel })
    }

    const updated = await repositories.agents.updateSensitivityPolicy(parsed)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.sensitivity_policy',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: `from:${agent.allowSensitiveExternalModel}`,
      outputRef: `to:${updated.allowSensitiveExternalModel}`,
      policyDecision: 'allowed',
      metadata: {
        allowSensitiveExternalModel: updated.allowSensitiveExternalModel,
        scope: 'all_sensitivity_tiers',
      },
    })

    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent sensitivity policy')
  }
}

/**
 * Operator-láthatóság. Tenant admin elrejtheti az agentet az operátorok elől;
 * a futás/dispatch nem függ ettől — csak a UI/API listázás és detail hozzáférés.
 */
export async function updateAgentOperatorVisibility(input: {
  agentId: string
  hiddenFromOperators: boolean
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentOperatorVisibilitySchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    if (agent.hiddenFromOperators === parsed.hiddenFromOperators) {
      return ok({ hiddenFromOperators: agent.hiddenFromOperators })
    }

    const updated = await repositories.agents.updateOperatorVisibility(parsed)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.operator_visibility',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: `from:${agent.hiddenFromOperators}`,
      outputRef: `to:${updated.hiddenFromOperators}`,
      policyDecision: 'allowed',
      metadata: {
        hiddenFromOperators: updated.hiddenFromOperators,
      },
    })

    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent operator visibility')
  }
}

/**
 * Feladatkör-korlátozás (#199). Bekapcsolva az agent EMBERI felületén nincs chat,
 * csak egyetlen skill-kötött feladat-indító gomb.
 *
 * FONTOS: ez UI-egyszerűsítés, NEM jogosultsági korlát. Az agent képességei
 * változatlanok, és a nem-emberi belépési pontok (`agent_ask`, csatorna-integrációk,
 * agent API-kulcs, monitor-eszkaláció, ticket-kommentek) nyitva maradnak.
 */
export async function updateAgentTaskOnly(input: { agentId: string; taskOnly: boolean }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentTaskOnlySchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    if (agent.taskOnly === parsed.taskOnly) {
      return ok({ taskOnly: agent.taskOnly })
    }

    const updated = await repositories.agents.updateTaskOnly(parsed)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.task_only',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: `from:${agent.taskOnly}`,
      outputRef: `to:${updated.taskOnly}`,
      policyDecision: 'allowed',
      metadata: {
        taskOnly: updated.taskOnly,
        scope: 'ui_only',
      },
    })

    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent task-only mode')
  }
}

export async function updateAgentPersona(input: {
  agentId: string
  personaNickname?: string
  personaGreeting?: string
  personaTrait?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentPersonaSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')

    const updated = await repositories.agents.updatePersona({
      agentId: parsed.agentId,
      ...(parsed.personaNickname !== undefined ? { personaNickname: parsed.personaNickname } : {}),
      ...(parsed.personaGreeting !== undefined ? { personaGreeting: parsed.personaGreeting } : {}),
      ...(parsed.personaTrait !== undefined ? { personaTrait: parsed.personaTrait } : {}),
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.persona',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: {
        changed: [
          parsed.personaNickname !== undefined ? 'personaNickname' : null,
          parsed.personaGreeting !== undefined ? 'personaGreeting' : null,
          parsed.personaTrait !== undefined ? 'personaTrait' : null,
        ].filter(Boolean),
      },
    })

    return ok({
      personaNickname: updated.personaNickname,
      personaGreeting: updated.personaGreeting,
      personaTrait: updated.personaTrait,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent persona')
  }
}

export async function updateAgentAvatar(input: { agentId: string; avatarUrl: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentAvatarSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')

    const nextAvatar = parsed.avatarUrl === '' ? null : parsed.avatarUrl
    await repositories.agents.updateAvatar({ agentId: parsed.agentId, avatarUrl: nextAvatar })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.avatar',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { removed: nextAvatar === null },
    })

    return ok({ avatarUrl: nextAvatar })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent avatar')
  }
}

export async function updateAgentModelConfig(input: {
  agentId: string
  modelConfig: AgentModelConfigInput
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateAgentModelConfigSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const result = await applyAgentModelConfigUpdate({
      ...parsed,
      actorId: user.user.id,
      scope: 'tenant_agent',
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update agent model config')
  }
}

export async function updateAgentSelfEvolutionProfile(input: {
  agentId: string
  profile: {
    scope: Array<'memory' | 'behavior' | 'role'>
    approval_mode: 'human' | 'higher_role' | 'eval_only' | 'auto_after_eval'
    diff_limit?: number
  }
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsedResult = updateAgentSelfEvolutionProfileSchema.safeParse(input)
    if (!parsedResult.success) {
      const idResult = agentIdSchema.safeParse({ id: input.agentId })
      if (idResult.success) {
        await repositories.audit.append({
          actorType: 'human',
          actorId: user.user.id,
          agentVersion: null,
          action: 'training.capability_escalation_denied',
          targetType: 'agent',
          targetId: idResult.data.id,
          modelUsed: null,
          inputRef: 'self_evolution_profile',
          outputRef: 'denied',
          policyDecision: 'capability_escalation_denied',
          metadata: {
            issues: parsedResult.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          } as Prisma.JsonValue,
        })
      }
      return fail('Invalid self-evolution profile')
    }
    const parsed = parsedResult.data
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.updateSelfEvolutionProfile(parsed)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.self_evolution_profile_change',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: parsed.profile.approval_mode,
      policyDecision: 'allowed',
      metadata: parsed.profile,
    })

    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update self-evolution profile')
  }
}

export async function rotateAgentApiKey(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const result = await repositories.agents.rotateApiKey(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.api_key_rotated',
      targetType: 'agent',
      targetId: agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: result.keyId,
      policyDecision: 'allowed',
      metadata: { scopes: result.scopes },
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to rotate agent API key')
  }
}

export async function revokeAgentApiKey(input: { keyId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { keyId } = agentApiKeyIdSchema.parse(input)
    const key = await prisma.agentApiKey.findUnique({
      where: { id: keyId },
      include: { agent: { select: { tenantId: true } } },
    })
    if (!key || key.agent.tenantId !== user.activeTenantId) return fail('Agent API key not found')
    const result = await repositories.agents.revokeApiKey(keyId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.api_key_revoked',
      targetType: 'agent_api_key',
      targetId: keyId,
      modelUsed: null,
      inputRef: result.agentId,
      outputRef: 'revoked',
      policyDecision: 'allowed',
      metadata: { agentId: result.agentId },
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke agent API key')
  }
}

// ── Megosztott viselkedés-profil (§3.4) ──────────────────────────────────────

export async function listBehaviorProfiles() {
  try {
    const user = await requireTenantRole('admin')
    const profiles = await repositories.behaviorProfiles.findMany(user.activeTenantId)
    return ok(profiles)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list behavior profiles')
  }
}

export async function getBehaviorProfile(input: { profileId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { profileId } = behaviorProfileIdSchema.parse(input)
    const [profile, referrers] = await Promise.all([
      repositories.behaviorProfiles.findByIdWithVersions(profileId, user.activeTenantId),
      repositories.behaviorProfiles.listReferrers(profileId, user.activeTenantId),
    ])
    if (!profile) return fail('Behavior profile not found')
    return ok({ profile, referrers })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load behavior profile')
  }
}

export async function createBehaviorProfile(input: { name: string; body: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createBehaviorProfileSchema.parse(input)
    const profile = await repositories.behaviorProfiles.create({
      name: parsed.name,
      body: parsed.body,
      tenantId: user.activeTenantId,
      approvedById: user.user.id,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'behavior_profile.created',
      targetType: 'behavior_profile',
      targetId: profile.id,
      modelUsed: null,
      inputRef: null,
      outputRef: profile.name,
      policyDecision: 'allowed',
      metadata: { name: profile.name },
    })

    return ok(profile)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create behavior profile')
  }
}

export async function updateBehaviorProfile(input: { profileId: string; body: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = updateBehaviorProfileSchema.parse(input)
    // I7: új al-verzió, de a hivatkozó agentek élő viselkedése NEM változik —
    // ahhoz külön `acceptBehaviorProfileUpdate` kell.
    const result = await repositories.behaviorProfiles.update({
      profileId: parsed.profileId,
      body: parsed.body,
      approvedById: user.user.id,
      tenantId: user.activeTenantId,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.behavior_profile_updated',
      targetType: 'behavior_profile',
      targetId: parsed.profileId,
      modelUsed: null,
      inputRef: null,
      outputRef: `v${result.version}`,
      policyDecision: 'allowed',
      metadata: { version: result.version },
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update behavior profile')
  }
}

export async function acceptBehaviorProfileUpdate(input: {
  agentId: string
  profileId: string
  profileVersion: number
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = acceptBehaviorProfileUpdateSchema.parse(input)
    const body = await repositories.behaviorProfiles.getVersionBody(
      parsed.profileId,
      parsed.profileVersion,
      user.activeTenantId,
    )
    if (body === null) return fail('Behavior profile version not found')

    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    if (agent.currentBehaviorProfileId !== parsed.profileId) {
      return fail('Behavior profile is not linked to this agent')
    }

    const result = await repositories.agents.acceptBehaviorProfileUpdate({
      agentId: parsed.agentId,
      profileId: parsed.profileId,
      profileVersion: parsed.profileVersion,
      profileBody: body,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: result.agentVersion,
      action: 'agent.behavior_profile_update_accepted',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: parsed.profileId,
      outputRef: `v${result.agentVersion}`,
      policyDecision: 'allowed',
      metadata: {
        profileId: parsed.profileId,
        behaviorProfileVersion: result.behaviorProfileVersion,
      },
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to accept behavior profile update')
  }
}

export async function setAgentBehaviorProfile(input: {
  agentId: string
  profileId: string | null
  overlay?: string
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = setAgentBehaviorProfileSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')

    let profileVersion: number | null = null
    let profileBody: string | null = null
    let profileName: string | null = null

    if (parsed.profileId) {
      const profile = await repositories.behaviorProfiles.findByIdWithVersions(
        parsed.profileId,
        user.activeTenantId,
      )
      if (!profile) return fail('Behavior profile not found')
      const body = await repositories.behaviorProfiles.getVersionBody(
        parsed.profileId,
        profile.currentVersion,
        user.activeTenantId,
      )
      if (body === null) return fail('Behavior profile version not found')
      profileVersion = profile.currentVersion
      profileBody = body
      profileName = profile.name
    }

    const result = await repositories.agents.setBehaviorProfile({
      agentId: parsed.agentId,
      profileId: parsed.profileId,
      profileVersion,
      profileBody,
      overlay: parsed.overlay,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: result.agentVersion,
      action: 'agent.behavior_profile_set',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: parsed.profileId,
      outputRef: `v${result.agentVersion}`,
      policyDecision: 'allowed',
      metadata: {
        profileId: parsed.profileId,
        profileName,
        behaviorProfileVersion: result.behaviorProfileVersion,
        hasOverlay: (parsed.overlay ?? '').trim().length > 0,
      },
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to set behavior profile')
  }
}

export async function activateAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')
    const result = await repositories.agents.activate(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: result.agentVersion,
      action: 'agent.activated',
      targetType: 'agent',
      targetId: agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: `v${result.agentVersion}`,
      policyDecision: 'allowed',
      metadata: { snapshotVersion: result.agentVersion },
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to activate agent')
  }
}

export async function suspendAgent(input: { agentId: string; reason: string }) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = suspendAgentSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.suspend(parsed.agentId, parsed.reason)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.suspended',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: 'suspended',
      policyDecision: 'allowed',
      metadata: { reason: parsed.reason },
    })

    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to suspend agent')
  }
}

export async function resumeAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const existing = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.resume(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.resumed',
      targetType: 'agent',
      targetId: agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: 'active',
      policyDecision: 'allowed',
      metadata: {},
    })

    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to resume agent')
  }
}

export async function retireAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const existing = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.retire(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'agent.retired',
      targetType: 'agent',
      targetId: agentId,
      modelUsed: null,
      inputRef: null,
      outputRef: 'retired',
      policyDecision: 'allowed',
      metadata: { retiredAt: agent.retiredAt?.toISOString() ?? null },
    })

    return ok(agent)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to retire agent')
  }
}

export async function deleteAgent(input: { id: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { id } = agentIdSchema.parse(input)
    const existing = await repositories.agents.findById(id, user.activeTenantId)
    if (!existing) return fail('Agent not found')
    const deleted = await repositories.agents.delete(id)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'agent.delete',
      targetType: 'agent',
      targetId: deleted.id,
      modelUsed: null,
      inputRef: null,
      outputRef: deleted.name,
      policyDecision: 'allowed',
      metadata: { name: deleted.name },
    })

    return ok(deleted)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete agent')
  }
}

export async function uploadDocument(formData: FormData) {
  try {
    const user = await requireTenantRole('operator')
    const file = formData.get('file')
    const textOverride = formData.get('text')

    let filename = 'upload.txt'
    let extractedText = ''
    let mimeType: string | null = null
    let storageBytes: Buffer
    // KB-v3 §7.3 — formátumfüggő extraction: normalizált markdown +
    // forrás-provenance-os szeletek (PDF oldal / DOCX section / XLSX cella).
    let extraction: StructuredExtraction | null = null

    if (typeof textOverride === 'string' && textOverride.trim()) {
      // A beillesztett szöveg is untrusted és a fájl-úttal azonos plafon alá esik.
      if (Buffer.byteLength(textOverride, 'utf8') > MAX_UPLOAD_BYTES) {
        return fail('A beillesztett szöveg legfeljebb 25 MB lehet')
      }
      extractedText = textOverride
      filename = 'paste.txt'
      mimeType = 'text/plain'
      extraction = extractTextContent(textOverride)
      storageBytes = Buffer.from(textOverride, 'utf8')
    } else if (file instanceof File) {
      // Erőforrás-védelem: a KB-feltöltés is untrusted bájtokat parse-ol
      // (PDF/DOCX/XLSX = zip → dekompressziós bomba kockázat). A ticket-csatolmány
      // úttal AZONOS közös kapu (max 25 MB + típus-allowlist), hogy egy tenant
      // operátora ne tudja a MEGOSZTOTT Node-folyamatot memóriából kiéheztetni (DoS).
      const uploadRejection = uploadRejectionReason(file)
      if (uploadRejection) return fail(uploadRejection)
      filename = safeUploadFilename(file.name)
      mimeType = file.type || null
      storageBytes = Buffer.from(await file.arrayBuffer())
      if (file.type.startsWith('image/')) {
        extractedText = `[image:${file.type}]${storageBytes.toString('base64')}`
      } else {
        extraction = await extractStructured({
          buffer: storageBytes,
          filename,
          mimeType: file.type || null,
        })
        extractedText = extraction.markdown
      }
    } else {
      return fail('No file or text provided')
    }

    const { storageRef, absolutePath } = resolveUploadTarget(filename)
    await mkdir(path.dirname(absolutePath), { recursive: true })
    await writeFile(absolutePath, storageBytes)

    const document = await repositories.documents.create({
      filename,
      storageRef,
      extractedText,
      status: 'uploaded',
      connectorId: null,
      uploadedById: user.user.id,
      mimeType,
      // A szeletek (§4.7 forrás-refekkel) a metadata-ba kerülnek; az OKF-artifact
      // generáláskor innen épül a bundle. Régi doksin nincs → heading-split fallback.
      // A `tenantId` bélyeg a feldolgozási utak tenant-kapujának (l.
      // document-tenant-access) mérvadó forrása — pontos egyezést kényszerít.
      metadata: buildOriginalDocumentMetadata(storageBytes.length, {
        tenantId: user.activeTenantId,
        ...(extraction ? { extraction: toExtractionMetadata(extraction) } : {}),
      }),
    })

    return ok(document)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Upload failed')
  }
}

export async function processDocument(input: { documentId: string; agentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = processDocumentSchema.parse(input)

    // Tenant-határ: a cél-agent ÉS a feldolgozandó dokumentum is a hívó
    // tenantjához kell tartozzon. Enélkül egy operátor idegen tenant agentjével
    // idegen tenant dokumentumát elemeztethette volna le (cross-tenant szivárgás).
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)

    const document = await repositories.documents.findById(parsed.documentId)
    if (!document) return fail('Document not found')
    await assertDocumentReachableFromTenant(document, user.activeTenantId)

    const result = await services.bookkeeper.processDocument(
      parsed.documentId,
      parsed.agentId,
      user.user.id,
    )
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Processing failed')
  }
}

export async function processDocumentForWiki(input: { documentId: string; agentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = processDocumentForWikiSchema.parse(input)

    const document = await repositories.documents.findById(parsed.documentId)
    if (!document) return fail('Document not found')
    // Tenant-határ: a dokumentum a hívó tenantjához kell tartozzon, különben egy
    // idegen tenant feltöltött doksiját is be lehetne kötni a saját KB-be.
    await assertDocumentReachableFromTenant(document, user.activeTenantId)

    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)
    if (agent.role === 'orchestrator') {
      return fail('Orchestrator agents do not use a knowledge base')
    }

    const kbConnector = await ensureAgentKnowledgeBase(agent)
    if (!kbConnector) return fail('Agent has no knowledge_base connector')

    const updated = await repositories.documents.update(parsed.documentId, {
      connectorId: kbConnector.id,
      status: 'processed',
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'tool.call',
      targetType: 'document',
      targetId: parsed.documentId,
      modelUsed: null,
      inputRef: parsed.agentId,
      outputRef: kbConnector.id,
      policyDecision: 'allowed',
      metadata: { filename: document.filename, connectorId: kbConnector.id },
    })

    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to process document for wiki')
  }
}

export async function listDocumentsForAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })

    const agent = await repositories.agents.findById(agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)
    if (agent.role === 'orchestrator') return ok([])

    const kbConnector = await ensureAgentKnowledgeBase(agent)
    if (!kbConnector) return ok([])

    const documents = await repositories.documents.findByConnectorId(kbConnector.id)
    return ok(documents)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list documents')
  }
}

// ── KB-dokumentum jóváhagyási kapu (§9.3 / §4.6) ───────────────────────────

/** Feltöltött dokumentumhoz jóváhagyási (tanítási) ticketet nyit — még nem kereshető. */
export async function requestKbDocument(input: {
  documentId: string
  agentId: string
  processingMode?: 'raw_text_only' | 'okf'
}) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = requestKbDocumentSchema.parse(input)
    const ticket = await services.knowledgeBase.requestDocument({
      agentId: parsed.agentId,
      documentId: parsed.documentId,
      createdById: user.user.id,
      actorTenantId: user.activeTenantId,
      processingMode: parsed.processingMode,
    })
    return ok(ticket)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to request KB document')
  }
}

/** Jóváhagyás után a dokumentum bekerül a KB-be és kereshetővé válik. */
export async function approveKbDocument(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = kbTicketSchema.parse(input)
    const document = await services.knowledgeBase.approveDocument({
      ticketId: parsed.ticketId,
      approverId: user.user.id,
      approverRole: user.activeTenantRole,
      actorTenantId: user.activeTenantId,
    })
    return ok(document)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve KB document')
  }
}

export async function rejectKbDocument(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = kbTicketSchema.parse(input)
    const result = await services.knowledgeBase.rejectDocument({
      ticketId: parsed.ticketId,
      approverId: user.user.id,
      approverRole: user.activeTenantRole,
      actorTenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to reject KB document')
  }
}

export async function listKbDocumentRequests(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const pending = await services.knowledgeBase.listPendingDocuments(agentId, user.activeTenantId)
    return ok(pending)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list KB requests')
  }
}

/**
 * §12.2 hárompaneles review adatai: forrás extracted text + OKF file-tree
 * preview + friss §7.6 validáció + a jóváhagyási ticket azonosítója.
 */
export async function getKbArtifactReview(input: { agentId: string; documentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = kbArtifactReviewSchema.parse(input)
    const review = await services.knowledgeBase.getArtifactReview({
      agentId: parsed.agentId,
      documentId: parsed.documentId,
      actorTenantId: user.activeTenantId,
    })
    if (!review) return fail('KB dokumentum nem található')
    return ok(review)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load KB review')
  }
}

// ── KB megosztás (§4.9.1 / §4.12: megosztható, many-to-many erőforrás) ──────

/** Az agent KB connectorának megosztása egy másik (worker) agenttel. */
export async function shareKnowledgeBaseWithAgent(input: { agentId: string; targetAgentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = shareKnowledgeBaseSchema.parse(input)
    if (parsed.agentId === parsed.targetAgentId) {
      return fail('Source and target agents are the same')
    }

    const source = await repositories.agents.findById(parsed.agentId)
    if (!source) return fail('Source agent not found')
    assertAgentTenantReachable(source, user.activeTenantId)
    if (source.role === 'orchestrator') {
      return fail('Orchestrator agents do not use a knowledge base')
    }

    const target = await repositories.agents.findById(parsed.targetAgentId)
    if (!target) return fail('Target agent not found')
    assertAgentTenantReachable(target, user.activeTenantId)
    if (target.role === 'orchestrator') {
      return fail('Orchestrator agents do not use a knowledge base')
    }

    const kbConnector = await ensureAgentKnowledgeBase(source)
    if (!kbConnector) return fail('Source agent has no knowledge_base connector')

    await prisma.agentConnector.upsert({
      where: {
        agentId_connectorId: { agentId: parsed.targetAgentId, connectorId: kbConnector.id },
      },
      create: { agentId: parsed.targetAgentId, connectorId: kbConnector.id, accessMode: 'read' },
      update: {},
    })
    await prisma.capability.upsert({
      where: { agentId_toolName: { agentId: parsed.targetAgentId, toolName: 'kb_search' } },
      create: { agentId: parsed.targetAgentId, toolName: 'kb_search', allowed: true },
      update: { allowed: true },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'kb.shared',
      targetType: 'connector',
      targetId: kbConnector.id,
      modelUsed: null,
      inputRef: parsed.agentId,
      outputRef: parsed.targetAgentId,
      policyDecision: 'kb_shared',
      metadata: null,
    })

    return ok({ shared: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to share knowledge base')
  }
}

/** Megosztás visszavonása: a célagent elveszti a forrás KB-jéhez való hozzáférést. */
export async function unshareKnowledgeBaseFromAgent(input: {
  agentId: string
  targetAgentId: string
}) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = shareKnowledgeBaseSchema.parse(input)
    if (parsed.agentId === parsed.targetAgentId) {
      return fail('Cannot revoke the owner agent from its own knowledge base')
    }

    const source = await repositories.agents.findById(parsed.agentId)
    if (!source) return fail('Source agent not found')
    assertAgentTenantReachable(source, user.activeTenantId)
    if (source.role === 'orchestrator') {
      return fail('Orchestrator agents do not use a knowledge base')
    }

    const kbConnector = await ensureAgentKnowledgeBase(source)
    if (!kbConnector) return fail('Source agent has no knowledge_base connector')

    const link = await prisma.agentConnector.findUnique({
      where: {
        agentId_connectorId: { agentId: parsed.targetAgentId, connectorId: kbConnector.id },
      },
    })
    if (!link) return fail('Target agent does not have access to this knowledge base')

    await prisma.agentConnector.delete({
      where: {
        agentId_connectorId: { agentId: parsed.targetAgentId, connectorId: kbConnector.id },
      },
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'kb.unshared',
      targetType: 'connector',
      targetId: kbConnector.id,
      modelUsed: null,
      inputRef: parsed.agentId,
      outputRef: parsed.targetAgentId,
      policyDecision: 'kb_unshared',
      metadata: null,
    })

    return ok({ unshared: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to unshare knowledge base')
  }
}

/** A KB connector megosztási állapota: mely más agentek használják (a tulajdonos nélkül). */
export async function getKnowledgeBaseSharing(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })

    const agent = await repositories.agents.findById(agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)
    if (agent.role === 'orchestrator') {
      return ok({ connectorId: null, sharedWithAgents: [] })
    }

    const kbConnector = await ensureAgentKnowledgeBase(agent)
    if (!kbConnector) return ok({ connectorId: null, sharedWithAgents: [] })

    const links = await prisma.agentConnector.findMany({
      where: { connectorId: kbConnector.id },
      include: { agent: { select: { id: true, name: true } } },
      orderBy: { agent: { name: 'asc' } },
    })
    return ok({
      connectorId: kbConnector.id,
      sharedWithAgents: links
        .filter((l) => l.agent.id !== agentId)
        .map((l) => ({ id: l.agent.id, name: l.agent.name })),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get KB sharing')
  }
}

/** Jóváhagyott KB-dokumentum törlése az agent saját tudásbázisából. */
export async function deleteKbDocument(input: { agentId: string; documentId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = deleteKbDocumentSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)
    if (agent.role === 'orchestrator') {
      return fail('Orchestrator agents do not use a knowledge base')
    }

    const kbConnector = await ensureAgentKnowledgeBase(agent)
    if (!kbConnector) return fail('Agent has no knowledge_base connector')

    const document = await repositories.documents.findById(parsed.documentId)
    if (!document) return fail('Document not found')
    if (document.connectorId !== kbConnector.id) {
      return fail('Document does not belong to this agent knowledge base')
    }

    const absolutePath = path.resolve(process.cwd(), document.storageRef)
    const uploadRoot = path.resolve(process.cwd(), 'uploads')
    const uploadRootPrefix = uploadRoot.endsWith(path.sep) ? uploadRoot : `${uploadRoot}${path.sep}`
    if (absolutePath.startsWith(uploadRootPrefix)) {
      await unlink(absolutePath).catch(() => undefined)
    }

    await repositories.documents.delete(parsed.documentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: null,
      action: 'kb.document.deleted',
      targetType: 'document',
      targetId: parsed.documentId,
      modelUsed: null,
      inputRef: parsed.agentId,
      outputRef: kbConnector.id,
      policyDecision: 'kb_document_deleted',
      metadata: { filename: document.filename },
    })

    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete KB document')
  }
}

export async function askWiki(input: { agentId: string; question: string; conversationId?: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = askWikiSchema.parse(input)
    const result = await services.wiki.askWiki({
      ...parsed,
      createdById: user.user.id,
      tenantId: user.activeTenantId,
    })

    return ok({
      conversationId: result.conversationId,
      messageId: result.messageId,
      answer: {
        answer: result.answer.answer,
        sources: result.answer.sources,
        rationale: result.answer.rationale,
        confidence: result.answer.confidence,
      },
      pending: false,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Wiki question failed')
  }
}

export async function listReportTemplatesAction() {
  try {
    await requireTenantRole('viewer')
    return ok(
      listReportTemplates().map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
      })),
    )
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list report templates')
  }
}

export async function generateReport(input: { agentId: string; templateId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = generateReportSchema.parse(input)
    const template = getReportTemplate(parsed.templateId)
    if (!template) return fail('Unknown report template')

    const ticket = await services.wiki.generateReport({
      agentId: parsed.agentId,
      template,
      createdById: user.user.id,
      tenantId: user.activeTenantId,
    })

    return ok({ ticketId: ticket.id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to generate report')
  }
}

export async function promoteToTicket(input: { conversationId: string; reason?: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = promoteToTicketSchema.parse(input)
    const { messages } = await services.conversations.getConversation(
      parsed.conversationId,
      user.activeTenantId,
    )

    const lastAgent = [...messages].reverse().find((m) => m.role === 'agent' && m.content)
    if (!lastAgent?.content) return fail('No agent answer to promote')

    let answerPayload: Record<string, unknown>
    try {
      answerPayload = JSON.parse(lastAgent.content) as Record<string, unknown>
    } catch {
      return fail('Invalid agent message payload')
    }

    const ticket = await services.conversations.promoteToTicket({
      conversationId: parsed.conversationId,
      createdById: user.user.id,
      tenantId: user.activeTenantId,
      reason: parsed.reason ?? 'approval',
      answerPayload,
      agentMessageId: lastAgent.id,
    })

    return ok({ ticketId: ticket.id, ticket })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Promote to ticket failed')
  }
}

export async function archiveConversation(input: { conversationId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { conversationId } = conversationIdSchema.parse(input)
    const archived = await services.conversations.archiveConversation({
      conversationId,
      actorId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok({ conversationId: archived.id, status: archived.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to archive conversation')
  }
}

export async function promoteConversationWithAi(input: { conversationId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { conversationId } = conversationIdSchema.parse(input)
    const { conversation, messages } = await services.conversations.getConversation(conversationId, user.activeTenantId)
    const agentRow = await repositories.agents.findById(conversation.agentId, user.activeTenantId)
    if (!agentRow) return fail('Agent not found')

    // #142 — a ticket-generáló prompt is FELELŐS-jelölteket kínál a modellnek, ezért
    // `address` alapján szűr: különben olyan agentet javasolna, akihez a ticket
    // felvétele utána elbukna.
    const promptSubject = tenantUserSubject(user)
    const [agents, users] = await Promise.all([
      promptSubject
        ? services.agentAccess.listAccessibleAgents(promptSubject, 'address', {
            subjectIsTenantAdmin: isTenantAdmin(user),
            activeOnly: true,
          })
        : Promise.resolve([]),
      prisma.user.findMany({
        where: { tenantId: user.activeTenantId, status: 'active' },
        select: { id: true, name: true, role: true, jobDescription: true },
        orderBy: { name: 'asc' },
      }),
    ])

    const prompt = buildTicketGenerationPrompt({
      transcript: formatConversationForTicketPrompt(messages),
      agents: agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({ id: agent.id, name: agent.name, role: agent.role })),
      users,
    })
    const modelConfig = agentRow.modelConfig as {
      provider: string
      model: string
      temperature?: number
      maxTokens?: number
    }
    const response = await services.gateway.call({
      agentId: conversation.agentId,
      agentVersion: agentRow.currentVersion,
      tenantId: user.activeTenantId,
      conversationId,
      messages: [
        {
          role: 'system',
          content: 'Tapasztalt projektkoordinátor vagy. Beszélgetésekből ticketet vagy tisztázó kérdést készítesz.',
        },
        { role: 'user', content: prompt },
      ],
      modelConfig: {
        ...modelConfig,
        temperature: 0.1,
      },
    })
    const parsed = extractJsonObject(response.content)
    if (!parsed || typeof parsed.status !== 'string') {
      return fail('Az AI ticket-előkészítése nem adott értelmezhető választ.')
    }

    if (parsed.status === 'needs_clarification') {
      const question =
        typeof parsed.question === 'string' && parsed.question.trim()
          ? parsed.question.trim()
          : 'Mielőtt ticketet nyitok, pontosítsd kérlek a feladatot vagy a felelőst.'
      const appended = await services.conversations.appendMessage({
        conversationId,
        tenantId: user.activeTenantId,
        role: 'agent',
        content: question,
        actingUserId: user.user.id,
        agentVersion: agentRow.currentVersion,
        model: modelConfig.model,
        actorType: 'agent',
        actorId: conversation.agentId,
      })
      return ok({ outcome: 'needs_clarification', question, messageId: appended.id })
    }

    if (parsed.status !== 'create_ticket') {
      return fail('Az AI ticket-előkészítése ismeretlen státuszt adott vissza.')
    }

    const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : ''
    const assigneeType = parsed.assigneeType === 'agent' ? 'agent' : parsed.assigneeType === 'human' ? 'human' : null
    const assigneeId = typeof parsed.assigneeId === 'string' ? parsed.assigneeId : ''
    if (!title || !description || !assigneeType || !assigneeId) {
      return fail('Az AI ticket-javaslata hiányos volt.')
    }

    const boardTicketResult = await createBoardTicket({
      title,
      description,
      assigneeType,
      assigneeId,
    })
    if (!boardTicketResult.success) return boardTicketResult

    const ticket = boardTicketResult.data.ticket
    const ticketLink = `/control-plane/tickets/${ticket.id}`
    const responseText =
      `Létrehoztam a ticketet: [${ticket.title}](${ticketLink}).` +
      (typeof parsed.rationale === 'string' && parsed.rationale.trim()
        ? ` Rövid indoklás: ${parsed.rationale.trim()}`
        : '')
    const appended = await services.conversations.appendMessage({
      conversationId,
      tenantId: user.activeTenantId,
      role: 'agent',
      content: responseText,
      actingUserId: user.user.id,
      agentVersion: agentRow.currentVersion,
      model: modelConfig.model,
      ticketRefId: ticket.id,
      actorType: 'agent',
      actorId: conversation.agentId,
    })

    return ok({
      outcome: 'ticket_created',
      ticketId: ticket.id,
      ticket,
      messageId: appended.id,
      warning: 'warning' in boardTicketResult.data ? boardTicketResult.data.warning : undefined,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'AI promote failed')
  }
}

export async function getConversation(input: { conversationId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { conversationId } = conversationIdSchema.parse(input)
    const data = await services.conversations.getConversation(conversationId, user.activeTenantId)
    return ok(data)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get conversation')
  }
}


export async function createAgentTaskTicket(input: {
  agentId: string
  content: string
  conversationId?: string
  attachmentDocumentIds?: string[]
  executeAfter?: string
  authorizeRunAs?: boolean
}) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = createAgentTaskTicketSchema.parse(input)
    const executeAfter = parsed.executeAfter ? new Date(parsed.executeAfter) : null
    const ticket = await services.agentChat.createTaskTicket({
      agentId: parsed.agentId,
      content: parsed.content,
      conversationId: parsed.conversationId,
      attachmentDocumentIds: parsed.attachmentDocumentIds,
      executeAfter,
      authorizeRunAs: parsed.authorizeRunAs,
      createdById: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok({ ticketId: ticket.id, ticket })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Task ticket creation failed')
  }
}

export async function createScheduledAgentTask(input: {
  agentId: string
  title: string
  content: string
  conversationId?: string
  attachmentDocumentIds?: string[]
  nextRunAt: string
  recurrence?: 'none' | 'hourly' | 'daily' | 'weekly' | 'monthly'
  intervalHours?: number
  maxRuns?: number | null
  authorizeRunAs?: boolean
}) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = createScheduledAgentTaskSchema.parse(input)
    // #142 — ütemezett feladat is agent-megszólítás: `address` kell, különben
    // tiltott agenthez materializálódó ticket kerülhet a boardra.
    const subject = tenantUserSubject(user)
    if (!subject) return fail('Agent not found')
    try {
      await services.agentAccess.assertCanAccessAgent({
        subject,
        targetAgentId: parsed.agentId,
        verb: 'address',
        subjectIsTenantAdmin: isTenantAdmin(user),
        audit: {
          channel: 'ticket',
          initiatingUserId: user.user.id,
        },
      })
    } catch (error) {
      if (isAgentAccessError(error)) return fail(error.message)
      throw error
    }
    const attachmentIds = [...new Set(parsed.attachmentDocumentIds ?? [])]
    if (attachmentIds.length > 0) {
      const documents = await repositories.documents.findByIds(attachmentIds)
      await assertDocumentsReachableFromTenant(documents, attachmentIds, user.activeTenantId)
    }
    const nextRunAt = new Date(parsed.nextRunAt)
    const recurrence = parsed.recurrence ?? 'none'
    const isRecurring = recurrence !== 'none'
    const scheduleStamp = buildTicketScheduleStamp({
      kind: isRecurring ? 'recurring' : 'once',
      runAt: nextRunAt,
      recurrence,
      intervalHours: parsed.intervalHours,
      maxRuns: parsed.maxRuns,
      role: isRecurring ? 'series' : undefined,
    })
    const ticketPayload = stampTicketSchedule(
      {
        question: parsed.content,
        task: parsed.content,
        source: 'scheduled_task',
        conversationId: parsed.conversationId ?? null,
        attachmentDocumentIds: attachmentIds,
      },
      scheduleStamp,
      isRecurring ? { role: 'series' } : undefined,
    )
    const ticket = await repositories.tickets.create({
      tenantId: user.activeTenantId,
      type: 'interaction',
      title: parsed.title,
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: parsed.agentId,
      agentId: parsed.agentId,
      payload: ticketPayload as Prisma.JsonValue,
      sourceDocumentId: attachmentIds[0] ?? null,
      conversationId: parsed.conversationId ?? null,
      executeAfter: nextRunAt,
      dueBy: null,
      createdById: user.user.id,
    })
    const scheduledTask = await services.scheduledTasks.createAgentTask({
      agentId: parsed.agentId,
      title: parsed.title,
      content: parsed.content,
      conversationId: parsed.conversationId,
      attachmentDocumentIds: attachmentIds,
      nextRunAt,
      recurrence: parsed.recurrence,
      intervalHours: parsed.intervalHours,
      maxRuns: parsed.maxRuns,
      authorizeRunAs: parsed.authorizeRunAs,
      createdById: user.user.id,
      tenantId: user.activeTenantId,
      materializedTicketId: isRecurring ? null : ticket.id,
      payload: isRecurring ? { seriesTicketId: ticket.id } : undefined,
    })
    await repositories.tickets.update(ticket.id, {
      payload: stampTicketSchedule(
        ticketPayload,
        scheduleStamp,
        {
          scheduledTaskId: scheduledTask.id,
          ...(isRecurring ? { role: 'series' as const } : {}),
        },
      ) as Prisma.JsonObject,
    })
    return ok({
      scheduledTaskId: scheduledTask.id,
      scheduledTask,
      ticketId: ticket.id,
      ticket,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Scheduled task creation failed')
  }
}

/**
 * Ticket → Megbeszélés (#219): új conversation a tickethez kötve, az agent chat
 * panelben megnyitható. Nem az origin `ticket.conversationId`; ismételt hívás
 * mindig új conversationt hoz létre.
 */
export async function createDiscussionFromTicket(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { ticketId } = z.object({ ticketId: z.string().uuid() }).parse(input)
    const ticket = await repositories.tickets.findById(ticketId)
    if (!ticket) return fail('Ticket not found')
    assertTicketTenantScope(ticket, user.activeTenantId)

    const agentId =
      ticket.agentId ??
      (ticket.assigneeType === 'agent' && ticket.assigneeId ? ticket.assigneeId : null)
    if (!agentId) return fail('Ehhez a feladathoz nincs megszólítható AI munkatárs')

    const subject = tenantUserSubject(user)
    if (!subject) return fail('Agent not found')
    try {
      await services.agentAccess.assertCanAccessAgent({
        subject,
        targetAgentId: agentId,
        verb: 'address',
        subjectIsTenantAdmin: isTenantAdmin(user),
        audit: {
          channel: 'chat',
          ticketId: ticket.id,
          initiatingUserId: user.user.id,
        },
      })
    } catch (error) {
      if (isAgentAccessError(error)) return fail(error.message)
      throw error
    }

    const agent = await repositories.agents.findById(agentId)
    if (!agent) return fail('Agent not found')

    const title = `Megbeszélés: ${ticket.title}`.slice(0, 80)
    const conversation = await services.conversations.createConversation({
      agentId,
      createdById: user.user.id,
      tenantId: user.activeTenantId,
      title,
      continuedFromTicketId: ticket.id,
    })

    return ok({
      conversationId: conversation.id,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      agent: {
        id: agent.id,
        name: agent.name,
        status: agent.status,
        avatarUrl: agent.avatarUrl,
        personaNickname: agent.personaNickname,
        personaGreeting: agent.personaGreeting,
        personaTrait: agent.personaTrait,
      },
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to start discussion from ticket')
  }
}

export async function loadAgentChatMessages(input: { conversationId: string; agentId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { conversationId, agentId } = loadAgentChatSchema.parse(input)
    const { conversation, messages } = await services.conversations.getConversation(
      conversationId,
      user.activeTenantId,
    )
    if (conversation.agentId !== agentId) return fail('Conversation agent mismatch')
    const privacyViews = await services.agentChat.getConversationMessages(
      conversationId,
      user.activeTenantId,
      agentId,
      user.user.id,
    )
    const privacyViewById = new Map(privacyViews.map((view) => [view.id, view]))

    const views = []
    for (const message of messages) {
      const contentDeletedAt = message.contentDeletedAt
        ? message.contentDeletedAt.toISOString()
        : null
      const parsed = message.content && !message.contentDeletedAt
        ? parseStoredChatMessage(message.content)
        : { text: '', attachmentIds: [] }
      const attachments = []

      for (const documentId of parsed.attachmentIds) {
        const doc = await prisma.document.findUnique({
          where: { id: documentId },
          select: { id: true, filename: true, extractedText: true },
        })
        if (!doc) continue
        const kind: 'image' | 'text' = imageFilenamePattern.test(doc.filename) || doc.extractedText?.startsWith('[image:')
          ? 'image'
          : 'text'
        const imageMatch = kind === 'image' && doc.extractedText
          ? doc.extractedText.match(imageDataMarkerPattern)
          : null
        attachments.push({
          documentId: doc.id,
          filename: doc.filename,
          kind,
          previewDataUrl: imageMatch?.[2] && imageMatch[3]
            ? `data:${imageMatch[2]};base64,${imageMatch[3]}`
            : null,
        })
      }

      views.push({
        id: message.id,
        role: message.role,
        text: privacyViewById.get(message.id)?.text ?? parsed.text,
        privacyMarkers: privacyViewById.get(message.id)?.privacyMarkers ?? [],
        attachments,
        createdAt: message.createdAt.toISOString(),
        contentDeletedAt,
        ticketRefId: message.ticketRefId,
      })
    }

    // issue #97 — a következmény-kapu függő jóváhagyásai. A stream-esemény
    // efemer: enélkül a „Jóváhagyom" gomb a forduló végén (a chat ilyenkor a DB
    // végállapotát tölti újra), lapfrissítéskor és visszacsatlakozáskor eltűnne,
    // a művelet pedig némán ott ülne lejáratig.
    const pendingConsequenceApprovals = await services.consequenceApproval.listOpenForConversation(
      conversationId,
      { id: user.user.id, tenantId: user.activeTenantId, role: user.activeTenantRole },
    )
    const pendingConnectorGrants = await services.connectorGrants.listOpenGrantNeeds({
      userId: user.user.id,
      tenantId: user.activeTenantId,
      conversationId,
    })

    let continuedFromTicket: { id: string; title: string } | null = null
    let ticketDiscussionHistory: Array<{
      id: string
      role: 'user' | 'agent' | 'system'
      text: string
      authorLabel: string
      createdAt: string
    }> = []
    if (conversation.continuedFromTicketId) {
      const sourceTicket = await repositories.tickets.findById(conversation.continuedFromTicketId)
      if (sourceTicket && sourceTicket.tenantId === user.activeTenantId) {
        continuedFromTicket = { id: sourceTicket.id, title: sourceTicket.title }
        const payload =
          sourceTicket.payload &&
          typeof sourceTicket.payload === 'object' &&
          !Array.isArray(sourceTicket.payload)
            ? (sourceTicket.payload as Record<string, unknown>)
            : {}
        const originalTask = readTicketPromptText(payload) || sourceTicket.title
        const comments = await repositories.tickets.listComments(sourceTicket.id)
        ticketDiscussionHistory = buildTicketDiscussionHistory({
          comments,
          originalTask,
          ticketCreatedAt: sourceTicket.createdAt,
        })
      }
    }

    return ok({
      conversationId,
      conversation: {
        id: conversation.id,
        status: conversation.status,
        title: conversation.title,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        continuedFromTicketId: conversation.continuedFromTicketId,
      },
      continuedFromTicket,
      ticketDiscussionHistory,
      messages: views,
      pendingConsequenceApprovals,
      pendingConnectorGrants,
      isAdmin: hasMinimumRole(user.activeTenantRole, 'admin'),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load chat messages')
  }
}

export async function listAgentChatSessions(input: {
  agentId: string
  status?: 'active' | 'archived' | 'all'
  limit?: number
  offset?: number
}) {
  try {
    const user = await requireTenantRole('viewer')
    const { agentId, status = 'active', limit = 10, offset = 0 } = listAgentChatSessionsSchema.parse(input)
    const take = Math.min(limit, 50)
    const rows = await prisma.conversation.findMany({
      where: {
        agentId,
        createdById: user.user.id,
        tenantId: user.activeTenantId,
        ...(status === 'all' ? {} : { status }),
      },
      orderBy: { lastMessageAt: 'desc' },
      skip: offset,
      take: take + 1,
      include: {
        messages: {
          where: { role: 'user', contentDeletedAt: null },
          orderBy: { seq: 'asc' },
          take: 1,
          select: { contentRef: true },
        },
      },
    })
    const hasMore = rows.length > take
    const pageRows = hasMore ? rows.slice(0, take) : rows
    const sessions = pageRows.map(({ messages, ...conversation }) => {
      const raw = decodeInlineConversationContent(messages[0]?.contentRef)
      const preview = raw ? decodeConversationPreview(raw).slice(0, 120) : null
      return {
        id: conversation.id,
        title: conversation.title?.trim() || preview?.slice(0, 60) || 'Beszélgetés',
        preview,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
        createdAt: conversation.createdAt.toISOString(),
        status: conversation.status,
      }
    })
    return ok({
      sessions,
      hasMore,
      nextOffset: offset + sessions.length,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list chat sessions')
  }
}

export async function deleteMessageContent(input: { messageId: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { messageId } = messageIdSchema.parse(input)
    const updated = await services.conversations.deleteMessageContent({
      messageId,
      actorId: user.user.id,
      tenantId: user.activeTenantId,
      reason: 'ui-message-delete',
    })
    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete message content')
  }
}

export async function createSandboxReport(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = createSandboxReportSchema.parse(input)
    const app = await services.sandboxApps.createOrVersionWikiReport(parsed.ticketId, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(app)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create sandbox report')
  }
}

export async function getSandboxReportForTicket(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = createSandboxReportSchema.parse(input)
    const app = await services.sandboxApps.getLatestForTicket(parsed.ticketId, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(app)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get sandbox report')
  }
}

// ── App Registry általános API (Feature-spec — App Registry §4) ─────────────

/** A SandboxAppError kódját a hibaüzenet elé fűzi, hogy az UI/teszt megkülönböztesse. */
function sandboxAppFail(e: unknown, fallback: string) {
  if (e instanceof SandboxAppError) return fail(`${e.code}: ${e.message}`)
  return fail(e instanceof Error ? e.message : fallback)
}

export async function createSandboxApp(input: z.infer<typeof createSandboxAppSchema>) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = createSandboxAppSchema.parse(input)
    const result = await services.sandboxApps.createSandboxApp(parsed, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to create sandbox app')
  }
}

export async function upsertSandboxAppVersion(input: z.infer<typeof upsertSandboxAppVersionSchema>) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = upsertSandboxAppVersionSchema.parse(input)
    const result = await services.sandboxApps.upsertSandboxAppVersion(parsed, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to create sandbox app version')
  }
}

export async function activateSandboxAppVersion(
  input: z.infer<typeof activateSandboxAppVersionSchema>,
) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = activateSandboxAppVersionSchema.parse(input)
    const result = await services.sandboxApps.activateSandboxAppVersion(parsed, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to activate sandbox app version')
  }
}

export async function listSandboxApps(input: z.infer<typeof listSandboxAppsSchema>) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = listSandboxAppsSchema.parse(input)
    const result = await services.sandboxApps.listSandboxApps(parsed, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    const appsWithNames = await Promise.all(
      result.apps.map(async (app) => {
        const createdByAgentId = (app as { createdByAgentId?: string }).createdByAgentId
        const createdByUserId = (app as { createdByUserId?: string }).createdByUserId
        const createdByType = (app as { createdByType?: string }).createdByType
        if (createdByAgentId) {
          const agent = await repositories.agents.findById(createdByAgentId, user.activeTenantId)
          return { ...app, createdByName: agent?.name ?? 'Ismeretlen agent' }
        }
        if (createdByUserId) {
          const creator = await repositories.users.findById(createdByUserId)
          return { ...app, createdByName: creator?.name ?? 'Ismeretlen felhasználó' }
        }
        return {
          ...app,
          createdByName: createdByType === 'agent' ? 'Ismeretlen agent' : 'Ismeretlen felhasználó',
        }
      }),
    )
    const response = { ...result, apps: appsWithNames }
    return ok(response)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to list sandbox apps')
  }
}

export async function getSandboxApp(input: z.infer<typeof getSandboxAppSchema>) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = getSandboxAppSchema.parse(input)
    const result = await services.sandboxApps.getSandboxApp(parsed, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to get sandbox app')
  }
}

export async function getSandboxAppRegistryMetrics() {
  try {
    const user = await requireTenantRole('viewer')
    const result = await services.sandboxApps.getRegistryMetrics({
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to load app registry metrics')
  }
}

export async function getSandboxAppPreviewUrl(input: z.infer<typeof sandboxAppPreviewUrlSchema>) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = sandboxAppPreviewUrlSchema.parse(input)
    const result = await services.sandboxApps.getSandboxAppPreviewUrl(parsed, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to create sandbox app preview URL')
  }
}

export async function createTrainingTicket(input: {
  agentId: string
  proposedContent: string
  source: string
}) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = createTrainingSchema.parse(input)
    const ticket = await services.training.createTrainingTicket({
      ...parsed,
      actor: trainingActor(user),
    })
    return ok(ticket)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create training ticket')
  }
}

export async function proposeMemoryItemChange(
  input: z.infer<typeof proposeMemoryItemChangeSchema>,
) {
  try {
    const parsed = proposeMemoryItemChangeSchema.parse(input)
    const user = await requireTenantRole('operator')
    const change =
      parsed.operation === 'add'
        ? { operation: 'add' as const, text: parsed.text }
        : parsed.operation === 'update'
          ? {
              operation: 'update' as const,
              itemIndex: parsed.itemIndex,
              text: parsed.text,
            }
          : { operation: 'remove' as const, itemIndex: parsed.itemIndex }

    const ticket = await services.training.proposeMemoryItemChange({
      agentId: parsed.agentId,
      change,
      actor: trainingActor(user),
    })

    if (parsed.apply && hasMinimumRole(user.activeTenantRole, 'approver')) {
      const approved = await services.training.approveTraining(ticket.id, trainingActor(user))
      return ok({ ticket, approved })
    }

    return ok({ ticket, approved: null })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to propose memory item change')
  }
}

export async function listTrainingMemoryVersions(input: {
  agentId: string
  limit?: number
}) {
  try {
    const user = await requireTenantRole('viewer')
    const parsed = listTrainingMemoryVersionsSchema.parse(input)
    const data = await services.training.listMemoryVersionsForTraining(
      parsed.agentId,
      trainingActor(user),
      parsed.limit,
    )
    return ok(data)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list memory versions')
  }
}

export async function approveTraining(input: { ticketId: string; overrideEval?: boolean }) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = approveTrainingSchema.parse(input)
    const result = await services.training.approveTraining(parsed.ticketId, trainingActor(user), {
      overrideEval: parsed.overrideEval,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve training')
  }
}

// ── Tartós agent-memória — WP-6 (agent-memory-persistent-cross-conversation-spec.md
// §6.2/§6.3): a chat-kártya "Jóváhagyom"/"Módosítom"/"Ticketbe küldöm"/"Elvetem"
// gombjai. A tényleges inline-vs-ticket elágazás a MemoryApprovalService-ben dől
// el (RBAC + agent self_evolution_profile alapján) — az action csak a baseline
// "legalább operator" beléptető kaput adja, minden más a service felelőssége. ──

export async function approveMemoryCandidate(input: { candidateId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = memoryCandidateIdSchema.parse(input)
    const result = await services.memoryApproval.approve(parsed.candidateId, {
      id: user.user.id,
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    })
    return result.ok ? ok(result) : fail(result.reason)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve memory candidate')
  }
}

export async function rejectMemoryCandidate(input: { candidateId: string; reason?: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = rejectMemoryCandidateSchema.parse(input)
    const result = await services.memoryApproval.reject(
      parsed.candidateId,
      { id: user.user.id, tenantId: user.activeTenantId, role: user.activeTenantRole },
      parsed.reason,
    )
    return result.ok ? ok(result) : fail(result.reason)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to reject memory candidate')
  }
}

/** issue #97 — következmény-kapu: mellékhatásos tool jóváhagyása (szerveroldali invoke). */
export async function approveConsequenceApproval(input: { approvalId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = consequenceApprovalIdSchema.parse(input)
    const actor = {
      id: user.user.id,
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    }
    const existing = await repositories.consequenceApprovals.findById(parsed.approvalId)
    // Task-only ticket: mid-run approve race a loop végével — csak awaiting_human-nél.
    if (existing?.ticketId && !existing.conversationId) {
      const ticket = await repositories.tickets.findById(existing.ticketId)
      if (ticket && ticket.state !== 'awaiting_human') {
        return fail(
          'A jóváhagyás csak akkor indítható, amikor a ticket emberi jóváhagyásra vár.',
        )
      }
    }
    const result = await services.consequenceApproval.approve(parsed.approvalId, actor)
    if (!result.ok) return fail(result.reason)

    const row = existing ?? (await repositories.consequenceApprovals.findById(parsed.approvalId))
    const resume = row?.ticketId
      ? await resumeTicketAfterConsequenceApprovals(row.ticketId, row.conversationId, {
          id: user.user.id,
          name: user.user.name,
          tenantId: user.activeTenantId,
          role: user.activeTenantRole,
        })
      : { ticketResumed: false as const }

    return ok({
      ...result,
      ticketResumed: resume.ticketResumed,
      ...('warning' in resume && resume.warning ? { warning: resume.warning } : {}),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve consequence action')
  }
}

/**
 * Task-only ticket folytatása a következmény-kapu ALATT lefutott műveletek után.
 *
 * Ha nincs több függő kártya, handback + dispatch — különben a Föld PATCH lefut,
 * de az agent soha nem folytatja a terv többi sorát / a záró összefoglalót
 * (cade35e7: ticket-szintű „Jóváhagyás" ≠ API invoke). A visszatérés a hívó két
 * útján (egyedi és batch jóváhagyás) KÖZÖS, hogy a folytatás feltétele egy
 * helyen éljen.
 */
async function resumeTicketAfterConsequenceApprovals(
  ticketId: string,
  conversationId: string | null,
  actor: { id: string; name: string | null; tenantId: string; role: UserRole },
): Promise<{ ticketResumed: boolean; warning?: string }> {
  if (conversationId) return { ticketResumed: false }
  const open = await services.consequenceApproval.listOpenForTicket(ticketId, {
    id: actor.id,
    tenantId: actor.tenantId,
    role: actor.role,
  })
  if (open.length > 0) return { ticketResumed: false }

  const ticket = await repositories.tickets.findById(ticketId)
  if (!ticket?.agentId || ticket.state !== 'awaiting_human') return { ticketResumed: false }

  const prevPayload =
    ticket.payload && typeof ticket.payload === 'object' && !Array.isArray(ticket.payload)
      ? { ...(ticket.payload as Record<string, unknown>) }
      : {}
  delete prevPayload.awaitingConsequenceApproval
  delete prevPayload.consequenceApprovalIds
  await repositories.tickets.update(ticket.id, {
    payload: {
      ...prevPayload,
      consequenceApprovalsCompletedAt: new Date().toISOString(),
    } as Prisma.JsonValue,
  })
  await repositories.tickets.appendComment({
    ticketId: ticket.id,
    kind: 'human_comment',
    authorType: 'human',
    authorUserId: actor.id,
    authorDisplayName: actor.name,
    body:
      '✅ Jóváhagyva — a kapu alatti API-műveletek lefutottak. Folytasd a feladatot a munkaterület checkpointjából (fold_muveletek / fold_frissites_progress); ne egyeztess újra elölről.',
  })
  await services.tickets.transition({
    ticketId: ticket.id,
    toState: 'needs_info',
    actor: { type: 'human', userId: actor.id, role: actor.role },
    note: 'Következmény-kapu jóváhagyás utáni folytatás',
  })
  await services.tickets.transition({
    ticketId: ticket.id,
    toState: 'ready',
    actor: { type: 'system' },
  })
  await repositories.tickets.appendComment({
    ticketId: ticket.id,
    kind: 'system_note',
    authorType: 'system',
    body: 'Visszaadva újrafeldolgozásra (következmény-kapu után)',
  })
  // User-intent folytatás a kapu után — ne a dispatcher enable / cron-ra várjunk.
  const dispatchOutcome = await runAgentTicketDispatch(ticket.id, ticket.agentId, {
    bypassDispatcherEnabledCheck: true,
  })
  const warning = dispatchOutcome.error ?? dispatchOutcome.warning
  return { ticketResumed: true, ...(warning ? { warning } : {}) }
}

export async function resumeTicketAfterConnectorGrant(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const { ticketId } = z.object({ ticketId: z.string().uuid() }).parse(input)
    const ticket = await repositories.tickets.findById(ticketId)
    if (!ticket) return fail('ticket_not_found')
    assertTicketTenantScope(ticket, user.activeTenantId)
    if (!ticket.agentId) return fail('ticket_not_found')
    if (ticket.state !== 'awaiting_human') {
      return fail('A folytatás csak akkor indítható, amikor a ticket emberi lépésre vár.')
    }

    const { readConnectorGrantNeedsFromPayload, CONNECTOR_GRANT_NEEDED_TICKET_NOTE } = await import(
      '@/domain/connector-grant/connector-grant-needed'
    )
    const stillOpen = await services.connectorGrants.listOpenGrantNeeds({
      userId: user.user.id,
      tenantId: user.activeTenantId,
      ticketId,
      payloadCards: readConnectorGrantNeedsFromPayload(ticket.payload),
    })
    if (stillOpen.length > 0) {
      return fail('A kért fiók-hozzáférés még hiányzik — előbb add meg a hozzáférést.')
    }

    const prevPayload =
      ticket.payload && typeof ticket.payload === 'object' && !Array.isArray(ticket.payload)
        ? { ...(ticket.payload as Record<string, unknown>) }
        : {}
    delete prevPayload.awaitingConnectorGrant
    delete prevPayload.connectorGrantNeeds
    await repositories.tickets.update(ticket.id, {
      payload: {
        ...prevPayload,
        connectorGrantCompletedAt: new Date().toISOString(),
      } as Prisma.JsonValue,
    })
    await repositories.tickets.appendComment({
      ticketId: ticket.id,
      kind: 'human_comment',
      authorType: 'human',
      authorUserId: user.user.id,
      authorDisplayName: user.user.name,
      body: `✅ ${CONNECTOR_GRANT_NEEDED_TICKET_NOTE}`,
    })
    await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'needs_info',
      actor: { type: 'human', userId: user.user.id, role: user.activeTenantRole },
      note: 'Connector-hozzáférés megadása utáni folytatás',
    })
    await services.tickets.transition({
      ticketId: ticket.id,
      toState: 'ready',
      actor: { type: 'system' },
    })
    await repositories.tickets.appendComment({
      ticketId: ticket.id,
      kind: 'system_note',
      authorType: 'system',
      body: 'Visszaadva újrafeldolgozásra (külső fiók hozzáférés után)',
    })
    const dispatchOutcome = await runAgentTicketDispatch(ticket.id, ticket.agentId, {
      bypassDispatcherEnabledCheck: true,
    })
    const warning = dispatchOutcome.error ?? dispatchOutcome.warning
    return ok({ ticketResumed: true, ...(warning ? { warning } : {}) })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to resume ticket after connector grant')
  }
}

/**
 * EGY döntés — N művelet. A ticket összes nyitott kártyáját a SZERVEREN futtatja
 * le, sorban, friss listából.
 *
 * ÜZLETI OK (`f7ef867f`, 2026-08-04): a felhasználó 30 műveletből 10-et hagyott
 * jóvá, mert a gomb a lapbetöltés pillanatképéből dolgozott, és a futás közben
 * született 20 kártyát nem látta. A friss lista itt a szerveren áll össze, tehát
 * a „mind" tényleg mindet jelenti. A sorrend a létrehozás sorrendje: a műveleti
 * terv (PATCH → POST → DELETE) így marad érvényes.
 *
 * Részleges hiba nem állítja meg a sort: a hívó megkapja, MI bukott el és miért.
 */
const CONSEQUENCE_BATCH_BUDGET_MS = 60_000

export async function approveTicketConsequenceApprovals(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = z.object({ ticketId: z.string().uuid() }).parse(input)
    const actor = {
      id: user.user.id,
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    }

    const ticket = await repositories.tickets.findById(parsed.ticketId)
    if (!ticket) return fail('ticket_not_found')
    assertTicketTenantScope(ticket, user.activeTenantId)
    if (ticket.state !== 'awaiting_human') {
      return fail(
        'A jóváhagyás csak akkor indítható, amikor a ticket emberi jóváhagyásra vár.',
      )
    }

    const open = await services.consequenceApproval.listOpenForTicket(parsed.ticketId, actor)
    const decidable = open.filter((card) => !card.expired || card.failedReason)
    let approved = 0
    let remaining = 0
    const failed: { approvalId: string; summary: string; reason: string }[] = []
    // Falióra-korlát: egy valós szinkron 89 külső HTTP-hívást jelent, ez egyetlen
    // szerver-akcióban időtúllépésbe futna — a felhasználó pedig nem tudná meg,
    // mi futott le. Ezért a sort itt vágjuk el, és MEGMONDJUK, mennyi maradt:
    // a gomb újbóli megnyomása onnan folytatja (a lefutott sorok már nem nyitottak).
    const deadline = Date.now() + CONSEQUENCE_BATCH_BUDGET_MS
    for (const card of decidable) {
      if (Date.now() >= deadline) {
        remaining += 1
        continue
      }
      const result = await services.consequenceApproval.approve(card.approvalId, actor)
      if (result.ok) approved += 1
      else failed.push({ approvalId: card.approvalId, summary: card.summary, reason: result.reason })
    }

    const resume = await resumeTicketAfterConsequenceApprovals(parsed.ticketId, null, {
      id: user.user.id,
      name: user.user.name,
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    })

    return ok({
      total: decidable.length,
      approved,
      failed,
      remaining,
      skippedExpired: open.length - decidable.length,
      ticketResumed: resume.ticketResumed,
      ...(resume.warning ? { warning: resume.warning } : {}),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve consequence actions')
  }
}

export async function rejectConsequenceApproval(input: { approvalId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = consequenceApprovalIdSchema.parse(input)
    const result = await services.consequenceApproval.reject(parsed.approvalId, {
      id: user.user.id,
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    })
    return result.ok ? ok(result) : fail(result.reason)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to reject consequence action')
  }
}

export async function modifyMemoryCandidate(input: {
  candidateId: string
  patch: { title?: string; summary?: string; text?: string; tags?: string[]; evidence?: string; reason?: string }
}) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = modifyMemoryCandidateSchema.parse(input)
    const result = await services.memoryApproval.modify(
      parsed.candidateId,
      { id: user.user.id, tenantId: user.activeTenantId, role: user.activeTenantRole },
      parsed.patch,
    )
    return result.ok ? ok(result) : fail(result.reason)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to modify memory candidate')
  }
}

export async function ticketMemoryCandidate(input: { candidateId: string }) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = memoryCandidateIdSchema.parse(input)
    const result = await services.memoryApproval.ticket(parsed.candidateId, {
      id: user.user.id,
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    })
    return result.ok ? ok(result) : fail(result.reason)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to ticket memory candidate')
  }
}

export async function approveMemoryCandidateTicket(input: { ticketId: string }) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = approveMemoryCandidateTicketSchema.parse(input)
    const result = await services.memoryApproval.approveTicketedCandidate(parsed.ticketId, {
      id: user.user.id,
      tenantId: user.activeTenantId,
      role: user.activeTenantRole,
    })
    return result.ok ? ok(result) : fail(result.reason)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve memory candidate ticket')
  }
}

// ── Tartós agent-memória — WP-8 (agent-memory-persistent-cross-conversation-spec.md
// §8/§9.3/§11.2): agent memória-oldal olvasás, karbantartás-indítás, manifest-alapú
// rollback. A rollback/maintenance permission-kulcs alapú kapun megy (`memory.rollback`
// / `memory.maintenance.run`, minRole admin) — nem a `requireTenantRole` szerep-literállal. ──

export async function listAgentMemoryProjectKeys(input: { agentId: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId)
    if (!agent?.memoryId) return fail('Agent not found')
    assertAgentTenantReachable(agent, ctx.activeTenantId)

    const keys = new Set<string>(['__general__'])
    const memoryId = agent.memoryId

    const [convRows, chunkRows, candidateRows, versionRows] = await Promise.all([
      prisma.conversation.findMany({
        where: { agentId },
        distinct: ['projectKey'],
        select: { projectKey: true },
      }),
      prisma.memoryChunk.findMany({
        where: { memoryId },
        distinct: ['projectKey'],
        select: { projectKey: true },
      }),
      prisma.memoryCandidate.findMany({
        where: { memoryId },
        distinct: ['projectKey'],
        select: { projectKey: true },
      }),
      prisma.memoryVersion.findMany({
        where: { memoryId },
        distinct: ['projectKey'],
        select: { projectKey: true },
      }),
    ])

    for (const row of [...convRows, ...chunkRows, ...candidateRows, ...versionRows]) {
      const key = row.projectKey?.trim()
      if (key) keys.add(key)
    }

    const projectKeys = [...keys].sort((a, b) => {
      if (a === '__general__') return -1
      if (b === '__general__') return 1
      return a.localeCompare(b, 'hu')
    })

    return ok({ projectKeys })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list memory project keys')
  }
}

export async function getAgentMemoryOverview(input: { agentId: string; projectKey: string; workstreamKey?: string }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const parsed = memoryScopeSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, ctx.activeTenantId)
    const memoryId = agent.memoryId
    // workstreamKey nélkül az egész projectKey scope — ne szűrjünk workstream_key IS NULL-ra.
    const workstreamKey = parsed.workstreamKey

    const [focus, decisions, openTasks, constraints, artifacts, activeChunks, versions] = await Promise.all([
      repositories.memoryChunks.findActiveFocus({ memoryId, projectKey: parsed.projectKey, workstreamKey }),
      repositories.memoryChunks.listActiveByType({ memoryId, projectKey: parsed.projectKey, workstreamKey, type: 'decision', limit: 20 }),
      repositories.memoryChunks.listActiveByType({ memoryId, projectKey: parsed.projectKey, workstreamKey, type: 'open_task', limit: 20 }),
      repositories.memoryChunks.listActiveByType({ memoryId, projectKey: parsed.projectKey, workstreamKey, type: 'constraint', limit: 20 }),
      repositories.memoryChunks.listActiveByType({ memoryId, projectKey: parsed.projectKey, workstreamKey, type: 'artifact', limit: 20 }),
      repositories.memoryChunks.listRecentActive({ memoryId, projectKey: parsed.projectKey, workstreamKey, limit: 100 }),
      repositories.memoryVersions.listForScope({ memoryId, projectKey: parsed.projectKey, workstreamKey, limit: 20 }),
    ])

    const pending = await repositories.memoryCandidates.listByRun({
      memoryId,
      projectKey: parsed.projectKey,
      statuses: ['proposed', 'modified', 'ticketed'],
    })
    const candidateQueue = pending.filter((c) => c.proposedBy !== 'maintenance_job')
    const maintenanceProposals = pending.filter((c) => c.proposedBy === 'maintenance_job')

    return ok({
      projectState: { focus, decisions, openTasks, constraints, artifacts },
      activeChunks,
      candidateQueue,
      maintenanceProposals,
      versions,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load agent memory overview')
  }
}

export async function runMemoryMaintenance(input: { agentId: string; projectKey: string; workstreamKey?: string }) {
  try {
    const ctx = await requireTenantPermission('memory.maintenance.run')
    const parsed = memoryScopeSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, ctx.activeTenantId)

    const result = await services.memoryMaintenance.run({
      memoryId: agent.memoryId,
      agentId: parsed.agentId,
      tenantId: ctx.activeTenantId,
      projectKey: parsed.projectKey,
      workstreamKey: parsed.workstreamKey,
      actorId: ctx.user.id,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to run memory maintenance')
  }
}

export async function rollbackMemoryVersion(input: {
  agentId: string
  projectKey: string
  workstreamKey?: string
  toVersion: number
}) {
  try {
    const ctx = await requireTenantPermission('memory.rollback')
    const parsed = rollbackMemoryVersionSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, ctx.activeTenantId)

    const result = await services.memoryRollback.rollback({
      memoryId: agent.memoryId,
      projectKey: parsed.projectKey,
      workstreamKey: parsed.workstreamKey ?? null,
      toVersion: parsed.toVersion,
      actorId: ctx.user.id,
      tenantId: ctx.activeTenantId,
    })
    return result.ok ? ok(result) : fail(result.reason)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to roll back memory version')
  }
}

/**
 * agent-memory-persistent-cross-conversation-spec.md §14 — dashboard-nézet a
 * meglévő audit-eseményekre/metrikákra: candidate-átfutás, inline/ticket arány,
 * memória-méret trend projektenként, retrieval token/latencia, user-feedback
 * arány. DB-alapú (nem az efemer in-process metrika-regiszterből olvas), a
 * `getModelCallsSummary` mintáját követve — így szerver-újraindítás/több
 * instance esetén is konzisztens.
 */
export async function getMemoryObservabilityDashboard(input?: { sinceHours?: number }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const tenantId = ctx.activeTenantId
    const sinceHours = input?.sinceHours ?? 720
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000)

    const tenantAgents = await prisma.agent.findMany({ where: { tenantId }, select: { memoryId: true } })
    const memoryIds = tenantAgents.map((a) => a.memoryId)

    const [
      statusGroups,
      resolvedCandidates,
      pendingCount,
      ticketPathCount,
      inlineApprovedCount,
      activeChunkGroups,
      recentVersions,
      feedbackAgg,
      conflictGroups,
      retrieveAudits,
    ] = await Promise.all([
      prisma.memoryCandidate.groupBy({
        by: ['status'],
        where: { tenantId, createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.memoryCandidate.findMany({
        where: { tenantId, createdAt: { gte: since }, status: { in: ['approved', 'rejected'] } },
        select: { createdAt: true, approvedAt: true, rejectedAt: true },
      }),
      prisma.memoryCandidate.count({
        where: { tenantId, createdAt: { gte: since }, status: { in: ['proposed', 'modified', 'ticketed'] } },
      }),
      prisma.memoryCandidate.count({
        where: { tenantId, createdAt: { gte: since }, ticketId: { not: null } },
      }),
      prisma.memoryCandidate.count({
        where: { tenantId, createdAt: { gte: since }, ticketId: null, status: 'approved' },
      }),
      prisma.memoryChunk.groupBy({
        by: ['projectKey'],
        where: { tenantId, status: 'active' },
        _count: { _all: true },
      }),
      memoryIds.length > 0
        ? prisma.memoryVersion.findMany({
            where: { memoryId: { in: memoryIds }, projectKey: { not: null }, createdAt: { gte: since } },
            select: { projectKey: true, activeChunkIds: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
            take: 500,
          })
        : Promise.resolve([]),
      prisma.memoryChunk.aggregate({
        where: { tenantId, status: 'active' },
        _sum: { userConfirmedHelpfulCount: true, userCorrectedCount: true },
      }),
      prisma.auditLog.groupBy({
        by: ['targetType'],
        where: { tenantId, action: 'memory.conflict_detected', createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.auditLog.findMany({
        where: { tenantId, action: 'memory.retrieve', createdAt: { gte: since } },
        select: { metadata: true },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
    ])

    const decisionMinutes = resolvedCandidates
      .map((c) => {
        const decidedAt = c.approvedAt ?? c.rejectedAt
        if (!decidedAt) return null
        return (decidedAt.getTime() - c.createdAt.getTime()) / 60000
      })
      .filter((v): v is number => v !== null)
    const avgDecisionMinutes =
      decisionMinutes.length > 0
        ? Math.round((decisionMinutes.reduce((a, b) => a + b, 0) / decisionMinutes.length) * 10) / 10
        : null

    const trendByProject = new Map<string, { at: string; activeCount: number }[]>()
    for (const v of recentVersions) {
      if (!v.projectKey) continue
      const ids = Array.isArray(v.activeChunkIds) ? v.activeChunkIds : []
      const points = trendByProject.get(v.projectKey) ?? []
      points.push({ at: v.createdAt.toISOString(), activeCount: ids.length })
      trendByProject.set(v.projectKey, points)
    }

    let tokenSum = 0
    let tokenCount = 0
    let latencySum = 0
    let latencyCount = 0
    for (const row of retrieveAudits) {
      const meta = row.metadata as { contextTokens?: unknown; latencyMs?: unknown } | null
      if (meta && typeof meta.contextTokens === 'number') {
        tokenSum += meta.contextTokens
        tokenCount++
      }
      if (meta && typeof meta.latencyMs === 'number') {
        latencySum += meta.latencyMs
        latencyCount++
      }
    }

    const confirmedHelpful = feedbackAgg._sum.userConfirmedHelpfulCount ?? 0
    const corrected = feedbackAgg._sum.userCorrectedCount ?? 0

    return ok({
      sinceHours,
      candidatesByStatus: statusGroups.map((g) => ({ status: g.status, count: g._count._all })),
      decisionThroughput: { avgMinutes: avgDecisionMinutes, resolvedCount: decisionMinutes.length, pendingCount },
      inlineVsTicket: { inlineApproved: inlineApprovedCount, ticketed: ticketPathCount },
      conflicts: {
        retrieval: conflictGroups.find((g) => g.targetType === 'memory')?._count._all ?? 0,
        publish: conflictGroups.find((g) => g.targetType === 'memory_candidate')?._count._all ?? 0,
      },
      chunksActiveByProject: activeChunkGroups.map((g) => ({ projectKey: g.projectKey, count: g._count._all })),
      chunkTrend: Array.from(trendByProject.entries()).map(([projectKey, points]) => ({ projectKey, points })),
      userFeedback: {
        confirmedHelpful,
        corrected,
        ratio: confirmedHelpful + corrected > 0 ? confirmedHelpful / (confirmedHelpful + corrected) : null,
      },
      retrieval: {
        avgTokens: tokenCount > 0 ? Math.round(tokenSum / tokenCount) : null,
        avgLatencyMs: latencyCount > 0 ? Math.round(latencySum / latencyCount) : null,
        sampleCount: Math.max(tokenCount, latencyCount),
      },
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load memory observability dashboard')
  }
}

/**
 * #46 / #33 — contract megfigyelhetőség a rendszer-áttekintőn.
 * Forrás: `contract.evaluate` + `process.blocked` audit jelek.
 */
export async function getContractObservabilityDashboard(input?: { sinceHours?: number }) {
  try {
    const ctx = await requireTenantRole('viewer')
    const tenantId = ctx.activeTenantId
    const sinceHours = input?.sinceHours ?? 720
    const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000)

    const {
      summarizeContractObservability,
      evaluationFromAuditMetadata,
      humanGateFromBlockedMetadata,
      CONTRACT_OUTCOME_LABELS,
    } = await import('@/domain/contract-runtime')

    const [evaluateAudits, blockedAudits] = await Promise.all([
      prisma.auditLog.findMany({
        where: { tenantId, action: 'contract.evaluate', createdAt: { gte: since } },
        select: { metadata: true },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
      prisma.auditLog.findMany({
        where: { tenantId, action: 'process.blocked', createdAt: { gte: since } },
        select: { metadata: true },
        orderBy: { createdAt: 'desc' },
        take: 2000,
      }),
    ])

    const evaluations = evaluateAudits
      .map((row) => evaluationFromAuditMetadata(row.metadata))
      .filter((e): e is NonNullable<typeof e> => e != null)

    const humanGates = blockedAudits
      .map((row) => humanGateFromBlockedMetadata(row.metadata))
      .filter((g): g is NonNullable<typeof g> => g != null)

    const summary = summarizeContractObservability({ evaluations, humanGates })

    return ok({
      sinceHours,
      ...summary,
      outcomeLabels: CONTRACT_OUTCOME_LABELS,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load contract observability dashboard')
  }
}

// ── IAM / RBAC (Epik 2 + Feature-spec IAM-RBAC) ─────────────────────────────

/** GET /me (§6) — a saját profil; `pending`/role=NULL esetén a hívó a "várj jóváhagyásra" nézetet rendereli. */
export async function getMe() {
  try {
    const user = await getCurrentUser()
    if (!user) return fail('Unauthorized')
    return ok(user)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load current user')
  }
}

export async function listUsers() {
  try {
    const ctx = await requireTenantPermission('user.read')
    const users = await services.iam.listUsers(ctx.activeTenantId, { limit: 100 })
    return ok(users)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list users')
  }
}

export async function listInvitations() {
  try {
    const ctx = await requireTenantPermission('user.read')
    const invitations = await services.iam.listInvitations(ctx.activeTenantId, { limit: 100 })
    return ok(invitations)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list invitations')
  }
}

export async function inviteUser(input: { email: string; role: string }) {
  try {
    const ctx = await requireTenantPermission('user.invite')
    const parsed = inviteUserSchema.parse(input)
    const email = parsed.email.trim().toLowerCase()

    // A helyi invitation az autorizáció forrása; Clerk csak az identitást és a
    // kézbesítést adja. Előbb a helyi, auditált rekord jön létre, majd annak id-ja
    // kerül a Clerk szerver-oldali metadatajába pontos kötésként.
    const result = await services.iam.inviteUser({
      email,
      role: parsed.role,
      createdById: ctx.user.id,
      tenantId: ctx.activeTenantId,
    })

    let clerkInvited = false
    if (isClerkEnabled()) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
        const client = await clerkClient()
        const clerkInvitation = await client.invitations.createInvitation({
          emailAddress: email,
          publicMetadata: { enterpriseInvitationId: result.invitation.id },
          notify: true,
          ignoreExisting: true,
          ...(appUrl ? { redirectUrl: `${appUrl}/sign-up` } : {}),
        })
        await services.iam.bindClerkInvitation({
          invitationId: result.invitation.id,
          clerkInvitationId: clerkInvitation.id,
        })
        clerkInvited = true
      } catch (error) {
        // Fail closed: a locally issued token must not remain usable when the
        // selected production identity provider did not accept the invitation.
        await services.iam.revokeInvitation({
          invitationId: result.invitation.id,
          actorId: ctx.user.id,
          actorTenantId: ctx.activeTenantId,
        })
        throw error
      }
    }

    // A nyers token CSAK most adható vissza. Clerk-módban e-mail ment ki, a token csak
    // belső fallback — a UI ennek megfelelően jelzi, hogy nem kell kézzel megosztani.
    return ok({ invitationId: result.invitation.id, token: result.rawToken, clerkInvited })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to invite user')
  }
}

/**
 * Csendes előkészítés: User + TenantMembership email+szereppel, meghívó email nélkül.
 * Az első verified Google/Clerk belépés email alapján aktiválja a fiókot.
 */
export async function provisionUser(input: { email: string; role: string }) {
  try {
    const ctx = await requireTenantPermission('user.invite')
    if (!ctx.activeTenantId) {
      return fail('provision: active tenant required')
    }
    const parsed = provisionUserSchema.parse(input)
    const result = await services.iam.provisionUser({
      email: parsed.email,
      role: parsed.role,
      createdById: ctx.user.id,
      tenantId: ctx.activeTenantId,
    })
    // Kiinduló jog: az új kolléga a tenant minden agentjét láthatja / megszólíthatja.
    const { materializeDefaultUserAgentGrants } = await import(
      '@/domain/agent-access/default-user-agent-grants'
    )
    await materializeDefaultUserAgentGrants({
      tenantId: ctx.activeTenantId,
      actorUserId: ctx.user.id,
      userId: result.user.id,
    })
    return ok({ userId: result.user.id, membershipId: result.membership.id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to provision user')
  }
}

export async function revokeInvitation(input: { invitationId: string }) {
  try {
    const ctx = await requireTenantPermission('user.invite.revoke')
    const parsed = revokeInvitationSchema.parse(input)
    const invitation = await repositories.invitations.findById(parsed.invitationId)
    const updated = await services.iam.revokeInvitation({
      invitationId: parsed.invitationId,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    if (isClerkEnabled() && invitation?.clerkInvitationId) {
      try {
        const client = await clerkClient()
        await client.invitations.revokeInvitation(invitation.clerkInvitationId)
      } catch (error) {
        // The local denial is already authoritative and fail-closed. Keep the
        // provider drift visible for operations without reopening the grant.
        logger.error(
          { event: 'clerk.invitation.revoke_failed', invitationId: invitation.id, error: String(error) },
          'Clerk invitation revoke failed after local revocation',
        )
      }
    }
    return ok({ invitationId: updated.id, status: updated.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke invitation')
  }
}

export async function redeemInvitation(input: { token: string; name?: string }) {
  try {
    const current = await getCurrentUser()
    if (!current) return fail('Unauthorized')
    const parsed = redeemInvitationSchema.parse(input)
    const user = await services.iam.redeemInvitation({
      token: parsed.token,
      email: current.email,
      externalAuthId: current.externalAuthId,
      name: parsed.name ?? current.name,
    })
    return ok({ userId: user.id, role: user.role })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to redeem invitation')
  }
}

/** §7/B: önregisztrált (pending, role=NULL) fiók jóváhagyása szerepkör-kiosztással. */
export async function approveUser(input: { targetUserId: string; role: string }) {
  try {
    const ctx = await requireTenantPermission('user.approve')
    const parsed = approveUserSchema.parse(input)
    const updated = await services.iam.approveUser({
      targetUserId: parsed.targetUserId,
      role: parsed.role,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ userId: updated.id, role: updated.role, status: updated.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve user')
  }
}

export async function changeUserRole(input: { targetUserId: string; newRole: string }) {
  try {
    const ctx = await requireTenantPermission('user.role.write')
    const parsed = changeUserRoleSchema.parse(input)

    // A DB a jog forrása (N-IAM-1): a self-edit/lock-out/tenant-izoláció döntést a
    // service hozza meg ELŐSZÖR — a Clerk-metadata csak ezután, sikeres döntés után
    // szinkronizál, különben egy elutasított (pl. lock-out) demóció mégis bekerülhetne
    // a Clerk publicMetadata-ba, és a következő bejelentkezéskor visszaszivárogna a DB-be.
    const updated = await services.iam.changeRole({
      targetUserId: parsed.targetUserId,
      newRole: parsed.newRole,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })

    if (isClerkEnabled()) {
      const target = await repositories.users.findById(parsed.targetUserId)
      if (target) {
        const client = await clerkClient()
        const clerkUser = await client.users.getUser(target.externalAuthId)
        await client.users.updateUser(target.externalAuthId, {
          publicMetadata: { ...clerkUser.publicMetadata, role: parsed.newRole },
        })
      }
    }

    return ok({ userId: updated.id, role: updated.role })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to change role')
  }
}

export async function suspendUser(input: { targetUserId: string; reason: string }) {
  try {
    const ctx = await requireTenantPermission('user.suspend')
    const parsed = suspendUserSchema.parse(input)
    const updated = await services.iam.suspendUser({
      targetUserId: parsed.targetUserId,
      reason: parsed.reason,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ userId: updated.id, status: updated.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to suspend user')
  }
}

export async function reactivateUser(input: { targetUserId: string }) {
  try {
    const ctx = await requireTenantPermission('user.suspend')
    const parsed = reactivateUserSchema.parse(input)
    const updated = await services.iam.reactivateUser({
      targetUserId: parsed.targetUserId,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ userId: updated.id, status: updated.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to reactivate user')
  }
}

/**
 * A humán "szerep" leírás (jobDescription) beállítása — ezt látja az agent
 * user_directory toolja, hogy egy feladathoz megtalálja az illetékest.
 */
export async function setUserJobDescription(input: {
  targetUserId: string
  jobDescription?: string | null
}) {
  try {
    const ctx = await requireTenantPermission('user.role.write')
    const parsed = setUserJobDescriptionSchema.parse(input)
    const updated = await services.iam.setJobDescription({
      targetUserId: parsed.targetUserId,
      jobDescription: parsed.jobDescription ?? null,
      actorId: ctx.user.id,
      actorTenantId: ctx.activeTenantId,
    })
    return ok({ userId: updated.id, jobDescription: updated.jobDescription })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update user description')
  }
}

/** GET/PATCH /permissions (§6) — a deklaratív permission-mátrix. */
export async function getPermissionMatrix() {
  try {
    await requireTenantPermission('user.permission.write')
    const matrix = await services.iam.getPermissionMatrix()
    return ok(matrix)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load permission matrix')
  }
}

export async function updateRolePermission(input: { permissionKey: string; minRole: string }) {
  try {
    const ctx = await requireTenantPermission('user.permission.write')
    const parsed = updateRolePermissionSchema.parse(input)
    const updated = await services.iam.updatePermission({
      permissionKey: parsed.permissionKey,
      minRole: parsed.minRole,
      actorId: ctx.user.id,
      tenantId: ctx.activeTenantId,
    })
    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update permission')
  }
}

/** GET /audit/access (§6) — kizárólag a hozzáférési audit-eseménytípusok (§8.5). */
export async function getAccessAuditLog(input?: { limit?: number }) {
  try {
    const ctx = await requireTenantPermission('audit.read')
    const entries = await repositories.audit.findMany(
      buildTenantAccessAuditFilter({ tenantId: ctx.activeTenantId, limit: input?.limit }),
    )
    return ok(entries)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load access audit log')
  }
}

export async function createEval(input: {
  agentId: string
  name: string
  goldenSet: Array<{ description: string; type: string; value: string | number }>
}) {
  try {
    const user = await requireTenantRole('admin')
    const parsed = createEvalSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)
    const evalDef = await services.eval.create(parsed)
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'training.eval_created',
      targetType: 'eval',
      targetId: evalDef.id,
      modelUsed: null,
      inputRef: agent.id,
      outputRef: evalDef.id,
      policyDecision: 'allowed',
      tenantId: user.activeTenantId,
      metadata: { assertionCount: parsed.goldenSet.length, name: evalDef.name },
    })
    return ok(evalDef)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create eval')
  }
}

export async function runEval(input: { evalId: string; agentId: string; proposedContent: string }) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = runEvalSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)
    const evalRun = await services.eval.run({
      evalId: parsed.evalId,
      agentId: agent.id,
      proposedContent: parsed.proposedContent,
      agentVersion: agent.currentVersion,
      trigger: 'manual',
    })
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'training.eval',
      targetType: 'eval',
      targetId: parsed.evalId,
      modelUsed: null,
      inputRef: agent.id,
      outputRef: evalRun.id,
      policyDecision: evalRun.passed ? 'passed' : 'failed',
      tenantId: user.activeTenantId,
      metadata: { trigger: 'manual', passed: evalRun.passed, score: evalRun.score },
    })
    return ok(evalRun)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to run eval')
  }
}

export async function listEvalsForAgent(input: { agentId: string }) {
  try {
    const user = await requireTenantRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId)
    if (!agent) return fail('Agent not found')
    assertAgentTenantReachable(agent, user.activeTenantId)
    const evals = await services.eval.findAllForAgent(agent.id)
    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'training.eval_read',
      targetType: 'agent',
      targetId: agent.id,
      modelUsed: null,
      inputRef: agent.id,
      outputRef: null,
      policyDecision: 'allowed',
      tenantId: user.activeTenantId,
      metadata: { evalCount: evals.length },
    })
    return ok(evals)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list evals')
  }
}

export async function rollbackMemory(input: { agentId: string; toVersion: number }) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = rollbackMemorySchema.parse(input)
    const memoryVersion = await services.training.rollbackMemory(
      parsed.agentId,
      parsed.toVersion,
      trainingActor(user),
    )
    return ok(memoryVersion)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Rollback failed')
  }
}

export async function listAuditLog(input?: z.infer<typeof listAuditLogSchema>) {
  try {
    const user = await requireTenantRole('approver')
    const parsed = input ? listAuditLogSchema.parse(input) : {}
    const entries = await repositories.audit.findMany({
      // Az audit-nézet compliance-adatot mutat (agent, döntés, cél és időpont), ezért
      // az approver szerep SOHA nem jelenthet cross-tenant olvasási jogosultságot.
      tenantId: user.activeTenantId,
      limit: parsed.limit ?? 100,
      action: parsed.action,
      actorType: parsed.actorType,
      actorId: parsed.actorId,
      targetType: parsed.targetType,
      targetId: parsed.targetId,
      ticketId: parsed.ticketId,
      conversationId: parsed.conversationId,
      since: parsed.since,
    })
    return ok(entries)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list audit log')
  }
}

export async function archiveSandboxApp(input: z.infer<typeof archiveSandboxAppSchema>) {
  try {
    const user = await requireTenantRole('operator')
    const parsed = archiveSandboxAppSchema.parse(input)
    const result = await services.sandboxApps.archiveSandboxApp(parsed, {
      userId: user.user.id,
      tenantId: user.activeTenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to archive sandbox app')
  }
}

function rangeToSince(range?: 'today' | '7d' | '30d' | 'all'): Date | undefined {
  const now = new Date()
  switch (range) {
    case 'all':
      return undefined
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    case '30d':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    case 'today':
    default: {
      const startOfDay = new Date()
      startOfDay.setHours(0, 0, 0, 0)
      return startOfDay
    }
  }
}

export async function getModelCostSummary(input?: { range?: unknown }) {
  try {
    await requireTenantRole('viewer')
    const { range } = costSummarySchema.parse({ range: input?.range })
    const summary = await repositories.modelCalls.getCostSummary(rangeToSince(range))
    return ok(summary)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get cost summary')
  }
}

export async function verifyAuditChain() {
  try {
    await requireTenantRole('approver')
    const result = await services.auditChain.verifyChain()
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Verification failed')
  }
}

export async function exportAuditSiem(input?: { since?: string }) {
  try {
    const user = await requireTenantRole('admin')
    const { since } = z.object({ since: z.coerce.date().optional() }).parse(input ?? {})
    const jsonLines = await services.auditChain.exportJsonLines({
      tenantId: user.activeTenantId,
      since,
    })
    return ok({ content: jsonLines, filename: `audit-siem-${new Date().toISOString().slice(0, 10)}.jsonl` })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Export failed')
  }
}

export async function listWorkspaceTenants() {
  try {
    await requireTenantRole('admin')
    const rows = await prisma.user.findMany({
      where: { tenantId: { not: null } },
      select: { tenantId: true },
      distinct: ['tenantId'],
    })
    const tenantIds = rows.map((row) => row.tenantId).filter((id): id is string => Boolean(id))
    return ok({ tenantIds, includesGlobalFallback: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list tenants')
  }
}

/** GDPR / tenant offboarding — azonnali workspace törlés (§5.3). */
export async function purgeTenantWorkspaces(tenantId: string) {
  try {
    const actor = await requireTenantRole('admin')
    const normalized = tenantId.trim()
    if (!normalized) return fail('Tenant ID is required')

    const deleted = await services.workspaceLifecycle.purgeTenantWorkspaces(normalized)
    await repositories.audit.append({
      actorType: 'human',
      actorId: actor.user.id,
      agentVersion: null,
      action: 'workspace.tenant.purge',
      targetType: 'tenant',
      targetId: normalized === 'global' ? null : normalized,
      modelUsed: null,
      inputRef: normalized,
      outputRef: String(deleted),
      policyDecision: 'allowed',
      metadata: { deletedObjects: deleted, tenantId: normalized },
    })
    return ok({ deletedObjects: deleted })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Workspace purge failed')
  }
}

export async function getDashboardStats() {
  try {
    const user = await requireTenantRole('viewer')
    const since = new Date(new Date().setHours(0, 0, 0, 0))
    const openStates = ['backlog', 'ready', 'approved', 'in_progress', 'awaiting_human'] as const
    const [activeAgents, openTickets, cost, tools] = await Promise.all([
      repositories.agents.count({
        tenantId: user.activeTenantId,
        status: 'active',
        excludeHiddenFromOperators: shouldExcludeHiddenAgents(user.activeTenantRole),
      }),
      repositories.tickets.count({
        tenantId: user.activeTenantId,
        state: [...openStates],
        excludeTest: true,
      }),
      repositories.modelCalls.getCostSummary(since),
      repositories.toolBroker.getToolSummary(since),
    ])

    return ok({
      activeAgents,
      openTickets,
      tokensToday: cost.tokens,
      costTodayEur: cost.cost,
      toolCallsToday: tools.calls,
      toolDeniedToday: tools.denied,
      toolErrorsToday: tools.errors,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get dashboard stats')
  }
}

const SANDBOX_AUDIT_ACTIONS = [
  'sandbox_app.create',
  'sandbox_app.version.create',
  'sandbox_app.preview',
  'sandbox_app.export',
  'sandbox_app.access_denied',
] as const

/**
 * Aggregated governance / observability report (Epik 8, §11).
 * Combines Gateway + Tool Broker metrics, control-plane transition stats,
 * audit-chain integrity and sandbox-app events for the chosen time range.
 */
export async function getGovernanceReport(input?: { range?: unknown }) {
  try {
    await requireTenantRole('viewer')
    const { range } = costSummarySchema.parse({ range: input?.range })
    const since = rangeToSince(range)

    const [model, tools, transitions, sandboxCounts, chain, breakdown, toolByTicket, tickets, playbookGovernance] =
      await Promise.all([
        repositories.modelCalls.getGovernanceSummary(since),
        repositories.toolBroker.getToolSummary(since),
        repositories.tickets.getTransitionStats(since),
        repositories.audit.getActionCounts({ actions: [...SANDBOX_AUDIT_ACTIONS], since }),
        services.auditChain.verifyChain(),
        repositories.modelCalls.getPerTicketBreakdown(since, 25),
        repositories.toolBroker.getToolCallCountsByTicket(since),
        repositories.tickets.findMany(),
        computePlaybookGovernance({ audit: repositories.audit }, since ?? null),
      ])

    const titleById = new Map(tickets.map((t) => [t.id, t.title]))
    const perTicket = breakdown.map((b) => ({
      ...b,
      title: titleById.get(b.ticketId) ?? '(ismeretlen ügy)',
      toolCalls: toolByTicket[b.ticketId] ?? 0,
    }))

    const decisions = transitions.toApproved + transitions.toRejected
    const rejectionRate = decisions > 0 ? transitions.toRejected / decisions : 0
    const humanShare =
      transitions.total > 0 ? transitions.byActor.human / transitions.total : 0

    return ok({
      range: range ?? 'today',
      model,
      tools,
      transitions,
      control: { decisions, rejectionRate, humanShare },
      sandbox: {
        created: sandboxCounts['sandbox_app.create'] ?? 0,
        versions: sandboxCounts['sandbox_app.version.create'] ?? 0,
        previews: sandboxCounts['sandbox_app.preview'] ?? 0,
        exports: sandboxCounts['sandbox_app.export'] ?? 0,
        accessDenied: sandboxCounts['sandbox_app.access_denied'] ?? 0,
      },
      chain,
      playbookGovernance,
      perTicket,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to build governance report')
  }
}

export async function getDispatcherControls() {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    const controls = await services.platformSettings.getDispatcherControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read dispatcher controls')
  }
}

export async function getTicketTypeConfigs() {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    const configs = await services.platformSettings.getTicketTypeConfigs()
    return ok(configs)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read ticket type configs')
  }
}

export async function getModelPolicy() {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    const policy = await services.platformSettings.getModelPolicy()
    return ok(policy)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read model policy')
  }
}

export async function adminUpsertModelPolicyEntry(input: {
  provider: string
  model: string
  enabled: boolean
  label?: string
  description?: string
}) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const parsed = modelPolicyEntrySchema.parse(input)
    const policy = await services.platformSettings.upsertModelPolicyEntry(parsed, actor.id)
    return ok(policy)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update model policy')
  }
}

export async function adminUpsertTicketType(input: {
  type: 'interaction' | 'training' | 'monitor_alert'
  allowedTransitions: Array<{
    from:
      | 'backlog'
      | 'ready'
      | 'approved'
      | 'in_progress'
      | 'awaiting_human'
      | 'needs_info'
      | 'done'
      | 'rejected'
    to:
      | 'backlog'
      | 'ready'
      | 'approved'
      | 'in_progress'
      | 'awaiting_human'
      | 'needs_info'
      | 'done'
      | 'rejected'
    allowed:
      | 'system'
      | 'agent'
      | 'approver'
      | 'operator'
      | 'admin'
      | 'system_or_operator'
      | 'creator_or_operator'
  }>
}) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const parsed = ticketTypeConfigSchema.parse(input)
    const configs = await services.platformSettings.upsertTicketTypeConfig(parsed, actor.id)
    return ok(configs)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update ticket type config')
  }
}

export async function setDispatcherControls(input: {
  enabled?: boolean
  allowedModes?: string[]
  pollIntervalSeconds?: number
  blockedNotifyChannel?: string
}) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const parsed = setDispatcherControlsSchema.parse(input)
    const controls = await services.platformSettings.setDispatcherControls(
      {
        enabled: parsed.enabled,
        allowedModes: parsed.allowedModes,
        pollIntervalMs:
          parsed.pollIntervalSeconds !== undefined ? parsed.pollIntervalSeconds * 1000 : undefined,
        blockedNotifyChannel: parsed.blockedNotifyChannel,
      },
      actor.id,
    )
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update dispatcher controls')
  }
}

export type LocalWorkerStatus =
  | { available: false }
  | { available: true; running: false }
  | {
      available: true
      running: true
      startedAt: string
      lastCycleAt: string | null
      lastCycleError: string | null
      cycles: number
    }

export type SchedulerWorkerStatus =
  | { available: false; error: string }
  | {
      available: true
      state: 'ENABLED' | 'PAUSED' | 'UNKNOWN'
      schedule: string | null
      timeZone: string | null
      lastAttemptStatus: string | null
    }

export type WorkerProcessesStatus = {
  local: LocalWorkerStatus
  scheduler: SchedulerWorkerStatus
  lastCycle: DispatchCycleRunRecord | null
}

async function fetchLocalWorkerStatus(): Promise<LocalWorkerStatus> {
  const url = process.env.LOCAL_WORKER_CONTROL_URL?.trim()
  if (!url) return { available: false }
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    const body = (await response.json()) as {
      listening?: boolean
      startedAt?: string
      lastCycleAt?: string | null
      lastCycleError?: string | null
      cycles?: number
    }
    if (!body.listening) return { available: true, running: false }
    return {
      available: true,
      running: true,
      startedAt: body.startedAt ?? '',
      lastCycleAt: body.lastCycleAt ?? null,
      lastCycleError: body.lastCycleError ?? null,
      cycles: body.cycles ?? 0,
    }
  } catch {
    return { available: true, running: false }
  }
}

export async function getWorkerProcessesStatus(): Promise<ActionResult<WorkerProcessesStatus>> {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    const [local, scheduler, lastCycle] = await Promise.all([
      fetchLocalWorkerStatus(),
      getSchedulerJobStatus()
        .then((status) => ({ available: true as const, ...status }))
        .catch((e) => ({ available: false as const, error: e instanceof Error ? e.message : String(e) })),
      services.platformSettings.getLastDispatchCycleRun(),
    ])
    return ok({ local, scheduler, lastCycle })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read worker processes status')
  }
}

/**
 * Kézi dispatch-ciklus indítás (§5.7 kiegészítés — admin UI gomb): ugyanazt a
 * ciklust futtatja le, mint a Cloud Scheduler-hívta stateless endpoint vagy a
 * lokális worker, csak közvetlenül, ebből a kérésből — nem kell hozzá sem
 * dispatcher-worker process, sem Cloud Scheduler beállítva.
 */
export async function runDispatchCycleNow(): Promise<ActionResult<DispatchCycleSummary>> {
  try {
    await ensureActiveDatabaseMode()
    await requirePlatformRole('superadmin')
    const summary = await runDispatchCycle({ triggeredBy: 'manual' })
    return ok(summary)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to run dispatch cycle')
  }
}

export async function stopLocalDispatcherWorker(): Promise<ActionResult<{ stopped: boolean }>> {
  try {
    await ensureActiveDatabaseMode()
    await requirePlatformRole('superadmin')
    const url = process.env.LOCAL_WORKER_CONTROL_URL?.trim()
    const token = process.env.DISPATCHER_CONTROL_TOKEN?.trim()
    if (!url || !token) {
      return fail('LOCAL_WORKER_CONTROL_URL / DISPATCHER_CONTROL_TOKEN nincs beállítva ezen a szerveren')
    }
    const response = await fetch(`${url}/control/stop`, {
      method: 'POST',
      headers: { 'x-dispatcher-token': token },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) {
      return fail(`Local worker stop failed: ${response.status}`)
    }
    return ok({ stopped: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to stop local dispatcher worker')
  }
}

/** A dispatch-cycle-sweep Cloud Scheduler job szüneteltetése/folytatása az admin UI-ból. */
export async function setDispatchSchedulerPaused(
  paused: boolean,
): Promise<ActionResult<SchedulerWorkerStatus>> {
  try {
    await ensureActiveDatabaseMode()
    await requirePlatformRole('superadmin')
    const status = await setSchedulerJobPaused(paused)
    return ok({ available: true, ...status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update Cloud Scheduler job state')
  }
}

/** A dispatch-cycle-sweep Cloud Scheduler job intervallumának állítása (2-59 perc). */
export async function setDispatchSchedulerIntervalMinutes(
  minutes: number,
): Promise<ActionResult<SchedulerWorkerStatus>> {
  try {
    await ensureActiveDatabaseMode()
    await requirePlatformRole('superadmin')
    const status = await setSchedulerJobIntervalMinutes(minutes)
    return ok({ available: true, ...status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update Cloud Scheduler interval')
  }
}

/**
 * Teszt / üresjárat: agent-indítás ki, monitor kill-switch be, Cloud Scheduler szünet (ha elérhető).
 * Elmenti az előző állapotot visszaállításhoz. A lokális workert külön kell leállítani.
 */
export async function setMinimalCostMode(): Promise<
  ActionResult<{ warnings: string[] }>
> {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const warnings: string[] = []

    const [dispatcher, monitor] = await Promise.all([
      services.platformSettings.getDispatcherControls(),
      services.platformSettings.getMonitorControls(),
    ])

    let schedulerState: 'ENABLED' | 'PAUSED' | null = null
    try {
      const status = await getSchedulerJobStatus()
      schedulerState = status.state === 'ENABLED' || status.state === 'PAUSED' ? status.state : null
    } catch {
      schedulerState = null
    }

    await services.platformSettings.saveAutomationIdleSnapshot(
      {
        dispatcherEnabled: dispatcher.enabled,
        monitorKillSwitch: monitor.killSwitch,
        schedulerState,
        savedAt: new Date().toISOString(),
      },
      actor.id,
    )

    await services.platformSettings.setDispatcherControls({ enabled: false }, actor.id)
    await services.platformSettings.setMonitorControls({ killSwitch: true }, actor.id)

    try {
      await setSchedulerJobPaused(true)
    } catch (e) {
      warnings.push(
        e instanceof Error
          ? `Cloud Scheduler nem szüneteltethető: ${e.message}`
          : 'Cloud Scheduler nem szüneteltethető innen',
      )
    }

    return ok({ warnings })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to enable minimal cost mode')
  }
}

/** Üresjárat mód visszavonása — a bekapcsolás előtti mentett állapotot állítja vissza. */
export async function resumeAutomationMode(): Promise<
  ActionResult<{ warnings: string[] }>
> {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const warnings: string[] = []

    const snapshot = await services.platformSettings.getAutomationIdleSnapshot()
    if (!snapshot) {
      await services.platformSettings.setDispatcherControls({ enabled: true }, actor.id)
      await services.platformSettings.setMonitorControls({ killSwitch: false }, actor.id)
      try {
        await setSchedulerJobPaused(false)
      } catch (e) {
        warnings.push(
          e instanceof Error
            ? `Cloud Scheduler nem folytatható: ${e.message}`
            : 'Cloud Scheduler nem folytatható innen',
        )
      }
      warnings.unshift('Nincs mentett állapot — alapértelmezett normál mód visszaállítva.')
      return ok({ warnings })
    }

    await services.platformSettings.setDispatcherControls(
      { enabled: snapshot.dispatcherEnabled },
      actor.id,
    )
    await services.platformSettings.setMonitorControls(
      { killSwitch: snapshot.monitorKillSwitch },
      actor.id,
    )

    if (snapshot.schedulerState === 'ENABLED') {
      try {
        await setSchedulerJobPaused(false)
      } catch (e) {
        warnings.push(
          e instanceof Error
            ? `Cloud Scheduler nem folytatható: ${e.message}`
            : 'Cloud Scheduler nem folytatható innen',
        )
      }
    }

    await services.platformSettings.clearAutomationIdleSnapshot(actor.id)

    return ok({ warnings })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to resume automation mode')
  }
}

export async function getAutomationIdleSnapshot(): Promise<
  ActionResult<import('@/domain/platform-settings/platform-settings-service').AutomationIdleSnapshot | null>
> {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    const snapshot = await services.platformSettings.getAutomationIdleSnapshot()
    return ok(snapshot)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read idle snapshot')
  }
}

/** Fejléc kapcsoló: csak platform-superadminnak, tenant nélkül is olvasható. */
export async function getAutomationModeToggleState(): Promise<
  ActionResult<{ canToggle: boolean; idle: boolean }>
> {
  try {
    const ctx = await getAuthContext()
    if (!ctx || !isSuperadmin(ctx.platformRoles)) {
      return ok({ canToggle: false, idle: false })
    }
    await ensureActiveDatabaseMode()
    const snapshot = await services.platformSettings.getAutomationIdleSnapshot()
    return ok({ canToggle: true, idle: snapshot !== null })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read automation mode')
  }
}

export async function getDatabaseMode() {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    const [info, syncStatus] = await Promise.all([
      services.platformSettings.getDatabaseMode(),
      services.platformSettings.getDatabaseSyncStatus(),
    ])
    return ok({ ...info, syncStatus })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read database mode')
  }
}

export async function setDatabaseMode(input: { mode: 'production' | 'test' }) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    const parsed = setDatabaseModeSchema.parse(input)
    const info = await services.platformSettings.setDatabaseMode(parsed.mode, actor.id)
    return ok(info)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update database mode')
  }
}

export async function syncTestDatabaseFromProduction(input: { confirm: true }) {
  try {
    await ensureActiveDatabaseMode()
    const actor = (await requirePlatformRole('superadmin')).user
    syncTestDatabaseSchema.parse(input)
    const result = await services.platformSettings.syncTestDatabaseFromProduction(actor.id)
    const syncStatus = await services.platformSettings.getDatabaseSyncStatus()
    return ok({ result, syncStatus })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to sync test database')
  }
}

// Az automatikus connector-linkeléshez szükséges tool-halmazok a broker
// `TOOL_REQUIREMENTS` mátrixából SZÁMOLNAK (issue #194): ami a brokernek
// connectort igényel, arra a mentés connectort is linkel. A korábbi kézzel írt
// listákból több workspace-es tool kimaradt, ezért a bepipált jog mellé nem
// került connector, és az eszköz némán elhasalt.
const KNOWLEDGE_BASE_TOOLS = toolsRequiringConnector('knowledge_base')
const WORKSPACE_TOOLS = toolsRequiringConnector('workspace')
const BOARD_TOOLS = toolsRequiringConnector('board')
const GMAIL_TOOLS = toolsRequiringConnector('gmail')
const GMAIL_WRITE_TOOLS = toolsRequiringConnector('gmail', 'write')
const HTTP_API_TOOLS = toolsRequiringConnector('http_api')

const CONFIGURABLE_AGENT_TOOLS = NORMAL_TOOL_CAPABILITY_NAMES

const CONFIGURABLE_AGENT_TOOL_SET = new Set<string>(CONFIGURABLE_AGENT_TOOLS)

async function linkActiveConnectorForAgent(input: {
  agentId: string
  tenantId: string | null
  type: ConnectorType
  accessMode: ConnectorAccessMode
  missingMessage: string
}): Promise<{ success: true } | { success: false; error: string }> {
  let connector
  if (input.type === 'web_search' && input.tenantId) {
    const { findTenantWebSearchConnector, ensureTenantWebSearchConnector } = await import(
      '@/domain/web-search/web-search-connector-service'
    )
    connector =
      (await findTenantWebSearchConnector(input.tenantId)) ??
      (await ensureTenantWebSearchConnector(input.tenantId))
  } else {
    // Tenant-preferencia: ELŐSZÖR a tenant saját connectora, és CSAK ha nincs, akkor a
    // platform (tenantId=null) megosztott connector. A korábbi `OR + orderBy createdAt asc`
    // a legrégebbit vette a saját∪null halmazból, így a régi platform-seed connectorok
    // (pl. a Provider CRM) legyőzték a tenant saját connectorát — cross-tenant szivárgás.
    // Idegen tenant connectora sosem jöhet szóba (a runtime tenant_isolation őre is tiltja).
    connector =
      (input.tenantId
        ? await prisma.connector.findFirst({
            where: { type: input.type, lifecycleState: 'active', tenantId: input.tenantId },
            orderBy: { createdAt: 'asc' },
          })
        : null) ??
      (await prisma.connector.findFirst({
        where: { type: input.type, lifecycleState: 'active', tenantId: null },
        orderBy: { createdAt: 'asc' },
      }))
  }
  if (!connector) return { success: false, error: input.missingMessage }

  await prisma.agentConnector.upsert({
    where: {
      agentId_connectorId: { agentId: input.agentId, connectorId: connector.id },
    },
    create: {
      agentId: input.agentId,
      connectorId: connector.id,
      accessMode: input.accessMode,
    },
    update: { accessMode: input.accessMode },
  })

  return { success: true }
}

export async function updateAgentCapabilities(input: {
  agentId: string
  enabledTools: string[]
}) {
  try {
    const user = await requireTenantRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })

    const agent = await repositories.agents.findById(agentId, user.activeTenantId)
    if (!agent) return fail('Agent not found')

    // A Futás-elemző tenant-naplókat olvas. A tool-halmaza ezért system-managed:
    // egy admin sem adhat hozzá egress capability-t a normál capability-panelen.
    if (agent.systemRole === RUN_ANALYST_SYSTEM_ROLE) {
      await repositories.audit.append({
        actorType: 'human',
        actorId: user.user.id,
        agentVersion: agent.currentVersion,
        action: 'capability.update_denied_system_role',
        targetType: 'agent',
        targetId: agentId,
        modelUsed: null,
        inputRef: [...new Set(input.enabledTools)].join(','),
        outputRef: 'denied',
        policyDecision: 'denied',
        metadata: {
          systemRole: RUN_ANALYST_SYSTEM_ROLE,
          requiredTools: [...RUN_ANALYST_ROLE_CAPABILITIES],
        } as Prisma.JsonValue,
      })
      return fail(RUN_ANALYST_CAPABILITIES_LOCKED_MESSAGE)
    }

    const allTools = [...new Set(input.enabledTools)].filter((toolName) =>
      CONFIGURABLE_AGENT_TOOL_SET.has(toolName),
    )
    const enabledSet = new Set(allTools)
    const needsKnowledgeBase = KNOWLEDGE_BASE_TOOLS.some((t) => enabledSet.has(t))
    const needsWorkspace = WORKSPACE_TOOLS.some((t) => enabledSet.has(t))
    const needsGmail = GMAIL_TOOLS.some((t) => enabledSet.has(t))
    const needsGmailWrite = GMAIL_WRITE_TOOLS.some((t) => enabledSet.has(t))
    // A HTTP API tool bekapcsolása CSAK a jogot adja meg — connectort NEM linkelünk
    // automatikusan. Nincs „kanonikus" http_api connector (egy tenantnak több is lehet),
    // és az auto-választás korábban a legrégebbi platform-connectort (Provider CRM) húzta
    // be cross-tenant. A konkrét connectort az adminnak explicit hozzá kell rendelnie.
    const needsHttpApi = HTTP_API_TOOLS.some((t) => enabledSet.has(t))
    const needsWebSearch = enabledSet.has('web_search')
    const needsBoard = BOARD_TOOLS.some((t) => enabledSet.has(t))

    if (agent.role === 'orchestrator' && allTools.length > 0) {
      await repositories.audit.append({
        actorType: 'human',
        actorId: user.user.id,
        agentVersion: agent.currentVersion,
        action: 'tool.authorize_denied_orchestrator',
        targetType: 'agent',
        targetId: agentId,
        modelUsed: null,
        inputRef: allTools.join(','),
        outputRef: 'denied',
        policyDecision: 'denied',
        metadata: { requestedTools: allTools } as Prisma.JsonValue,
      })
      return fail('Orchestrator agent nem kaphat Tool Broker capability-t.')
    }

    if (needsKnowledgeBase) {
      const connector = await ensureAgentKnowledgeBase(agent, prisma)
      if (!connector) return fail('Knowledge Base connector nem hozható létre ehhez az agenthez.')
    }

    if (needsWorkspace) {
      const linked = await linkActiveConnectorForAgent({
        agentId,
        tenantId: user.activeTenantId,
        type: 'workspace',
        accessMode: 'write',
        missingMessage: 'Workspace connector nem található a rendszerben.',
      })
      if (!linked.success) return fail(linked.error)
    }

    if (needsGmail) {
      const linked = await linkActiveConnectorForAgent({
        agentId,
        tenantId: user.activeTenantId,
        type: 'gmail',
        accessMode: needsGmailWrite ? 'write' : 'read',
        missingMessage: 'Aktív Gmail connector nem található a rendszerben.',
      })
      if (!linked.success) return fail(linked.error)
    }

    if (needsWebSearch) {
      const linked = await linkActiveConnectorForAgent({
        agentId,
        tenantId: user.activeTenantId,
        type: 'web_search',
        accessMode: 'read',
        missingMessage: 'Aktív Web Search connector nem található a rendszerben.',
      })
      if (!linked.success) return fail(linked.error)
    }

    // A sandbox_app.* toolok a `board` connectort igénylik (TOOL_REQUIREMENTS).
    // A normál agentek ezt seedből megkapják; itt idempotensen biztosítjuk, hogy
    // az App Registry jog engedélyezésekor a link garantáltan meglegyen.
    if (needsBoard) {
      const linked = await linkActiveConnectorForAgent({
        agentId,
        tenantId: user.activeTenantId,
        type: 'board',
        accessMode: 'write',
        missingMessage: 'Aktív Board connector nem található a rendszerben.',
      })
      if (!linked.success) return fail(linked.error)
    }

    const disabledTools = CONFIGURABLE_AGENT_TOOLS.filter((toolName) => !enabledSet.has(toolName))

    await Promise.all([
      ...allTools.map((toolName) =>
        prisma.capability.upsert({
          where: { agentId_toolName: { agentId, toolName } },
          create: { agentId, toolName, allowed: true },
          update: { allowed: true },
        }),
      ),
      disabledTools.length
        ? prisma.capability.updateMany({
            where: { agentId, toolName: { in: [...disabledTools] } },
            data: { allowed: false },
          })
        : Promise.resolve({ count: 0 }),
    ])

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.user.id,
      agentVersion: agent.currentVersion,
      action: 'capability.update',
      targetType: 'tool',
      targetId: agentId,
      modelUsed: null,
      inputRef: allTools.join(','),
      outputRef: 'updated',
      policyDecision: 'allowed',
      metadata: {
        enabledTools: allTools,
        disabledTools,
        knowledgeBaseLinked: needsKnowledgeBase,
        workspaceLinked: needsWorkspace,
        gmailLinked: needsGmail,
        httpApiLinked: false,
        httpApiAssignmentRequired: needsHttpApi,
        webSearchLinked: needsWebSearch,
        boardLinked: needsBoard,
      } as Prisma.JsonValue,
    })

    return ok({
      updatedCount: allTools.length,
      knowledgeBaseLinked: needsKnowledgeBase,
      workspaceLinked: needsWorkspace,
      gmailLinked: needsGmail,
      // A http_api connector sosem linkelődik automatikusan — külön hozzárendelés kell.
      httpApiLinked: false,
      httpApiAssignmentRequired: needsHttpApi,
      webSearchLinked: needsWebSearch,
      boardLinked: needsBoard,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update capabilities')
  }
}

// ── Model Gateway: Routing policies (Fázis 2-A) ──────────────────────────────

export async function listModelRoutingPolicies() {
  try {
    await requireTenantRole('operator')
    const policies = await repositories.modelRoutingPolicies.list()
    return ok(policies)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list routing policies')
  }
}

export async function createModelRoutingPolicy(input: {
  scope: 'global' | 'agent' | 'ticket_type'
  scopeRef?: string
  model: string
  provider: string
  priority?: number
  tenantId?: string
}) {
  try {
    await requirePlatformRole('superadmin')
    const policy = await repositories.modelRoutingPolicies.create({
      tenantId: input.tenantId ?? null,
      scope: input.scope,
      scopeRef: input.scopeRef ?? null,
      model: input.model.trim(),
      provider: input.provider.trim(),
      priority: input.priority ?? 100,
      conditions: null,
    })
    return ok(policy)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create routing policy')
  }
}

export async function deleteModelRoutingPolicy(input: { id: string }) {
  try {
    await requirePlatformRole('superadmin')
    await repositories.modelRoutingPolicies.delete(input.id)
    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete routing policy')
  }
}

// ── Model Gateway: Budgets (Fázis 2-A) ──────────────────────────────────────

/**
 * Egy keretszabály a felület számára. Szándékosan NEM a nyers Prisma sor: a
 * `softThreshold` `Decimal` példány, amit a szerver→kliens határ nem tud
 * szerializálni, és a felületnek amúgy sincs rá szüksége.
 */
export type BudgetRuleView = {
  id: string
  /** `null` = platform-szintű, minden szervezetre érvényes szabály. */
  tenantId: string | null
  scope: 'tenant' | 'agent' | 'ticket_type'
  scopeRef: string | null
  period: 'day' | 'week' | 'month'
  callLimit: number | null
  tokenLimit: number | null
  hardCap: boolean
  /**
   * A szabály SAJÁT hatókörén mért fogyasztás — ugyanaz a mérés, amit a kapu néz,
   * hogy a felületen látszó „hol tartunk" ne térjen el a tényleges döntéstől.
   * A platform-szintű sornál az aktív szervezetben mérve (ott dől el, blokkol-e itt).
   */
  usage: {
    calls: number
    tokens: number
    /**
     * A „minden munkatársra külön-külön" szabálynál nincs egyetlen fogyasztás: a
     * korlátot az éri el először, aki a legtöbbet fogyasztotta. A számok ezért az
     * ő fogyasztását mutatják — ő a szűk keresztmetszet.
     */
    peakAgentName?: string
    /** Igaz, ha ez a szabály most blokkolna egy új hívást. */
    exhausted: boolean
  }
}

type BudgetRuleRow = {
  id: string
  tenantId: string | null
  scope: string
  scopeRef: string | null
  period: string
  callLimit: number | null
  tokenLimit: number | null
  hardCap: boolean
}

function toBudgetRuleView(row: BudgetRuleRow, usage: BudgetRuleView['usage']): BudgetRuleView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    scope: row.scope as BudgetRuleView['scope'],
    scopeRef: row.scopeRef,
    period: row.period as BudgetRuleView['period'],
    callLimit: row.callLimit,
    tokenLimit: row.tokenLimit,
    hardCap: row.hardCap,
    usage,
  }
}

/** Frissen létrehozott / most mentett szabály — a fogyasztás a következő betöltéskor pontosul. */
function toBudgetRuleViewWithoutUsage(row: BudgetRuleRow): BudgetRuleView {
  return toBudgetRuleView(row, { calls: 0, tokens: 0, exhausted: false })
}

/**
 * Egy keretszabály fogyasztása a SAJÁT hatókörén, az aktív szervezetben mérve.
 * A hatókör dönti el, mit összegzünk — ugyanaz a szabály, amit a kapu is követ
 * (`usageForBudget`), különben a felületen látszó szám és a blokkolás elválna.
 */
async function budgetRuleUsage(
  row: BudgetRuleRow,
  tenantId: string,
  agentNameById: Map<string, string>,
  byAgentByPeriod: Map<string, Array<{ agentId: string; calls: number; tokens: number }>>,
): Promise<BudgetRuleView['usage']> {
  const period = row.period as ModelBudgetPeriod
  const exhausted = (usage: { calls: number; tokens: number }) => isRuleExhausted(row, usage)

  if (row.scope === 'tenant') {
    const usage = await repositories.modelCalls.getUsageForTenant(tenantId, period)
    return { ...usage, exhausted: exhausted(usage) }
  }

  if (row.scope === 'ticket_type') {
    if (!row.scopeRef) return { calls: 0, tokens: 0, exhausted: false }
    const usage = await repositories.modelCalls.getUsageForTicketType(
      tenantId,
      row.scopeRef as Ticket['type'],
      period,
    )
    return { ...usage, exhausted: exhausted(usage) }
  }

  if (row.scopeRef) {
    const usage = await repositories.modelCalls.getUsageForAgent(row.scopeRef, period)
    return { ...usage, exhausted: exhausted(usage) }
  }

  // `scope=agent` + `scopeRef=null`: minden munkatársra külön érvényes. A korlátot az
  // éri el először, aki a legtöbbet fogyasztotta — őt mutatjuk szűk keresztmetszetként.
  const peak = pickPeakAgent(byAgentByPeriod.get(period) ?? [], row)
  if (!peak) return { calls: 0, tokens: 0, exhausted: false }
  return {
    calls: peak.calls,
    tokens: peak.tokens,
    peakAgentName: agentNameById.get(peak.agentId) ?? peak.agentId,
    exhausted: exhausted(peak),
  }
}

export async function listModelBudgets(): Promise<ActionResult<BudgetRuleView[]>> {
  try {
    const ctx = await requireTenantRole('operator')
    // A `list()` szűrő nélkül MINDEN tenant keretét visszaadta egy tenant-operatornak.
    // A saját tenant + a platform-szintű (tenantId: null) sorok láthatók, más nem.
    const [own, platformWide, agents] = await Promise.all([
      repositories.modelBudgets.list({ tenantId: ctx.activeTenantId }),
      repositories.modelBudgets.list({ tenantId: undefined }).then((rows) =>
        rows.filter((b) => b.tenantId === null),
      ),
      repositories.agents.findMany({
        tenantId: ctx.activeTenantId,
        excludeHiddenFromOperators: shouldExcludeHiddenAgents(ctx.activeTenantRole),
      }),
    ])
    const rows = [...own, ...platformWide]
    const agentNameById = new Map(agents.map((a) => [a.id, a.name]))

    // Az agentenkénti bontás periódusonként egyszer kell, nem szabályonként.
    const periods = [
      ...new Set(
        rows
          .filter((r) => r.scope === 'agent' && r.scopeRef === null)
          .map((r) => r.period as ModelBudgetPeriod),
      ),
    ]
    const byAgentByPeriod = new Map(
      await Promise.all(
        periods.map(
          async (period) =>
            [period, await repositories.modelCalls.getUsageByAgent(ctx.activeTenantId, period)] as const,
        ),
      ),
    )

    const views = await Promise.all(
      rows.map(async (row) =>
        toBudgetRuleView(
          row,
          await budgetRuleUsage(row, ctx.activeTenantId, agentNameById, byAgentByPeriod),
        ),
      ),
    )
    return ok(views)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list model budgets')
  }
}

export type BudgetLimits = {
  callLimit: number | null
  tokenLimit: number | null
}

export type ConfiguredBudgetLimits = BudgetLimits & { configured: boolean }

export type DailyBudgetOverview = {
  tenantId: string
  /** Az összesített tenant-keret; `null` limit = korlátlan, `null` sor = nincs beállítva. */
  tenant: ConfiguredBudgetLimits
  /** Minden agentre külön-külön érvényes napi keret. */
  perAgent: ConfiguredBudgetLimits
  /** Az env-mentsvár, ami akkor dönt, ha egyetlen keret sincs beállítva. */
  envFallback: { maxCallsPerDay: number; maxTokensPerDay: number }
  usage: {
    tenant: { calls: number; tokens: number }
    agents: Array<{ agentId: string; name: string; calls: number; tokens: number }>
  }
  /**
   * A szervezet AI munkatársai — az egyedi keretszabályok UUID helyett nevet
   * mutatnak, és új szabálynál listából lehet munkatársat választani.
   */
  agents: Array<{ id: string; name: string }>
}

/**
 * A tenant napi model-kerete és a hozzá tartozó tényleges fogyasztás egy nézetben. A
 * fogyasztás ugyanazon a gördülő 24 órás ablakon számol, amit a dispatcher-kapu is néz
 * (`budgetPeriodSince`), így a kiírt „elhasznált / limit" nem tér el a kapu döntésétől.
 */
export async function getDailyBudgetOverview(): Promise<ActionResult<DailyBudgetOverview>> {
  try {
    const ctx = await requireTenantRole('operator')
    const tenantId = ctx.activeTenantId

    const budgets = await repositories.modelBudgets.list({ tenantId })
    const dayBudgets = budgets.filter((b) => b.period === 'day')
    const tenantBudget = dayBudgets.find((b) => b.scope === 'tenant')
    const perAgentBudget = dayBudgets.find((b) => b.scope === 'agent' && b.scopeRef === null)

    const [tenantUsage, byAgent, agents] = await Promise.all([
      repositories.modelCalls.getUsageForTenant(tenantId, 'day'),
      repositories.modelCalls.getUsageByAgent(tenantId, 'day'),
      repositories.agents.findMany({
        tenantId,
        excludeHiddenFromOperators: shouldExcludeHiddenAgents(ctx.activeTenantRole),
      }),
    ])

    const nameById = new Map(agents.map((a) => [a.id, a.name]))

    return ok({
      tenantId,
      tenant: {
        callLimit: tenantBudget?.callLimit ?? null,
        tokenLimit: tenantBudget?.tokenLimit ?? null,
        configured: Boolean(tenantBudget),
      },
      perAgent: {
        callLimit: perAgentBudget?.callLimit ?? null,
        tokenLimit: perAgentBudget?.tokenLimit ?? null,
        configured: Boolean(perAgentBudget),
      },
      envFallback: dispatchBudgetFromEnv(),
      usage: {
        tenant: tenantUsage,
        agents: byAgent
          .map((u) => ({ ...u, name: nameById.get(u.agentId) ?? u.agentId }))
          .sort((a, b) => b.tokens - a.tokens),
      },
      agents: agents
        .map((a) => ({ id: a.id, name: a.name }))
        .sort((a, b) => a.name.localeCompare(b.name, 'hu')),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load budget overview')
  }
}

/**
 * A tenant napi keretének beállítása: az összesített és a per-agent sor együtt (upsert).
 * `null` limit = korlátlan az adott dimenzióban. Tenant-admin joggal megy, mert a saját
 * tenantja keretét állítja — platform-szintű (`tenantId: null`) sort innen nem lehet írni.
 */
export type TenantDailyBudgetInput = {
  tenant: BudgetLimits
  perAgent: BudgetLimits
}

export async function setTenantDailyBudget(
  input: TenantDailyBudgetInput,
): Promise<ActionResult<{ saved: true }>> {
  try {
    const ctx = await requireTenantRole('admin')
    const tenantId = ctx.activeTenantId

    const existing = (await repositories.modelBudgets.list({ tenantId })).filter(
      (b) => b.period === 'day',
    )
    const upsert = async (
      scope: 'tenant' | 'agent',
      limits: BudgetLimits,
    ) => {
      const row = existing.find(
        (b) => b.scope === scope && (scope === 'tenant' || b.scopeRef === null),
      )
      if (row) {
        await repositories.modelBudgets.update(row.id, { ...limits })
        return
      }
      await repositories.modelBudgets.create({
        tenantId,
        scope,
        scopeRef: null,
        period: 'day',
        callLimit: limits.callLimit,
        tokenLimit: limits.tokenLimit,
        softThreshold: null,
        hardCap: true,
      })
    }

    await upsert('tenant', input.tenant)
    await upsert('agent', input.perAgent)

    await repositories.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'model.budget_changed',
      targetType: 'tenant',
      targetId: tenantId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { tenant: input.tenant, perAgent: input.perAgent, period: 'day' },
    })

    return ok({ saved: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to save daily budget')
  }
}

/**
 * Egyedi keretszabály létrehozása.
 *
 * A `appliesTo` szándékosan kötelező döntés: korábban a hiányzó `tenantId` némán
 * PLATFORM-szintű (minden szervezetre érvényes) sort hozott létre, amit a felületen
 * semmi nem jelzett — így egy szervezetnek szánt korlát az összes többit is fogta.
 */
export async function createModelBudget(input: {
  scope: 'tenant' | 'agent' | 'ticket_type'
  scopeRef?: string
  period: 'day' | 'week' | 'month'
  callLimit?: number
  tokenLimit?: number
  softThreshold?: number
  hardCap?: boolean
  appliesTo: 'tenant' | 'platform'
}) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    if (input.appliesTo === 'tenant' && !ctx.activeTenantId) {
      return fail('Nincs kiválasztott szervezet — válts szervezetet, vagy add meg platform-szintűnek.')
    }
    const budget = await repositories.modelBudgets.create({
      tenantId: input.appliesTo === 'platform' ? null : ctx.activeTenantId,
      scope: input.scope,
      scopeRef: input.scopeRef ?? null,
      period: input.period,
      callLimit: input.callLimit ?? null,
      tokenLimit: input.tokenLimit ?? null,
      softThreshold: input.softThreshold != null ? new (await import('@prisma/client')).Prisma.Decimal(input.softThreshold) : null,
      hardCap: input.hardCap ?? true,
    })
    return ok(toBudgetRuleViewWithoutUsage(budget))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create model budget')
  }
}

/**
 * Meglévő keretszabály korlátainak módosítása. A hatókör (kire vonatkozik) és a
 * periódus nem változtatható — az más szabály, ott törlés + új a helyes út.
 */
export async function updateModelBudget(input: {
  id: string
  callLimit: number | null
  tokenLimit: number | null
  hardCap: boolean
}) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const existing = await repositories.modelBudgets.findById(input.id)
    if (!existing) return fail('A keretszabály nem található.')
    // Platform-szintű sort bárhonnan, tenant-sort csak a saját szervezet nézetéből.
    if (existing.tenantId !== null && existing.tenantId !== ctx.activeTenantId) {
      return fail('Ez a keretszabály másik szervezethez tartozik — válts arra a szervezetre.')
    }
    const budget = await repositories.modelBudgets.update(input.id, {
      callLimit: input.callLimit,
      tokenLimit: input.tokenLimit,
      hardCap: input.hardCap,
    })
    await repositories.audit.append({
      actorType: 'human',
      actorId: ctx.user.id,
      agentVersion: null,
      action: 'model.budget_changed',
      targetType: 'tenant',
      targetId: existing.tenantId ?? 'platform',
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: {
        budgetId: input.id,
        scope: existing.scope,
        scopeRef: existing.scopeRef,
        period: existing.period,
        callLimit: input.callLimit,
        tokenLimit: input.tokenLimit,
        hardCap: input.hardCap,
      },
    })
    return ok(toBudgetRuleViewWithoutUsage(budget))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update model budget')
  }
}

export async function deleteModelBudget(input: { id: string }) {
  try {
    const ctx = await requirePlatformRole('superadmin')
    const existing = await repositories.modelBudgets.findById(input.id)
    if (!existing) return fail('A keretszabály nem található.')
    if (existing.tenantId !== null && existing.tenantId !== ctx.activeTenantId) {
      return fail('Ez a keretszabály másik szervezethez tartozik — válts arra a szervezetre.')
    }
    await repositories.modelBudgets.delete(input.id)
    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete model budget')
  }
}

// ── Model Gateway: Observability summary ────────────────────────────────────

export async function getModelCallsSummary(input?: { sinceHours?: number }) {
  try {
    await requireTenantRole('operator')
    const since = input?.sinceHours
      ? new Date(Date.now() - input.sinceHours * 60 * 60 * 1000)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const [summary, breakdown, actionCounts] = await Promise.all([
      repositories.modelCalls.getGovernanceSummary(since),
      repositories.modelCalls.getPerTicketBreakdown(since, 20),
      repositories.audit.getActionCounts({ actions: ['model.call.fallback'], since }),
    ])
    return ok({
      summary: {
        ...summary,
        fallbackSwitches: actionCounts['model.call.fallback'] ?? 0,
      },
      breakdown,
      sinceHours: input?.sinceHours ?? 168,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load model calls summary')
  }
}

// ── Model Gateway: tartalék-lánc + tarifa (#34) ─────────────────────────────

export async function getFallbackChain() {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    return ok(await services.platformSettings.getFallbackChain())
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read fallback chain')
  }
}

export async function setFallbackChain(input: {
  chain: Array<{ provider: string; model: string }>
}) {
  try {
    await ensureActiveDatabaseMode()
    const user = await requirePlatformRole('superadmin')
    const known = new Set(
      (await import('@/lib/model-providers')).MODEL_PROVIDERS.map((p) => p.value),
    )
    const chain = await services.platformSettings.setFallbackChain(
      input.chain,
      user.user.id,
      known,
    )
    return ok(chain)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to save fallback chain')
  }
}

export async function previewEffectiveFallbackChain(input: {
  agentId?: string
  provider: string
  model: string
  simulateSensitive?: boolean
}) {
  try {
    await ensureActiveDatabaseMode()
    const user = await requireTenantRole('operator')
    let agentModelConfig: unknown
    if (input.agentId) {
      const agent = await repositories.agents.findById(input.agentId, user.activeTenantId)
      agentModelConfig = agent?.modelConfig
    }
    const preview = await services.gateway.previewEffectiveFallbackChain({
      primary: { provider: input.provider, model: input.model },
      agentId: input.agentId,
      tenantId: user.activeTenantId,
      agentModelConfig,
      simulateSensitive: input.simulateSensitive,
    })
    return ok(preview)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to preview fallback chain')
  }
}

export async function getModelPricingView() {
  try {
    await ensureActiveDatabaseMode()
    await requireTenantRole('operator')
    return ok(await services.platformSettings.getModelPricingView())
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read model pricing')
  }
}

export async function setManualModelPrice(input: {
  model: string
  inputPerMTokens: number
  outputPerMTokens: number
}) {
  try {
    await ensureActiveDatabaseMode()
    const user = await requirePlatformRole('superadmin')
    await services.platformSettings.setManualModelPrice(
      input.model,
      {
        inputPerMTokens: input.inputPerMTokens,
        outputPerMTokens: input.outputPerMTokens,
      },
      user.user.id,
    )
    return ok(true)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to set manual price')
  }
}

export async function clearManualModelPrice(input: { model: string }) {
  try {
    await ensureActiveDatabaseMode()
    const user = await requirePlatformRole('superadmin')
    await services.platformSettings.clearManualModelPrice(input.model, user.user.id)
    return ok(true)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to clear manual price')
  }
}

/** OpenRouter models API → szinkronizált tarifa-réteg (superadmin). */
export async function syncModelPricingFromOpenRouter() {
  try {
    await ensureActiveDatabaseMode()
    const user = await requirePlatformRole('superadmin')
    const result = await services.platformSettings.syncModelPricingFromOpenRouter(user.user.id)
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to sync model pricing')
  }
}
