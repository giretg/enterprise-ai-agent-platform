/**
 * #1136 F3: a `kb_search` illesztése és tartaléka valódi Postgresen, valódi szótárral:
 * a §5 táblázatok „Új kb_search” oszlopa, stopszók, `matched`, tartalék-hiba, határok (AC22–AC27).
 * Futtatás: DATABASE_URL=… npm run test:kb-search-matching-db (CI: migrations job).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a szolgáltatásból itt csak a keresés kell */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { KnowledgeBaseService } from '../src/domain/knowledge-base/knowledge-base-service'
import { prisma } from '../src/lib/db'
import {
  PostgresDocumentRepository,
  PostgresKnowledgeArtifactRepository,
  PostgresKnowledgeChunkRepository,
} from '../src/repositories/postgres/knowledge-repository'

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (error) {
    failures++
    console.log(`  FAIL ${name}: ${error instanceof Error ? error.stack : error}`)
  }
}

const chunks = new PostgresKnowledgeChunkRepository()
const documents = new PostgresDocumentRepository()
const artifacts = new PostgresKnowledgeArtifactRepository()
const service = new KnowledgeBaseService({ chunks, documents, artifacts } as any)

async function main() {
  console.log('=== #1136 kb_search illesztés (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({ data: { slug: `kb1136-${randomUUID().slice(0, 8)}`, displayName: 'KB kereső teszt' } })
  const user = await prisma.user.create({ data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Teszt' } })

  const makeConnector = async (kbLanguage = 'hu', tenantId = tenant.id) => {
    const connector = await prisma.connector.create({
      data: { tenantId, type: 'knowledge_base', name: `kb:shared:${randomUUID()}`, authMode: 'agent_owned', scope: 'single', kbLanguage } as any,
    })
    return connector.id
  }
  const addChunk = async (connectorId: string, path: string, text: string, status: 'published' | 'pending_review' = 'published', title = 'Semleges cím') => {
    const artifact = await prisma.knowledgeArtifact.create({ data: { connectorId, status, contentHash: randomUUID() } })
    await prisma.knowledgeChunk.create({
      data: { artifactId: artifact.id, connectorId, path, title, type: 'entity', chunkIndex: 0, text, contentHash: randomUUID() },
    })
    return artifact.id
  }
  const addDocument = (connectorId: string, filename: string, extractedText: string) =>
    prisma.document.create({ data: { tenantId: tenant.id, connectorId, filename, extractedText, uploadedById: user.id, status: 'processed' } })
  const search = (connectorId: string, query: string, svc: KnowledgeBaseService = service) => svc.search({ connectorId, query, k: 5 })

  const single = await makeConnector()
  const finds = async (word: string, text: string) => {
    await prisma.knowledgeArtifact.deleteMany({ where: { connectorId: single } })
    await addChunk(single, 'lap.md', text)
    return (await search(single, word)).length === 1
  }

  const positive: Array<[string, string]> = [
    // §5: amit ma nem talál meg.
    ['kartya', 'kártyák'], ['szerzodes', 'szerződésben'], ['kártyák', 'kártya'], ['levél', 'levelek'], ['levelek', 'levél'],
    ['ügyfelek', 'ügyfél'], ['kódok', 'kód'], ['terminálok', 'terminál'], ['elfogadás', 'kártyaelfogadás'], ['8583', 'ISO-8583'],
    // §5: ami ma is jó.
    ['kártya', 'kártyák'], ['kártyát', 'kártyák'], ['szerződés', 'szerződésben'], ['szerződésben', 'szerződés'], ['díjak', 'díj'],
    ['3DS', '3DS2'], ['kockázat', 'kockázatok'], ['bank', 'bankok'], ['bank', 'bankkártya'], ['adat', 'adatok'],
    ['terminál', 'terminálok'], ['fizetés', 'fizetési'], ['kereskedő', 'kereskedők'],
    // §5: vállalt zaj.
    ['adat', 'feladat'], ['termék', 'termelés'], ['karton', 'kártya'],
  ]
  for (const [word, text] of positive) {
    await check(`találat: ${word} → ${text}`, async () => assert.equal(await finds(word, text), true))
  }
  const negative: Array<[string, string]> = [
    ['bank', 'barát és baj'], ['adat', 'adó és adott'], ['terminál', 'termék és termelés'], ['visa', 'visszatérítés'], ['díja', 'dísz'],
    // D11: a stopszó a kb_search-ben kiesik, a felülettel ellentétben.
    ['nem', 'nem elfogadott'],
  ]
  for (const [word, text] of negative) {
    await check(`nincs találat: ${word} → ${text}`, async () => assert.equal(await finds(word, text), false))
  }

  await check('raw dokumentum: a K1 és a tartalék is talál, a részlet és a szakasz megvan', async () => {
    const connectorId = await makeConnector()
    await addDocument(connectorId, 'szabalyzat.md', '# Bevezető\n\nSemmi lényeges.\n\n# Díjak\n\nA kártyaelfogadás a kereskedő költsége, ISO-8583 szerint.')
    const direct = await search(connectorId, 'kereskedő')
    assert.equal(direct.length, 1)
    const viaFallback = await search(connectorId, 'elfogadás')
    assert.equal(viaFallback.length, 1)
    assert.match(viaFallback[0].snippet, /kártyaelfogadás/)
    assert.equal(viaFallback[0].source?.section, 'Díjak')
    assert.equal((await search(connectorId, 'kartya')).length, 1)
    assert.equal((await search(connectorId, 'bank')).length, 0)
  })

  await check('AC15-párja: angol tudásbázison az angol szótár dolgozik', async () => {
    const connectorId = await makeConnector('en')
    await addChunk(connectorId, 'en.md', 'one payment only')
    assert.equal((await search(connectorId, 'payments')).length, 1)
    assert.equal((await search(connectorId, 'the')).length, 0, 'angol stopszó')
  })

  await check('AC23: a stopszó se a keresésbe, se a tartalékba nem kerül; hosszú kérdés rangsora nem romlik', async () => {
    const connectorId = await makeConnector()
    await addChunk(connectorId, 'stopszavas.md', 'hogyan és miért nem lehet az hogy de ha már')
    await addChunk(connectorId, 'celzott.md', 'A kártyák elfogadása kereskedői feladat, az elfogadás szabályai.')
    assert.deepEqual((await search(connectorId, 'hogyan és miért nem')).map((hit) => hit.path), [])
    const hits = await search(connectorId, 'hogyan és miért nem lehet elfogadni a kártyát a kereskedő?')
    assert.equal(hits[0].path, 'celzott.md')
  })

  await check('AC24: ugyanaz a chunk nem szerepel kétszer, a K1 és a tartalék szava együtt számít', async () => {
    const connectorId = await makeConnector()
    await addChunk(connectorId, 'mindketto.md', 'kártyák az ISO-8583 szerint')
    await addChunk(connectorId, 'csak-egy.md', 'kártyák máshogy')
    const hits = await search(connectorId, 'kártyát 8583')
    assert.deepEqual(hits.map((hit) => hit.path), ['mindketto.md', 'csak-egy.md'])
    assert.ok(hits[0].score! > hits[1].score!, 'két szó többet ér, mint egy')
    const direct = await chunks.searchChunks([connectorId], 'kártyát 8583', 10)
    assert.deepEqual(direct.find((hit) => hit.path === 'csak-egy.md')?.matched, ['kártyát'])
    const fallback = await chunks.searchChunksFallback([connectorId], ['8583'], 'literal', 10)
    assert.deepEqual(fallback.map((hit) => [hit.path, hit.matched, hit.score]), [['mindketto.md', ['8583'], 0]])
  })

  const spying = (overrides: Record<string, unknown> = {}) => {
    const calls = { chunks: 0, raw: 0 }
    const svc = new KnowledgeBaseService({
      artifacts,
      chunks: {
        searchChunks: chunks.searchChunks.bind(chunks),
        searchChunksFallback: (...args: Parameters<typeof chunks.searchChunksFallback>) => {
          calls.chunks++
          return chunks.searchChunksFallback(...args)
        },
        ...overrides,
      },
      documents: {
        searchRaw: documents.searchRaw.bind(documents),
        searchRawFallback: (...args: Parameters<typeof documents.searchRawFallback>) => {
          calls.raw++
          return documents.searchRawFallback(...args)
        },
      },
    } as any)
    return { svc, calls }
  }

  await check('AC25: ha minden szónak van jelöltje, a tartalék nem fut', async () => {
    const connectorId = await makeConnector()
    await addChunk(connectorId, 'lap.md', 'kártyák és szerződések')
    const { svc, calls } = spying()
    assert.equal((await search(connectorId, 'kártya szerződés', svc)).length, 1)
    assert.deepEqual(calls, { chunks: 0, raw: 0 })
    assert.equal((await search(connectorId, 'kártya elfogadás', svc)).length, 1)
    assert.ok(calls.chunks > 0 && calls.raw > 0)
  })

  await check('AC26: a tartalék hibája vagy időtúllépése mellett a K1 találatai jönnek, a napló nem tartalmaz szót', async () => {
    const connectorId = await makeConnector()
    await addChunk(connectorId, 'lap.md', 'kártyák')
    const warnings: unknown[][] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args)
    try {
      const failing = spying({ searchChunksFallback: async () => { throw new Error('titkosszo a hibaüzenetben') } })
      assert.deepEqual((await search(connectorId, 'kártya titkosszo', failing.svc)).map((hit) => hit.path), ['lap.md'])
      const hanging = spying({ searchChunksFallback: () => new Promise(() => {}) })
      const startedAt = Date.now()
      assert.deepEqual((await search(connectorId, 'kártya titkosszo', hanging.svc)).map((hit) => hit.path), ['lap.md'])
      const elapsed = Date.now() - startedAt
      assert.ok(elapsed >= 1_900 && elapsed < 3_000, `eltelt: ${elapsed} ms`)
    } finally {
      console.warn = original
    }
    assert.equal(warnings.length, 2)
    assert.equal((warnings[1][1] as { reason: string }).reason, 'timeout')
    assert.ok(!JSON.stringify(warnings).includes('titkosszo'), JSON.stringify(warnings))
  })

  await check('AC26: ha csak a tőalakos kör akad el, a betű szerinti kör találata megmarad', async () => {
    const connectorId = await makeConnector()
    await addChunk(connectorId, 'betuszerinti.md', 'kártyaelfogadás')
    const original = console.warn
    console.warn = () => {}
    try {
      const svc = new KnowledgeBaseService({
        artifacts,
        chunks: {
          searchChunks: chunks.searchChunks.bind(chunks),
          searchChunksFallback: (ids: string[], terms: string[], mode: 'literal' | 'stem', limit: number) =>
            mode === 'stem' ? new Promise(() => {}) : chunks.searchChunksFallback(ids, terms, mode, limit),
        },
        documents,
      } as any)
      assert.deepEqual((await search(connectorId, 'elfogadás nincsilyenszo', svc)).map((hit) => hit.path), ['betuszerinti.md'])
    } finally {
      console.warn = original
    }
  })

  await check('AC26: a futó pásztázást a Postgres is leállítja 2 másodpercnél', async () => {
    await assert.rejects(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 2000')
        await tx.$queryRaw`SELECT pg_sleep(4)`
      }),
      /statement timeout|canceling statement/,
    )
  })

  await check('AC27: a tartalék connector-határt nem lép át, nem közzétett tartalomra és kiváltott forrásra nem talál', async () => {
    const connectorId = await makeConnector()
    const other = await makeConnector()
    const foreign = await prisma.tenant.create({ data: { slug: `kb1136-m-${randomUUID().slice(0, 8)}`, displayName: 'Másik cég' } })
    await addChunk(connectorId, 'tervezet.md', 'kártyaelfogadás', 'pending_review')
    await addChunk(other, 'masik.md', 'kártyaelfogadás')
    await addChunk(await makeConnector('hu', foreign.id), 'idegen.md', 'kártyaelfogadás')
    await addDocument(other, 'masik.txt', 'kártyaelfogadás')
    const superseded = await addDocument(connectorId, 'kivaltott.txt', 'kártyaelfogadás')
    await prisma.knowledgeArtifact.create({ data: { connectorId, status: 'published', contentHash: randomUUID(), sourceDocumentId: superseded.id } })
    assert.deepEqual(await search(connectorId, 'elfogadás'), [])
    assert.deepEqual(await chunks.searchChunksFallback([connectorId], ['elfogadás'], 'literal', 10), [])
    assert.deepEqual(await documents.searchRawFallback(connectorId, ['elfogadás'], 'literal', 10), [])
    assert.deepEqual((await search(other, 'elfogadás')).length, 2)
  })

  await check('a tartalék legfeljebb 8 szót néz, a leghosszabbakat, és a 3 karakternél rövidebbet nem', async () => {
    const connectorId = await makeConnector()
    await addChunk(connectorId, 'lap.md', 'xxkulcsszoxx')
    const short = Array.from({ length: 8 }, (_, i) => `rovidebbszo${i}`)
    assert.equal((await chunks.searchChunksFallback([connectorId], [...short, 'kulcsszo'], 'literal', 10)).length, 0)
    assert.equal((await chunks.searchChunksFallback([connectorId], [...short.slice(1), 'kulcsszo'], 'literal', 10)).length, 1)
  })

  await prisma.$disconnect()
  if (failures) {
    console.log(`\n${failures} teszt elbukott.`)
    process.exit(1)
  }
  console.log('\nMinden teszt zöld.')
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
