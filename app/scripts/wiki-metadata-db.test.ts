/**
 * #1061 F3/F4 — metaadat-mezők, nézetek és kategória-sablon valódi Postgresen (migrált séma):
 * - átállás: a régi frontmatter status / owner / last_reviewed a beépített mezőkbe (előnézettel);
 * - AC14 egyedi mező (listán kívüli érték hiba, nem definiált kulcs marad), kötelező mezők;
 * - AC15 kötelező fejezet: figyelmeztetés vagy hiba a kategória beállítása szerint;
 * - AC12 agent `docStatus: approved` → függő change-set, csak a jóváhagyás állítja át;
 * - AC13 „Átnéztem”: csak ember / interaktív munkamenet, eltűnik a lejárt nézetből, auditált;
 * - AC11 a felület és a `kb_list_index reviewOverdue=true` ugyanazt adja (a régóta lejártak elöl);
 * - NFR-4 a metaadat-változás revízió (időutazás), NFR-3 az audit tartalommentes, NFR-5 GIN-index.
 * Futtatás: DATABASE_URL=… npm run test:wiki-metadata-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { PostgresWikiRepository, PostgresWikiStructureRepository } from '../src/repositories/postgres/wiki-repository'
import { PostgresWikiHistoryRepository } from '../src/repositories/postgres/wiki-history-repository'
import { PostgresWikiConsoleRepository } from '../src/repositories/postgres/wiki-console-repository'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresConnectorRepository } from '../src/repositories/postgres/connector-repository'
import { PostgresAgentRepository } from '../src/repositories/postgres/agent-repository'
import { PostgresDocumentRepository } from '../src/repositories/postgres/knowledge-repository'
import { WikiService, type WikiCaller, type WikiServiceDeps } from '../src/domain/knowledge-base/wiki-service'
import { WikiCategoryService } from '../src/domain/knowledge-base/wiki-category-service'
import { WikiMetadataService } from '../src/domain/knowledge-base/wiki-metadata-service'
import type { WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import { executeKnowledgeBaseTool } from '../src/domain/enterprise-tools/handlers/knowledge-base'

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

const DAY = 24 * 60 * 60 * 1000
const wikis = new PostgresWikiRepository()
const structure = new PostgresWikiStructureRepository()
const audit = new PostgresAuditRepository()
const consoleRepo = new PostgresWikiConsoleRepository()

async function main() {
  console.log('=== #1061 F3/F4 metaadat-mezők és sablon (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({ data: { slug: `wiki1061f3-${randomUUID().slice(0, 8)}`, displayName: 'Wiki F3 teszt' } })
  const mkUser = async (name: string) => {
    const user = await prisma.user.create({
      data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID().slice(0, 8)}@example.test`, name },
    })
    await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'admin', status: 'active' } })
    return user
  }
  const admin = await mkUser('Admin')
  const olga = await mkUser('Olga Owner')
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

  const later = new Date(Date.now() + 100 * DAY)
  const deps: WikiServiceDeps = {
    wikis,
    history: new PostgresWikiHistoryRepository(),
    structure,
    documents: new PostgresDocumentRepository(),
    connectors: new PostgresConnectorRepository(),
    agents: new PostgresAgentRepository(),
    knowledgeBase: { ingest: async () => { throw new Error('not used') }, getDocument: async () => { throw new Error('not used') } } as never,
    audit,
    findUserLabel: async (userId) => (await consoleRepo.userLabels([userId])).get(userId) ?? null,
    findTenantUser: async (tenantId, query) => {
      const user = (await consoleRepo.listTenantUsers(tenantId)).find((row) =>
        query.userId ? row.id === query.userId : row.email.toLowerCase() === query.email?.toLowerCase(),
      )
      return user ? { id: user.id, label: user.label } : null
    },
  }
  const wikiService = new WikiService(deps)
  const wikiLater = new WikiService({ ...deps, now: () => later })
  const access = { view: true, contribute: true, manage: true, metaOnly: false }
  // A jogosultságot a konzol-tesztek fedik; itt a metaadat-logika és a DB a tét.
  const wikiConsole = { authorize: async () => ({ connector, access }) }
  const metadata = new WikiMetadataService({ wikiConsole, wiki: wikiService, wikis, structure, users: consoleRepo, audit })
  const metadataLater = new WikiMetadataService({ wikiConsole, wiki: wikiLater, wikis, structure, users: consoleRepo, audit, now: () => later })
  const categories = new WikiCategoryService({ wikiConsole, wiki: wikiService, wikis, structure, audit })
  const actor: WikiConsoleActor = { userId: admin.id, tenantId: tenant.id, role: 'admin' }
  const caller = (extra: Partial<WikiCaller> = {}): WikiCaller => ({
    tenantId: tenant.id,
    userId: admin.id,
    agentId: agent.id,
    snapshot: { connectors: [{ connectorId: connector.id, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct' }] },
    interactive: true,
    ...extra,
  })
  const note = [{ kind: 'human_note', occasion: '2026-11-03 sales meeting' }]
  const upsert = (path: string, category: string, body: string, extra: Record<string, unknown> = {}, frontmatter: Record<string, unknown> = {}) => ({
    path,
    action: 'upsert' as const,
    type: 'entity' as const,
    title: path,
    summary: `Summary of ${path}`,
    category,
    body,
    frontmatter: { sources: note, ...frontmatter },
    ...extra,
  })
  const codes = (result: unknown) =>
    ((result as { details?: { errors?: Array<{ code: string }> } }).details?.errors ?? []).map((issue) => issue.code).sort()

  // Régi oldalak: a frontmatterben szabad szövegként status / owner / last_reviewed.
  const seed = async (path: string, frontmatter: Record<string, unknown>) => {
    const result = await wikis.applyChangeSet({
      wikiId: wiki.id,
      connectorId: connector.id,
      changeSet: { create: { wikiId: wiki.id, connectorId: connector.id, agentId: agent.id, pages: [], approverScope: {} } },
      ops: [{
        kind: 'create',
        page: { path, type: 'entity', title: path, summary: 's', category: null, body: 'régi', frontmatter, sourceRefs: [], outLinks: [], status: 'published', contentHash: randomUUID() },
        createdByAgentId: agent.id,
        chunks: [],
      }],
      log: { op: 'ingest', title: 'seed', pagePaths: [path], actorAgentId: agent.id },
      appliedAt: new Date(),
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  await seed('legacy/handbook.md', { status: 'Jóváhagyott', owner: olga.email, last_reviewed: '2026-01-15', product: 'Card' })
  await seed('legacy/other.md', { owner: 'Ismeretlen Ember' })

  await check('NFR-2: kikapcsolva nincs nézet, a kb_get_page nem kap metaadatot, a szabad frontmatter marad', async () => {
    assert.equal(await wikiService.fieldSettings(wiki.id), null)
    const view = await wikiService.viewFor(tenant.id, connector.id, caller(), { docStatus: ['draft'] })
    assert.equal(view.ok, false)
    const page = await wikiService.readPage({ tenantId: tenant.id, connectorId: connector.id, path: 'legacy/handbook.md', explicitWiki: true })
    assert.equal(page?.metadata, undefined)
    assert.match(String(page?.text), /status: "Jóváhagyott"/)
  })

  await check('bekapcsolás előtt: előnézet arról, mi kerül át (NFR-1)', async () => {
    const view = await metadata.get(actor, connector.id)
    assert.equal(view.managed, false)
    assert.deepEqual(
      { pages: view.importPreview!.pages, docStatus: view.importPreview!.docStatus, owner: view.importPreview!.owner, reviewedAt: view.importPreview!.reviewedAt, ownerUnmatched: view.importPreview!.ownerUnmatched },
      { pages: 1, docStatus: 1, owner: 1, reviewedAt: 1, ownerUnmatched: 1 },
    )
    assert.equal(view.importPreview!.samples[0].owner, 'Olga Owner')
  })

  await check('átállás: a régi értékek a beépített mezőkbe, revízióval; a párosíthatatlan gazda marad', async () => {
    assert.deepEqual(await metadata.enable(actor, connector.id), { imported: 1 })
    const page = (await wikis.findPage(connector.id, 'legacy/handbook.md'))!
    assert.equal(page.docStatus, 'approved')
    assert.equal(page.ownerUserId, olga.id)
    assert.equal(page.reviewedAt?.toISOString(), '2026-01-15T00:00:00.000Z')
    assert.equal(page.reviewedByUserId, null)
    assert.deepEqual(page.frontmatter, { product: 'Card' })
    const revisions = await wikis.listRevisions(page.id)
    assert.equal(revisions.length, 2)
    assert.equal((revisions[0].meta as { docStatus?: string }).docStatus, 'approved')
    assert.deepEqual((await wikis.findPage(connector.id, 'legacy/other.md'))!.frontmatter, { owner: 'Ismeretlen Ember' })
    assert.deepEqual(await metadata.enable(actor, connector.id), { imported: 0 })
  })

  let policiesId = ''
  await check('mezők és kategória-szabályok: ellenőrzött kulcsok, ismeretlen kötelező mező hiba', async () => {
    await categories.enable(actor, connector.id)
    policiesId = (await categories.create(actor, connector.id, { key: 'policies', name: 'Policies' })).id
    const partners = await categories.create(actor, connector.id, { key: 'partners', name: 'Partners' })
    await metadata.createField(actor, connector.id, { key: 'country', name: 'Ország', type: 'select', options: ['HU', 'SK', 'HU'] })
    await assert.rejects(() => metadata.createField(actor, connector.id, { key: 'owner', name: 'X', type: 'text' }), /invalid_key/)
    await assert.rejects(() => metadata.createField(actor, connector.id, { key: 'country', name: 'X', type: 'text' }), /key_taken/)
    await assert.rejects(() => metadata.createField(actor, connector.id, { key: 'empty', name: 'X', type: 'select', options: [] }), /invalid_args/)
    await assert.rejects(() => categories.update(actor, connector.id, policiesId, { requiredFields: ['nope'] }), /invalid_args/)
    await categories.update(actor, connector.id, policiesId, { reviewCycleDays: 30, requiredFields: ['country', 'owner'], requiredSections: ['## Summary'], sectionRule: 'error' })
    await categories.update(actor, connector.id, partners.id, { reviewCycleDays: 90, requiredSections: ['Contacts'], templateMd: '## Contacts\n\n- …' })
    const view = await categories.get(actor, connector.id)
    const policies = view.categories.find((row) => row.key === 'policies')!
    assert.deepEqual([policies.reviewCycleDays, policies.requiredFields, policies.requiredSections, policies.sectionRule], [30, ['country', 'owner'], ['Summary'], 'error'])
    assert.deepEqual(view.requirableFields.map((row) => row.key), ['owner', 'country'])
    const index = await wikiService.indexFor(tenant.id, connector.id, caller())
    const indexed = (index!.categories as Array<Record<string, unknown>>).find((row) => row.category === 'partners')!
    assert.deepEqual(indexed.template, { requiredSections: ['Contacts'], missingSection: 'warning', skeleton: '## Contacts\n\n- …' })
    assert.deepEqual((index as { metadataFields?: unknown }).metadataFields, [{ key: 'country', name: 'Ország', type: 'select', options: ['HU', 'SK'] }])
  })

  await check('AC14: listán kívüli érték → hiba, semmi nem íródik; az érték kanonikus, a nem definiált kulcs marad', async () => {
    const bad = await wikiService.write(caller(), {
      pages: [upsert('policies/a.md', 'policies', '## Summary\n\nLásd [[partners/p]].', { owner: { email: olga.email } }, { country: 'RO' })],
    })
    assert.equal(bad.ok, false)
    assert.deepEqual(codes(bad), ['invalid_field_value'])
    assert.equal(await wikis.findPage(connector.id, 'policies/a.md'), null)
    const good = await wikiService.write(caller(), {
      pages: [upsert('policies/a.md', 'policies', '## Summary\n\nLásd [[partners/p]].', { owner: { email: olga.email.toUpperCase(), role: 'Sales vezető' }, docStatus: 'draft' }, { country: 'hu', foo: 'bar' })],
    })
    assert.equal(good.ok, true, JSON.stringify(good))
    const page = (await wikis.findPage(connector.id, 'policies/a.md'))!
    assert.deepEqual(page.frontmatter, { country: 'HU', foo: 'bar' })
    assert.deepEqual([page.ownerUserId, page.ownerRole, page.docStatus], [olga.id, 'Sales vezető', 'draft'])
  })

  await check('belső művelet (setMeta, restore) az argumentumból nem jöhet', async () => {
    const forged = await wikiService.write(caller(), {
      pages: [{ path: 'policies/a.md', action: 'setMeta', meta: { docStatus: 'approved', reviewedByUserId: olga.id } } as never],
    })
    assert.deepEqual(codes(forged), ['invalid_action'])
    assert.equal((await wikis.findPage(connector.id, 'policies/a.md'))!.docStatus, 'draft')
  })

  await check('kötelező mezők és ismeretlen gazda: új oldal nem menthető hiánnyal', async () => {
    const missing = await wikiService.write(caller(), { pages: [upsert('policies/b.md', 'policies', '## Summary\n\nx')] })
    assert.deepEqual(codes(missing), ['missing_field', 'missing_field'])
    const unknown = await wikiService.write(caller(), {
      pages: [upsert('policies/b.md', 'policies', '## Summary\n\nx', { owner: { email: 'nobody@nowhere.test' } }, { country: 'SK' })],
    })
    assert.deepEqual(codes(unknown), ['unknown_owner'])
  })

  await check('AC15: hiányzó kötelező fejezet — „hiba” kategóriában nem menthető, „figyelmeztetés” kategóriában igen', async () => {
    const blocked = await wikiService.write(caller(), {
      pages: [upsert('policies/c.md', 'policies', 'Nincs összefoglaló.', { owner: { userId: olga.id } }, { country: 'SK' })],
    })
    assert.deepEqual(codes(blocked), ['missing_section'])
    const warned = await wikiService.write(caller(), { pages: [upsert('partners/p.md', 'partners', 'Partner, kapcsolattartó nélkül.', { docStatus: 'draft' })] })
    assert.equal(warned.ok, true, JSON.stringify(warned))
    const warnings = (warned as { result: { warnings?: Array<{ code: string }> } }).result.warnings ?? []
    assert.ok(warnings.some((issue) => issue.code === 'missing_section'), JSON.stringify(warnings))
  })

  let seqBeforeApproval = 0
  await check('AC12: agent „jóváhagyott” kérése közvetlen írású kötésnél is függő change-set; a döntés állítja be', async () => {
    seqBeforeApproval = await new PostgresWikiHistoryRepository().latestSeq(wiki.id)
    const result = await wikiService.write(caller(), { pages: [{ path: 'policies/a.md', action: 'patch', docStatus: 'approved' }] })
    assert.equal(result.ok, 'approval', JSON.stringify(result))
    const approval = result as Extract<typeof result, { ok: 'approval' }>
    assert.equal(approval.request.reason, 'doc_status')
    assert.equal((await wikis.findPage(connector.id, 'policies/a.md'))!.docStatus, 'draft')
    const preview = await wikiService.previewChangeSet(tenant.id, approval.request.changeSetId)
    assert.deepEqual(preview!.pages[0].docStatusChange, { from: 'draft', to: 'approved' })
    const applied = await wikiService.applyApproved(caller(), approval.request.changeSetId)
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal((await wikis.findPage(connector.id, 'policies/a.md'))!.docStatus, 'approved')
    // D6: a tartalmi módosítás nem állítja vissza tervezetre.
    const page = (await wikis.findPage(connector.id, 'policies/a.md'))!
    const edit = await wikiService.write(caller(), {
      pages: [{ path: 'policies/a.md', action: 'patch', baseVersion: page.contentHash, patch: [{ op: 'appendToSection', section: 'Summary', text: 'Új mondat.' }] }],
    })
    assert.equal(edit.ok, true, JSON.stringify(edit))
    assert.equal((await wikis.findPage(connector.id, 'policies/a.md'))!.docStatus, 'approved')
  })

  await check('„Átnéztem” MCP-n: háttérfutásból hiba; interaktívan a munkamenet embere, a baseVersion nem évül el', async () => {
    const background = await wikiService.write(caller({ interactive: false }), { pages: [{ path: 'policies/a.md', action: 'review' }] })
    assert.equal(background.ok, false)
    assert.equal((background as { code: string }).code, 'review_requires_session')
    const before = (await wikis.findPage(connector.id, 'policies/a.md'))!
    const reviewed = await wikiService.write(caller(), { pages: [{ path: 'policies/a.md', action: 'review' }] })
    assert.equal(reviewed.ok, true, JSON.stringify(reviewed))
    const after = (await wikis.findPage(connector.id, 'policies/a.md'))!
    assert.equal(after.reviewedByUserId, admin.id)
    assert.ok(after.reviewedAt && after.reviewedAt.getTime() > Date.now() - 60_000)
    assert.equal(after.contentHash, before.contentHash)
    assert.equal(after.version, before.version + 1)
  })

  await check('AC11: lejárt átnézés — a felület és a kb_list_index reviewOverdue=true ugyanazt adja, a régóta lejártak elöl', async () => {
    await metadata.setPage(actor, connector.id, 'legacy/handbook.md', { reviewCycleDays: 10 })
    const now = await wikiService.queryView({ tenantId: tenant.id, connectorId: connector.id, wikiId: wiki.id, viewerUserId: admin.id, filter: { reviewOverdue: true } })
    assert.deepEqual(now!.pages.map((page) => page.path), ['legacy/handbook.md'])
    const ui = await metadataLater.views(actor, connector.id, { reviewOverdue: true })
    const mcp = (await executeKnowledgeBaseTool({} as never, 'kb_list_index', { wikiId: wiki.id, reviewOverdue: true }, {
      connectorId: connector.id, tenantId: tenant.id, agentId: agent.id, userId: admin.id, snapshot: caller().snapshot,
    }, wikiLater)) as { wikiView: { pages: Array<{ path: string; overdueDays?: number }> } }
    const expected = ['legacy/handbook.md', 'policies/a.md', 'partners/p.md']
    assert.deepEqual((ui as { pages: Array<{ path: string }> }).pages.map((page) => page.path), expected)
    assert.deepEqual(mcp.wikiView.pages.map((page) => page.path), expected)
    assert.ok(mcp.wikiView.pages[0].overdueDays! > mcp.wikiView.pages[1].overdueDays!)
  })

  await check('AC13: „Átnéztem” a felületen — eltűnik a lejárt nézetből, az audit rögzíti, ki nézte át', async () => {
    await metadataLater.review(actor, connector.id, 'legacy/handbook.md')
    const view = await wikiLater.queryView({ tenantId: tenant.id, connectorId: connector.id, wikiId: wiki.id, viewerUserId: admin.id, filter: { reviewOverdue: true } })
    assert.deepEqual(view!.pages.map((page) => page.path), ['policies/a.md', 'partners/p.md'])
    const rows = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: 'kb.wiki.page.reviewed' }, orderBy: { createdAt: 'asc' } })
    assert.equal(rows.length, 2)
    assert.equal((rows[1].metadata as { reviewedByUserId?: string }).reviewedByUserId, admin.id)
    assert.equal(rows[1].actorType, 'human')
  })

  await check('nézetek: tervezetek, saját / gazda e-mail, mező szerint, árva oldalak', async () => {
    const q = (filter: Parameters<WikiService['queryView']>[0]['filter'], viewerUserId = admin.id) =>
      wikiService.queryView({ tenantId: tenant.id, connectorId: connector.id, wikiId: wiki.id, viewerUserId, filter }).then((view) => view!.pages.map((page) => page.path).sort())
    assert.deepEqual(await q({ docStatus: ['draft'] }), ['partners/p.md'])
    assert.deepEqual(await q({ owner: ['me'] }, olga.id), ['legacy/handbook.md', 'policies/a.md'])
    assert.deepEqual(await q({ owner: [olga.email] }), ['legacy/handbook.md', 'policies/a.md'])
    assert.deepEqual(await q({ owner: ['nobody@nowhere.test'] }), [])
    assert.deepEqual(await q({ fields: [{ key: 'country', values: ['hu'] }] }), ['policies/a.md'])
    assert.deepEqual(await q({ fields: [{ key: 'unknown', values: ['x'] }] }), [])
    assert.deepEqual(await q({ category: ['partners'] }), ['partners/p.md'])
    assert.deepEqual(await q({ orphans: true }), ['legacy/handbook.md', 'legacy/other.md', 'policies/a.md'])
  })

  await check('kb_get_page metaadat, briefing-sor és időutazás (NFR-4)', async () => {
    const page = await wikiService.readPage({ tenantId: tenant.id, connectorId: connector.id, path: 'policies/a.md', explicitWiki: true })
    const meta = page!.metadata as Record<string, unknown>
    assert.equal(meta.docStatus, 'approved')
    assert.deepEqual(meta.owner, { userId: olga.id, name: 'Olga Owner', role: 'Sales vezető' })
    assert.deepEqual(meta.fields, { country: 'HU' })
    assert.equal(meta.reviewCycleDays, 30)
    assert.deepEqual(meta.requiredFields, ['country', 'owner'])
    assert.match(String(page!.text), /doc_status: "approved"/)
    const [briefing] = await wikiService.listWikis(caller())
    assert.deepEqual((briefing as { metadata?: unknown }).metadata, { reviewOverdue: 0, drafts: 1, fields: ['country'] })
    const [briefingLater] = await wikiLater.listWikis(caller())
    assert.equal((briefingLater as { metadata: { reviewOverdue: number } }).metadata.reviewOverdue, 2)
    const old = await wikiService.readPage({ tenantId: tenant.id, connectorId: connector.id, path: 'policies/a.md', explicitWiki: true, asOf: seqBeforeApproval })
    assert.equal(old!.docStatus, 'draft')
  })

  await check('NFR-5: a mező-szűrő a frontmatter GIN-indexét használja', async () => {
    const plan = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off')
      const rows = await tx.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(
        `EXPLAIN SELECT path FROM wiki_pages WHERE frontmatter @> '{"country":"HU"}'::jsonb`,
      )
      return rows.map((row) => row['QUERY PLAN']).join('\n')
    })
    assert.match(plan, /wiki_pages_frontmatter_idx/, plan)
  })

  await check('NFR-3: az audit-sorban nincs mezőnév, szerep-szöveg vagy választási érték', async () => {
    const rows = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: { startsWith: 'kb.wiki.' } } })
    const text = JSON.stringify(rows.map((row) => row.metadata))
    for (const forbidden of ['Ország', 'Sales vezető', '"HU"', 'Contacts']) assert.ok(!text.includes(forbidden), forbidden)
    const actions = new Set(rows.map((row) => row.action))
    for (const action of ['kb.wiki.fields.enabled', 'kb.wiki.field.created', 'kb.wiki.page.reviewed', 'kb.wiki.page.metadata_changed']) {
      assert.ok(actions.has(action), `${action} hiányzik`)
    }
  })

  await check('mező törlése: a kategória kötelező listájából is kikerül, az értékek maradnak; kikapcsolva a nézet leáll', async () => {
    const field = (await metadata.get(actor, connector.id)).fields.find((row) => row.key === 'country')!
    await metadata.removeField(actor, connector.id, field.id)
    const policies = (await structure.listCategories(wiki.id)).find((row) => row.id === policiesId)!
    assert.deepEqual(policies.requiredFields, ['owner'])
    assert.equal(((await wikis.findPage(connector.id, 'policies/a.md'))!.frontmatter as { country?: string }).country, 'HU')
    await metadata.disable(actor, connector.id)
    assert.equal((await metadata.views(actor, connector.id, { docStatus: ['draft'] })).managed, false)
    assert.equal((await wikis.findPage(connector.id, 'policies/a.md'))!.docStatus, 'approved')
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
