/**
 * #946 LLM Wiki 5/6 — a Control Plane wiki-nézetének SQL-je valódi Postgresen:
 * tudásbázis-lista statisztikával, tálca minden állapottal (lejárt foglalás = vár),
 * agent-kötések, forrás-dokumentumok.
 * Futtatás: DATABASE_URL=… npm run test:wiki-console-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PostgresDocumentRepository } from '../src/repositories/postgres/knowledge-repository'
import { PostgresWikiConsoleRepository } from '../src/repositories/postgres/wiki-console-repository'

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

const repo = new PostgresWikiConsoleRepository()

async function main() {
  console.log('=== #946 wiki console (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({
    data: { slug: `wiki946-${randomUUID().slice(0, 8)}`, displayName: 'Wiki konzol teszt' },
  })
  const owner = await prisma.user.create({
    data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Tulaj Tamás' },
  })
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Réka', roleInstruction: 'x' } })
  const priv = await prisma.connector.create({
    data: {
      tenantId: tenant.id,
      type: 'knowledge_base',
      name: `kb:private:${randomUUID()}`,
      authMode: 'agent_owned',
      scope: 'single',
      config: { displayName: 'Leletek' },
      visibility: 'private_to_user',
      ownerUserId: owner.id,
    },
  })
  const wiki = await prisma.agentWiki.create({ data: { connectorId: priv.id, schemaMd: '# WIKI' } })
  await prisma.agentConnector.create({
    data: { agentId: agent.id, connectorId: priv.id, accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct', wikiCollectFocus: 'Leletek' },
  })
  const now = new Date()
  const batchId = randomUUID()
  const mk = (filename: string, data: Record<string, unknown>) =>
    prisma.document.create({
      data: {
        tenantId: tenant.id,
        filename,
        extractedText: 'abcd',
        connectorId: priv.id,
        uploadedById: owner.id,
        status: 'processed',
        wikiBatchId: batchId,
        ...data,
      },
    })
  await mk('vár.pdf', { wikiStatus: 'pending', wikiBatchSeq: 0 })
  await mk('lejárt.pdf', { wikiStatus: 'in_progress', wikiClaimedByAgentId: agent.id, wikiClaimExpiresAt: new Date(now.getTime() - 1000), wikiBatchSeq: 1 })
  await mk('fut.pdf', { wikiStatus: 'in_progress', wikiClaimedByAgentId: agent.id, wikiClaimExpiresAt: new Date(now.getTime() + 3_600_000), wikiBatchSeq: 2 })
  await mk('kész.pdf', { wikiStatus: 'processed', wikiBatchSeq: 3 })
  await mk('nem-tálca.pdf', {})
  await prisma.wikiPage.create({
    data: { wikiId: wiki.id, connectorId: priv.id, path: 'labs/a.md', type: 'entity', title: 'A', summary: 's', body: 'xyz', contentHash: 'h' },
  })
  await prisma.wikiPage.create({
    data: { wikiId: wiki.id, connectorId: priv.id, path: 'old.md', type: 'entity', title: 'Old', summary: 's', body: 'q', contentHash: 'h2', status: 'archived' },
  })

  try {
    await check('listKnowledgeBases: forrás- és oldalszám, méret, tulajdonos neve', async () => {
      const rows = await repo.listKnowledgeBases(tenant.id)
      assert.equal(rows.length, 1)
      const row = rows[0]
      assert.equal(row.visibility, 'private_to_user')
      assert.equal(row.ownerLabel, 'Tulaj Tamás')
      assert.equal(row.sourceCount, 5)
      assert.equal(row.pageCount, 1, 'csak a publikált oldal számít')
      assert.equal(row.bytes, 5 * 4 + 3 + 1)
      assert.equal(row.lifecycleState, 'active')
    })

    await check('listInboxItems: minden wiki-állapot, lejárt foglalás = vár, a nem-tálca dokumentum kimarad', async () => {
      const items = await repo.listInboxItems(priv.id, { now })
      const byName = new Map(items.map((item) => [item.filename, item]))
      assert.equal(items.length, 4)
      assert.equal(byName.get('vár.pdf')!.status, 'pending')
      assert.equal(byName.get('lejárt.pdf')!.status, 'pending')
      assert.equal(byName.get('lejárt.pdf')!.claimedByAgentId, null)
      assert.equal(byName.get('fut.pdf')!.status, 'in_progress')
      assert.equal(byName.get('fut.pdf')!.claimedByAgentId, agent.id)
      assert.equal(byName.get('kész.pdf')!.status, 'processed')
      assert.equal(byName.get('vár.pdf')!.uploadedByLabel, 'Tulaj Tamás')
      assert.equal(byName.get('vár.pdf')!.batchId, batchId)
      // Váró / folyamatban lévő tételek elöl.
      assert.equal(items[items.length - 1].filename, 'kész.pdf')
    })

    await check('párhuzamos azonos feltöltésből pontosan egy dokumentum készül', async () => {
      const documents = new PostgresDocumentRepository()
      const contentHash = randomUUID()
      const results = await Promise.all(Array.from({ length: 3 }, (_, i) => documents.createIfAbsent({
        tenantId: tenant.id, connectorId: priv.id, uploadedById: owner.id,
        filename: `same-${i}.txt`, contentHash, extractedText: 'same',
      })))
      assert.equal(results.filter((result) => result.created).length, 1)
      assert.equal(new Set(results.map((result) => result.document.id)).size, 1)
      assert.equal(await prisma.document.count({ where: { connectorId: priv.id, contentHash } }), 1)
      await prisma.document.delete({ where: { id: results[0].document.id } })
    })

    await check('listBindingsForConnector + agentNames + userLabels + forrás-dokumentumok', async () => {
      const bindings = await repo.listBindingsForConnector(priv.id)
      assert.deepEqual(bindings, [
        { agentId: agent.id, agentName: 'Réka', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct', wikiCollectFocus: 'Leletek' },
      ])
      assert.equal((await repo.agentNames(tenant.id, [agent.id])).get(agent.id), 'Réka')
      assert.equal((await repo.agentNames(randomUUID(), [agent.id])).size, 0, 'más tenant agentje nem oldódik fel')
      assert.equal((await repo.userLabels([owner.id])).get(owner.id), 'Tulaj Tamás')
      const docs = await repo.listSourceDocuments(priv.id)
      assert.equal(docs.length, 5)
      const one = await repo.findSourceDocument(priv.id, docs[0].id)
      assert.equal(one?.id, docs[0].id)
      assert.equal(await repo.findSourceDocument(randomUUID(), docs[0].id), null)
    })
  } finally {
    await prisma.document.deleteMany({ where: { connectorId: priv.id } })
    await prisma.wikiPage.deleteMany({ where: { connectorId: priv.id } })
    await prisma.agentConnector.deleteMany({ where: { connectorId: priv.id } })
    await prisma.agentWiki.deleteMany({ where: { connectorId: priv.id } })
    await prisma.connector.delete({ where: { id: priv.id } })
    await prisma.agent.delete({ where: { id: agent.id } })
    await prisma.user.delete({ where: { id: owner.id } })
    await prisma.tenant.delete({ where: { id: tenant.id } })
    await prisma.$disconnect()
  }

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
