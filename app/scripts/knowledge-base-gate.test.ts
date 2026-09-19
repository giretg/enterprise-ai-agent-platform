/**
 * Knowledge-base ingest: raw file vs OKF wiki, tenant isolation.
 * Futtatás: npm run test:kb-gate
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Connector, Document, KnowledgeArtifact, KnowledgeChunk } from '@prisma/client'
import { KnowledgeBaseService } from '../src/domain/knowledge-base/knowledge-base-service'
import type {
  AgentRepository,
  AuditRepository,
  ConnectorRepository,
  DocumentRepository,
  KnowledgeArtifactRepository,
  KnowledgeChunkRepository,
} from '../src/repositories/interfaces'

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = '11111111-1111-4111-8111-111111111111'

let failures = 0
function check(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  OK  ${name}`))
    .catch((e) => {
      failures++
      console.log(`  FAIL ${name}: ${e instanceof Error ? e.message : e}`)
    })
}

function makeFakes() {
  const documents = new Map<string, Document>()
  const artifacts = new Map<string, KnowledgeArtifact>()
  const chunks = new Map<string, KnowledgeChunk>()
  const connectors = new Map<string, Connector>()
  const agents = new Map<string, { id: string; name: string; tenantId: string }>()
  const audits: Array<{ action: string; tenantId?: string | null }> = []

  const documentRepo = {
    async create(data: Record<string, unknown>) {
      const doc = {
        id: randomUUID(),
        createdAt: new Date(),
        storageRef: null,
        metadata: {},
        ...data,
      } as unknown as Document
      documents.set(doc.id, doc)
      return doc
    },
    async findById(id: string) {
      return documents.get(id) ?? null
    },
    async findByConnectorId(connectorId: string) {
      return [...documents.values()].filter(
        (doc) => doc.connectorId === connectorId && doc.status === 'processed',
      )
    },
    async listByConnectorId(connectorId: string) {
      return [...documents.values()].filter((doc) => doc.connectorId === connectorId)
    },
    async update(id: string, data: Record<string, unknown>) {
      const doc = documents.get(id)
      if (!doc) throw new Error('missing')
      const next = { ...doc, ...data } as Document
      documents.set(id, next)
      return next
    },
    async delete(id: string) {
      documents.delete(id)
    },
  } as unknown as DocumentRepository

  const artifactRepo = {
    async create(data: Record<string, unknown>) {
      const row = {
        id: randomUUID(),
        createdAt: new Date(),
        format: 'okf',
        ...data,
      } as unknown as KnowledgeArtifact
      artifacts.set(row.id, row)
      return row
    },
    async findById(id: string) {
      return artifacts.get(id) ?? null
    },
    async findByConnector(connectorId: string, status?: string) {
      return [...artifacts.values()].filter(
        (row) => row.connectorId === connectorId && (!status || row.status === status),
      )
    },
    async publishedSourceDocumentIds(connectorIds: string[]) {
      return new Set(
        [...artifacts.values()]
          .filter(
            (row) =>
              connectorIds.includes(row.connectorId) &&
              row.status === 'published' &&
              row.sourceDocumentId,
          )
          .map((row) => row.sourceDocumentId as string),
      )
    },
    async deleteBySourceDocumentId(documentId: string) {
      for (const [id, row] of artifacts) {
        if (row.sourceDocumentId === documentId) {
          artifacts.delete(id)
          for (const [chunkId, chunk] of chunks) {
            if (chunk.artifactId === id) chunks.delete(chunkId)
          }
        }
      }
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
    async searchChunks() {
      return []
    },
    async listIndex() {
      return []
    },
    async getPageChunks() {
      return []
    },
    async deleteByArtifact(artifactId: string) {
      for (const [id, chunk] of chunks) if (chunk.artifactId === artifactId) chunks.delete(id)
    },
  } as unknown as KnowledgeChunkRepository

  const agentRepo = {
    async findById(id: string, tenantId?: string) {
      const agent = agents.get(id)
      if (!agent) return null
      if (tenantId && agent.tenantId !== tenantId) return null
      return agent
    },
    async upsertConnectorBinding() {},
  } as unknown as AgentRepository

  const connectorRepo = {
    async findByTenantTypeAndName(tenantId: string, type: string, name: string) {
      return (
        [...connectors.values()].find(
          (row) => row.tenantId === tenantId && row.type === type && row.name === name,
        ) ?? null
      )
    },
    async create(data: Record<string, unknown>) {
      const row = { id: randomUUID(), createdAt: new Date(), ...data } as unknown as Connector
      connectors.set(row.id, row)
      return row
    },
  } as unknown as ConnectorRepository

  const auditRepo = {
    async append(data: { action: string; tenantId?: string | null }) {
      audits.push(data)
      return data
    },
  } as unknown as AuditRepository

  const kb = new KnowledgeBaseService({
    documents: documentRepo,
    artifacts: artifactRepo,
    chunks: chunkRepo,
    agents: agentRepo,
    connectors: connectorRepo,
    audit: auditRepo,
  })

  return { kb, documents, artifacts, chunks, connectors, agents, audits }
}

async function run() {
  console.log('=== KB ingest (raw / OKF) teszt ===')

  await check('raw_text_only: dokumentum azonnal kereshető, nincs wiki-artifact', async () => {
    const { kb, documents, artifacts, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', tenantId: TENANT_A })
    const result = await kb.ingest({
      tenantId: TENANT_A,
      agentId: 'agent-1',
      uploadedById: USER_ID,
      filename: 'szabalyzat.md',
      buffer: Buffer.from('# Távmunka\nOtthonról is lehet dolgozni.'),
      processingMode: 'raw_text_only',
    })
    assert.equal(result.searchable, true)
    assert.equal(result.processingMode, 'raw_text_only')
    assert.equal(result.artifactId, null)
    assert.equal(result.chunkCount, 0)
    const doc = documents.get(result.documentId)
    assert.equal(doc?.status, 'processed')
    assert.ok(doc?.connectorId)
    assert.equal(artifacts.size, 0)
  })

  await check('okf: published artifact + chunkok, tenant-idegen agent nem látszik', async () => {
    const { kb, artifacts, chunks, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', tenantId: TENANT_A })
    const result = await kb.ingest({
      tenantId: TENANT_A,
      agentId: 'agent-1',
      uploadedById: USER_ID,
      filename: 'policy.md',
      buffer: Buffer.from('# Remote Work\nAllowed.\n\n# Onboarding\nHR handles it.'),
      processingMode: 'okf',
    })
    assert.ok(result.artifactId)
    assert.equal(result.chunkCount > 0, true)
    assert.equal([...artifacts.values()][0]?.status, 'published')
    assert.equal(chunks.size, result.chunkCount)

    await assert.rejects(
      () =>
        kb.ingest({
          tenantId: TENANT_B,
          agentId: 'agent-1',
          uploadedById: USER_ID,
          filename: 'x.md',
          buffer: Buffer.from('secret'),
          processingMode: 'raw_text_only',
        }),
      /Agent not found/,
    )
  })

  await check('delete only removes the agent own document', async () => {
    const { kb, documents, agents } = makeFakes()
    agents.set('agent-1', { id: 'agent-1', name: 'Wiki', tenantId: TENANT_A })
    const ingested = await kb.ingest({
      tenantId: TENANT_A,
      agentId: 'agent-1',
      uploadedById: USER_ID,
      filename: 'drop.md',
      buffer: Buffer.from('bye'),
      processingMode: 'raw_text_only',
    })
    await kb.deleteDocument({
      tenantId: TENANT_A,
      agentId: 'agent-1',
      documentId: ingested.documentId,
      actorId: USER_ID,
    })
    assert.equal(documents.size, 0)
  })

  console.log(failures === 0 ? '\nkb-gate: ok' : `\nkb-gate: ${failures} failed`)
  if (failures > 0) process.exit(1)
}

void run()
