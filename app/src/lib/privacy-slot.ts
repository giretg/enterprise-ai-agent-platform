import type { Prisma, PrismaClient } from '@prisma/client'

type ConnectorDb = Pick<PrismaClient, 'connector'>

export type ConnectorCreateWithoutSlot = Omit<Prisma.ConnectorUncheckedCreateInput, 'privacySlot'>

/** Következő tenanton belüli forrás-sorszám — monoton, soha nem újrahasznált. */
export async function nextConnectorPrivacySlot(
  db: ConnectorDb,
  tenantId: string | null,
): Promise<number> {
  const max = await db.connector.aggregate({
    where: { tenantId },
    _max: { privacySlot: true },
  })
  return (max._max.privacySlot ?? 0) + 1
}

/** Connector create input kiegészítése privacy slottal, ha hiányzik. */
export async function withConnectorPrivacySlot(
  db: ConnectorDb,
  data: ConnectorCreateWithoutSlot,
): Promise<Prisma.ConnectorUncheckedCreateInput> {
  const privacySlot = await nextConnectorPrivacySlot(db, data.tenantId ?? null)
  return { ...data, privacySlot }
}
