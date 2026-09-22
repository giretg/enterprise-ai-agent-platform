/**
 * A kiadott Skill készítő sort beírja az adatbázisba.
 * Alapból a teszt DB, ha van DATABASE_URL_TEST; --production az app DB-je.
 *
 * cd app && npx tsx scripts/ensure-producer-skill.ts
 * cd app && npx tsx scripts/ensure-producer-skill.ts --production
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

const useProduction = process.argv.includes('--production')
const testDbUrl = process.env.DATABASE_URL_TEST?.trim()
if (!useProduction && testDbUrl) {
  process.env.DATABASE_URL = testDbUrl
  process.env.DIRECT_URL = process.env.DIRECT_URL_TEST?.trim() ?? testDbUrl
  console.log('Cél: teszt DB')
} else {
  console.log('Cél: app DB')
}

async function main() {
  const { prisma } = await import('../src/lib/db')
  const { ensurePublishedProducerSkill } = await import('../src/domain/skill/ensure-producer-skill')
  const result = await ensurePublishedProducerSkill()
  const tenants = await prisma.tenant.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } })
  const skill = await prisma.skill.findFirst({
    where: { tenantId: null, name: 'skill-keszito', producesSkills: true },
    select: { id: true, kind: true },
  })
  console.log(
    `${result}: ${skill?.id ?? 'hiányzik'} (${skill?.kind ?? '-'}) — ${tenants.length} tenant: ${tenants.map((t) => t.slug).join(', ') || 'nincs'}`,
  )
  await prisma.$disconnect()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
