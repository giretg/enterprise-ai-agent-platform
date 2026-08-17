/**
 * StepTemplate eval-minta írás — tenant-izolációs regresszió-teszt.
 * DB és LLM NÉLKÜL (in-memory prisma-stub). Futtatás: npm run test:step-template-isolation
 *
 * Védett invariáns: az eval-minták mentése a `versionId`-t a tulajdon-ellenőrzött
 * sablon SAJÁT verziói közül oldja fel. Egy tenant-admin a saját (jogszerű) template-id-je
 * mellé NEM adhat meg egy másik tenant vagy a globális seed-katalógus verzió-ID-jét, hogy
 * annak eval-mintáit felülírja (cross-tenant írási IDOR).
 */
import assert from 'node:assert/strict'
import {
  setStepTemplateEvalSamples,
  certifyStepTemplateVersion,
  StepTemplateError,
} from '../src/domain/step-template/step-template-service'

let failures = 0
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    console.log(`  ✅ ${name}`)
  } catch (e) {
    failures++
    console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
  }
}

type FakeVersion = {
  id: string
  templateId: string
  version: number
  fragment: unknown
  contentHash: string
  certified: boolean
  evalSamples: unknown
  createdAt: Date
}
type FakeTemplate = {
  id: string
  tenantId: string | null
  key: string
  name: string
  description: string | null
  category: string | null
  status: string
  currentPublishedVersionId: string | null
  archivedAt: Date | null
  updatedAt: Date
  versions: FakeVersion[]
}

/** Minimál prisma-stub: csak a service által hívott két metódus. */
function makePrisma(templates: FakeTemplate[]) {
  const versionUpdates: string[] = []
  const prisma = {
    stepTemplate: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const t = templates.find((tt) => tt.id === where.id)
        if (!t) return null
        // A service `versions: { orderBy: { version: 'desc' } }`-t kér.
        return { ...t, versions: [...t.versions].sort((a, b) => b.version - a.version) }
      },
    },
    stepTemplateVersion: {
      update: async ({ where, data }: { where: { id: string }; data: { evalSamples?: unknown; certified?: boolean } }) => {
        for (const t of templates) {
          const v = t.versions.find((vv) => vv.id === where.id)
          if (v) {
            versionUpdates.push(v.id)
            if (data.evalSamples !== undefined) v.evalSamples = data.evalSamples
            if (data.certified !== undefined) v.certified = data.certified
            return v
          }
        }
        throw new Error(`version not found: ${where.id}`)
      },
    },
  }
  // A service `PrismaClient`-et vár; a stub elég a hívott metódusokhoz.
  return { prisma: prisma as never, versionUpdates }
}

function fixtures() {
  const globalVersion: FakeVersion = {
    id: 'ver-global-1',
    templateId: 'tpl-global',
    version: 1,
    fragment: { step: { name: 'global step' } },
    contentHash: 'hash-global',
    certified: false,
    evalSamples: [{ sampleInput: {}, expectations: ['eredeti-globális-elvárás'] }],
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
  const tenantAVersion: FakeVersion = {
    id: 'ver-a-1',
    templateId: 'tpl-a',
    version: 1,
    fragment: { step: { name: 'a step' } },
    contentHash: 'hash-a',
    certified: false,
    evalSamples: [],
    createdAt: new Date('2026-01-02T00:00:00Z'),
  }
  const templates: FakeTemplate[] = [
    {
      id: 'tpl-global',
      tenantId: null,
      key: 'global-key',
      name: 'Globális sablon',
      description: null,
      category: null,
      status: 'published',
      currentPublishedVersionId: 'ver-global-1',
      archivedAt: null,
      updatedAt: new Date(),
      versions: [globalVersion],
    },
    {
      id: 'tpl-a',
      tenantId: 'tenant-A',
      key: 'a-key',
      name: 'A tenant sablon',
      description: null,
      category: null,
      status: 'draft',
      currentPublishedVersionId: null,
      archivedAt: null,
      updatedAt: new Date(),
      versions: [tenantAVersion],
    },
  ]
  return { templates, globalVersion, tenantAVersion }
}

async function main() {
  console.log('StepTemplate eval-minta írás — tenant-izoláció')

  await check('cross-tenant: A-admin saját template-id + globális verzió-ID → elutasítva, a globális verzió érintetlen', async () => {
    const { templates, globalVersion } = fixtures()
    const { prisma, versionUpdates } = makePrisma(templates)
    await assert.rejects(
      () =>
        setStepTemplateEvalSamples(prisma, {
          id: 'tpl-a',
          tenantId: 'tenant-A',
          versionId: 'ver-global-1', // idegen (globális) verzió
          evalSamples: [{ sampleInput: {}, expectations: ['injektált'] }],
        }),
      (e: unknown) => e instanceof StepTemplateError && /verzió nem található/i.test((e as Error).message),
    )
    assert.equal(versionUpdates.length, 0, 'egyetlen verzió-UPDATE sem futhatott le')
    assert.deepEqual(
      globalVersion.evalSamples,
      [{ sampleInput: {}, expectations: ['eredeti-globális-elvárás'] }],
      'a globális verzió eval-mintái nem módosulhattak',
    )
  })

  await check('pozitív: A-admin saját template + saját verzió → mentés lefut', async () => {
    const { templates, tenantAVersion } = fixtures()
    const { prisma, versionUpdates } = makePrisma(templates)
    const res = await setStepTemplateEvalSamples(prisma, {
      id: 'tpl-a',
      tenantId: 'tenant-A',
      versionId: 'ver-a-1',
      evalSamples: [{ sampleInput: { x: 1 }, expectations: ['saját'] }],
    })
    assert.equal(res.count, 1)
    assert.deepEqual(versionUpdates, ['ver-a-1'])
    assert.deepEqual(tenantAVersion.evalSamples, [{ sampleInput: { x: 1 }, expectations: ['saját'] }])
  })

  await check('cross-tenant: idegen template-id (globális) → már a tulajdon-kapun elbukik', async () => {
    const { templates } = fixtures()
    const { prisma, versionUpdates } = makePrisma(templates)
    await assert.rejects(
      () =>
        setStepTemplateEvalSamples(prisma, {
          id: 'tpl-global',
          tenantId: 'tenant-A',
          versionId: 'ver-global-1',
          evalSamples: [],
        }),
      (e: unknown) => e instanceof StepTemplateError,
    )
    assert.equal(versionUpdates.length, 0)
  })

  await check('regresszió-horgony: certify is a saját verzióhoz kötött (idegen verzió → elutasítva)', async () => {
    const { templates } = fixtures()
    const { prisma, versionUpdates } = makePrisma(templates)
    await assert.rejects(
      () =>
        certifyStepTemplateVersion(prisma, {
          id: 'tpl-a',
          tenantId: 'tenant-A',
          versionId: 'ver-global-1',
        }),
      (e: unknown) => e instanceof StepTemplateError && /verzió nem található/i.test((e as Error).message),
    )
    assert.equal(versionUpdates.length, 0)
  })

  if (failures > 0) {
    console.log(`\n${failures} teszt bukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

void main()
