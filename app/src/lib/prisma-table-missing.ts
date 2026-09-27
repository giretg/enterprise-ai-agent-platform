import { Prisma } from '@prisma/client'

/** Prisma P2021 — a séma még nem futott le (pl. handoffs migráció). */
export function isPrismaMissingTable(error: unknown, tableName: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2021') {
    return false
  }
  const message = typeof error.message === 'string' ? error.message : ''
  return message.includes(`\`${tableName}\``) || message.includes(`"${tableName}"`) || message.includes(tableName)
}
