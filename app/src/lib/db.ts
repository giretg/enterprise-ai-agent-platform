import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined }

/** Dev HMR cache-ből maradt kliens nem látja az új sémát — ilyenkor újra generálunk. */
const DEV_REQUIRED_MODELS = ['conversation', 'message'] as const

function prismaClientIsStale(client: PrismaClient): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return DEV_REQUIRED_MODELS.some((model) => !(model in client))
}

function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  })
}

function getPrismaClient(): PrismaClient {
  const cached = globalForPrisma.prisma
  if (cached && !prismaClientIsStale(cached)) return cached

  const client = createPrismaClient()
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = client
  }
  return client
}

export const prisma = getPrismaClient()
