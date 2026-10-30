/**
 * Dev-belépés jogosultsága: a Clerk nélküli dev-identitás (DevAuthProvider —
 * DEV_AUTH_USER_ID / DEV_AUTH_EMAIL / DEV_AUTH_NAME) admin-tagságot kap a seed
 * tenantban (alap: `demo`), és platform-superadmint, hogy minden Control Plane
 * képernyő megnyitható legyen. Enélkül a dev-user tagság nélkül lép be, és a
 * tenant-oldalak üresek / jogosultsági hibát adnak.
 *
 * Idempotens. Előfeltétel: `npm run db:seed` (a tenant létezik).
 * Nem lokális adatbázison (pl. Neon) csak `--yes` kapcsolóval fut.
 *
 * Használat:  npm run db:seed:dev-login [-- --yes]
 */
import path from 'path'
import { config } from 'dotenv'
import { PrismaClient } from '@prisma/client'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

function databaseHost(): string {
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('Hiányzik a DATABASE_URL (.env.local)')
  return new URL(raw).hostname
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Éles környezetben nincs dev-belépés — a script nem fut NODE_ENV=production alatt.')
  }
  const host = databaseHost()
  if (!LOCAL_HOSTS.has(host) && !process.argv.includes('--yes')) {
    throw new Error(
      `A DATABASE_URL nem lokális (${host}). Ha biztosan ide kell a dev-belépés, futtasd: npm run db:seed:dev-login -- --yes`,
    )
  }

  const tenantSlug = process.env.SEED_TENANT_SLUG ?? 'demo'
  const externalAuthId = process.env.DEV_AUTH_USER_ID ?? 'dev-user-001'
  const email = process.env.DEV_AUTH_EMAIL ?? 'dev@excellence.ai'
  const name = process.env.DEV_AUTH_NAME ?? 'Dev Operator'

  const prisma = new PrismaClient()
  try {
    const tenant = await prisma.tenant.findUnique({ where: { slug: tenantSlug } })
    if (!tenant) throw new Error(`Nincs '${tenantSlug}' tenant — előbb: npm run db:seed`)

    const user = await prisma.user.upsert({
      where: { externalAuthId },
      create: { externalAuthId, email, name, role: 'admin', status: 'active', activatedAt: new Date() },
      update: { status: 'active' },
    })

    await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
      update: { role: 'admin', status: 'active', isDefault: true },
      create: {
        tenantId: tenant.id,
        userId: user.id,
        role: 'admin',
        status: 'active',
        isDefault: true,
        activatedAt: new Date(),
      },
    })

    await prisma.platformMembership.upsert({
      where: { userId_role: { userId: user.id, role: 'superadmin' } },
      update: { status: 'active' },
      create: { userId: user.id, role: 'superadmin', status: 'active' },
    })

    console.log(
      `Dev-belépés kész: ${email} (${externalAuthId}) → '${tenantSlug}' tenant admin + platform superadmin (db: ${host})`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
