/**
 * Val-surrogate + crypto-shredding DoD (APG-18, #292).
 *
 * Valódi Postgres kell — futtatás migrált DB ellen:
 *   npm run test:val-surrogate-crypto-shred
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { gcShreddedConversationSurrogateMappings } from '../src/domain/privacy/surrogate-vault-gc'
import { runDispatchCycle } from '../src/domain/dispatcher/run-dispatch-cycle'
import { allowAllPrivacyResolveAccess } from '../src/domain/privacy/resolve-access'
import { SurrogateEngine } from '../src/domain/privacy/surrogate-engine'
import { PostgresSurrogateVault } from '../src/repositories/postgres/surrogate-vault-repository'
import { PostgresConversationPrivacyKeyRepository } from '../src/repositories/postgres/conversation-privacy-key-repository'
import { PostgresConversationRepository } from '../src/repositories/postgres/conversation-repository'

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

const HMAC_KEY = 'test-tenant-hmac-key'
const RETENTION_NOW = new Date('2026-07-01T10:00:00.000Z')

class NoopAudit {
  async recordUnknownSurrogate() {}
  async recordResolveDenied() {}
}

async function seedUser(tenantId: string) {
  const suffix = randomUUID().slice(0, 8)
  return prisma.user.create({
    data: {
      externalAuthId: `ext-val-${suffix}`,
      email: `val-${suffix}@example.test`,
      name: 'Val tester',
      status: 'active',
      role: 'operator',
      tenantId,
    },
  })
}

async function seedAgent(tenantId: string) {
  const memory = await prisma.memory.create({ data: {} })
  return prisma.agent.create({
    data: {
      name: `val-agent-${randomUUID().slice(0, 8)}`,
      roleInstruction: 'x',
      behaviorProfile: 'y',
      modelConfig: { provider: 'stub', model: 'stub' },
      status: 'active',
      tenantId,
      memoryId: memory.id,
    },
  })
}

async function withConversation(
  fn: (ctx: {
    tenantId: string
    userId: string
    conversationId: string
    engine: SurrogateEngine
  }) => Promise<void>,
  opts?: { legalHold?: boolean },
) {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({
    data: { slug: `val-shred-${suffix}`, displayName: `val-shred ${suffix}` },
  })
  const user = await seedUser(tenant.id)
  const agent = await seedAgent(tenant.id)
  const conversation = await prisma.conversation.create({
    data: {
      agentId: agent.id,
      tenantId: tenant.id,
      createdById: user.id,
      retainUntil: new Date('2026-06-30T10:00:00.000Z'),
      legalHold: opts?.legalHold ?? false,
    },
  })
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      seq: 1,
      role: 'user',
      contentRef: 'c29udGVudA==',
      contentHash: 'abc',
    },
  })

  const vault = new PostgresSurrogateVault(() => HMAC_KEY)
  const privacyKeys = new PostgresConversationPrivacyKeyRepository()
  const engine = new SurrogateEngine(
    vault,
    new NoopAudit(),
    allowAllPrivacyResolveAccess,
    privacyKeys,
  )

  try {
    await fn({
      tenantId: tenant.id,
      userId: user.id,
      conversationId: conversation.id,
      engine,
    })
  } finally {
    await prisma.surrogateMap.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.conversationPrivacyKey.deleteMany({ where: { tenantId: tenant.id } })
    await prisma.message.deleteMany({ where: { conversationId: conversation.id } })
    await prisma.conversation.delete({ where: { id: conversation.id } }).catch(() => undefined)
    await prisma.agent.delete({ where: { id: agent.id } }).catch(() => undefined)
    await prisma.memory.delete({ where: { id: agent.memoryId } }).catch(() => undefined)
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined)
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined)
  }
}

async function main() {
  console.log('val-surrogate crypto-shredding (APG-18)\n')

  await check('val-surrogate feloldható, amíg megvan az adatkulcs', async () => {
    await withConversation(async ({ tenantId, userId, conversationId, engine }) => {
      const scope = { type: 'conversation' as const, id: conversationId }
      const surrogate = await engine.allocateVal({
        tenantId,
        scope,
        entityType: 'email',
        plaintext: 'teszt@example.com',
      })
      const resolved = await engine.resolveVal({
        tenantId,
        scope,
        surrogate,
        requester: { tenantId, userId },
      })
      assert.equal(resolved.ok, true)
      if (resolved.ok) assert.equal(resolved.value, 'teszt@example.com')
    })
  })

  await check('retention sweep után a val-surrogate nem oldható fel (crypto-shredding)', async () => {
    await withConversation(async ({ tenantId, userId, conversationId, engine }) => {
      const scope = { type: 'conversation' as const, id: conversationId }
      const surrogate = await engine.allocateVal({
        tenantId,
        scope,
        entityType: 'email',
        plaintext: 'sensitive@example.com',
      })

      const conversations = new PostgresConversationRepository()
      await conversations.retentionSweep(RETENTION_NOW, 10)

      const key = await prisma.conversationPrivacyKey.findUnique({
        where: { conversationId },
      })
      assert.equal(key, null)

      const resolved = await engine.resolveVal({
        tenantId,
        scope,
        surrogate,
        requester: { tenantId, userId },
      })
      assert.equal(resolved.ok, false)
      if (!resolved.ok) assert.equal(resolved.reason, 'shredded')
    })
  })

  await check('legal hold alatt a kulcs megmarad és a val-surrogate feloldható', async () => {
    await withConversation(
      async ({ tenantId, userId, conversationId, engine }) => {
        const scope = { type: 'conversation' as const, id: conversationId }
        const surrogate = await engine.allocateVal({
          tenantId,
          scope,
          entityType: 'email',
          plaintext: 'hold@example.com',
        })

        const conversations = new PostgresConversationRepository()
        const sweep = await conversations.retentionSweep(RETENTION_NOW, 10)
        assert.equal(sweep.sweptCount, 0)

        const key = await prisma.conversationPrivacyKey.findUnique({
          where: { conversationId },
        })
        assert.notEqual(key, null)

        const resolved = await engine.resolveVal({
          tenantId,
          scope,
          surrogate,
          requester: { tenantId, userId },
        })
        assert.equal(resolved.ok, true)
        if (resolved.ok) assert.equal(resolved.value, 'hold@example.com')
      },
      { legalHold: true },
    )
  })

  await check('GC-járat törli a lejárt mapping sorokat', async () => {
    await withConversation(async ({ tenantId, conversationId, engine }) => {
      const scope = { type: 'conversation' as const, id: conversationId }
      await engine.allocateVal({
        tenantId,
        scope,
        entityType: 'email',
        plaintext: 'gc@example.com',
      })

      await new PostgresConversationRepository().retentionSweep(RETENTION_NOW, 10)

      const before = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: conversationId },
      })
      assert.ok(before > 0)

      const gc = await gcShreddedConversationSurrogateMappings(10)
      assert.ok(gc.deletedCount > 0)
      assert.ok(gc.conversationIds.includes(conversationId))

      const after = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: conversationId },
      })
      assert.equal(after, 0)
    })
  })

  await check('a dispatch ciklus hívja a surrogate vault GC-t (éles hívó)', async () => {
    const source = String(runDispatchCycle)
    assert.match(source, /gcShreddedConversationSurrogateMappings/)
    assert.match(source, /surrogateVaultGc/)
  })

  if (failures > 0) {
    console.log(`\n${failures} hiba`)
    process.exit(1)
  }
  console.log('\nMinden teszt OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
