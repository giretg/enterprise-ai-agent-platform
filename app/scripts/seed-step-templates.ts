/**
 * Governed Flow Builder — StepTemplate kezdő-katalógus seed (WP-3).
 * Futtatás: npm run db:seed:step-templates  (dev)  ·  a full seed is meghívja.
 *
 * A dinamikus import garantálja, hogy a dotenv (DATABASE_URL) a DB-t érintő modulok
 * betöltése ELŐTT lefusson (a full seed import-hoisting sorrendjének elkerülésére).
 */
import { config } from 'dotenv'
import path from 'path'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

async function main() {
  const { PrismaClient } = await import('@prisma/client')
  const { ensureStarterStepTemplates } = await import(
    '../src/domain/step-template/step-template-catalog'
  )
  const prisma = new PrismaClient()
  try {
    await ensureStarterStepTemplates(prisma)
    const count = await prisma.stepTemplate.count({ where: { tenantId: null, status: 'published' } })
    console.log(`StepTemplate katalógus seedelve — ${count} published globális sablon.`)
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
