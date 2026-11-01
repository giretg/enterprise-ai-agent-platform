/**
 * #1028 tenant-postafiók grant valódi (migrált) Postgresen: tulajdonos-típus CHECK constraint,
 * egy aktív tenant-grant címenként, újracsatlakoztatás ugyanazt a sort frissíti, a bekötő
 * admin törlése nem viszi magával a grantet.
 * Futtatás: npm run test:tenant-mailbox-db (DATABASE_URL + DIRECT_URL egy eldobható DB-re).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PostgresConnectorGrantRepository } from '../src/repositories/postgres/connector-grant-repository'

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => pattern.test(String(error)))
}

async function main() {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({ data: { slug: `mailbox-${suffix}`, displayName: 'Mailbox test' } })
  const admin = await prisma.user.create({ data: { email: `admin-${suffix}@example.com`, name: 'Admin', externalAuthId: `ext-${suffix}` } })
  const connector = await prisma.connector.create({
    data: {
      tenantId: tenant.id,
      type: 'gmail',
      name: 'Postafiók · szamlazas@ceg.hu',
      authMode: 'service',
      scope: 'single',
      config: { mailbox: { source: 'google', readOnly: false, requireApproval: true } },
    },
  })
  const repo = new PostgresConnectorGrantRepository()

  // CHECK: tenant-grantnek nem lehet userje, user-grantnek kötelező.
  await rejectsWith(
    prisma.connectorGrant.create({
      data: { tenantId: tenant.id, connectorId: connector.id, ownerType: 'tenant', userId: admin.id, tokenRef: `t-${suffix}-1` },
    }),
    /connector_grants_owner_user_check/,
  )
  await rejectsWith(
    prisma.connectorGrant.create({
      data: { tenantId: tenant.id, connectorId: connector.id, ownerType: 'user', userId: null, tokenRef: `t-${suffix}-2` },
    }),
    /connector_grants_owner_user_check/,
  )
  console.log('  OK  owner_type CHECK constraint')

  const first = await repo.upsertTenantGrant({
    tenantId: tenant.id,
    connectorId: connector.id,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    tokenRef: `t-${suffix}-a`,
    accountLabel: 'szamlazas@ceg.hu',
    metadata: { connectedByUserId: admin.id },
  })
  assert.equal(first.ownerType, 'tenant')
  assert.equal(first.userId, null)
  assert.equal((await repo.findActiveTenantGrant({ tenantId: tenant.id, connectorId: connector.id }))?.id, first.id)

  // Megszakad, majd újracsatlakoztatás: ugyanaz a sor lesz újra aktív.
  await repo.updateStatus(first.id, 'expired')
  assert.equal(await repo.findActiveTenantGrant({ tenantId: tenant.id, connectorId: connector.id }), null)
  const again = await repo.upsertTenantGrant({
    tenantId: tenant.id,
    connectorId: connector.id,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    tokenRef: first.tokenRef,
    accountLabel: 'szamlazas@ceg.hu',
    metadata: { connectedByUserId: admin.id },
  })
  assert.equal(again.id, first.id)
  assert.equal(again.status, 'active')
  console.log('  OK  reconnect reactivates the same tenant grant')

  // Egyedi index: ugyanarra a címre nem lehet két aktív tenant-grant (kis/nagybetűtől függetlenül).
  await rejectsWith(
    prisma.connectorGrant.create({
      data: {
        tenantId: tenant.id,
        connectorId: connector.id,
        ownerType: 'tenant',
        userId: null,
        tokenRef: `t-${suffix}-dup`,
        accountLabel: 'SZAMLAZAS@ceg.hu',
      },
    }),
    /connector_grants_active_tenant_account_key|Unique constraint/,
  )
  console.log('  OK  one active tenant grant per address')

  // A bekötő admin törlése (kilépés) nem érinti a tenant-grantet; a user-grantjeit viszi.
  const userGrant = await prisma.connectorGrant.create({
    data: { tenantId: tenant.id, connectorId: connector.id, userId: admin.id, tokenRef: `t-${suffix}-u`, accountLabel: 'admin@ceg.hu' },
  })
  assert.equal(await repo.revokeAllForUser(admin.id), 1)
  await prisma.connectorGrant.delete({ where: { id: userGrant.id } })
  await prisma.user.delete({ where: { id: admin.id } })
  assert.equal((await repo.findActiveTenantGrant({ tenantId: tenant.id, connectorId: connector.id }))?.id, first.id)
  console.log('  OK  tenant grant survives the connecting admin leaving')

  await prisma.connectorGrant.deleteMany({ where: { tenantId: tenant.id } })
  await prisma.connector.deleteMany({ where: { tenantId: tenant.id } })
  await prisma.tenant.delete({ where: { id: tenant.id } })
  console.log('all passed')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
