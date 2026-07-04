'use server'

import { z } from 'zod'
import type { Prisma, UserRole } from '@prisma/client'
import { mkdir, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { clerkClient } from '@clerk/nextjs/server'
import { getCurrentUser, requireRole } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { requirePermission } from '@/auth/permission'
import { services } from '@/domain'
import { SandboxAppError } from '@/domain/sandbox/errors'
import { dispatchBudgetFromEnv } from '@/domain/dispatcher/dispatcher-service'
import { repositories } from '@/repositories/postgres'
import { isClerkEnabled } from '@/lib/clerk-config'
import { prisma, ensureActiveDatabaseMode } from '@/lib/db'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
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
import { fail, ok, type ActionResult } from '@/lib/result'
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
  createHttpApiConnectorSchema,
  updateHttpApiConnectorSchema,
  createTrainingSchema,
  askWikiSchema,
  generateReportSchema,
  sendAgentMessageSchema,
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
  ticketFilterSchema,
  ticketIdSchema,
  ticketTypeConfigSchema,
  transitionTicketSchema,
  modelPolicyEntrySchema,
  createBoardTicketSchema,
  inviteUserSchema,
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

export async function listTickets(input?: { filter?: unknown }) {
  try {
    await requireRole('viewer')
    const filter = input?.filter ? ticketFilterSchema.parse(input.filter) : undefined
    const tickets = await repositories.tickets.findMany(filter)
    return ok(tickets)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list tickets')
  }
}

export async function listBoardAssignees() {
  try {
    const user = await requireRole('operator')
    const [agents, users] = await Promise.all([
      repositories.agents.findMany({ tenantId: user.tenantId }),
      prisma.user.findMany({
        // `role: { not: null }` a deny-by-default invariáns tükre (N-IAM-3): egy
        // aktív, de role nélküli sor (elméletileg nem fordulhat elő) sem legyen kijelölhető.
        where: { status: 'active', role: { not: null } },
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' },
      }),
    ])

    return ok({
      agents: agents
        .filter((agent) => agent.status === 'active')
        .map((agent) => ({ id: agent.id, name: agent.name })),
      users: users.filter((u): u is typeof u & { role: UserRole } => u.role !== null),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list board assignees')
  }
}

async function runAgentTicketDispatch(
  ticketId: string,
  agentId: string,
): Promise<{ warning?: string; error?: string }> {
  const launcherMode = process.env.HARNESS_LAUNCHER_MODE ?? 'local-wiki'
  if (launcherMode !== 'local-wiki') {
    return {
      warning:
        'Ticket létrejött (ready). Docker/Cloud Run módban a feldolgozáshoz futtasd: npm run dispatcher:worker',
    }
  }

  try {
    const dispatchResult = await services.dispatcher.dispatchTicket(ticketId)
    if (dispatchResult.status === 'budget_blocked') {
      const since = new Date()
      since.setHours(0, 0, 0, 0)
      const usage = await repositories.modelCalls.getUsageForAgentSince(agentId, since)
      const budget = dispatchBudgetFromEnv()
      return {
        warning:
          `Ticket létrejött (ready), de a napi keret betelt: ${usage.tokens.toLocaleString('hu-HU')}/${budget.maxTokensPerDay.toLocaleString('hu-HU')} token, ${usage.calls}/${budget.maxCallsPerDay} hívás. ` +
          'Emeld a DISPATCH_MAX_TOKENS_PER_DAY értékét, vagy várd meg a holnapi resetet.',
      }
    }
    if (dispatchResult.status === 'paused') {
      return {
        warning:
          'Ticket létrejött (ready), de a dispatcher ki van kapcsolva — System → Dispatcher panelen kapcsold be.',
      }
    }
    if (dispatchResult.status === 'skipped') {
      return {
        warning:
          'Ticket létrejött (ready), de a feldolgozás most nem indult el — frissíts, vagy indítsd a dispatcher workert.',
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

export async function createBoardTicket(input: {
  title: string
  description?: string
  assigneeType: 'human' | 'agent'
  assigneeId: string
  deferDispatch?: boolean
}) {
  try {
    const user = await requireRole('operator')
    const parsed = createBoardTicketSchema.parse(input)

    const promptText = parsed.description?.trim() || parsed.title.trim()

    if (parsed.assigneeType === 'agent') {
      const agentDetails = await repositories.agents.findByIdWithDetails(parsed.assigneeId, user.tenantId)
      if (!agentDetails) return fail('Agent not found')
      if (agentDetails.agent.status !== 'active') return fail('Agent is not active')

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

      const ticket = await repositories.tickets.create({
        tenantId: user.tenantId,
        type: 'interaction',
        title: parsed.title,
        state: 'ready',
        assigneeType: 'agent',
        assigneeId: parsed.assigneeId,
        agentId: parsed.assigneeId,
        payload: payload as Prisma.JsonValue,
        sourceDocumentId: null,
        executeAfter: null,
        dueBy: null,
        createdById: user.id,
      })

      let warning: string | undefined
      if (!parsed.deferDispatch) {
        const dispatchOutcome = await runAgentTicketDispatch(ticket.id, parsed.assigneeId)
        if (dispatchOutcome.error) return fail(dispatchOutcome.error)
        warning = dispatchOutcome.warning
      }

      const updated = await repositories.tickets.findById(ticket.id)
      return ok({ ticket: updated ?? ticket, warning })
    }

    const payload: Record<string, unknown> = { source: 'board' }
    if (parsed.description) payload.task = parsed.description

    const assignee = await prisma.user.findUnique({ where: { id: parsed.assigneeId } })
    if (!assignee) return fail('User not found')
    if (assignee.status !== 'active') return fail('User is not active')

    const ticket = await repositories.tickets.create({
      tenantId: user.tenantId,
      type: 'interaction',
      title: parsed.title,
      state: 'awaiting_human',
      assigneeType: 'human',
      assigneeId: parsed.assigneeId,
      agentId: null,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: user.id,
    })

    return ok({ ticket })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create board ticket')
  }
}

export async function dispatchBoardTicket(input: { ticketId: string }) {
  try {
    await requireRole('operator')
    const { id: ticketId } = ticketIdSchema.parse(input)
    const ticket = await repositories.tickets.findById(ticketId)
    if (!ticket) return fail('Ticket not found')
    if (ticket.assigneeType !== 'agent' || !ticket.assigneeId) {
      return fail('Ticket is not assigned to an agent')
    }
    if (ticket.state !== 'ready') return fail('Ticket is not in ready state')

    const dispatchOutcome = await runAgentTicketDispatch(ticketId, ticket.assigneeId)
    if (dispatchOutcome.error) return fail(dispatchOutcome.error)

    const updated = await repositories.tickets.findById(ticketId)
    return ok({ ticket: updated ?? ticket, warning: dispatchOutcome.warning })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to dispatch board ticket')
  }
}

export async function listBoardTickets() {
  try {
    await requireRole('viewer')
    const tickets = await repositories.tickets.findMany({ excludeTest: true })

    const agentIds = new Set<string>()
    const userIds = new Set<string>()
    for (const ticket of tickets) {
      userIds.add(ticket.createdById)
      if (ticket.assigneeType === 'agent' && ticket.assigneeId) agentIds.add(ticket.assigneeId)
      if (ticket.assigneeType === 'human' && ticket.assigneeId) userIds.add(ticket.assigneeId)
      if (ticket.agentId) agentIds.add(ticket.agentId)
      const creatorAgentId = extractCreatorAgentId(ticket.payload)
      if (creatorAgentId) agentIds.add(creatorAgentId)
    }

    const [agents, users] = await Promise.all([
      agentIds.size > 0
        ? prisma.agent.findMany({
            where: { id: { in: [...agentIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
      userIds.size > 0
        ? prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ])

    const enriched = enrichTicketsForBoard(tickets, {
      agents: new Map(agents.map((agent) => [agent.id, agent.name])),
      users: new Map(users.map((user) => [user.id, user.name])),
    })

    return ok(enriched)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list board tickets')
  }
}

export async function listScheduledTasks() {
  try {
    const user = await requireRole('operator')
    const tasks = await services.scheduledTasks.list({
      tenantId: user.tenantId,
      limit: 100,
    })
    return ok(tasks)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list scheduled tasks')
  }
}

export async function revokeScheduledTask(input: { id: string }) {
  try {
    const user = await requireRole('operator')
    const { id } = scheduledTaskIdSchema.parse(input)
    const task = await services.scheduledTasks.revoke({
      scheduledTaskId: id,
      actorId: user.id,
      tenantId: user.tenantId,
    })
    return ok(task)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to revoke scheduled task')
  }
}

export async function getTicket(input: { id: string }) {
  try {
    await requireRole('viewer')
    const { id } = ticketIdSchema.parse(input)
    const ticket = await repositories.tickets.findById(id)
    if (!ticket) return fail('Ticket not found')

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
    const [assigneeUser, creatorUser, creatorAgent] = await Promise.all([
      ticket.assigneeType === 'human' && ticket.assigneeId
        ? prisma.user.findUnique({ where: { id: ticket.assigneeId }, select: { name: true } })
        : Promise.resolve(null),
      prisma.user.findUnique({ where: { id: ticket.createdById }, select: { name: true } }),
      creatorAgentId
        ? repositories.agents.findById(creatorAgentId)
        : Promise.resolve(null),
    ])

    const display = buildTicketDisplayExtras(ticket, {
      assigneeAgentName: assigneeAgent?.name ?? null,
      assigneeUserName: assigneeUser?.name ?? null,
      responsibleAgentName:
        responsibleAgent && responsibleAgent.id !== ticket.assigneeId
          ? responsibleAgent.name
          : assigneeAgent?.name ?? responsibleAgent?.name ?? null,
    })

    const agentNames = new Map<string, string>()
    if (creatorAgent) agentNames.set(creatorAgent.id, creatorAgent.name)

    return ok({
      ...ticket,
      reproduction,
      ...display,
      creator: formatTicketCreator({
        createdById: ticket.createdById,
        payload: ticket.payload,
        agentNames,
        userNames: new Map([[ticket.createdById, creatorUser?.name ?? 'Ismeretlen']]),
      }),
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get ticket')
  }
}

export async function getTicketTransitions(input: { id: string }) {
  try {
    await requireRole('viewer')
    const { id } = ticketIdSchema.parse(input)
    const transitions = await repositories.tickets.findTransitions(id)
    return ok(transitions)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get ticket transitions')
  }
}

export async function transitionTicket(input: {
  id: string
  toState: string
  note?: string
}): Promise<ActionResult<unknown>> {
  try {
    const user = await requireRole(['viewer', 'operator', 'approver', 'admin'])
    const parsed = transitionTicketSchema.parse(input)

    const existing = await repositories.tickets.findById(parsed.id)
    if (!existing) return fail('Ticket not found')

    if (
      existing.type === 'training' &&
      (parsed.toState === 'approved' || parsed.toState === 'done') &&
      existing.state === 'awaiting_human'
    ) {
      if (!hasMinimumRole(user.role, 'approver')) {
        return fail('Tanítás jóváhagyása approver jogosultságot igényel')
      }
      const result = await services.training.approveTraining(parsed.id, user.id)
      return ok(result)
    }

    const ticket = await services.tickets.transition({
      ticketId: parsed.id,
      toState: parsed.toState,
      actor: { type: 'human', userId: user.id, role: user.role },
      note: parsed.note,
    })

    if (parsed.toState === 'approved') {
      const done = await services.tickets.transition({
        ticketId: parsed.id,
        toState: 'done',
        actor: { type: 'system' },
      })
      return ok(done ?? ticket)
    }

    return ok(ticket)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Transition failed')
  }
}

export async function listAgents() {
  try {
    const user = await requireRole('viewer')
    return ok(await repositories.agents.findMany({ tenantId: user.tenantId }))
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list agents')
  }
}

export async function getAgent(input: { id: string }) {
  try {
    const user = await requireRole('viewer')
    const { id } = agentIdSchema.parse(input)
    const detail = await repositories.agents.findByIdWithDetails(id, user.tenantId)
    if (!detail) return fail('Agent not found')
    return ok(detail)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get agent')
  }
}

export async function getAgentGovernance(input: { agentId: string }) {
  try {
    const user = await requireRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId, user.tenantId)
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
  endpoints?: Array<{
    method: string
    path: string
    description?: string
    idempotent?: boolean
    profile?: string
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
    restrictToEndpoints: input.restrictToEndpoints,
  }
}

async function syncHttpApiCapabilities(agentId: string, connectorId: string, accessMode: 'read' | 'write') {
  await prisma.capability.upsert({
    where: { agentId_toolName: { agentId, toolName: 'http_api_get' } },
    create: { agentId, toolName: 'http_api_get', allowed: true },
    update: { allowed: true },
  })

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
  endpoints?: Array<{
    method: string
    path: string
    description?: string
    idempotent?: boolean
    profile?: string
  }>
}) {
  try {
    const user = await requireRole('admin')
    const parsed = createHttpApiConnectorSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!agent) return fail('Agent not found')
    if (agent.role === 'orchestrator') {
      return fail('Orchestrator agent nem kaphat HTTP API connectort vagy Tool Broker capability-t.')
    }

    const existing = await prisma.connector.findUnique({
      where: { type_name: { type: 'http_api', name: parsed.name } },
    })
    if (existing) return fail(`Már létezik „${parsed.name}" nevű API-kapcsolat — adj egyedi nevet.`)

    const config = httpApiConnectorConfig(parsed)

    // 1. Connector létrehozása secret nélkül; 2. a pasted kulcs a secret-store
    //    mögé kerül (NEM a DB-be); 3. az alias secret-ref:<id>-re frissül.
    // oauth2_delegated: a connector user_delegated — a felhasználó adja a
    // hozzájárulást (authorization-code consent), az agent az ő tokenjével jár el.
    const isDelegated = parsed.authScheme === 'oauth2_delegated'
    const connector = await prisma.connector.create({
      data: {
        type: 'http_api',
        name: parsed.name,
        authMode: isDelegated ? 'user_delegated' : 'service',
        scope: 'global',
        config: config as Prisma.InputJsonValue,
        secretAlias: null,
        tenantId: user.tenantId ?? null,
      },
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
      actorId: user.id,
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

export async function updateHttpApiConnectorForAgent(input: {
  agentId: string
  connectorId: string
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
  endpoints?: Array<{
    method: string
    path: string
    description?: string
    idempotent?: boolean
    profile?: string
  }>
}) {
  try {
    const user = await requireRole('admin')
    const parsed = updateHttpApiConnectorSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!agent) return fail('Agent not found')
    if (agent.role === 'orchestrator') {
      return fail('Orchestrator agent nem kaphat HTTP API connectort vagy Tool Broker capability-t.')
    }

    const link = await prisma.agentConnector.findUnique({
      where: {
        agentId_connectorId: { agentId: parsed.agentId, connectorId: parsed.connectorId },
      },
      include: { connector: true },
    })
    if (!link) return fail('API-kapcsolat nincs ehhez az agenthez rendelve.')
    if (link.connector.type !== 'http_api') return fail('Csak API-kapcsolat szerkeszthető itt.')

    // Egy már user_delegated (auto-consent) connectort nem szabad némán service
    // módra visszaállítani egy generikus szerkesztéssel — az eltörné a per-user
    // grant-feloldást és eldobná a config.oauth blokkot.
    if (link.connector.authMode === 'user_delegated' && parsed.authScheme !== 'oauth2_delegated') {
      return fail(
        'Ez egy automatikus-hozzájárulású (user-delegált) kapcsolat — a hitelesítést az „Összekötött fiókok" oldalon kezeld, vagy válaszd az „OAuth2 – automatikus hozzájárulás" módot.',
      )
    }

    const existing = await prisma.connector.findUnique({
      where: { type_name: { type: 'http_api', name: parsed.name } },
    })
    if (existing && existing.id !== parsed.connectorId) {
      return fail(`Már létezik „${parsed.name}" nevű API-kapcsolat — adj egyedi nevet.`)
    }

    const isDelegated = parsed.authScheme === 'oauth2_delegated'
    const wasDelegated = link.connector.authMode === 'user_delegated'
    const config = httpApiConnectorConfig(parsed)

    // oauth2_delegated átállásnál a store mögé PLAIN client_secret kell (a consent
    // token-cseréhez). Ha nincs új secret megadva és a connector eddig NEM volt
    // delegált, a régi {clientSecret,refreshToken} blobból kinyerjük a client_secretet,
    // hogy az admin ne kényszerüljön újra beírni a már tárolt titkot.
    let delegatedSecret = parsed.clientSecret
    if (isDelegated && !delegatedSecret && !wasDelegated && link.connector.secretAlias) {
      const { resolveConnectorApiKey } = await import('@/domain/connector/http-api-client')
      try {
        const existing = await resolveConnectorApiKey(link.connector.secretAlias)
        const blob = JSON.parse(existing) as { clientSecret?: unknown }
        if (typeof blob.clientSecret === 'string' && blob.clientSecret.trim()) {
          delegatedSecret = blob.clientSecret.trim()
        }
      } catch {
        /* nem JSON-blob (pl. már plain) — hagyjuk a meglévőt */
      }
    }

    // oauth2 rotáláshoz mindkét titok kell (a séma ezt kikényszeríti); a JSON blob
    // formátum megegyezik a create-tel, hogy a http_api runtime egységesen olvassa.
    // oauth2_delegated: csak a client_secret kerül a store mögé (plain).
    const rotatedSecret =
      parsed.authScheme === 'oauth2' && parsed.clientSecret && parsed.refreshToken
        ? JSON.stringify({ clientSecret: parsed.clientSecret, refreshToken: parsed.refreshToken })
        : isDelegated
          ? delegatedSecret
          : parsed.authScheme !== 'oauth2'
            ? parsed.apiKey
            : undefined
    if (rotatedSecret) {
      const { saveConnectorApiKey } = await import('@/domain/connector/connector-secret-store')
      await saveConnectorApiKey(parsed.connectorId, rotatedSecret)
    }
    const { buildConnectorSecretRef } = await import('@/domain/connector/connector-secret-store')

    const connector = await prisma.connector.update({
      where: { id: parsed.connectorId },
      data: {
        name: parsed.name,
        authMode: isDelegated ? 'user_delegated' : 'service',
        config: config as Prisma.InputJsonValue,
        secretAlias: link.connector.secretAlias ?? buildConnectorSecretRef(parsed.connectorId),
        version: { increment: 1 },
      },
    })

    await prisma.agentConnector.update({
      where: {
        agentId_connectorId: { agentId: parsed.agentId, connectorId: parsed.connectorId },
      },
      data: { accessMode: parsed.accessMode },
    })

    await syncHttpApiCapabilities(parsed.agentId, parsed.connectorId, parsed.accessMode)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: agent.currentVersion,
      action: 'connector.update',
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
        apiKeyRotated: Boolean(rotatedSecret),
      },
    })

    return ok({ connectorId: connector.id, name: connector.name })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update API connector')
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
    temperature?: number
    maxTokens?: number
  }
}) {
  try {
    const user = await requireRole('admin')
    const parsed = createAgentSchema.parse(input)
    await services.platformSettings.assertModelAllowed(
      parsed.modelConfig.provider,
      parsed.modelConfig.model,
    )
    const result = await repositories.agents.create({
      ...parsed,
      createdById: user.id,
      tenantId: user.tenantId,
      status: 'draft',
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create agent')
  }
}

export async function updateAgentInstruction(input: {
  agentId: string
  roleInstruction?: string
  behaviorProfile?: string
}) {
  try {
    const user = await requireRole('admin')
    const parsed = updateAgentInstructionSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!agent) return fail('Agent not found')
    const result = await repositories.agents.updateInstruction(parsed)

    const changed = [
      result.roleChanged ? 'roleInstruction' : null,
      result.behaviorChanged ? 'behaviorProfile' : null,
    ].filter(Boolean)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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

export async function updateAgentPersona(input: {
  agentId: string
  personaNickname?: string
  personaGreeting?: string
  personaTrait?: string
}) {
  try {
    const user = await requireRole('admin')
    const parsed = updateAgentPersonaSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!agent) return fail('Agent not found')

    const updated = await repositories.agents.updatePersona({
      agentId: parsed.agentId,
      ...(parsed.personaNickname !== undefined ? { personaNickname: parsed.personaNickname } : {}),
      ...(parsed.personaGreeting !== undefined ? { personaGreeting: parsed.personaGreeting } : {}),
      ...(parsed.personaTrait !== undefined ? { personaTrait: parsed.personaTrait } : {}),
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const parsed = updateAgentAvatarSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!agent) return fail('Agent not found')

    const nextAvatar = parsed.avatarUrl === '' ? null : parsed.avatarUrl
    await repositories.agents.updateAvatar({ agentId: parsed.agentId, avatarUrl: nextAvatar })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
  modelConfig: { provider: string; model: string; temperature?: number; maxTokens?: number }
}) {
  try {
    const user = await requireRole('admin')
    const parsed = updateAgentModelConfigSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!agent) return fail('Agent not found')
    await services.platformSettings.assertModelAllowed(
      parsed.modelConfig.provider,
      parsed.modelConfig.model,
    )
    const result = await repositories.agents.updateModelConfig(parsed)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: result.agentVersion,
      action: 'agent.version',
      targetType: 'agent',
      targetId: parsed.agentId,
      modelUsed: parsed.modelConfig.model,
      inputRef: null,
      outputRef: `v${result.agentVersion}`,
      policyDecision: 'allowed',
      metadata: { changed: ['modelConfig'], modelConfig: parsed.modelConfig },
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
    const user = await requireRole('admin')
    const parsedResult = updateAgentSelfEvolutionProfileSchema.safeParse(input)
    if (!parsedResult.success) {
      const idResult = agentIdSchema.safeParse({ id: input.agentId })
      if (idResult.success) {
        await repositories.audit.append({
          actorType: 'human',
          actorId: user.id,
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
    const existing = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.updateSelfEvolutionProfile(parsed)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId, user.tenantId)
    if (!agent) return fail('Agent not found')
    const result = await repositories.agents.rotateApiKey(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const { keyId } = agentApiKeyIdSchema.parse(input)
    const key = await prisma.agentApiKey.findUnique({
      where: { id: keyId },
      include: { agent: { select: { tenantId: true } } },
    })
    if (!key || key.agent.tenantId !== user.tenantId) return fail('Agent API key not found')
    const result = await repositories.agents.revokeApiKey(keyId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const profiles = await repositories.behaviorProfiles.findMany(user.tenantId)
    return ok(profiles)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list behavior profiles')
  }
}

export async function getBehaviorProfile(input: { profileId: string }) {
  try {
    const user = await requireRole('admin')
    const { profileId } = behaviorProfileIdSchema.parse(input)
    const [profile, referrers] = await Promise.all([
      repositories.behaviorProfiles.findByIdWithVersions(profileId, user.tenantId),
      repositories.behaviorProfiles.listReferrers(profileId, user.tenantId),
    ])
    if (!profile) return fail('Behavior profile not found')
    return ok({ profile, referrers })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load behavior profile')
  }
}

export async function createBehaviorProfile(input: { name: string; body: string }) {
  try {
    const user = await requireRole('admin')
    const parsed = createBehaviorProfileSchema.parse(input)
    const profile = await repositories.behaviorProfiles.create({
      name: parsed.name,
      body: parsed.body,
      tenantId: user.tenantId,
      approvedById: user.id,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const parsed = updateBehaviorProfileSchema.parse(input)
    // I7: új al-verzió, de a hivatkozó agentek élő viselkedése NEM változik —
    // ahhoz külön `acceptBehaviorProfileUpdate` kell.
    const result = await repositories.behaviorProfiles.update({
      profileId: parsed.profileId,
      body: parsed.body,
      approvedById: user.id,
      tenantId: user.tenantId,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const parsed = acceptBehaviorProfileUpdateSchema.parse(input)
    const body = await repositories.behaviorProfiles.getVersionBody(
      parsed.profileId,
      parsed.profileVersion,
      user.tenantId,
    )
    if (body === null) return fail('Behavior profile version not found')

    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
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
      actorId: user.id,
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
    const user = await requireRole('admin')
    const parsed = setAgentBehaviorProfileSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!agent) return fail('Agent not found')

    let profileVersion: number | null = null
    let profileBody: string | null = null
    let profileName: string | null = null

    if (parsed.profileId) {
      const profile = await repositories.behaviorProfiles.findByIdWithVersions(
        parsed.profileId,
        user.tenantId,
      )
      if (!profile) return fail('Behavior profile not found')
      const body = await repositories.behaviorProfiles.getVersionBody(
        parsed.profileId,
        profile.currentVersion,
        user.tenantId,
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
      actorId: user.id,
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
    const user = await requireRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const agent = await repositories.agents.findById(agentId, user.tenantId)
    if (!agent) return fail('Agent not found')
    const result = await repositories.agents.activate(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const parsed = suspendAgentSchema.parse(input)
    const existing = await repositories.agents.findById(parsed.agentId, user.tenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.suspend(parsed.agentId, parsed.reason)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const existing = await repositories.agents.findById(agentId, user.tenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.resume(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const existing = await repositories.agents.findById(agentId, user.tenantId)
    if (!existing) return fail('Agent not found')
    const agent = await repositories.agents.retire(agentId)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('admin')
    const { id } = agentIdSchema.parse(input)
    const existing = await repositories.agents.findById(id, user.tenantId)
    if (!existing) return fail('Agent not found')
    const deleted = await repositories.agents.delete(id)

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
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
    const user = await requireRole('operator')
    const file = formData.get('file')
    const textOverride = formData.get('text')

    let filename = 'upload.txt'
    let extractedText = ''
    let mimeType: string | null = null
    // KB-v3 §7.3 — formátumfüggő extraction: normalizált markdown +
    // forrás-provenance-os szeletek (PDF oldal / DOCX section / XLSX cella).
    let extraction: StructuredExtraction | null = null

    if (typeof textOverride === 'string' && textOverride.trim()) {
      extractedText = textOverride
      filename = 'paste.txt'
      mimeType = 'text/plain'
      extraction = extractTextContent(textOverride)
    } else if (file instanceof File) {
      filename = safeUploadFilename(file.name)
      mimeType = file.type || null
      if (file.type.startsWith('image/')) {
        const buffer = Buffer.from(await file.arrayBuffer())
        extractedText = `[image:${file.type}]${buffer.toString('base64')}`
      } else {
        extraction = await extractStructured({
          buffer: Buffer.from(await file.arrayBuffer()),
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
    await writeFile(absolutePath, extractedText)

    const document = await repositories.documents.create({
      filename,
      storageRef,
      extractedText,
      status: 'uploaded',
      connectorId: null,
      uploadedById: user.id,
      mimeType,
      // A szeletek (§4.7 forrás-refekkel) a metadata-ba kerülnek; az OKF-artifact
      // generáláskor innen épül a bundle. Régi doksin nincs → heading-split fallback.
      ...(extraction ? { metadata: { extraction: toExtractionMetadata(extraction) } } : {}),
    })

    return ok(document)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Upload failed')
  }
}

export async function processDocument(input: { documentId: string; agentId: string }) {
  try {
    const user = await requireRole('operator')
    const parsed = processDocumentSchema.parse(input)
    const result = await services.bookkeeper.processDocument(
      parsed.documentId,
      parsed.agentId,
      user.id,
    )
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Processing failed')
  }
}

export async function processDocumentForWiki(input: { documentId: string; agentId: string }) {
  try {
    const user = await requireRole('operator')
    const parsed = processDocumentForWikiSchema.parse(input)

    const document = await repositories.documents.findById(parsed.documentId)
    if (!document) return fail('Document not found')

    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
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
      actorId: user.id,
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
    await requireRole('operator')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })

    const agent = await repositories.agents.findById(agentId)
    if (!agent) return fail('Agent not found')
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
export async function requestKbDocument(input: { documentId: string; agentId: string }) {
  try {
    const user = await requireRole('operator')
    const parsed = requestKbDocumentSchema.parse(input)
    const ticket = await services.knowledgeBase.requestDocument({
      agentId: parsed.agentId,
      documentId: parsed.documentId,
      createdById: user.id,
    })
    return ok(ticket)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to request KB document')
  }
}

/** Jóváhagyás után a dokumentum bekerül a KB-be és kereshetővé válik. */
export async function approveKbDocument(input: { ticketId: string }) {
  try {
    const user = await requireRole('approver')
    const parsed = kbTicketSchema.parse(input)
    const document = await services.knowledgeBase.approveDocument({
      ticketId: parsed.ticketId,
      approverId: user.id,
      approverRole: user.role,
    })
    return ok(document)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve KB document')
  }
}

export async function rejectKbDocument(input: { ticketId: string }) {
  try {
    const user = await requireRole('approver')
    const parsed = kbTicketSchema.parse(input)
    const result = await services.knowledgeBase.rejectDocument({
      ticketId: parsed.ticketId,
      approverId: user.id,
      approverRole: user.role,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to reject KB document')
  }
}

export async function listKbDocumentRequests(input: { agentId: string }) {
  try {
    await requireRole('operator')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const pending = await services.knowledgeBase.listPendingDocuments(agentId)
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
    await requireRole('operator')
    const parsed = kbArtifactReviewSchema.parse(input)
    const review = await services.knowledgeBase.getArtifactReview({
      agentId: parsed.agentId,
      documentId: parsed.documentId,
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
    const user = await requireRole('operator')
    const parsed = shareKnowledgeBaseSchema.parse(input)
    if (parsed.agentId === parsed.targetAgentId) {
      return fail('Source and target agents are the same')
    }

    const source = await repositories.agents.findById(parsed.agentId)
    if (!source) return fail('Source agent not found')
    if (source.role === 'orchestrator') {
      return fail('Orchestrator agents do not use a knowledge base')
    }

    const target = await repositories.agents.findById(parsed.targetAgentId)
    if (!target) return fail('Target agent not found')
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
      actorId: user.id,
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
    const user = await requireRole('operator')
    const parsed = shareKnowledgeBaseSchema.parse(input)
    if (parsed.agentId === parsed.targetAgentId) {
      return fail('Cannot revoke the owner agent from its own knowledge base')
    }

    const source = await repositories.agents.findById(parsed.agentId)
    if (!source) return fail('Source agent not found')
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
      actorId: user.id,
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
    await requireRole('operator')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })

    const agent = await repositories.agents.findById(agentId)
    if (!agent) return fail('Agent not found')
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
    const user = await requireRole('operator')
    const parsed = deleteKbDocumentSchema.parse(input)

    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
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
      actorId: user.id,
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
    const user = await requireRole('operator')
    const parsed = askWikiSchema.parse(input)
    const result = await services.wiki.askWiki({
      ...parsed,
      createdById: user.id,
      tenantId: user.tenantId,
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
    await requireRole('viewer')
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
    const user = await requireRole('operator')
    const parsed = generateReportSchema.parse(input)
    const template = getReportTemplate(parsed.templateId)
    if (!template) return fail('Unknown report template')

    const ticket = await services.wiki.generateReport({
      agentId: parsed.agentId,
      template,
      createdById: user.id,
    })

    return ok({ ticketId: ticket.id })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to generate report')
  }
}

export async function promoteToTicket(input: { conversationId: string; reason?: string }) {
  try {
    const user = await requireRole('operator')
    const parsed = promoteToTicketSchema.parse(input)
    const { messages } = await services.conversations.getConversation(
      parsed.conversationId,
      user.tenantId,
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
      createdById: user.id,
      reason: parsed.reason ?? 'approval',
      answerPayload,
      agentMessageId: lastAgent.id,
    })

    return ok({ ticketId: ticket.id, ticket })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Promote to ticket failed')
  }
}

export async function getConversation(input: { conversationId: string }) {
  try {
    const user = await requireRole('viewer')
    const { conversationId } = conversationIdSchema.parse(input)
    const data = await services.conversations.getConversation(conversationId, user.tenantId)
    return ok(data)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get conversation')
  }
}

export async function sendAgentMessage(input: {
  agentId: string
  content: string
  conversationId?: string
  attachmentDocumentIds?: string[]
}) {
  try {
    const user = await requireRole('operator')
    const parsed = sendAgentMessageSchema.parse(input)
    const result = await services.agentChat.sendMessage({
      ...parsed,
      createdById: user.id,
      tenantId: user.tenantId,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Agent message failed')
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
    const user = await requireRole('operator')
    const parsed = createAgentTaskTicketSchema.parse(input)
    const executeAfter = parsed.executeAfter ? new Date(parsed.executeAfter) : null
    const ticket = await services.agentChat.createTaskTicket({
      agentId: parsed.agentId,
      content: parsed.content,
      conversationId: parsed.conversationId,
      attachmentDocumentIds: parsed.attachmentDocumentIds,
      executeAfter,
      authorizeRunAs: parsed.authorizeRunAs,
      createdById: user.id,
      tenantId: user.tenantId,
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
  recurrence?: 'none' | 'daily' | 'weekly' | 'monthly'
  maxRuns?: number | null
  authorizeRunAs?: boolean
}) {
  try {
    const user = await requireRole('operator')
    const parsed = createScheduledAgentTaskSchema.parse(input)
    const scheduledTask = await services.scheduledTasks.createAgentTask({
      agentId: parsed.agentId,
      title: parsed.title,
      content: parsed.content,
      conversationId: parsed.conversationId,
      attachmentDocumentIds: parsed.attachmentDocumentIds,
      nextRunAt: new Date(parsed.nextRunAt),
      recurrence: parsed.recurrence,
      maxRuns: parsed.maxRuns,
      authorizeRunAs: parsed.authorizeRunAs,
      createdById: user.id,
      tenantId: user.tenantId,
    })
    return ok({ scheduledTaskId: scheduledTask.id, scheduledTask })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Scheduled task creation failed')
  }
}

export async function loadAgentChatMessages(input: { conversationId: string; agentId: string }) {
  try {
    const user = await requireRole('viewer')
    const { conversationId, agentId } = loadAgentChatSchema.parse(input)
    const { conversation, messages } = await services.conversations.getConversation(
      conversationId,
      user.tenantId,
    )
    if (conversation.agentId !== agentId) return fail('Conversation agent mismatch')

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
        text: parsed.text,
        attachments,
        createdAt: message.createdAt.toISOString(),
        contentDeletedAt,
        ticketRefId: message.ticketRefId,
      })
    }

    return ok({
      conversationId,
      conversation: {
        id: conversation.id,
        status: conversation.status,
        title: conversation.title,
        lastMessageAt: conversation.lastMessageAt.toISOString(),
      },
      messages: views,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load chat messages')
  }
}

export async function listAgentChatSessions(input: { agentId: string; status?: 'active' | 'archived' | 'all' }) {
  try {
    const user = await requireRole('viewer')
    const { agentId, status = 'active' } = listAgentChatSessionsSchema.parse(input)
    const rows = await prisma.conversation.findMany({
      where: {
        agentId,
        createdById: user.id,
        tenantId: user.tenantId,
        ...(status === 'all' ? {} : { status }),
      },
      orderBy: { lastMessageAt: 'desc' },
      take: 50,
      include: {
        messages: {
          where: { role: 'user', contentDeletedAt: null },
          orderBy: { seq: 'asc' },
          take: 1,
          select: { contentRef: true },
        },
      },
    })
    const sessions = rows.map(({ messages, ...conversation }) => {
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
    return ok({ sessions })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list chat sessions')
  }
}

export async function deleteMessageContent(input: { messageId: string }) {
  try {
    const user = await requireRole('admin')
    const { messageId } = messageIdSchema.parse(input)
    const updated = await services.conversations.deleteMessageContent({
      messageId,
      actorId: user.id,
      tenantId: user.tenantId,
      reason: 'ui-message-delete',
    })
    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete message content')
  }
}

export async function createSandboxReport(input: { ticketId: string }) {
  try {
    const user = await requireRole('operator')
    const parsed = createSandboxReportSchema.parse(input)
    const app = await services.sandboxApps.createOrVersionWikiReport(parsed.ticketId, {
      userId: user.id,
      tenantId: user.tenantId,
    })
    return ok(app)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create sandbox report')
  }
}

export async function getSandboxReportForTicket(input: { ticketId: string }) {
  try {
    const user = await requireRole('viewer')
    const parsed = createSandboxReportSchema.parse(input)
    const app = await services.sandboxApps.getLatestForTicket(parsed.ticketId, {
      userId: user.id,
      tenantId: user.tenantId,
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
    const user = await requireRole('operator')
    const parsed = createSandboxAppSchema.parse(input)
    const result = await services.sandboxApps.createSandboxApp(parsed, {
      userId: user.id,
      tenantId: user.tenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to create sandbox app')
  }
}

export async function upsertSandboxAppVersion(input: z.infer<typeof upsertSandboxAppVersionSchema>) {
  try {
    const user = await requireRole('operator')
    const parsed = upsertSandboxAppVersionSchema.parse(input)
    const result = await services.sandboxApps.upsertSandboxAppVersion(parsed, {
      userId: user.id,
      tenantId: user.tenantId,
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
    const user = await requireRole('operator')
    const parsed = activateSandboxAppVersionSchema.parse(input)
    const result = await services.sandboxApps.activateSandboxAppVersion(parsed, {
      userId: user.id,
      tenantId: user.tenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to activate sandbox app version')
  }
}

export async function listSandboxApps(input: z.infer<typeof listSandboxAppsSchema>) {
  try {
    const user = await requireRole('viewer')
    const parsed = listSandboxAppsSchema.parse(input)
    const result = await services.sandboxApps.listSandboxApps(parsed, {
      userId: user.id,
      tenantId: user.tenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to list sandbox apps')
  }
}

export async function getSandboxApp(input: z.infer<typeof getSandboxAppSchema>) {
  try {
    const user = await requireRole('viewer')
    const parsed = getSandboxAppSchema.parse(input)
    const result = await services.sandboxApps.getSandboxApp(parsed, {
      userId: user.id,
      tenantId: user.tenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to get sandbox app')
  }
}

export async function getSandboxAppRegistryMetrics() {
  try {
    const user = await requireRole('viewer')
    const result = await services.sandboxApps.getRegistryMetrics({
      userId: user.id,
      tenantId: user.tenantId,
    })
    return ok(result)
  } catch (e) {
    return sandboxAppFail(e, 'Failed to load app registry metrics')
  }
}

export async function getSandboxAppPreviewUrl(input: z.infer<typeof sandboxAppPreviewUrlSchema>) {
  try {
    const user = await requireRole('viewer')
    const parsed = sandboxAppPreviewUrlSchema.parse(input)
    const result = await services.sandboxApps.getSandboxAppPreviewUrl(parsed, {
      userId: user.id,
      tenantId: user.tenantId,
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
    const user = await requireRole('operator')
    const parsed = createTrainingSchema.parse(input)
    const ticket = await services.training.createTrainingTicket({
      ...parsed,
      createdById: user.id,
    })
    return ok(ticket)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create training ticket')
  }
}

export async function approveTraining(input: { ticketId: string; overrideEval?: boolean }) {
  try {
    const user = await requireRole('approver')
    const parsed = approveTrainingSchema.parse(input)
    const result = await services.training.approveTraining(parsed.ticketId, user.id, {
      overrideEval: parsed.overrideEval,
    })
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve training')
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
    const actor = await requirePermission('user.read')
    const users = await services.iam.listUsers(actor.tenantId)
    return ok(users)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list users')
  }
}

export async function listInvitations() {
  try {
    const actor = await requirePermission('user.read')
    const invitations = await services.iam.listInvitations(actor.tenantId)
    return ok(invitations)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list invitations')
  }
}

export async function inviteUser(input: { email: string; role: string }) {
  try {
    const actor = await requirePermission('user.invite')
    const parsed = inviteUserSchema.parse(input)
    const email = parsed.email.trim().toLowerCase()

    // Clerk-natív gating: regisztrálni csak meghívóval lehet (Dashboard → Restrictions:
    // "sign-ups restricted to invitations"). A Clerk-meghívó hordozza a szerepkört a
    // publicMetadata-ban; a `user.created` webhook ebből állítja be — nincs külön beváltó lépés.
    let clerkInvited = false
    if (isClerkEnabled()) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
      const client = await clerkClient()
      await client.invitations.createInvitation({
        emailAddress: email,
        publicMetadata: { role: parsed.role },
        notify: true,
        ignoreExisting: true,
        ...(appUrl ? { redirectUrl: `${appUrl}/sign-up` } : {}),
      })
      clerkInvited = true
    }

    // In-app napló + token-alapú beváltás (spec-tesztelt domain folyamat, dev/fallback útvonal).
    const result = await services.iam.inviteUser({
      email,
      role: parsed.role,
      createdById: actor.id,
      tenantId: actor.tenantId,
    })
    // A nyers token CSAK most adható vissza. Clerk-módban e-mail ment ki, a token csak
    // belső fallback — a UI ennek megfelelően jelzi, hogy nem kell kézzel megosztani.
    return ok({ invitationId: result.invitation.id, token: result.rawToken, clerkInvited })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to invite user')
  }
}

export async function revokeInvitation(input: { invitationId: string }) {
  try {
    const actor = await requirePermission('user.invite.revoke')
    const parsed = revokeInvitationSchema.parse(input)
    const updated = await services.iam.revokeInvitation({
      invitationId: parsed.invitationId,
      actorId: actor.id,
      actorTenantId: actor.tenantId,
    })
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
    const actor = await requirePermission('user.approve')
    const parsed = approveUserSchema.parse(input)
    const updated = await services.iam.approveUser({
      targetUserId: parsed.targetUserId,
      role: parsed.role,
      actorId: actor.id,
      actorTenantId: actor.tenantId,
    })
    return ok({ userId: updated.id, role: updated.role, status: updated.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to approve user')
  }
}

export async function changeUserRole(input: { targetUserId: string; newRole: string }) {
  try {
    const actor = await requirePermission('user.role.write')
    const parsed = changeUserRoleSchema.parse(input)

    // A DB a jog forrása (N-IAM-1): a self-edit/lock-out/tenant-izoláció döntést a
    // service hozza meg ELŐSZÖR — a Clerk-metadata csak ezután, sikeres döntés után
    // szinkronizál, különben egy elutasított (pl. lock-out) demóció mégis bekerülhetne
    // a Clerk publicMetadata-ba, és a következő bejelentkezéskor visszaszivárogna a DB-be.
    const updated = await services.iam.changeRole({
      targetUserId: parsed.targetUserId,
      newRole: parsed.newRole,
      actorId: actor.id,
      actorTenantId: actor.tenantId,
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
    const actor = await requirePermission('user.suspend')
    const parsed = suspendUserSchema.parse(input)
    const updated = await services.iam.suspendUser({
      targetUserId: parsed.targetUserId,
      reason: parsed.reason,
      actorId: actor.id,
      actorTenantId: actor.tenantId,
    })
    return ok({ userId: updated.id, status: updated.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to suspend user')
  }
}

export async function reactivateUser(input: { targetUserId: string }) {
  try {
    const actor = await requirePermission('user.suspend')
    const parsed = reactivateUserSchema.parse(input)
    const updated = await services.iam.reactivateUser({
      targetUserId: parsed.targetUserId,
      actorId: actor.id,
      actorTenantId: actor.tenantId,
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
    const actor = await requirePermission('user.role.write')
    const parsed = setUserJobDescriptionSchema.parse(input)
    const updated = await services.iam.setJobDescription({
      targetUserId: parsed.targetUserId,
      jobDescription: parsed.jobDescription ?? null,
      actorId: actor.id,
      actorTenantId: actor.tenantId,
    })
    return ok({ userId: updated.id, jobDescription: updated.jobDescription })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update user description')
  }
}

/** GET/PATCH /permissions (§6) — a deklaratív permission-mátrix. */
export async function getPermissionMatrix() {
  try {
    await requirePermission('user.permission.write')
    const matrix = await services.iam.getPermissionMatrix()
    return ok(matrix)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load permission matrix')
  }
}

export async function updateRolePermission(input: { permissionKey: string; minRole: string }) {
  try {
    const actor = await requirePermission('user.permission.write')
    const parsed = updateRolePermissionSchema.parse(input)
    const updated = await services.iam.updatePermission({
      permissionKey: parsed.permissionKey,
      minRole: parsed.minRole,
      actorId: actor.id,
    })
    return ok(updated)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update permission')
  }
}

const ACCESS_AUDIT_ACTIONS = [
  'user.invite.issue',
  'user.invite.redeem',
  'user.invite.revoke',
  'user.selfregister',
  'user.role.assign',
  'user.role.change',
  'user.suspend',
  'user.reactivate',
  'user.permission.update',
  'user.authz.deny',
]

/** GET /audit/access (§6) — kizárólag a hozzáférési audit-eseménytípusok (§8.5). */
export async function getAccessAuditLog(input?: { limit?: number }) {
  try {
    await requirePermission('audit.read')
    const entries = await repositories.audit.findMany({
      action: ACCESS_AUDIT_ACTIONS,
      limit: input?.limit ?? 200,
    })
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
    await requireRole('admin')
    const parsed = createEvalSchema.parse(input)
    const evalDef = await services.eval.create(parsed)
    return ok(evalDef)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create eval')
  }
}

export async function runEval(input: { evalId: string; agentId: string; proposedContent: string }) {
  try {
    await requireRole('approver')
    const parsed = runEvalSchema.parse(input)
    const agent = await repositories.agents.findById(parsed.agentId)
    if (!agent) return fail('Agent not found')
    const evalRun = await services.eval.run({
      evalId: parsed.evalId,
      proposedContent: parsed.proposedContent,
      agentVersion: agent.currentVersion,
      trigger: 'manual',
    })
    return ok(evalRun)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to run eval')
  }
}

export async function listEvalsForAgent(input: { agentId: string }) {
  try {
    await requireRole('viewer')
    const evals = await services.eval.findAllForAgent(input.agentId)
    return ok(evals)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list evals')
  }
}

export async function rollbackMemory(input: { agentId: string; toVersion: number }) {
  try {
    const user = await requireRole('approver')
    const parsed = rollbackMemorySchema.parse(input)
    const memoryVersion = await services.training.rollbackMemory(
      parsed.agentId,
      parsed.toVersion,
      user.id,
    )
    return ok(memoryVersion)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Rollback failed')
  }
}

export async function listAuditLog(input?: z.infer<typeof listAuditLogSchema>) {
  try {
    await requireRole('approver')
    const parsed = input ? listAuditLogSchema.parse(input) : {}
    const entries = await repositories.audit.findMany({
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
    await requireRole('operator')
    const parsed = archiveSandboxAppSchema.parse(input)
    const user = await getCurrentUser()
    if (!user) throw new Error('Not authenticated')
    const result = await services.sandboxApps.archiveSandboxApp(parsed, {
      userId: user.id,
      tenantId: user.tenantId,
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
    await requireRole('viewer')
    const { range } = costSummarySchema.parse({ range: input?.range })
    const summary = await repositories.modelCalls.getCostSummary(rangeToSince(range))
    return ok(summary)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get cost summary')
  }
}

export async function verifyAuditChain() {
  try {
    await requireRole('approver')
    const result = await services.auditChain.verifyChain()
    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Verification failed')
  }
}

export async function exportAuditSiem(input?: { since?: string }) {
  try {
    await requireRole('admin')
    const since = input?.since ? new Date(input.since) : undefined
    const jsonLines = await services.auditChain.exportJsonLines(since)
    return ok({ content: jsonLines, filename: `audit-siem-${new Date().toISOString().slice(0, 10)}.jsonl` })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Export failed')
  }
}

export async function listWorkspaceTenants() {
  try {
    await requireRole('admin')
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
    const actor = await requireRole('admin')
    const normalized = tenantId.trim()
    if (!normalized) return fail('Tenant ID is required')

    const deleted = await services.workspaceLifecycle.purgeTenantWorkspaces(normalized)
    await repositories.audit.append({
      actorType: 'human',
      actorId: actor.id,
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
    await requireRole('viewer')
    const since = new Date(new Date().setHours(0, 0, 0, 0))
    const [agents, tickets, cost, tools] = await Promise.all([
      repositories.agents.findMany(),
      repositories.tickets.findMany({
        state: ['backlog', 'ready', 'approved', 'in_progress', 'awaiting_human'],
        excludeTest: true,
      }),
      repositories.modelCalls.getCostSummary(since),
      repositories.toolBroker.getToolSummary(since),
    ])

    return ok({
      activeAgents: agents.filter((a) => a.status === 'active').length,
      openTickets: tickets.length,
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
    await requireRole('viewer')
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
    await requireRole('operator')
    const controls = await services.platformSettings.getDispatcherControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read dispatcher controls')
  }
}

export async function getTicketTypeConfigs() {
  try {
    await ensureActiveDatabaseMode()
    await requireRole('operator')
    const configs = await services.platformSettings.getTicketTypeConfigs()
    return ok(configs)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read ticket type configs')
  }
}

export async function getModelPolicy() {
  try {
    await ensureActiveDatabaseMode()
    await requireRole('operator')
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
    const actor = await requireRole('admin')
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
    from: 'backlog' | 'ready' | 'approved' | 'in_progress' | 'awaiting_human' | 'done' | 'rejected'
    to: 'backlog' | 'ready' | 'approved' | 'in_progress' | 'awaiting_human' | 'done' | 'rejected'
    allowed: 'system' | 'agent' | 'approver' | 'operator' | 'admin' | 'system_or_operator'
  }>
}) {
  try {
    await ensureActiveDatabaseMode()
    const actor = await requireRole('admin')
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
    const actor = await requireRole('admin')
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

export async function getDatabaseMode() {
  try {
    await ensureActiveDatabaseMode()
    await requireRole('operator')
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
    const actor = await requireRole('admin')
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
    const actor = await requireRole('admin')
    syncTestDatabaseSchema.parse(input)
    const result = await services.platformSettings.syncTestDatabaseFromProduction(actor.id)
    const syncStatus = await services.platformSettings.getDatabaseSyncStatus()
    return ok({ result, syncStatus })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to sync test database')
  }
}

const WORKSPACE_TOOLS = [
  'file_read', 'file_write', 'create_html', 'file_edit', 'file_list', 'file_glob',
  'file_search', 'file_delete',
  'xlsx_read_sheet', 'xlsx_write_cells', 'xlsx_append_rows',
  'xlsx_create', 'xlsx_format_range', 'xlsx_layout',
  'pptx_create',
  'docx_read', 'pdf_read', 'pdf_create',
] as const

const SANDBOX_APP_TOOLS = [
  'sandbox_app.create',
  'sandbox_app.update_artifact',
  'sandbox_app.preview',
  'sandbox_app.export',
] as const

const BOARD_TOOLS = ['ticket_create', 'board_write'] as const

const CONFIGURABLE_AGENT_TOOLS = [
  ...WORKSPACE_TOOLS,
  ...SANDBOX_APP_TOOLS,
  ...BOARD_TOOLS,
  'gmail_search',
  'gmail_get_message',
  'gmail_create_draft',
  'gmail_send',
  'agent_catalog',
  'agent_resolve',
  'user_directory',
  'agent_ask',
  'http_api_get',
  'http_api_request',
  'web_search',
] as const

const CONFIGURABLE_AGENT_TOOL_SET = new Set<string>(CONFIGURABLE_AGENT_TOOLS)

export async function updateAgentCapabilities(input: {
  agentId: string
  enabledTools: string[]
}) {
  try {
    const user = await requireRole('admin')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })

    const agent = await repositories.agents.findById(agentId, user.tenantId)
    if (!agent) return fail('Agent not found')

    const allTools = [...new Set(input.enabledTools)].filter((toolName) =>
      CONFIGURABLE_AGENT_TOOL_SET.has(toolName),
    )
    const enabledSet = new Set(allTools)
    const needsWorkspace = WORKSPACE_TOOLS.some((t) => enabledSet.has(t))
    const needsWebSearch = enabledSet.has('web_search')
    const needsBoard = [...SANDBOX_APP_TOOLS, ...BOARD_TOOLS].some((t) => enabledSet.has(t))

    if (agent.role === 'orchestrator' && allTools.length > 0) {
      await repositories.audit.append({
        actorType: 'human',
        actorId: user.id,
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

    if (needsWorkspace) {
      const workspaceConnector = await prisma.connector.findFirst({
        where: { type: 'workspace', OR: [{ tenantId: user.tenantId }, { tenantId: null }] },
      })
      if (!workspaceConnector) return fail('Workspace connector nem található a rendszerben.')

      await prisma.agentConnector.upsert({
        where: {
          agentId_connectorId: { agentId, connectorId: workspaceConnector.id },
        },
        create: { agentId, connectorId: workspaceConnector.id, accessMode: 'write' },
        update: { accessMode: 'write' },
      })
    }

    if (needsWebSearch) {
      const webSearchConnector = await prisma.connector.findFirst({
        where: {
          type: 'web_search',
          lifecycleState: 'active',
          OR: [{ tenantId: user.tenantId }, { tenantId: null }],
        },
        orderBy: { createdAt: 'asc' },
      })
      if (!webSearchConnector) return fail('Aktív Web Search connector nem található a rendszerben.')

      await prisma.agentConnector.upsert({
        where: {
          agentId_connectorId: { agentId, connectorId: webSearchConnector.id },
        },
        create: { agentId, connectorId: webSearchConnector.id, accessMode: 'read' },
        update: { accessMode: 'read' },
      })
    }

    // A sandbox_app.* toolok a `board` connectort igénylik (TOOL_REQUIREMENTS).
    // A normál agentek ezt seedből megkapják; itt idempotensen biztosítjuk, hogy
    // az App Registry jog engedélyezésekor a link garantáltan meglegyen.
    if (needsBoard) {
      const boardConnector = await prisma.connector.findFirst({
        where: {
          type: 'board',
          lifecycleState: 'active',
          OR: [{ tenantId: user.tenantId }, { tenantId: null }],
        },
        orderBy: { createdAt: 'asc' },
      })
      if (!boardConnector) return fail('Aktív Board connector nem található a rendszerben.')

      await prisma.agentConnector.upsert({
        where: {
          agentId_connectorId: { agentId, connectorId: boardConnector.id },
        },
        create: { agentId, connectorId: boardConnector.id, accessMode: 'write' },
        update: { accessMode: 'write' },
      })
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
      actorId: user.id,
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
        workspaceLinked: needsWorkspace,
        webSearchLinked: needsWebSearch,
        boardLinked: needsBoard,
      } as Prisma.JsonValue,
    })

    return ok({
      updatedCount: allTools.length,
      workspaceLinked: needsWorkspace,
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
    await requireRole('operator')
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
    await requireRole('admin')
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
    await requireRole('admin')
    await repositories.modelRoutingPolicies.delete(input.id)
    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete routing policy')
  }
}

// ── Model Gateway: Budgets (Fázis 2-A) ──────────────────────────────────────

export async function listModelBudgets() {
  try {
    await requireRole('operator')
    const budgets = await repositories.modelBudgets.list()
    return ok(budgets)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list model budgets')
  }
}

export async function createModelBudget(input: {
  scope: 'tenant' | 'agent' | 'ticket_type'
  scopeRef?: string
  period: 'day' | 'week' | 'month'
  callLimit?: number
  tokenLimit?: number
  softThreshold?: number
  hardCap?: boolean
  tenantId?: string
}) {
  try {
    await requireRole('admin')
    const budget = await repositories.modelBudgets.create({
      tenantId: input.tenantId ?? null,
      scope: input.scope,
      scopeRef: input.scopeRef ?? null,
      period: input.period,
      callLimit: input.callLimit ?? null,
      tokenLimit: input.tokenLimit ?? null,
      softThreshold: input.softThreshold != null ? new (await import('@prisma/client')).Prisma.Decimal(input.softThreshold) : null,
      hardCap: input.hardCap ?? true,
    })
    return ok(budget)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create model budget')
  }
}

export async function deleteModelBudget(input: { id: string }) {
  try {
    await requireRole('admin')
    await repositories.modelBudgets.delete(input.id)
    return ok({ deleted: true })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to delete model budget')
  }
}

// ── Model Gateway: Observability summary ────────────────────────────────────

export async function getModelCallsSummary(input?: { sinceHours?: number }) {
  try {
    await requireRole('operator')
    const since = input?.sinceHours
      ? new Date(Date.now() - input.sinceHours * 60 * 60 * 1000)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
    const [summary, breakdown] = await Promise.all([
      repositories.modelCalls.getGovernanceSummary(since),
      repositories.modelCalls.getPerTicketBreakdown(since, 20),
    ])
    return ok({ summary, breakdown, sinceHours: input?.sinceHours ?? 168 })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load model calls summary')
  }
}
