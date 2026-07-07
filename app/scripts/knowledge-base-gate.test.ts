/**
 * Determinisztikus teszt a KB-dokumentum jóváhagyási kapuhoz (§9.3 / §4.6).
 * Futtatás: npm run test:kb-gate
 *
 * DB NÉLKÜL fut: in-memory fake repókat használ + a VALÓDI TicketService
 * állapotgépét, így a teljes flow-t igazolja (feltöltés → jóváhagyásra vár →
 * jóváhagyás/elutasítás), beleértve hogy a dokumentum csak jóváhagyás után
 * kerül a KB connectorba (connectorId + processed → ettől kereshető).
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type {
  Connector,
  Document,
  KnowledgeArtifact,
  KnowledgeArtifactStatus,
  KnowledgeChunk,
  Ticket,
  TicketTransition,
} from '@prisma/client'
import { TicketService } from '../src/domain/ticket/ticket-service'
import {
  KnowledgeBaseService,
  asKbDocumentPayload,
} from '../src/domain/knowledge-base/knowledge-base-service'
import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
  TicketRepository,
} from '../src/repositories/interfaces'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✅ ${name}`))
    .catch((e) => {
      failures++
      console.log(`  ❌ ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

// ── In-memory fakes ────────────────────────────────────────────────────────

type Audit = { action: string; targetId: string; policyDecision: string }

function makeFakes() {
  const tickets = new Map<string, Ticket>()
  const documents = new Map<string, Document>()
  const agents = new Map<
    string,
    { id: string; name: string; role: string; tenantId: string | null }
  >()
  const transitions: TicketTransition[] = []
  const audits: Audit[] = []

  const ticketRepo = {
    async create(data: Record<string, unknown>) {
      const ticket = {
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
        lockToken: null,
        lockedAt: null,
        playbookRef: null,
        conversationId: null,
        source: 'user',
        ...data,
      } as unknown as Ticket
      tickets.set(ticket.id, ticket)
      return ticket
    },
    async findById(id: string) {
      return tickets.get(id) ?? null
    },
    async update(id: string, data: Record<string, unknown>) {
      const current = tickets.get(id)
      if (!current) throw new Error('ticket not found')
      const next = { ...current, ...data, updatedAt: new Date() } as Ticket
      tickets.set(id, next)
      return next
    },
    async recordTransition(data: Record<string, unknown>) {
      const t = { id: randomUUID(), ts: new Date(), ...data } as unknown as TicketTransition
      transitions.push(t)
      return t
    },
    async findMany(filter?: { type?: string; agentId?: string; state?: string }) {
      return [...tickets.values()].filter(
        (t) =>
          (!filter?.type || t.type === filter.type) &&
          (!filter?.agentId || t.agentId === filter.agentId) &&
          (!filter?.state || t.state === filter.state),
      )
    },
  } as unknown as TicketRepository

  const documentRepo = {
    async findById(id: string) {
      return documents.get(id) ?? null
    },
    async update(id: string, data: Partial<Document>) {
      const current = documents.get(id)
      if (!current) throw new Error('document not found')
      const next = { ...current, ...data } as Document
      documents.set(id, next)
      return next
    },
  } as unknown as DocumentRepository

  const agentRepo = {
    async findById(id: string) {
      return (agents.get(id) ?? null) as never
    },
  } as unknown as AgentRepository

  const auditRepo = {
    async append(entry: Audit) {
      audits.push(entry)
      return undefined as never
    },
  } as unknown as AuditRepository

  const artifacts = new Map<string, KnowledgeArtifact>()
  const chunks = new Map<string, KnowledgeChunk>()

  const artifactRepo = {
    async findById(id: string) {
      return artifacts.get(id) ?? null
    },
    async create(data: Record<string, unknown>) {
      const artifact = {
        id: randomUUID(),
        createdAt: new Date(),
        publishedAt: null,
        ...data,
      } as unknown as KnowledgeArtifact
      artifacts.set(artifact.id, artifact)
      return artifact
    },
    async update(id: string, data: Partial<KnowledgeArtifact>) {
      const current = artifacts.get(id)
      if (!current) throw new Error('artifact not found')
      const next = { ...current, ...data } as KnowledgeArtifact
      artifacts.set(id, next)
      return next
    },
    async findByConnector(connectorId: string, status?: KnowledgeArtifactStatus) {
      return [...artifacts.values()].filter(
        (a) => a.connectorId === connectorId && (!status || a.status === status),
      )
    },
    async latestVersionForDocument(connectorId: string, sourceDocumentId: string) {
      return [...artifacts.values()]
        .filter((a) => a.connectorId === connectorId && a.sourceDocumentId === sourceDocumentId)
        .reduce((max, a) => Math.max(max, a.version), 0)
    },
  } as unknown as KnowledgeArtifactRepository

  const chunkRepo = {
    async createMany(rows: Array<Omit<KnowledgeChunk, 'id' | 'createdAt'>>) {
      for (const row of rows) {
        const chunk = { id: randomUUID(), createdAt: new Date(), ...row } as KnowledgeChunk
        chunks.set(chunk.id, chunk)
      }
      return rows.length
    },
    async findByArtifact(artifactId: string) {
      return [...chunks.values()]
        .filter((c) => c.artifactId === artifactId)
        .sort((a, b) => a.chunkIndex - b.chunkIndex)
    },
    async deleteByArtifact(artifactId: string) {
      for (const [id, c] of chunks) if (c.artifactId === artifactId) chunks.delete(id)
    },
  } as unknown as KnowledgeChunkRepository

  const connector = {
    id: 'kb-conn-1',
    type: 'knowledge_base',
    name: 'kb:agent-1',
    tenantId: null,
  } as unknown as Connector

  const ensureKb = async (agent: { role: string }) =>
    agent.role === 'orchestrator' ? null : connector

  const ticketService = new TicketService(ticketRepo, auditRepo)
  const kb = new KnowledgeBaseService(
    ticketRepo,
    documentRepo,
    agentRepo,
    auditRepo,
    ticketService,
    artifactRepo,
    chunkRepo,
    ensureKb,
  )

  return { kb, tickets, documents, agents, transitions, audits, connector, artifacts, chunks }
}

function seedDoc(
  documents: Map<string, Document>,
  filename: string,
  connectorId: string | null = null,
  extractedText = 'tartalom',
): Document {
  const doc = {
    id: randomUUID(),
    filename,
    storageRef: `ref/${filename}`,
    extractedText,
    status: 'uploaded',
    connectorId,
    uploadedById: randomUUID(),
    createdAt: new Date(),
  } as unknown as Document
  documents.set(doc.id, doc)
  return doc
}

// ── Tesztek ────────────────────────────────────────────────────────────────

async function run() {
  console.log('=== KB-dokumentum jóváhagyási kapu teszt ===')

  await check('feltöltés → jóváhagyásra vár, a dokumentum még NEM kereshető', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'szabalyzat.md')

    const ticket = await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'user-1',
      actorTenantId: null,
    })

    assert.equal(ticket.state, 'awaiting_human', 'a ticket jóváhagyásra vár')
    assert.equal(ticket.type, 'training')
    assert.equal(ticket.sourceDocumentId, doc.id)
    const payload = asKbDocumentPayload(ticket.payload)
    assert.ok(payload, 'kb_document payload')
    assert.equal(payload.documentId, doc.id)
    // A dokumentum még nincs connectorhoz kötve → kb_search nem találja.
    assert.equal(documents.get(doc.id)?.connectorId, null)
    assert.equal(documents.get(doc.id)?.status, 'uploaded')
  })

  await check('az állapotgép a teljes kapu-úton megy (backlog→…→awaiting_human)', async () => {
    const { kb, documents, agents, transitions } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'a.md')
    await kb.requestDocument({ agentId: 'agent-1', documentId: doc.id, createdById: 'u', actorTenantId: null })
    const seq = transitions.map((t) => t.toState)
    assert.deepEqual(seq, ['ready', 'in_progress', 'awaiting_human'])
  })

  await check('jóváhagyás → bekerül a KB-be (connectorId + processed), ticket done', async () => {
    const { kb, tickets, documents, agents, transitions, audits, connector } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'kezikonyv.md')
    const ticket = await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'u',
      actorTenantId: null,
    })

    const updated = await kb.approveDocument({
      ticketId: ticket.id,
      approverId: 'approver-1',
      approverRole: 'approver',
      actorTenantId: null,
    })

    assert.equal(updated.connectorId, connector.id, 'a dokumentum a KB connectorba kerül')
    assert.equal(updated.status, 'processed', 'processed → kb_search megtalálja')
    assert.equal(tickets.get(ticket.id)?.state, 'done', 'a ticket lezárult')
    // az approve utáni két átmenet:
    const tail = transitions.slice(-2).map((t) => t.toState)
    assert.deepEqual(tail, ['approved', 'done'])
    assert.ok(audits.some((a) => a.action === 'kb.document.approved'))
  })

  await check('elutasítás → a dokumentum failed, ticket rejected', async () => {
    const { kb, documents, agents, transitions, audits } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'rossz.md')
    const ticket = await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'u',
      actorTenantId: null,
    })

    await kb.rejectDocument({ ticketId: ticket.id, approverId: 'a1', approverRole: 'approver', actorTenantId: null })

    assert.equal(documents.get(doc.id)?.status, 'failed')
    assert.equal(documents.get(doc.id)?.connectorId, null, 'elutasított doc nem kerül a KB-be')
    assert.equal(transitions.at(-1)?.toState, 'rejected')
    assert.ok(audits.some((a) => a.action === 'kb.document.rejected'))
  })

  await check('listPendingDocuments csak a függő KB-ticketeket adja, jóváhagyás után 0', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'fuggo.md')
    const ticket = await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'u',
      actorTenantId: null,
    })

    const before = await kb.listPendingDocuments('agent-1', null)
    assert.equal(before.length, 1)
    assert.equal(before[0].filename, 'fuggo.md')

    await kb.approveDocument({ ticketId: ticket.id, approverId: 'a1', approverRole: 'approver', actorTenantId: null })
    const after = await kb.listPendingDocuments('agent-1', null)
    assert.equal(after.length, 0)
  })

  await check('orchestrator agentnek nincs KB — requestDocument elutasít', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('orch', { id: 'orch', name: 'Orchestrator', role: 'orchestrator', tenantId: null })
    const doc = seedDoc(documents, 'x.md')
    await assert.rejects(
      kb.requestDocument({ agentId: 'orch', documentId: doc.id, createdById: 'u', actorTenantId: null }),
      /Orchestrator/,
    )
  })

  await check('már csatolt dokumentumot nem lehet újra beküldeni', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'mar.md', 'kb-conn-1')
    await assert.rejects(
      kb.requestDocument({ agentId: 'agent-1', documentId: doc.id, createdById: 'u', actorTenantId: null }),
      /already attached/,
    )
  })

  await check('approveDocument nem-KB (memória) tanítási ticketet elutasít', async () => {
    const { kb, tickets, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const memTicket = {
      id: randomUUID(),
      type: 'training',
      state: 'awaiting_human',
      agentId: 'agent-1',
      payload: { proposedContent: 'memória szöveg' },
      createdAt: new Date(),
    } as unknown as Ticket
    tickets.set(memTicket.id, memTicket)
    await assert.rejects(
      kb.approveDocument({ ticketId: memTicket.id, approverId: 'a1', approverRole: 'approver', actorTenantId: null }),
      /Not a KB document ticket/,
    )
  })

  await check('asKbDocumentPayload diszkriminátor helyessége', () => {
    assert.ok(
      asKbDocumentPayload({ kind: 'kb_document', documentId: 'd', connectorId: 'c', filename: 'f' }),
    )
    assert.equal(asKbDocumentPayload({ proposedContent: 'x' }), null)
    assert.equal(asKbDocumentPayload(null), null)
    assert.equal(asKbDocumentPayload([1, 2, 3] as never), null)
  })

  // ── KB-v3 OKF artifact flow (§17 acceptance) ──────────────────────────────

  await check('OKF-mód: requestDocument draft artifactot hoz létre, chunk MÉG nincs', async () => {
    const { kb, documents, agents, artifacts, chunks } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(
      documents,
      'policy.md',
      null,
      '# Remote Work\nRules here.\n\n# Onboarding\nSteps here.',
    )

    await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'u',
      actorTenantId: null,
      processingMode: 'okf',
    })

    const drafts = [...artifacts.values()]
    assert.equal(drafts.length, 1, 'egy draft artifact')
    assert.equal(drafts[0].status, 'pending_review', 'pending_review, nem published')
    assert.equal(drafts[0].version, 1)
    assert.equal(drafts[0].sourceDocumentId, doc.id)
    assert.equal(documents.get(doc.id)?.processingMode, 'okf', 'a mód a dokumentumon rögzül')
    // Approval előtt NINCS chunk → nem kereshető.
    assert.equal(chunks.size, 0, 'publikálás előtt nincs chunk index')
  })

  await check('OKF-mód: jóváhagyás publikál és felépíti a chunk indexet', async () => {
    const { kb, documents, agents, artifacts, chunks, audits } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(
      documents,
      'kezikonyv.md',
      null,
      '# Bevezetés\nSzöveg.\n\n# Szabályok\nTöbb szöveg.',
    )
    const ticket = await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'u',
      actorTenantId: null,
      processingMode: 'okf',
    })

    await kb.approveDocument({ ticketId: ticket.id, approverId: 'a1', approverRole: 'approver', actorTenantId: null })

    const artifact = [...artifacts.values()][0]
    assert.equal(artifact.status, 'published', 'publikált')
    assert.ok(artifact.publishedAt, 'publishedAt beáll')
    assert.equal(artifact.approvedById, 'a1')
    assert.ok(chunks.size >= 2, 'a heading-szekciókból chunkok épülnek')
    // A chunkok a connector scope-ot hordozzák (D-B).
    for (const c of chunks.values()) assert.equal(c.connectorId, 'kb-conn-1')
    assert.ok(audits.some((a) => a.action === 'kb.artifact.generated'))
    assert.ok(audits.some((a) => a.action === 'kb.artifact.published'))
  })

  await check('OKF-mód: elutasítás → az artifact failed, nem publikálódik', async () => {
    const { kb, documents, agents, artifacts, chunks } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'rossz-okf.md', null, '# X\nY')
    const ticket = await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'u',
      actorTenantId: null,
      processingMode: 'okf',
    })

    await kb.rejectDocument({ ticketId: ticket.id, approverId: 'a1', approverRole: 'approver', actorTenantId: null })

    assert.equal([...artifacts.values()][0].status, 'failed')
    assert.equal(chunks.size, 0, 'elutasított artifact nem indexelődik')
  })

  await check('listPendingArtifacts a függő artifactokat adja, publish után 0', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'fuggo-okf.md', null, '# A\nB')
    const ticket = await kb.requestDocument({
      agentId: 'agent-1',
      documentId: doc.id,
      createdById: 'u',
      actorTenantId: null,
      processingMode: 'okf',
    })

    const before = await kb.listPendingArtifacts('agent-1', null)
    assert.equal(before.length, 1)

    await kb.approveDocument({ ticketId: ticket.id, approverId: 'a1', approverRole: 'approver', actorTenantId: null })
    const after = await kb.listPendingArtifacts('agent-1', null)
    assert.equal(after.length, 0)
  })

  await check('raw_text_only (default): NEM keletkezik artifact', async () => {
    const { kb, documents, agents, artifacts } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'nyers.md')
    await kb.requestDocument({ agentId: 'agent-1', documentId: doc.id, createdById: 'u', actorTenantId: null })
    assert.equal(artifacts.size, 0, 'raw módban nincs OKF artifact')
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exit(1)
}

run()
