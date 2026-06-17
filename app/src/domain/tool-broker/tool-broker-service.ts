import type {
  Connector,
  ConnectorAccessMode,
  ConnectorType,
  Prisma,
  TicketState,
  ToolCallStatus,
} from '@prisma/client'
import type {
  AgentRepository,
  AuditRepository,
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

export type ToolBrokerInvokeInput =
  | {
      agentId: string
      agentVersion: number
      ticketId?: string
      conversationId?: string
      tool: 'kb_search'
      args: KbSearchArgs
    }
  | {
      agentId: string
      agentVersion: number
      ticketId?: string
      conversationId?: string
      tool: 'board_write'
      args: BoardWriteArgs
    }

export type ToolBrokerInvokeResult =
  | {
      denied: true
      reason: string
      latencyMs: number
    }
  | {
      denied: false
      result: KbSearchResult | BoardWriteResult
      resultMeta: Record<string, unknown>
      latencyMs: number
    }

type ToolName = ToolBrokerInvokeInput['tool']

type AuthorizationResult =
  | { allowed: true; connector: Connector }
  | { allowed: false; reason: string; connector?: Connector }

const TOOL_REQUIREMENTS: Record<
  ToolName,
  { connectorType: ConnectorType; accessMode: ConnectorAccessMode }
> = {
  kb_search: { connectorType: 'knowledge_base', accessMode: 'read' },
  board_write: { connectorType: 'board', accessMode: 'write' },
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
  if (input.tool === 'kb_search') {
    return {
      queryLength: input.args.query.length,
      k: input.args.k ?? 5,
      ticketId: input.ticketId ?? null,
      conversationId: input.conversationId ?? null,
    }
  }

  return {
    ticketId: input.args.ticketId,
    conversationId: input.conversationId ?? null,
    requestedState: input.args.patch.state ?? null,
    payloadKeys: input.args.patch.payload ? Object.keys(input.args.patch.payload).sort() : [],
  }
}

function resultMeta(result: KbSearchResult | BoardWriteResult): Record<string, unknown> {
  if ('hits' in result) {
    return {
      hitCount: result.hits.length,
      memoryVersions: [...new Set(result.hits.map((hit) => hit.memoryVersion))],
    }
  }

  return {
    ok: result.ok,
    ticketId: result.ticketId,
    state: result.state,
  }
}

export interface Authorizer {
  authorize(input: {
    agentId: string
    tool: ToolName
  }): Promise<AuthorizationResult>
}

export class AllowlistAuthorizer implements Authorizer {
  constructor(
    private tools: ToolBrokerRepository,
    private agents: AgentRepository,
  ) {}

  async authorize(input: { agentId: string; tool: ToolName }): Promise<AuthorizationResult> {
    const agent = await this.agents.findById(input.agentId)
    if (agent?.role === 'orchestrator') {
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
  ) {}

  async invoke(input: ToolBrokerInvokeInput): Promise<ToolBrokerInvokeResult> {
    const startedAt = Date.now()
    const ticketId = input.tool === 'board_write' ? input.args.ticketId : input.ticketId ?? null
    const authorization = await this.authorizer.authorize({
      agentId: input.agentId,
      tool: input.tool,
    })

    if (!authorization.allowed) {
      return this.recordDenied(input, ticketId, null, authorization.reason, startedAt)
    }

    if (input.tool === 'board_write') {
      const ticket = await this.tickets.findById(input.args.ticketId)
      if (!ticket) {
        return this.recordDenied(input, ticketId, authorization.connector.id, 'ticket_not_found', startedAt)
      }
      if (ticket.agentId !== input.agentId) {
        return this.recordDenied(
          input,
          ticketId,
          authorization.connector.id,
          'ticket_not_accessible_for_agent',
          startedAt,
        )
      }
    }

    try {
      const result =
        input.tool === 'kb_search'
          ? await this.kbSearch(input.agentId, input.args, authorization.connector)
          : await this.boardWrite(input)
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
      })
      throw e
    }
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

    let current = ticket
    if (input.args.patch.payload) {
      const currentPayload = isRecord(current.payload) ? current.payload : {}
      current = await this.tickets.update(current.id, {
        payload: {
          ...currentPayload,
          ...input.args.patch.payload,
        } as Prisma.JsonValue,
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

  private async recordDenied(
    input: ToolBrokerInvokeInput,
    ticketId: string | null,
    connectorId: string | null,
    reason: string,
    startedAt: number,
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
  }) {
    const metadata = {
      tool: params.input.tool,
      status: params.status,
      argsMeta: argsMeta(params.input),
      resultMeta: params.resultMeta,
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
