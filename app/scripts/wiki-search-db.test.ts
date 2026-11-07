/**
 * #1136 F1: a wiki-keresés SQL-je valódi Postgresen, valódi szótárral: a §5 táblázatai,
 * a sorrend, a részleges találatok és a jogok (AC3–AC6, AC12, AC14, AC15).
 * Futtatás: DATABASE_URL=… npm run test:wiki-search-db (CI: migrations job).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a szolgáltatás itt csak a kereséshez kell */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { WikiPageStatus, WikiPageType } from '@prisma/client'
import { WikiConsoleError, WikiConsoleService, type WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import { prisma } from '../src/lib/db'
import { PostgresWikiRepository } from '../src/repositories/postgres/wiki-repository'

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

const wikis = new PostgresWikiRepository()

async function main() {
  console.log('=== #1136 wiki-keresés (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({ data: { slug: `wiki1136-${randomUUID().slice(0, 8)}`, displayName: 'Wiki kereső teszt' } })
  const owner = await prisma.user.create({ data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Tulaj' } })
  const member = await prisma.user.create({ data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Tag' } })

  const makeWiki = async (data: Record<string, unknown> = {}) => {
    const connector = await prisma.connector.create({
      data: { tenantId: tenant.id, type: 'knowledge_base', name: `kb:shared:${randomUUID()}`, authMode: 'agent_owned', scope: 'single', ...data } as any,
    })
    const wiki = await prisma.agentWiki.create({ data: { connectorId: connector.id, schemaMd: '# WIKI' } })
    return { connectorId: connector.id, wikiId: wiki.id }
  }
  const addPage = (
    wiki: { connectorId: string; wikiId: string },
    path: string,
    body: string,
    extra: { title?: string; summary?: string; type?: WikiPageType; status?: WikiPageStatus; category?: string; updatedAt?: Date } = {},
  ) =>
    prisma.wikiPage.create({
      data: {
        wikiId: wiki.wikiId,
        connectorId: wiki.connectorId,
        path,
        type: extra.type ?? 'entity',
        title: extra.title ?? 'Semleges cím',
        summary: extra.summary ?? 'Semleges leírás',
        category: extra.category,
        status: extra.status ?? 'published',
        body,
        contentHash: randomUUID(),
        ...(extra.updatedAt ? { updatedAt: extra.updatedAt } : {}),
      },
    })
  const search = (connectorId: string, query: string[], language = 'hu', limit = 30) =>
    wikis.searchPages(connectorId, { terms: query, language, limit })

  const single = await makeWiki()
  const finds = async (word: string, text: string, language = 'hu') => {
    await prisma.wikiPage.deleteMany({ where: { connectorId: single.connectorId } })
    await addPage(single, 'lap.md', text)
    return (await search(single.connectorId, [word], language)).hits.length === 1
  }

  const positive: Array<[string, string]> = [
    // §5: amit ma nem talál meg.
    ['kartya', 'kártyák'], ['szerzodes', 'szerződésben'], ['kártyák', 'kártya'], ['levél', 'levelek'], ['levelek', 'levél'],
    ['ügyfelek', 'ügyfél'], ['kódok', 'kód'], ['terminálok', 'terminál'], ['elfogadás', 'kártyaelfogadás'], ['8583', 'ISO-8583'],
    ['nem', 'nem elfogadott'],
    // §5: ami ma is jó.
    ['kártya', 'kártyák'], ['kártyát', 'kártyák'], ['szerződés', 'szerződésben'], ['szerződésben', 'szerződés'], ['díjak', 'díj'],
    ['3ds', '3DS2'], ['kockázat', 'kockázatok'], ['bank', 'bankok'], ['bank', 'bankkártya'], ['adat', 'adatok'],
    ['terminál', 'terminálok'], ['fizetés', 'fizetési'], ['kereskedő', 'kereskedők'],
    // §5: vállalt zaj.
    ['adat', 'feladat'], ['termék', 'termelés'], ['karton', 'kártya'],
  ]
  for (const [word, text] of positive) {
    await check(`találat: ${word} → ${text}`, async () => assert.equal(await finds(word, text), true))
  }
  const negative: Array<[string, string]> = [
    ['bank', 'barát és baj'], ['adat', 'adó és adott'], ['terminál', 'termék és termelés'], ['visa', 'visszatérítés'], ['díja', 'dísz'],
    ['ai', 'fail mail'], ['pos', 'kompost'],
  ]
  for (const [word, text] of negative) {
    await check(`nincs találat: ${word} → ${text}`, async () => assert.equal(await finds(word, text), false))
  }

  await check('AC15: angol wikin az angol szótár adja a tőalakot', async () => {
    assert.equal(await finds('payments', 'one payment only', 'en'), true)
    assert.equal(await finds('payments', 'one payment only', 'hu'), false)
  })

  await check('AC4: a mindre illeszkedő oldalak elöl, a részleges a hiányzó szóval', async () => {
    const wiki = await makeWiki()
    await addPage(wiki, 'minden.md', 'kártya és elfogadás', { title: 'Lap egy' })
    await addPage(wiki, 'reszleges.md', 'csak kártya kártya kártya kártya', { title: 'Lap kettő' })
    const hits = (await search(wiki.connectorId, ['kártya', 'elfogadás'])).hits
    assert.deepEqual(hits.map((hit) => hit.path), ['minden.md', 'reszleges.md'])
    assert.deepEqual(hits.map((hit) => hit.matchedTerms), [[0, 1], [0]])
  })

  await check('AC5: cím a törzs előtt, betű szerinti a tőalakos előtt, forrás hátul, egy oldal egyszer', async () => {
    const wiki = await makeWiki()
    await addPage(wiki, 'a-torzs-sok.md', 'kártyák '.repeat(40))
    await addPage(wiki, 'b-osszefoglalo.md', 'semmi', { summary: 'A kártyák leírása' })
    await addPage(wiki, 'c-cim.md', 'semmi', { title: 'Kártyák' })
    await addPage(wiki, 'd-forras.md', 'kártyák', { type: 'source' })
    await addPage(wiki, 'e-toalak.md', 'kártya kártya kártya')
    const hits = (await search(wiki.connectorId, ['kártyák'])).hits
    assert.deepEqual(hits.map((hit) => hit.path), ['c-cim.md', 'b-osszefoglalo.md', 'a-torzs-sok.md', 'e-toalak.md', 'd-forras.md'])
    assert.equal(new Set(hits.map((hit) => hit.path)).size, hits.length)
  })

  await check('AC5: a teljes keresés a címben megelőzi a szétszórt címszavakat', async () => {
    const wiki = await makeWiki()
    await addPage(wiki, 'szetszort.md', 'x', { title: 'Elfogadás és kártya' })
    await addPage(wiki, 'egyben.md', 'x', { title: 'Kártya elfogadás' })
    assert.deepEqual((await search(wiki.connectorId, ['kártya', 'elfogadás'])).hits.map((hit) => hit.path), ['egyben.md', 'szetszort.md'])
  })

  await check('a LIMIT után is a teljes darabszám jön vissza', async () => {
    const wiki = await makeWiki()
    for (let i = 0; i < 5; i++) await addPage(wiki, `lap-${i}.md`, 'kártya')
    const result = await search(wiki.connectorId, ['kártya'], 'hu', 2)
    assert.equal(result.total, 5)
    assert.equal(result.hits.length, 2)
  })

  await check('AC6 + AC12: másik wiki, tervezet és archivált oldal nem ad találatot, darabszámot sem', async () => {
    const wiki = await makeWiki()
    const other = await makeWiki()
    await addPage(wiki, 'kozzetett.md', 'kártya')
    await addPage(wiki, 'tervezet.md', 'kártya', { status: 'pending_approval', title: 'Titkos tervezet' })
    await addPage(wiki, 'archiv.md', 'kártya', { status: 'archived' })
    await addPage(other, 'masik.md', 'kártya')
    const result = await search(wiki.connectorId, ['kártya'])
    assert.equal(result.total, 1)
    assert.deepEqual(result.hits.map((hit) => hit.path), ['kozzetett.md'])
  })

  await check('AC12: a korábbi verzió szövege nem kereshető', async () => {
    const wiki = await makeWiki()
    const page = await addPage(wiki, 'lap.md', 'az új szöveg')
    await prisma.wikiPageRevision.create({
      data: { pageId: page.id, version: 1, title: 'Régi', summary: 'Régi', body: 'kártyaszám a régi verzióban', contentHash: randomUUID(), status: 'published' } as any,
    })
    assert.equal((await search(wiki.connectorId, ['kártyaszám'])).total, 0)
  })

  const service = new WikiConsoleService({
    connectors: { findById: (id: string) => prisma.connector.findUnique({ where: { id } }) },
    wikis,
    wiki: { wikiIdForConnector: async () => null },
  } as any)
  const actor = (userId: string, role: string): WikiConsoleActor => ({ userId, tenantId: tenant.id, role })
  const hidden = async (fn: () => Promise<unknown>) =>
    assert.rejects(fn, (error: unknown) => error instanceof WikiConsoleError && error.code === 'not_found')

  await check('AC12: privát wiki más adminjának ugyanaz a „nem található”, mint nem létező wikinél', async () => {
    const wiki = await makeWiki({ name: `kb:private:${randomUUID()}`, visibility: 'private_to_user', ownerUserId: owner.id })
    await addPage(wiki, 'lelet.md', 'kártya')
    await hidden(() => service.searchPages(actor(member.id, 'admin'), wiki.connectorId, 'kártya'))
    await hidden(() => service.searchPages(actor(member.id, 'admin'), randomUUID(), 'kártya'))
    assert.equal((await service.searchPages(actor(owner.id, 'operator'), wiki.connectorId, 'kártya')).total, 1)
  })

  await check('AC12: másik tenant és a közös wikit nem látó néző nem kap találatot', async () => {
    const wiki = await makeWiki()
    await addPage(wiki, 'kozos.md', 'kártya')
    await hidden(() => service.searchPages({ userId: owner.id, tenantId: randomUUID(), role: 'admin' }, wiki.connectorId, 'kártya'))
    await hidden(() => service.searchPages(actor(owner.id, 'viewer'), wiki.connectorId, 'kártya'))
    assert.equal((await service.searchPages(actor(owner.id, 'operator'), wiki.connectorId, 'kártya')).total, 1)
  })

  await check('AC4, AC14: a szolgáltatás hiányzó szót, maszkolt részletet és szöveges HTML-t ad', async () => {
    const wiki = await makeWiki()
    await addPage(wiki, 'minden.md', '<script>alert(1)</script> A 4111 1111 1111 1111 kártya és elfogadás.', { title: 'Minden' })
    await addPage(wiki, 'reszleges.md', 'csak kártya', { title: 'Részleges', category: 'Partnerek' })
    const result = await service.searchPages(actor(owner.id, 'operator'), wiki.connectorId, 'kártya elfogadás')
    const [full, partial] = result.hits
    assert.equal(full.full, true)
    assert.deepEqual(full.missing, [])
    assert.ok(!full.snippet.text.includes('4111 1111'), full.snippet.text)
    assert.match(full.snippet.text, /<script>alert\(1\)<\/script>/)
    assert.equal(partial.full, false)
    assert.deepEqual(partial.missing, ['elfogadás'])
    assert.equal(partial.category, 'Partnerek')
    assert.equal(partial.snippet.text.slice(...partial.snippet.ranges[0]), 'kártya')
  })

  await check('üres vagy túl rövid kérdésre nincs lekérdezés, legfeljebb 6 szó számít', async () => {
    const wiki = await makeWiki()
    await addPage(wiki, 'lap.md', 'hetedik')
    assert.equal((await service.searchPages(actor(owner.id, 'operator'), wiki.connectorId, ' ! ')).total, 0)
    const result = await service.searchPages(actor(owner.id, 'operator'), wiki.connectorId, 'aa bb cc dd ee ff hetedik')
    assert.equal(result.terms.length, 6)
    assert.equal(result.total, 0)
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
