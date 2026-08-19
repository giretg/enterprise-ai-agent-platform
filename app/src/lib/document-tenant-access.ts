import { prisma } from '@/lib/db'
import { isAgentReachableFromTenant } from '@/lib/tenant-reachability'

/**
 * Dokumentum tenant-határ a feldolgozási/betöltési utakhoz.
 *
 * A `Document`-nek nincs saját `tenantId` oszlopa: a tenant-kötés implicit, két
 * forrásból vezethető le determinisztikusan:
 *   - Már tudásbázishoz (KB-connectorhoz) kötött dokumentum (`connectorId` kitöltve)
 *     → a connector tenantja dönt (megosztott platform-connector mindenkinek elérhető).
 *   - Friss, még be nem kötött dokumentum (`connectorId === null`)
 *     → a FELTÖLTŐ (`uploadedById`) AKTÍV tenant-tagsága adja a jogosultságot.
 *
 * Ez a határ eddig hiányzott a dokumentum-feldolgozó control-plane műveleteken
 * (számla-feldolgozás, wiki-betöltés, KB-jóváhagyás kérése). Mivel ezek pusztán a
 * kliens által küldött `documentId`-t oldották fel tenant-ellenőrzés nélkül, egy
 * tenant operátora egy MÁSIK tenant feltöltött dokumentumát is beköthette a saját
 * agentje tudásbázisába vagy leelemeztethette — cross-tenant adatszivárgás és a
 * forrás-tenant dokumentumának „ellopása" (connector-átkötés). Ez a helper zárja a rést.
 *
 * Fail-closed: ha a kötés egyik forrásból sem igazolható, a hozzáférés tilos. Az
 * opak `Document not found` hiba szándékos — az idegen dokumentum létezése nem
 * válhat felderítési orákulummá (l. {@link assertAgentTenantReachable}).
 */

/** A dokumentum tenant-kötöttségének forrása (DB-feloldás eredménye). */
export type DocumentAttachment =
  | { kind: 'unattached' }
  | { kind: 'connector'; connectorTenantId: string | null }
  | { kind: 'connector-missing' }

/**
 * Tiszta döntési mag (DB-mentes, determinisztikusan tesztelhető). A DB-feloldást a
 * hívó végzi és a már kinyert állapotot adja át.
 */
export function decideDocumentTenantAccess(params: {
  attachment: DocumentAttachment
  /** Csak `unattached` esetben mérvadó: a feltöltőnek van-e AKTÍV tagsága a hívó tenantjában. */
  uploaderHasActiveMembership: boolean
  actorTenantId: string | null
}): boolean {
  switch (params.attachment.kind) {
    case 'connector':
      // Megosztott (tenantId=null) connector mindenkinek elérhető; egyébként tenant-egyezés.
      return isAgentReachableFromTenant(params.attachment.connectorTenantId, params.actorTenantId)
    case 'connector-missing':
      // Bekötött dokumentum, de a connector eltűnt → nincs igazolható tenant → tilos.
      return false
    case 'unattached':
      // Platform-kontextusban (actorTenantId === null) nincs mihez kötni → fail-closed.
      if (!params.actorTenantId) return false
      return params.uploaderHasActiveMembership
  }
}

export async function isDocumentReachableFromTenant(
  doc: { uploadedById: string; connectorId: string | null },
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
    attachment = { kind: 'unattached' }
    if (actorTenantId) {
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
  doc: { uploadedById: string; connectorId: string | null },
  actorTenantId: string | null,
): Promise<void> {
  if (!(await isDocumentReachableFromTenant(doc, actorTenantId))) {
    throw new Error('Document not found')
  }
}
