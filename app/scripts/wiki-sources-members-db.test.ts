/**
 * #1061 F2 — források és „csak a kijelöltek” tudástár valódi Postgresen (migrált séma):
 * - AC6: emberi rögzítés (`human_note`) — a szerző a munkamenet embere; háttérfutásból
 *   `human_note_requires_session`, és semmi nem íródik;
 * - AC7: közönség-szabály — közös wiki nem idézhet névsorosból, fordítva igen (forrás és link);
 * - AC8: névsoros wikihez kötött agent nem-tag emberrel `not_found`-ot kap;
 * - AC9: a kapcsolt wiki menüpontja nem-tagnak nem látszik, az `index.md`-be nem kerül;
 * - AC10: tagság elvétele után a korábban idézett forrás „nincs hozzáférésed” címkét kap;
 * - D9: admin csak tagként látja; önfelvétele külön auditált esemény; a névsor az audit-
 *   katalóguson és a payload-őrön is átmegy (NFR-3).
 * Futtatás: DATABASE_URL=… npm run test:wiki-sources-members-db (CI: migrations job).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Connector } from '@prisma/client'
import { prisma } from '../src/lib/db'
import { PostgresWikiRepository, PostgresWikiStructureRepository } from '../src/repositories/postgres/wiki-repository'
import { PostgresWikiHistoryRepository } from '../src/repositories/postgres/wiki-history-repository'
import { PostgresAuditRepository } from '../src/repositories/postgres/audit-repository'
import { PostgresConnectorRepository } from '../src/repositories/postgres/connector-repository'
import { PostgresAgentRepository } from '../src/repositories/postgres/agent-repository'
import { PostgresDocumentRepository } from '../src/repositories/postgres/knowledge-repository'
import { PostgresWikiConsoleRepository } from '../src/repositories/postgres/wiki-console-repository'
import { WikiService, type WikiCaller } from '../src/domain/knowledge-base/wiki-service'
import { WikiConsoleError, WikiConsoleService, type WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import { WikiHistoryService } from '../src/domain/knowledge-base/wiki-history-service'
import { WikiCategoryService } from '../src/domain/knowledge-base/wiki-category-service'
import { authorizeToolCall } from '../src/domain/enterprise-tools/authorize-tool-call'
import { withLiveKbAudience, type WikiSnapshotConnector } from '../src/lib/wiki-access'

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
  await assert.rejects(fn, (error: unknown) => error instanceof WikiConsoleError && error.code === code)
}

const wikis = new PostgresWikiRepository()
const structure = new PostgresWikiStructureRepository()
const audit = new PostgresAuditRepository()
const connectors = new PostgresConnectorRepository()
const documents = new PostgresDocumentRepository()

async function main() {
  console.log('=== #1061 F2 források + névsoros wiki (Postgres) ===')
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  if (host !== '127.0.0.1' && host !== 'localhost') {
    console.log(`  SKIP: nem helyi DB (${host}) — ez a teszt csak eldobható Postgresen fut`)
    process.exit(1)
  }
  const tenant = await prisma.tenant.create({ data: { slug: `wiki1061f2-${randomUUID().slice(0, 8)}`, displayName: 'F2 teszt' } })
  const mkUser = async (name: string, role: 'admin' | 'operator') => {
    const user = await prisma.user.create({ data: { externalAuthId: `test_${randomUUID()}`, email: `${randomUUID()}@example.test`, name } })
    await prisma.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role, status: 'active' } })
    return user
  }
  const admin = await mkUser('Admin Anna', 'admin')
  const admin2 = await mkUser('Admin Béla', 'admin')
  const alice = await mkUser('Alice', 'operator')
  const bob = await mkUser('Bob', 'operator')
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Wiki-agent', roleInstruction: 'x' } })

  const mkKb = async (displayName: string) => {
    const connector = (await prisma.connector.create({
      data: {
        tenantId: tenant.id,
        type: 'knowledge_base',
        name: `kb:shared:${randomUUID()}`,
        authMode: 'agent_owned',
        scope: 'single',
        config: { displayName },
      },
    })) as Connector
    const wiki = await wikis.ensureForConnector({ connectorId: connector.id, schemaMd: '# WIKI' })
    const doc = await prisma.document.create({
      data: { tenantId: tenant.id, connectorId: connector.id, uploadedById: admin.id, filename: `${displayName}.pdf`, extractedText: 'x', status: 'processed' },
    })
    return { connector, wiki, doc }
  }
  const S = await mkKb('Közös')
  const M = await mkKb('Szerződések')
  const M2 = await mkKb('Árazás')

  const wikiService = new WikiService({
    wikis,
    structure,
    history: new PostgresWikiHistoryRepository(),
    documents,
    connectors,
    agents: new PostgresAgentRepository(),
    knowledgeBase: { ingest: async () => { throw new Error('not used') }, getDocument: async () => { throw new Error('not used') } } as never,
    audit,
    findUserLabel: async () => null,
  })
  const consoleService = new WikiConsoleService({
    documents,
    connectors,
    agents: new PostgresAgentRepository(),
    wikis,
    console: new PostgresWikiConsoleRepository(),
    wiki: wikiService,
    wikiAccess: {} as never,
    knowledgeBase: {} as never,
    audit,
  })
  const historyService = new WikiHistoryService({
    history: new PostgresWikiHistoryRepository(), wikis, connectors,
    console: new PostgresWikiConsoleRepository(), wikiConsole: consoleService, wiki: wikiService, audit,
  })
  const categories = new WikiCategoryService({ wikiConsole: consoleService, wiki: wikiService, wikis, structure, audit })
  const actor = (user: { id: string }, role: 'admin' | 'operator'): WikiConsoleActor => ({ userId: user.id, tenantId: tenant.id, role })
  const asAdmin = actor(admin, 'admin')
  const asAdmin2 = actor(admin2, 'admin')
  const asAlice = actor(alice, 'operator')
  const asBob = actor(bob, 'operator')

  // A publikált snapshot mintája: a névsor nincs benne, betöltéskor az élő sorból jön (agent-definition).
  const binding = (connector: Connector, writeMode: 'direct' | 'approval' = 'direct'): WikiSnapshotConnector => ({
    connectorId: connector.id,
    type: 'knowledge_base',
    accessMode: 'write',
    wikiAccess: 'write',
    wikiWriteMode: writeMode,
    ...(connector.visibility === 'members' ? { visibility: 'members' as const, ownerUserId: connector.ownerUserId! } : {}),
  })
  const snapshot = async (writeModes: Partial<Record<string, 'direct' | 'approval'>> = {}) => {
    const live = await Promise.all([S, M, M2].map(({ connector }) => connectors.findById(connector.id, tenant.id)))
    const rows = live.filter((row): row is Connector => !!row)
    return { connectors: withLiveKbAudience(rows.map((row) => binding(row, writeModes[row.id])), rows) }
  }
  const caller = async (user: { id: string }, extra: Partial<WikiCaller> = {}): Promise<WikiCaller> => ({
    tenantId: tenant.id,
    userId: user.id,
    agentId: agent.id,
    snapshot: await snapshot(),
    interactive: true,
    ...extra,
  })
  const upsert = (path: string, body: string, sources: unknown[], extra: Record<string, unknown> = {}) => ({
    path,
    action: 'upsert' as const,
    type: 'entity' as const,
    title: path,
    summary: 'összefoglaló',
    body,
    frontmatter: { sources },
    ...extra,
  })

  // Függő change-set a még közös M-ben (jóváhagyós kötéssel) — a váltás el fogja utasítani.
  let pendingId = ''
  await check('előkészítés: függő change-set a közös wikiben', async () => {
    const result = await wikiService.write(
      { ...(await caller(alice)), snapshot: await snapshot({ [M.connector.id]: 'approval' }) },
      { wikiId: M.wiki.id, pages: [upsert('contracts/draft.md', 'Tervezet', [{ documentId: M.doc.id }])] },
    )
    assert.equal(result.ok, 'approval', JSON.stringify(result))
    pendingId = (result as { request: { changeSetId: string } }).request.changeSetId
  })

  await check('NFR-1 előnézet: közös → csak a kijelöltek — ki veszti el a hozzáférést', async () => {
    const preview = await consoleService.previewVisibilityChange(asAdmin, M.connector.id, 'members')
    assert.equal(preview.losingAccess.count, 3, JSON.stringify(preview))
    assert.deepEqual([...preview.losingAccess.sample].sort(), ['Admin Béla', 'Alice', 'Bob'])
    assert.equal(preview.rejectedChangeSets, 1)
    await rejectsWith('forbidden', () => consoleService.previewVisibilityChange(asAlice, M.connector.id, 'members'))
  })

  await check('váltás csak a kijelöltekre: a váltó admin a tulajdonos és az első tag; a függő módosítás elutasul', async () => {
    const result = await consoleService.changeVisibility(asAdmin, M.connector.id, 'members')
    assert.deepEqual(result, { visibility: 'members', rejectedChangeSets: 1 })
    const live = (await connectors.findById(M.connector.id, tenant.id))!
    assert.equal(live.visibility, 'members')
    assert.equal(live.ownerUserId, admin.id)
    assert.deepEqual(live.kbMemberUserIds, [admin.id])
    assert.match(live.name, /^kb:members:/)
    assert.equal((await wikis.findChangeSet(pendingId))!.status, 'rejected')
    await consoleService.changeVisibility(asAdmin, M2.connector.id, 'members')
  })

  await check('névsor: a tulajdonos felveszi Alice-t; nem-tag operátornak a wiki nem létezik', async () => {
    assert.deepEqual(await consoleService.addMember(asAdmin, M.connector.id, alice.id), { added: true })
    assert.deepEqual(await consoleService.addMember(asAdmin, M2.connector.id, alice.id), { added: true })
    await rejectsWith('not_found', () => consoleService.addMember(asBob, M.connector.id, bob.id))
    await rejectsWith('not_found', () => consoleService.getOverview(asBob, M.connector.id))
    await rejectsWith('invalid_args', () => consoleService.removeMember(asAdmin, M.connector.id, admin.id))
    const view = await consoleService.getMembers(asAdmin, M.connector.id)
    assert.deepEqual(view.members.map((row) => [row.label, row.owner]), [['Admin Anna', true], ['Alice', false]])
    assert.ok(view.candidates.some((row) => row.label === 'Bob'))
  })

  await check('D9: nem-tag admin csak metaadatot lát; önmagát felveheti, külön auditált eseménnyel', async () => {
    await rejectsWith('not_found', () => consoleService.getOverview(asAdmin2, M.connector.id))
    const listed = (await consoleService.listKnowledgeBases(asAdmin2)).find((row) => row.connectorId === M.connector.id)!
    assert.equal(listed.metadataOnly, true)
    assert.equal(listed.kind, 'members')
    await consoleService.addMember(asAdmin2, M.connector.id, admin2.id)
    assert.equal((await consoleService.getOverview(asAdmin2, M.connector.id)).kind, 'members')
    await consoleService.removeMember(asAdmin2, M.connector.id, admin2.id)
    await rejectsWith('not_found', () => consoleService.getOverview(asAdmin2, M.connector.id))
    const rows = await prisma.auditLog.findMany({ where: { tenantId: tenant.id, action: { startsWith: 'kb.members.' } } })
    const actions = rows.map((row) => row.action)
    for (const action of ['kb.members.added', 'kb.members.self_added', 'kb.members.removed']) {
      assert.ok(actions.includes(action), `${action} hiányzik: ${actions.join(', ')}`)
    }
    // NFR-3: azonosító igen, név nem.
    assert.ok(!JSON.stringify(rows.map((row) => row.metadata)).includes('Alice'))
    assert.ok(rows.every((row) => (row.metadata as { membersKb?: boolean }).membersKb === true))
  })

  await check('AC8: névsoros wikihez kötött agent nem-tag emberrel not_found-ot kap (wiki-eszközök)', async () => {
    const bobCaller = await caller(bob)
    assert.ok(!(await wikiService.listWikis(bobCaller)).some((row) => row.connectorId === M.connector.id))
    assert.equal((await wikiService.changes(bobCaller, { wikiId: M.wiki.id })).ok, false)
    assert.deepEqual(await wikiService.changes(bobCaller, { wikiId: M.wiki.id }), { ok: false, code: 'not_found' })
    const write = await wikiService.write(bobCaller, { wikiId: M.wiki.id, pages: [upsert('x.md', 'x', [{ documentId: M.doc.id }])] })
    assert.deepEqual(write, { ok: false, code: 'not_found' })
    // Tag: látja (a névsor az élő sorból jön, nem a snapshotból).
    const aliceCaller = await caller(alice)
    const listed = (await wikiService.listWikis(aliceCaller)).find((row) => row.connectorId === M.connector.id)
    assert.equal(listed?.membersOnly, true)
  })

  await check('AC8: kb_search / kb_get_page / kb_list_index / kb_get_document — nem-tag not_found, tag engedélyezett', async () => {
    const definition = async () => ({
      definitionId: randomUUID(),
      agentId: agent.id,
      snapshot: {
        ...(await snapshot()),
        capabilities: ['kb_search', 'kb_get_page', 'kb_list_index', 'kb_get_document'].map((toolName) => ({ toolName, allowed: true })),
      },
    })
    const deps = { findConnector: (id: string) => connectors.findById(id), findActiveGrant: async () => null } as never
    for (const toolName of ['kb_search', 'kb_get_page', 'kb_list_index', 'kb_get_document']) {
      const args = { connectorId: M.connector.id, query: 'x', path: 'index.md', documentId: M.doc.id }
      const denied = await authorizeToolCall(deps, {
        principal: { userId: bob.id, tenantId: tenant.id, role: 'operator', assumed: false },
        definition: (await definition()) as never,
        toolName,
        args,
      })
      assert.deepEqual(denied, { allowed: false, reason: 'not_found' }, `${toolName}: ${JSON.stringify(denied)}`)
      const allowed = await authorizeToolCall(deps, {
        principal: { userId: alice.id, tenantId: tenant.id, role: 'operator', assumed: false },
        definition: (await definition()) as never,
        toolName,
        args,
      })
      assert.equal(allowed.allowed, true, `${toolName}: ${JSON.stringify(allowed)}`)
    }
    // Élesítés előtti (régi, közös) snapshot-sor: az élő sor dönt.
    const stale = await definition()
    stale.snapshot.connectors = stale.snapshot.connectors.map((row) =>
      row.connectorId === M.connector.id ? { ...row, visibility: undefined, ownerUserId: undefined, kbMemberUserIds: undefined } : row,
    )
    const staleDenied = await authorizeToolCall(deps, {
      principal: { userId: bob.id, tenantId: tenant.id, role: 'operator', assumed: false },
      definition: stale as never,
      toolName: 'kb_search',
      args: { connectorId: M.connector.id, query: 'x' },
    })
    assert.deepEqual(staleDenied, { allowed: false, reason: 'not_found' })
  })

  await check('AC6: emberi rögzítés — a szerző a munkamenet embere, nem az argumentum', async () => {
    const result = await wikiService.write(await caller(alice), {
      wikiId: S.wiki.id,
      pages: [
        upsert('decisions/pricing.md', 'Döntés: 2% kedvezmény.', [
          { kind: 'human_note', occasion: '2026-11-03 sales-megbeszélés', participants: 'Alice, Bob', recordedByUserId: bob.id, recordedAt: '2020-01-01' },
        ]),
      ],
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    const page = (await wikis.findPage(S.connector.id, 'decisions/pricing.md'))!
    const [ref] = page.sourceRefs as Array<Record<string, unknown>>
    assert.equal(ref.kind, 'human_note')
    assert.equal(ref.recordedByUserId, alice.id)
    assert.notEqual(ref.recordedAt, '2020-01-01')
    assert.equal(ref.occasion, '2026-11-03 sales-megbeszélés')
    const view = await consoleService.getPage(asAlice, S.connector.id, 'decisions/pricing.md')
    assert.deepEqual(
      { ...view.sources[0], recordedAt: undefined },
      { kind: 'human_note', recordedBy: 'Alice', recordedAt: undefined, occasion: '2026-11-03 sales-megbeszélés', participants: 'Alice, Bob' },
    )
  })

  await check('AC6: háttérfutásból human_note_requires_session, semmi nem íródik; meglévő rögzítés változatlanul maradhat', async () => {
    const background = await caller(alice, { interactive: false })
    const result = await wikiService.write(background, {
      wikiId: S.wiki.id,
      pages: [upsert('decisions/other.md', 'Kitalált döntés', [{ kind: 'human_note', occasion: 'megbeszélés' }])],
    })
    assert.equal(result.ok, false)
    assert.equal((result as { code: string }).code, 'human_note_requires_session')
    assert.equal(await wikis.findPage(S.connector.id, 'decisions/other.md'), null)
    // A meglévő oldal változatlan rögzítéssel frissíthető (nem kell hozzá új munkamenet).
    const existing = (await wikis.findPage(S.connector.id, 'decisions/pricing.md'))!
    const kept = await wikiService.write(background, {
      wikiId: S.wiki.id,
      pages: [upsert('decisions/pricing.md', 'Döntés: 2% kedvezmény, 2027-ig.', existing.sourceRefs as unknown[], { baseVersion: existing.contentHash })],
    })
    assert.equal(kept.ok, true, JSON.stringify(kept))
    // Új rögzítés patch-csel sem jöhet háttérből.
    const patched = await wikiService.write(background, {
      wikiId: S.wiki.id,
      pages: [{ path: 'decisions/pricing.md', action: 'patch', patch: [{ op: 'addSource', source: { kind: 'human_note', occasion: 'másik' } as never }] }],
    })
    assert.equal((patched as { code?: string }).code, 'human_note_requires_session')
  })

  await check('AC7: közös wiki nem idézhet névsorosból (forrás és link); fordítva igen', async () => {
    const fromShared = await wikiService.write(await caller(alice), {
      wikiId: S.wiki.id,
      pages: [upsert('partners/acme.md', 'ACME', [{ documentId: M.doc.id, connectorId: M.connector.id }])],
    })
    assert.equal(fromShared.ok, false)
    const codes = ((fromShared as { details: { errors: Array<{ code: string }> } }).details.errors).map((row) => row.code)
    assert.deepEqual(codes, ['source_audience_narrower'])
    const linkFromShared = await wikiService.write(await caller(alice), {
      wikiId: S.wiki.id,
      pages: [upsert('partners/acme.md', `Lásd [[wiki:${M.wiki.id}/contracts/acme]]`, [{ documentId: S.doc.id }])],
    })
    assert.deepEqual(
      ((linkFromShared as { details: { errors: Array<{ code: string }> } }).details.errors).map((row) => row.code),
      ['source_audience_narrower'],
    )
    const fromMembers = await wikiService.write(await caller(alice), {
      wikiId: M.wiki.id,
      pages: [
        upsert('contracts/acme.md', 'Szerződés, lásd [[wiki:' + S.wiki.id + '/decisions/pricing]]', [
          { documentId: S.doc.id, connectorId: S.connector.id },
          { documentId: M2.doc.id, connectorId: M2.connector.id },
        ]),
      ],
    })
    assert.equal(fromMembers.ok, true, JSON.stringify(fromMembers))
    const page = (await wikis.findPage(M.connector.id, 'contracts/acme.md'))!
    assert.ok(page.outLinks.includes(`wiki:${S.wiki.id}/decisions/pricing.md`))
  })

  await check('nem olvasható másik tudástár: unknown_source (nem árulja el, hogy létezik)', async () => {
    const bobWrite = await wikiService.write(await caller(bob), {
      wikiId: S.wiki.id,
      pages: [upsert('partners/x.md', 'X', [{ documentId: M.doc.id, connectorId: M.connector.id }])],
    })
    assert.deepEqual(
      ((bobWrite as { details: { errors: Array<{ code: string }> } }).details.errors).map((row) => row.code),
      ['unknown_source'],
    )
  })

  await check('más wikiből jövő visszahivatkozás csak annak látszik, aki azt a wikit is látja', async () => {
    const forAlice = await wikiService.crossBacklinksFor(await caller(alice), S.wiki.id, 'decisions/pricing.md')
    assert.deepEqual(forAlice.map((row) => row.path), ['contracts/acme.md'])
    assert.deepEqual(await wikiService.crossBacklinksFor(await caller(bob), S.wiki.id, 'decisions/pricing.md'), [])
    assert.equal((await consoleService.getPage(asAlice, S.connector.id, 'decisions/pricing.md')).crossBacklinks.length, 1)
    assert.equal((await consoleService.getPage(asBob, S.connector.id, 'decisions/pricing.md')).crossBacklinks.length, 0)
  })

  await check('AC10: tagság elvétele után az idézett forrás „nincs hozzáférésed” címkét kap, tartalom nélkül', async () => {
    const previous = (await wikis.findPage(M.connector.id, 'contracts/acme.md'))!
    const updated = await wikiService.write(await caller(alice), {
      wikiId: M.wiki.id,
      pages: [upsert(previous.path, previous.body, [
        { documentId: S.doc.id, connectorId: S.connector.id },
        { documentId: M2.doc.id, connectorId: M2.connector.id, filename: 'restricted-filename.pdf' },
      ], { baseVersion: previous.contentHash })],
    })
    assert.equal(updated.ok, true, JSON.stringify(updated))
    await consoleService.removeMember(asAdmin, M2.connector.id, alice.id)
    const view = await consoleService.getPage(asAlice, M.connector.id, 'contracts/acme.md')
    assert.deepEqual(view.sources.map((row) => row.kind), ['document', 'restricted'])
    assert.ok(!JSON.stringify(view.sources).includes(M2.doc.id))
    const read = await wikiService.readPage({
      tenantId: tenant.id,
      connectorId: M.connector.id,
      path: 'contracts/acme.md',
      explicitWiki: true,
      reader: await caller(alice),
    })
    assert.deepEqual((read!.sources as Array<{ kind?: string }>).map((row) => row.kind ?? 'document'), ['document', 'restricted'])
    assert.ok(!String(read!.text).includes(M2.doc.id))
    const page = (await wikis.findPage(M.connector.id, 'contracts/acme.md'))!
    const seq = await new PostgresWikiHistoryRepository().latestSeq(M.wiki.id)
    const outputs = [
      await wikiService.readPage({ tenantId: tenant.id, connectorId: M.connector.id, path: page.path, explicitWiki: true, asOf: seq, reader: await caller(alice) }),
      await historyService.getRevision(asAlice, M.connector.id, page.path, page.version),
      await historyService.getPageAt(asAlice, M.connector.id, page.path, String(seq)),
      await historyService.diffRevisions(asAlice, M.connector.id, page.path, previous.version, page.version),
      await historyService.getChangeSet(asAlice, M.connector.id, seq),
    ]
    for (const output of outputs) {
      assert.ok(!JSON.stringify(output).includes(M2.doc.id), JSON.stringify(output))
      assert.ok(!JSON.stringify(output).includes('restricted-filename.pdf'), JSON.stringify(output))
    }
    const exported = await consoleService.exportZip({ ...asAlice, role: 'admin' }, M.connector.id)
    assert.ok(!new TextDecoder().decode(exported.bytes).includes(M2.doc.id))
    // A tulajdonos (még tag) látja.
    const ownerView = await consoleService.getPage(asAdmin, M.connector.id, 'contracts/acme.md')
    assert.deepEqual(ownerView.sources.map((row) => row.kind), ['document', 'document'])
  })

  await check('AC9: a kapcsolt wiki menüpontja nem-tagnak nem látszik; az index.md-be nem kerül', async () => {
    await categories.enable(asAdmin, S.connector.id)
    await categories.create(asAdmin, S.connector.id, { key: 'decisions', name: 'Döntések' })
    await categories.create(asAdmin, S.connector.id, { key: 'contracts-link', name: 'Szerződések', linkedConnectorId: M.connector.id })
    assert.deepEqual((await consoleService.getOverview(asAdmin, S.connector.id)).linkedWikis.map((row) => row.connectorId), [M.connector.id])
    assert.deepEqual((await consoleService.getOverview(asAlice, S.connector.id)).linkedWikis.length, 1)
    assert.deepEqual((await consoleService.getOverview(asBob, S.connector.id)).linkedWikis, [])
    const index = await wikiService.readPage({ tenantId: tenant.id, connectorId: S.connector.id, path: 'index.md', explicitWiki: true })
    assert.ok(!String(index!.text).includes('Szerződések') && !String(index!.text).includes('contracts-link'), String(index!.text))
    // Oldal nem kerülhet a kapcsolt menüpontba.
    const write = await wikiService.write(await caller(alice), {
      wikiId: S.wiki.id,
      pages: [upsert('x/y.md', 'y', [{ documentId: S.doc.id }], { category: 'contracts-link' })],
    })
    assert.equal(((write as { details: { errors: Array<{ code: string }> } }).details.errors)[0].code, 'unknown_category')
    // Nem látott wikire nem lehet menüpontot tenni (Bob-nak nem létezik).
    const view = await categories.get(asAdmin, S.connector.id)
    assert.equal(view.linkedWikis[0].targetVisible, true)
  })

  await check('döntés a névsoros wiki change-setjéről: csak élő tag (az admin is csak tagként)', async () => {
    const result = await wikiService.write(
      { ...(await caller(alice)), snapshot: await snapshot({ [M.connector.id]: 'approval' }) },
      { wikiId: M.wiki.id, pages: [upsert('contracts/new.md', 'Új', [{ documentId: M.doc.id }])] },
    )
    assert.equal(result.ok, 'approval', JSON.stringify(result))
    const changeSetId = (result as { request: { changeSetId: string; pages?: unknown } }).request.changeSetId
    // A gateway-kártyára path nem kerül (admin is látja a kártyák listáját).
    assert.equal((result as { request: { pages?: unknown } }).request.pages, undefined)
    assert.equal(await wikiService.canDecide({ userId: admin.id, role: 'admin', tenantId: tenant.id }, changeSetId), true)
    assert.equal(await wikiService.canDecide({ userId: admin2.id, role: 'admin', tenantId: tenant.id }, changeSetId), false)
    assert.equal(await wikiService.canDecide({ userId: alice.id, role: 'operator', tenantId: tenant.id }, changeSetId), false)
  })

  await check('vissza közösre: a névsor kiürül, mindenki látja', async () => {
    await consoleService.changeVisibility(asAdmin, M.connector.id, 'shared')
    const live = (await connectors.findById(M.connector.id, tenant.id))!
    assert.equal(live.visibility, 'shared')
    assert.deepEqual(live.kbMemberUserIds, [])
    assert.equal((await consoleService.getOverview(asBob, M.connector.id)).kind, 'shared')
  })

  await check('stale roster update cannot restore a removed member', async () => {
    const before = (await connectors.findById(M2.connector.id, tenant.id))!
    await consoleService.addMember(asAdmin, M2.connector.id, alice.id)
    const stale = (await connectors.findById(M2.connector.id, tenant.id))!
    await consoleService.removeMember(asAdmin, M2.connector.id, alice.id)
    await assert.rejects(() => connectors.updateKnowledgeBase(M2.connector.id, {
      expectedMemberUserIds: stale.kbMemberUserIds, kbMemberUserIds: [...stale.kbMemberUserIds, bob.id],
    }))
    assert.deepEqual((await connectors.findById(M2.connector.id, tenant.id))!.kbMemberUserIds, before.kbMemberUserIds)
  })
  await check('[[path\\|címke]] táblában: nincs broken_link, a céloldalon backlink, a címke nélküli link felirata a cím', async () => {
    const cited = [{ documentId: S.doc.id }]
    const target = await wikiService.write(await caller(admin), {
      wikiId: S.wiki.id, pages: [upsert('entities/link-target.md', 'cél', cited, { title: 'Link cél' })],
    })
    assert.equal(target.ok, true, JSON.stringify(target))
    const written = await wikiService.write(await caller(admin), {
      wikiId: S.wiki.id,
      pages: [upsert('analyses/link-table.md', '| a |\n|---|\n| [[entities/link-target.md\\|Saját címke]] |', cited)],
    })
    assert.equal(written.ok, true, JSON.stringify(written))
    assert.ok(!JSON.stringify(written).includes('broken_link'), JSON.stringify(written))
    const backlinks = await wikiService.backlinks(S.connector.id, 'entities/link-target.md')
    assert.deepEqual(backlinks!.pages.map((page) => page.path), ['analyses/link-table.md'])

    const titled = await wikiService.write(await caller(admin), {
      wikiId: S.wiki.id, pages: [upsert('analyses/link-plain.md', '[[entities/link-target]]', cited)],
    })
    assert.equal(titled.ok, true, JSON.stringify(titled))
    const view = await consoleService.getPage(asAlice, S.connector.id, 'analyses/link-plain.md')
    assert.deepEqual(view.linkTitles, { 'entities/link-target.md': 'Link cél' })
  })
  await check('0057: a korábban hibásan tárolt kimenő link helyes alakra áll, a jó érintetlen, újrafuttatva is', async () => {
    const stored = ['entities/a.md\\.md', 'entities/b\\.md', 'entities/c.md', `wiki:${M.wiki.id}/x.md\\.md`]
    const page = (await wikis.findPage(S.connector.id, 'analyses/link-table.md'))!
    await prisma.wikiPage.update({ where: { id: page.id }, data: { outLinks: stored } })
    const sql = readFileSync('prisma/migrations/0057_wiki_out_links_escaped_pipe/migration.sql', 'utf8')
    await prisma.$executeRawUnsafe(sql)
    await prisma.$executeRawUnsafe(sql)
    const after = (await prisma.wikiPage.findUnique({ where: { id: page.id } }))!
    assert.deepEqual([...after.outLinks].sort(), ['entities/a.md', 'entities/b.md', 'entities/c.md', `wiki:${M.wiki.id}/x.md`].sort())
    assert.equal(after.version, page.version)
    assert.equal(after.contentHash, page.contentHash)
  })
  await check('agent audience also covers published and pinned definitions', async () => {
    const version = await prisma.agentDefinitionVersion.create({ data: {
      agentId: agent.id, version: 1, publishedById: admin.id, contentHash: 'test',
      snapshot: { connectors: [binding(M.connector)] },
    } })
    assert.equal(await connectors.agentAudienceCovers(tenant.id, S.connector.id, M.connector.id), false)
    const result = await wikiService.write(await caller(admin), {
      wikiId: M.wiki.id, pages: [upsert('contracts/agent-audience.md', 'x', [{ documentId: S.doc.id, connectorId: S.connector.id }])],
    })
    assert.ok(JSON.stringify(result).includes('source_audience_narrower'), JSON.stringify(result))
    await prisma.agentDefinitionVersion.update({ where: { id: version.id }, data: { snapshot: { connectors: [binding(M.connector), binding(S.connector)] } } })
    assert.equal(await connectors.agentAudienceCovers(tenant.id, S.connector.id, M.connector.id), true)
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
