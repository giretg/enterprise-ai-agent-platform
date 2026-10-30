import type { ConnectorGrantService } from './connector-grant-service'
import { GmailApiAuthError } from './gmail-api-client'
import { tenantMailboxOf } from './tenant-mailbox'

export type MailboxFailureDeps = {
  markGrantExpired?: ConnectorGrantService['markGrantExpired']
}

/** A szolgáltató 401-e megszakadt kapcsolat; a 403 lehet egyszerű jogosultsághiány is. */
export async function expireRejectedTenantMailbox(
  deps: MailboxFailureDeps,
  input: {
    connector: { id: string; authMode: string; config?: unknown }
    grantId?: string | null
    userId: string
    tenantId: string
    outcome: unknown
  },
): Promise<boolean> {
  const { outcome } = input
  const unauthorized = outcome instanceof GmailApiAuthError
    ? outcome.status === 401
    : !!outcome && typeof outcome === 'object' && 'status' in outcome && outcome.status === 401
  if (!unauthorized || !input.grantId || !tenantMailboxOf(input.connector)) return false
  await deps.markGrantExpired?.({
    grantId: input.grantId,
    connectorId: input.connector.id,
    actingUserId: input.userId,
    tenantId: input.tenantId,
    metadata: { reason: 'provider_unauthorized' },
  })
  return true
}
