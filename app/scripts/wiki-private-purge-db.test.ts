/**
 * #942 LLM Wiki 1/6 — valódi Postgres (migrált séma) kell hozzá:
 * - privát KB végleges törlése után egyetlen sor sem marad (forrás, oldal, revízió,
 *   chunk, artifact, change-set, napló, tálca, agent-kötés), a közös KB érintetlen;
 * - 30 napos késleltetett törlés (időeltolással): 31 napja eltávolított tulajdonos
 *   KB-ja törlődik, a 29 napja eltávolítotté és az aktív tagé marad;
 * - tálca-SQL: lejárt foglalás = pending, CAS-foglalás, köteg-összesítő.
 * Futtatás: DATABASE_URL=… npm run test:wiki-private-purge-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { WikiAccessService } from '../src/domain/knowledge-base/wiki-access-service'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresAgentRepository } from '../src/repositories/postgres/agent-repository'
import { PostgresConnectorRepository } from '../src/repositories/postgres/connector-repository'
import {
  PostgresPrivateKnowledgeBaseStore,
  PostgresWikiRepository,
} from '../src/repositories/postgres/wiki-repository'

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
const store = new PostgresPrivateKnowledgeBaseStore()
const audit = new PostgresAuditRepository()

function service(now = new Date()) {
  return new WikiAccessService({
    connectors: new PostgresConnectorRepository(),
    agents: new PostgresAgentRepository(),
    wikis,
    privateKnowledgeBases: store,
    audit,
    now: () => now,
  })
}

async function seedUser(tenantId: string, status: 'active' | 'suspended', removedDaysAgo = 0) {
  const user = await prisma.user.create({
    data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'T' },
  })
  const membership = await prisma.tenantMembership.create({
    data: { tenantId, userId: user.id, role: 'viewer', status: 'active' },
  })
  if (status === 'suspended') {
    await prisma.tenantMembership.update({ where: { id: membership.id }, data: { status: 'suspended' } })
    // A felfüggesztés idejét időeltolással állítjuk (a sweep `updated_at`-et néz).
    await prisma.$executeRaw`UPDATE tenant_memberships SET updated_at = ${new Date(Date.now() - removedDaysAgo * DAY)} WHERE id = ${membership.id}::uuid`
  }
  return user
}

/** Teljes privát KB tartalommal: forrás, artifact+chunk, wiki-oldal+revízió, change-set, napló, tálca, agent-kötés. */
async function seedPrivateKb(tenantId: string, ownerUserId: string, agentId: string) {
  const kb = await service().createPrivateKnowledgeBase({
    actor: { userId: ownerUserId, tenantId, role: 'viewer' },
    displayName: 'Egészség-napló',
  })
  await service().linkKnowledgeBase({
    actor: { userId: ownerUserId, tenantId, role: 'viewer' },
    agentId,
    connectorId: kb.id,
  })
  const doc = await prisma.document.create({
    data: {
      tenantId,
      filename: 'lelet-2024.pdf',
      extractedText: 'HbA1c 6.1',
      connectorId: kb.id,
      uploadedById: ownerUserId,
      status: 'processed',
      contentHash: 'h1',
      wikiStatus: 'pending',
    },
  })
  const artifact = await prisma.knowledgeArtifact.create({
    data: { connectorId: kb.id, status: 'published', format: 'llm_wiki', contentHash: 'c', bundle: {} },
  })
  await prisma.knowledgeChunk.create({
    data: {
      artifactId: artifact.id,
      connectorId: kb.id,
      path: 'conditions/cukorbetegseg.md',
      title: 'Cukorbetegség',
      type: 'concept',
      chunkIndex: 0,
      text: 'x',
      contentHash: 'c',
    },
  })
  const wiki = await wikis.ensureForConnector({ connectorId: kb.id, schemaMd: '# WIKI' })
  const changeSet = await wikis.createChangeSet({
    wikiId: wiki.id,
    connectorId: kb.id,
    agentId,
    pages: [{ path: 'conditions/cukorbetegseg.md' }],
    approverScope: { kind: 'owner_user', userId: ownerUserId },
  })
  const page = await wikis.createPage({
    wikiId: wiki.id,
    connectorId: kb.id,
    path: 'conditions/cukorbetegseg.md',
    type: 'concept',
    title: 'Cukorbetegség',
    summary: 's',
    body: 'b',
    sourceRefs: [{ documentId: doc.id }],
    contentHash: 'p1',
    createdByAgentId: agentId,
    changeSetId: changeSet.id,
  })
  const updated = await wikis.updatePage(page.id, 1, {
    body: 'b2',
    contentHash: 'p2',
    changeSetId: changeSet.id,
  })
  assert.equal(updated?.version, 2)
  await wikis.appendLog({ wikiId: wiki.id, op: 'ingest', title: 'Lelet 2024', changeSetId: changeSet.id })
  return { kb, doc, wiki, page }
}

async function rowsForConnector(connectorId: string) {
  const pageIds = (await prisma.wikiPage.findMany({ where: { connectorId }, select: { id: true } })).map(
    (r) => r.id,
  )
  return {
    connectors: await prisma.connector.count({ where: { id: connectorId } }),
    documents: await prisma.document.count({ where: { connectorId } }),
    artifacts: await prisma.knowledgeArtifact.count({ where: { connectorId } }),
    chunks: await prisma.knowledgeChunk.count({ where: { connectorId } }),
    wikis: await prisma.agentWiki.count({ where: { connectorId } }),
    pages: pageIds.length,
    changeSets: await prisma.wikiChangeSet.count({ where: { connectorId } }),
    logEntries: await prisma.wikiLogEntry.count({ where: { wiki: { connectorId } } }),
    agentLinks: await prisma.agentConnector.count({ where: { connectorId } }),
  }
}

async function main() {
  console.log('=== #942 privát KB törlés + tálca (Postgres) ===')
  // A sweep tenant-függetlenül töröl: csak helyi / CI-s eldobható DB-n fusson.
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({
    data: { slug: `wiki942-${randomUUID().slice(0, 8)}`, displayName: 'Wiki teszt' },
  })
  const owner = await seedUser(tenant.id, 'active')
  const agent = await prisma.agent.create({
    data: { tenantId: tenant.id, name: 'Egészség-agent', roleInstruction: 'x' },
  })

  await check('DB check constraint: privát KB tulajdonos nélkül nem jöhet létre', async () => {
    await assert.rejects(
      prisma.$executeRaw`INSERT INTO connectors (id, type, name, scope, tenant_id, visibility)
        VALUES (${randomUUID()}::uuid, 'knowledge_base', ${`kb:private:${randomUUID()}`}, 'single', ${tenant.id}::uuid, 'private_to_user')`,
    )
    await assert.rejects(
      prisma.$executeRaw`INSERT INTO connectors (id, type, name, scope, tenant_id, visibility, owner_user_id)
        VALUES (${randomUUID()}::uuid, 'gmail', ${`gm:${randomUUID()}`}, 'single', ${tenant.id}::uuid, 'private_to_user', ${owner.id}::uuid)`,
    )
  })

  await check(
    'végleges törlés után a privát KB-hoz egyetlen sor sem marad; a közös KB érintetlen',
    async () => {
      const shared = await prisma.connector.create({
        data: {
          tenantId: tenant.id,
          type: 'knowledge_base',
          name: `kb:${agent.id}`,
          authMode: 'agent_owned',
          scope: 'single',
        },
      })
      const sharedDoc = await prisma.document.create({
        data: {
          tenantId: tenant.id,
          filename: 'kozos.md',
          connectorId: shared.id,
          uploadedById: owner.id,
          status: 'processed',
        },
      })
      const { kb, page } = await seedPrivateKb(tenant.id, owner.id, agent.id)
      const before = await rowsForConnector(kb.id)
      assert.ok(
        before.documents &&
          before.chunks &&
          before.pages &&
          before.changeSets &&
          before.logEntries &&
          before.agentLinks,
      )
      assert.equal(await prisma.wikiPageRevision.count({ where: { pageId: page.id } }), 2)

      const counts = await service().purgePrivateKnowledgeBase({
        actor: { userId: owner.id, tenantId: tenant.id, role: 'viewer' },
        connectorId: kb.id,
      })
      assert.equal(counts.revisions, 2)
      assert.equal(counts.documents, 1)
      const after = await rowsForConnector(kb.id)
      for (const [table, n] of Object.entries(after)) assert.equal(n, 0, `${table} maradt: ${n}`)
      assert.equal(await prisma.wikiPageRevision.count({ where: { pageId: page.id } }), 0)
      assert.equal(await prisma.document.count({ where: { id: sharedDoc.id } }), 1)

      const auditRows = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, targetId: kb.id } })
      assert.ok(auditRows.some((row) => row.action === 'kb.private.deleted'))
      const json = JSON.stringify(auditRows, (_key, value) =>
        typeof value === 'bigint' ? String(value) : value,
      )
      for (const leak of ['Egészség-napló', 'lelet-2024.pdf', 'cukorbetegseg', 'Cukorbetegség']) {
        assert.ok(!json.includes(leak), `audit-szivárgás: ${leak}`)
      }
    },
  )

  await check('30 napos késleltetett törlés: 31 nap → törlődik, 29 nap és aktív tag → marad', async () => {
    const gone = await seedUser(tenant.id, 'suspended', 31)
    const recent = await seedUser(tenant.id, 'suspended', 29)
    const goneKb = await seedPrivateKb(tenant.id, gone.id, agent.id)
    const recentKb = await seedPrivateKb(tenant.id, recent.id, agent.id)
    const activeKb = await seedPrivateKb(tenant.id, owner.id, agent.id)

    await service().sweepOrphanedPrivateKnowledgeBases()
    assert.equal((await rowsForConnector(goneKb.kb.id)).connectors, 0)
    assert.equal((await rowsForConnector(goneKb.kb.id)).documents, 0)
    assert.equal((await rowsForConnector(recentKb.kb.id)).connectors, 1)
    assert.equal((await rowsForConnector(activeKb.kb.id)).connectors, 1)

    // Időeltolás: 2 nap múlva a 29 napos is lejár.
    await service(new Date(Date.now() + 2 * DAY)).sweepOrphanedPrivateKnowledgeBases()
    assert.equal((await rowsForConnector(recentKb.kb.id)).connectors, 0)
    assert.equal((await rowsForConnector(activeKb.kb.id)).connectors, 1)
  })

  await check('visszaállított (újra aktív) tulajdonos KB-ja nem törlődik', async () => {
    const back = await seedUser(tenant.id, 'suspended', 40)
    const backKb = await seedPrivateKb(tenant.id, back.id, agent.id)
    await prisma.tenantMembership.updateMany({ where: { userId: back.id }, data: { status: 'active' } })
    await service().sweepOrphanedPrivateKnowledgeBases()
    assert.equal((await rowsForConnector(backKb.kb.id)).connectors, 1)
  })

  await check('tálca: CAS-foglalás, lejárt foglalás = pending, köteg-összesítő', async () => {
    const kb = await prisma.connector.create({
      data: {
        tenantId: tenant.id,
        type: 'knowledge_base',
        name: `kb:inbox-${randomUUID()}`,
        authMode: 'agent_owned',
        scope: 'single',
      },
    })
    const other = await prisma.agent.create({
      data: { tenantId: tenant.id, name: 'Másik', roleInstruction: 'x' },
    })
    const batchId = randomUUID()
    const docs = []
    for (let i = 0; i < 3; i++) {
      const doc = await prisma.document.create({
        data: {
          tenantId: tenant.id,
          filename: `l${i}.pdf`,
          connectorId: kb.id,
          uploadedById: owner.id,
          status: 'processed',
          contentHash: `hash-${i}`,
        },
      })
      await wikis.submitToInbox({ documentId: doc.id, status: 'pending', batchId, batchSeq: 3 - i })
      docs.push(doc)
    }
    const now = new Date()
    const listed = await wikis.listInbox([kb.id], { now })
    assert.deepEqual(
      listed.map((item) => item.batchSeq),
      [1, 2, 3],
    )

    assert.equal(
      await wikis.claimInboxItem({
        documentId: docs[0].id,
        connectorId: kb.id,
        agentId: agent.id,
        now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
      true,
    )
    assert.equal(
      await wikis.claimInboxItem({
        documentId: docs[0].id,
        connectorId: kb.id,
        agentId: other.id,
        now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
      false,
      'élő foglalást másik agent nem vehet el',
    )
    // Saját foglalás megújítható.
    assert.equal(
      await wikis.claimInboxItem({
        documentId: docs[0].id,
        connectorId: kb.id,
        agentId: agent.id,
        now,
        expiresAt: new Date(now.getTime() + 120_000),
      }),
      true,
    )

    const later = new Date(now.getTime() + 10 * 60_000)
    const relisted = await wikis.listInbox([kb.id], { now: later })
    assert.equal(
      relisted.find((item) => item.documentId === docs[0].id)?.status,
      'pending',
      'lejárt foglalás pending',
    )
    assert.equal(
      await wikis.claimInboxItem({
        documentId: docs[0].id,
        connectorId: kb.id,
        agentId: other.id,
        now: later,
        expiresAt: new Date(later.getTime() + 60_000),
      }),
      true,
      'lejárt foglalás átvehető',
    )

    const changeSet = await wikis.createChangeSet({
      wikiId: (await wikis.ensureForConnector({ connectorId: kb.id, schemaMd: '#' })).id,
      connectorId: kb.id,
      pages: [],
      approverScope: { kind: 'tenant_admin', approverUserId: null },
    })
    assert.equal(await wikis.markInboxProcessed({ documentId: docs[1].id, changeSetId: changeSet.id }), true)
    assert.equal(await wikis.skipInboxItem({ documentId: docs[2].id, connectorId: kb.id }), true)

    const summary = await wikis.inboxSummary([kb.id], { now: later })
    assert.deepEqual(summary.wikis, [
      { connectorId: kb.id, pending: 0, inProgress: 1, processed: 1, skipped: 1 },
    ])
    assert.deepEqual(summary.batches, [
      { connectorId: kb.id, batchId, pending: 0, inProgress: 1, processed: 1, skipped: 1 },
    ])

    assert.equal(
      await wikis.releaseClaimsForAgent({ agentId: other.id }),
      1,
      'D16: az agent foglalásai visszakerülnek',
    )
    assert.equal((await wikis.listInbox([kb.id], { now: later }))[0].status, 'pending')
    assert.deepEqual(await wikis.findDocumentByContentHash(kb.id, 'hash-1'), { id: docs[1].id })
  })

  await check('wiki-oldal optimista zár: elavult verzió → null, nincs csendes felülírás', async () => {
    const kb = await prisma.connector.create({
      data: {
        tenantId: tenant.id,
        type: 'knowledge_base',
        name: `kb:lock-${randomUUID()}`,
        authMode: 'agent_owned',
        scope: 'single',
      },
    })
    const wiki = await wikis.ensureForConnector({ connectorId: kb.id, schemaMd: '#' })
    const page = await wikis.createPage({
      wikiId: wiki.id,
      connectorId: kb.id,
      path: 'a.md',
      type: 'entity',
      title: 'A',
      summary: 's',
      body: 'v1',
      contentHash: '1',
    })
    assert.ok(await wikis.updatePage(page.id, 1, { body: 'v2', contentHash: '2' }))
    assert.equal(await wikis.updatePage(page.id, 1, { body: 'v2b', contentHash: '3' }), null)
    assert.equal((await wikis.findPage(kb.id, 'a.md'))?.body, 'v2')
    assert.equal((await wikis.listRevisions(page.id)).length, 2)
  })

  // Takarítás: a teszt-tenant nyomai (audit-lánc hash-integritása miatt az audit marad).
  await prisma.document.deleteMany({ where: { tenantId: tenant.id } })
  await prisma.connector.deleteMany({ where: { tenantId: tenant.id } })
  await prisma.agent.deleteMany({ where: { tenantId: tenant.id } })

  await prisma.$disconnect()
  if (failures > 0) {
    console.log(`\n❌ ${failures} teszt bukott`)
    process.exit(1)
  }
  console.log('\n✅ minden teszt zöld')
}

void main().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
