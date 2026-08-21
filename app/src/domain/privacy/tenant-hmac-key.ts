/**
 * Tenant HMAC-kulcs a surrogate vault rekordjaihoz (APG-02/APG-04).
 *
 * A gyökérkulcs platformtitok; a tenant-kulcs belőle származik, hogy a
 * leképezések tenantok között ne legyenek korrelálhatók.
 */
import { createHmac } from 'node:crypto'
import { resolveSecret } from '@/lib/crypto/secret-resolver'

const ROOT = resolveSecret(
  ['PRIVACY_SURROGATE_HMAC_KEY', 'WRITE_GATE_SECRET'],
  'dev-privacy-surrogate-hmac-change-in-prod',
)

export function resolveTenantPrivacyHmacKey(tenantId: string): string {
  return createHmac('sha256', ROOT).update(tenantId).digest('hex')
}
