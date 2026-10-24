/**
 * #946 LLM Wiki 5/6: a Control Plane wiki-nézetének szabályai (`WikiConsoleService`).
 * Minden server action ezen a service-en megy át, ezért a jogosultsági
 * esetek itt actiononként szerepelnek. In-memory fake-ekkel, DB nélkül.
 * Futtatás: npm run test:wiki-console
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a fake-ek szándékosan laza alakúak */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import type { Connector, WikiPage } from '@prisma/client'
import { WikiConsoleError, WikiConsoleService, type WikiConsoleActor } from '../src/domain/knowledge-base/wiki-console-service'
import type { WikiConsoleKbRow, WikiConsoleRepository } from '../src/repositories/postgres/wiki-console-repository'
import { readZipEntries } from '../src/lib/skill/zip-reader'
import { collapseUnchanged, diffLines } from '../src/lib/text-line-diff'
import { linkifyWikiLinks } from '../src/lib/wiki-markdown-links'

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = '11111111-1111-4111-8111-111111111111'
const ADMIN = '22222222-2222-4222-8222-222222222222'
const OPERATOR = '33333333-3333-4333-8333-333333333333'
const VIEWER = '44444444-4444-4444-8444-444444444444'
const AGENT = '55555555-5555-4555-8555-555555555555'
const KB_PRIV = '66666666-6666-4666-8666-666666666666'
const KB_SHARED = '77777777-7777-4777-8777-777777777777'
const KB_OTHER_PRIV = '88888888-8888-4888-8888-888888888888'
const DOC = '99999999-9999-4999-8999-999999999999'
const BATCH = 'b0000000-0000-4000-8000-00000000000b'
const CHANGESET = 'c0000000-0000-4000-8000-00000000000c'

const owner: WikiConsoleActor = { userId: OWNER, tenantId: TENANT, role: 'operator' }
const admin: WikiConsoleActor = { userId: ADMIN, tenantId: TENANT, role: 'admin' }
const operator: WikiConsoleActor = { userId: OPERATOR, tenantId: TENANT, role: 'operator' }
const viewer: WikiConsoleActor = { userId: VIEWER, tenantId: TENANT, role: 'viewer' }

let failures = 0
async function check(name: string, fn: () => void | Promise<void>) {
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

function connector(id: string, extra: Partial<Connector>): Connector {
  return {
    id,
    tenantId: TENANT,
    type: 'knowledge_base',
    name: `kb:shared:${id}`,
    authMode: 'agent_owned',
    scope: 'single',
    config: {},
    lifecycleState: 'active',
    visibility: 'shared',
    ownerUserId: null,
    kbLanguage: 'hu',
    ...extra,
  } as Connector
}

function page(path: string, extra: Partial<WikiPage> = {}): WikiPage {
  return {
    id: `p-${path}`,
    wikiId: 'wiki-1',
    connectorId: KB_PRIV,
    path,
    type: 'entity',
    title: path.replace(/\.md$/, ''),
    summary: 'egy sor',
    category: 'Labor',
    frontmatter: {},
    body: '## Tények\n\nHbA1c 6,1 %',
    sourceRefs: [{ documentId: DOC, page: 2 }],
    outLinks: [],
    status: 'published',
    version: 1,
    contentHash: 'h',
    createdByAgentId: AGENT,
    createdByUserId: null,
    updatedByAgentId: null,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-02T00:00:00Z'),
    ...extra,
  } as WikiPage
}

function setup() {
  const connectors = new Map<string, Connector>([
    [KB_PRIV, connector(KB_PRIV, { name: `kb:private:${KB_PRIV}`, visibility: 'private_to_user', ownerUserId: OWNER, config: { displayName: 'Leletek' } })],
    [KB_OTHER_PRIV, connector(KB_OTHER_PRIV, { name: `kb:private:${KB_OTHER_PRIV}`, visibility: 'private_to_user', ownerUserId: ADMIN, config: { displayName: 'Admin titka' } })],
    [KB_SHARED, connector(KB_SHARED, { config: { displayName: 'Termékismeret' } })],
  ])
  const documents = new Map<string, { id: string; connectorId: string; filename: string; extractedText: string; contentHash: string; wikiStatus: string | null; batchId?: string; batchSeq?: number }>([
    [DOC, { id: DOC, connectorId: KB_PRIV, filename: 'lelet.pdf', extractedText: '# Oldal 1\n\nx\n\n# Oldal 2\n\nHbA1c 6,1 %', contentHash: 'doc-hash', wikiStatus: 'processed' }],
  ])
  const pages = [page('labs/hba1c.md'), page('overview.md', { category: null, type: 'overview' })]
  const audit: any[] = []
  const calls: Record<string, any[]> = { purge: [], link: [], setWikiAccess: [], create: [], skip: [] }
  let docSeq = 0

  const consoleRepo: WikiConsoleRepository = {
    async listKnowledgeBases(): Promise<WikiConsoleKbRow[]> {
      return [...connectors.values()].map((c) => ({
        connectorId: c.id,
        name: c.name,
        config: c.config,
        visibility: c.visibility,
        ownerUserId: c.ownerUserId,
        ownerLabel: c.ownerUserId === OWNER ? 'Tulaj Tamás' : c.ownerUserId === ADMIN ? 'Admin Anna' : null,
        lifecycleState: 'active',
        createdAt: new Date(),
        sourceCount: [...documents.values()].filter((d) => d.connectorId === c.id).length,
        pageCount: c.id === KB_PRIV ? pages.length : 0,
        bytes: 2048,
      }))
    },
    async listInboxItems(connectorId) {
      return [...documents.values()]
        .filter((d) => d.connectorId === connectorId && d.wikiStatus)
        .map((d) => ({
          documentId: d.id,
          filename: d.filename,
          purpose: null,
          status: d.wikiStatus as any,
          uploadedById: OWNER,
          uploadedByLabel: 'Tulaj Tamás',
          submittedByAgentId: null,
          claimedByAgentId: null,
          claimExpiresAt: null,
          batchId: d.batchId ?? null,
          batchSeq: d.batchSeq ?? null,
          createdAt: new Date('2026-10-01T00:00:00Z'),
        }))
    },
    async listBindingsForConnector() {
      return [{ agentId: AGENT, agentName: 'Réka', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct', wikiCollectFocus: 'Leletek' }]
    },
    async listSourceDocuments(connectorId, ids) {
      return [...documents.values()]
        .filter((d) => d.connectorId === connectorId && (!ids || ids.includes(d.id)))
        .map((d) => ({ id: d.id, filename: d.filename, extractedText: d.extractedText, createdAt: new Date() }))
    },
    async findSourceDocument(connectorId, documentId) {
      const d = documents.get(documentId)
      return d && d.connectorId === connectorId ? { id: d.id, filename: d.filename, extractedText: d.extractedText, createdAt: new Date() } : null
    },
    async userLabels(ids) {
      return new Map(ids.map((id) => [id, `user-${id.slice(0, 4)}`]))
    },
    async agentNames(_tenantId, ids) {
      return new Map(ids.filter((id) => id === AGENT).map((id) => [id, 'Réka']))
    },
  }

  const service = new WikiConsoleService({
    documents: { readSource: async () => Buffer.from('%PDF-original-bytes') },
    connectors: {
      findById: async (id: string) => connectors.get(id) ?? null,
      create: async (input: any) => {
        const row = connector(`d0000000-0000-4000-8000-00000000000${connectors.size}`, input)
        connectors.set(row.id, row)
        calls.create.push(input)
        return row
      },
    } as any,
    agents: {
      findById: async (id: string) => (id === AGENT ? ({ id: AGENT, tenantId: TENANT, name: 'Réka' } as any) : null),
      findConnectorsForAgent: async () => [
        { connector: connectors.get(KB_SHARED)!, accessMode: 'read', wikiAccess: 'read', wikiWriteMode: 'approval', wikiCollectFocus: null } as any,
      ],
      findConnectorBinding: async (_agentId: string, connectorId: string) =>
        connectorId === KB_SHARED ? ({ accessMode: 'read', wikiAccess: 'read', connector: connectors.get(KB_SHARED) } as any) : null,
    },
    wikis: {
      findByConnectorId: async (id: string) => ({ id: 'wiki-1', connectorId: id, schemaMd: '# Wiki rules' }) as any,
      listPages: async (connectorId: string) => (connectorId === KB_PRIV ? pages : []),
      findPage: async (connectorId: string, path: string) => (connectorId === KB_PRIV ? pages.find((p) => p.path === path) ?? null : null),
      listRevisions: async () => [],
      listLog: async () => [
        { id: 'log-1', wikiId: 'wiki-1', op: 'ingest', title: 'Lelet feldolgozva', note: null, pagePaths: ['labs/hba1c.md'], changeSetId: null, actorAgentId: AGENT, actorUserId: null, createdAt: new Date() },
      ] as any,
      inboxSummary: async (connectorIds: string[]) => ({
        wikis: connectorIds.map((connectorId) => {
          const rows = [...documents.values()].filter((d) => d.connectorId === connectorId)
          const count = (status: string) => rows.filter((d) => d.wikiStatus === status).length
          return { connectorId, pending: count('pending'), inProgress: count('in_progress'), processed: count('processed'), skipped: count('skipped') }
        }),
        batches: [],
      }),
      skipInboxItem: async ({ documentId, connectorId }: any) => {
        const d = documents.get(documentId)
        if (!d || d.connectorId !== connectorId || d.wikiStatus !== 'pending') return false
        d.wikiStatus = 'skipped'
        calls.skip.push(documentId)
        return true
      },
      submitToInbox: async (input: any) => {
        const d = documents.get(input.documentId)!
        d.wikiStatus = input.status
        d.batchId = input.batchId
        d.batchSeq = input.batchSeq
      },
      findDocumentByContentHash: async (connectorId: string, hash: string) => {
        const d = [...documents.values()].find((row) => row.connectorId === connectorId && row.contentHash === hash)
        return d ? { id: d.id } : null
      },
    },
    console: consoleRepo,
    wiki: {
      wikiIdForConnector: async () => 'wiki-1',
      canDecide: async (actor: any) => actor.userId === OWNER,
      previewChangeSet: async () => ({
        changeSet: { id: CHANGESET, status: 'pending', agentId: AGENT, userId: OWNER, createdAt: new Date(), sourceDocumentIds: [DOC], logEntry: { title: 'Új lelet' } },
        connector: connectors.get(KB_PRIV)!,
        pages: [
          {
            path: 'labs/hba1c.md',
            finalPath: 'labs/hba1c.md',
            action: 'patch',
            othersPage: false,
            status: 'published',
            before: { title: 'HbA1c', summary: 's', body: 'a\nb', status: 'published' },
            after: { title: 'HbA1c', summary: 's', body: 'a\nc', sources: [{ documentId: DOC, page: 2 }] },
          },
          {
            path: 'old.md',
            finalPath: 'old.md',
            action: 'archive',
            othersPage: true,
            status: 'archived',
            before: { title: 'Régi', summary: '', body: 'x', status: 'published' },
            after: { title: 'Régi', summary: '', body: 'x', sources: [] },
          },
        ],
        issues: [{ severity: 'warning', code: 'orphan', path: 'old.md', message: 'no inbound links' }],
        blocking: null,
      }),
    } as any,
    wikiAccess: {
      createPrivateKnowledgeBase: async (input: any) => {
        calls.create.push({ private: true, ...input })
        const row = connector('e0000000-0000-4000-8000-00000000000e', { visibility: 'private_to_user', ownerUserId: input.actor.userId, config: { displayName: input.displayName, wikiTemplate: input.wikiTemplate } })
        connectors.set(row.id, row)
        return row
      },
      linkKnowledgeBase: async (input: any) => {
        calls.link.push(input)
        return {} as any
      },
      setWikiAccess: async (input: any) => {
        calls.setWikiAccess.push(input)
        return {} as any
      },
      purgePrivateKnowledgeBase: async (input: any) => {
        calls.purge.push(input)
        connectors.delete(input.connectorId)
        return { documents: 1, pages: 2 } as any
      },
    },
    knowledgeBase: {
      ingestIntoKnowledgeBase: async (input: any) => {
        const id = `f0000000-0000-4000-8000-00000000000${docSeq++}`
        documents.set(id, {
          id,
          connectorId: input.connectorId,
          filename: input.filename,
          extractedText: input.buffer.toString('utf8'),
          contentHash: createHash('sha256').update(input.buffer).digest('hex'),
          wikiStatus: null,
        })
        return { documentId: id, filename: input.filename } as any
      },
    },
    audit: { append: async (entry: any) => void audit.push(entry) },
    now: () => new Date('2026-10-10T00:00:00Z'),
  })
  return { service, connectors, documents, audit, calls }
}

async function main() {
  console.log('wiki-console (#946)')

  await check('listKnowledgeBasesAction: admin csak metaadat-sort lát a más privát KB-járól', async () => {
    const { service } = setup()
    const rows = await service.listKnowledgeBases(admin)
    const priv = rows.find((row) => row.connectorId === KB_PRIV)!
    assert.equal(priv.metadataOnly, true)
    assert.ok(!('name' in priv), 'a privát KB neve nem kerülhet az admin-listába')
    assert.equal(priv.ownerLabel, 'Tulaj Tamás')
    assert.equal(priv.pageCount, 2)
    assert.ok(!JSON.stringify(rows).includes('Leletek'))
    // Az admin saját privát KB-ja teljes sor.
    assert.equal(rows.find((row) => row.connectorId === KB_OTHER_PRIV)!.metadataOnly, false)
  })

  await check('listKnowledgeBasesAction: operátor nem látja más privát KB-ját, a sajátját igen', async () => {
    const { service } = setup()
    const forOperator = await service.listKnowledgeBases(operator)
    assert.deepEqual(forOperator.map((row) => row.connectorId), [KB_SHARED])
    const forOwner = await service.listKnowledgeBases(owner)
    const own = forOwner.find((row) => row.connectorId === KB_PRIV)!
    assert.equal(own.metadataOnly, false)
    assert.equal((own as any).name, 'Leletek')
    assert.ok(!forOwner.some((row) => row.connectorId === KB_OTHER_PRIV))
    // Néző a közöset sem látja (a katalógus operátor-szintű), privátot létrehozhat.
    assert.deepEqual(await service.listKnowledgeBases(viewer), [])
  })

  await check('getWikiOverviewAction / getWikiPageAction / getWikiSourceAction / listWikiInboxAction: admin → not_found a privátnál', async () => {
    const { service } = setup()
    await rejectsWith('not_found', () => service.getOverview(admin, KB_PRIV))
    await rejectsWith('not_found', () => service.getPage(admin, KB_PRIV, 'labs/hba1c.md'))
    await rejectsWith('not_found', () => service.getSource(admin, KB_PRIV, DOC))
    await rejectsWith('not_found', () => service.listInbox(admin, KB_PRIV))
    await rejectsWith('not_found', () => service.getOverview({ ...admin, role: 'admin', assumed: true }, KB_PRIV))
  })

  await check('uploadWikiInboxFileAction / skipWikiInboxItemAction / export / purge: admin → not_found a privátnál', async () => {
    const { service, calls } = setup()
    await rejectsWith('not_found', () =>
      service.uploadToInbox(admin, { connectorId: KB_PRIV, batchId: BATCH, batchSeq: 0, filename: 'a.txt', buffer: Buffer.from('a') }),
    )
    await rejectsWith('not_found', () => service.skipInboxItem(admin, KB_PRIV, DOC))
    await rejectsWith('not_found', () => service.exportZip(admin, KB_PRIV))
    await rejectsWith('not_found', () => service.purgePrivate(admin, KB_PRIV))
    assert.equal(calls.purge.length, 0)
  })

  await check('getWikiChangeSetReviewAction: csak a döntéshozó kapja meg (privátnál admin sem)', async () => {
    const { service } = setup()
    await rejectsWith('not_found', () => service.getChangeSetReview(admin, CHANGESET))
    const review = await service.getChangeSetReview(owner, CHANGESET)
    assert.equal(review.wikiName, 'Leletek')
    assert.equal(review.agentName, 'Réka')
    assert.deepEqual(review.sources.map((s) => s.filename), ['lelet.pdf'])
    assert.deepEqual(review.pages.map((p) => p.kind), ['modified', 'archived'])
    assert.equal(review.pages[1].othersPage, true)
    assert.deepEqual(review.pages[0].diff, [
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'c' },
    ])
    assert.deepEqual(review.pages[1].diff, [])
    assert.equal(review.issues[0].code, 'orphan')
  })

  await check('tulajdonos: wiki fül — tartalomjegyzék, szerző, napló, hozzáférés', async () => {
    const { service } = setup()
    const overview = await service.getOverview(owner, KB_PRIV)
    assert.equal(overview.name, 'Leletek')
    assert.equal(overview.private, true)
    assert.equal(overview.canManage, true)
    assert.deepEqual(overview.categories.map((c) => c.category), ['Labor', 'Uncategorized'])
    assert.deepEqual(overview.categories[0].pages[0].author, { kind: 'agent', name: 'Réka' })
    assert.equal(overview.log[0].title, 'Lelet feldolgozva')
    assert.deepEqual(overview.access[0], { agentId: AGENT, agentName: 'Réka', access: 'write', writeMode: 'direct', collectFocus: 'Leletek' })
    const detail = await service.getPage(owner, KB_PRIV, 'labs/hba1c.md')
    assert.deepEqual(detail.sources[0], { documentId: DOC, page: 2, filename: 'lelet.pdf', exists: true })
    assert.ok(detail.knownPaths.includes('overview.md'))
    await rejectsWith('not_found', () => service.getPage(owner, KB_PRIV, 'nincs.md'))
  })

  await check('közös KB: operátor olvas és feltölt, de kihagyni / exportálni csak admin tud', async () => {
    const { service } = setup()
    const overview = await service.getOverview(operator, KB_SHARED)
    assert.equal(overview.canManage, false)
    assert.equal(overview.canContribute, true)
    await service.uploadToInbox(operator, { connectorId: KB_SHARED, batchId: BATCH, batchSeq: 0, filename: 'a.txt', buffer: Buffer.from('aaa') })
    await rejectsWith('forbidden', () => service.skipInboxItem(operator, KB_SHARED, DOC))
    await rejectsWith('forbidden', () => service.exportZip(operator, KB_SHARED))
    await rejectsWith('not_found', () => service.getOverview(viewer, KB_SHARED))
  })

  await check('tálca: 30 fájl egy kötegben, duplikátum külön jelezve, 10 MB fölött elutasítva', async () => {
    const { service, documents, audit } = setup()
    const results = []
    for (let i = 0; i < 30; i++) {
      results.push(
        await service.uploadToInbox(owner, { connectorId: KB_PRIV, batchId: BATCH, batchSeq: i, filename: `lelet-${i}.txt`, buffer: Buffer.from(`lelet ${i}`) }),
      )
    }
    assert.ok(results.every((r) => r.status === 'queued'))
    const batch = [...documents.values()].filter((d) => d.batchId === BATCH)
    assert.equal(batch.length, 30)
    assert.ok(batch.every((d) => d.wikiStatus === 'pending'))
    assert.deepEqual(batch.map((d) => d.batchSeq).sort((a, b) => a! - b!), Array.from({ length: 30 }, (_, i) => i))
    const dup = await service.uploadToInbox(owner, { connectorId: KB_PRIV, batchId: BATCH, batchSeq: 30, filename: 'ujra.txt', buffer: Buffer.from('lelet 3') })
    assert.equal(dup.status, 'duplicate')
    await rejectsWith('too_large', () =>
      service.uploadToInbox(owner, { connectorId: KB_PRIV, batchId: BATCH, batchSeq: 31, filename: 'nagy.pdf', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }),
    )
    await rejectsWith('invalid_args', () =>
      service.uploadToInbox(owner, { connectorId: KB_PRIV, batchId: 'nem-uuid', batchSeq: 0, filename: 'x.txt', buffer: Buffer.from('x') }),
    )
    const inbox = await service.listInbox(owner, KB_PRIV)
    assert.equal(inbox.totals.pending, 30)
    assert.equal(inbox.items.filter((item) => item.stale).length, 30, 'D17: 3 napnál régebben váró tétel kiemelve a gazdának')
    // A privát KB audit-sorában nincs fájlnév.
    assert.ok(!JSON.stringify(audit).includes('lelet-'))
  })

  await check('kihagyás: csak váró tételt, és auditál', async () => {
    const { service, documents, audit } = setup()
    const queued = await service.uploadToInbox(owner, { connectorId: KB_PRIV, batchId: BATCH, batchSeq: 0, filename: 'x.txt', buffer: Buffer.from('xx') })
    assert.equal(queued.status, 'queued')
    const id = (queued as { documentId: string }).documentId
    await service.skipInboxItem(owner, KB_PRIV, id)
    assert.equal(documents.get(id)!.wikiStatus, 'skipped')
    assert.ok(audit.some((entry) => entry.action === 'kb.wiki.inbox.skipped'))
    await rejectsWith('not_found', () => service.skipInboxItem(owner, KB_PRIV, id))
  })

  await check('ZIP-letöltés: wiki-oldalak, index, napló, WIKI.md és nyers források', async () => {
    const { service, audit } = setup()
    const { filename, bytes } = await service.exportZip(owner, KB_PRIV)
    assert.equal(filename, 'Leletek.zip')
    const entries = readZipEntries(bytes)
    const paths = entries.map((entry) => entry.path).sort()
    assert.deepEqual(paths, [
      'Leletek/WIKI.md',
      'Leletek/index.md',
      'Leletek/labs/hba1c.md',
      'Leletek/log.md',
      'Leletek/overview.md',
      'Leletek/raw/99999999-lelet.pdf',
      'Leletek/raw/99999999-lelet.pdf.md',
    ])
    assert.equal(Buffer.from(entries.find((entry) => entry.path === 'Leletek/raw/99999999-lelet.pdf')!.bytes).toString(), '%PDF-original-bytes')
    const text = new TextDecoder().decode(entries.find((entry) => entry.path === 'Leletek/labs/hba1c.md')!.bytes)
    assert.ok(text.startsWith('---\n') && text.includes('HbA1c 6,1 %'))
    assert.ok(audit.some((entry) => entry.action === 'kb.wiki.exported' && entry.metadata.privateKb === true))
  })

  await check('végleges törlés: tulajdonos indítja, közös KB-n tiltott', async () => {
    const { service, calls } = setup()
    await service.purgePrivate(owner, KB_PRIV)
    assert.equal(calls.purge.length, 1)
    await rejectsWith('not_found', () => service.getOverview(owner, KB_PRIV))
    await rejectsWith('forbidden', () => service.purgePrivate(admin, KB_SHARED))
  })

  await check('createKnowledgeBaseAction: privát bárkinek (sablonnal), közös csak adminnak', async () => {
    const { service, calls } = setup()
    await service.createKnowledgeBase(viewer, { displayName: 'Napló', private: true, template: 'health-journal' })
    assert.equal(calls.create[0].wikiTemplate, 'health-journal')
    await rejectsWith('forbidden', () => service.createKnowledgeBase(operator, { displayName: 'Közös', private: false }))
    const created = await service.createKnowledgeBase(admin, { displayName: 'Közös', private: false, template: 'nincs-ilyen' })
    assert.ok(created.connectorId)
    assert.deepEqual(calls.create[1].config, { displayName: 'Közös', wikiTemplate: 'general' })
    assert.ok(calls.create[1].name.startsWith('kb:shared:'))
    await rejectsWith('invalid_args', () => service.createKnowledgeBase(admin, { displayName: '  ', private: true }))
  })

  await check('listAgentWikiLinksAction: más privát wikije nem jelenik meg, a saját igen', async () => {
    const { service } = setup()
    const forOwner = await service.listAgentWikiLinks(owner, AGENT)
    assert.deepEqual(forOwner.map((row) => row.connectorId).sort(), [KB_PRIV, KB_SHARED].sort())
    const priv = forOwner.find((row) => row.connectorId === KB_PRIV)!
    assert.equal(priv.canEdit, true)
    assert.equal(priv.access, 'none')
    assert.equal(priv.writeMode, 'direct', 'D14: privát wikinél az új kapcsolat alapból közvetlen')
    assert.equal(forOwner.find((row) => row.connectorId === KB_SHARED)!.canEdit, false, 'közöset csak admin állít')
    const forAdmin = await service.listAgentWikiLinks(admin, AGENT)
    assert.ok(!forAdmin.some((row) => row.connectorId === KB_PRIV))
    assert.equal(forAdmin.find((row) => row.connectorId === KB_SHARED)!.canEdit, true)
  })

  await check('setAgentWikiLinkAction: új kapcsolat írásnál write accessModdal jön létre; none + nincs kötés = nincs teendő', async () => {
    const { service, calls } = setup()
    assert.deepEqual(await service.setAgentWikiLink(owner, { agentId: AGENT, connectorId: KB_PRIV, wikiAccess: 'none' }), { changed: false })
    await service.setAgentWikiLink(owner, {
      agentId: AGENT,
      connectorId: KB_PRIV,
      wikiAccess: 'write',
      wikiWriteMode: 'direct',
      wikiCollectFocus: 'Leletek',
    })
    assert.equal(calls.link[0].accessMode, 'write')
    assert.equal(calls.setWikiAccess[0].wikiWriteMode, 'direct')
    assert.equal(calls.setWikiAccess[0].wikiCollectFocus, 'Leletek')
    // Olvasási jognál a „Mit gyűjtsön” törlődik, a meglévő kötésnél nincs új link.
    await service.setAgentWikiLink(admin, { agentId: AGENT, connectorId: KB_SHARED, wikiAccess: 'read', wikiCollectFocus: 'x' })
    assert.equal(calls.link.length, 1)
    assert.equal(calls.setWikiAccess[1].wikiCollectFocus, null)
    assert.ok(!('wikiWriteMode' in calls.setWikiAccess[1]))
  })

  await check('soronkénti diff + összecsukás', () => {
    const rows = diffLines('a\nb\nc\nd\ne\nf\ng', 'a\nb\nc\nX\ne\nf\ng')
    assert.deepEqual(rows.filter((row) => row.kind !== 'same'), [
      { kind: 'del', text: 'd' },
      { kind: 'add', text: 'X' },
    ])
    const collapsed = collapseUnchanged(rows, 1)
    assert.deepEqual(collapsed[0], { kind: 'skip', count: 2 })
    assert.deepEqual(diffLines('', 'új'), [{ kind: 'add', text: 'új' }])
  })

  await check('[[wiki-link]] kattintható linkké alakul', () => {
    assert.equal(linkifyWikiLinks('Lásd [[labs/hba1c]] és [[overview|az áttekintést]].'), 'Lásd [labs/hba1c](#wiki:labs%2Fhba1c.md) és [az áttekintést](#wiki:overview.md).')
  })

  if (failures > 0) {
    console.log(`\n${failures} FAIL`)
    process.exit(1)
  }
  console.log('\nminden OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
