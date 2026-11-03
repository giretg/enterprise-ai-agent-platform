/**
 * #1075 — agent által javasolt wiki-beállítás valódi Postgresen: a teljes út a javaslattól a
 * jóváhagyásig, az elfogadási feltételek szerint.
 * Futtatás: DATABASE_URL=… npm run test:wiki-config-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { PostgresWikiConfigRepository, PostgresWikiRepository, PostgresWikiStructureRepository } from '../src/repositories/postgres/wiki-repository'
import { PostgresWikiHistoryRepository } from '../src/repositories/postgres/wiki-history-repository'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresConnectorRepository } from '../src/repositories/postgres/connector-repository'
import { PostgresAgentRepository } from '../src/repositories/postgres/agent-repository'
import { PostgresDocumentRepository } from '../src/repositories/postgres/knowledge-repository'
import { WikiService, type WikiCaller } from '../src/domain/knowledge-base/wiki-service'
import { WikiConsoleError, type WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import { WikiConfigError, WikiConfigService } from '../src/domain/knowledge-base/wiki-config-service'
import { WikiCategoryService } from '../src/domain/knowledge-base/wiki-category-service'
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

const wikis = new PostgresWikiRepository()
const structure = new PostgresWikiStructureRepository()
const audit = new PostgresAuditRepository()
const repo = new PostgresWikiConfigRepository()

type Row = Record<string, unknown>
function okResult(outcome: { ok: boolean; result?: unknown; code?: string; details?: unknown }): Row {
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  return outcome.result as Row
}
function failCode(outcome: { ok: boolean; code?: string }, code: string) {
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, code)
}

async function main() {
  console.log('=== #1075 wiki-konfig javaslat (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({ data: { slug: `wiki1075-${randomUUID().slice(0, 8)}`, displayName: 'Wiki teszt' } })
  const user = await prisma.user.create({ data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Admin' } })
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Rafael', roleInstruction: 'x' } })
  const otherAgent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Másik', roleInstruction: 'x' } })
  const connector = (await prisma.connector.create({
    data: { tenantId: tenant.id, type: 'knowledge_base', name: `kb:shared:${randomUUID()}`, authMode: 'agent_owned', scope: 'single', config: { displayName: 'Céges wiki', wikiTemplate: 'general' } },
  })) as Connector
  const wiki = await wikis.ensureForConnector({ connectorId: connector.id, schemaMd: '# WIKI\n' })
  await structure.setManaged(wiki.id, true)
  await structure.setFieldsManaged!(wiki.id, true)

  const connectors = new PostgresConnectorRepository()
  const wikiService = new WikiService({
    wikis,
    history: new PostgresWikiHistoryRepository(),
    structure,
    documents: new PostgresDocumentRepository(),
    connectors,
    agents: new PostgresAgentRepository(),
    knowledgeBase: { ingest: async () => { throw new Error('not used') }, getDocument: async () => { throw new Error('not used') } } as never,
    audit,
  })
  const actor: WikiConsoleActor = { userId: user.id, tenantId: tenant.id, role: 'admin' }
  const operatorActor: WikiConsoleActor = { ...actor, role: 'operator' }
  const service = new WikiConfigService({
    wiki: wikiService,
    wikiConsole: {
      authorize: (async (who: WikiConsoleActor, id: string) => {
        if (who.role !== 'admin') throw new WikiConsoleError('forbidden')
        const row = await connectors.findById(id, who.tenantId)
        if (!row) throw new WikiConsoleError('not_found')
        return { connector: row as Connector, access: { view: true, contribute: true, manage: true, metaOnly: false } }
      }) as never,
      displayName: async () => 'Céges wiki',
    },
    wikis,
    config: repo,
    agentNames: async (_tenant, ids) => new Map(ids.map((id) => [id, id === agent.id ? 'Rafael' : 'Másik'])),
    audit,
  })

  const binding = { connectorId: connector.id, type: 'knowledge_base', accessMode: 'write' as const, wikiAccess: 'write' as const, wikiCollectFocus: 'Saját fókusz' }
  const caller: WikiCaller = { tenantId: tenant.id, userId: user.id, agentId: agent.id, snapshot: { connectors: [binding] } }
  const otherCaller: WikiCaller = { ...caller, agentId: otherAgent.id }
  const readOnly: WikiCaller = { ...caller, snapshot: { connectors: [{ connectorId: connector.id, type: 'knowledge_base', accessMode: 'read' }] } }
  const version = async () => okResult(await service.get(caller, { wikiId: wiki.id })).configVersion as string
  const propose = async (operations: unknown[], extra: { validateOnly?: boolean; who?: WikiCaller; base?: string } = {}) =>
    service.propose(extra.who ?? caller, { wikiId: wiki.id, baseConfigVersion: extra.base ?? (await version()), operations, note: 'Teszt', validateOnly: extra.validateOnly })

  const seed = async (path: string, category: string | null, frontmatter: Row = {}) => {
    const result = await wikis.applyChangeSet({
      wikiId: wiki.id,
      connectorId: connector.id,
      changeSet: { create: { wikiId: wiki.id, connectorId: connector.id, agentId: agent.id, pages: [], approverScope: {} } },
      ops: [{
        kind: 'create',
        page: { path, type: 'entity', title: path, summary: 's', category, frontmatter: frontmatter as never, body: 'b', sourceRefs: [], outLinks: extractWikiLinks('b', path), status: 'published', contentHash: randomUUID() },
        createdByAgentId: agent.id,
        chunks: [],
      }],
      log: { op: 'ingest', title: 'seed', pagePaths: [path], actorAgentId: agent.id },
      appliedAt: new Date(),
    })
    assert.equal(result.ok, true, JSON.stringify(result))
  }

  // MOL Card PM méretű konfiguráció: 4 mező, 17 sablon, 18 csoport, 36 kategória.
  const fullConfig: unknown[] = [
    { op: 'setName', name: 'MOL Card Product Management Wiki' },
    { op: 'setCollectFocus', collect: 'Termék és partner tudás' },
    { op: 'setWikiMd', text: '# Wiki rules\n\nÚj szabályok.' },
    ...['direction', 'country', 'product', 'phase'].map((key) => ({ op: 'upsertMetadataField', key, label: key, type: 'select', options: ['a', 'b'] })),
    ...Array.from({ length: 17 }, (_, i) => ({ op: 'upsertTemplate', id: `tpl-${i}`, requiredFields: ['direction', 'owner'], requiredSections: ['Summary', 'Sources'], skeleton: '## Summary\n## Sources' })),
    ...Array.from({ length: 18 }, (_, i) => ({ op: 'upsertGroup', key: `group-${i}`, label: `Csoport ${i}`, order: (18 - i) * 10 })),
    ...Array.from({ length: 36 }, (_, i) => ({ op: 'upsertCategory', key: `group-${i % 18}/cat-${i}`, label: `Kategória ${i}`, order: (i + 1) * 10, pageSort: 'title', template: `tpl-${i % 17}`, reviewCycleDays: 180 })),
  ]

  await check('AC5: kikapcsolt beállításnál config_changes_disabled, de olvasni lehet', async () => {
    failCode(await propose([{ op: 'setName', name: 'x' }]), 'config_changes_disabled')
    assert.equal(okResult(await service.get(readOnly, { wikiId: wiki.id })).agentConfigChanges, 'off')
  })

  await service.setEnabled(actor, connector.id, true)

  await check('csak írási joggal lehet javasolni; nem kezelő nem kapcsolhat', async () => {
    failCode(await propose([{ op: 'setName', name: 'x' }], { who: readOnly }), 'wiki_write_not_allowed')
    await assert.rejects(() => service.setEnabled(operatorActor, connector.id, false), (error: unknown) => error instanceof WikiConsoleError && error.code === 'forbidden')
  })

  await check('AC9: hibás műveletnél nem jön létre javaslat, minden hiba indexszel látszik', async () => {
    const outcome = await propose([{ op: 'setName', name: 'Jó' }, { op: 'removeCategory', key: 'nincs' }, { op: 'upsertCategory', key: 'nincs/x', label: 'x' }])
    failCode(outcome, 'invalid_config_change')
    const errors = (outcome as unknown as { details: { errors: Array<{ index: number; code: string }> } }).details.errors
    assert.deepEqual(errors.map((row) => [row.index, row.code]), [[1, 'unknown_category'], [2, 'unknown_group']])
    assert.equal((await repo.listProposals(wiki.id, { pending: true, limit: 5 })).length, 0)
  })

  await check('validateOnly nem hoz létre javaslatot', async () => {
    const result = okResult(await propose(fullConfig, { validateOnly: true }))
    assert.equal(result.status, 'valid')
    assert.equal((await repo.listProposals(wiki.id, { pending: true, limit: 5 })).length, 0)
  })

  await check('AC2: elavult baseConfigVersion → config_conflict', async () => {
    failCode(await propose([{ op: 'setName', name: 'x' }], { base: 'elavult' }), 'config_conflict')
  })

  let fullId = ''
  await check('AC1: teljes konfiguráció egy javaslatban; jóváhagyás előtt semmi nem változik', async () => {
    const before = await version()
    const result = okResult(await propose(fullConfig))
    assert.equal(result.status, 'awaiting_approval')
    assert.match(String(result.approvalPath), new RegExp(`/control-plane/knowledge/${connector.id}\\?tab=proposals&proposal=`))
    fullId = String(result.proposalId)
    assert.equal(await version(), before)
    assert.equal((await structure.listCategories(wiki.id)).length, 0)
  })

  await check('egy agenttől egy nyitott javaslat; másik agent nem vonhatja vissza', async () => {
    failCode(await propose([{ op: 'setName', name: 'x' }]), 'proposal_pending')
    failCode(await service.withdraw(otherCaller, { wikiId: wiki.id, proposalId: fullId }), 'not_found')
  })

  await check('AC8: nem kezelő nem láthatja és nem hagyhatja jóvá', async () => {
    await assert.rejects(() => service.approve(operatorActor, connector.id, fullId), (error: unknown) => error instanceof WikiConsoleError && error.code === 'forbidden')
    await assert.rejects(() => service.review(operatorActor, connector.id, fullId), (error: unknown) => error instanceof WikiConsoleError && error.code === 'forbidden')
  })

  await check('a jóváhagyó oldal csoportosítva mutatja a változást', async () => {
    const review = await service.review(actor, connector.id, fullId)
    assert.equal(review.stale, false)
    assert.equal(review.diff.groups.added.length, 18)
    assert.equal(review.diff.categories.added.length, 36)
    assert.equal(review.diff.fields.added.length, 4)
    assert.equal(review.diff.templates.added.length, 17)
    assert.ok(review.diff.wikiMd)
    assert.ok(review.diff.name)
  })

  await check('AC1: egy jóváhagyás után minden él, az index menüsorrendben, újrapublikálás nélkül', async () => {
    await service.approve(actor, connector.id, fullId)
    const rows = await structure.listCategories(wiki.id)
    assert.equal(rows.length, 18 + 36)
    assert.equal((await structure.fieldSettings!(wiki.id)).fields.length, 4)
    assert.equal(rows.find((row) => row.key === 'cat-0')!.templateKey, 'tpl-0')
    const fresh = await wikis.findById(wiki.id)
    assert.equal(fresh!.schemaMd, '# Wiki rules\n\nÚj szabályok.\n')
    const live = (await connectors.findById(connector.id, tenant.id)) as Connector
    assert.equal((live.config as Row).displayName, 'MOL Card Product Management Wiki')
    assert.equal((live.config as Row).wikiTemplate, 'general')
    const index = await wikiService.indexFor(tenant.id, connector.id, caller)
    assert.equal((index as unknown as Row).collect, 'Termék és partner tudás\nSaját fókusz')
    const groups = (index as unknown as { categories: Array<{ category: string }> }).categories.map((row) => row.category)
    assert.equal(groups[0], 'group-17')
    assert.equal(groups[1], 'group-16')
    // Napló és előzmény: egy emberi change-set `schema` bejegyzéssel, audit tartalom nélkül.
    const log = await prisma.wikiLogEntry.findFirst({ where: { wikiId: wiki.id, op: 'schema' } })
    assert.equal(log!.title, 'Config: agent proposal approved')
    assert.equal(log!.actorUserId, user.id)
    const row = await repo.findProposal(fullId)
    assert.equal(row!.status, 'applied')
    assert.ok(row!.changeSetId)
    const audits = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: { startsWith: 'kb.wiki.config.' } }, select: { action: true, metadata: true } })
    assert.deepEqual([...new Set(audits.map((row) => row.action))].sort(), ['kb.wiki.config.applied', 'kb.wiki.config.proposed', 'kb.wiki.config.setting_changed'])
    assert.ok(!JSON.stringify(audits).includes('MOL Card'))
  })

  await check('a már elbírált javaslat nem hagyható jóvá újra', async () => {
    await assert.rejects(() => service.approve(actor, connector.id, fullId), (error: unknown) => error instanceof WikiConfigError && error.code === 'proposal_not_pending')
  })

  await check('AC2: jóváhagyáskor elavult → config_conflict, semmi nem íródik, a javaslat elutasítva', async () => {
    const id = String(okResult(await propose([{ op: 'setName', name: 'Elavuló' }])).proposalId)
    await service.setCollect(actor, connector.id, 'Közben változott')
    assert.equal((await service.review(actor, connector.id, id)).stale, true)
    await assert.rejects(() => service.approve(actor, connector.id, id), (error: unknown) => error instanceof WikiConfigError && error.code === 'config_conflict')
    assert.equal(((await connectors.findById(connector.id, tenant.id)) as Connector & { config: Row }).config.displayName, 'MOL Card Product Management Wiki')
    const row = await repo.findProposal(id)
    assert.deepEqual([row!.status, row!.decisionReason], ['rejected', 'config_conflict'])
  })

  await check('tranzakció alatt észlelt ütközés: visszagörget, semmi nem íródik', async () => {
    const id = String(okResult(await propose([{ op: 'setName', name: 'Versengő' }])).proposalId)
    const proposal = (await repo.findProposal(id))!
    const state = (await repo.readState(wiki.id))!
    const result = await wikiService.applyConfigChange({
      tenantId: tenant.id,
      userId: user.id,
      connector,
      wikiId: wiki.id,
      pages: [],
      configPlan: { proposalId: id, expectedVersion: 'régi-lenyomat', decidedByUserId: user.id, next: { ...state, name: 'Versengő' } },
      title: 'x',
      note: null,
    })
    assert.equal(result.ok, false)
    assert.equal((result as { code: string }).code, 'config_conflict')
    assert.equal((await repo.findProposal(id))!.status, 'pending')
    assert.equal(proposal.baseConfigVersion, (await repo.findProposal(id))!.baseConfigVersion)
    assert.equal(((await connectors.findById(connector.id, tenant.id)) as Connector & { config: Row }).config.displayName, 'MOL Card Product Management Wiki')
    okResult(await service.withdraw(caller, { wikiId: wiki.id, proposalId: id }))
  })

  await seed('a.md', 'group-0/cat-0', { direction: 'a', other: 'megmarad' })
  await seed('b.md', 'group-0/cat-0', { direction: 'b' })
  await seed('c.md', 'group-1/cat-1')

  await check('AC3: oldalas kategória törlése → category_not_empty', async () => {
    failCode(await propose([{ op: 'removeCategory', key: 'group-0/cat-0' }]), 'invalid_config_change')
  })

  await check('AC4 + AC7: merge és mező-átírás egy change-setben, revízióval, a kb_wiki_changes-ben', async () => {
    const result = okResult(await propose([
      { op: 'mergeCategory', from: 'group-0/cat-0', to: 'group-1/cat-1' },
      { op: 'renameFieldOption', field: 'direction', from: 'a', to: 'alfa' },
    ]))
    const id = String(result.proposalId)
    const review = await service.review(actor, connector.id, id)
    assert.deepEqual(review.destructive.map((row) => row.kind), ['merge', 'rename_option'])
    assert.deepEqual(review.pageChanges.map((row) => row.path).sort(), ['a.md', 'b.md'])
    await service.approve(actor, connector.id, id)
    const a = (await wikis.findPage(connector.id, 'a.md'))!
    assert.equal(a.category, 'group-1/cat-1')
    assert.equal(a.version, 2)
    assert.deepEqual([(a.frontmatter as Row).direction, (a.frontmatter as Row).other], ['alfa', 'megmarad'])
    const b = (await wikis.findPage(connector.id, 'b.md'))!
    assert.deepEqual([b.category, (b.frontmatter as Row).direction], ['group-1/cat-1', 'b'])
    assert.equal((await structure.listCategories(wiki.id)).some((row) => row.key === 'cat-0'), false)
    assert.equal((await structure.fieldSettings!(wiki.id)).fields.find((field) => field.key === 'direction')!.options.includes('alfa'), true)
    const changes = okResult(await wikiService.changes(caller, { wikiId: wiki.id, since: 0, limit: 50, markSeen: false })) as { changes: Array<{ logTitle?: string; title?: string; pages: Array<{ path: string }> }> }
    const moved = changes.changes.find((row) => row.pages.some((page) => page.path === 'a.md') && row.pages.length === 2)
    assert.ok(moved, JSON.stringify(changes.changes.map((row) => row.pages)))
    assert.equal((await repo.findProposal(id))!.status, 'applied')
  })

  await check('removeFieldOption remapTo: az oldal frontmatterje átíródik', async () => {
    const id = String(okResult(await propose([{ op: 'removeFieldOption', field: 'direction', option: 'b', remapTo: 'alfa' }])).proposalId)
    await service.approve(actor, connector.id, id)
    assert.equal(((await wikis.findPage(connector.id, 'b.md'))!.frontmatter as Row).direction, 'alfa')
  })

  await check('AC6: az elutasító megjegyzés visszajut az agenthez; a log.md-be is bekerül', async () => {
    const id = String(okResult(await propose([{ op: 'setName', name: 'Nem jó név' }])).proposalId)
    await service.reject(actor, connector.id, id, 'Maradjon a régi név')
    const seen = okResult(await service.get(caller, { wikiId: wiki.id })) as { recentProposals: Array<Row>; pendingProposals: unknown[] }
    assert.equal(seen.pendingProposals.length, 0)
    const recent = seen.recentProposals.find((row) => row.proposalId === id)!
    assert.deepEqual([recent.status, recent.comment], ['rejected', 'Maradjon a régi név'])
    const log = await prisma.wikiLogEntry.findFirst({ where: { wikiId: wiki.id, title: 'Config: agent proposal rejected', note: 'Maradjon a régi név' } })
    assert.ok(log)
  })

  await check('a saját javaslat visszavonható, utána újat lehet küldeni', async () => {
    const id = String(okResult(await propose([{ op: 'setName', name: 'Első' }])).proposalId)
    assert.equal(okResult(await service.withdraw(caller, { wikiId: wiki.id, proposalId: id })).status, 'withdrawn')
    failCode(await service.withdraw(caller, { wikiId: wiki.id, proposalId: id }), 'proposal_not_pending')
    const again = String(okResult(await propose([{ op: 'setName', name: 'Második' }])).proposalId)
    okResult(await service.withdraw(caller, { wikiId: wiki.id, proposalId: again }))
  })

  await check('változtatás nélküli javaslat nem jön létre', async () => {
    failCode(await propose([{ op: 'setName', name: 'MOL Card Product Management Wiki' }]), 'invalid_config_change')
  })

  await check('felületi sablon-szerkesztés leválasztja a kategóriát a névvel ellátott sablonról', async () => {
    const categories = new WikiCategoryService({
      wikiConsole: { authorize: async () => ({ connector, access: { view: true, contribute: true, manage: true, metaOnly: false } }) } as never,
      wiki: wikiService,
      wikis,
      structure,
      audit,
    })
    const row = (await structure.listCategories(wiki.id)).find((item) => item.key === 'cat-2')!
    assert.equal(row.templateKey, 'tpl-2')
    await categories.update(actor, connector.id, row.id, { description: 'csak leírás' })
    assert.equal((await structure.listCategories(wiki.id)).find((item) => item.key === 'cat-2')!.templateKey, 'tpl-2')
    await categories.update(actor, connector.id, row.id, { requiredSections: ['Más'] })
    assert.equal((await structure.listCategories(wiki.id)).find((item) => item.key === 'cat-2')!.templateKey, null)
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
