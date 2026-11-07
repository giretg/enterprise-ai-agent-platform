/**
 * #1129 wiki-kommentek valódi Postgresen: az elfogadási feltételek (AC1–AC14, AC17, AC19–AC21).
 * Futtatás: DATABASE_URL=… npm run test:wiki-comments-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { PostgresWikiRepository, PostgresWikiStructureRepository } from '../src/repositories/postgres/wiki-repository'
import { PostgresWikiHistoryRepository } from '../src/repositories/postgres/wiki-history-repository'
import { PostgresWikiCommentRepository } from '../src/repositories/postgres/wiki-comment-repository'
import { PostgresWikiConsoleRepository } from '../src/repositories/postgres/wiki-console-repository'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresConnectorRepository } from '../src/repositories/postgres/connector-repository'
import { PostgresAgentRepository } from '../src/repositories/postgres/agent-repository'
import { PostgresDocumentRepository } from '../src/repositories/postgres/knowledge-repository'
import { PostgresPrivateKnowledgeBaseStore } from '../src/repositories/postgres/wiki-repository'
import { WikiService, pageChunks, type WikiCaller } from '../src/domain/knowledge-base/wiki-service'
import { WikiConsoleError, WikiConsoleService, type WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import { WikiCommentError, WikiCommentService } from '../src/domain/knowledge-base/wiki-comment-service'
import { WikiHistoryService } from '../src/domain/knowledge-base/wiki-history-service'
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a tesztek a szolgáltatás laza JSON-válaszait olvassák
type Row = Record<string, any>
function okResult(outcome: { ok: unknown; result?: unknown; code?: string }): Row {
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  return outcome.result as Row
}
function failCode(outcome: { ok: unknown; code?: string }, code: string) {
  assert.equal(outcome.ok, false, JSON.stringify(outcome))
  assert.equal(outcome.code, code, JSON.stringify(outcome))
}
async function rejectsCode(fn: () => Promise<unknown>, code: string) {
  await assert.rejects(fn, (error: unknown) => (error instanceof WikiConsoleError || error instanceof WikiCommentError) && error.code === code, code)
}

const wikis = new PostgresWikiRepository()
const comments = new PostgresWikiCommentRepository()
const audit = new PostgresAuditRepository()
const connectors = new PostgresConnectorRepository()
const consoleRepo = new PostgresWikiConsoleRepository()
const history = new PostgresWikiHistoryRepository()

async function main() {
  console.log('=== #1129 wiki-kommentek (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const mkUser = (name: string) => prisma.user.create({ data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name } })
  const tenant = await prisma.tenant.create({ data: { slug: `wiki1129-${randomUUID().slice(0, 8)}`, displayName: 'Komment teszt' } })
  const otherTenant = await prisma.tenant.create({ data: { slug: `wiki1129b-${randomUUID().slice(0, 8)}`, displayName: 'Másik cég' } })
  const adminUser = await mkUser('Admin Ádám')
  const operatorUser = await mkUser('Kovács Anna')
  const secondOperator = await mkUser('Nagy Béla')
  const outsider = await mkUser('Külső Kornél')
  for (const [user, role] of [[adminUser, 'admin'], [operatorUser, 'operator'], [secondOperator, 'operator']] as const) {
    await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role, status: 'active' } })
  }
  await prisma.tenantMembership.create({ data: { tenantId: otherTenant.id, userId: outsider.id, role: 'admin', status: 'active' } })
  // Két szervezet tagja (AC21).
  await prisma.tenantMembership.create({ data: { tenantId: otherTenant.id, userId: operatorUser.id, role: 'operator', status: 'active' } })

  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Réka', roleInstruction: 'x' } })
  const otherAgent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Másik', roleInstruction: 'x' } })

  let flagOn = true
  const commentsEnabled = async () => flagOn
  const wikiService = new WikiService({
    wikis,
    history,
    structure: new PostgresWikiStructureRepository(),
    documents: new PostgresDocumentRepository(),
    connectors,
    agents: new PostgresAgentRepository(),
    knowledgeBase: { ingest: async () => { throw new Error('not used') }, getDocument: async () => { throw new Error('not used') } } as never,
    audit,
    comments,
    commentsEnabled,
  })
  const consoleService = new WikiConsoleService({
    connectors,
    agents: new PostgresAgentRepository(),
    wikis,
    console: consoleRepo,
    wiki: wikiService,
    audit,
    comments,
    commentsEnabled,
  } as never)
  const service = new WikiCommentService({
    comments,
    wikis,
    wiki: wikiService,
    wikiConsole: consoleService,
    userLabels: (ids) => consoleRepo.userLabels(ids),
    agentNames: (tenantId, ids) => consoleRepo.agentNames(tenantId, ids),
    audit,
    commentsEnabled,
  })
  const historyService = new WikiHistoryService({
    history,
    wikis,
    connectors,
    console: consoleRepo,
    wikiConsole: consoleService,
    wiki: wikiService,
    audit,
    comments,
  })

  const admin: WikiConsoleActor = { userId: adminUser.id, tenantId: tenant.id, role: 'admin' }
  const operator: WikiConsoleActor = { userId: operatorUser.id, tenantId: tenant.id, role: 'operator' }
  const operator2: WikiConsoleActor = { userId: secondOperator.id, tenantId: tenant.id, role: 'operator' }
  const foreignAdmin: WikiConsoleActor = { userId: outsider.id, tenantId: otherTenant.id, role: 'admin' }
  const operatorAbroad: WikiConsoleActor = { userId: operatorUser.id, tenantId: otherTenant.id, role: 'operator' }

  const mkWiki = async (name: string, data: Row = {}) => {
    const connector = (await prisma.connector.create({
      data: { tenantId: tenant.id, type: 'knowledge_base', name: `kb:shared:${randomUUID()}`, authMode: 'agent_owned', scope: 'single', config: { displayName: name, wikiTemplate: 'general' }, ...data },
    })) as Connector
    const wiki = await wikis.ensureForConnector({ connectorId: connector.id, schemaMd: '# WIKI\n' })
    const document = await prisma.document.create({
      data: { tenantId: tenant.id, connectorId: connector.id, filename: 'forras.txt', extractedText: 'forrás', uploadedById: adminUser.id, status: 'processed' },
    })
    return { connector, wiki, documentId: document.id }
  }
  const main = await mkWiki('Közös wiki')
  const second = await mkWiki('Másik wiki')
  const callerFor = (target: { connector: Connector }, writeMode: 'direct' | 'approval' = 'direct', extra: Partial<WikiCaller> = {}): WikiCaller => ({
    tenantId: tenant.id,
    userId: adminUser.id,
    agentId: agent.id,
    snapshot: { connectors: [{ connectorId: target.connector.id, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: writeMode }] as never },
    ...extra,
  })
  const direct = callerFor(main)
  const reader: WikiCaller = { ...direct, snapshot: { connectors: [{ connectorId: main.connector.id, type: 'knowledge_base', accessMode: 'read', wikiAccess: 'read' }] as never } }

  const seed = async (target: typeof main, path: string, agentId: string = agent.id) => {
    const result = await wikis.applyChangeSet({
      wikiId: target.wiki.id,
      connectorId: target.connector.id,
      changeSet: { create: { wikiId: target.wiki.id, connectorId: target.connector.id, agentId, pages: [], approverScope: {} } },
      ops: [{
        kind: 'create',
        page: { path, type: 'entity', title: path, summary: 's', category: null, frontmatter: {}, body: 'A jutalék 2%.', sourceRefs: [{ documentId: target.documentId }] as never, outLinks: extractWikiLinks('b', path), status: 'published', contentHash: randomUUID() },
        createdByAgentId: agentId,
        chunks: pageChunks({ path, type: 'entity', title: path, summary: 's', category: null, frontmatter: {}, body: 'A jutalék 2%.', sources: [{ documentId: target.documentId }] }),
      }],
      log: { op: 'ingest', title: 'seed', pagePaths: [path], actorAgentId: agentId },
      appliedAt: new Date(),
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    return (await wikis.findPage(target.connector.id, path))!
  }
  const writePage = (caller: WikiCaller, target: typeof main, path: string, baseVersion: string | undefined, resolves?: Array<{ commentId: string; note: string }>, body = 'A jutalék 3%.') =>
    wikiService.write(caller, {
      wikiId: target.wiki.id,
      pages: [{ path, action: 'upsert', type: 'entity', title: path, summary: 's', body, baseVersion, frontmatter: { sources: [{ documentId: target.documentId }] } }],
      ...(resolves ? { resolvesComments: resolves } : {}),
    })
  const add = async (who: WikiConsoleActor, path: string, body = 'A jutalék 3%, nem 2%.', target = main, quote?: string) =>
    (await service.addComment(who, target.connector.id, { path, body, quote })).id
  const statusOf = async (id: string) => (await prisma.wikiComment.findUniqueOrThrow({ where: { id } })).status
  const eventsOf = (id: string) => prisma.wikiCommentEvent.findMany({ where: { commentId: id }, orderBy: { createdAt: 'asc' } })
  const hashOf = async (path: string, target = main) => (await wikis.findPage(target.connector.id, path))!.contentHash

  await check('AC1: csak az ír és olvas, aki látja a wikit', async () => {
    await seed(main, 'ac1.md')
    const id = await add(operator, 'ac1.md')
    assert.equal((await service.listForPage(operator2, main.connector.id, 'ac1.md')).comments.length, 1)
    await rejectsCode(() => add(foreignAdmin, 'ac1.md'), 'not_found')
    await rejectsCode(() => service.listForPage(foreignAdmin, main.connector.id, 'ac1.md'), 'not_found')
    await rejectsCode(() => service.answer(foreignAdmin, main.connector.id, id, 'x'), 'not_found')
    const viewer: WikiConsoleActor = { userId: randomUUID(), tenantId: tenant.id, role: 'viewer' }
    await rejectsCode(() => service.listForWiki(viewer, main.connector.id, {}), 'not_found')

    const members = await mkWiki('Névsoros', { visibility: 'members', ownerUserId: adminUser.id, kbMemberUserIds: [adminUser.id, operatorUser.id] })
    await seed(members, 'm.md')
    const mine = await add(operator, 'm.md', 'Kérdés', members)
    const nonMemberAdmin: WikiConsoleActor = { userId: secondOperator.id, tenantId: tenant.id, role: 'admin' }
    await rejectsCode(() => service.listForPage(nonMemberAdmin, members.connector.id, 'm.md'), 'not_found')
    await prisma.connector.update({ where: { id: members.connector.id }, data: { kbMemberUserIds: [adminUser.id] } })
    await rejectsCode(() => service.withdraw(operator, members.connector.id, mine), 'not_found')
    await rejectsCode(() => service.listForPage(operator, members.connector.id, 'm.md'), 'not_found')
  })

  await check('AC1 (agent): más wikihez kötött agent nem fér hozzá', async () => {
    const stranger = callerFor(second)
    assert.equal((await service.listForAgent(stranger, { wikiId: main.wiki.id })).ok, false)
    const id = await add(operator, 'ac1.md', 'Második')
    const denied = await service.respondAsAgent(stranger, { wikiId: main.wiki.id, commentId: id, action: 'decline', text: 'x' })
    assert.equal(denied.ok, false)
    assert.equal(await statusOf(id), 'open')
  })

  await check('AC2: a szerző a munkamenetből jön, kliens-argumentum nem számít', async () => {
    const { id } = await service.addComment(operator, main.connector.id, { path: 'ac1.md', body: 'x', authorUserId: adminUser.id } as never)
    assert.equal((await prisma.wikiComment.findUniqueOrThrow({ where: { id } })).authorUserId, operatorUser.id)
  })

  await check('generált lapra, archivált és nem létező oldalra nem lehet kommentelni', async () => {
    await rejectsCode(() => add(operator, 'index.md'), 'page_not_commentable')
    await rejectsCode(() => add(operator, 'nincs.md'), 'page_not_commentable')
    const page = await seed(main, 'archived.md')
    await prisma.wikiPage.update({ where: { id: page.id }, data: { status: 'archived' } })
    await rejectsCode(() => add(operator, 'archived.md'), 'page_not_commentable')
  })

  await check('AC3: az oldal áthelyezése után a komment az új útvonalon látszik', async () => {
    await seed(main, 'old-path.md')
    const id = await add(operator, 'old-path.md')
    okResult(await wikiService.write(direct, { wikiId: main.wiki.id, pages: [{ path: 'old-path.md', action: 'move', newPath: 'new-path.md' }] }))
    const listed = await service.listForPage(operator, main.connector.id, 'new-path.md')
    assert.deepEqual(listed.comments.map((row) => row.id), [id])
    assert.equal(listed.comments[0].path, 'new-path.md')
  })

  await check('AC4: a komment nem változtatja az oldalt, és nem kerül a keresésbe, az index.md-be', async () => {
    const page = await seed(main, 'ac4.md')
    const marker = `egyedi-${randomUUID()}`
    await add(operator, 'ac4.md', `Vélemény ${marker}`)
    const after = (await wikis.findPage(main.connector.id, 'ac4.md'))!
    assert.equal(after.version, page.version)
    assert.equal(after.contentHash, page.contentHash)
    assert.equal(after.updatedAt.getTime(), page.updatedAt.getTime())
    assert.equal(await prisma.knowledgeChunk.count({ where: { connectorId: main.connector.id, text: { contains: marker } } }), 0)
    const index = await wikiService.readPage({ tenantId: tenant.id, connectorId: main.connector.id, path: 'index.md', explicitWiki: true })
    assert.doesNotMatch(JSON.stringify(index), new RegExp(marker))
    const log = await wikis.listLog(main.wiki.id, 1000)
    assert.doesNotMatch(JSON.stringify(log), new RegExp(marker))
  })

  await check('AC5: közvetlen írás egy tranzakcióban; hibánál sem az oldal, sem a komment nem változik', async () => {
    const page = await seed(main, 'ac5.md')
    const id = await add(admin, 'ac5.md')
    // Kikényszerített hiba: a tervezés még nyitottnak látta, az írás előtt más lezárta.
    const racing = new WikiService({
      wikis,
      history,
      documents: new PostgresDocumentRepository(),
      connectors,
      agents: new PostgresAgentRepository(),
      knowledgeBase: {} as never,
      audit,
      commentsEnabled,
      comments: {
        ...comments,
        activeRoles: comments.activeRoles.bind(comments),
        findForWrite: async (wikiId, ids) => {
          const rows = await comments.findForWrite(wikiId, ids)
          await prisma.wikiComment.update({ where: { id }, data: { status: 'declined' } })
          return rows
        },
      } as never,
    })
    const fresh = page
    const forced = await racing.write(direct, {
      wikiId: main.wiki.id,
      pages: [{ path: 'ac5.md', action: 'upsert', type: 'entity', title: 'x', summary: 's', body: 'Más törzs', baseVersion: fresh.contentHash, frontmatter: { sources: [{ documentId: main.documentId }] } }],
      resolvesComments: [{ commentId: id, note: 'kész' }],
    })
    failCode(forced, 'comment_not_open')
    assert.equal((await wikis.findPage(main.connector.id, 'ac5.md'))!.contentHash, fresh.contentHash)
    assert.equal(await statusOf(id), 'declined')

    await prisma.wikiComment.update({ where: { id }, data: { status: 'open' } })
    const stale = await writePage(direct, main, 'ac5.md', 'elavult-hash', [{ commentId: id, note: 'kész' }])
    failCode(stale, 'conflict')
    assert.equal(await statusOf(id), 'open', 'ütközésnél a komment sem változik')

    const applied = okResult(await writePage(direct, main, 'ac5.md', fresh.contentHash, [{ commentId: id, note: 'Átírtam 3%-ra.' }], 'Végleges törzs'))
    assert.deepEqual(applied.resolvedComments, [id])
    const row = await prisma.wikiComment.findUniqueOrThrow({ where: { id } })
    assert.equal(row.status, 'resolved')
    assert.equal(row.changeSetId, applied.changeSetId)
    assert.ok(row.closedAt)
    const events = await eventsOf(id)
    assert.equal(events.at(-1)?.body, 'Átírtam 3%-ra.')
    assert.equal(events.at(-1)?.actorKind, 'agent')
    assert.equal(events.at(-1)?.actorAgentId, agent.id)
  })

  await check('AC6: közvetlen módú közös wikin a nem-kezelő szerző módosítása jóváhagyásra megy, a kezelőé nem', async () => {
    const page = await seed(main, 'ac6.md')
    const fromOperator = await add(operator, 'ac6.md')
    const outcome = await writePage(direct, main, 'ac6.md', page.contentHash, [{ commentId: fromOperator, note: 'Átírtam.' }])
    assert.equal(outcome.ok, 'approval', JSON.stringify(outcome))
    assert.equal((outcome as Row).request.reason, 'comment_author')
    assert.equal(await statusOf(fromOperator), 'pending_approval')
    assert.equal(await hashOf('ac6.md'), page.contentHash, 'jóváhagyásig az oldal nem változik')
    assert.deepEqual((outcome as Row).result.pendingComments, [fromOperator])

    const page2 = await seed(main, 'ac6b.md')
    const fromAdmin = await add(admin, 'ac6b.md')
    okResult(await writePage(direct, main, 'ac6b.md', page2.contentHash, [{ commentId: fromAdmin, note: 'Kész.' }]))
    assert.equal(await statusOf(fromAdmin), 'resolved')

    const priv = await mkWiki('Privát', { visibility: 'private_to_user', ownerUserId: operatorUser.id })
    const privPage = await seed(priv, 'p.md')
    const own = await add(operator, 'p.md', 'Saját', priv)
    const privCaller = { ...callerFor(priv), userId: operatorUser.id }
    okResult(await writePage(privCaller, priv, 'p.md', privPage.contentHash, [{ commentId: own, note: 'Kész.' }]))
    assert.equal(await statusOf(own), 'resolved')

    // A szervezetből kikerült szerző nem kezelő.
    const page3 = await seed(main, 'ac6c.md')
    const gone = await add(operator2, 'ac6c.md')
    await prisma.tenantMembership.updateMany({ where: { tenantId: tenant.id, userId: secondOperator.id }, data: { status: 'suspended' } })
    const goneOutcome = await writePage(direct, main, 'ac6c.md', page3.contentHash, [{ commentId: gone, note: 'x' }])
    assert.equal(goneOutcome.ok, 'approval')
    await prisma.tenantMembership.updateMany({ where: { tenantId: tenant.id, userId: secondOperator.id }, data: { status: 'active' } })
  })

  await check('jóváhagyásos módban a komment pending_approval, de a tálca és a többi út érintetlen', async () => {
    const approvalCaller = callerFor(main, 'approval')
    const page = await seed(main, 'approval.md')
    const id = await add(admin, 'approval.md')
    const outcome = await writePage(approvalCaller, main, 'approval.md', page.contentHash, [{ commentId: id, note: 'x' }])
    assert.equal(outcome.ok, 'approval')
    assert.equal((outcome as Row).request.reason, 'approval_mode')
    assert.equal(await statusOf(id), 'pending_approval')
  })

  await check('AC7: jóváhagyás után resolved; elutasítás, ütközés, láthatóság-váltás után open, az ok beírásával', async () => {
    const page = await seed(main, 'ac7.md')
    const approved = await add(operator, 'ac7.md')
    const pendingA = (await writePage(direct, main, 'ac7.md', page.contentHash, [{ commentId: approved, note: 'Átírtam.' }])) as Row
    assert.equal(pendingA.ok, 'approval')
    const applied = await wikiService.applyApproved(direct, pendingA.request.changeSetId)
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(await statusOf(approved), 'resolved')
    assert.equal((await prisma.wikiComment.findUniqueOrThrow({ where: { id: approved } })).changeSetId, pendingA.request.changeSetId)

    const page2 = await seed(main, 'ac7b.md')
    const rejected = await add(operator, 'ac7b.md')
    const pendingB = (await writePage(direct, main, 'ac7b.md', page2.contentHash, [{ commentId: rejected, note: 'Átírtam.' }])) as Row
    assert.equal(await wikiService.reject(pendingB.request.changeSetId, { tenantId: tenant.id, actorUserId: adminUser.id, note: 'Nem ez a szerződés.' }), true)
    assert.equal(await statusOf(rejected), 'open')
    const eventsB = await eventsOf(rejected)
    assert.equal(eventsB.at(-1)?.systemCode, 'change_rejected')
    assert.equal(eventsB.at(-1)?.body, 'Nem ez a szerződés.')
    const row = await prisma.wikiComment.findUniqueOrThrow({ where: { id: rejected } })
    assert.equal(row.changeSetId, null)
    assert.equal(row.closedAt, null)

    const page3 = await seed(main, 'ac7c.md')
    const conflicted = await add(operator, 'ac7c.md')
    const pendingC = (await writePage(direct, main, 'ac7c.md', page3.contentHash, [{ commentId: conflicted, note: 'Átírtam.' }])) as Row
    okResult(await writePage(direct, main, 'ac7c.md', page3.contentHash, undefined, 'Közben más írta'))
    const failed = await wikiService.applyApproved(direct, pendingC.request.changeSetId)
    assert.equal(failed.ok, false)
    assert.equal(await statusOf(conflicted), 'open')
    assert.equal((await eventsOf(conflicted)).at(-1)?.systemCode, 'change_conflict')

    const page4 = await seed(main, 'ac7d.md')
    const visibility = await add(operator, 'ac7d.md')
    const pendingD = (await writePage(direct, main, 'ac7d.md', page4.contentHash, [{ commentId: visibility, note: 'x' }])) as Row
    await wikiService.reject(pendingD.request.changeSetId, { tenantId: tenant.id, actorUserId: adminUser.id, reason: 'visibility_changed' })
    assert.equal(await statusOf(visibility), 'open')
    assert.equal((await eventsOf(visibility)).at(-1)?.systemCode, 'visibility_changed')
  })

  await check('AC8: teljes change-set visszavonása visszanyitja a kommenteket, egy oldal visszaállítása nem', async () => {
    const page = await seed(main, 'ac8.md')
    const id = await add(admin, 'ac8.md')
    const applied = okResult(await writePage(direct, main, 'ac8.md', page.contentHash, [{ commentId: id, note: 'Kész.' }]))
    assert.equal(await statusOf(id), 'resolved')
    const reverted = await wikiService.revertAsHuman({
      tenantId: tenant.id,
      userId: adminUser.id,
      connector: main.connector,
      wikiId: main.wiki.id,
      target: { kind: 'changeset', seq: applied.seq },
    })
    assert.equal(reverted.ok, true, JSON.stringify(reverted))
    assert.equal(await statusOf(id), 'open')
    assert.equal((await eventsOf(id)).at(-1)?.systemCode, 'change_reverted')
    const row = await prisma.wikiComment.findUniqueOrThrow({ where: { id } })
    assert.equal(row.changeSetId, null)

    const page2 = await seed(main, 'ac8b.md')
    const kept = await add(admin, 'ac8b.md')
    okResult(await writePage(direct, main, 'ac8b.md', page2.contentHash, [{ commentId: kept, note: 'Kész.' }]))
    const restored = await wikiService.revertAsHuman({
      tenantId: tenant.id,
      userId: adminUser.id,
      connector: main.connector,
      wikiId: main.wiki.id,
      target: { kind: 'page', path: 'ac8b.md', version: 1 },
    })
    assert.equal(restored.ok, true, JSON.stringify(restored))
    assert.equal(await statusOf(kept), 'resolved', 'oldal-visszaállítás nem köthető kommenthez')
  })

  await check('AC9: vegyes írásnál a komment csak a függő rész jóváhagyása után kész; elutasításkor a kód jelzi a kint maradt részt', async () => {
    await seed(main, 'ac9-others.md', otherAgent.id)
    const own = await seed(main, 'ac9-own.md')
    const id = await add(admin, 'ac9-own.md')
    const outcome = (await wikiService.write(direct, {
      wikiId: main.wiki.id,
      pages: [
        { path: 'ac9-own.md', action: 'upsert', type: 'entity', title: 'x', summary: 's', body: 'Új', baseVersion: own.contentHash, frontmatter: { sources: [{ documentId: main.documentId }] } },
        { path: 'ac9-others.md', action: 'archive' },
      ],
      resolvesComments: [{ commentId: id, note: 'Kész.' }],
    })) as Row
    assert.equal(outcome.ok, 'approval', JSON.stringify(outcome))
    assert.equal(outcome.request.reason, 'other_authors_page')
    assert.ok(outcome.request.applied, 'a közvetlen rész élesben van')
    assert.notEqual(await hashOf('ac9-own.md'), own.contentHash)
    assert.equal(await statusOf(id), 'pending_approval')
    const applied = await wikiService.applyApproved(direct, outcome.request.changeSetId)
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(await statusOf(id), 'resolved')

    await seed(main, 'ac9b-others.md', otherAgent.id)
    const own2 = await seed(main, 'ac9b-own.md')
    const id2 = await add(admin, 'ac9b-own.md')
    const outcome2 = (await wikiService.write(direct, {
      wikiId: main.wiki.id,
      pages: [
        { path: 'ac9b-own.md', action: 'upsert', type: 'entity', title: 'x', summary: 's', body: 'Új', baseVersion: own2.contentHash, frontmatter: { sources: [{ documentId: main.documentId }] } },
        { path: 'ac9b-others.md', action: 'archive' },
      ],
      resolvesComments: [{ commentId: id2, note: 'Kész.' }],
    })) as Row
    await wikiService.reject(outcome2.request.changeSetId, { tenantId: tenant.id, actorUserId: adminUser.id })
    assert.equal(await statusOf(id2), 'open')
    assert.equal((await eventsOf(id2)).at(-1)?.systemCode, 'change_rejected_partly_applied')
    assert.notEqual(await hashOf('ac9b-own.md'), own2.contentHash, 'a már alkalmazott rész marad')
  })

  await check('AC10: az agent válasza; nem nyitott kommentre comment_not_open, olvasó agent nem válaszolhat', async () => {
    await seed(main, 'ac10.md')
    for (const [action, status] of [['already_done', 'resolved'], ['decline', 'declined'], ['ask', 'question']] as const) {
      const id = await add(operator, 'ac10.md')
      failCode(await service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: id, action, text: '   ' }), 'invalid_args')
      okResult(await service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: id, action, text: 'Ellenőriztem.' }))
      assert.equal(await statusOf(id), status)
      failCode(await service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: id, action: 'decline', text: 'újra' }), 'comment_not_open')
    }
    const id = await add(operator, 'ac10.md')
    failCode(await service.respondAsAgent(reader, { wikiId: main.wiki.id, commentId: id, action: 'decline', text: 'x' }), 'wiki_write_not_allowed')
    assert.equal(await statusOf(id), 'open')
    failCode(await service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: randomUUID(), action: 'decline', text: 'x' }), 'not_found')
    // A már jó oldalnál a komment kész, de módosítás nem tartozik hozzá.
    const done = await add(operator, 'ac10.md')
    okResult(await service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: done, action: 'already_done', text: 'Jó.' }))
    assert.equal((await prisma.wikiComment.findUniqueOrThrow({ where: { id: done } })).changeSetId, null)
  })

  await check('AC11: két párhuzamos lezárásból az egyik comment_not_open', async () => {
    await seed(main, 'ac11.md')
    const id = await add(operator, 'ac11.md')
    const results = await Promise.all([
      service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: id, action: 'decline', text: 'A' }),
      service.respondAsAgent({ ...direct, agentId: otherAgent.id }, { wikiId: main.wiki.id, commentId: id, action: 'ask', text: 'B' }),
    ])
    assert.deepEqual(results.map((row) => row.ok).sort(), [false, true])
    failCode(results.find((row) => !row.ok)!, 'comment_not_open')
    assert.equal((await eventsOf(id)).filter((row) => row.actorKind === 'agent').length, 1)
  })

  await check('AC12: a forrás szerzője és ideje a komment sorából jön; más wiki kommentje invalid_comment_ref', async () => {
    const page = await seed(main, 'ac12.md')
    const id = await add(operator, 'ac12.md')
    const row = await prisma.wikiComment.findUniqueOrThrow({ where: { id } })
    const applied = await wikiService.write(direct, {
      wikiId: main.wiki.id,
      pages: [{
        path: 'ac12.md', action: 'upsert', type: 'entity', title: 'x', summary: 's', body: 'A jutalék 3%.', baseVersion: page.contentHash,
        frontmatter: { sources: [{ kind: 'wiki_comment', commentId: id, authorUserId: adminUser.id, commentedAt: '2000-01-01T00:00:00.000Z' }] },
      }],
    })
    okResult(applied)
    const refs = (await wikis.findPage(main.connector.id, 'ac12.md'))!.sourceRefs as Row[]
    assert.deepEqual(refs, [{ kind: 'wiki_comment', commentId: id, authorUserId: operatorUser.id, commentedAt: row.createdAt.toISOString() }])

    // Háttérfutásban (nem interaktív) is mehet, szemben a human_note-tal.
    assert.notEqual(direct.interactive, true)

    await seed(second, 'other.md')
    const foreign = await add(operator, 'other.md', 'Másik wiki', second)
    const fresh = (await wikis.findPage(main.connector.id, 'ac12.md'))!
    failCode(await wikiService.write(direct, {
      wikiId: main.wiki.id,
      pages: [{ path: 'ac12.md', action: 'patch', baseVersion: fresh.contentHash, patch: [{ op: 'addSource', source: { kind: 'wiki_comment', commentId: foreign } as never }] }],
    }), 'invalid_comment_ref')
    failCode(await writePage(direct, main, 'ac12.md', fresh.contentHash, [{ commentId: foreign, note: 'x' }]), 'invalid_comment_ref')
    assert.equal(await hashOf('ac12.md'), fresh.contentHash, 'semmi nem íródott')
  })

  await check('a felület forrása: név és dátum, törölt kommentnél „törölt komment”', async () => {
    const before = await consoleService.getPage(operator, main.connector.id, 'ac12.md').catch((error) => error)
    assert.ok(!(before instanceof Error), String(before))
    const source = before.sources.find((row: Row) => row.kind === 'wiki_comment')
    assert.equal(source.authorName, 'Kovács Anna')
    assert.equal(source.erased, false)
    await service.remove(admin, main.connector.id, source.commentId)
    const after = await consoleService.getPage(operator, main.connector.id, 'ac12.md')
    const erased = after.sources.find((row) => row.kind === 'wiki_comment') as Row
    assert.equal(erased.erased, true)
    assert.equal(erased.authorName, null)
    assert.equal(erased.commentedAt, null)
    // A törölt komment az oldalon maradt forrása újraírásnál nem akadály.
    const page = (await wikis.findPage(main.connector.id, 'ac12.md'))!
    okResult(await wikiService.write(direct, {
      wikiId: main.wiki.id,
      pages: [{ path: 'ac12.md', action: 'upsert', type: 'entity', title: 'x', summary: 's', body: 'Újra', baseVersion: page.contentHash, frontmatter: { sources: page.sourceRefs } }],
    }))
  })

  await check('AC13: GDPR-törlés mindhárom körben kiüríti a kommentet, az idézetet és az eseményeket; az audit szöveg nélküli', async () => {
    const secretWord = `titok${randomUUID().slice(0, 6)}`
    const erase = (target: typeof main, name: string, scope: Parameters<typeof historyService.executeErasure>[2]['scope']) =>
      historyService.executeErasure(admin, target.connector.id, { scope, reason: 'GDPR kérés', confirmName: name })

    // Szöveg-kör, kitakarás és teljes törlés.
    const text = await mkWiki('GDPR szöveg')
    const textCaller = callerFor(text)
    await seed(text, 'gdpr-text.md')
    const redacted = await add(operator, 'gdpr-text.md', `Ez ${secretWord} adat`, text, `idézet ${secretWord}`)
    okResult(await service.respondAsAgent(textCaller, { wikiId: text.wiki.id, commentId: redacted, action: 'ask', text: `Biztos ${secretWord}?` }))
    const preview = await historyService.previewErasure(admin, text.connector.id, { kind: 'text', phrase: secretWord, mode: 'redact' })
    assert.equal(preview.counts.comment, 1)
    assert.equal((await erase(text, 'GDPR szöveg', { kind: 'text', phrase: secretWord, mode: 'redact' })).ok, true)
    const redactedRow = await prisma.wikiComment.findUniqueOrThrow({ where: { id: redacted }, include: { events: true } })
    assert.doesNotMatch(JSON.stringify(redactedRow), new RegExp(secretWord))
    assert.match(redactedRow.body, /\[törölve\]/)
    assert.equal(redactedRow.erasedAt, null)

    const erased = `tel${randomUUID().slice(0, 6)}`
    const gone = await add(operator, 'gdpr-text.md', `Hívd ${erased}`, text)
    assert.equal((await erase(text, 'GDPR szöveg', { kind: 'text', phrase: erased, mode: 'erase' })).ok, true)
    const goneRow = await prisma.wikiComment.findUniqueOrThrow({ where: { id: gone } })
    assert.equal(goneRow.body, '')
    assert.ok(goneRow.erasedAt)
    assert.ok(goneRow.erasureId)
    assert.equal((await service.listForPage(operator, text.connector.id, 'gdpr-text.md')).comments.find((row) => row.id === gone)?.erased, true)

    // Oldal-kör (a forrásdokumentum is törlődik, ezért külön wikin).
    const pages = await mkWiki('GDPR oldal')
    await seed(pages, 'gdpr-page.md')
    const onPage = await add(operator, 'gdpr-page.md', 'Oldal-komment', pages, 'idézet')
    okResult(await service.respondAsAgent(callerFor(pages), { wikiId: pages.wiki.id, commentId: onPage, action: 'ask', text: 'Válasz szövege' }))
    assert.equal((await erase(pages, 'GDPR oldal', { kind: 'pages', paths: ['gdpr-page.md'] })).ok, true)
    const pageRow = await prisma.wikiComment.findUniqueOrThrow({ where: { id: onPage }, include: { events: true } })
    assert.equal(pageRow.body, '')
    assert.equal(pageRow.quote, null)
    assert.ok(pageRow.events.every((event) => event.body === null))

    // Verzió-kör: csak a törölt verzióhoz írt komment idézete ürül.
    const revision = await mkWiki('GDPR verzió')
    const versioned = await seed(revision, 'gdpr-rev.md')
    const atV1 = await add(operator, 'gdpr-rev.md', 'v1 komment', revision, 'A jutalék 2%.')
    okResult(await writePage(callerFor(revision), revision, 'gdpr-rev.md', versioned.contentHash))
    const atV2 = await add(operator, 'gdpr-rev.md', 'v2 komment', revision, 'A jutalék 3%.')
    assert.equal((await erase(revision, 'GDPR verzió', { kind: 'revision', path: 'gdpr-rev.md', version: 1 })).ok, true)
    const v1Row = await prisma.wikiComment.findUniqueOrThrow({ where: { id: atV1 } })
    assert.equal(v1Row.quote, null)
    assert.equal(v1Row.body, 'v1 komment')
    assert.equal((await prisma.wikiComment.findUniqueOrThrow({ where: { id: atV2 } })).quote, 'A jutalék 3%.')

    // Az audit szöveg nélküli: sem a komment, sem az indoklás nem kerül bele.
    const auditRows = await prisma.auditLog.findMany({
      where: { tenantId: tenant.id, OR: [{ action: { startsWith: 'kb.wiki.comment.' } }, { action: 'kb.wiki.erasure.executed' }] },
    })
    assert.ok(auditRows.some((row) => row.action === 'kb.wiki.erasure.executed'))
    assert.ok(auditRows.some((row) => row.action === 'kb.wiki.comment.created'))
    const auditJson = JSON.stringify(auditRows, (_key, value) => (typeof value === 'bigint' ? String(value) : value))
    for (const needle of [secretWord, erased, 'Kovács Anna', 'Oldal-komment', 'A jutalék 3%, nem 2%.', 'GDPR kérés']) {
      assert.doesNotMatch(auditJson, new RegExp(needle), needle)
    }
  })

  await check('GDPR-törlés: az elutasított függő módosításhoz kötött komment visszanyílik', async () => {
    const pending = await mkWiki('GDPR függő')
    const page = await seed(pending, 'gdpr-pending.md')
    const id = await add(operator, 'gdpr-pending.md', 'Maradjon', pending)
    const outcome = (await writePage(callerFor(pending), pending, 'gdpr-pending.md', page.contentHash, [{ commentId: id, note: 'x' }], 'Tartalom kiszedendo')) as Row
    assert.equal(outcome.ok, 'approval')
    const done = await historyService.executeErasure(admin, pending.connector.id, { scope: { kind: 'text', phrase: 'kiszedendo', mode: 'erase' }, reason: 'GDPR kérés', confirmName: 'GDPR függő' })
    assert.equal(done.ok, true)
    assert.equal(await statusOf(id), 'open')
    assert.equal((await eventsOf(id)).at(-1)?.systemCode, 'change_erased')
  })

  await check('AC14: érvényes kártyaszámot tartalmazó komment nem menthető; a 31. komment érthető hibát ad', async () => {
    const quiet = await mkWiki('Elárasztás')
    await seed(quiet, 'flood.md')
    await rejectsCode(() => add(operator, 'flood.md', 'A kártyám 4111 1111 1111 1111', quiet), 'comment_sensitive_data')
    await rejectsCode(() => add(operator, 'flood.md', 'ok', quiet, '4111 1111 1111 1111'), 'comment_sensitive_data')
    await rejectsCode(() => add(operator, 'flood.md', 'x'.repeat(4001), quiet), 'invalid_args')
    const results = await Promise.allSettled(Array.from({ length: 31 }, (_, i) => add(operator, 'flood.md', `Komment ${i}`, quiet)))
    assert.equal(results.filter((row) => row.status === 'fulfilled').length, 30, 'párhuzamos küldésnél sem csúszik át')
    const rejected = results.find((row): row is PromiseRejectedResult => row.status === 'rejected')
    assert.equal(rejected?.reason.code, 'comment_rate_limited')
    await add(operator2, 'flood.md', 'Másik szerző írhat', quiet)
  })

  await check('emberi műveletek: visszavonás, válasz, újranyitás, kézi lezárás, törlés', async () => {
    await seed(main, 'human.md')
    const mine = await add(operator, 'human.md')
    await rejectsCode(() => service.withdraw(operator2, main.connector.id, mine), 'not_author')
    await service.withdraw(operator, main.connector.id, mine)
    assert.equal(await statusOf(mine), 'withdrawn')
    await rejectsCode(() => service.withdraw(operator, main.connector.id, mine), 'comment_not_open')
    await rejectsCode(() => service.reopen(operator, main.connector.id, mine, 'x'), 'comment_not_open')

    const asked = await add(operator, 'human.md')
    okResult(await service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: asked, action: 'ask', text: 'Melyik szerződés?' }))
    await rejectsCode(() => service.answer(operator2, main.connector.id, asked, '   '), 'invalid_args')
    await service.answer(operator2, main.connector.id, asked, 'A 2026-os.')
    assert.equal(await statusOf(asked), 'open', 'bárki válaszolhat, aki látja')
    await rejectsCode(() => service.answer(operator, main.connector.id, asked, 'még egyszer'), 'comment_not_open')

    const declined = await add(operator, 'human.md')
    okResult(await service.respondAsAgent(direct, { wikiId: main.wiki.id, commentId: declined, action: 'decline', text: 'Nem.' }))
    await rejectsCode(() => service.reopen(operator2, main.connector.id, declined, 'miért'), 'not_author')
    await rejectsCode(() => service.reopen(operator, main.connector.id, declined, '  '), 'invalid_args')
    await service.reopen(operator, main.connector.id, declined, 'De igen, lásd a szerződést.')
    assert.equal(await statusOf(declined), 'open')

    await rejectsCode(() => service.closeManually(operator, main.connector.id, declined, { to: 'declined', reason: 'x' }), 'forbidden')
    await service.closeManually(admin, main.connector.id, declined, { to: 'declined', reason: 'Lezárom.' })
    assert.equal(await statusOf(declined), 'declined')
    // A kezelő újranyithat, a saját kézi lezárása nem keletkeztet teendőt.
    await service.reopen(admin, main.connector.id, declined, 'Mégis.')
    const own = await add(admin, 'human.md')
    await service.closeManually(admin, main.connector.id, own, { to: 'resolved', reason: 'Elintéztem.' })
    assert.ok((await prisma.wikiComment.findUniqueOrThrow({ where: { id: own } })).authorSeenAt)

    await rejectsCode(() => service.remove(operator, main.connector.id, own), 'forbidden')
    await service.remove(admin, main.connector.id, own)
    await rejectsCode(() => service.reopen(admin, main.connector.id, own, 'x'), 'not_found')
  })

  await check('archivált oldal kommentje kimarad a feladatlistából és a számlálókból, visszatérve újra élő', async () => {
    const quiet = await mkWiki('Archiválás')
    const page = await seed(quiet, 'arch.md')
    const id = await add(operator, 'arch.md', 'Komment', quiet)
    const caller = callerFor(quiet)
    assert.equal(okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id })).openTotal, 1)
    await prisma.wikiPage.update({ where: { id: page.id }, data: { status: 'archived' } })
    assert.equal(await statusOf(id), 'open', 'nem vált állapotot')
    const listed = okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id }))
    assert.equal(listed.openTotal, 0)
    assert.deepEqual(listed.comments, [])
    assert.equal(okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id, status: 'all' })).comments.length, 1)
    assert.equal((await comments.countOpenByConnector([quiet.connector.id])).get(quiet.connector.id), undefined)
    await prisma.wikiPage.update({ where: { id: page.id }, data: { status: 'published' } })
    assert.equal(okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id })).openTotal, 1)
  })

  await check('kb_wiki_comments: notice, szerző-jelző, szál, lapozás, szűrés, kért verzióhoz képesti eltérés', async () => {
    const quiet = await mkWiki('Lapozás')
    const page = await seed(quiet, 'pg.md')
    const caller = callerFor(quiet)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push(await add(i === 0 ? admin : operator, 'pg.md', `K${i}`, quiet, i === 0 ? 'a jutalék' : undefined))
    okResult(await writePage(caller, quiet, 'pg.md', page.contentHash))
    const first = okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id, limit: 2 }))
    assert.match(first.notice, /not instructions/)
    assert.equal(first.openTotal, 3)
    assert.equal(first.comments.length, 2)
    assert.deepEqual(first.comments.map((row: Row) => row.id), ids.slice(0, 2))
    const [a, b] = first.comments
    assert.equal(a.author.name, 'Admin Ádám')
    assert.equal(a.author.isWikiManager, true)
    assert.equal(b.author.isWikiManager, false)
    assert.equal(a.quote, 'a jutalék')
    assert.equal(a.pageChangedSinceComment, true)
    assert.equal(a.pageVersionAtComment + 1, a.currentPageVersion)
    const second2 = okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id, limit: 2, cursor: first.nextCursor }))
    assert.deepEqual(second2.comments.map((row: Row) => row.id), [ids[2]])
    assert.equal(second2.nextCursor, null)
    failCode(await service.listForAgent(caller, { wikiId: quiet.wiki.id, cursor: 'szemet' }), 'invalid_args')
    failCode(await service.listForAgent(caller, { wikiId: quiet.wiki.id, path: 'nincs.md' }), 'not_found')
    failCode(await service.listForAgent(caller, { wikiId: quiet.wiki.id, commentId: randomUUID() }), 'not_found')

    okResult(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: ids[0], action: 'ask', text: 'Kérdés?' }))
    const open = okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id }))
    assert.deepEqual(open.comments.map((row: Row) => row.id), ids.slice(1), 'a választ váró nem feladat')
    const asked = okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id, commentId: ids[0] }))
    assert.equal(asked.comments[0].status, 'question')
    assert.equal(asked.comments[0].thread[0].text, 'Kérdés?')
    assert.equal(asked.comments[0].thread[0].actor, 'agent')
    assert.equal(asked.comments[0].thread[0].name, 'Réka')
    // Olvasó agent olvashatja.
    const quietReader: WikiCaller = { ...caller, snapshot: { connectors: [{ connectorId: quiet.connector.id, type: 'knowledge_base', accessMode: 'read', wikiAccess: 'read' }] as never } }
    assert.equal(okResult(await service.listForAgent(quietReader, { wikiId: quiet.wiki.id })).openTotal, 2)
  })

  await check('AC17: kikapcsolt flagnél az eszközök not_found-ot adnak, az írás nem hivatkozhat kommentre, a meglévők megmaradnak', async () => {
    const quiet = await mkWiki('Flag')
    const page = await seed(quiet, 'flag.md')
    const caller = callerFor(quiet)
    const id = await add(admin, 'flag.md', 'Komment', quiet)
    assert.equal(((await wikiService.listWikis(caller)).find((row) => row.wikiId === quiet.wiki.id) as Row).comments.open, 1)
    assert.equal((await wikiService.readPage({ tenantId: tenant.id, connectorId: quiet.connector.id, path: 'flag.md', explicitWiki: true, reader: caller }))?.openComments, 1)

    flagOn = false
    failCode(await service.listForAgent(caller, { wikiId: quiet.wiki.id }), 'not_found')
    failCode(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: id, action: 'decline', text: 'x' }), 'not_found')
    failCode(await writePage(caller, quiet, 'flag.md', page.contentHash, [{ commentId: id, note: 'x' }]), 'invalid_comment_ref')
    failCode(await wikiService.write(caller, {
      wikiId: quiet.wiki.id,
      pages: [{ path: 'flag.md', action: 'patch', baseVersion: page.contentHash, patch: [{ op: 'addSource', source: { kind: 'wiki_comment', commentId: id } as never }] }],
    }), 'invalid_comment_ref')
    assert.equal(((await wikiService.listWikis(caller)).find((row) => row.wikiId === quiet.wiki.id) as Row).comments, undefined)
    assert.equal((await wikiService.readPage({ tenantId: tenant.id, connectorId: quiet.connector.id, path: 'flag.md', explicitWiki: true, reader: caller }))?.openComments, undefined)
    const overview = await consoleService.getOverview(admin, quiet.connector.id).catch((error) => error)
    assert.equal(overview.commentsEnabled, false)
    assert.equal(overview.openComments, 0)
    assert.equal(await statusOf(id), 'open', 'a komment megmarad')

    flagOn = true
    assert.equal(okResult(await service.listForAgent(caller, { wikiId: quiet.wiki.id })).openTotal, 1)
  })

  await check('a már elindult jóváhagyás kikapcsolt flagnél is lefut: a komment nem ragad be', async () => {
    const quiet = await mkWiki('Flag futó')
    const page = await seed(quiet, 'f.md')
    const caller = callerFor(quiet)
    const id = await add(operator, 'f.md', 'Komment', quiet)
    const outcome = (await writePage(caller, quiet, 'f.md', page.contentHash, [{ commentId: id, note: 'x' }])) as Row
    flagOn = false
    const applied = await wikiService.applyApproved(caller, outcome.request.changeSetId)
    flagOn = true
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(await statusOf(id), 'resolved')
  })

  await check('bejövő levél feldolgozása: komment nem zárható és nem idézhető forrásként', async () => {
    const quiet = await mkWiki('Levél')
    const page = await seed(quiet, 'l.md')
    const id = await add(admin, 'l.md', 'Komment', quiet)
    const mail = callerFor(quiet, 'approval', { forceWriteApproval: true })
    failCode(await writePage(mail, quiet, 'l.md', page.contentHash, [{ commentId: id, note: 'x' }]), 'invalid_comment_ref')
    failCode(await wikiService.write(mail, {
      wikiId: quiet.wiki.id,
      pages: [{ path: 'l.md', action: 'patch', baseVersion: page.contentHash, patch: [{ op: 'addSource', source: { kind: 'wiki_comment', commentId: id } as never }] }],
    }), 'invalid_comment_ref')
    assert.equal(await statusOf(id), 'open')
  })

  await check('resolvesComments többrészes írásnál az utolsó hívásba kerül', async () => {
    const quiet = await mkWiki('Részletek')
    const page = await seed(quiet, 'r.md')
    const id = await add(admin, 'r.md', 'Komment', quiet)
    const outcome = await wikiService.write(callerFor(quiet), {
      wikiId: quiet.wiki.id,
      final: false,
      pages: [{ path: 'r.md', action: 'upsert', type: 'entity', title: 'x', summary: 's', body: 'Új', baseVersion: page.contentHash, frontmatter: { sources: [{ documentId: quiet.documentId }] } }],
      resolvesComments: [{ commentId: id, note: 'x' }],
    })
    failCode(outcome, 'invalid_comment_ref')
    assert.equal(await statusOf(id), 'open')
  })

  await check('AC19–AC21: a szerző Teendői, a számláló pontosan a kérdés- és elutasítás-sorokat számolja', async () => {
    const quiet = await mkWiki('Teendők')
    await seed(quiet, 'todo.md')
    const caller = callerFor(quiet)
    const before = await service.countTodos(operator)
    const listedBefore = (await service.listTodos(operator)).filter((row) => row.connectorId === quiet.connector.id).length
    assert.equal(listedBefore, 0)
    const question = await add(operator, 'todo.md', 'K1', quiet)
    const declined = await add(operator, 'todo.md', 'K2', quiet)
    const resolved = await add(operator, 'todo.md', 'K3', quiet)
    const withdrawn = await add(operator, 'todo.md', 'K4', quiet)
    const stillOpen = await add(operator, 'todo.md', 'K5', quiet)
    okResult(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: question, action: 'ask', text: 'Melyik?' }))
    okResult(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: declined, action: 'decline', text: 'Nem módosítok.' }))
    okResult(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: resolved, action: 'already_done', text: 'Már jó.' }))
    await service.withdraw(operator, quiet.connector.id, withdrawn)

    assert.equal(await service.countTodos(operator), before + 2, 'kérdés + elutasítás; a kész nem számít')
    const rows = (await service.listTodos(operator)).filter((row) => row.connectorId === quiet.connector.id)
    assert.deepEqual(new Set(rows.map((row) => row.id)), new Set([question, declined, resolved]))
    assert.ok(!rows.some((row) => row.id === withdrawn || row.id === stillOpen))
    const row = rows.find((item) => item.id === declined)!
    assert.equal(row.wikiName, 'Teendők')
    assert.equal(row.path, 'todo.md')
    assert.equal(row.answer, 'Nem módosítok.')

    // Csak a szerző, csak az aktív szervezetből.
    assert.equal((await service.listTodos(operator2)).some((item) => item.connectorId === quiet.connector.id), false)
    assert.equal(await service.countTodos(operatorAbroad), 0)
    assert.equal((await service.listTodos(operatorAbroad)).length, 0)

    // AC19: a válasz után open, a sor eltűnik.
    await service.answer(operator, quiet.connector.id, question, 'A 2026-os.')
    assert.equal(await statusOf(question), 'open')
    assert.equal(await service.countTodos(operator), before + 1)

    // AC20: „Rendben” után eltűnik, az állapot nem változik; újranyitás + újabb lezárás után visszatér.
    await service.acknowledge(operator, { commentId: declined })
    assert.equal(await statusOf(declined), 'declined')
    assert.equal(await service.countTodos(operator), before)
    await service.reopen(operator, quiet.connector.id, declined, 'Nem értek egyet.')
    assert.equal((await prisma.wikiComment.findUniqueOrThrow({ where: { id: declined } })).authorSeenAt, null)
    okResult(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: declined, action: 'decline', text: 'Továbbra sem.' }))
    assert.equal(await service.countTodos(operator), before + 1)
    assert.ok((await service.listTodos(operator)).some((item) => item.id === declined))

    // „Mind rendben”: csak a kész sorok.
    await service.acknowledge(operator, { allResolved: true })
    const afterAll = (await service.listTodos(operator)).filter((item) => item.connectorId === quiet.connector.id)
    assert.deepEqual(afterAll.map((item) => item.id), [declined])

    // Másik szerző nem nyugtázhatja.
    assert.equal((await service.acknowledge(operator2, { commentId: declined })).acknowledged, 0)
  })

  await check('AC21: névsorról lekerült szerző nem látja, a számláló egyezik a sorokkal; archivált oldal kimarad', async () => {
    const list = await mkWiki('Névsoros Teendők', { visibility: 'members', ownerUserId: adminUser.id, kbMemberUserIds: [adminUser.id, secondOperator.id] })
    await seed(list, 'm.md')
    const caller = { ...callerFor(list), userId: adminUser.id }
    const id = await add(operator2, 'm.md', 'K', list)
    okResult(await service.respondAsAgent(caller, { wikiId: list.wiki.id, commentId: id, action: 'ask', text: 'Melyik?' }))
    const count = async () => service.countTodos(operator2)
    const rows = async () => (await service.listTodos(operator2)).filter((row) => row.status !== 'resolved')
    assert.equal(await count(), (await rows()).length)
    assert.ok((await rows()).some((row) => row.id === id))
    await prisma.connector.update({ where: { id: list.connector.id }, data: { kbMemberUserIds: [adminUser.id] } })
    assert.equal((await rows()).some((row) => row.id === id), false)
    assert.equal(await count(), (await rows()).length)
    await prisma.connector.update({ where: { id: list.connector.id }, data: { kbMemberUserIds: [adminUser.id, secondOperator.id] } })
    const page = (await wikis.findPage(list.connector.id, 'm.md'))!
    await prisma.wikiPage.update({ where: { id: page.id }, data: { status: 'archived' } })
    assert.equal((await rows()).some((row) => row.id === id), false)
    assert.equal(await count(), (await rows()).length)
  })

  await check('megőrzés (D11): a lezárt komment a closedAt-től számítva ürül; beállítás nélkül megmarad', async () => {
    const quiet = await mkWiki('Megőrzés')
    await seed(quiet, 'ret.md')
    const caller = callerFor(quiet)
    const old = await add(operator, 'ret.md', 'Régi', quiet)
    okResult(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: old, action: 'decline', text: 'Indok' }))
    const fresh = await add(operator, 'ret.md', 'Friss', quiet)
    okResult(await service.respondAsAgent(caller, { wikiId: quiet.wiki.id, commentId: fresh, action: 'decline', text: 'Indok' }))
    const alive = await add(operator, 'ret.md', 'Nyitott', quiet)
    const longAgo = new Date(Date.now() - 400 * 86_400_000)
    await prisma.wikiComment.update({ where: { id: old }, data: { closedAt: longAgo } })
    await prisma.wikiComment.update({ where: { id: alive }, data: { createdAt: longAgo } })

    // Az alapérték 365 nap; „nincs beállítva” = üres.
    await prisma.agentWiki.update({ where: { id: quiet.wiki.id }, data: { retentionDeleteDays: null } })
    await historyService.sweepRetention()
    assert.ok((await prisma.wikiComment.findUniqueOrThrow({ where: { id: old } })).body, 'beállítás nélkül megmarad')

    await prisma.agentWiki.update({ where: { id: quiet.wiki.id }, data: { retentionDeleteDays: 365 } })
    const totals = await historyService.sweepRetention()
    assert.ok(totals.commentsErased >= 1)
    const oldRow = await prisma.wikiComment.findUniqueOrThrow({ where: { id: old }, include: { events: true } })
    assert.equal(oldRow.body, '')
    assert.ok(oldRow.erasedAt)
    assert.ok(oldRow.events.every((event) => event.body === null))
    assert.equal((await prisma.wikiComment.findUniqueOrThrow({ where: { id: fresh } })).body, 'Friss')
    assert.equal((await prisma.wikiComment.findUniqueOrThrow({ where: { id: alive } })).body, 'Nyitott', 'a nyitott komment nem évül el')
  })

  await check('láthatóság-előnézet és privát wiki végleges törlése: a kommentek száma', async () => {
    const quiet = await mkWiki('Láthatóság')
    await seed(quiet, 'v.md')
    await add(operator, 'v.md', 'K', quiet)
    const preview = await consoleService.previewVisibilityChange(admin, quiet.connector.id, 'private')
    assert.equal(preview.comments, 1)

    const priv = await mkWiki('Törlendő', { visibility: 'private_to_user', ownerUserId: operatorUser.id })
    await seed(priv, 'p.md')
    await add(operator, 'p.md', 'K', priv)
    const counts = await new PostgresPrivateKnowledgeBaseStore().purge(priv.connector.id)
    assert.equal(counts.comments, 1)
    assert.equal(await prisma.wikiComment.count({ where: { connectorId: priv.connector.id } }), 0)
  })

  await check('jóváhagyó kártya: a kérő kommentek a szerzővel és a teljes szöveggel; a gateway-argumentumban csak azonosító', async () => {
    const page = await seed(main, 'review.md')
    const id = await add(operator, 'review.md', 'A jutalék 3%.', main, 'a jutalék 2%')
    const outcome = (await writePage(direct, main, 'review.md', page.contentHash, [{ commentId: id, note: 'Átírtam.' }])) as Row
    assert.equal(outcome.ok, 'approval')
    assert.doesNotMatch(JSON.stringify(outcome.request), /A jutalék 3%/)
    const listed = await comments.listForChangeSet(main.connector.id, outcome.request.changeSetId)
    assert.deepEqual(listed.map((row) => row.id), [id])
    const review = await consoleService.getChangeSetReview(admin, outcome.request.changeSetId)
    assert.equal(review.comments.length, 1)
    assert.equal(review.comments[0].authorName, 'Kovács Anna')
    assert.equal(review.comments[0].body, 'A jutalék 3%.')
    assert.equal(review.comments[0].quote, 'a jutalék 2%')
    assert.equal(review.comments[0].note, 'Átírtam.')
    const changes = await wikiService.applyApproved(direct, outcome.request.changeSetId)
    assert.equal(changes.ok, true)
    const seq = (changes as Row).result.seq
    const row = okResult(await wikiService.changes(direct, { wikiId: main.wiki.id, since: seq - 1, limit: 1, markSeen: false })).changes[0]
    assert.equal(row.resolvedComments, 1)
  })

  await prisma.$disconnect()
  console.log(`\n${failures === 0 ? 'wiki-comments-db: ok' : `wiki-comments-db: ${failures} failed`}`)
  if (failures > 0) process.exit(1)
}

void main()
