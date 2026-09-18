/**
 * Phase 0 seed is a no-op so `prisma db seed` still compiles without the
 * legacy runtime graph. The previous seed lives at `legacy/prisma/seed.ts`.
 * Phase B (#539) rewrites a minimal User/Tenant/Agent/Drive-grant seed.
 */
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  console.log('Phase 0 seed: no-op. Use the existing database or later Phase B seed.')
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
