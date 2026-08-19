/**
 * Platform Surrogate Engine: Postgres vault + hash-láncolt privacy-audit.
 * A Tool Broker ezt kapja (APG-04); a feloldás (APG-05/APG-08) ugyanerre az instance-ra épül.
 */
import type { AuditRepository, ConversationRepository, TicketRepository } from '@/repositories/interfaces'
import { ConversationPrivacyResolveAccess } from '@/domain/privacy/resolve-access'
import { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { PostgresSurrogateVault } from '@/domain/privacy/surrogate-vault'
import { resolveTenantPrivacyHmacKey } from '@/domain/privacy/tenant-hmac-key'

export function createPlatformSurrogateEngine(
  audit: AuditRepository,
  conversations: ConversationRepository,
  tickets: TicketRepository,
): SurrogateEngine {
  return new SurrogateEngine(
    new PostgresSurrogateVault(resolveTenantPrivacyHmacKey),
    {
      async recordUnknownSurrogate(event) {
        await audit.append({
          actorType: 'system',
          actorId: null,
          agentVersion: null,
          action: event.action,
          targetType: event.scope.type,
          targetId: event.scope.id,
          modelUsed: null,
          inputRef: event.surrogate,
          outputRef: event.reason,
          policyDecision: event.reason,
          metadata: {
            tenantId: event.tenantId,
            scopeType: event.scope.type,
          },
          tenantId: event.tenantId,
          conversationId: event.scope.type === 'conversation' ? event.scope.id : null,
        })
      },
      async recordResolveDenied(event) {
        await audit.append({
          actorType: event.requesterUserId ? 'human' : 'system',
          actorId: event.requesterUserId ?? null,
          agentVersion: null,
          action: event.action,
          targetType: event.scope.type,
          targetId: event.scope.id,
          modelUsed: null,
          inputRef: event.surrogate,
          outputRef: event.reason,
          policyDecision: 'denied',
          metadata: {
            tenantId: event.tenantId,
            scopeType: event.scope.type,
            reason: event.reason,
          },
          tenantId: event.tenantId,
          conversationId: event.scope.type === 'conversation' ? event.scope.id : null,
        })
      },
    },
    new ConversationPrivacyResolveAccess(conversations, tickets),
  )
}
