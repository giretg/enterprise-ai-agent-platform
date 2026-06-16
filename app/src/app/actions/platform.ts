'use server'

import { mkdir, writeFile } from 'fs/promises'
import path from 'path'

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
import { getCurrentUser, requireRole } from '@/auth'
import { services } from '@/domain'
import { repositories } from '@/repositories/postgres'
import { fail, ok, type ActionResult } from '@/lib/result'
import {
  agentIdSchema,
  approveTrainingSchema,
  createEvalSchema,
  runEvalSchema,
  costSummarySchema,
  createSandboxReportSchema,
  createAgentSchema,
  createTrainingSchema,
  askWikiSchema,
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
} from '@/lib/validators/actions'

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

export async function getTicket(input: { id: string }) {
  try {
    await requireRole('viewer')
    const { id } = ticketIdSchema.parse(input)
    const ticket = await repositories.tickets.findById(id)
    if (!ticket) return fail('Ticket not found')
    return ok(ticket)
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
  roleDescription: string
  systemPrompt: string
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
      metadata: null,
    })

    return ok(result)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to create agent')
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
      extractedText = await file.text()
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

    const kbConnector = await repositories.toolBroker.findConnectorForAgent(
      parsed.agentId,
      'knowledge_base',
      'read',
    )
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

    const kbConnector = await repositories.toolBroker.findConnectorForAgent(
      agentId,
      'knowledge_base',
      'read',
    )
    if (!kbConnector) return ok([])

    const documents = await repositories.documents.findByConnectorId(kbConnector.id)
    return ok(documents)
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Failed to list documents')
  }
}

export async function askWiki(input: { agentId: string; question: string }) {
  try {
    const user = await requireRole('operator')
    const parsed = askWikiSchema.parse(input)
    const ticket = await services.wiki.createQuestionTicket({
      ...parsed,
      createdById: user.id,
    })
    const dispatch = await services.dispatcher.dispatchTicket(ticket.id)
    const updated = await repositories.tickets.findById(ticket.id)
    const payload =
      typeof updated?.payload === 'object' && updated.payload !== null && !Array.isArray(updated.payload)
        ? (updated.payload as Record<string, unknown>)
        : {}

    return ok({
      ticketId: ticket.id,
      answer: {
        answer: typeof payload.answer === 'string' ? payload.answer : '',
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        rationale: typeof payload.rationale === 'string' ? payload.rationale : '',
        confidence: typeof payload.confidence === 'string' ? payload.confidence : 'medium',
      },
      ticket: updated,
      dispatch,
    })
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'Wiki question failed')
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
    const user = await requireRole('admin')
    const parsed = inviteUserSchema.parse(input)
    const result = await services.iam.inviteUser({
      email: parsed.email,
      role: parsed.role,
      createdById: user.id,
    })
    // A nyers token CSAK most adható vissza.
    return ok({ invitationId: result.invitation.id, token: result.rawToken })
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

export async function getDashboardStats() {
  try {
    await requireRole('viewer')
    const since = new Date(new Date().setHours(0, 0, 0, 0))
    const [agents, tickets, cost, tools] = await Promise.all([
      repositories.agents.findMany(),
      repositories.tickets.findMany({
        state: ['backlog', 'ready', 'approved', 'in_progress', 'awaiting_human'],
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
