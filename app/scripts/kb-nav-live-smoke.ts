/**
 * Élő smoke a KB-v3 §9.2/§9.3 navigációs repo-lekérdezésekhez
 * (`PostgresKnowledgeChunkRepository.listIndex` / `getPageChunks`). A tiszta
 * összeállító logikát a `kb-retrieval.test.ts` fedi; ez a smoke a VALÓDI Prisma
 * relation-filter (`artifact: { status: 'published' }`) + `connectorId`-scope
 * SQL-t futtatja a TESZT DB-n — a `searchChunks` uuid=text bugjához hasonló
 * runtime-hibák elkapására.
 *
 * Futtatás: npm run smoke:kb-nav   (DATABASE_URL_TEST kell a .env.local-ból)
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import { resolve } from 'node:path'

config({ path: resolve(process.cwd(), '.env.local') })
config({ path: resolve(process.cwd(), '.env') })

const testUrl = process.env.DATABASE_URL_TEST?.trim()
if (!testUrl) {
  console.error('DATABASE_URL_TEST nincs beállítva (.env.local) — smoke kihagyva')
  process.exit(1)
}
// A '@/lib/db' singleton a DATABASE_URL-t olvassa (config mód) — a teszt branchre irányítjuk.
process.env.DATABASE_URL = testUrl

async function main() {
  const { prisma } = await import('../src/lib/db')
  const { PostgresKnowledgeChunkRepository } = await import(
    '../src/repositories/postgres/knowledge-repository'
  )
  const repo = new PostgresKnowledgeChunkRepository()

  const connectorId = randomUUID()
  const otherConnectorId = randomUUID()
  const publishedArtifactId = randomUUID()
  const draftArtifactId = randomUUID()
  let failures = 0

  try {
    const { withConnectorPrivacySlot } = await import('../src/lib/privacy-slot')
    // Két connector (scope-izoláció), egy published + egy draft artifact.
    await prisma.connector.create({
      data: await withConnectorPrivacySlot(prisma, {
        id: connectorId,
        type: 'knowledge_base',
        name: `kb-nav-smoke-${connectorId}`,
        scope: 'single',
      }),
    })
    await prisma.connector.create({
      data: await withConnectorPrivacySlot(prisma, {
        id: otherConnectorId,
        type: 'knowledge_base',
        name: `kb-nav-smoke-other-${otherConnectorId}`,
        scope: 'single',
      }),
    })
    await prisma.knowledgeArtifact.create({
      data: {
        id: publishedArtifactId,
        connectorId,
        format: 'okf_v0_1',
        status: 'published',
        version: 1,
        contentHash: 'hash-pub',
        bundleRef: `kb/${connectorId}/`,
        publishedAt: new Date(),
      },
    })
    await prisma.knowledgeArtifact.create({
      data: {
        id: draftArtifactId,
        connectorId,
        format: 'okf_v0_1',
        status: 'draft',
        version: 2,
        contentHash: 'hash-draft',
        bundleRef: `kb/${connectorId}/`,
      },
    })
    // Published oldal: 2 chunk (sorrend-ellenőrzéshez fordítva szúrjuk be).
    await prisma.knowledgeChunk.createMany({
      data: [
        {
          artifactId: publishedArtifactId,
          connectorId,
          path: 'pages/01-remote-work.md',
          title: 'Remote Work Policy',
          type: 'Section',
          section: 'Remote Work Policy',
          chunkIndex: 1,
          text: 'Második bekezdés.',
          contentHash: 'c-p-1',
          sourceRef: { documentId: 'doc-okf', filename: 'hr-remote-policy.pdf', page: 3 },
        },
        {
          artifactId: publishedArtifactId,
          connectorId,
          path: 'pages/01-remote-work.md',
          title: 'Remote Work Policy',
          type: 'Section',
          section: 'Remote Work Policy',
          chunkIndex: 0,
          text: 'Első bekezdés.',
          contentHash: 'c-p-0',
          sourceRef: { documentId: 'doc-okf', filename: 'hr-remote-policy.pdf', page: 3 },
        },
        {
          artifactId: publishedArtifactId,
          connectorId,
          path: 'pages/02-onboarding.md',
          title: 'Onboarding',
          type: 'Section',
          section: 'Onboarding',
          chunkIndex: 0,
          text: 'Onboarding lépések.',
          contentHash: 'c-p-2',
          sourceRef: { documentId: 'doc-okf', filename: 'hr-remote-policy.pdf' },
        },
      ],
    })
    // Draft chunk — NEM jöhet vissza (csak published, §14.1).
    await prisma.knowledgeChunk.create({
      data: {
        artifactId: draftArtifactId,
        connectorId,
        path: 'pages/99-draft.md',
        title: 'Draft page',
        type: 'Section',
        section: 'Draft',
        chunkIndex: 0,
        text: 'Nem publikált tartalom.',
        contentHash: 'c-d-0',
      },
    })

    const check = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn()
        console.log(`  ✅ ${name}`)
      } catch (e) {
        failures++
        console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
      }
    }

    console.log('=== KB-v3 nav repo élő smoke (teszt DB) ===')

    await check('listIndex: csak published oldalak, path-onként egy sor (scope)', async () => {
      const entries = await repo.listIndex({ connectorIds: [connectorId] })
      const paths = entries.map((e) => e.path).sort()
      assert.deepEqual(paths, ['pages/01-remote-work.md', 'pages/02-onboarding.md'])
      assert.ok(!paths.includes('pages/99-draft.md'), 'draft artifact chunkja kimarad')
    })

    await check('listIndex: pathPrefix szűkít', async () => {
      const entries = await repo.listIndex({ connectorIds: [connectorId], pathPrefix: 'pages/02' })
      assert.equal(entries.length, 1)
      assert.equal(entries[0].path, 'pages/02-onboarding.md')
    })

    await check('listIndex: idegen connector scope üres', async () => {
      const entries = await repo.listIndex({ connectorIds: [otherConnectorId] })
      assert.equal(entries.length, 0, 'scope-izoláció (D-B)')
    })

    await check('getPageChunks: published oldal 2 chunkja chunkIndex sorrendben', async () => {
      const chunks = await repo.getPageChunks({
        connectorIds: [connectorId],
        path: 'pages/01-remote-work.md',
      })
      assert.equal(chunks.length, 2)
      assert.deepEqual(chunks.map((c) => c.chunkIndex), [0, 1], 'chunkIndex ASC')
      assert.equal(chunks[0].text, 'Első bekezdés.')
    })

    await check('getPageChunks: draft oldal nem érhető el', async () => {
      const chunks = await repo.getPageChunks({
        connectorIds: [connectorId],
        path: 'pages/99-draft.md',
      })
      assert.equal(chunks.length, 0, 'csak published (§14.1)')
    })

    console.log(failures === 0 ? '\n✅ minden smoke zöld' : `\n❌ ${failures} smoke bukott`)
  } finally {
    // Cleanup (FK-sorrend): chunk → artifact → connector. Idle-connection szivárgás
    // ellen mindig disconnect (lásd feedback-neon-connection-leaks).
    await prisma.knowledgeChunk.deleteMany({ where: { connectorId: { in: [connectorId, otherConnectorId] } } })
    await prisma.knowledgeArtifact.deleteMany({ where: { connectorId: { in: [connectorId, otherConnectorId] } } })
    await prisma.connector.deleteMany({ where: { id: { in: [connectorId, otherConnectorId] } } })
    await prisma.$disconnect()
  }

  if (failures > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
