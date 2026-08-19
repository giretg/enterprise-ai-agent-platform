import { prisma } from '@/lib/db'
import { isTenantReachable } from '@/lib/tenant-reachability'

/**
 * Dokumentum tenant-határ a feldolgozási/betöltési utakhoz.
 *
 * A `Document`-nek nincs saját `tenantId` oszlopa: a tenant-kötés implicit, több
 * forrásból vezethető le determinisztikusan:
 *   - Már tudásbázishoz (KB-connectorhoz) kötött dokumentum (`connectorId` kitöltve)
 *     → a connector tenantja dönt (megosztott platform-connector mindenkinek elérhető).
 *   - Friss, még be nem kötött dokumentum (`connectorId === null`):
 *       · ÚJ dok → a feltöltéskor a `metadata.tenantId`-be bélyegzett tenant (PONTOS egyezés).
 *       · LEGACY (bélyeg nélküli) dok → a FELTÖLTŐ aktív tenant-tagsága a fallback.
 *
 * Ez a határ eddig hiányzott a dokumentum-feldolgozó control-plane műveleteken
 * (számla-feldolgozás, wiki-betöltés, KB-jóváhagyás kérése, review-panel). Mivel ezek
 * pusztán a kliens által küldött `documentId`-t oldották fel tenant-ellenőrzés nélkül,
 * egy tenant operátora egy MÁSIK tenant feltöltött dokumentumát is beköthette a saját
 * agentje tudásbázisába, leelemeztethette, vagy a review-panelen a nyers `extractedText`-et
 * kiolvashatta — cross-tenant adatszivárgás és a forrás-tenant dokumentumának „ellopása".
 * Ez a helper zárja a rést.
 *
 * A feltöltéskori tenant-bélyeg (`metadata.tenantId`) a mérvadó: egy több tenanthoz is
 * tartozó feltöltő NEM nyitja meg a dokumentumot mindkét tenant operátorai előtt (a
 * puszta tagság-alapú fallback ezt megtette volna, ezért csak bélyeg nélküli legacy
 * doksin fut).
 *
 * Fail-closed: ha a kötés egyik forrásból sem igazolható, a hozzáférés tilos. Az
 * opak `Document not found` hiba szándékos — az idegen dokumentum létezése nem
 * válhat felderítési orákulummá.
 */

/** A dokumentum tenant-kötöttségének forrása (DB-feloldás eredménye). */
export type DocumentAttachment =
  | { kind: 'unattached'; stampedTenantId: string | null }
  | { kind: 'connector'; connectorTenantId: string | null }
  | { kind: 'connector-missing' }

/**
 * Tiszta döntési mag (DB-mentes, determinisztikusan tesztelhető). A DB-feloldást a
 * hívó végzi és a már kinyert állapotot adja át.
 */
export function decideDocumentTenantAccess(params: {
  attachment: DocumentAttachment
  /** Csak bélyeg nélküli LEGACY `unattached` dokumentumnál mérvadó fallback. */
  uploaderHasActiveMembership: boolean
  actorTenantId: string | null
}): boolean {
  switch (params.attachment.kind) {
    case 'connector':
      // Megosztott (tenantId=null) connector mindenkinek elérhető; egyébként tenant-egyezés.
      return isTenantReachable(params.attachment.connectorTenantId, params.actorTenantId)
    case 'connector-missing':
      // Bekötött dokumentum, de a connector eltűnt → nincs igazolható tenant → tilos.
      return false
    case 'unattached': {
      // Platform-kontextusban (actorTenantId === null) nincs mihez kötni → fail-closed.
      if (!params.actorTenantId) return false
      // Feltöltéskor bélyegzett tenant az igazság: PONTOS egyezés (nincs megosztott ág).
      if (params.attachment.stampedTenantId !== null) {
        return params.attachment.stampedTenantId === params.actorTenantId
      }
      // Legacy (bélyeg nélküli) dok: a feltöltő aktív tagsága a legjobb elérhető közelítés.
      return params.uploaderHasActiveMembership
    }
  }
}

/** A `metadata`-ból kiolvassa a feltöltéskor bélyegzett tenantId-t (ha van). */
export function readStampedTenantId(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const value = (metadata as Record<string, unknown>).tenantId
  return typeof value === 'string' && value.length > 0 ? value : null
}

export async function isDocumentReachableFromTenant(
  doc: { uploadedById: string; connectorId: string | null; metadata?: unknown },
  actorTenantId: string | null,
): Promise<boolean> {
  let attachment: DocumentAttachment
  let uploaderHasActiveMembership = false

  if (doc.connectorId) {
    const connector = await prisma.connector.findUnique({
      where: { id: doc.connectorId },
      select: { tenantId: true },
    })
    attachment = connector
      ? { kind: 'connector', connectorTenantId: connector.tenantId }
      : { kind: 'connector-missing' }
  } else {
    const stampedTenantId = readStampedTenantId(doc.metadata)
    attachment = { kind: 'unattached', stampedTenantId }
    // A tagság-fallback csak bélyeg nélküli legacy doksin számít — csak ott kérdezzük le.
    if (stampedTenantId === null && actorTenantId) {
      const membership = await prisma.tenantMembership.findFirst({
        where: { userId: doc.uploadedById, tenantId: actorTenantId, status: 'active' },
        select: { id: true },
      })
      uploaderHasActiveMembership = membership !== null
    }
  }

  return decideDocumentTenantAccess({ attachment, uploaderHasActiveMembership, actorTenantId })
}

/**
 * Dobó változat a control-plane hívóknak. Opak `Document not found` hibát dob, ha
 * a dokumentum nem érhető el a hívó tenantjából (l. {@link isDocumentReachableFromTenant}).
 */
export async function assertDocumentReachableFromTenant(
  doc: { uploadedById: string; connectorId: string | null; metadata?: unknown },
  actorTenantId: string | null,
): Promise<void> {
  if (!(await isDocumentReachableFromTenant(doc, actorTenantId))) {
    throw new Error('Document not found')
  }
}
