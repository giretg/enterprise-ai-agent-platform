/**
 * Platform Surrogate Engine: Postgres vault + hash-láncolt unknown-álnév audit.
 * A Tool Broker ezt kapja (APG-04); a feloldás (APG-05) ugyanerre az instance-ra épül.
 */
import type { AuditRepository } from '@/repositories/interfaces'
import { SurrogateEngine } from '@/domain/privacy/surrogate-engine'
import { PostgresSurrogateVault } from '@/domain/privacy/surrogate-vault'
import { resolveTenantPrivacyHmacKey } from '@/domain/privacy/tenant-hmac-key'

export function createPlatformSurrogateEngine(audit: AuditRepository): SurrogateEngine {
  return new SurrogateEngine(new PostgresSurrogateVault(resolveTenantPrivacyHmacKey), {
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
  })
}
