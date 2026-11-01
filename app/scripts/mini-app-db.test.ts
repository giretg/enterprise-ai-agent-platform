/**
 * #967 mini app repository valódi (migrált) Postgresen: tranzakciós létrehozás,
 * idempotencia, optimista verzió-zár, láthatósági lista, megosztás, purge.
 * Futtatás: npm run test:mini-app-db (DATABASE_URL + DIRECT_URL egy eldobható DB-re).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { PostgresMiniAppRepository, listMiniAppsForAgentPage } from '../src/repositories/postgres/mini-app-repository'

function version(html: string, key: string | null = null) {
  return { html, contentHash: `h-${html.length}-${key ?? ''}`, byteSize: html.length, lintWarnings: ['fetch_call'], changeNote: null, idempotencyKey: key, createdByUserId: '' }
}

async function main() {
  const suffix = randomUUID()
  const tenant = await prisma.tenant.create({ data: { slug: `mini-app-test-${suffix}`, displayName: 'Mini app test' } })
  const other = await prisma.tenant.create({ data: { slug: `mini-app-other-${suffix}`, displayName: 'Other' } })
  const user = await prisma.user.create({ data: { externalAuthId: suffix, email: `${suffix}@example.invalid`, name: 'Mini app test' } })
  const mk = (tenantId: string, name: string) =>
    prisma.agent.create({ data: { tenantId, name, roleInstruction: 'test', modelConfig: { provider: 'stub', model: 'stub' } } })
  const [reka, zoli, kati, foreign] = await Promise.all([mk(tenant.id, 'Réka'), mk(tenant.id, 'Zoli'), mk(tenant.id, 'Kati'), mk(other.id, 'Idegen')])
  const repo = new PostgresMiniAppRepository()
  const base = {
    tenantId: tenant.id,
    ownerAgentId: reka.id,
    projectKey: '__general__',
    description: 'leírás',
    copiedFromAppId: null,
    copiedFromVersion: null,
    createdByUserId: user.id,
  }
  try {
    const first = await repo.createWithVersion({ ...base, name: 'Havi riport', createIdempotencyKey: 'k1', version: { ...version('<p>1</p>'), createdByUserId: user.id } })
    assert.equal(first.created, true)
    assert.equal(first.app.currentVersion, 1)
    const replay = await repo.createWithVersion({ ...base, name: 'Havi riport', createIdempotencyKey: 'k1', version: { ...version('<p>1</p>'), createdByUserId: user.id } })
    assert.equal(replay.created, false)
    assert.equal(replay.app.id, first.app.id)
    assert.equal(await prisma.miniApp.count({ where: { tenantId: tenant.id } }), 1)
    console.log('  OK  create tranzakcióban + idempotencia-ütközés a meglévőt adja')

    const appId = first.app.id
    const v2 = await repo.addVersion({ appId, tenantId: tenant.id, expectedCurrentVersion: 1, version: { ...version('<p>2</p>', 'u1'), createdByUserId: user.id } })
    assert.notEqual(v2, 'conflict')
    assert.equal(v2 !== 'conflict' && v2.version, 2)
    assert.equal(await repo.addVersion({ appId, tenantId: tenant.id, expectedCurrentVersion: 1, version: { ...version('<p>x</p>', 'u2'), createdByUserId: user.id } }), 'conflict')
    assert.equal((await repo.findVersionByKey(appId, 'u1'))?.version, 2)
    assert.equal((await repo.findVersion(appId, 2))?.html, '<p>2</p>')
    const versions = await repo.listVersions(appId)
    assert.deepEqual(versions.map((v) => v.version), [2, 1])
    assert.equal('html' in versions[0]!, false, 'a verziólista nem tölti be a HTML-t')
    console.log('  OK  új verzió optimista zárral; elavult expectedCurrentVersion → conflict')

    const visible = async (agentId: string, scope: 'mine' | 'shared_with_me' | 'all' = 'all') =>
      (await repo.listVisibleToAgent({ tenantId: tenant.id, agentId, scope, includeArchived: false, limit: 20, offset: 0 })).map((a) => a.id)
    assert.deepEqual(await visible(zoli.id), [])
    assert.deepEqual(await repo.activateShares({ tenantId: tenant.id, appId, agentIds: [zoli.id], sharedByUserId: user.id }), [zoli.id])
    assert.deepEqual(await repo.activateShares({ tenantId: tenant.id, appId, agentIds: [zoli.id], sharedByUserId: user.id }), [])
    assert.deepEqual(await visible(zoli.id, 'shared_with_me'), [appId])
    assert.deepEqual(await visible(zoli.id, 'mine'), [])
    assert.equal(await repo.hasActiveShare(appId, zoli.id), true)
    assert.deepEqual(await repo.revokeShares(appId, [zoli.id, kati.id]), [zoli.id])
    assert.deepEqual(await visible(zoli.id), [])
    assert.deepEqual(await repo.activateShares({ tenantId: tenant.id, appId, agentIds: [zoli.id], sharedByUserId: user.id }), [zoli.id], 'visszavont megosztás újra aktiválható')
    await repo.setVisibility(appId, 'organization')
    assert.deepEqual(await visible(kati.id), [appId])
    assert.deepEqual(
      (await repo.listVisibleToAgent({ tenantId: other.id, agentId: foreign.id, scope: 'all', includeArchived: false, limit: 20, offset: 0 })).length,
      0,
      'szervezeti láthatóság nem lép át tenantot',
    )
    assert.deepEqual((await repo.listVisibleToAgent({ tenantId: tenant.id, agentId: kati.id, scope: 'all', query: 'HAVI', includeArchived: false, limit: 20, offset: 0 })).length, 1)
    assert.equal((await listMiniAppsForAgentPage(tenant.id, kati.id)).length, 1)
    assert.equal(await repo.findById(other.id, appId), null)
    console.log('  OK  láthatóság: megosztás, visszavonás, szervezeti, keresés, tenant-határ')

    await repo.setStatus(appId, 'archived', new Date(Date.now() - 100 * 24 * 60 * 60 * 1000))
    assert.deepEqual(await visible(kati.id), [])
    assert.deepEqual((await repo.listVisibleToAgent({ tenantId: tenant.id, agentId: reka.id, scope: 'mine', includeArchived: true, limit: 20, offset: 0 })).map((a) => a.id), [appId])
    const purged = await repo.purgeArchivedBefore(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))
    assert.deepEqual(purged.map((row) => row.id), [appId])
    assert.equal(await prisma.miniAppVersion.count({ where: { appId } }), 0)
    assert.equal(await prisma.miniAppShare.count({ where: { appId } }), 0)
    console.log('  OK  archiválás + 90 napos purge kaszkáddal')
    console.log('\nmini-app-db: ok')
  } finally {
    await prisma.miniApp.deleteMany({ where: { tenantId: { in: [tenant.id, other.id] } } })
    await prisma.agent.deleteMany({ where: { tenantId: { in: [tenant.id, other.id] } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } })
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
