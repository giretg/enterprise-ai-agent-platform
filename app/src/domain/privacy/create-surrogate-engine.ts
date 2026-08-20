/**
 * Platform Surrogate Engine: Postgres vault + hash-láncolt privacy-audit.
 * A Tool Broker ezt kapja (APG-04); a feloldás (APG-05/APG-08) ugyanerre az instance-ra épül.
 */
import type { AuditRepository, ConversationRepository, TicketRepository } from '@/repositories/interfaces'
import { recordPrivacyGatewayAudit, summaryFromSurrogate } from '@/domain/privacy/privacy-audit'
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
        await recordPrivacyGatewayAudit(audit, {
          action: event.action,
          tenantId: event.tenantId,
          scope: event.scope,
          summary: summaryFromSurrogate(event.surrogate),
          reason: event.reason,
          surrogate: event.surrogate,
        })
      },
      async recordResolveDenied(event) {
        await recordPrivacyGatewayAudit(audit, {
          action: event.action,
          tenantId: event.tenantId,
          scope: event.scope,
          summary: summaryFromSurrogate(event.surrogate),
          reason: event.reason,
          surrogate: event.surrogate,
          actorType: event.requesterUserId ? 'human' : 'system',
          actorId: event.requesterUserId ?? null,
        })
      },
    },
    new ConversationPrivacyResolveAccess(conversations, tickets),
  )
}
