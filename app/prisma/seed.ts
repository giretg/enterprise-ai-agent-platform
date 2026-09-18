/**
 * Phase 0 seed — User/Tenant/membership only.
 * Drive grant and Agent Definition seed come in later phases.
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
