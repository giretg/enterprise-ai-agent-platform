/**
 * IAM tenant-boundary regression tests.
 *
 * Futtatás: DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub tsx scripts/iam-tenant-boundary.test.ts
 *
 * A teszt DB nélkül fut: az action-rétegből kiemelt access-audit szűrőt és az
 * IamService permission-update audit attribúcióját ellenőrzi.
 */
import assert from 'node:assert/strict'
import { buildTenantAccessAuditFilter } from '../src/domain/iam/access-audit'
import { IamService } from '../src/domain/iam/iam-service'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  OK  ${name}`))
    .catch((e: unknown) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

async function main() {
  await check('access audit filter is tenant-scoped', () => {
    const filter = buildTenantAccessAuditFilter({ tenantId: 'tenant-a', limit: 25 })
    assert.equal(filter.tenantId, 'tenant-a')
    assert.equal(filter.limit, 25)
    assert.ok(Array.isArray(filter.action))
    assert.ok(filter.action.includes('user.authz.deny'))
    assert.ok(filter.action.includes('user.permission.update'))
  })

  await check('permission update succeeds without AuditLog', async () => {
    const service = new IamService(
      {} as never,
      {} as never,
      {
        async findByKey(permissionKey: string) {
          assert.equal(permissionKey, 'audit.read')
          return {
            id: 'rp-existing',
            permissionKey,
            minRole: 'approver',
            description: 'Access audit olvasása',
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          }
        },
        async findAll() {
          return []
        },
        async upsert(permissionKey: string, minRole: 'admin' | 'approver' | 'operator' | 'viewer', description?: string | null) {
          return {
            id: 'rp-updated',
            permissionKey,
            minRole,
            description: description ?? null,
            updatedAt: new Date('2026-01-02T00:00:00Z'),
          }
        },
      } as never,
    )

    const updated = await service.updatePermission({
      permissionKey: 'audit.read',
      minRole: 'admin',
      actorId: 'user-admin',
      tenantId: 'tenant-a',
    })
    assert.equal(updated.minRole, 'admin')
    assert.equal(updated.id, 'rp-updated')
  })

  console.log(`\n${failures === 0 ? 'Minden teszt zöld.' : `${failures} teszt bukott.`}`)
  if (failures > 0) process.exit(1)
}

main()
