import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'
import {
  SurrogateTakenError,
  authenticateValVaultRecord,
  computeSurrogateHmac,
  hmacFieldsFromValInsert,
  type InsertValInput,
  type PrivacyScope,
  type ValVaultRecord,
} from '@/domain/privacy/surrogate-vault'
import type { GatewayValVault } from '@/domain/model-gateway/content-filter'
import { resolveTenantPrivacyHmacKey } from '@/domain/privacy/tenant-hmac-key'

/** A Model Gateway álnév-vaultja (`gateway_surrogates`); a nem hitelesíthető (HMAC) sorokat eldobja. */
export class PostgresGatewaySurrogateRepository implements GatewayValVault {
  async list(tenantId: string, scope: PrivacyScope): Promise<ValVaultRecord[]> {
    const key = resolveTenantPrivacyHmacKey(tenantId)
    const rows = await prisma.gatewaySurrogate.findMany({
      where: { tenantId, scopeType: scope.type, scopeId: scope.id },
      orderBy: { createdAt: 'asc' },
    })
    return rows.flatMap((r) => {
      const record: ValVaultRecord = {
        id: r.id,
        tenantId,
        scopeType: scope.type,
        scopeId: scope.id,
        entityType: r.entityType,
        surrogate: r.surrogate,
        class: 'val',
        connectorId: '',
        sourceId: r.fingerprint,
        hmac: r.hmac,
        encryptedValue: r.encryptedValue,
      }
      return authenticateValVaultRecord(record, key).status === 'hit' ? [record] : []
    })
  }

  async insert(input: InsertValInput): Promise<void> {
    try {
      await prisma.gatewaySurrogate.create({
        data: {
          tenantId: input.tenantId,
          scopeType: input.scope.type,
          scopeId: input.scope.id,
          entityType: input.entityType,
          fingerprint: input.fingerprint,
          surrogate: input.surrogate,
          hmac: computeSurrogateHmac(resolveTenantPrivacyHmacKey(input.tenantId), hmacFieldsFromValInsert(input)),
          encryptedValue: input.encryptedValue,
        },
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new SurrogateTakenError(input.surrogate)
      }
      throw error
    }
  }
}
