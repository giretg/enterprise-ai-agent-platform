/** Run against a disposable local DB: DATABASE_URL_TEST=postgresql://.../enterprise_ai_776_admin_test npx tsx scripts/client-policy-admin-db.test.ts */
import assert from 'node:assert/strict'
import { saveAdminPolicy, AdminPolicyError, type AdminPolicyStore } from '../src/domain/client-policy/admin-policy'

const url = process.env.DATABASE_URL_TEST
if (!url || !['localhost', '127.0.0.1'].includes(new URL(url).hostname) || !new URL(url).pathname.includes('776_admin_test')) {
  throw new Error('Use only a disposable local 776_admin_test database.')
}
process.env.DATABASE_URL = url
process.env.DIRECT_URL = url
const T = '11111111-1111-4111-8111-111111111111'
const U = '22222222-2222-4222-8222-222222222222'
const A = '33333333-3333-4333-8333-333333333333'
const OTHER_T = '44444444-4444-4444-8444-444444444444'
const OTHER_U = '55555555-5555-4555-8555-555555555555'
const OTHER_A = '66666666-6666-4666-8666-666666666666'

async function main() {
  const { prisma } = await import('../src/lib/db')
  const { clientPolicyAdminStore } = await import('../src/repositories/postgres/client-policy-admin')
  try {
    for (const [id, slug, displayName] of [[T, 'hermes-test', 'Hermes tesztcég'], [OTHER_T, 'other-test', 'Másik tesztcég']]) {
      await prisma.tenant.upsert({ where: { id }, create: { id, slug, displayName }, update: {} })
    }
    for (const [id, externalAuthId, name, tenantId, role] of [[U, 'dev-user-001', 'Teszt admin', T, 'admin'], [OTHER_U, 'dev-user-002', 'Másik cég munkatársa', OTHER_T, 'operator']] as const) {
      await prisma.user.upsert({ where: { id }, create: { id, externalAuthId, name, email: `${externalAuthId}@example.test`, status: 'active', role }, update: {} })
      await prisma.tenantMembership.upsert({ where: { tenantId_userId: { tenantId, userId: id } }, create: { tenantId, userId: id, role, status: 'active', isDefault: true }, update: {} })
    }
    for (const [id, tenantId, name] of [[A, T, 'Hermes teszt agent'], [OTHER_A, OTHER_T, 'Másik cég agentje']]) {
      await prisma.agent.upsert({ where: { id }, create: { id, tenantId, name, roleInstruction: 'Teszt' }, update: {} })
    }
    await prisma.clientPolicy.deleteMany({ where: { tenantId: T } })
    const actor = { tenantId: T, userId: U, role: 'admin' }
    const input = { scope: 'tenant' as const, scopeId: T, preset: 'bound' as const, capabilities: {}, version: 0, confirmWidening: false }
    const count = () => prisma.auditLog.count({ where: { tenantId: T, action: { startsWith: 'client_policy.' } } })
    const before = await count()
    const saved = await saveAdminPolicy(clientPolicyAdminStore, actor, input)
    assert.equal(saved.version, 1)
    assert.equal(await count(), before + 1)
    const concurrent = await Promise.allSettled([
      saveAdminPolicy(clientPolicyAdminStore, actor, { ...input, version: 1, preset: 'standard' }),
      saveAdminPolicy(clientPolicyAdminStore, actor, { ...input, version: 1, preset: 'standard' }),
    ])
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1)
    const rejected = concurrent.find((r) => r.status === 'rejected') as PromiseRejectedResult
    assert.equal((rejected.reason as AdminPolicyError).code, 'version_conflict')
    assert.equal(await count(), before + 2)
    assert.equal((await prisma.clientPolicy.findFirst({ where: { tenantId: T, scope: 'tenant' } }))?.version, 2)

    const failingAuditStore: AdminPolicyStore = {
      transaction: (tenantId, run) => clientPolicyAdminStore.transaction(tenantId, (tx) => run({ ...tx, audit: async () => { throw new Error('audit_unavailable') } })),
    }
    await assert.rejects(saveAdminPolicy(failingAuditStore, actor, { ...input, version: 2, preset: 'free' }), /audit_unavailable/)
    assert.equal((await prisma.clientPolicy.findFirst({ where: { tenantId: T, scope: 'tenant' } }))?.version, 2)
    assert.equal(await count(), before + 2)
    for (const [scope, scopeId] of [['tenant', OTHER_T], ['user', OTHER_U], ['agent', OTHER_A]] as const) {
      await assert.rejects(saveAdminPolicy(clientPolicyAdminStore, actor, { ...input, scope, scopeId }), (e: unknown) => e instanceof AdminPolicyError && e.code === 'not_found')
    }
    const userPolicy = { ...input, scope: 'user' as const, scopeId: U, preset: 'free' as const }
    await assert.rejects(saveAdminPolicy(clientPolicyAdminStore, actor, userPolicy), (e: unknown) => e instanceof AdminPolicyError && e.code === 'confirmation_required')
    await saveAdminPolicy(clientPolicyAdminStore, actor, { ...userPolicy, confirmWidening: true })
    assert.equal(await count(), before + 4)
    const audit = await prisma.auditLog.findFirst({ where: { tenantId: T, action: 'client_policy.user_exception' }, orderBy: { seq: 'desc' } })
    assert.ok(audit?.hash)
    assert.ok(audit?.prevHash)
    assert.equal((audit?.metadata as { confirmed: boolean }).confirmed, true)
    console.log('client-policy-admin-db: atomic save + chained audit, concurrent conflict, audit rollback, tenant isolation, D3 OK')
  } finally {
    await prisma.$disconnect()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
