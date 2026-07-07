/**
 * Determinisztikus teszt a Knowledge Base tenant-határához (multi-tenant izoláció).
 * Futtatás: npm run test:kb-tenant-boundary
 *
 * DB NÉLKÜL fut (in-memory fake repók). Azt igazolja, hogy a KB-műveletek a hívó
 * AKTÍV tenantjának határán belül maradnak: egy tenant operátora/approvere NEM
 * férhet hozzá egy MÁSIK tenant agentjének tudásbázisához — se olvasásra (review /
 * pending-lista), se írásra (request), se jóváhagyásra/elutasításra. A megosztott
 * (tenantId === null, platform-szintű) agent bárhonnan elérhető marad.
 *
 * Ez a Tool Broker `isAgentReachableFromTenant` izolációjának KB-oldali párja
 * (a tudásbázis a legérzékenyebb ügyfél-tartalom), és a `knowledge-base-gate.test.ts`
 * happy-path kapuját egészíti ki a cross-tenant deny ágakkal.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type {
  Connector,
  Document,
  KnowledgeArtifact,
  KnowledgeArtifactStatus,
  Ticket,
  TicketTransition,
} from '@prisma/client'
import { TicketService } from '../src/domain/ticket/ticket-service'
import { KnowledgeBaseService } from '../src/domain/knowledge-base/knowledge-base-service'
import { isAgentReachableFromTenant } from '../src/lib/tenant-reachability'
import type {
  AgentRepository,
  AuditRepository,
  DocumentRepository,
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
  TicketRepository,
} from '../src/repositories/interfaces'

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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

type AgentSeed = { id: string; name: string; role: string; tenantId: string | null }

function makeFakes() {
  const tickets = new Map<string, Ticket>()
  const documents = new Map<string, Document>()
  const agents = new Map<string, AgentSeed>()
  const artifacts = new Map<string, KnowledgeArtifact>()
  const transitions: TicketTransition[] = []

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
    async append() {
      return undefined as never
    },
  } as unknown as AuditRepository

  const artifactRepo = {
    async findById(id: string) {
      return artifacts.get(id) ?? null
    },
    async create(data: Record<string, unknown>) {
      const artifact = { id: randomUUID(), createdAt: new Date(), publishedAt: null, ...data } as unknown as KnowledgeArtifact
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
    async latestVersionForDocument() {
      return 0
    },
  } as unknown as KnowledgeArtifactRepository

  const chunkRepo = {
    async createMany() {
      return 0
    },
    async deleteByArtifact() {},
  } as unknown as KnowledgeChunkRepository

  // A KB connectort az agent tenantjához igazítjuk (a valós provisioning is így teszi).
  const ensureKb = async (agent: { id: string; role: string }) => {
    if (agent.role === 'orchestrator') return null
    const seed = agents.get(agent.id)
    return {
      id: `kb-conn-${agent.id}`,
      type: 'knowledge_base',
      name: `kb:${agent.id}`,
      tenantId: seed?.tenantId ?? null,
    } as unknown as Connector
  }

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

  return { kb, tickets, documents, agents }
}

function seedDoc(documents: Map<string, Document>, filename: string): Document {
  const doc = {
    id: randomUUID(),
    filename,
    storageRef: `ref/${filename}`,
    extractedText: 'titkos tartalom',
    status: 'uploaded',
    connectorId: null,
    uploadedById: randomUUID(),
    createdAt: new Date(),
  } as unknown as Document
  documents.set(doc.id, doc)
  return doc
}

async function run() {
  console.log('=== KB tenant-határ teszt ===')

  // ── A tiszta szabály (DB-mentes) ─────────────────────────────────────────
  await check('isAgentReachableFromTenant: megosztott (null) agent bárhonnan elérhető', () => {
    assert.equal(isAgentReachableFromTenant(null, TENANT_A), true)
    assert.equal(isAgentReachableFromTenant(null, null), true)
  })
  await check('isAgentReachableFromTenant: saját tenant elérhető, más tenant nem', () => {
    assert.equal(isAgentReachableFromTenant(TENANT_A, TENANT_A), true)
    assert.equal(isAgentReachableFromTenant(TENANT_B, TENANT_A), false)
    assert.equal(isAgentReachableFromTenant(TENANT_A, null), false)
  })

  // ── requestDocument ──────────────────────────────────────────────────────
  await check('requestDocument: cross-tenant agent → Agent not found', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-b', { id: 'agent-b', name: 'B-Wiki', role: 'worker', tenantId: TENANT_B })
    const doc = seedDoc(documents, 'b-belso.md')
    await assert.rejects(
      kb.requestDocument({
        agentId: 'agent-b',
        documentId: doc.id,
        createdById: 'user-a',
        actorTenantId: TENANT_A,
      }),
      /Agent not found/,
    )
    // A dokumentum nem csatolódott (nem szivárgott a másik tenant KB-jébe).
    assert.equal(documents.get(doc.id)?.connectorId, null)
  })

  await check('requestDocument: saját tenant agentje → átmegy a kapun', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-a', { id: 'agent-a', name: 'A-Wiki', role: 'worker', tenantId: TENANT_A })
    const doc = seedDoc(documents, 'a-belso.md')
    const ticket = await kb.requestDocument({
      agentId: 'agent-a',
      documentId: doc.id,
      createdById: 'user-a',
      actorTenantId: TENANT_A,
    })
    assert.equal(ticket.state, 'awaiting_human')
  })

  await check('requestDocument: megosztott (null) agent bármely tenantból elérhető', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-shared', { id: 'agent-shared', name: 'Közös', role: 'worker', tenantId: null })
    const doc = seedDoc(documents, 'kozos.md')
    const ticket = await kb.requestDocument({
      agentId: 'agent-shared',
      documentId: doc.id,
      createdById: 'user-a',
      actorTenantId: TENANT_A,
    })
    assert.equal(ticket.state, 'awaiting_human')
  })

  // ── approve / reject (ticket-alapú) ──────────────────────────────────────
  await check('approveDocument: másik tenant KB-ticketje → KB ticket not found', async () => {
    const { kb, tickets, documents, agents } = makeFakes()
    // A tenant B-ben létrejön egy valós KB-jóváhagyási ticket.
    agents.set('agent-b', { id: 'agent-b', name: 'B-Wiki', role: 'worker', tenantId: TENANT_B })
    const doc = seedDoc(documents, 'b-doc.md')
    const ticket = await kb.requestDocument({
      agentId: 'agent-b',
      documentId: doc.id,
      createdById: 'user-b',
      actorTenantId: TENANT_B,
    })
    // Tenant A approvere NEM hagyhatja jóvá.
    await assert.rejects(
      kb.approveDocument({
        ticketId: ticket.id,
        approverId: 'approver-a',
        approverRole: 'approver',
        actorTenantId: TENANT_A,
      }),
      /KB ticket not found/,
    )
    // A dokumentum állapota változatlan (nem került be a KB-be).
    assert.equal(documents.get(doc.id)?.connectorId, null)
    assert.equal(tickets.get(ticket.id)?.state, 'awaiting_human')
  })

  await check('rejectDocument: másik tenant KB-ticketje → KB ticket not found', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-b', { id: 'agent-b', name: 'B-Wiki', role: 'worker', tenantId: TENANT_B })
    const doc = seedDoc(documents, 'b-doc2.md')
    const ticket = await kb.requestDocument({
      agentId: 'agent-b',
      documentId: doc.id,
      createdById: 'user-b',
      actorTenantId: TENANT_B,
    })
    await assert.rejects(
      kb.rejectDocument({
        ticketId: ticket.id,
        approverId: 'approver-a',
        approverRole: 'approver',
        actorTenantId: TENANT_A,
      }),
      /KB ticket not found/,
    )
    assert.equal(documents.get(doc.id)?.status, 'uploaded')
  })

  // ── olvasási utak (adat-disclosure) ──────────────────────────────────────
  await check('getArtifactReview: cross-tenant agent → Agent not found (nincs tartalom-szivárgás)', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-b', { id: 'agent-b', name: 'B-Wiki', role: 'worker', tenantId: TENANT_B })
    const doc = seedDoc(documents, 'b-titok.md')
    await assert.rejects(
      kb.getArtifactReview({ agentId: 'agent-b', documentId: doc.id, actorTenantId: TENANT_A }),
      /Agent not found/,
    )
  })

  await check('listPendingDocuments: cross-tenant agent → Agent not found', async () => {
    const { kb, agents } = makeFakes()
    agents.set('agent-b', { id: 'agent-b', name: 'B-Wiki', role: 'worker', tenantId: TENANT_B })
    await assert.rejects(
      kb.listPendingDocuments('agent-b', TENANT_A),
      /Agent not found/,
    )
  })

  await check('listPendingArtifacts: cross-tenant agent → Agent not found', async () => {
    const { kb, agents } = makeFakes()
    agents.set('agent-b', { id: 'agent-b', name: 'B-Wiki', role: 'worker', tenantId: TENANT_B })
    await assert.rejects(
      kb.listPendingArtifacts('agent-b', TENANT_A),
      /Agent not found/,
    )
  })

  console.log(failures === 0 ? '\n✅ minden teszt zöld' : `\n❌ ${failures} teszt bukott`)
  if (failures > 0) process.exit(1)
}

run()
