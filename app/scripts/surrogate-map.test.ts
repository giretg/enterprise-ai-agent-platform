/**
 * `surrogate_map` DB-invariánsok (AI Privacy Gateway APG-01 / spec §5–§6, D2).
 *
 * VALÓDI Postgres kell hozzá — a bijektivitást a unique kényszerek kényszerítik ki,
 * a párhuzamos allokáció pedig csak akkor konvergál, ha a unique ütközés után
 * újraolvasás történik, nem második insert.
 *
 * Futtatás egy migrált DB ellen:
 *   npm run test:surrogate-map
 * A CI-ban a `migrations` job futtatja, közvetlenül a `prisma migrate deploy` után.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { formatSurrogate } from '../src/domain/privacy/surrogate-format'
import { PostgresSurrogateVault } from '../src/repositories/postgres/surrogate-vault-repository'
import { PostgresConversationPrivacyKeyRepository } from '../src/repositories/postgres/conversation-privacy-key-repository'
import type { InsertRefInput } from '../src/domain/privacy/surrogate-vault'

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

const HMAC = '0'.repeat(64)

async function withTenant(fn: (tenantId: string) => Promise<void>) {
  const suffix = randomUUID().slice(0, 8)
  const tenant = await prisma.tenant.create({
    data: { slug: `smap-${suffix}`, displayName: `surrogate-map ${suffix}` },
  })
  try {
    await fn(tenant.id)
  } finally {
    await prisma.tenant.delete({ where: { id: tenant.id } }).catch(() => undefined)
  }
}

function refInput(
  tenantId: string,
  overrides: Partial<Omit<InsertRefInput, 'tenantId' | 'scope'>> & { scopeId?: string } = {},
): InsertRefInput {
  const { scopeId = randomUUID(), ...fields } = overrides
  return {
    tenantId,
    scope: { type: 'conversation' as const, id: scopeId },
    entityType: 'company' as const,
    surrogate: '[[COMPANY_1]]',
    connectorId: randomUUID(),
    sourceId: 'crm/company/4821',
    ...fields,
  }
}

async function main() {
  console.log('surrogate_map DB-invariánsok\n')

  await check('ugyanaz az entitás második allokációja a meglévő álnevet adja, nem újat', async () => {
    await withTenant(async (tenantId) => {
      const vault = new PostgresSurrogateVault(() => 'test-tenant-hmac-key')
      const input = refInput(tenantId)
      const first = await vault.insertRef(input)
      const second = await vault.insertRef({ ...input, surrogate: '[[COMPANY_99]]' })
      assert.equal(first.surrogate, '[[COMPANY_1]]')
      assert.equal(second.surrogate, '[[COMPANY_1]]')
      assert.equal(first.id, second.id)
      const count = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: input.scope.id },
      })
      assert.equal(count, 1)
    })
  })

  await check('két párhuzamos allokáció ugyanarra az entitásra egy sort és egy álnevet ad', async () => {
    await withTenant(async (tenantId) => {
      const vault = new PostgresSurrogateVault(() => 'test-tenant-hmac-key')
      const input = refInput(tenantId)
      const results = await Promise.all(
        Array.from({ length: 8 }, () => vault.insertRef(input)),
      )
      const surrogates = new Set(results.map((row) => row.surrogate))
      const ids = new Set(results.map((row) => row.id))
      assert.equal(surrogates.size, 1)
      assert.equal(ids.size, 1)
      assert.equal([...surrogates][0], '[[COMPANY_1]]')
      const count = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: input.scope.id },
      })
      assert.equal(count, 1)
    })
  })

  await check('egy scope-on belül két entitás nem kaphatja ugyanazt az álnevet', async () => {
    await withTenant(async (tenantId) => {
      const vault = new PostgresSurrogateVault(() => 'test-tenant-hmac-key')
      const scopeId = randomUUID()
      await vault.insertRef(refInput(tenantId, { scopeId, sourceId: 'crm/company/1' }))
      await assert.rejects(() =>
        vault.insertRef(
          refInput(tenantId, {
            scopeId,
            sourceId: 'crm/company/2',
            connectorId: randomUUID(),
          }),
        ),
      )
    })
  })

  await check('CHECK: ref-osztály nem tárolhat titkosított értéket', async () => {
    await withTenant(async (tenantId) => {
      await assert.rejects(() =>
        prisma.surrogateMap.create({
          data: {
            tenantId,
            scopeType: 'conversation',
            scopeId: randomUUID(),
            entityType: 'company',
            surrogate: '[[COMPANY_1]]',
            class: 'ref',
            connectorId: randomUUID(),
            sourceId: 'crm/company/4821',
            encryptedValue: 'should-not-store',
            hmac: HMAC,
          },
        }),
      )
    })
  })

  await check('val-osztály mezői titkosított értékkel létrehozhatók (APG-18)', async () => {
    await withTenant(async (tenantId) => {
      const vault = new PostgresSurrogateVault(() => 'test-tenant-hmac-key')
      const privacyKeys = new PostgresConversationPrivacyKeyRepository()
      const memory = await prisma.memory.create({ data: {} })
      const agent = await prisma.agent.create({
        data: {
          name: `val-map-${randomUUID().slice(0, 8)}`,
          roleInstruction: 'x',
          behaviorProfile: 'y',
          modelConfig: { provider: 'stub', model: 'stub' },
          status: 'active',
          tenantId,
          memoryId: memory.id,
        },
      })
      const user = await prisma.user.create({
        data: {
          externalAuthId: `val-map-${randomUUID().slice(0, 8)}`,
          email: `val-map-${randomUUID().slice(0, 8)}@example.test`,
          name: 'val map',
          status: 'active',
          role: 'operator',
          tenantId,
        },
      })
      const conversation = await prisma.conversation.create({
        data: { agentId: agent.id, tenantId, createdById: user.id },
      })
      await privacyKeys.ensureDataKey(tenantId, conversation.id)
      const dataKey = await privacyKeys.getDataKey(tenantId, conversation.id)
      assert.ok(dataKey)
      const { encryptValSurrogateValue } = await import('../src/domain/privacy/val-surrogate-crypto')
      const { valSurrogateFingerprint } = await import('../src/domain/privacy/val-fingerprint')
      const plaintext = 'val@example.com'
      const fingerprint = valSurrogateFingerprint(plaintext)
      const encryptedValue = encryptValSurrogateValue(tenantId, dataKey!, plaintext)
      const row = await vault.insertVal({
        tenantId,
        scope: { type: 'conversation', id: conversation.id },
        entityType: 'email',
        fingerprint,
        surrogate: '[[EMAIL_1]]',
        encryptedValue,
      })
      assert.equal(row.class, 'val')
      assert.equal(row.encryptedValue, encryptedValue)
      assert.equal(row.sourceId, fingerprint)
    })
  })

  await check('APG-10: insertRefs N entitást egy tranzakcióban ír, ütköző entitás a meglévőt adja', async () => {
    await withTenant(async (tenantId) => {
      const vault = new PostgresSurrogateVault(() => 'test-tenant-hmac-key')
      const scope = { type: 'conversation' as const, id: randomUUID() }
      const connectorId = randomUUID()
      const inputs: InsertRefInput[] = Array.from({ length: 20 }, (_, i) => ({
        tenantId,
        scope,
        entityType: 'company',
        connectorId,
        sourceId: `crm/company/${i + 1}`,
        surrogate: formatSurrogate('company', i + 1),
      }))
      const first = await vault.insertRefs(inputs)
      assert.equal(first.length, 20)
      const again = await vault.insertRefs(inputs)
      assert.equal(again.length, 20)
      assert.equal(again[0]?.surrogate, '[[COMPANY_1]]')
      assert.equal(again[0]?.id, first[0]?.id)
      const count = await prisma.surrogateMap.count({
        where: { tenantId, scopeId: scope.id },
      })
      assert.equal(count, 20)
    })
  })

  await check(
    'megjelenítési érték perzisztál és a beszélgetés kulcsával fejthető vissza (spec §5 R19)',
    async () => {
      await withTenant(async (tenantId) => {
        const vault = new PostgresSurrogateVault(() => 'test-tenant-hmac-key')
        const scope = { type: 'conversation' as const, id: randomUUID() }
        const surrogate = '[[COMPANY_1]]'
        await vault.insertRef(
          refInput(tenantId, { scopeId: scope.id, sourceId: 'crm/company/4821' }),
        )

        const { encryptSurrogateDisplayValue, decryptSurrogateDisplayValue } = await import(
          '../src/domain/privacy/display-value-crypto'
        )
        const dataKey = Buffer.alloc(32, 5)
        const displayValueEnc = encryptSurrogateDisplayValue({
          tenantId,
          dataKey,
          scope,
          surrogate,
          payload: { value: 'SPAR Magyarország Kft.', source: 'structured_field' },
        })
        await vault.saveDisplayValues(tenantId, scope, [{ surrogate, displayValueEnc }])

        const stored = await vault.listDisplayValues(tenantId, scope)
        assert.equal(stored.length, 1)
        const payload = decryptSurrogateDisplayValue({
          tenantId,
          dataKey,
          scope,
          surrogate,
          encrypted: stored[0]!.displayValueEnc,
        })
        assert.equal(payload?.value, 'SPAR Magyarország Kft.')
        assert.equal(payload?.source, 'structured_field')

        // Másik beszélgetés kulcsával nem fejthető vissza (scope-hoz kötött kulcs).
        const foreign = decryptSurrogateDisplayValue({
          tenantId,
          dataKey,
          scope: { type: 'conversation', id: randomUUID() },
          surrogate,
          encrypted: stored[0]!.displayValueEnc,
        })
        assert.equal(foreign, null)
      })
    },
  )

  console.log(failures === 0 ? '\nMinden surrogate_map teszt zöld.' : `\n${failures} teszt elbukott.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
