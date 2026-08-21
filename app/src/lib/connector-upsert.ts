import type { Connector, Prisma, PrismaClient } from '@prisma/client'
import type { ConnectorCreateWithoutSlot } from '@/lib/privacy-slot'

type ConnectorDb = Pick<PrismaClient, 'connector'>

/**
 * Connector find-or-create/update a (tenantId, type, name) kulcson.
 *
 * A séma `@@unique([tenantId, type, name])` compound-kulcsa (Tenant-Management
 * §4.2 bug-fix) Prisma-oldalon NEM fogad `null` tenantId-t a `findUnique`/`upsert`
 * where-jében (nullable-compound korlát: a generált compound-input `tenantId`-je
 * nem-null). Ezért a globális (null-tenant) és tenant-scope connectorokra egyaránt
 * `findFirst` + `create`/`update` mintát használunk — funkcionálisan ekvivalens a
 * korábbi `upsert`-tel, csak null tenantId-vel is működik.
 */
export async function upsertConnectorByTypeName(
  db: ConnectorDb,
  args: {
    create: ConnectorCreateWithoutSlot
    update?: Prisma.ConnectorUncheckedUpdateInput
  },
): Promise<Connector> {
  const { type, name } = args.create
  const tenantId = args.create.tenantId ?? null

  const existing = await db.connector.findFirst({ where: { type, name, tenantId } })
  if (existing) {
    if (args.update) return db.connector.update({ where: { id: existing.id }, data: args.update })
    return existing
  }
  const { withConnectorPrivacySlot } = await import('@/lib/privacy-slot')
  const create = await withConnectorPrivacySlot(db, args.create)
  return db.connector.create({ data: create })
}
