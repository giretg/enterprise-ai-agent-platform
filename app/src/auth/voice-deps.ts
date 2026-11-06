import { canViewAgent, MCP_AGENT_ID_HEADER } from '@/auth/mcp-server'
import { voiceAllowedToolAliases } from '@/auth/voice-tool-guard'
import { services } from '@/domain/gateway-services'
import { chatTokenKeyFromEnv } from '@/domain/platform-chat/chat-token'
import { createOpenAiLiveProvider } from '@/domain/voice/openai-live'
import type { VoiceSessionDeps } from '@/domain/voice/session'
import { isDispatchable } from '@/lib/agent-lifecycle'
import { prisma } from '@/lib/db'
import { loadOpenAiTenantKey } from '@/lib/openai-tenant-key'
import { repositories } from '@/repositories/postgres'

export function voiceSessionDeps(publicOrigin: string): VoiceSessionDeps {
  return {
    signingKey: chatTokenKeyFromEnv(),
    publicOrigin,
    agentHeaderName: MCP_AGENT_ID_HEADER,
    allowedTools: voiceAllowedToolAliases(),
    provider: createOpenAiLiveProvider(),
    loadTenantSlug: async (tenantId) => (await repositories.tenants.findById(tenantId))?.slug ?? null,
    loadAgent: async ({ tenantId, agentId }) => repositories.agents.findById(agentId, tenantId),
    loadUsableDefinition: async (input) => {
      const definition = await services.agentDefinitions.loadAgentDefinition({ tenantId: input.tenantId, agentId: input.agentId })
      if (!definition || !isDispatchable(definition.status) || !(await canViewAgent(input))) return null
      return { snapshot: definition.snapshot }
    },
    loadApiKey: loadOpenAiTenantKey,
    audit: repositories.audit,
  }
}

/** Az OpenAI két óránál tovább nem tart nyitva beszélgetést, ezért ennél régebbi indítást nem kell keresni. */
const VOICE_SESSION_LOOKBACK_MS = 3 * 60 * 60 * 1000

export function voiceSessionEndDeps() {
  return {
    audit: repositories.audit,
    sessionAwaitsEnd: async (input: { tenantId: string; userId: string; agentId: string; sessionId: string }) => {
      const rows = await prisma.auditLog.findMany({
        where: {
          tenantId: input.tenantId,
          actorId: input.userId,
          targetId: input.agentId,
          action: { in: ['voice.session_started', 'voice.session_ended'] },
          createdAt: { gte: new Date(Date.now() - VOICE_SESSION_LOOKBACK_MS) },
          metadata: { path: ['sessionId'], equals: input.sessionId },
        },
        select: { action: true },
        take: 2,
      })
      return rows.length === 1 && rows[0].action === 'voice.session_started'
    },
  }
}
