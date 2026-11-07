import { productionAiAuditDeps } from '@/auth/ai-audit-deps'
import { canViewAgent, MCP_AGENT_ID_HEADER } from '@/auth/mcp-server'
import { voiceAllowedToolAliases } from '@/auth/voice-tool-guard'
import { recordVoiceTranscript, voiceTranscriptAllowed } from '@/domain/ai-audit/ai-audit-service'
import { services } from '@/domain/gateway-services'
import { chatTokenKeyFromEnv } from '@/domain/platform-chat/chat-token'
import { createElevenLabsProvider } from '@/domain/voice/elevenlabs-agents'
import { createOpenAiLiveProvider } from '@/domain/voice/openai-live'
import type { VoiceSessionDeps } from '@/domain/voice/session'
import { isDispatchable } from '@/lib/agent-lifecycle'
import { prisma } from '@/lib/db'
import { loadElevenLabsTenantKey } from '@/lib/elevenlabs-tenant-key'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { loadOpenAiTenantKey } from '@/lib/openai-tenant-key'
import { repositories } from '@/repositories/postgres'
import { Prisma } from '@prisma/client'
import { MCP_VOICE_CONVERSATION_HEADER } from '@/domain/voice/provider-credential'

export function voiceSessionDeps(publicOrigin: string): VoiceSessionDeps {
  return {
    signingKey: chatTokenKeyFromEnv(),
    publicOrigin,
    agentHeaderName: MCP_AGENT_ID_HEADER,
    allowedTools: voiceAllowedToolAliases(),
    resolveProvider: async ({ tenantId, providerId }) => {
      if (providerId === 'openai_live') return createOpenAiLiveProvider()
      if (!(await isFeatureEnabled('voice.elevenlabs', { tenantId }))) return null
      return createElevenLabsProvider({ conversationHeaderName: MCP_VOICE_CONVERSATION_HEADER })
    },
    loadTenantSlug: async (tenantId) => (await repositories.tenants.findById(tenantId))?.slug ?? null,
    loadAgent: async ({ tenantId, agentId }) => repositories.agents.findById(agentId, tenantId),
    loadUsableDefinition: async (input) => {
      const definition = await services.agentDefinitions.loadAgentDefinition({ tenantId: input.tenantId, agentId: input.agentId })
      if (!definition || !isDispatchable(definition.status) || !(await canViewAgent(input))) return null
      return { snapshot: definition.snapshot }
    },
    loadApiKey: ({ tenantId, providerId }) => (providerId === 'elevenlabs' ? loadElevenLabsTenantKey(tenantId) : loadOpenAiTenantKey(tenantId)),
    // Egyetlen kulcsot ír, így nem írhatja felül az admin közben mentett hang-beállítását.
    saveProviderState: async ({ tenantId, agentId, state }) => {
      await prisma.$executeRaw(
        Prisma.sql`UPDATE agents SET voice_config = jsonb_set(voice_config, '{elevenLabs}', ${JSON.stringify(state)}::jsonb) WHERE id = ${agentId}::uuid AND tenant_id = ${tenantId}::uuid AND voice_config IS NOT NULL`,
      )
    },
    transcriptRecorded: async (input) => voiceTranscriptAllowed(await productionAiAuditDeps().depthFor(input)),
    audit: repositories.audit,
  }
}

/** Az OpenAI két óránál tovább nem tart nyitva beszélgetést, ezért ennél régebbi indítást nem kell keresni. */
const VOICE_SESSION_LOOKBACK_MS = 3 * 60 * 60 * 1000

export function voiceSessionEndDeps() {
  return {
    audit: repositories.audit,
    recordTranscript: (input: Parameters<typeof recordVoiceTranscript>[1]) => recordVoiceTranscript(productionAiAuditDeps(), input),
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
