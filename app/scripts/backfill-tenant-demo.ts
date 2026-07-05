/**
 * Tenant-Management §11.1 Fázis-A migráció: legacy null-tenant adat → `demo` tenant.
 *
 * Idempotens. Amit csinál:
 *  1. Létrehozza (ha nincs) a `demo` tenantot fix UUID-del (a seed monitor is ezt használja).
 *  2. Minden AKTÍV userre `demo` tenant-membershipet ír (role = User.role), isDefault=true.
 *  3. Egy dev-superadmin platform-membershipet ad (DEV_SUPERADMIN_EMAIL vagy admin@excellence.ai).
 *  4. A tenant-scope táblák `tenant_id IS NULL` sorait a demo tenantba mozgatja — KIVÉVE:
 *     - platform-globális fallback táblák (§3.2/§4.2): connector_templates, role_templates,
 *       model_routing_policies, model_budgets;
 *     - audit_log: append-only trigger + §11.2 szerint a legacy null sorok "legacy"-ként
 *       jelennek meg, NEM backfillelünk (az UPDATE-et a trigger amúgy is tiltaná).
 *
 * Használat:  set -a; . ./.env.local; set +a; npx tsx scripts/backfill-tenant-demo.ts
 * Teszt DB:   DATABASE_URL=$DATABASE_URL_TEST DIRECT_URL=$DIRECT_URL_TEST npx tsx scripts/backfill-tenant-demo.ts
 */
import path from 'path'
import { config } from 'dotenv'
import { PrismaClient } from '@prisma/client'

config({ path: path.join(process.cwd(), '.env.local') })
config({ path: path.join(process.cwd(), '.env') })

const prisma = new PrismaClient()

/** A demo tenant fix azonosítója — a prisma/seed.ts monitor-seedje is erre hivatkozik. */
export const DEMO_TENANT_ID = '00000000-0000-4000-a000-000000000001'
export const DEMO_TENANT_SLUG = 'demo'

/** Ezekben a táblákban a `tenant_id = null` legitim (platform-globális) VAGY append-only. */
const KEEP_NULL_TABLES = new Set([
  'connector_templates',
  'role_templates',
  'model_routing_policies',
  'model_budgets',
  'audit_log',
  // A tenant-modell saját táblái — nincs értelmes null-backfill:
  'tenants',
  'tenant_memberships',
  'platform_memberships',
])

async function main() {
  const testMode = process.argv.includes('--check')

  // 1. demo tenant ────────────────────────────────────────────────────────────
  const demo = await prisma.tenant.upsert({
    where: { id: DEMO_TENANT_ID },
    update: {},
    create: {
      id: DEMO_TENANT_ID,
      slug: DEMO_TENANT_SLUG,
      displayName: 'Demo (Excellence Pay)',
      legalName: 'Excellence Pay',
      status: 'active',
      domainAllowlist: [],
      settings: {},
    },
  })
  console.log(`demo tenant: ${demo.id} (${demo.slug})`)

  // 2. membership backfill minden aktív userre ─────────────────────────────────
  const users = await prisma.user.findMany({
    select: { id: true, email: true, role: true, status: true },
  })
  let memberCount = 0
  for (const u of users) {
    if (u.status !== 'active') continue
    const role = u.role ?? 'viewer'
    await prisma.tenantMembership.upsert({
      where: { tenantId_userId: { tenantId: DEMO_TENANT_ID, userId: u.id } },
      update: {},
      create: {
        tenantId: DEMO_TENANT_ID,
        userId: u.id,
        role,
        status: 'active',
        isDefault: true,
        activatedAt: new Date(),
      },
    })
    memberCount++
  }
  console.log(`tenant memberships (active users): ${memberCount}`)

  // 3. dev-superadmin platform-membership ──────────────────────────────────────
  // §11.1: NEM automatikus (nem minden admin lesz superadmin) — kijelölt dev-
  // identitás(ok) kapnak platform-szintű superadmint, hogy a platform-felület
  // (és a platform-guard alatti globális beállítások, §9.2) tesztelhető legyen.
  // DEV_SUPERADMIN_EMAILS (vesszős lista) elsőbbséget élvez a DEV_SUPERADMIN_EMAIL felett.
  const superadminEmails = (
    process.env.DEV_SUPERADMIN_EMAILS ??
    process.env.DEV_SUPERADMIN_EMAIL ??
    'admin@excellence.ai'
  )
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  for (const email of superadminEmails) {
    const sa = await prisma.user.findFirst({ where: { email } })
    if (sa) {
      await prisma.platformMembership.upsert({
        where: { userId_role: { userId: sa.id, role: 'superadmin' } },
        update: { status: 'active' },
        create: { userId: sa.id, role: 'superadmin', status: 'active' },
      })
      console.log(`superadmin platform-membership: ${email} (${sa.id})`)
    } else {
      console.warn(`superadmin nem található: ${email} — kihagyva`)
    }
  }

  // 4. tenant-scope adat null → demo ────────────────────────────────────────────
  const cols = await prisma.$queryRaw<{ table_name: string }[]>`
    select table_name from information_schema.columns
    where column_name = 'tenant_id' and table_schema = 'public'
    order by table_name
  `
  for (const { table_name } of cols) {
    if (KEEP_NULL_TABLES.has(table_name)) continue
    if (testMode) {
      const [{ n }] = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `select count(*)::int as n from "${table_name}" where tenant_id is null`,
      )
      console.log(`  [check] ${table_name}: ${n} null sor`)
      continue
    }
    const updated = await prisma.$executeRawUnsafe(
      `update "${table_name}" set tenant_id = $1::uuid where tenant_id is null`,
      DEMO_TENANT_ID,
    )
    if (updated > 0) console.log(`  ${table_name}: ${updated} sor → demo`)
  }

  console.log('Backfill kész.')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
