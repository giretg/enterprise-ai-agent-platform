import { chatTokenKeyFromEnv, type ChatTokenClaims } from '@/domain/platform-chat/chat-token'
import { resolveVoiceProviderClaims } from '@/domain/voice/provider-credential'
import { prisma } from '@/lib/db'
import { isFeatureEnabled } from '@/lib/feature-flags'
import { repositories } from '@/repositories/postgres'

/** Éles függőségek a hangszolgáltató MCP-kéréseinek ellenőrzéséhez. */
export function productionVoiceProviderClaims(input: {
  credential: string
  tenantSlug: string
  agentId: string | null
  conversationId: string | null
}): Promise<ChatTokenClaims | null> {
  return resolveVoiceProviderClaims(
    {
      signingKey: chatTokenKeyFromEnv(),
      findTenantId: async (tenantSlug) => (await repositories.tenants.findBySlug(tenantSlug))?.id ?? null,
      providerEnabled: ({ tenantId }) => isFeatureEnabled('voice.elevenlabs', { tenantId }),
      loadAgent: ({ tenantId, agentId }) => repositories.agents.findById(agentId, tenantId),
      loadSessionRows: ({ tenantId, agentId, sessionId, since }) =>
        prisma.auditLog.findMany({
          where: {
            tenantId,
            targetId: agentId,
            action: { in: ['voice.session_started', 'voice.session_ended'] },
            createdAt: { gte: since },
            metadata: { path: ['sessionId'], equals: sessionId },
          },
          select: { action: true, actorId: true, createdAt: true, metadata: true },
          take: 2,
        }),
    },
    input,
  )
}
