'use server'

import { mkdir, writeFile } from 'fs/promises'
import path from 'path'
import { clerkClient } from '@clerk/nextjs/server'
import { getCurrentUser, requireRole } from '@/auth'
import { hasMinimumRole } from '@/auth/types'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { isClerkEnabled } from '@/lib/clerk-config'
import { prisma } from '@/lib/db'
import { ensureAgentKnowledgeBase } from '@/lib/agent-knowledge-base'
import { buildTicketDisplayExtras, enrichTicketsForBoard } from '@/lib/ticket-display'
import { fail, ok, type ActionResult } from '@/lib/result'
import {
  agentIdSchema,
  approveTrainingSchema,
  createEvalSchema,
  runEvalSchema,
  costSummarySchema,
  createSandboxReportSchema,
  createAgentSchema,
  updateAgentInstructionSchema,
  updateAgentModelConfigSchema,
  updateAgentSelfEvolutionProfileSchema,
  createTrainingSchema,
  askWikiSchema,
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
  rollbackMemorySchema,
  ticketFilterSchema,
  ticketIdSchema,
  transitionTicketSchema,
  inviteUserSchema,
  redeemInvitationSchema,
  changeUserRoleSchema,
  setUserStatusSchema,
  setDispatcherControlsSchema,
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
    const [assigneeUser, creator] = await Promise.all([
      ticket.assigneeType === 'human' && ticket.assigneeId
        ? prisma.user.findUnique({ where: { id: ticket.assigneeId }, select: { name: true } })
        : Promise.resolve(null),
      prisma.user.findUnique({ where: { id: ticket.createdById }, select: { name: true } }),
    ])

    const display = buildTicketDisplayExtras(ticket, {
      assigneeAgentName: assigneeAgent?.name ?? null,
      assigneeUserName: assigneeUser?.name ?? null,
      responsibleAgentName:
        responsibleAgent && responsibleAgent.id !== ticket.assigneeId
          ? responsibleAgent.name
          : assigneeAgent?.name ?? responsibleAgent?.name ?? null,
    })

    return ok({
      ...ticket,
      reproduction,
      ...display,
      creator: {
        id: ticket.createdById,
        label: creator?.name ?? 'Ismeretlen',
      },
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
    await requireRole('viewer')
    return ok(await repositories.agents.findMany())
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list agents')
  }
}

export async function getAgent(input: { id: string }) {
  try {
    await requireRole('viewer')
    const { id } = agentIdSchema.parse(input)
    const detail = await repositories.agents.findByIdWithDetails(id)
    if (!detail) return fail('Agent not found')
    return ok(detail)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get agent')
  }
}

export async function getAgentGovernance(input: { agentId: string }) {
  try {
    await requireRole('viewer')
    const { id: agentId } = agentIdSchema.parse({ id: input.agentId })
    const [capabilities, connectors] = await Promise.all([
      repositories.toolBroker.findCapabilitiesForAgent(agentId),
      repositories.toolBroker.findConnectorsForAgent(agentId),
    ])
    return ok({ capabilities, connectors })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to get agent governance')
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
    const result = await repositories.agents.create({
      ...parsed,
      createdById: user.id,
    })

    await repositories.audit.append({
      actorType: 'human',
      actorId: user.id,
      agentVersion: 1,
      action: 'agent.create',
      targetType: 'agent',
      targetId: result.agent.id,
      modelUsed: null,
      inputRef: null,
      outputRef: result.agent.name,
      policyDecision: 'allowed',
      metadata: { role: result.agent.role },
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

export async function updateAgentModelConfig(input: {
  agentId: string
  modelConfig: { provider: string; model: string; temperature?: number; maxTokens?: number }
}) {
  try {
    const user = await requireRole('admin')
    const parsed = updateAgentModelConfigSchema.parse(input)
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
    const parsed = updateAgentSelfEvolutionProfileSchema.parse(input)
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

export async function deleteAgent(input: { id: string }) {
  try {
    const user = await requireRole('admin')
    const { id } = agentIdSchema.parse(input)
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

    if (typeof textOverride === 'string' && textOverride.trim()) {
      extractedText = textOverride
      filename = 'paste.txt'
    } else if (file instanceof File) {
      filename = safeUploadFilename(file.name)
      if (file.type.startsWith('image/')) {
        const buffer = Buffer.from(await file.arrayBuffer())
        extractedText = `[image:${file.type}]${buffer.toString('base64')}`
      } else {
        extractedText = await file.text()
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

    const kbConnector =
      (await ensureAgentKnowledgeBase(agent)) ??
      (await repositories.toolBroker.findConnectorForAgent(
        parsed.agentId,
        'knowledge_base',
        'read',
      ))
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

    const kbConnector =
      (await ensureAgentKnowledgeBase(agent)) ??
      (await repositories.toolBroker.findConnectorForAgent(
        agentId,
        'knowledge_base',
        'read',
      ))
    if (!kbConnector) return ok([])

    const documents = await repositories.documents.findByConnectorId(kbConnector.id)
    return ok(documents)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list documents')
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
    const messages = await services.agentChat.getConversationMessages(
      conversationId,
      user.tenantId,
      agentId,
    )
    return ok({ conversationId, messages })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to load chat messages')
  }
}

export async function listAgentChatSessions(input: { agentId: string }) {
  try {
    const user = await requireRole('viewer')
    const { agentId } = listAgentChatSessionsSchema.parse(input)
    const sessions = await services.agentChat.listSessions({
      agentId,
      createdById: user.id,
      tenantId: user.tenantId,
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

// ── IAM / RBAC (Epik 2) ────────────────────────────────────────────────────

export async function listUsers() {
  try {
    await requireRole('admin')
    const users = await services.iam.listUsers()
    return ok(users)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list users')
  }
}

export async function listInvitations() {
  try {
    await requireRole('admin')
    const invitations = await services.iam.listInvitations()
    return ok(invitations)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list invitations')
  }
}

export async function inviteUser(input: { email: string; role: string }) {
  try {
    const actor = await requireRole('admin')
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
    })
    // A nyers token CSAK most adható vissza. Clerk-módban e-mail ment ki, a token csak
    // belső fallback — a UI ennek megfelelően jelzi, hogy nem kell kézzel megosztani.
    return ok({ invitationId: result.invitation.id, token: result.rawToken, clerkInvited })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to invite user')
  }
}

export async function redeemInvitation(input: { token: string; name?: string }) {
  try {
    const current = await getCurrentUser()
    if (!current) return fail('Unauthorized')
    const parsed = redeemInvitationSchema.parse(input)
    const user = await services.iam.redeemInvitation({
      token: parsed.token,
      externalAuthId: current.externalAuthId,
      name: parsed.name ?? current.name,
    })
    return ok({ userId: user.id, role: user.role })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to redeem invitation')
  }
}

export async function changeUserRole(input: { targetUserId: string; newRole: string }) {
  try {
    const actor = await requireRole('admin')
    const parsed = changeUserRoleSchema.parse(input)

    if (parsed.targetUserId === actor.id) {
      return fail('lockout: admin cannot change own role')
    }

    const target = await prisma.user.findUnique({
      where: { id: parsed.targetUserId },
      select: { externalAuthId: true, role: true, status: true },
    })
    if (!target) return fail('user: not found')

    if (target.role === 'admin' && parsed.newRole !== 'admin' && target.status === 'active') {
      const otherActiveAdmins = await prisma.user.count({
        where: { role: 'admin', status: 'active', id: { not: parsed.targetUserId } },
      })
      if (otherActiveAdmins === 0) {
        return fail('lockout: last active admin cannot be removed')
      }
    }

    if (isClerkEnabled()) {
      const client = await clerkClient()
      const clerkUser = await client.users.getUser(target.externalAuthId)
      await client.users.updateUser(target.externalAuthId, {
        publicMetadata: { ...clerkUser.publicMetadata, role: parsed.newRole },
      })
    }

    const updated = await services.iam.changeRole({
      targetUserId: parsed.targetUserId,
      newRole: parsed.newRole,
      actorId: actor.id,
    })
    return ok({ userId: updated.id, role: updated.role })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to change role')
  }
}

export async function setUserStatus(input: { targetUserId: string; status: string }) {
  try {
    const actor = await requireRole('admin')
    const parsed = setUserStatusSchema.parse(input)
    const updated = await services.iam.setStatus({
      targetUserId: parsed.targetUserId,
      status: parsed.status,
      actorId: actor.id,
    })
    return ok({ userId: updated.id, status: updated.status })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to change user status')
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

export async function listAuditLog(input?: { limit?: number }) {
  try {
    await requireRole('approver')
    const entries = await repositories.audit.findMany({ limit: input?.limit ?? 100 })
    return ok(entries)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list audit log')
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
  'sandbox_app.version',
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

    const [model, tools, transitions, sandboxCounts, chain, breakdown, toolByTicket, tickets] =
      await Promise.all([
        repositories.modelCalls.getGovernanceSummary(since),
        repositories.toolBroker.getToolSummary(since),
        repositories.tickets.getTransitionStats(since),
        repositories.audit.getActionCounts({ actions: [...SANDBOX_AUDIT_ACTIONS], since }),
        services.auditChain.verifyChain(),
        repositories.modelCalls.getPerTicketBreakdown(since, 25),
        repositories.toolBroker.getToolCallCountsByTicket(since),
        repositories.tickets.findMany(),
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
        versions: sandboxCounts['sandbox_app.version'] ?? 0,
        previews: sandboxCounts['sandbox_app.preview'] ?? 0,
        exports: sandboxCounts['sandbox_app.export'] ?? 0,
        accessDenied: sandboxCounts['sandbox_app.access_denied'] ?? 0,
      },
      chain,
      perTicket,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to build governance report')
  }
}

export async function getDispatcherControls() {
  try {
    await requireRole('operator')
    const controls = await services.platformSettings.getDispatcherControls()
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to read dispatcher controls')
  }
}

export async function setDispatcherControls(input: {
  enabled?: boolean
  pollIntervalSeconds?: number
}) {
  try {
    const actor = await requireRole('admin')
    const parsed = setDispatcherControlsSchema.parse(input)
    const controls = await services.platformSettings.setDispatcherControls(
      {
        enabled: parsed.enabled,
        pollIntervalMs:
          parsed.pollIntervalSeconds !== undefined ? parsed.pollIntervalSeconds * 1000 : undefined,
      },
      actor.id,
    )
    return ok(controls)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to update dispatcher controls')
  }
}
