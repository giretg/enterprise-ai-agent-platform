import type { Prisma } from '@prisma/client'
import type { prisma as Db } from '../src/lib/db'
import type { TemplateDescriptor } from '../src/domain/connector-template/template-descriptor'
import { withTemplateIcon } from './template-icons'

/**
 * Kódból seedelt sablonok (v1) beírása a DB-be, helyben frissítve.
 * `tenantSlugByKey`: cégre szabott sablon → csak az adott tenant katalógusába kerül;
 * ha a tenant nem létezik, a sablont kihagyjuk.
 */
export async function syncConnectorTemplates(
  prisma: typeof Db,
  origin: 'builtin' | 'custom',
  descriptors: TemplateDescriptor[],
  tenantSlugByKey: Record<string, string> = {},
): Promise<void> {
  const tenantIdBySlug = new Map<string, string | null>()
  for (const seed of descriptors) {
    const slug = tenantSlugByKey[seed.key]
    let tenantId: string | null = null
    if (slug) {
      if (!tenantIdBySlug.has(slug)) {
        const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true } })
        tenantIdBySlug.set(slug, tenant?.id ?? null)
      }
      tenantId = tenantIdBySlug.get(slug) ?? null
      if (!tenantId) {
        console.log(`Kihagyva: ${seed.displayName} — nincs „${slug}” tenant`)
        continue
      }
    }
    // A korábban platform-szinten seedelt sor átköltözik a tenantba: ugyanaz az id,
    // így a belőle létrehozott konnektorok hivatkozása érvényes marad.
    const existing =
      (await prisma.connectorTemplate.findFirst({ where: { key: seed.key, version: 1, tenantId, origin } })) ??
      (tenantId
        ? await prisma.connectorTemplate.findFirst({ where: { key: seed.key, version: 1, tenantId: null, origin } })
        : null)
    const descriptor = withTemplateIcon(seed, existing?.descriptor)
    const data = {
      tenantId,
      displayName: descriptor.displayName,
      description: descriptor.description ?? null,
      descriptor: descriptor as Prisma.InputJsonValue,
      status: 'active' as const,
    }
    if (existing) {
      await prisma.connectorTemplate.update({ where: { id: existing.id }, data })
    } else {
      await prisma.connectorTemplate.create({ data: { key: seed.key, version: 1, origin, ...data } })
    }
    if (tenantId) {
      // Más tenantban ne maradjon látható platform-szintű példány.
      await prisma.connectorTemplate.updateMany({
        where: { key: seed.key, origin, tenantId: null },
        data: { status: 'archived' },
      })
    }
    console.log(`${existing ? 'Frissítve' : 'Létrehozva'}: ${descriptor.displayName} (${seed.key})`)
  }
}
