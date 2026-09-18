import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient()
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

/** Phase 0: one database. Legacy config-vs-active split is DELETE. */
export const configPrisma = prisma

/** Phase 0: single developer database. Legacy prod/test toggle is DELETE. */
export async function ensureActiveDatabaseMode(): Promise<'production'> {
  return 'production'
}
