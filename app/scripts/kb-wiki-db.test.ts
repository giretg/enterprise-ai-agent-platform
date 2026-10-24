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
