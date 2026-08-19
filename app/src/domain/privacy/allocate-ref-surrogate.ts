/**
 * Ref-surrogate allokáció: insert, unique ütközésnél a meglévő sor újraolvasása.
 *
 * A sorszámozást és a HMAC-képzést az APG-02 Surrogate Engine adja; ez a függvény
 * csak a DB-szintű bijektivitást tartja: két párhuzamos forduló ugyanarra az
 * entitásra ugyanazt az álnevet kapja, nem duplikátumot.
 */
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

export type AllocateRefSurrogateInput = {
  tenantId: string
  scopeType: 'conversation' | 'trace'
  scopeId: string
  entityType: string
  surrogate: string
  connectorId: string
  sourceId: string
  hmac: string
}

export type AllocatedRefSurrogate = {
  id: string
  surrogate: string
}

function isUniqueCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
}

export async function allocateRefSurrogate(
  input: AllocateRefSurrogateInput,
): Promise<AllocatedRefSurrogate> {
  try {
    return await prisma.surrogateMap.create({
      data: {
        tenantId: input.tenantId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        entityType: input.entityType,
        surrogate: input.surrogate,
        class: 'ref',
        connectorId: input.connectorId,
        sourceId: input.sourceId,
        hmac: input.hmac,
      },
      select: { id: true, surrogate: true },
    })
  } catch (error) {
    if (!isUniqueCollision(error)) throw error
    const existing = await prisma.surrogateMap.findFirst({
      where: {
        tenantId: input.tenantId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        entityType: input.entityType,
        connectorId: input.connectorId,
        sourceId: input.sourceId,
      },
      select: { id: true, surrogate: true },
    })
    if (!existing) throw error
    return existing
  }
}
