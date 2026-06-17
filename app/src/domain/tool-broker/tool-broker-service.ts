import type {
  AssigneeType,
  Connector,
  ConnectorAccessMode,
  ConnectorGrant,
  ConnectorType,
  Prisma,
  Ticket,
  TicketState,
  ToolCallStatus,
} from '@prisma/client'
import { prisma } from '@/lib/db'
import { personaFor } from '@/lib/agent-persona'
import {
  buildAgentCatalogEntry,
  scoreAgentForCatalogQuery,
  type AgentCatalogEntry,
} from '@/lib/agent-catalog'
import { readDelegationPayload, shouldCompleteDelegation } from '@/lib/delegation-payload'
import { GmailApiClient } from '@/domain/connector-grant/gmail-api-client'
import type { ConnectorGrantService } from '@/domain/connector-grant/connector-grant-service'
import type {
  AgentRepository,
  AuditRepository,
  ConnectorGrantRepository,
  TicketRepository,
  ToolBrokerRepository,
} from '@/repositories/interfaces'
import type { TicketService } from '@/domain/ticket/ticket-service'

export type KbSearchArgs = {
  query: string
  k?: number
}

export type KbSearchHit = {
  docId: string
  snippet: string
  sourceRef: string
  memoryVersion: number | null
}

export type KbSearchResult = {
  hits: KbSearchHit[]
}

export type BoardWriteArgs = {
  ticketId: string
  patch: {
    state?: TicketState
    payload?: Record<string, unknown>
  }
}

export type BoardWriteResult = {
  ok: boolean
  ticketId: string
  state: TicketState
}

export type TicketCreateArgs = {
  title: string
  payload: Record<string, unknown>
  assigneeType: AssigneeType
  assigneeId?: string
  sourceDocumentId?: string
}

export type TicketCreateResult = {
  ok: boolean
  ticketId: string
  state: TicketState
  assigneeType: AssigneeType
  assigneeId: string | null
}

export type AgentAskArgs = {
  targetAgentId: string
  question: string
  context?: Record<string, unknown>
}

export type AgentAskResult = {
  ok: boolean
  ticketId: string
  state: TicketState
  targetAgentId: string
  requesterAgentId: string
}

export type AgentResolveArgs = {
  query: string
  limit?: number
}

export type AgentResolveHit = {
  agentId: string
  name: string
  nickname: string
  role: string
  trait: string
  score: number
}

export type AgentResolveResult = {
  agents: AgentResolveHit[]
}

export type AgentCatalogArgs = {
  query?: string
  agentId?: string
  limit?: number
}

export type AgentCatalogResult = {
  agents: AgentCatalogEntry[]
}

export type GmailSearchArgs = { query: string; maxResults?: number }
export type GmailGetMessageArgs = { id: string }
export type GmailCreateDraftArgs = {
  to: string
  subject: string
  body: string
  threadId?: string
}
export type GmailSendArgs = {
  draftId?: string
  to?: string
  subject?: string
  body?: string
  approvalTicketId?: string
}

export type GmailSearchResult = { messages: Array<Record<string, string>> }
export type GmailGetMessageResult = Record<string, string>
export type GmailCreateDraftResult = { draftId: string }
export type GmailSendResult = { messageId: string }

type ToolInvokeBase = {
  agentId: string
  agentVersion: number
  ticketId?: string
  conversationId?: string
  actingUserId?: string
}

export type ToolBrokerInvokeInput =
  | (ToolInvokeBase & { tool: 'kb_search'; args: KbSearchArgs })
  | (ToolInvokeBase & { tool: 'board_write'; args: BoardWriteArgs })
  | (ToolInvokeBase & { tool: 'ticket_create'; args: TicketCreateArgs })
  | (ToolInvokeBase & { tool: 'agent_ask'; args: AgentAskArgs })
  | (ToolInvokeBase & { tool: 'agent_resolve'; args: AgentResolveArgs })
  | (ToolInvokeBase & { tool: 'agent_catalog'; args: AgentCatalogArgs })
  | (ToolInvokeBase & { tool: 'gmail_search'; args: GmailSearchArgs })
  | (ToolInvokeBase & { tool: 'gmail_get_message'; args: GmailGetMessageArgs })
  | (ToolInvokeBase & { tool: 'gmail_create_draft'; args: GmailCreateDraftArgs })
  | (ToolInvokeBase & { tool: 'gmail_send'; args: GmailSendArgs })

export type ToolBrokerInvokeResult =
  | {
      denied: true
      reason: string
      latencyMs: number
    }
  | {
      denied: false
      result:
        | KbSearchResult
        | BoardWriteResult
        | TicketCreateResult
        | AgentAskResult
        | AgentResolveResult
        | AgentCatalogResult
        | GmailSearchResult
        | GmailGetMessageResult
        | GmailCreateDraftResult
        | GmailSendResult
      resultMeta: Record<string, unknown>
      latencyMs: number
    }

type ToolName = ToolBrokerInvokeInput['tool']

type AuthorizationResult =
  | { allowed: true; connector: Connector; grant?: ConnectorGrant; actingUserId?: string }
  | { allowed: false; reason: string; connector?: Connector }

const TOOL_REQUIREMENTS: Record<
  ToolName,
  { connectorType: ConnectorType; accessMode: ConnectorAccessMode }
> = {
  kb_search: { connectorType: 'knowledge_base', accessMode: 'read' },
  board_write: { connectorType: 'board', accessMode: 'write' },
  ticket_create: { connectorType: 'board', accessMode: 'write' },
  agent_ask: { connectorType: 'board', accessMode: 'write' },
  agent_resolve: { connectorType: 'board', accessMode: 'read' },
  agent_catalog: { connectorType: 'board', accessMode: 'read' },
  gmail_search: { connectorType: 'gmail', accessMode: 'read' },
  gmail_get_message: { connectorType: 'gmail', accessMode: 'read' },
  gmail_create_draft: { connectorType: 'gmail', accessMode: 'write' },
  gmail_send: { connectorType: 'gmail', accessMode: 'write' },
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
}

// Magyar ragoz\u00e1s \u00e1thidal\u00e1sa: a tokeneket egy r\u00f6vid sz\u00f3t\u0151re v\u00e1gjuk, \u00edgy a
// k\u00e9rd\u00e9sbeli ragozott alak (pl. "gatewayeken", "m\u0171veleteinek") egyezik a
// dokumentumbeli alapalakkal ("gateway", "m\u0171velet"). Nyers r\u00e9szstring helyett
// prefix-bucket egyez\u00e9st haszn\u00e1lunk, ami a recallt jav\u00edtja keyword keres\u00e9sn\u00e9l.
const STEM_LENGTH = 4

function stemToken(token: string): string {
  return token.length <= STEM_LENGTH ? token : token.slice(0, STEM_LENGTH)
}

function snippet(value: string): string {
  return value.length > 280 ? `${value.slice(0, 277)}...` : value
}

function argsMeta(input: ToolBrokerInvokeInput): Record<string, unknown> {
  const base = {
    ticketId: input.ticketId ?? null,
    conversationId: input.conversationId ?? null,
    actingUserId: input.actingUserId ?? null,
  }

  if (input.tool === 'kb_search') {
    return { ...base, queryLength: input.args.query.length, k: input.args.k ?? 5 }
  }

  if (input.tool === 'ticket_create') {
    return {
      ...base,
      titleLength: input.args.title.length,
      assigneeType: input.args.assigneeType,
      assigneeId: input.args.assigneeId ?? null,
      parentTicketId: input.ticketId ?? null,
      payloadKeys: Object.keys(input.args.payload).sort(),
    }
  }

  if (input.tool === 'agent_ask') {
    return {
      ...base,
      targetAgentId: input.args.targetAgentId,
      questionLength: input.args.question.length,
      parentTicketId: input.ticketId ?? null,
      hasContext: Boolean(input.args.context && Object.keys(input.args.context).length > 0),
    }
  }

  if (input.tool === 'agent_resolve') {
    return {
      ...base,
      queryLength: input.args.query.length,
      limit: input.args.limit ?? 5,
    }
  }

  if (input.tool === 'agent_catalog') {
    return {
      ...base,
      queryLength: input.args.query?.length ?? 0,
      agentId: input.args.agentId ?? null,
      limit: input.args.limit ?? null,
    }
  }

  if (input.tool === 'gmail_search') {
    return { ...base, queryLength: input.args.query.length, maxResults: input.args.maxResults ?? 10 }
  }

  if (input.tool === 'gmail_get_message') {
    return { ...base, messageId: input.args.id }
  }

  if (input.tool === 'gmail_create_draft') {
    return {
      ...base,
      toLength: input.args.to.length,
      subjectLength: input.args.subject.length,
      bodyLength: input.args.body.length,
      hasThreadId: Boolean(input.args.threadId),
    }
  }

  if (input.tool === 'gmail_send') {
    return {
      ...base,
      hasDraftId: Boolean(input.args.draftId),
      approvalTicketId: input.args.approvalTicketId ?? input.ticketId ?? null,
    }
  }

  return {
    ...base,
    ticketId: input.args.ticketId,
    requestedState: input.args.patch.state ?? null,
    payloadKeys: input.args.patch.payload ? Object.keys(input.args.patch.payload).sort() : [],
  }
}

function resultMeta(
  result:
    | KbSearchResult
    | BoardWriteResult
    | TicketCreateResult
    | AgentAskResult
    | AgentResolveResult
    | AgentCatalogResult
    | GmailSearchResult
    | GmailGetMessageResult
    | GmailCreateDraftResult
    | GmailSendResult,
): Record<string, unknown> {
  if ('hits' in result && Array.isArray(result.hits)) {
    return {
      hitCount: result.hits.length,
      memoryVersions: [...new Set(result.hits.map((hit) => hit.memoryVersion))],
    }
  }

  if ('messages' in result && Array.isArray(result.messages)) {
    return { messageCount: result.messages.length }
  }

  if ('agents' in result && Array.isArray(result.agents)) {
    const first = result.agents[0] as { agentId?: string; score?: number } | undefined
    return {
      matchCount: result.agents.length,
      topAgentId: first?.agentId ?? null,
      topScore: first && 'score' in first ? first.score : undefined,
    }
  }

  if ('draftId' in result && typeof result.draftId === 'string') {
    return { draftId: result.draftId }
  }

  if ('messageId' in result && typeof result.messageId === 'string' && !('ticketId' in result)) {
    return { messageId: result.messageId }
  }

  if ('id' in result && 'body' in result) {
    return { messageId: String(result.id) }
  }

  if ('ok' in result && 'ticketId' in result && 'state' in result) {
    return {
      ok: result.ok,
      ticketId: result.ticketId,
      state: result.state,
      assigneeType: 'assigneeType' in result ? result.assigneeType : undefined,
      assigneeId: 'assigneeId' in result ? result.assigneeId : undefined,
      targetAgentId: 'targetAgentId' in result ? result.targetAgentId : undefined,
      requesterAgentId: 'requesterAgentId' in result ? result.requesterAgentId : undefined,
    }
  }

  return {}
}

async function systemUserId(): Promise<string> {
  const user = await prisma.user.findFirst({
    where: { role: 'admin' },
    orderBy: { createdAt: 'asc' },
  })
  if (!user) throw new Error('No system user configured')
  return user.id
}

export interface Authorizer {
  authorize(input: {
    agentId: string
    tool: ToolName
    actingUserId?: string | null
    tenantId?: string | null
  }): Promise<AuthorizationResult>
}

const ORCHESTRATOR_DELEGATION_TOOLS: ToolName[] = [
  'ticket_create',
  'agent_ask',
  'agent_resolve',
  'agent_catalog',
]

export class AllowlistAuthorizer implements Authorizer {
  constructor(
    private tools: ToolBrokerRepository,
    private agents: AgentRepository,
    private grants: ConnectorGrantRepository,
  ) {}

  async authorize(input: {
    agentId: string
    tool: ToolName
    actingUserId?: string | null
    tenantId?: string | null
  }): Promise<AuthorizationResult> {
    const agent = await this.agents.findById(input.agentId)
    if (
      agent?.role === 'orchestrator' &&
      !ORCHESTRATOR_DELEGATION_TOOLS.includes(input.tool)
    ) {
      return { allowed: false, reason: 'orchestrator_tool_less' }
    }

    const capability = await this.tools.findCapability(input.agentId, input.tool)
    if (!capability?.allowed) {
      return { allowed: false, reason: 'capability_not_allowed' }
    }

    const requirement = TOOL_REQUIREMENTS[input.tool]
    const connector = await this.tools.findConnectorForAgent(
      input.agentId,
      requirement.connectorType,
      requirement.accessMode,
    )
    if (!connector) {
      return {
        allowed: false,
        reason: `missing_${requirement.connectorType}_connector_${requirement.accessMode}`,
      }
    }

    if (connector.authMode === 'user_delegated') {
      if (!input.actingUserId) {
        return { allowed: false, reason: 'acting_user_required', connector }
      }

      const user = await prisma.user.findUnique({ where: { id: input.actingUserId } })
      if (!user || user.status === 'suspended') {
        return { allowed: false, reason: 'acting_user_suspended', connector }
      }

      const grant = await this.grants.findActiveGrant({
        tenantId: input.tenantId ?? connector.tenantId ?? null,
        connectorId: connector.id,
        userId: input.actingUserId,
      })
      if (!grant) {
        return { allowed: false, reason: 'connector_grant_missing', connector }
      }

      return { allowed: true, connector, grant, actingUserId: input.actingUserId }
    }

    return { allowed: true, connector }
  }
}

export class ToolBrokerService {
  constructor(
    private agents: AgentRepository,
    private tickets: TicketRepository,
    private tools: ToolBrokerRepository,
    private audit: AuditRepository,
    private ticketService: TicketService,
    private authorizer: Authorizer,
    private grantService: ConnectorGrantService,
  ) {}

  async invoke(input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> {
    const startedAt = Date.now()
    const ticketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId ?? null
    const actingUserId = await this.resolveActingUserId(input)

    const authorization = await this.authorizer.authorize({
      agentId: input.agentId,
      tool: input.tool,
      actingUserId,
    })

    if (!authorization.allowed) {
      return this.recordDenied(input, ticketId, authorization.connector?.id ?? null, authorization.reason, startedAt, actingUserId, null)
    }

    if (input.tool === 'gmail_send') {
      const approved = await this.checkGmailSendApproval(input, input.args)
      if (!approved) {
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector.id,
          'human_approval_required',
          startedAt,
          actingUserId,
          authorization.grant?.id ?? null,
        )
      }
    }

    if (input.tool === 'board_write') {
      const ticket = await this.tickets.findById(input.args.ticketId)
      if (!ticket) {
        return this.recordDenied(input, ticketId, authorization.connector.id, 'ticket_not_found', startedAt, actingUserId, authorization.grant?.id ?? null)
      }
      if (ticket.agentId !== input.agentId) {
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector.id,
          'ticket_not_accessible_for_agent',
          startedAt,
          actingUserId,
          authorization.grant?.id ?? null,
        )
      }
    }

    try {
      const result = await this.executeTool(input, authorization)
      const latencyMs = Date.now() - startedAt
      const meta = resultMeta(result)

      await this.recordCall({
        input,
        ticketId,
        connectorId: authorization.connector.id,
        status: 'ok',
        latencyMs,
        policyDecision: 'allowed',
        resultMeta: meta,
        actingUserId,
        grantId: authorization.grant?.id ?? null,
      })

      return {
        denied: false,
        result,
        resultMeta: meta,
        latencyMs,
      }
    } catch (e) {
      const latencyMs = Date.now() - startedAt
      const message = e instanceof Error ? e.message : 'tool_call_failed'
      await this.recordCall({
        input,
        ticketId,
        connectorId: authorization.connector.id,
        status: 'error',
        latencyMs,
        policyDecision: 'error',
        resultMeta: { error: message },
        actingUserId,
        grantId: authorization.grant?.id ?? null,
      })
      throw e
    }
  }

  private async executeTool(
    input: ToolBrokerInvokeInput,
    authorization: Extract<AuthorizationResult, { allowed: true }>,
  ) {
    if (input.tool === 'kb_search') {
      return this.kbSearch(input.agentId, input.args, authorization.connector)
    }
    if (input.tool === 'board_write') return this.boardWrite(input)
    if (input.tool === 'ticket_create') return this.ticketCreate(input)
    if (input.tool === 'agent_ask') return this.agentAsk(input)
    if (input.tool === 'agent_resolve') return this.agentResolve(input.args)
    if (input.tool === 'agent_catalog') return this.agentCatalog(input.args)

    const accessToken = await this.resolveDelegatedAccessToken(input, authorization)
    const gmail = new GmailApiClient(accessToken)

    if (input.tool === 'gmail_search') {
      const res = await gmail.search(input.args)
      return { messages: res.messages }
    }
    if (input.tool === 'gmail_get_message') {
      return gmail.getMessage(input.args)
    }
    if (input.tool === 'gmail_create_draft') {
      return gmail.createDraft(input.args)
    }
    return gmail.send(input.args)
  }

  private async resolveDelegatedAccessToken(
    input: ToolBrokerInvokeInput,
    authorization: Extract<AuthorizationResult, { allowed: true }>,
  ): Promise<string> {
    if (authorization.connector.authMode !== 'user_delegated' || !authorization.grant) {
      throw new Error('delegated_access_token_requires_grant')
    }
    const actingUserId = authorization.actingUserId ?? (await this.resolveActingUserId(input))
    if (!actingUserId) throw new Error('acting_user_required')
    return this.grantService.resolveAccessToken({
      connector: authorization.connector,
      grantId: authorization.grant.id,
      tokenRef: authorization.grant.tokenRef,
      actingUserId,
    })
  }

  private async resolveActingUserId(input: ToolBrokerInvokeInput): Promise<string | null> {
    if (input.actingUserId) return input.actingUserId

    if (input.conversationId) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: input.conversationId },
      })
      if (conversation) return conversation.createdById
    }

    if (input.ticketId) {
      const ticket = await this.tickets.findById(input.ticketId)
      if (ticket) {
        const payload = isRecord(ticket.payload) ? ticket.payload : null
        if (payload && typeof payload.runAsUserId === 'string' && payload.runAsUserId.trim()) {
          return payload.runAsUserId
        }
        return ticket.createdById
      }
    }

    return null
  }

  private async checkGmailSendApproval(
    input: ToolBrokerInvokeInput,
    args: GmailSendArgs,
  ): Promise<boolean> {
    const approvalTicketId = args.approvalTicketId ?? input.ticketId
    if (!approvalTicketId) return false
    const ticket = await this.tickets.findById(approvalTicketId)
    if (!ticket || ticket.state !== 'approved') return false
    const payload = isRecord(ticket.payload) ? ticket.payload : {}
    const approvedRef = payload.gmailSendApproved
    if (typeof approvedRef !== 'string' || !approvedRef) return false
    return approvedRef === (args.draftId ?? args.to ?? '')
  }

  private async kbSearch(
    agentId: string,
    args: KbSearchArgs,
    connector: Connector,
  ): Promise<KbSearchResult> {
    const detail = await this.agents.findByIdWithDetails(agentId)
    if (!detail) throw new Error('Agent not found')

    const termStems = [
      ...new Set(
        normalizeText(args.query)
          .split(/\s+/)
          .map((term) => term.trim())
          .filter((term) => term.length >= 3)
          .map(stemToken),
      ),
    ]

    const k = args.k ?? 5

    type ScoredChunk = { chunk: string; score: number; docId: string; sourceRef: string; memoryVersion: number | null }

    function scoreChunks(
      text: string,
      docId: string,
      sourceRef: string,
      memoryVersion: number | null,
    ): ScoredChunk[] {
      return text
        .split(/\n{2,}|\n(?=-\s+)/)
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const chunkStems = new Set(
            normalizeText(chunk)
              .split(/\s+/)
              .filter(Boolean)
              .map(stemToken),
          )
          const score = termStems.reduce((sum, stem) => sum + (chunkStems.has(stem) ? 1 : 0), 0)
          return { chunk, score, docId, sourceRef, memoryVersion }
        })
        .filter((item) => item.score > 0)
    }

    const memoryChunks = scoreChunks(
      detail.memoryContent ?? '',
      `memory:${detail.agent.memoryId}`,
      `memory:${detail.agent.memoryId}:v${detail.memoryVersion ?? 'unknown'}`,
      detail.memoryVersion,
    )

    const documents = await this.tools.findDocumentsForConnector(connector.id)
    const docChunks: ScoredChunk[] = documents.flatMap((doc) =>
      scoreChunks(
        doc.extractedText ?? '',
        `doc:${doc.id}`,
        `doc:${doc.id}:${doc.filename}`,
        null,
      ),
    )

    const all = [...memoryChunks, ...docChunks]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)

    return {
      hits: all.map((item) => ({
        docId: item.docId,
        snippet: snippet(item.chunk),
        sourceRef: item.sourceRef,
        memoryVersion: item.memoryVersion,
      })),
    }
  }

  private async boardWrite(
    input: Extract<ToolBrokerInvokeInput, { tool: 'board_write' }>,
  ): Promise<BoardWriteResult> {
    const ticket = await this.tickets.findById(input.args.ticketId)
    if (!ticket) throw new Error('Ticket not found')

    let mergedPayload: Record<string, unknown> = isRecord(ticket.payload) ? { ...ticket.payload } : {}
    if (input.args.patch.payload) {
      Object.assign(mergedPayload, input.args.patch.payload)
    }

    if (
      shouldCompleteDelegation(mergedPayload, input.agentId, ticket.assigneeId, input.args.patch)
    ) {
      return await this.completeDelegationReturn(ticket, mergedPayload, input)
    }

    let current = ticket
    if (input.args.patch.payload) {
      current = await this.tickets.update(current.id, {
        payload: mergedPayload as Prisma.JsonValue,
      })
    }

    if (input.args.patch.state && input.args.patch.state !== current.state) {
      current = await this.ticketService.transition({
        ticketId: current.id,
        toState: input.args.patch.state,
        actor: { type: 'agent', agentId: input.agentId },
        agentVersion: input.agentVersion,
      })
    }

    return { ok: true, ticketId: current.id, state: current.state }
  }

  private async completeDelegationReturn(
    ticket: Ticket,
    mergedPayload: Record<string, unknown>,
    input: Extract<ToolBrokerInvokeInput, { tool: 'board_write' }>,
  ): Promise<BoardWriteResult> {
    const delegation = readDelegationPayload(mergedPayload)
    if (!delegation) throw new Error('Delegation payload missing')

    const requesterId = delegation.requesterAgentId
    const finalPayload: Record<string, unknown> = {
      ...mergedPayload,
      delegationReturned: true,
      answeredByAgentId: input.agentId,
      delegationCompletedAt: new Date().toISOString(),
    }

    if (ticket.lockToken) {
      await this.tickets.releaseDispatchLock(ticket.id, ticket.lockToken)
    }

    const fromState = ticket.state
    const updated = await this.tickets.update(ticket.id, {
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: requesterId,
      agentId: requesterId,
      payload: finalPayload as Prisma.JsonValue,
      lockToken: null,
      lockedAt: null,
    })

    await this.tickets.recordTransition({
      ticketId: ticket.id,
      fromState,
      toState: 'ready',
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      note: `delegation returned to requester ${requesterId}`,
    })

    await this.audit.append({
      actorType: 'agent',
      actorId: input.agentId,
      agentVersion: input.agentVersion,
      action: 'delegation.return',
      targetType: 'ticket',
      targetId: ticket.id,
      modelUsed: null,
      inputRef: requesterId,
      outputRef: 'ready',
      policyDecision: 'allowed',
      metadata: {
        answeredByAgentId: input.agentId,
        requesterAgentId: requesterId,
        parentTicketId: delegation.parentTicketId,
      } as Prisma.JsonValue,
    })

    if (delegation.parentTicketId) {
      await this.mergeDelegationIntoParent(
        delegation.parentTicketId,
        requesterId,
        ticket.id,
        finalPayload,
      )
    }

    return { ok: true, ticketId: updated.id, state: updated.state }
  }

  private async mergeDelegationIntoParent(
    parentTicketId: string,
    requesterId: string,
    childTicketId: string,
    childPayload: Record<string, unknown>,
  ) {
    const parent = await this.tickets.findById(parentTicketId)
    if (!parent) return

    const parentPayload = isRecord(parent.payload) ? parent.payload : {}
    const entry = {
      delegationTicketId: childTicketId,
      question: typeof childPayload.question === 'string' ? childPayload.question : '',
      answer: typeof childPayload.answer === 'string' ? childPayload.answer : null,
      answeredByAgentId: childPayload.answeredByAgentId,
      returnedAt: childPayload.delegationCompletedAt,
    }

    const delegatedAnswers: Prisma.JsonValue[] = Array.isArray(parentPayload.delegatedAnswers)
      ? [...(parentPayload.delegatedAnswers as Prisma.JsonValue[]), entry as Prisma.JsonValue]
      : [entry as Prisma.JsonValue]

    await this.tickets.update(parentTicketId, {
      payload: { ...parentPayload, delegatedAnswers } as Prisma.JsonValue,
      assigneeType: 'agent',
      assigneeId: requesterId,
      agentId: requesterId,
    })
  }

  private async ticketCreate(
    input: Extract<ToolBrokerInvokeInput, { tool: 'ticket_create' }>,
  ): Promise<TicketCreateResult> {
    const { args } = input

    if (args.assigneeType === 'agent') {
      if (!args.assigneeId) throw new Error('assigneeId is required when assigneeType is agent')
      const assignee = await this.agents.findById(args.assigneeId)
      if (!assignee) throw new Error('Assignee agent not found')
    }

    const workerAgentId = args.assigneeType === 'agent' ? args.assigneeId! : input.agentId
    const payload: Record<string, unknown> = {
      ...args.payload,
      source: 'agent_tool',
      createdByAgentId: input.agentId,
    }
    if (input.ticketId) payload.parentTicketId = input.ticketId
    if (input.conversationId) payload.conversationId = input.conversationId
    if (input.actingUserId) payload.runAsUserId = input.actingUserId

    const initialState: TicketState = args.assigneeType === 'agent' ? 'ready' : 'in_progress'

    let ticket = await this.tickets.create({
      type: 'interaction',
      title: args.title,
      state: initialState,
      assigneeType: args.assigneeType,
      assigneeId: args.assigneeType === 'agent' ? args.assigneeId! : null,
      agentId: workerAgentId,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: args.sourceDocumentId ?? null,
      executeAfter: null,
      dueBy: null,
      createdById: await systemUserId(),
    })

    if (args.assigneeType === 'human') {
      ticket = await this.ticketService.transition({
        ticketId: ticket.id,
        toState: 'awaiting_human',
        actor: { type: 'agent', agentId: input.agentId },
        agentVersion: input.agentVersion,
      })
    }

    return {
      ok: true,
      ticketId: ticket.id,
      state: ticket.state,
      assigneeType: args.assigneeType,
      assigneeId: ticket.assigneeId,
    }
  }

  private async agentAsk(
    input: Extract<ToolBrokerInvokeInput, { tool: 'agent_ask' }>,
  ): Promise<AgentAskResult> {
    const question = input.args.question.trim()
    if (!question) throw new Error('Question is required')

    const target = await this.agents.findById(input.args.targetAgentId)
    if (!target) throw new Error('Target agent not found')
    if (target.role === 'orchestrator') {
      throw new Error('Target agent is orchestrator and cannot answer delegated tickets')
    }

    const payload: Record<string, unknown> = {
      delegation: true,
      requesterAgentId: input.agentId,
      question,
      source: 'agent_ask',
    }
    if (input.ticketId) payload.parentTicketId = input.ticketId
    if (input.conversationId) payload.conversationId = input.conversationId
    if (input.args.context && Object.keys(input.args.context).length > 0) {
      payload.context = input.args.context
    }

    const ticket = await this.tickets.create({
      type: 'interaction',
      title: `Delegálás: ${question.slice(0, 80)}`,
      state: 'ready',
      assigneeType: 'agent',
      assigneeId: input.args.targetAgentId,
      agentId: input.args.targetAgentId,
      payload: payload as Prisma.JsonValue,
      sourceDocumentId: null,
      executeAfter: null,
      dueBy: null,
      createdById: await systemUserId(),
    })

    return {
      ok: true,
      ticketId: ticket.id,
      state: ticket.state,
      targetAgentId: input.args.targetAgentId,
      requesterAgentId: input.agentId,
    }
  }

  private async agentResolve(args: AgentResolveArgs): Promise<AgentResolveResult> {
    const query = normalizeText(args.query.trim())
    if (!query) throw new Error('Query is required')

    const limit = args.limit ?? 5
    const all = await this.agents.findMany()

    const scored = all
      .filter((agent) => agent.status === 'active')
      .map((agent) => {
        const persona = personaFor(agent.name)
        const score = scoreAgentForCatalogQuery(agent, args.query)
        return { agent, persona, score }
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)

    return {
      agents: scored.map(({ agent, persona, score }) => ({
        agentId: agent.id,
        name: agent.name,
        nickname: persona.nickname,
        role: agent.role,
        trait: persona.trait,
        score,
      })),
    }
  }

  private async agentCatalog(args: AgentCatalogArgs): Promise<AgentCatalogResult> {
    const limitDefault = args.query?.trim() ? 5 : 25

    if (args.agentId) {
      const entry = await buildAgentCatalogEntry(args.agentId, this.agents, this.tools)
      return { agents: [entry] }
    }

    const all = await this.agents.findMany()
    let candidates = all.filter((agent) => agent.status === 'active')

    if (args.query?.trim()) {
      candidates = candidates
        .map((agent) => ({ agent, score: scoreAgentForCatalogQuery(agent, args.query!) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((row) => row.agent)
    }

    const limit = args.limit ?? limitDefault
    const selected = candidates.slice(0, limit)
    const agents = await Promise.all(
      selected.map((agent) => buildAgentCatalogEntry(agent.id, this.agents, this.tools)),
    )

    return { agents }
  }

  private async recordDenied(
    input: ToolBrokerInvokeInput,
    ticketId: string | null,
    connectorId: string | null,
    reason: string,
    startedAt: number,
    actingUserId: string | null = null,
    grantId: string | null = null,
  ): Promise<ToolBrokerInvokeResult> {
    const latencyMs = Date.now() - startedAt
    await this.recordCall({
      input,
      ticketId,
      connectorId,
      status: 'denied',
      latencyMs,
      policyDecision: reason,
      resultMeta: { denied: true, reason },
      actingUserId,
      grantId,
    })

    return { denied: true, reason, latencyMs }
  }

  private async recordCall(params: {
    input: ToolBrokerInvokeInput
    ticketId: string | null
    connectorId: string | null
    status: ToolCallStatus
    latencyMs: number
    policyDecision: string
    resultMeta: Record<string, unknown>
    actingUserId?: string | null
    grantId?: string | null
  }) {
    const metadata = {
      tool: params.input.tool,
      status: params.status,
      argsMeta: argsMeta(params.input),
      resultMeta: params.resultMeta,
      acting_user_id: params.actingUserId ?? params.input.actingUserId ?? null,
      grant_id: params.grantId ?? null,
    }

    await this.tools.createToolCall({
      agentId: params.input.agentId,
      ticketId: params.ticketId,
      conversationId: params.input.conversationId ?? null,
      connectorId: params.connectorId,
      toolName: params.input.tool,
      status: params.status,
      argsMeta: metadata.argsMeta as Prisma.JsonValue,
      resultMeta: params.resultMeta as Prisma.JsonValue,
      latencyMs: params.latencyMs,
      policyDecision: params.policyDecision,
    })

    const targetType = params.ticketId ? 'ticket' : params.input.conversationId ? 'conversation' : 'tool'
    const targetId = params.ticketId ?? params.input.conversationId ?? params.connectorId

    await this.audit.append({
      actorType: 'agent',
      actorId: params.input.agentId,
      agentVersion: params.input.agentVersion,
      action: params.status === 'denied' ? 'tool.call.denied' : 'tool.call',
      targetType,
      targetId,
      modelUsed: null,
      inputRef: params.input.tool,
      outputRef: params.status,
      policyDecision: params.policyDecision,
      metadata: metadata as Prisma.JsonValue,
    })
  }
}
