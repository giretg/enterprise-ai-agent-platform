/**
 * #943 LLM Wiki 2/6 — a change-set alkalmazása valódi Postgresen (migrált séma):
 * - egy tranzakció: oldal + revízió + chunk a wiki-konténer alatt + napló + tálca;
 * - verzió-ütközésnél semmi nem marad (rollback, a change-set sem jön létre);
 * - áthelyezésnél a régi path chunkjai eltűnnek, archiválásnál minden chunk;
 * - jóváhagyott change-set csak `pending`-ből alkalmazható; elutasításkor a tétel visszanyitható.
 * Futtatás: DATABASE_URL=… npm run test:kb-wiki-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PostgresWikiRepository } from '../src/repositories/postgres/wiki-repository'
import type { WikiApplyPageOp } from '../src/repositories/interfaces'

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

function page(path: string, body: string, hash: string) {
  return { path, type: 'entity' as const, title: path, summary: 's', body, contentHash: hash, sourceRefs: [] }
}

function chunk(path: string, text: string) {
  return { path, title: path, type: 'entity', section: path, chunkIndex: 0, text, sourceRef: null, contentHash: text }
}

async function main() {
  console.log('=== #943 wiki change-set (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({
    data: { slug: `wiki943-${randomUUID().slice(0, 8)}`, displayName: 'Wiki teszt' },
  })
  const user = await prisma.user.create({
    data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'T' },
  })
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Wiki-agent', roleInstruction: 'x' } })
  const connector = await prisma.connector.create({
    data: { tenantId: tenant.id, type: 'knowledge_base', name: `kb:${agent.id}`, authMode: 'agent_owned', scope: 'single' },
  })
  const wiki = await wikis.ensureForConnector({ connectorId: connector.id, schemaMd: '# WIKI' })
  const doc = await prisma.document.create({
    data: {
      tenantId: tenant.id,
      filename: 'forras.md',
      extractedText: 'x',
      connectorId: connector.id,
      uploadedById: user.id,
      status: 'processed',
      wikiStatus: 'in_progress',
      wikiClaimedByAgentId: agent.id,
      wikiClaimExpiresAt: new Date(Date.now() + 3_600_000),
    },
  })
  const base = {
    wikiId: wiki.id,
    connectorId: connector.id,
    log: { op: 'ingest' as const, title: 'Első', pagePaths: ['entities/a.md'], actorAgentId: agent.id },
    appliedAt: new Date(),
  }
  const newSet = () => ({
    create: { wikiId: wiki.id, connectorId: connector.id, agentId: agent.id, pages: [], approverScope: {} },
  })

  let pageA = ''
  await check('létrehozás: oldal, revízió, chunk a konténer alatt, napló, tálca processed', async () => {
    const result = await wikis.applyChangeSet({
      ...base,
      changeSet: newSet(),
      ops: [{ kind: 'create', page: page('entities/a.md', 'A', 'h1'), createdByAgentId: agent.id, chunks: [chunk('entities/a.md', 'alma')] }],
      inbox: { documentId: doc.id, final: true, agentId: agent.id, claimExpiresAt: new Date() },
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    if (!result.ok) return
    pageA = result.pages[0].id
    const container = await wikis.findContainerArtifactId(connector.id)
    assert.ok(container)
    const chunks = await prisma.knowledgeChunk.findMany({ where: { artifactId: container! } })
    assert.deepEqual(chunks.map((c) => c.text), ['alma'])
    assert.equal((await wikis.listRevisions(pageA)).length, 1)
    assert.equal((await wikis.listLog(wiki.id)).length, 1)
    const after = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } })
    assert.equal(after.wikiStatus, 'processed')
    assert.equal(after.wikiProcessedByChangeSetId, result.changeSetId)
    assert.equal((await wikis.findChangeSet(result.changeSetId))!.status, 'applied')
  })

  await check('ütközés: elavult verzió → semmi nem marad (új oldal, change-set, napló sem)', async () => {
    const setsBefore = await prisma.wikiChangeSet.count({ where: { connectorId: connector.id } })
    const ops: WikiApplyPageOp[] = [
      { kind: 'create', page: page('entities/b.md', 'B', 'hb'), createdByAgentId: agent.id, chunks: [chunk('entities/b.md', 'banán')] },
      { kind: 'update', pageId: pageA, expectedVersion: 99, previousPath: 'entities/a.md', page: page('entities/a.md', 'A2', 'h2'), chunks: [] },
    ]
    const result = await wikis.applyChangeSet({ ...base, changeSet: newSet(), ops })
    assert.deepEqual(result, { ok: false, reason: 'conflict', path: 'entities/a.md' })
    assert.equal(await wikis.findPage(connector.id, 'entities/b.md'), null)
    assert.equal(await prisma.wikiChangeSet.count({ where: { connectorId: connector.id } }), setsBefore)
    assert.equal((await wikis.listLog(wiki.id)).length, 1)
    assert.equal(await prisma.knowledgeChunk.count({ where: { connectorId: connector.id, text: 'banán' } }), 0)
  })

  await check('áthelyezés: a régi path chunkjai eltűnnek; archiválás: chunk nélkül', async () => {
    const moved = await wikis.applyChangeSet({
      ...base,
      changeSet: newSet(),
      ops: [{ kind: 'update', pageId: pageA, expectedVersion: 1, previousPath: 'entities/a.md', page: page('entities/alma.md', 'A2', 'h2'), chunks: [chunk('entities/alma.md', 'alma2')] }],
    })
    assert.equal(moved.ok, true, JSON.stringify(moved))
    const paths = (await prisma.knowledgeChunk.findMany({ where: { connectorId: connector.id } })).map((c) => c.path)
    assert.deepEqual(paths, ['entities/alma.md'])
    const archived = await wikis.applyChangeSet({
      ...base,
      changeSet: newSet(),
      ops: [{ kind: 'update', pageId: pageA, expectedVersion: 2, previousPath: 'entities/alma.md', page: { ...page('entities/alma.md', 'A2', 'h2'), status: 'archived' }, chunks: [] }],
    })
    assert.equal(archived.ok, true)
    assert.equal(await prisma.knowledgeChunk.count({ where: { connectorId: connector.id } }), 0)
    assert.equal((await wikis.findPage(connector.id, 'entities/alma.md'))!.status, 'archived')
    assert.equal((await wikis.listRevisions(pageA)).length, 3)
  })

  await check('jóváhagyott change-set: csak pending-ből; elutasításkor a tálca-tétel visszanyitható', async () => {
    const pending = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, pages: [], approverScope: {} })
    const ok = await wikis.applyChangeSet({
      ...base,
      changeSet: { id: pending.id },
      ops: [{ kind: 'create', page: page('entities/c.md', 'C', 'hc'), createdByAgentId: agent.id, chunks: [] }],
    })
    assert.equal(ok.ok, true)
    const again = await wikis.applyChangeSet({ ...base, changeSet: { id: pending.id }, ops: [] })
    assert.deepEqual(again, { ok: false, reason: 'changeset_not_pending' })

    const rejected = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, pages: [], approverScope: {} })
    const doc2 = await prisma.document.create({
      data: { tenantId: tenant.id, filename: 'b.md', connectorId: connector.id, uploadedById: user.id, status: 'processed', wikiStatus: 'pending' },
    })
    assert.equal(await wikis.markInboxProcessed({ documentId: doc2.id, changeSetId: rejected.id }), true)
    assert.equal(await wikis.reopenInboxItem({ documentId: doc2.id, changeSetId: rejected.id }), true)
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: doc2.id } })).wikiStatus, 'pending')
  })

  await check('#1077 listPagesCitingDocuments: csak a publikált, ugyanebben a tudástárban hivatkozó oldal', async () => {
    const cited = randomUUID()
    const other = randomUUID()
    const create = async (path: string, sourceRefs: unknown, status: 'published' | 'archived' = 'published') =>
      prisma.wikiPage.create({
        data: { wikiId: wiki.id, connectorId: connector.id, path, type: 'entity', title: path, summary: 's', body: 'b', contentHash: path, sourceRefs: sourceRefs as never, status },
      })
    await create('entities/cite-1.md', [{ documentId: cited }, { documentId: cited, page: 2 }])
    await create('entities/cite-own.md', [{ documentId: cited, connectorId: connector.id }])
    await create('entities/cite-archived.md', [{ documentId: cited }], 'archived')
    await create('entities/cite-foreign.md', [{ documentId: cited, connectorId: randomUUID() }])
    await create('entities/cite-other.md', [{ documentId: other }])
    await create('entities/cite-note.md', [{ kind: 'human_note', occasion: 'x' }])
    await create('entities/cite-not-array.md', { documentId: cited })
    const rows = await wikis.listPagesCitingDocuments([connector.id], [cited])
    assert.deepEqual(rows, [
      { documentId: cited, path: 'entities/cite-1.md', title: 'entities/cite-1.md' },
      { documentId: cited, path: 'entities/cite-own.md', title: 'entities/cite-own.md' },
    ])
    assert.deepEqual(await wikis.listPagesCitingDocuments([connector.id], []), [])
    assert.deepEqual(await wikis.listPagesCitingDocuments([randomUUID()], [cited]), [])
  })

  await check('#1085 újrafeldolgozás SQL: korábbi állapot, státusz, összesítő, jóváhagyás-kapu, Mégse, lezárás', async () => {
    const now = new Date()
    const batchId = randomUUID()
    const changeSet = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, status: 'applied', pages: [], approverScope: {} })
    const create = (filename: string, data: Record<string, unknown>) =>
      prisma.document.create({
        data: { tenantId: tenant.id, filename, connectorId: connector.id, uploadedById: user.id, status: 'processed', wikiBatchId: batchId, ...data } as never,
      })
    const processed = await create('rp-processed.md', { wikiStatus: 'processed', wikiProcessedByChangeSetId: changeSet.id })
    const skipped = await create('rp-skipped.md', { wikiStatus: 'skipped' })
    const waiting = await create('rp-waiting.md', { wikiStatus: 'pending' })
    const blocked = await create('rp-blocked.md', { wikiStatus: 'processed' })
    const blockedBySource = await create('rp-blocked-source.md', { wikiStatus: 'processed' })
    const raw = await prisma.document.create({
      data: { tenantId: tenant.id, filename: 'rp-raw.md', connectorId: connector.id, uploadedById: user.id, status: 'processed' },
    })
    const pending = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, status: 'pending', pages: [], inboxItemId: blocked.id, approverScope: {} })
    const pendingBySource = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, status: 'pending', pages: [], sourceDocumentIds: [blockedBySource.id], approverScope: {} })
    // Régebbi change-setnél is csak az oldal hivatkozásában lehet meg a forrás.
    const cited = await create('rp-cited.md', { wikiStatus: 'processed', wikiBatchId: null })
    const citedPage = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, status: 'pending', pages: [{ path: 'sources/cited.md', frontmatter: { sources: [{ documentId: cited.id }] } }], approverScope: {} })
    const citedRequest = () => wikis.requestReprocess({ connectorId: connector.id, target: { documentId: cited.id }, reason: 'Újra', requestedBy: { kind: 'human', userId: user.id }, now })
    assert.deepEqual((await citedRequest()).waitingForApproval, [cited.id])
    await wikis.transitionChangeSet(citedPage.id, 'pending', 'rejected')
    await wikis.createPage({ wikiId: wiki.id, connectorId: connector.id, ...page('sources/cited.md', 'Cited', 'cited-hash'), sourceRefs: [{ documentId: cited.id }], createdByAgentId: agent.id })
    const patch = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, status: 'pending', pages: [{ path: 'sources/cited.md', action: 'patch' }], approverScope: {} })
    assert.deepEqual((await citedRequest()).waitingForApproval, [cited.id], 'a meglévő oldal megtartott forrása is blokkol')
    await wikis.transitionChangeSet(patch.id, 'pending', 'rejected')
    assert.deepEqual((await citedRequest()).marked, [cited.id])

    const requestedBy = { kind: 'human' as const, userId: user.id }
    const request = (target: { documentId: string } | { batchId: string }, reason = 'Hibás') =>
      wikis.requestReprocess({ connectorId: connector.id, target, reason, requestedBy, now })

    // Nem wiki-forrás és idegen tudástár: semmi.
    assert.deepEqual(await request({ documentId: raw.id }), { marked: [], waitingForApproval: [], alreadyInInbox: [] })
    assert.deepEqual(
      await wikis.requestReprocess({ connectorId: randomUUID(), target: { documentId: processed.id }, reason: 'x', requestedBy, now }),
      { marked: [], waitingForApproval: [], alreadyInInbox: [] },
    )

    const single = await request({ documentId: processed.id }, 'Idézőjel " és \\ jel')
    assert.deepEqual(single, { marked: [processed.id], waitingForApproval: [], alreadyInInbox: [] })
    const after = await prisma.document.findUniqueOrThrow({ where: { id: processed.id } })
    assert.equal(after.wikiStatus, 'pending')
    assert.equal(after.wikiProcessedByChangeSetId, null)
    assert.deepEqual(after.wikiReprocess, {
      reason: 'Idézőjel " és \\ jel',
      requestedAt: now.toISOString(),
      requestedBy,
      previousStatus: 'processed',
      previousChangeSetId: changeSet.id,
    })

    const bulk = await request({ batchId })
    assert.deepEqual(bulk.marked, [skipped.id])
    assert.deepEqual(new Set(bulk.waitingForApproval), new Set([blocked.id, blockedBySource.id]))
    assert.deepEqual(new Set(bulk.alreadyInInbox), new Set([processed.id, waiting.id]))

    const items = await wikis.listInbox([connector.id], { now, batchId })
    assert.deepEqual(
      Object.fromEntries(items.map((item) => [item.filename, item.status])),
      { 'rp-processed.md': 'reprocess', 'rp-skipped.md': 'reprocess', 'rp-waiting.md': 'pending' },
    )
    assert.equal(items.find((item) => item.documentId === processed.id)!.reprocess!.previousChangeSetId, changeSet.id)
    const withDone = await wikis.listInbox([connector.id], { now, batchId, includeDone: true })
    assert.equal(withDone.length, 5)
    assert.deepEqual(withDone.slice(-2).map((item) => item.status), ['processed', 'processed'], 'a lezártak a várakozók után')
    const summary = await wikis.inboxSummary([connector.id], { now, batchId })
    const { connectorId: _c, batchId: _b, ...counts } = summary.batches[0]
    assert.deepEqual(counts, { pending: 1, reprocess: 2, inProgress: 0, processed: 2, skipped: 0 })

    // A foglalás nem veszti el a jelölést; lejárat után újra reprocess.
    const hour = 3_600_000
    assert.equal(await wikis.claimInboxItem({ documentId: processed.id, connectorId: connector.id, agentId: agent.id, now, expiresAt: new Date(now.getTime() + hour) }), true)
    assert.equal((await wikis.listInbox([connector.id], { now, batchId })).find((item) => item.documentId === processed.id)!.status, 'in_progress')
    const later = new Date(now.getTime() + 2 * hour)
    assert.equal((await wikis.listInbox([connector.id], { now: later, batchId })).find((item) => item.documentId === processed.id)!.status, 'reprocess')

    // Lejárt, hiányzó vagy más agent foglalásával nem zárható le.
    const finish = (at: Date) => wikis.finishReprocessUnchanged({ documentId: processed.id, connectorId: connector.id, agentId: agent.id, now: at })
    assert.equal(await finish(new Date(now.getTime() + hour)), false, 'a lejárat pillanatától nincs élő foglalás')
    assert.equal(await finish(later), false, 'lejárt foglalással nem zárható le')
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: processed.id } })).wikiStatus, 'in_progress')
    await prisma.document.update({ where: { id: processed.id }, data: { wikiClaimExpiresAt: null } })
    assert.equal(await finish(now), false, 'lejárati idő nélkül nincs élő foglalás')
    await wikis.claimInboxItem({ documentId: processed.id, connectorId: connector.id, agentId: agent.id, now, expiresAt: new Date(now.getTime() + hour) })

    // Más agent nem zárhatja le; a saját igen, és visszaáll az előző változás.
    assert.equal(await wikis.finishReprocessUnchanged({ documentId: processed.id, connectorId: connector.id, agentId: randomUUID(), now }), false)
    assert.equal(await wikis.finishReprocessUnchanged({ documentId: processed.id, connectorId: connector.id, agentId: agent.id, now }), true)
    const finished = await prisma.document.findUniqueOrThrow({ where: { id: processed.id } })
    assert.equal(finished.wikiStatus, 'processed')
    assert.equal(finished.wikiProcessedByChangeSetId, changeSet.id)
    assert.equal(finished.wikiClaimedByAgentId, null)
    assert.equal((finished.wikiReprocess as { outcome?: string }).outcome, 'unchanged')
    assert.equal(await wikis.finishReprocessUnchanged({ documentId: processed.id, connectorId: connector.id, agentId: agent.id, now }), false)

    // Lezárt tétel újra jelölhető: a jelölés felülíródik, az előző változás megmarad.
    assert.deepEqual((await request({ documentId: processed.id }, 'Még egyszer')).marked, [processed.id])
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: processed.id } })).wikiReprocess!['previousChangeSetId' as never], changeSet.id as never)

    // Mégse: visszaáll a korábbi állapot, a jelölés törlődik.
    assert.equal(await wikis.cancelReprocess({ documentId: processed.id, connectorId: connector.id }), true)
    const cancelled = await prisma.document.findUniqueOrThrow({ where: { id: processed.id } })
    assert.equal(cancelled.wikiStatus, 'processed')
    assert.equal(cancelled.wikiProcessedByChangeSetId, changeSet.id)
    assert.equal(cancelled.wikiReprocess, null)
    assert.equal(await wikis.cancelReprocess({ documentId: skipped.id, connectorId: randomUUID() }), false)
    assert.equal(await wikis.cancelReprocess({ documentId: skipped.id, connectorId: connector.id }), true)
    assert.equal((await prisma.document.findUniqueOrThrow({ where: { id: skipped.id } })).wikiStatus, 'skipped')
    assert.equal(await wikis.cancelReprocess({ documentId: waiting.id, connectorId: connector.id }), false, 'jelölés nélkül nincs mit visszavonni')

    // Elutasításkor újra reprocess: a kérés nincs teljesítve.
    assert.deepEqual((await request({ documentId: processed.id }, 'Újra')).marked, [processed.id])
    const attempt = await wikis.createChangeSet({ wikiId: wiki.id, connectorId: connector.id, status: 'pending', pages: [], inboxItemId: processed.id, approverScope: {} })
    assert.equal(await wikis.markInboxProcessed({ documentId: processed.id, changeSetId: attempt.id }), true)
    assert.equal(await wikis.reopenInboxItem({ documentId: processed.id, changeSetId: attempt.id }), true)
    assert.equal((await wikis.listInbox([connector.id], { now, batchId })).find((item) => item.documentId === processed.id)!.status, 'reprocess')

    await prisma.wikiChangeSet.deleteMany({ where: { id: { in: [pending.id, pendingBySource.id, attempt.id] } } })
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
