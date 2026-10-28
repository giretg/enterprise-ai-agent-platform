/**
 * #978 Wiki-előzmények valódi Postgresen (a spec 10 elfogadási kritériuma):
 * - visszavonás bájtra az előző revízióra, `reverted` állapot, redo (AC2);
 * - ütköző visszavonás: semmi nem íródik, az ütköző oldal megnevezve (AC3);
 * - agent-visszaállítás közvetlen módban is jóváhagyásra vár (AC4);
 * - `kb_wiki_changes` kétszer: a második üres, a briefing `unseen` 0 (AC5);
 * - `asOf`: korábbi tartalom, áthelyezett oldal a régi útvonalán (AC6);
 * - párhuzamos alkalmazás: nincs azonos sorszám (AC7);
 * - takarító: aktuális + legutóbbi 5 + címkézett megmarad, change-set kiürül (AC8);
 * - GDPR-kitakarás: a név sehol nem marad, az auditban sincs (AC9);
 * - privát wiki: az admin semmit nem lát és nem törölhet (AC10).
 * Futtatás: DATABASE_URL=… npm run test:wiki-history-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { repositories } from '../src/repositories/postgres'
import { PostgresWikiRepository } from '../src/repositories/postgres/wiki-repository'
import { PostgresWikiHistoryRepository } from '../src/repositories/postgres/wiki-history-repository'
import { PostgresWikiConsoleRepository } from '../src/repositories/postgres/wiki-console-repository'
import { WikiService, type WikiCaller, type WikiPageInput } from '../src/domain/knowledge-base/wiki-service'
import { WikiConsoleError, WikiConsoleService, type WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import { WikiHistoryService } from '../src/domain/knowledge-base/wiki-history-service'
import type { AuditAppendInput } from '../src/lib/audit/types'

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
const history = new PostgresWikiHistoryRepository()
const audit: AuditAppendInput[] = []
const auditSink = {
  async append(entry: AuditAppendInput) {
    audit.push(entry)
    return entry as never
  },
}

const wiki = new WikiService({
  wikis,
  documents: repositories.documents,
  connectors: repositories.connectors,
  agents: repositories.agents,
  knowledgeBase: { ingest: async () => { throw new Error('unused') }, getDocument: async () => { throw new Error('unused') } } as never,
  audit: auditSink,
  history,
})
const wikiConsole = new WikiConsoleService({
  documents: repositories.documents,
  connectors: repositories.connectors,
  agents: repositories.agents,
  wikis,
  console: new PostgresWikiConsoleRepository(),
  wiki,
  wikiAccess: {} as never,
  knowledgeBase: {} as never,
  audit: auditSink,
  history,
})
const wikiHistory = new WikiHistoryService({
  history,
  wikis,
  connectors: repositories.connectors,
  console: new PostgresWikiConsoleRepository(),
  wikiConsole,
  wiki,
  audit: auditSink,
})

function entity(path: string, body: string, docId: string, extra: Partial<WikiPageInput> = {}): WikiPageInput {
  return {
    path,
    action: 'upsert',
    type: 'entity',
    title: path.replace(/^.*\/|\.md$/g, ''),
    summary: `Összefoglaló: ${path}`,
    frontmatter: { sources: [{ documentId: docId }] },
    body,
    ...extra,
  }
}

async function main() {
  console.log('=== #978 wiki-előzmények (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({ data: { slug: `wiki978-${randomUUID().slice(0, 8)}`, displayName: 'Előzmény teszt' } })
  const admin = await prisma.user.create({ data: { externalAuthId: `t_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Admin' } })
  const owner = await prisma.user.create({ data: { externalAuthId: `t_${randomUUID()}`, email: `${randomUUID()}@example.test`, name: 'Tulaj' } })
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Anna', roleInstruction: 'x' } })
  const shared: Connector = await prisma.connector.create({
    data: { tenantId: tenant.id, type: 'knowledge_base', name: `kb:shared:${randomUUID()}`, authMode: 'agent_owned', scope: 'single', config: { displayName: 'Közös tudástár' } },
  })
  const priv: Connector = await prisma.connector.create({
    data: {
      tenantId: tenant.id, type: 'knowledge_base', name: `kb:private:${randomUUID()}`, authMode: 'agent_owned', scope: 'single',
      visibility: 'private_to_user', ownerUserId: owner.id, config: { displayName: 'Leleteim' },
    },
  })
  const doc = await prisma.document.create({
    data: { tenantId: tenant.id, filename: 'forras.md', extractedText: 'Kovács Béla vérnyomása 120/80.', connectorId: shared.id, uploadedById: admin.id, status: 'processed' },
  })
  await prisma.documentSourceFile.create({ data: { documentId: doc.id, data: Buffer.from('Kovács Béla eredeti') } })
  const privDoc = await prisma.document.create({
    data: { tenantId: tenant.id, filename: 'lelet.md', extractedText: 'x', connectorId: priv.id, uploadedById: owner.id, status: 'processed' },
  })

  const caller: WikiCaller = {
    tenantId: tenant.id,
    userId: admin.id,
    agentId: agent.id,
    snapshot: {
      connectors: [
        { connectorId: shared.id, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct' },
        { connectorId: priv.id, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct', visibility: 'private_to_user', ownerUserId: owner.id },
      ],
    },
  }
  const ownerCaller: WikiCaller = { ...caller, userId: owner.id }
  const adminActor: WikiConsoleActor = { userId: admin.id, tenantId: tenant.id, role: 'admin' }
  const ownerActor: WikiConsoleActor = { userId: owner.id, tenantId: tenant.id, role: 'operator' }
  const wikiId = (await wiki.wikiIdForConnector(tenant.id, shared.id))!

  const write = async (pages: WikiPageInput[], title: string, who: WikiCaller = caller, target = wikiId) => {
    const result = await wiki.write(who, { wikiId: target, pages, logEntry: { op: 'note', title }, sourceDocumentIds: [] })
    assert.equal(result.ok, true, JSON.stringify(result))
    return result as Extract<typeof result, { ok: true }>
  }
  const page = async (path: string) => (await wikis.findPage(shared.id, path))!

  // -------------------------------------------------------------------------
  let afterFirst: Array<{ path: string; body: string; title: string; summary: string; contentHash: string }> = []
  let secondSeq = 0
  await check('AC2: 3 oldalas change-set visszavonása bájtra az előző revízióra; reverted; redo', async () => {
    await write(['a', 'b', 'c'].map((n) => entity(`entities/${n}.md`, `# ${n}\n\nEredeti ${n}.`, doc.id)), 'Első')
    afterFirst = await Promise.all(['a', 'b', 'c'].map(async (n) => {
      const row = await page(`entities/${n}.md`)
      return { path: row.path, body: row.body, title: row.title, summary: row.summary, contentHash: row.contentHash }
    }))
    const second = await write(
      await Promise.all(['a', 'b', 'c'].map(async (n) =>
        entity(`entities/${n}.md`, `# ${n}\n\nMódosított ${n}.\n\nÚj sor.`, doc.id, { baseVersion: (await page(`entities/${n}.md`)).contentHash, title: `${n} v2` }),
      )),
      'Második',
    )
    secondSeq = Number(second.result.seq)
    assert.ok(secondSeq >= 2)
    const summary = (await history.findChangeSetBySeq(wikiId, secondSeq))!.pageSummary as Array<{ linesAdded: number; linesRemoved: number; action: string }>
    assert.equal(summary.length, 3)
    assert.ok(summary.every((row) => row.action === 'updated' && row.linesAdded >= 2 && row.linesRemoved >= 1), JSON.stringify(summary))

    const reverted = await wikiHistory.revert(adminActor, shared.id, { kind: 'changeset', seq: secondSeq })
    assert.equal(reverted.ok, true, JSON.stringify(reverted))
    for (const before of afterFirst) {
      const now = await page(before.path)
      assert.deepEqual(
        { path: now.path, body: now.body, title: now.title, summary: now.summary, contentHash: now.contentHash },
        before,
      )
    }
    const target = (await history.findChangeSetBySeq(wikiId, secondSeq))!
    assert.equal(target.status, 'reverted')
    const revertSeq = reverted.ok ? reverted.seq : 0
    const revertRow = (await history.findChangeSetBySeq(wikiId, revertSeq))!
    assert.equal(target.revertedById, revertRow.id)
    assert.equal(revertRow.revertsId, target.id)
    assert.equal((revertRow.logEntry as { op: string }).op, 'revert')
    assert.ok(audit.some((entry) => entry.action === 'kb.wiki.changeset.reverted' && entry.targetId === target.id))

    // Redo: a visszavonás visszavonása az eredeti (második) állapotot adja vissza.
    const redo = await wikiHistory.revert(adminActor, shared.id, { kind: 'changeset', seq: revertSeq })
    assert.equal(redo.ok, true, JSON.stringify(redo))
    assert.equal((await page('entities/a.md')).title, 'a v2')
    assert.equal((await history.findChangeSetBySeq(wikiId, revertSeq))!.status, 'reverted')
  })

  await check('AC3: ütköző visszavonás — semmi nem íródik, az ütköző oldal megnevezve', async () => {
    const a = await page('entities/a.md')
    const b = await page('entities/b.md')
    const both = await write([
      entity('entities/a.md', 'A harmadik.', doc.id, { baseVersion: a.contentHash }),
      entity('entities/b.md', 'B harmadik.', doc.id, { baseVersion: b.contentHash }),
    ], 'Kettő együtt')
    await write([entity('entities/a.md', 'A később.', doc.id, { baseVersion: (await page('entities/a.md')).contentHash })], 'Csak A')
    const latestBefore = await history.latestSeq(wikiId)
    const bBefore = await page('entities/b.md')
    const preview = await wikiHistory.previewRevert(adminActor, shared.id, { kind: 'changeset', seq: Number(both.result.seq) })
    assert.deepEqual(preview.conflicts.map((row) => row.path), ['entities/a.md'])
    const result = await wikiHistory.revert(adminActor, shared.id, { kind: 'changeset', seq: Number(both.result.seq) })
    assert.equal(result.ok, false)
    assert.deepEqual(result.ok ? [] : result.conflicts.map((row) => row.path), ['entities/a.md'])
    assert.equal(await history.latestSeq(wikiId), latestBefore)
    assert.equal((await page('entities/b.md')).contentHash, bBefore.contentHash)
    // Oldalanként mindig visszaállítható.
    const single = await wikiHistory.revert(adminActor, shared.id, { kind: 'page', path: 'entities/b.md', version: bBefore.version - 1 })
    assert.equal(single.ok, true, JSON.stringify(single))
    assert.ok(audit.some((entry) => entry.action === 'kb.wiki.page.restored'))
  })

  await check('AC4: agent kb_wiki_revert közvetlen írási módban is jóváhagyásra vár; jóváhagyáskor reverted', async () => {
    const c = await page('entities/c.md')
    const changed = await write([entity('entities/c.md', 'C hibás.', doc.id, { baseVersion: c.contentHash })], 'Hibás')
    const seq = Number(changed.result.seq)
    const outcome = await wiki.requestRevert(caller, { wikiId, target: { kind: 'changeset', seq }, note: 'hibás adat' })
    assert.equal(outcome.ok, 'approval', JSON.stringify(outcome))
    if (outcome.ok !== 'approval') return
    const pending = (await wikis.findChangeSet(outcome.request.changeSetId))!
    assert.equal(pending.status, 'pending')
    assert.equal(pending.revertsId, (await history.findChangeSetBySeq(wikiId, seq))!.id)
    assert.equal((await page('entities/c.md')).body, 'C hibás.')
    assert.ok(audit.some((entry) => entry.action === 'kb.wiki.changeset.revert_requested'))
    const applied = await wiki.applyApproved(caller, pending.id)
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal((await page('entities/c.md')).contentHash, c.contentHash)
    assert.equal((await history.findChangeSetBySeq(wikiId, seq))!.status, 'reverted')
  })

  await check('AC5: kb_wiki_changes kétszer — a második üres, a briefing unseen 0', async () => {
    const first = await wiki.changes(caller, { wikiId })
    assert.equal(first.ok, true)
    const rows = (first as { result: { changes: Array<{ pages: Array<{ linesAdded: number }>; author: { kind: string; name: string | null } }> } }).result.changes
    assert.ok(rows.length > 0)
    assert.ok(rows.every((row) => Array.isArray(row.pages)))
    assert.ok(!JSON.stringify(first).includes('Eredeti a.'), 'D4: diff / szöveg nélkül')
    const second = await wiki.changes(caller, { wikiId })
    assert.deepEqual((second as { result: { changes: unknown[] } }).result.changes, [])
    const briefing = await wiki.listWikis(caller)
    assert.equal(briefing.find((row) => row.wikiId === wikiId)!.changes, undefined)
    await write([entity('entities/d.md', 'Új D.', doc.id)], 'Újabb')
    const later = await wiki.listWikis(caller)
    assert.deepEqual(later.find((row) => row.wikiId === wikiId)!.changes?.unseen, 1)
  })

  await check('AC6: kb_get_page asOf — akkori tartalom; áthelyezett oldal a régi útvonalán', async () => {
    const seqBefore = await history.latestSeq(wikiId)
    const old = await page('entities/d.md')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await write([{ path: 'entities/d.md', action: 'move', newPath: 'entities/d-uj.md' }], 'Áthelyezés')
    await write([entity('entities/d-uj.md', 'D frissítve.', doc.id, { baseVersion: (await page('entities/d-uj.md')).contentHash })], 'D frissítés')
    const bySeq = await wiki.readPage({ tenantId: tenant.id, connectorId: shared.id, path: 'entities/d.md', explicitWiki: true, asOf: String(seqBefore) })
    assert.equal(bySeq?.found, true, JSON.stringify(bySeq))
    assert.match(String(bySeq?.text), /Új D\./)
    const at = (await history.appliedAtForSeq(wikiId, seqBefore))!.toISOString()
    const byDate = await wiki.readPage({ tenantId: tenant.id, connectorId: shared.id, path: 'entities/d.md', explicitWiki: true, asOf: at })
    assert.equal(byDate?.found, true)
    assert.equal(byDate?.version, old.version)
    const nowMissing = await wiki.readPage({ tenantId: tenant.id, connectorId: shared.id, path: 'entities/d.md', explicitWiki: true })
    assert.equal(nowMissing?.found, false)
    const index = await wiki.readPage({ tenantId: tenant.id, connectorId: shared.id, path: 'index.md', explicitWiki: true, asOf: seqBefore })
    assert.match(String(index?.text), /entities\/d\]\]/)
    const state = await wikiHistory.getPageAt(adminActor, shared.id, 'entities/d.md', String(seqBefore))
    assert.equal(state.body, 'Új D.')
  })

  await check('AC7: párhuzamos alkalmazás — soha nem azonos sorszám', async () => {
    const before = await history.latestSeq(wikiId)
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        wikis.applyChangeSet({
          changeSet: { create: { wikiId, connectorId: shared.id, agentId: agent.id, pages: [], approverScope: {} } },
          wikiId,
          connectorId: shared.id,
          ops: [{ kind: 'create', page: { path: `par/p${i}.md`, type: 'entity', title: `p${i}`, summary: 's', body: 'x', contentHash: `par${i}` }, createdByAgentId: agent.id, chunks: [] }],
          log: { op: 'note', title: `p${i}`, pagePaths: [`par/p${i}.md`] },
          appliedAt: new Date(),
        }),
      ),
    )
    const seqs = results.map((row) => (row.ok ? row.seq : -1)).sort((a, b) => a - b)
    assert.deepEqual(seqs, Array.from({ length: 6 }, (_, i) => before + 1 + i))
  })

  await check('AC8: takarító — aktuális + legutóbbi 5 + címkézett marad; régi ritkul / törlődik; pages kiürül', async () => {
    // 14 verzió, régi időpontokkal: 4 törlési korhatáron túl, 10 a ritkítási sávban (napi 2).
    let current = await page('entities/a.md')
    for (let i = 0; i < 13; i++) {
      await write([entity('entities/a.md', `Verzió ${i}`, doc.id, { baseVersion: current.contentHash })], `ver ${i}`)
      current = await page('entities/a.md')
    }
    const revs = await prisma.wikiPageRevision.findMany({ where: { pageId: current.id }, orderBy: { version: 'asc' } })
    const day = 86_400_000
    const now = Date.now()
    for (const [i, rev] of revs.entries()) {
      const age = i < 4 ? 400 * day + i * 60_000 : 200 * day - Math.floor((i - 4) / 2) * day + (i % 2) * 60_000
      await prisma.wikiPageRevision.update({ where: { id: rev.id }, data: { createdAt: new Date(now - age) } })
      if (rev.changeSetId) {
        await prisma.wikiChangeSet.update({ where: { id: rev.changeSetId }, data: { appliedAt: new Date(now - age) } })
      }
    }
    // A 2. verzió (törlési sávban) címkével védett.
    const taggedRev = revs[1]
    const taggedSeq = (await prisma.wikiChangeSet.findUniqueOrThrow({ where: { id: taggedRev.changeSetId! } })).seq!
    const tag = await wikiHistory.createTag(adminActor, shared.id, { seq: taggedSeq, name: 'Audit előtt' })
    assert.equal(tag.seq, taggedSeq)
    const latest5 = revs.slice(-5).map((rev) => rev.version)
    const counts = await history.sweepRetention({
      wikiId,
      fullBefore: new Date(now - 90 * day),
      deleteBefore: new Date(now - 365 * day),
      keepLatest: 5,
      limit: 1000,
      now: new Date(now),
    })
    assert.ok(counts.deleted >= 3, JSON.stringify(counts))
    assert.ok(counts.thinned >= 1, JSON.stringify(counts))
    const kept = (await prisma.wikiPageRevision.findMany({ where: { pageId: current.id } })).map((rev) => rev.version)
    for (const version of [...latest5, current.version, taggedRev.version]) assert.ok(kept.includes(version), `v${version} kept`)
    assert.ok(!kept.includes(revs[0].version), 'a címke nélküli legrégebbi törlődött')
    const pruned = await prisma.wikiChangeSet.findUniqueOrThrow({ where: { id: revs[5].changeSetId! } })
    assert.ok(pruned.pagesPrunedAt)
    assert.ok(!JSON.stringify(pruned.pages).includes('Verzió'), 'a régi change-set tartalma kiürült')
    assert.ok(Array.isArray(pruned.pageSummary) && (pruned.pageSummary as unknown[]).length === 1, 'az összefoglaló megmarad')
  })

  await check('AC9: GDPR-kitakarás — a név sehol nem marad, az auditban sincs', async () => {
    const NAME = 'Kovács Béla'
    const e = await write([entity('entities/e.md', `Páciens: ${NAME}.`, doc.id, { title: 'E oldal' })], `${NAME} felvétele`)
    await write([entity('entities/e.md', 'Páciens: anonim.', doc.id, { baseVersion: (await page('entities/e.md')).contentHash })], 'Anonimizálás')
    // Jóváhagyásra váró change-set + gateway-kártya a névvel.
    const pending = await wikis.createChangeSet({
      wikiId, connectorId: shared.id, agentId: agent.id, pages: [entity('entities/f.md', `${NAME} újra`, doc.id)] as never, approverScope: {},
    })
    const definition = await prisma.agentDefinitionVersion.create({
      data: { agentId: agent.id, version: 1, snapshot: {}, contentHash: 'h', publishedById: admin.id },
    })
    const op = await prisma.gatewayOperation.create({
      data: {
        tenantId: tenant.id, agentDefinitionVersionId: definition.id, principalUserId: admin.id, toolName: 'kb_wiki_write',
        argsJson: { changeSetId: pending.id, pages: [{ path: 'entities/f.md', action: 'upsert', note: NAME }] },
        idempotencyKey: `k-${randomUUID()}`, status: 'awaiting_approval', connectorId: shared.id,
      },
    })
    assert.ok(e.result.seq)
    const preview = await wikiHistory.previewErasure(adminActor, shared.id, { kind: 'text', phrase: NAME, mode: 'redact' })
    assert.ok(preview.counts.revision >= 1 && preview.counts.changeSet >= 2 && preview.counts.log >= 1 && preview.counts.document === 1, JSON.stringify(preview.counts))
    assert.ok(preview.counts.gatewayOperation === 1 && preview.counts.chunk >= 0)
    await assert.rejects(
      wikiHistory.executeErasure(adminActor, shared.id, { scope: { kind: 'text', phrase: NAME, mode: 'redact' }, reason: 'GDPR 2026/1', confirmName: 'rossz név' }),
      (error: unknown) => error instanceof WikiConsoleError && error.code === 'invalid_args',
    )
    const auditBefore = audit.length
    const done = await wikiHistory.executeErasure(adminActor, shared.id, {
      scope: { kind: 'text', phrase: NAME, mode: 'redact' }, reason: 'GDPR 2026/1', confirmName: 'Közös tudástár',
    })
    assert.equal(done.ok, true, JSON.stringify(done))
    const lower = NAME.toLowerCase()
    const leaks = await prisma.$queryRaw<Array<{ where: string; n: bigint }>>`
      SELECT 'page' AS where, count(*) AS n FROM wiki_pages WHERE connector_id = ${shared.id}::uuid AND position(${lower} in lower(title || summary || body || frontmatter::text)) > 0
      UNION ALL SELECT 'revision', count(*) FROM wiki_page_revisions r JOIN wiki_pages p ON p.id = r.page_id WHERE p.connector_id = ${shared.id}::uuid AND position(${lower} in lower(r.title || r.summary || r.body)) > 0
      UNION ALL SELECT 'changeSet', count(*) FROM wiki_change_sets WHERE connector_id = ${shared.id}::uuid AND position(${lower} in lower(pages::text || COALESCE(log_entry::text, '') || COALESCE(page_summary::text, ''))) > 0
      UNION ALL SELECT 'log', count(*) FROM wiki_log_entries WHERE wiki_id = ${wikiId}::uuid AND position(${lower} in lower(title || COALESCE(note, ''))) > 0
      UNION ALL SELECT 'chunk', count(*) FROM knowledge_chunks WHERE connector_id = ${shared.id}::uuid AND position(${lower} in lower(text)) > 0
      UNION ALL SELECT 'document', count(*) FROM documents WHERE connector_id = ${shared.id}::uuid AND position(${lower} in lower(COALESCE(extracted_text, '') || filename)) > 0
      UNION ALL SELECT 'gateway', count(*) FROM gateway_operations WHERE id = ${op.id}::uuid AND position(${lower} in lower(args_json::text)) > 0
    `
    for (const row of leaks) assert.equal(Number(row.n), 0, `${row.where} still contains the name`)
    assert.equal(await prisma.documentSourceFile.count({ where: { documentId: doc.id } }), 0, 'az eredeti fájl törlődött')
    const erasure = await prisma.wikiErasure.findFirstOrThrow({ where: { wikiId } })
    assert.ok(!JSON.stringify(erasure).toLowerCase().includes(lower))
    const newAudit = audit.slice(auditBefore)
    assert.ok(newAudit.some((entry) => entry.action === 'kb.wiki.erasure.executed'))
    assert.ok(!JSON.stringify(newAudit).toLowerCase().includes(lower), 'az audit nem tartalmazza a nevet')
    // A kitakarás után az oldal még mindig olvasható, csak a név helyén [törölve].
    assert.match((await page('entities/e.md')).body, /anonim/)
  })

  await check('GDPR: revízió-metaadat kitakarása és későbbi megőrzési takarítás', async () => {
    const marker = 'SensitiveMarker'
    await write([entity('entities/metadata.md', marker, doc.id, {
      category: marker, frontmatter: { sources: [{ documentId: doc.id, filename: marker }] },
    })], 'Metadata')
    const before = await page('entities/metadata.md')
    const originalRev = await history.findRevision(shared.id, before.id, before.version)
    const done = await wikiHistory.executeErasure(adminActor, shared.id, {
      scope: { kind: 'text', phrase: marker, mode: 'redact' }, reason: 'GDPR metadata', confirmName: 'Közös tudástár',
    })
    assert.equal(done.ok, true)
    const revisions = await prisma.wikiPageRevision.findMany({ where: { pageId: before.id } })
    assert.ok(!JSON.stringify(revisions).includes(marker), 'a revízió metaadata személyes adatot tartalmaz')
    const cs = await wikis.findChangeSet(originalRev!.changeSetId!)
    assert.equal(cs!.pagesPrunedAt, null, 'a kitakarás nem jelölheti kiürítettnek a teljes szöveget')
    await prisma.wikiChangeSet.update({ where: { id: cs!.id }, data: { appliedAt: new Date(Date.now() - 100 * 86_400_000) } })
    await history.sweepRetention({ wikiId, fullBefore: new Date(Date.now() - 90 * 86_400_000), deleteBefore: null, keepLatest: 5, limit: 1000, now: new Date() })
    const pruned = await wikis.findChangeSet(cs!.id)
    assert.ok(pruned!.pagesPrunedAt)
    assert.ok(!JSON.stringify(pruned!.pages).includes('body'))
  })

  await check('GDPR: csak kategóriában / forrásban szereplő kifejezést is megtalál', async () => {
    const marker = 'SourceOnlyMarker'
    await write([entity('entities/source-only.md', 'Anonim', doc.id, {
      frontmatter: { sources: [{ documentId: doc.id, filename: marker }] },
    })], 'Forrás metaadat')
    const preview = await wikiHistory.previewErasure(adminActor, shared.id, { kind: 'text', phrase: marker, mode: 'redact' })
    assert.equal(preview.counts.page, 1)
    assert.equal(preview.counts.revision, 1)
  })

  await check('D8: függő visszaállítás nem írhat felül későbbi archiválást', async () => {
    const path = 'entities/pending-revert.md'
    await write([entity(path, 'Első', doc.id)], 'Első')
    await write([entity(path, 'Második', doc.id, { baseVersion: (await page(path)).contentHash })], 'Második')
    const revert = await wiki.requestRevert(caller, { wikiId, target: { kind: 'page', path, version: 1 } })
    assert.equal(revert.ok, 'approval')
    if (revert.ok !== 'approval') throw new Error(JSON.stringify(revert))
    await write([{ path, action: 'archive', baseVersion: (await page(path)).contentHash }], 'Archiválás')
    const applied = await wiki.applyApproved(caller, revert.request.changeSetId)
    assert.equal(applied.ok, false, 'a függő visszaállítás ütközzön az archiválással')
    assert.equal((await page(path)).status, 'archived')
  })

  await check('GDPR oldal: függő másolat, gateway, napló és nyers forrás is törlődik', async () => {
    const marker = 'PrivatePagePayload'
    const raw = await prisma.document.create({ data: { tenantId: tenant.id, connectorId: shared.id, uploadedById: admin.id, filename: 'private.md', extractedText: marker, status: 'processed' } })
    await prisma.documentSourceFile.create({ data: { documentId: raw.id, data: Buffer.from(marker) } })
    const path = 'entities/pending-erasure.md'
    await write([entity(path, marker, raw.id)], marker)
    const pending = await wikis.createChangeSet({
      wikiId, connectorId: shared.id, agentId: agent.id, pages: [entity(path, marker, raw.id)] as never,
      logEntry: { op: 'note', title: marker, note: marker }, validation: { note: marker }, approverScope: {},
    })
    const definition = await prisma.agentDefinitionVersion.findFirstOrThrow({ where: { agentId: agent.id } })
    const gateway = await prisma.gatewayOperation.create({ data: {
      tenantId: tenant.id, agentDefinitionVersionId: definition.id, principalUserId: admin.id, toolName: 'kb_wiki_write',
      argsJson: { changeSetId: pending.id, pages: [{ path, body: marker }] },
      idempotencyKey: `k-${randomUUID()}`, status: 'awaiting_approval', connectorId: shared.id,
    } })
    const preview = await wikiHistory.previewErasure(adminActor, shared.id, { kind: 'pages', paths: [path] })
    assert.equal(preview.counts.document, 1)
    assert.equal(preview.counts.sourceFile, 1)
    const done = await wikiHistory.executeErasure(adminActor, shared.id, {
      scope: { kind: 'pages', paths: [path] }, reason: 'GDPR oldal', confirmName: 'Közös tudástár',
    })
    assert.equal(done.ok, true)
    const after = await wikis.findChangeSet(pending.id)
    assert.equal(after!.status, 'rejected')
    assert.ok(!JSON.stringify(after).includes(marker))
    const op = await prisma.gatewayOperation.findUniqueOrThrow({ where: { id: gateway.id } })
    assert.ok(!JSON.stringify(op.argsJson).includes(marker))
    assert.equal(op.status, 'rejected')
    assert.equal(await prisma.document.count({ where: { id: raw.id } }), 0)
    assert.equal(await prisma.documentSourceFile.count({ where: { documentId: raw.id } }), 0)
    const allCs = await prisma.wikiChangeSet.findMany({ where: { wikiId } })
    assert.ok(!JSON.stringify(allCs).includes(marker), 'egy change-set másolata megmaradt')
    const logs = await prisma.wikiLogEntry.findMany({ where: { wikiId } })
    assert.ok(!JSON.stringify(logs).includes(marker), 'a naplóban tartalom maradt')
  })

  await check('GDPR szöveg-erase: függő visszaállítás ne írja vissza a sír-jeles verzió többi személyes adatát', async () => {
    const phrase = 'EraseNameX'
    const otherSecret = 'SSN-998877'
    const path = 'entities/text-erase-pending.md'
    await write([entity(path, `Páciens: ${phrase}. Titok: ${otherSecret}.`, doc.id)], 'v1 erase-pending')
    const v1 = await page(path)
    await write([entity(path, 'Ártalmatlan későbbi szöveg.', doc.id, { baseVersion: v1.contentHash })], 'v2 erase-pending')
    const liveBefore = await page(path)
    const revert = await wiki.requestRevert(caller, { wikiId, target: { kind: 'page', path, version: v1.version } })
    assert.equal(revert.ok, 'approval', JSON.stringify(revert))
    if (revert.ok !== 'approval') throw new Error('expected approval')
    const pendingId = revert.request.changeSetId
    assert.ok(JSON.stringify((await wikis.findChangeSet(pendingId))!.pages).includes(otherSecret))
    const definition = await prisma.agentDefinitionVersion.findFirstOrThrow({ where: { agentId: agent.id } })
    const gateway = await prisma.gatewayOperation.create({
      data: {
        tenantId: tenant.id,
        agentDefinitionVersionId: definition.id,
        principalUserId: admin.id,
        toolName: 'kb_wiki_revert',
        argsJson: { changeSetId: pendingId, path, version: v1.version, note: phrase },
        idempotencyKey: `k-${randomUUID()}`,
        status: 'awaiting_approval',
        connectorId: shared.id,
      },
    })
    const done = await wikiHistory.executeErasure(adminActor, shared.id, {
      scope: { kind: 'text', phrase, mode: 'erase' },
      reason: 'GDPR szöveg erase',
      confirmName: 'Közös tudástár',
    })
    assert.equal(done.ok, true, JSON.stringify(done))
    const after = await wikis.findChangeSet(pendingId)
    assert.equal(after!.status, 'rejected')
    assert.ok(!JSON.stringify(after).includes(otherSecret), 'a függő restore pages megőrizte a sír-jeles tartalmat')
    assert.ok(!JSON.stringify(after).includes(phrase))
    const op = await prisma.gatewayOperation.findUniqueOrThrow({ where: { id: gateway.id } })
    assert.equal(op.status, 'rejected')
    assert.ok(!JSON.stringify(op.argsJson).includes(phrase))
    const tombstone = await history.findRevision(shared.id, liveBefore.id, v1.version)
    assert.ok(tombstone?.erasedAt)
    assert.equal(tombstone?.body, '')
    const applied = await wiki.applyApproved(caller, pendingId)
    assert.equal(applied.ok, false)
    assert.equal((await page(path)).body, liveBefore.body)
  })

  await check('GDPR oldal-mód: minden verzió sír-jel (contentHash marad), az oldal archivált és üres', async () => {
    const b = await page('entities/b.md')
    const hashes = (await prisma.wikiPageRevision.findMany({ where: { pageId: b.id } })).map((rev) => rev.contentHash)
    const done = await wikiHistory.executeErasure(adminActor, shared.id, {
      scope: { kind: 'pages', paths: ['entities/b.md'] }, reason: 'GDPR 2026/2', confirmName: 'Közös tudástár',
    })
    assert.equal(done.ok, true)
    const revs = await prisma.wikiPageRevision.findMany({ where: { pageId: b.id }, orderBy: { version: 'asc' } })
    const tombstones = revs.filter((rev) => rev.erasedAt)
    assert.equal(tombstones.length, hashes.length)
    assert.ok(tombstones.every((rev) => rev.body === '' && rev.title === '' && hashes.includes(rev.contentHash)))
    const after = (await prisma.wikiPage.findUniqueOrThrow({ where: { id: b.id } }))
    assert.equal(after.status, 'archived')
    assert.equal(after.body, '')
    assert.match(after.path, /^erased\//)
    const revert = await wikiHistory.revert(adminActor, shared.id, { kind: 'page', path: after.path, version: 1 })
    assert.equal(revert.ok, false)
    assert.equal(revert.ok ? '' : revert.code, 'version_erased')
  })

  await check('AC10: privát wiki — admin semmit nem lát, GDPR-törlést sem indíthat; a tulajdonos igen', async () => {
    const privWikiId = (await wiki.wikiIdForConnector(tenant.id, priv.id))!
    await write([entity('conditions/x.md', 'Titkos lelet.', privDoc.id)], 'Lelet', ownerCaller, privWikiId)
    const notFound = (error: unknown) => error instanceof WikiConsoleError && error.code === 'not_found'
    await assert.rejects(wikiHistory.getPageHistory(adminActor, priv.id, 'conditions/x.md'), notFound)
    await assert.rejects(wikiHistory.listChanges(adminActor, priv.id), notFound)
    await assert.rejects(wikiHistory.getStateAt(adminActor, priv.id, '1'), notFound)
    await assert.rejects(wikiHistory.previewErasure(adminActor, priv.id, { kind: 'text', phrase: 'Titkos', mode: 'redact' }), notFound)
    const own = await wikiHistory.getPageHistory(ownerActor, priv.id, 'conditions/x.md')
    assert.equal(own.revisions.length, 1)
    assert.equal(own.canRevert, true)
    const ownPreview = await wikiHistory.previewErasure(ownerActor, priv.id, { kind: 'text', phrase: 'Titkos', mode: 'erase' })
    assert.ok(ownPreview.total > 0)
    // A privát change-set audit-sora tartalommentes (path / cím nélkül).
    const privateAudit = audit.filter((entry) => entry.metadata && (entry.metadata as Record<string, unknown>).connectorId === priv.id)
    assert.ok(privateAudit.length > 0)
    assert.ok(!JSON.stringify(privateAudit).includes('conditions/x.md'))
  })

  await check('megőrzési beállítás: csak a felkínált értékek; a törlés nem rövidebb a teljesnél; audit', async () => {
    await assert.rejects(wikiHistory.updateRetention(adminActor, shared.id, { retentionFullDays: 365, retentionDeleteDays: 90 }))
    await assert.rejects(wikiHistory.updateRetention(adminActor, shared.id, { retentionFullDays: 45, retentionDeleteDays: null }))
    const saved = await wikiHistory.updateRetention(adminActor, shared.id, { retentionFullDays: 180, retentionDeleteDays: null })
    assert.deepEqual(saved, { retentionFullDays: 180, retentionDeleteDays: null })
    assert.ok(audit.some((entry) => entry.action === 'kb.wiki.retention.changed'))
    await assert.rejects(
      wikiHistory.updateRetention({ ...adminActor, role: 'operator' }, shared.id, { retentionFullDays: 90, retentionDeleteDays: 365 }),
      (error: unknown) => error instanceof WikiConsoleError && error.code === 'forbidden',
    )
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
