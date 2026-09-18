import type { Prisma, PrismaClient } from '@prisma/client'

type ConnectorDb = Pick<PrismaClient, 'connector'>

export type ConnectorCreateWithoutSlot = Prisma.ConnectorUncheckedCreateInput

/** Privacy slots were dropped in Phase B. Pass-through for existing callers. */
export async function withConnectorPrivacySlot(
  _db: ConnectorDb,
  data: ConnectorCreateWithoutSlot,
): Promise<Prisma.ConnectorUncheckedCreateInput> {
  return data
}
