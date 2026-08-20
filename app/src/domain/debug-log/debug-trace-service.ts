import type { PrismaClient } from '@prisma/client'
import type { AuditRepository, ToolBrokerRepository } from '@/repositories/interfaces'
import type { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import type { PrivacyGatewayMode } from '@/domain/privacy/privacy-mode'
import type { ResolvedPrivacyCategoryPolicy } from '@/domain/privacy/privacy-category-policy'
import {
  projectDebugTraceToolOutput,
  type DebugTraceRawBundle,
  type DebugTraceToolOutput,
} from '@/domain/privacy/debug-trace-projection'
import { privacyScopeForCall } from '@/domain/privacy/privacy-scope'
import type { PrivacyResolveAccess } from '@/domain/privacy/resolve-access'

const DEFAULT_TOOL_CALL_LIMIT = 200
const DEFAULT_MODEL_CALL_LIMIT = 100
const DEFAULT_AUDIT_LIMIT = 200

export class DebugTraceService {
  constructor(
    private prisma: PrismaClient,
    private toolBroker: ToolBrokerRepository,
    private audit: AuditRepository,
    /**
     * Feloldási scope-invariáns (spec §10.5 / R14). Ugyanaz a kapu, mint a
     * vault-feloldásé: a trace a beszélgetés TELJES tartalmát tartalmazza, így
     * azonos tenant önmagában nem elég — a kérőnek a beszélgetés jogosult
     * résztvevőjének kell lennie, különben bárki elolvashatná más beszélgetéseit.
     */
    private resolveAccess: PrivacyResolveAccess,
  ) {}

  async getProjectedTrace(params: {
    agentTurnId: string
    tenantId: string | null
    requesterUserId: string | null
    engine: SurrogateEngine
    mode: PrivacyGatewayMode
    policy: ResolvedPrivacyCategoryPolicy
  }): Promise<DebugTraceToolOutput> {
    const raw = await this.loadRawTrace({
      agentTurnId: params.agentTurnId,
      tenantId: params.tenantId,
      requesterUserId: params.requesterUserId,
    })
    return projectDebugTraceToolOutput({
      trace: raw,
      tenantId: params.tenantId ?? raw.tenantId ?? '',
      traceId: params.agentTurnId,
      knownValueScope: privacyScopeForCall(raw.conversationId, null),
      mode: params.mode,
      policy: params.policy,
      engine: params.engine,
    })
  }

  private async loadRawTrace(params: {
    agentTurnId: string
    tenantId: string | null
    requesterUserId: string | null
  }): Promise<DebugTraceRawBundle & { tenantId: string | null }> {
    const turn = await this.prisma.agentTurn.findUnique({
      where: { id: params.agentTurnId },
    })
    if (!turn || !params.tenantId || turn.tenantId !== params.tenantId) {
      throw new Error('agent_turn_not_found')
    }

    const access = await this.resolveAccess.authorize({
      requester: { tenantId: params.tenantId, userId: params.requesterUserId },
      claimedTenantId: params.tenantId,
      scope: { type: 'conversation', id: turn.conversationId },
    })
    if (!access.allowed) {
      // Ugyanaz a hibaüzenet, mint a nem létező fordulóé: a kérő ne tudja
      // kikövetkeztetni idegen beszélgetések azonosítóit.
      throw new Error('agent_turn_not_found')
    }

    const messageIds = [turn.userMessageId, turn.assistantMessageId].filter(
      (id): id is string => Boolean(id),
    )
    const messages =
      messageIds.length > 0
        ? await this.prisma.message.findMany({
            where: { id: { in: messageIds } },
            orderBy: { seq: 'asc' },
          })
        : []

    const decodedMessages = messages.map((message) => ({
      id: message.id,
      role: message.role,
      seq: message.seq,
      content: decodeInlineContent(message.contentRef),
    }))

    const [modelCalls, toolCalls, auditRows] = await Promise.all([
      this.prisma.modelCall.findMany({
        where: { agentTurnId: turn.id },
        orderBy: { createdAt: 'asc' },
        take: DEFAULT_MODEL_CALL_LIMIT,
      }),
      this.toolBroker.listToolCallsForConversation(turn.conversationId, DEFAULT_TOOL_CALL_LIMIT).then(
        (rows) =>
          rows.filter(
            (row) =>
              row.createdAt >= turn.startedAt &&
              (turn.finishedAt == null || row.createdAt <= turn.finishedAt),
          ),
      ),
      this.audit.findMany({
        conversationId: turn.conversationId,
        limit: DEFAULT_AUDIT_LIMIT,
      }),
    ])

    const audit = [...auditRows]
      .filter(
        (row) =>
          row.createdAt >= turn.startedAt &&
          (turn.finishedAt == null || row.createdAt <= turn.finishedAt),
      )
      .reverse()

    return {
      traceId: turn.id,
      agentTurnId: turn.id,
      conversationId: turn.conversationId,
      tenantId: turn.tenantId,
      status: turn.status,
      startedAt: turn.startedAt.toISOString(),
      finishedAt: turn.finishedAt?.toISOString() ?? null,
      partialText: turn.partialText,
      activities: turn.activities,
      turnCount: turn.turnCount,
      toolCallCount: turn.toolCallCount,
      deniedCount: turn.deniedCount,
      reason: turn.reason,
      error: turn.error,
      messages: decodedMessages,
      modelCalls: modelCalls.map((call) => ({
        id: call.id,
        provider: call.provider,
        model: call.model,
        promptTokens: call.promptTokens,
        completionTokens: call.completionTokens,
        cachedPromptTokens: call.cachedPromptTokens,
        latencyMs: call.latencyMs,
        status: call.status,
        createdAt: call.createdAt.toISOString(),
      })),
      toolCalls: toolCalls.map((call) => ({
        id: call.id,
        toolName: call.toolName,
        status: call.status,
        argsMeta: call.argsMeta,
        resultMeta: call.resultMeta,
        policyDecision: call.policyDecision,
        trustClass: call.trustClass,
        outcome: call.outcome,
        latencyMs: call.latencyMs,
        createdAt: call.createdAt.toISOString(),
      })),
      audit: audit.map((row) => ({
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        policyDecision: row.policyDecision,
        createdAt: row.createdAt.toISOString(),
      })),
    }
  }
}

function decodeInlineContent(contentRef: string | null | undefined): string | null {
  if (!contentRef) return null
  if (contentRef.startsWith('inline:')) return contentRef.slice('inline:'.length)
  return null
}
