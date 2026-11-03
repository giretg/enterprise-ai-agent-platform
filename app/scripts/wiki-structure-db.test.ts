/**
 * #1061 F1 — kezelt kategória-fa és visszahivatkozások valódi Postgresen (migrált séma):
 * - AC1: bekapcsoláskor a szabad kategóriákból felső szintű kategóriák lesznek, minden
 *   oldal (az archivált is) a kulcsát kapja, és ez revízió (emberi change-set, NFR-4);
 * - alkategória, 2 szint, egyedi kulcs; szülőváltásnál az oldalak vele mennek;
 * - csak üres kategória törölhető;
 * - „Mi hivatkozik erre?”: csak publikált, a saját oldal nélkül, GIN-indexszel (NFR-5);
 * - az audit-sorok a valódi katalóguson és payload-őrön mennek át (NFR-3).
 * Futtatás: DATABASE_URL=… npm run test:wiki-structure-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { PostgresWikiRepository, PostgresWikiStructureRepository } from '../src/repositories/postgres/wiki-repository'
import { PostgresWikiHistoryRepository } from '../src/repositories/postgres/wiki-history-repository'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresConnectorRepository } from '../src/repositories/postgres/connector-repository'
import { PostgresAgentRepository } from '../src/repositories/postgres/agent-repository'
import { PostgresDocumentRepository } from '../src/repositories/postgres/knowledge-repository'
import { WikiService } from '../src/domain/knowledge-base/wiki-service'
import { WikiCategoryError, WikiCategoryService } from '../src/domain/knowledge-base/wiki-category-service'
import type { WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import { extractWikiLinks } from '../src/lib/kb-wiki'

let failures = 0
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  OK  ${name}`)
  } catch (e) {
    failures++
    console.log(`  FAIL ${name}: ${e instanceof Error ? e.stack : e}`)
  }
}

async function rejectsWith(code: string, fn: () => Promise<unknown>) {
  await assert.rejects(fn, (error: unknown) => error instanceof WikiCategoryError && error.code === code)
}

const wikis = new PostgresWikiRepository()
const structure = new PostgresWikiStructureRepository()
const audit = new PostgresAuditRepository()

async function main() {
  console.log('=== #1061 wiki-szerkezet (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({ data: { slug: `wiki1061-${randomUUID().slice(0, 8)}`, displayName: 'Wiki teszt' } })
  const user = await prisma.user.create({
    data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Admin' },
  })
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Wiki-agent', roleInstruction: 'x' } })
  const connector = (await prisma.connector.create({
    data: {
      tenantId: tenant.id,
      type: 'knowledge_base',
      name: `kb:shared:${randomUUID()}`,
      authMode: 'agent_owned',
      scope: 'single',
      config: { displayName: 'Céges wiki' },
    },
  })) as Connector
  const wiki = await wikis.ensureForConnector({ connectorId: connector.id, schemaMd: '# WIKI' })

  const wikiService = new WikiService({
    wikis,
    history: new PostgresWikiHistoryRepository(),
    structure,
    documents: new PostgresDocumentRepository(),
    connectors: new PostgresConnectorRepository(),
    agents: new PostgresAgentRepository(),
    knowledgeBase: { ingest: async () => { throw new Error('not used') }, getDocument: async () => { throw new Error('not used') } } as never,
    audit,
  })
  const actor: WikiConsoleActor = { userId: user.id, tenantId: tenant.id, role: 'admin' }
  const categories = new WikiCategoryService({
    // A jogosultságot a konzol-tesztek fedik; itt a kategória-logika és a DB a tét.
    wikiConsole: { authorize: async () => ({ connector, access: { view: true, contribute: true, manage: true, metaOnly: false } }) },
    wiki: wikiService,
    wikis,
    history: new PostgresWikiHistoryRepository(),
    structure,
    audit,
  })

  // Kiinduló oldalak szabad kategóriákkal (az agent írta őket, még kezeletlen wikiben).
  const seed = async (path: string, category: string | null, body: string, status: 'published' | 'archived' = 'published') => {
    const result = await wikis.applyChangeSet({
      wikiId: wiki.id,
      connectorId: connector.id,
      changeSet: { create: { wikiId: wiki.id, connectorId: connector.id, agentId: agent.id, pages: [], approverScope: {} } },
      ops: [
        {
          kind: 'create',
          page: {
            path,
            type: 'entity',
            title: path,
            summary: 's',
            category,
            body,
            sourceRefs: [],
            outLinks: extractWikiLinks(body, path),
            status,
            contentHash: randomUUID(),
          },
          createdByAgentId: agent.id,
          chunks: [],
        },
      ],
      log: { op: 'ingest', title: 'seed', pagePaths: [path], actorAgentId: agent.id },
      appliedAt: new Date(),
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  await seed('partners/dkv.md', 'Fizetési partnerek', 'DKV')
  await seed('partners/teya.md', 'fizetési partnerek ', 'Teya, lásd [[partners/dkv]]')
  await seed('projects/fuel.md', 'Projektek', 'Projekt: [[partners/dkv]] és [[partners/dkv]] újra')
  await seed('policies/old.md', 'Projektek', 'Régi: [[partners/dkv]]', 'archived')
  await seed('misc/note.md', null, 'Önhivatkozás [[misc/note]]')

  await check('„Mi hivatkozik erre?”: csak publikált, a saját oldal nélkül, darabszámmal', async () => {
    const result = await structure.listBacklinks(connector.id, 'partners/dkv.md', 50)
    assert.equal(result.count, 2)
    assert.deepEqual(result.pages.map((row) => row.path).sort(), ['partners/teya.md', 'projects/fuel.md'])
    const limited = await structure.listBacklinks(connector.id, 'partners/dkv.md', 1)
    assert.equal(limited.count, 2)
    assert.equal(limited.pages.length, 1)
    assert.equal((await structure.listBacklinks(connector.id, 'misc/note.md', 50)).count, 0)
  })

  await check('NFR-5: a visszahivatkozás-lekérdezés indexelt (nincs teljes táblabejárás; a GIN-index használható)', async () => {
    const explain = (sql: string) =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
        const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`EXPLAIN ${sql}`)
        return rows.map((row) => row['QUERY PLAN']).join('\n')
      })
    const scoped = await explain(
      `SELECT path FROM wiki_pages WHERE connector_id = '${connector.id}'::uuid AND status = 'published' AND out_links @> ARRAY['partners/dkv.md']::text[]`,
    )
    assert.doesNotMatch(scoped, /Seq Scan/, scoped)
    const gin = await explain(`SELECT path FROM wiki_pages WHERE out_links @> ARRAY['partners/dkv.md']::text[]`)
    assert.match(gin, /wiki_pages_out_links_idx/, gin)
  })

  await check('bekapcsolás előtt: előnézet a létrejövő kategóriákról (NFR-1)', async () => {
    const view = await categories.get(actor, connector.id)
    assert.equal(view.managed, false)
    assert.deepEqual(
      view.importPreview.map((row) => [row.key, row.pageCount]),
      [
        ['fizetesi-partnerek', 2],
        ['projektek', 2],
      ],
    )
  })

  await check('AC1: bekapcsolás — felső szintű kategóriák, minden oldal a kulcsát kapja, revízióval', async () => {
    const result = await categories.enable(actor, connector.id)
    assert.deepEqual(result, { created: 2, movedPages: 4 })
    assert.equal(await structure.isManaged(wiki.id), true)
    const pages = await wikis.listPages(connector.id, { status: ['published', 'archived'] })
    const byPath = Object.fromEntries(pages.map((page) => [page.path, page]))
    assert.equal(byPath['partners/dkv.md'].category, 'fizetesi-partnerek')
    assert.equal(byPath['partners/teya.md'].category, 'fizetesi-partnerek')
    assert.equal(byPath['projects/fuel.md'].category, 'projektek')
    assert.equal(byPath['policies/old.md'].category, 'projektek')
    assert.equal(byPath['policies/old.md'].status, 'archived')
    assert.equal(byPath['misc/note.md'].category, null)
    // NFR-4: a kategóriaváltás is revízió, emberi change-setben, `schema` naplóbejegyzéssel.
    assert.equal(byPath['partners/dkv.md'].version, 2)
    assert.equal((await wikis.listRevisions(byPath['partners/dkv.md'].id)).length, 2)
    const log = await wikis.listLog(wiki.id)
    assert.ok(log.some((entry) => entry.op === 'schema' && entry.actorUserId === user.id && !entry.actorAgentId))
    const rows = await structure.listCategories(wiki.id)
    assert.deepEqual(rows.map((row) => [row.key, row.name, row.parentId]), [
      ['fizetesi-partnerek', 'Fizetési partnerek', null],
      ['projektek', 'Projektek', null],
    ])
    // Újrafuttatás nem csinál semmit.
    assert.deepEqual(await categories.enable(actor, connector.id), { created: 0, movedPages: 0 })
  })

  let paymentId = ''
  await check('alkategória: 2 szint, egyedi kulcs, érvényes kulcs', async () => {
    const parent = (await structure.listCategories(wiki.id)).find((row) => row.key === 'fizetesi-partnerek')!
    const created = await categories.create(actor, connector.id, { key: 'kartya', name: 'Kártya', parentId: parent.id, description: 'Kártyás partnerek' })
    paymentId = created.id
    assert.equal(created.path, 'fizetesi-partnerek/kartya')
    await rejectsWith('too_deep', () => categories.create(actor, connector.id, { key: 'harmadik', name: 'X', parentId: paymentId }))
    await rejectsWith('key_taken', () => categories.create(actor, connector.id, { key: 'projektek', name: 'Másik' }))
    await rejectsWith('invalid_key', () => categories.create(actor, connector.id, { key: 'Rossz Kulcs', name: 'X' }))
    const view = await categories.get(actor, connector.id)
    const top = view.categories.find((row) => row.key === 'fizetesi-partnerek')!
    assert.equal(top.children[0].path, 'fizetesi-partnerek/kartya')
    assert.equal(top.totalPublished, 2)
  })

  await check('szülőváltás: a kategória oldalai az új kulcsútra kerülnek; alkategóriás kategória nem mehet máshová', async () => {
    const rows = await structure.listCategories(wiki.id)
    const projects = rows.find((row) => row.key === 'projektek')!
    const partners = rows.find((row) => row.key === 'fizetesi-partnerek')!
    await rejectsWith('too_deep', () => categories.update(actor, connector.id, partners.id, { parentId: projects.id }))
    const moved = await categories.update(actor, connector.id, projects.id, { parentId: partners.id, name: 'Partner-projektek' })
    assert.equal(moved.movedPages, 2)
    assert.equal((await wikis.findPage(connector.id, 'projects/fuel.md'))!.category, 'fizetesi-partnerek/projektek')
    assert.equal((await wikis.findPage(connector.id, 'policies/old.md'))!.category, 'fizetesi-partnerek/projektek')
    // vissza felső szintre
    const back = await categories.update(actor, connector.id, projects.id, { parentId: null })
    assert.equal(back.movedPages, 2)
    assert.equal((await wikis.findPage(connector.id, 'projects/fuel.md'))!.category, 'projektek')
  })

  await check('emberi visszaállítás megtartja a kezelt kulcsot a régi szabad kategória helyett', async () => {
    const restored = await wikiService.revertAsHuman({ tenantId: tenant.id, userId: user.id, connector, wikiId: wiki.id,
      target: { kind: 'page', path: 'partners/dkv.md', version: 1 } })
    assert.equal(restored.ok, true, JSON.stringify(restored))
    assert.equal((await wikis.findPage(connector.id, 'partners/dkv.md'))!.category, 'fizetesi-partnerek')
  })

  await check('101 oldal áthelyezése: ütközésnél a kategória és minden oldal visszagördül', async () => {
    const parent = (await structure.listCategories(wiki.id)).find((row) => row.key === 'fizetesi-partnerek')!
    const bulk = await categories.create(actor, connector.id, { key: 'bulk', name: 'Bulk', approval: 'always' })
    await prisma.wikiPage.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      connectorId: connector.id, wikiId: wiki.id, path: `bulk/p-${i}.md`, title: 'Bulk', summary: 's', body: 'b',
      category: 'bulk', contentHash: randomUUID(), sourceRefs: [], outLinks: ['partners/dkv.md'], type: 'entity' as const,
    })) })
    assert.equal((await wikiService.backlinks(connector.id, 'partners/dkv.md'))!.pages.length, 50)
    const allBacklinks = await wikiService.backlinks(connector.id, 'partners/dkv.md', 2_147_483_647)
    assert.equal(allBacklinks!.pages.length, allBacklinks!.count)
    assert.ok(allBacklinks!.count > 100)
    const apply = wikis.applyChangeSet.bind(wikis)
    let count = 0
    wikis.applyChangeSet = async (input) => {
      if (input.categoryUpdate) {
        count++
        assert.equal(input.ops.length, 101)
        const last = input.ops.at(-1)!
        if (last.kind === 'update') last.expectedVersion = -1
      }
      return apply(input)
    }
    try {
      await rejectsWith('conflict', () => categories.update(actor, connector.id, bulk.id, { parentId: parent.id }))
      assert.equal(count, 1)
      assert.equal((await structure.listCategories(wiki.id)).find((row) => row.id === bulk.id)!.parentId, null)
      const pages = await prisma.wikiPage.findMany({ where: { wikiId: wiki.id, path: { startsWith: 'bulk/' } } })
      assert.equal(pages.length, 101)
      assert.ok(pages.every((page) => page.category === 'bulk' && page.version === 1))
    } finally {
      wikis.applyChangeSet = apply
      await prisma.wikiPage.deleteMany({ where: { wikiId: wiki.id, path: { startsWith: 'bulk/' } } })
      await categories.remove(actor, connector.id, bulk.id)
    }
  })

  await check('szabály-váltás és törlés: csak üres kategória törölhető; audit a valódi katalógussal', async () => {
    const rows = await structure.listCategories(wiki.id)
    const partners = rows.find((row) => row.key === 'fizetesi-partnerek')!
    await categories.update(actor, connector.id, partners.id, { approval: 'always' })
    await rejectsWith('not_empty', () => categories.remove(actor, connector.id, partners.id))
    const projects = rows.find((row) => row.key === 'projektek')!
    // Csak archivált oldal van benne — az is számít.
    await rejectsWith('not_empty', () => categories.remove(actor, connector.id, projects.id))
    assert.deepEqual(await categories.remove(actor, connector.id, paymentId), { deleted: true })
    const actions = (
      await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: { startsWith: 'kb.wiki.categor' } }, select: { action: true, metadata: true } })
    ).map((row) => row.action)
    for (const action of ['kb.wiki.categories.enabled', 'kb.wiki.category.created', 'kb.wiki.category.updated', 'kb.wiki.category.rule_changed', 'kb.wiki.category.deleted']) {
      assert.ok(actions.includes(action), `${action} hiányzik: ${actions.join(', ')}`)
    }
    // NFR-3: név és leírás nem kerül az audit-sorba.
    const rows2 = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: { startsWith: 'kb.wiki.categor' } } })
    assert.ok(!JSON.stringify(rows2.map((row) => row.metadata)).includes('Kártyás partnerek'))
  })

  await check('kikapcsolás: a fa és a besorolás megmarad', async () => {
    await categories.disable(actor, connector.id)
    assert.equal(await structure.isManaged(wiki.id), false)
    assert.equal((await structure.listCategories(wiki.id)).length, 2)
    assert.equal((await wikis.findPage(connector.id, 'partners/dkv.md'))!.category, 'fizetesi-partnerek')
  })

  await prisma.$disconnect()
  if (failures > 0) {
    console.log(`\n${failures} FAIL`)
    process.exit(1)
  }
  console.log('\nminden OK')
}

main().catch(async (error) => {
  console.error(error)
  await prisma.$disconnect()
  process.exit(1)
})
