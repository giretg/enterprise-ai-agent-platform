/**
 * #943 LLM Wiki 2/6: MCP-eszközök — beküldés, wiki-írás, tálca-feldolgozás.
 * A teljes út `invokeEnterpriseTool` + a valódi gateway jóváhagyási sor felett,
 * in-memory repókkal. Futtatás: npm run test:kb-wiki
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- a tool-válasz szabad alakú JSON */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type { Agent, Connector, Document, KnowledgeArtifact, WikiChangeSet, WikiLogEntry, WikiPage, WikiPageRevision } from '@prisma/client'
import type { AgentDefinition, AgentDefinitionSnapshot } from '../src/domain/agent-definition'
import {
  invokeEnterpriseTool,
  type EnterpriseToolDeps,
  type EnterpriseToolMcpResult,
  type ToolCallPrincipal,
} from '../src/domain/enterprise-tools'
import { executeKnowledgeBaseTool, executeWikiTool } from '../src/domain/enterprise-tools/handlers/knowledge-base'
import {
  approveGatewayOperation,
  enqueueWriteForMcp,
  rejectGatewayOperation,
  type GatewayOperationServiceDeps,
} from '../src/domain/gateway-operation'
import { KnowledgeBaseService } from '../src/domain/knowledge-base/knowledge-base-service'
import { WikiService } from '../src/domain/knowledge-base/wiki-service'
import { appendToSection, extractWikiLinks, renderWikiIndex, replaceSection } from '../src/lib/kb-wiki'
import { effectiveInboxStatus, scopeSnapshotConnectorsToUser } from '../src/lib/wiki-access'
import type {
  WikiApplyChangeSetInput,
  WikiApplyChangeSetResult,
  WikiInboxCounts,
  WikiInboxItem,
  WikiRepository,
} from '../src/repositories/interfaces'
import { MemoryGatewayOperationStore } from './memory-gateway-operation-store'

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER_USER = '22222222-2222-4222-8222-222222222222'
const APPROVER = '33333333-3333-4333-8333-333333333333'
const AGENT_A = '44444444-4444-4444-8444-444444444444'
const AGENT_B = '55555555-5555-4555-8555-555555555555'
const AGENT_C = '66666666-6666-4666-8666-666666666666'
const KB_A = '77777777-7777-4777-8777-777777777777'
const KB_SHARED = '88888888-8888-4888-8888-888888888888'
const KB_PRIV = '99999999-9999-4999-8999-999999999999'
const DEF_A = 'a0000000-0000-4000-8000-00000000000a'
const DEF_B = 'b0000000-0000-4000-8000-00000000000b'
const DEF_C = 'c0000000-0000-4000-8000-00000000000c'

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

// ---------------------------------------------------------------------------
// In-memory világ

let clock = new Date('2026-10-23T08:00:00Z')
const now = () => new Date(clock.getTime())
const advance = (ms: number) => {
  clock = new Date(clock.getTime() + ms)
}

function connectorRow(id: string, name: string, extra: Partial<Connector> = {}): Connector {
  return {
    id,
    tenantId: TENANT,
    type: 'knowledge_base',
    name,
    authMode: 'agent_owned',
    scope: 'single',
    lifecycleState: 'active',
    config: {},
    visibility: 'shared',
    ownerUserId: null,
    approverUserId: null,
    kbLanguage: 'hu',
    ...extra,
  } as unknown as Connector
}

const connectors = new Map<string, Connector>([
  [KB_A, connectorRow(KB_A, `kb:${AGENT_A}`)],
  [KB_SHARED, connectorRow(KB_SHARED, 'Közös tudástár', { approverUserId: APPROVER } as Partial<Connector>)],
  [KB_PRIV, connectorRow(KB_PRIV, `kb:private:${randomUUID()}`, {
    visibility: 'private_to_user',
    ownerUserId: OWNER,
    config: { displayName: 'Leleteim' },
  } as Partial<Connector>)],
])

const agents = new Map<string, Agent>(
  [
    [AGENT_A, 'Anna'],
    [AGENT_B, 'Béla'],
    [AGENT_C, 'Cili'],
  ].map(([id, name]) => [id, { id, name, tenantId: TENANT, approverUserId: id === AGENT_A ? APPROVER : null } as unknown as Agent]),
)

const documents = new Map<string, Document>()
const artifacts = new Map<string, KnowledgeArtifact>()
type Chunk = { artifactId: string; connectorId: string; path: string; title: string; type: string; section: string | null; chunkIndex: number; text: string; sourceRef: unknown }
let chunks: Chunk[] = []

const documentRepo = {
  async create(data: Record<string, unknown>) {
    const row = {
      id: randomUUID(),
      storageRef: null,
      kbLanguageOverride: null,
      wikiStatus: null,
      wikiSubmittedByAgentId: null,
      wikiClaimedByAgentId: null,
      wikiClaimExpiresAt: null,
      wikiProcessedByChangeSetId: null,
      wikiBatchId: null,
      wikiBatchSeq: null,
      createdAt: now(),
      ...data,
    } as unknown as Document
    documents.set(row.id, row)
    return row
  },
  async createSource(data: Record<string, unknown>) {
    const existing = [...documents.values()].find(
      (doc) => doc.connectorId === data.connectorId && doc.contentHash === data.contentHash,
    )
    return { document: existing ?? await this.create(data), duplicate: !!existing }
  },
  async readSource() {
    return null
  },
  async findById(id: string) {
    return documents.get(id) ?? null
  },
  async update(id: string, data: Record<string, unknown>) {
    const current = documents.get(id)
    if (!current) throw new Error('not_found')
    const next = { ...current, ...data } as Document
    documents.set(id, next)
    return next
  },
  async searchRaw() {
    return []
  },
  async listCatalog(connectorId: string) {
    return [...documents.values()]
      .filter((doc) => doc.connectorId === connectorId)
      .map((doc) => ({ id: doc.id, filename: doc.filename, processingMode: doc.processingMode, metadata: doc.metadata, chars: doc.extractedText?.length ?? 0 }))
  },
}

const artifactRepo = {
  async create(data: Record<string, unknown>) {
    const row = { id: randomUUID(), createdAt: now(), format: 'okf', ...data } as unknown as KnowledgeArtifact
    artifacts.set(row.id, row)
    return row
  },
  async findByConnector(connectorId: string, status?: string) {
    return [...artifacts.values()].filter((row) => row.connectorId === connectorId && (!status || row.status === status))
  },
  async publishedSourceDocumentIds() {
    return new Set<string>()
  },
}

const chunkRepo = {
  async createMany(rows: Chunk[]) {
    chunks.push(...rows)
    return rows.length
  },
  async searchChunks(connectorIds: string[], query: string, limit: number) {
    const q = query.toLowerCase()
    return chunks
      .filter((c) => connectorIds.includes(c.connectorId) && artifacts.get(c.artifactId)?.status === 'published')
      .filter((c) => `${c.title} ${c.text}`.toLowerCase().includes(q))
      .slice(0, limit)
      .map((c) => ({ ...c, score: 1, matched: [q] }))
  },
  async listIndex(connectorIds: string[]) {
    return chunks.filter((c) => connectorIds.includes(c.connectorId)).map((c) => ({ artifactId: c.artifactId, connectorId: c.connectorId, path: c.path, title: c.title, type: c.type }))
  },
  async getPageChunks() {
    return []
  },
}

class MemoryWikiRepository implements Partial<WikiRepository> {
  wikis = new Map<string, { id: string; connectorId: string; schemaMd: string; lastLint: null; createdAt: Date; updatedAt: Date }>()
  pages = new Map<string, WikiPage>()
  revisions: WikiPageRevision[] = []
  changeSets = new Map<string, WikiChangeSet>()
  log: WikiLogEntry[] = []

  async findById(id: string) {
    return this.wikis.get(id) ?? null
  }
  async findByConnectorId(connectorId: string) {
    return [...this.wikis.values()].find((w) => w.connectorId === connectorId) ?? null
  }
  async ensureForConnector(input: { connectorId: string; schemaMd: string }) {
    const existing = await this.findByConnectorId(input.connectorId)
    if (existing) return existing
    const row = { id: randomUUID(), connectorId: input.connectorId, schemaMd: input.schemaMd, lastLint: null, createdAt: now(), updatedAt: now() }
    this.wikis.set(row.id, row)
    return row
  }
  async findPage(connectorId: string, path: string) {
    return [...this.pages.values()].find((p) => p.connectorId === connectorId && p.path === path) ?? null
  }
  async listPages(connectorId: string, filter: { status?: string } = {}) {
    return [...this.pages.values()]
      .filter((p) => p.connectorId === connectorId && (!filter.status || p.status === filter.status))
      .sort((a, b) => a.path.localeCompare(b.path))
  }
  async listRevisions(pageId: string) {
    return this.revisions.filter((r) => r.pageId === pageId).sort((a, b) => b.version - a.version)
  }
  async createChangeSet(input: Parameters<WikiRepository['createChangeSet']>[0]) {
    const row = {
      id: randomUUID(),
      gatewayOperationId: null,
      createdAt: now(),
      appliedAt: null,
      status: 'pending',
      agentId: null,
      userId: null,
      validation: null,
      logEntry: null,
      sourceDocumentIds: [],
      inboxItemId: null,
      ...input,
    } as unknown as WikiChangeSet
    this.changeSets.set(row.id, row)
    return row
  }
  async findChangeSet(id: string) {
    return this.changeSets.get(id) ?? null
  }
  async transitionChangeSet(id: string, from: string, to: string, extra: { gatewayOperationId?: string | null } = {}) {
    const row = this.changeSets.get(id)
    if (!row || row.status !== from) return null
    const next = { ...row, status: to, ...(extra.gatewayOperationId !== undefined ? { gatewayOperationId: extra.gatewayOperationId } : {}) } as WikiChangeSet
    this.changeSets.set(id, next)
    return next
  }
  async listLog(wikiId: string) {
    return this.log.filter((l) => l.wikiId === wikiId)
  }
  async listInbox(connectorIds: string[], input: { now: Date; batchId?: string }): Promise<WikiInboxItem[]> {
    return [...documents.values()]
      .filter((d) => d.connectorId && connectorIds.includes(d.connectorId) && (!input.batchId || d.wikiBatchId === input.batchId))
      .map((d) => ({ d, status: effectiveInboxStatus(d, input.now) }))
      .filter((row) => row.status === 'pending' || row.status === 'in_progress')
      .map(({ d, status }) => ({
        documentId: d.id,
        connectorId: d.connectorId!,
        filename: d.filename,
        purpose: null,
        status: status as 'pending' | 'in_progress',
        uploadedById: d.uploadedById,
        submittedByAgentId: d.wikiSubmittedByAgentId,
        claimedByAgentId: status === 'in_progress' ? d.wikiClaimedByAgentId : null,
        claimExpiresAt: status === 'in_progress' ? d.wikiClaimExpiresAt : null,
        batchId: d.wikiBatchId,
        batchSeq: d.wikiBatchSeq,
        createdAt: d.createdAt,
      }))
  }
  async inboxSummary(connectorIds: string[], input: { now: Date; batchId?: string }) {
    const wikis = new Map<string, { connectorId: string } & WikiInboxCounts>()
    const batches = new Map<string, { connectorId: string; batchId: string } & WikiInboxCounts>()
    const add = (c: WikiInboxCounts, s: string) => {
      if (s === 'pending') c.pending++
      else if (s === 'in_progress') c.inProgress++
      else if (s === 'processed') c.processed++
      else if (s === 'skipped') c.skipped++
    }
    for (const d of documents.values()) {
      if (!d.connectorId || !connectorIds.includes(d.connectorId) || !d.wikiStatus) continue
      if (input.batchId && d.wikiBatchId !== input.batchId) continue
      const status = effectiveInboxStatus(d, input.now)!
      const w = wikis.get(d.connectorId) ?? { connectorId: d.connectorId, pending: 0, inProgress: 0, processed: 0, skipped: 0 }
      add(w, status)
      wikis.set(d.connectorId, w)
      if (d.wikiBatchId) {
        const b = batches.get(d.wikiBatchId) ?? { connectorId: d.connectorId, batchId: d.wikiBatchId, pending: 0, inProgress: 0, processed: 0, skipped: 0 }
        add(b, status)
        batches.set(d.wikiBatchId, b)
      }
    }
    return { wikis: [...wikis.values()], batches: [...batches.values()] }
  }
  async submitToInbox(input: Parameters<WikiRepository['submitToInbox']>[0]) {
    const d = documents.get(input.documentId)!
    documents.set(d.id, {
      ...d,
      wikiStatus: input.status,
      wikiSubmittedByAgentId: input.submittedByAgentId ?? null,
      wikiClaimedByAgentId: input.status === 'in_progress' ? (input.claimedByAgentId ?? null) : null,
      wikiClaimExpiresAt: input.status === 'in_progress' ? (input.claimExpiresAt ?? null) : null,
      wikiBatchId: input.batchId ?? null,
      wikiBatchSeq: input.batchSeq ?? null,
    })
  }
  async claimInboxItem(input: { documentId: string; connectorId: string; agentId: string; now: Date; expiresAt: Date }) {
    const d = documents.get(input.documentId)
    if (!d || d.connectorId !== input.connectorId) return false
    const ok =
      d.wikiStatus === 'pending' ||
      (d.wikiStatus === 'in_progress' && (!d.wikiClaimExpiresAt || d.wikiClaimExpiresAt <= input.now || d.wikiClaimedByAgentId === input.agentId))
    if (!ok) return false
    documents.set(d.id, { ...d, wikiStatus: 'in_progress', wikiClaimedByAgentId: input.agentId, wikiClaimExpiresAt: input.expiresAt })
    return true
  }
  async markInboxProcessed(input: { documentId: string; changeSetId: string }) {
    const d = documents.get(input.documentId)
    if (!d || (d.wikiStatus !== 'pending' && d.wikiStatus !== 'in_progress')) return false
    documents.set(d.id, { ...d, wikiStatus: 'processed', wikiProcessedByChangeSetId: input.changeSetId, wikiClaimedByAgentId: null, wikiClaimExpiresAt: null })
    return true
  }
  async reopenInboxItem(input: { documentId: string; changeSetId: string }) {
    const d = documents.get(input.documentId)
    if (!d || d.wikiStatus !== 'processed' || d.wikiProcessedByChangeSetId !== input.changeSetId) return false
    documents.set(d.id, { ...d, wikiStatus: 'pending', wikiProcessedByChangeSetId: null })
    return true
  }
  async findContainerArtifactId(connectorId: string) {
    return [...artifacts.values()].find((a) => a.connectorId === connectorId && a.format === 'llm_wiki')?.id ?? null
  }
  async applyChangeSet(input: WikiApplyChangeSetInput): Promise<WikiApplyChangeSetResult> {
    // Tranzakció: másolatokon dolgozunk, a végén egyben véglegesítünk.
    const pages = new Map(this.pages)
    let changeSetId: string
    if ('id' in input.changeSet) {
      const cs = this.changeSets.get(input.changeSet.id)
      if (!cs || cs.status !== 'pending') return { ok: false, reason: 'changeset_not_pending' }
      changeSetId = cs.id
    } else {
      changeSetId = randomUUID()
    }
    let container = [...artifacts.values()].find((a) => a.connectorId === input.connectorId && a.format === 'llm_wiki')
    const newRevisions: WikiPageRevision[] = []
    let newChunks = [...chunks]
    const out: WikiPage[] = []
    const containerId = container?.id ?? randomUUID()
    for (const op of input.ops) {
      let page: WikiPage
      if (op.kind === 'create') {
        if ([...pages.values()].some((p) => p.connectorId === input.connectorId && p.path === op.page.path)) {
          return { ok: false, reason: 'conflict', path: op.page.path }
        }
        page = {
          id: randomUUID(),
          wikiId: input.wikiId,
          connectorId: input.connectorId,
          category: null,
          frontmatter: {},
          sourceRefs: [],
          outLinks: [],
          status: 'published',
          ...op.page,
          version: 1,
          createdByAgentId: op.createdByAgentId ?? null,
          createdByUserId: op.createdByUserId ?? null,
          updatedByAgentId: op.createdByAgentId ?? null,
          createdAt: now(),
          updatedAt: now(),
        } as unknown as WikiPage
      } else {
        const current = pages.get(op.pageId)
        if (!current || current.version !== op.expectedVersion) return { ok: false, reason: 'conflict', path: op.previousPath }
        page = { ...current, ...op.page, version: current.version + 1, updatedByAgentId: op.updatedByAgentId ?? null, updatedAt: now() } as unknown as WikiPage
      }
      pages.set(page.id, page)
      const drop = new Set(op.kind === 'update' ? [op.previousPath, page.path] : [page.path])
      newChunks = newChunks.filter((c) => !(c.artifactId === containerId && drop.has(c.path)))
      newChunks.push(...op.chunks.map((c) => ({ ...c, artifactId: containerId, connectorId: input.connectorId })))
      newRevisions.push({ id: randomUUID(), pageId: page.id, changeSetId, version: page.version, title: page.title, summary: page.summary, body: page.body, frontmatter: page.frontmatter, contentHash: page.contentHash, createdAt: now() } as WikiPageRevision)
      out.push(page)
    }
    // commit
    if (!container) {
      container = { id: containerId, connectorId: input.connectorId, format: 'llm_wiki', status: 'published', createdAt: now() } as unknown as KnowledgeArtifact
      artifacts.set(containerId, container)
    }
    this.pages = pages
    this.revisions.push(...newRevisions)
    chunks = newChunks
    if ('id' in input.changeSet) {
      this.changeSets.set(changeSetId, { ...this.changeSets.get(changeSetId)!, status: 'applied', appliedAt: input.appliedAt })
    } else {
      this.changeSets.set(changeSetId, { id: changeSetId, ...input.changeSet.create, status: 'applied', appliedAt: input.appliedAt, createdAt: now(), gatewayOperationId: null } as unknown as WikiChangeSet)
    }
    this.log.push({ id: randomUUID(), wikiId: input.wikiId, changeSetId, createdAt: now(), note: null, ...input.log } as unknown as WikiLogEntry)
    if (input.inbox) {
      const d = documents.get(input.inbox.documentId)
      if (d && (d.wikiStatus === 'pending' || d.wikiStatus === 'in_progress')) {
        documents.set(d.id, input.inbox.final
          ? { ...d, wikiStatus: 'processed', wikiProcessedByChangeSetId: changeSetId, wikiClaimedByAgentId: null, wikiClaimExpiresAt: null }
          : { ...d, wikiStatus: 'in_progress', wikiClaimedByAgentId: input.inbox.agentId, wikiClaimExpiresAt: input.inbox.claimExpiresAt })
      }
    }
    return { ok: true, changeSetId, pages: out }
  }
}

const wikis = new MemoryWikiRepository()
const auditLog: Array<{ action: string; actorType: string; metadata: unknown }> = []
const audit = { async append(data: { action: string; actorType: string; metadata?: unknown }) { auditLog.push({ action: data.action, actorType: data.actorType, metadata: data.metadata }) } }

const connectorRepo = {
  async findById(id: string, tenantId?: string) {
    const row = connectors.get(id)
    return row && (!tenantId || row.tenantId === tenantId) ? row : null
  },
  async findByTenantTypeAndName() {
    return null
  },
  async create() {
    throw new Error('not used')
  },
}
const agentRepo = {
  async findById(id: string) {
    return agents.get(id) ?? null
  },
  async upsertConnectorBinding() {},
}

const kbService = new KnowledgeBaseService({
  documents: documentRepo as never,
  artifacts: artifactRepo as never,
  chunks: chunkRepo as never,
  agents: agentRepo as never,
  connectors: connectorRepo as never,
  audit: audit as never,
})
const wikiService = new WikiService({
  wikis: wikis as unknown as WikiRepository,
  documents: documentRepo as never,
  connectors: connectorRepo as never,
  agents: agentRepo as never,
  knowledgeBase: kbService,
  audit: audit as never,
  findUserLabel: async (id) => (id === OWNER ? 'Olga Owner' : null),
  now,
})

// ---------------------------------------------------------------------------
// Definíciók

const KB_CAPS = ['kb_search', 'kb_list_index', 'kb_get_page', 'kb_get_document', 'kb_ingest'].map((toolName) => ({ toolName, allowed: true }))
type SnapConn = AgentDefinitionSnapshot['connectors'][number]

const definitions = new Map<string, AgentDefinition>()
function define(definitionId: string, agentId: string, conns: SnapConn[]) {
  definitions.set(definitionId, {
    definitionId,
    agentId,
    version: 1,
    tenantId: TENANT,
    status: 'active',
    publishedAt: new Date(0).toISOString(),
    snapshot: { name: agentId, roleInstruction: '', skills: [], connectors: conns, capabilities: KB_CAPS },
  })
}
define(DEF_A, AGENT_A, [
  { connectorId: KB_A, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct' },
  { connectorId: KB_SHARED, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write' },
  { connectorId: KB_PRIV, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct', visibility: 'private_to_user', ownerUserId: OWNER },
])
define(DEF_B, AGENT_B, [{ connectorId: KB_A, type: 'knowledge_base', accessMode: 'read', wikiAccess: 'submit' }])
define(DEF_C, AGENT_C, [{ connectorId: KB_A, type: 'knowledge_base', accessMode: 'write', wikiAccess: 'write', wikiWriteMode: 'direct' }])
const currentDefinition: Record<string, string> = { [AGENT_A]: DEF_A, [AGENT_B]: DEF_B, [AGENT_C]: DEF_C }

const roles: Record<string, string> = { [OWNER]: 'member', [OTHER_USER]: 'member', [APPROVER]: 'approver' }
const principal = (userId: string): ToolCallPrincipal => ({ userId, tenantId: TENANT, role: roles[userId], assumed: false })

const operations = new MemoryGatewayOperationStore()
const shared = {
  async loadDefinition({ definitionId }: { definitionId: string }) {
    return definitions.get(definitionId) ?? null
  },
  async findCurrentDefinitionId({ agentId }: { agentId: string }) {
    return currentDefinition[agentId] ?? null
  },
  async findAgentGrant() {
    return { accessLevel: 'operate' }
  },
  async resolveAccessToken(): Promise<string> {
    throw new Error('no tokens for knowledge bases')
  },
  async findConnector(id: string) {
    const row = connectors.get(id)
    return row ? { ...row, authMode: row.authMode, lifecycleState: row.lifecycleState } : null
  },
  async findActiveGrant() {
    return null
  },
  audit: audit as never,
}

const gatewayDeps: GatewayOperationServiceDeps = {
  ...shared,
  operations,
  async resolveRequester({ userId }) {
    return { role: roles[userId], assumed: false }
  },
  async resolveDesignatedApprover({ tenantId, connectorId }) {
    if (!connectorId) return null
    const scope = await wikiService.approverScopeForConnector(tenantId, connectorId)
    const userId = scope ? (scope.kind === 'owner_user' ? scope.userId : scope.approverUserId) : null
    return userId ? { userId, name: userId === APPROVER ? 'Ádám Approver' : 'Olga Owner' } : null
  },
  wikiChangeSets: {
    canDecide: ({ actor, changeSetId }) => wikiService.canDecide(actor, changeSetId),
    apply: ({ requester, definition, changeSetId }) =>
      wikiService.applyApproved(
        {
          tenantId: requester.tenantId,
          userId: requester.userId,
          agentId: definition.agentId,
          snapshot: { connectors: scopeSnapshotConnectorsToUser(definition.snapshot.connectors, requester.userId) },
        },
        changeSetId,
      ),
    reject: async ({ tenantId, changeSetId, actorUserId }) => {
      await wikiService.reject(changeSetId, { tenantId, actorUserId })
    },
  },
}

const toolDeps: EnterpriseToolDeps = {
  ...shared,
  executeKbTool: (toolName, args, ctx) => executeKnowledgeBaseTool(kbService, toolName, args, ctx, wikiService),
  executeWikiTool: (toolName, args, ctx) => executeWikiTool(wikiService, toolName, args, ctx),
  resolveKbConnector: async ({ wikiId, documentId }) => {
    const connectorId = wikiId ? (await wikis.findById(wikiId))?.connectorId : documentId ? documents.get(documentId)?.connectorId : null
    return connectorId ?? null
  },
  onWikiApprovalQueued: async ({ tenantId, changeSetId, operationId }) => {
    if (operationId) await wikis.transitionChangeSet(changeSetId, 'pending', 'pending', { gatewayOperationId: operationId })
    else await wikiService.reject(changeSetId, { tenantId, actorUserId: null })
  },
  enqueueWrite: (input) => enqueueWriteForMcp(gatewayDeps, input),
}

async function call(userId: string, definitionId: string, toolName: string, args: Record<string, unknown>) {
  const result = (await invokeEnterpriseTool(toolDeps, {
    principal: principal(userId),
    toolName,
    args: { definitionId, ...args },
    origin: 'https://platform.test',
  })) as EnterpriseToolMcpResult
  const payload = JSON.parse(result.content[0].text) as Record<string, any>
  return { isError: !!result.isError, ...payload }
}

const md = (text: string) => ({ filename: 'forras.md', content: text })

// ---------------------------------------------------------------------------

async function main() {
  console.info = () => {}
  console.log('=== #943 LLM Wiki MCP-eszközök ===')
  // D3: a teljes út nem hívhat szerveroldali modellt (Model Gateway / külső HTTP).
  let fetchCalls = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCalls++
    throw new Error('network disabled in test')
  }) as typeof fetch

  const wikiIdOf = async (connectorId: string) => (await wikiService.wikiIdForConnector(TENANT, connectorId))!
  const WIKI_A = await wikiIdOf(KB_A)
  const WIKI_SHARED = await wikiIdOf(KB_SHARED)
  const WIKI_PRIV = await wikiIdOf(KB_PRIV)

  await check('kb-wiki: appendToSection táblázat végére, replaceSection, linkek', () => {
    const body = '# Teya\n\n## Díjak\n\n| Kártya | Díj |\n|---|---|\n| Hazai | 0,9% |\n\n## Kapcsolódó\n\n- [[concepts/interchange]]'
    const added = appendToSection(body, 'Díjak', '| Külföldi | 1,5% |')
    assert.match(added, /\| Hazai \| 0,9% \|\n\| Külföldi \| 1,5% \|\n\n## Kapcsolódó/)
    assert.equal(replaceSection(body, 'Hiányzó', 'x'), null)
    assert.match(replaceSection(body, 'Kapcsolódó', '- semmi')!, /## Kapcsolódó\n\n- semmi\n$/)
    assert.deepEqual(extractWikiLinks('[[entities/teya]] és [x](../concepts/a.md) és [k](https://a.hu/b.md)', 'sources/s.md'), [
      'concepts/a.md',
      'entities/teya.md',
    ])
    assert.equal(
      renderWikiIndex([{ path: 'b.md', title: 'B', summary: 's', category: null, type: 'entity' }, { path: 'a.md', title: 'A', summary: 's', category: 'X', type: 'entity' }]),
      '# Index\n\n2 pages.\n\n## X\n\n- [[a]] — A: s\n\n## Uncategorized\n\n- [[b]] — B: s\n',
    )
  })

  await check('#945 selected health template initializes once in the KB language', async () => {
    const id = randomUUID()
    connectors.set(id, connectorRow(id, 'Health', { kbLanguage: 'en', config: { wikiTemplate: 'health-journal' } }))
    const wikiId = await wikiService.wikiIdForConnector(TENANT, id)
    const schema = (await wikis.findById(wikiId!))!.schemaMd
    assert.match(schema, /# Wiki rules — Health journal/)
    assert.match(schema, /labs\/<parameter>\.md/)
    assert.match(schema, /## Facts/)
    connectors.get(id)!.config = { wikiTemplate: 'general' }
    await wikiService.wikiIdForConnector(TENANT, id)
    assert.equal((await wikis.findById(wikiId!))!.schemaMd, schema, 'existing schema remains intact')
  })

  let sourceDoc = ''
  let teyaVersion = ''
  await check('1. direct: kb_ingest wiki → kb_wiki_write → olvasható, kereshető, index + log, processed', async () => {
    const ingest = await call(OWNER, DEF_A, 'kb_ingest', { ...md('# Teya árlista\n\n## Díjak\nHazai kártya 0,9%.'), processingMode: 'wiki', wikiId: WIKI_A })
    assert.equal(ingest.isError, false, JSON.stringify(ingest))
    assert.equal(ingest.status, 'in_progress')
    assert.equal(ingest.inboxItemId, ingest.documentId)
    assert.deepEqual(ingest.outline, ['Teya árlista', 'Díjak'])
    assert.match(ingest.nextStep, /kb_wiki_write/)
    sourceDoc = ingest.documentId
    assert.equal(documents.get(sourceDoc)!.wikiClaimedByAgentId, AGENT_A)

    const write = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      sourceDocumentIds: [sourceDoc],
      inboxItemId: sourceDoc,
      logEntry: { op: 'ingest', title: 'Teya árlista 2026' },
      pages: [
        { path: 'sources/teya-arlista-2026.md', action: 'upsert', type: 'source', title: 'Teya árlista 2026', summary: 'Díjak 2026', category: 'Források', frontmatter: { source_date: '2026-01-15' }, body: '## Díjak\n\nHazai: 0,9% ([[entities/teya]])' },
        { path: 'entities/teya.md', action: 'upsert', type: 'entity', title: 'Teya Hungary', summary: 'Kártyaelfogadó', category: 'Szolgáltatók', frontmatter: { sources: [{ documentId: sourceDoc }] }, body: '## Díjak\n\n| Kártya | Díj |\n|---|---|\n| Hazai | 0,9% |' },
        { path: 'entities/excellence-pay.md', action: 'upsert', type: 'entity', title: 'Excellence Pay', summary: 'Partner', category: 'Szolgáltatók', body: '## Kapcsolat\n\nPartner ([[entities/teya]])' },
      ],
    })
    assert.equal(write.isError, false, JSON.stringify(write))
    assert.equal(write.status, 'applied')
    assert.equal(write.inboxStatus, 'processed')
    assert.equal(documents.get(sourceDoc)!.wikiStatus, 'processed')

    const page = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_A, path: 'entities/teya.md' })
    assert.equal(page.kind, 'wiki_page')
    assert.equal(page.sources[0].documentId, sourceDoc)
    teyaVersion = page.baseVersion
    // forrás nélkül a change-set sourceDocumentIds-ja került rá (D9)
    const ep = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_A, path: 'entities/excellence-pay.md' })
    assert.equal(ep.sources[0].documentId, sourceDoc)

    const index = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_A, path: 'index.md' })
    assert.match(index.text, /## Szolgáltatók\n\n- \[\[entities\/excellence-pay\]\] — Excellence Pay: Partner\n- \[\[entities\/teya\]\]/)
    const log = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_A, path: 'log.md' })
    assert.match(log.text, /## \[2026-10-23\] ingest \| Teya árlista 2026/)
    const schema = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_A, path: 'WIKI.md' })
    assert.match(schema.text, /Nyelv: hu/)

    const search = await call(OWNER, DEF_A, 'kb_search', { wikiId: WIKI_A, query: 'Hazai' })
    assert.ok(search.hits.some((hit: any) => hit.kind === 'wiki_page' && hit.path === 'entities/teya.md'), JSON.stringify(search))

    const listing = await call(OWNER, DEF_A, 'kb_list_index', { wikiId: WIKI_A })
    assert.equal(listing.wiki.pageCount, 3)
    assert.equal(listing.wiki.categories[0].category, 'Források')
    assert.ok(listing.sources.some((s: any) => s.documentId === sourceDoc))
    assert.ok(auditLog.some((row) => row.action === 'kb.wiki.changeset.applied' && row.actorType === 'agent'))
  })

  await check('duplikált MCP-feltöltés nem nyit újra feldolgozott tételt és nem veszi át más foglalását', async () => {
    for (const status of ['processed', 'in_progress'] as const) {
      const content = `duplicate-state-${status}`
      const first = await call(OWNER, DEF_A, 'kb_ingest', { ...md(content), processingMode: 'wiki', wikiId: WIKI_A })
      const document = documents.get(first.documentId)!
      document.wikiStatus = status
      document.wikiClaimedByAgentId = status === 'in_progress' ? AGENT_B : null
      const before = { ...document }
      const count = documents.size
      const auditCount = auditLog.filter((row) => row.action === 'kb.wiki.inbox.submitted').length
      const repeated = await call(OWNER, DEF_A, 'kb_ingest', { ...md(content), processingMode: 'wiki', wikiId: WIKI_A })
      assert.equal(repeated.isError, false)
      assert.equal(repeated.status, 'duplicate')
      assert.equal(repeated.documentId, first.documentId)
      assert.equal(documents.size, count)
      assert.equal(auditLog.filter((row) => row.action === 'kb.wiki.inbox.submitted').length, auditCount)
      assert.deepEqual(documents.get(first.documentId), before)
    }
  })

  await check('2. második forrás patch appendToSection-nel bővít; a revízió megmarad', async () => {
    const second = await call(OWNER, DEF_A, 'kb_ingest', { filename: 'teya-2.md', content: 'Külföldi kártya 1,5%.', processingMode: 'wiki' , wikiId: WIKI_A })
    const write = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      inboxItemId: second.documentId,
      // Az MCP-n hirdetett alak: JSON-szöveg és vesszős lista.
      sourceDocumentIds: `${second.documentId}, ${sourceDoc}`,
      pages: JSON.stringify([{ path: 'entities/teya.md', action: 'patch', patch: [{ op: 'appendToSection', section: 'Díjak', text: '| Külföldi | 1,5% |' }, { op: 'addSource', source: { documentId: second.documentId } }] }]),
    })
    assert.equal(write.isError, false, JSON.stringify(write))
    const page = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_A, path: 'entities/teya.md' })
    assert.match(page.text, /\| Hazai \| 0,9% \|\n\| Külföldi \| 1,5% \|/)
    assert.equal(page.version, 2)
    assert.equal(page.sources.length, 2)
    const pageRow = await wikis.findPage(KB_A, 'entities/teya.md')
    assert.equal((await wikis.listRevisions(pageRow!.id)).length, 2)
  })

  await check('6. elavult baseVersion → conflict az aktuális tartalommal; semmi nem íródik', async () => {
    const result = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      pages: [{ path: 'entities/teya.md', action: 'upsert', type: 'entity', title: 'Teya', summary: 'x', baseVersion: teyaVersion, body: 'felülírás', frontmatter: { sources: [{ documentId: sourceDoc }] } }],
    })
    assert.equal(result.isError, true)
    assert.equal(result.code, 'conflict')
    assert.match(result.conflicts[0].current.body, /Külföldi/)
    assert.notEqual(result.conflicts[0].baseVersion, teyaVersion)
    // Meglévő oldalra baseVersion nélküli upsert is conflict (nincs csendes felülírás).
    const noBase = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      pages: [{ path: 'entities/teya.md', action: 'upsert', type: 'entity', title: 'Teya', summary: 'x', body: 'y', frontmatter: { sources: [{ documentId: sourceDoc }] } }],
    })
    assert.equal(noBase.code, 'conflict')
    // Más fejezetet érintő közbeni írás nem ütközés a patch-nél.
    const otherSection = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      pages: [{ path: 'entities/teya.md', action: 'patch', baseVersion: teyaVersion, patch: [{ op: 'appendToSection', section: 'Kapcsolódó', text: '- [[entities/excellence-pay]]' }] }],
    })
    assert.equal(otherSection.isError, false, JSON.stringify(otherSection))
    const sameSection = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      pages: [{ path: 'entities/teya.md', action: 'patch', baseVersion: teyaVersion, patch: [{ op: 'replaceSection', section: 'Díjak', text: 'régi' }] }],
    })
    assert.equal(sameSection.code, 'conflict')
  })

  await check('5. validációs hibák → invalid_wiki_change, semmi nem íródik', async () => {
    const otherKbDoc = (await kbService.ingest({ tenantId: TENANT, agentId: AGENT_A, uploadedById: OWNER, filename: 'masik.md', buffer: Buffer.from('x'), processingMode: 'raw_text_only', connectorId: KB_SHARED })).documentId
    const pagesBefore = wikis.pages.size
    const result = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      pages: [
        { path: 'concepts/forras-nelkul.md', action: 'upsert', type: 'concept', title: 'A', summary: 'a', body: 'x' },
        { path: 'concepts/masik-kb.md', action: 'upsert', type: 'concept', title: 'B', summary: 'b', body: 'x', frontmatter: { sources: [{ documentId: otherKbDoc }] } },
        { path: 'concepts/nem-letezo.md', action: 'upsert', type: 'concept', title: 'C', summary: 'c', body: 'x', frontmatter: { sources: [{ documentId: randomUUID() }] } },
        { path: 'index.md', action: 'upsert', type: 'overview', title: 'I', summary: 'i', body: 'x' },
        { path: 'sources/datum-nelkul.md', action: 'upsert', type: 'source', title: 'S', summary: 's', body: 'x', frontmatter: { sources: [{ documentId: sourceDoc }] } },
        { path: 'Rossz Path.md', action: 'upsert', type: 'concept', title: 'R', summary: 'r', body: 'x' },
      ],
    })
    assert.equal(result.isError, true)
    assert.equal(result.code, 'invalid_wiki_change')
    const codes = result.errors.map((e: any) => `${e.path}:${e.code}`)
    for (const expected of [
      'concepts/forras-nelkul.md:missing_source',
      'concepts/masik-kb.md:unknown_source',
      'concepts/nem-letezo.md:unknown_source',
      'index.md:reserved_path',
      'sources/datum-nelkul.md:missing_source_date',
      'Rossz Path.md:invalid_path',
    ]) {
      assert.ok(codes.includes(expected), `${expected} hiányzik: ${codes.join(', ')}`)
    }
    assert.equal(wikis.pages.size, pagesBefore)
  })

  let approvalOp = ''
  let approvalCs = ''
  await check('3. approval mód: awaiting_approval + approvalUrl; előtte nem látszik; jóváhagyás után igen', async () => {
    const src = await call(OWNER, DEF_A, 'kb_ingest', { filename: 'kozos.md', content: 'Közös tudás.', processingMode: 'wiki', wikiId: WIKI_SHARED })
    const write = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_SHARED,
      inboxItemId: src.documentId,
      sourceDocumentIds: [src.documentId],
      pages: [{ path: 'concepts/kozos.md', action: 'upsert', type: 'concept', title: 'Közös', summary: 'közös', body: 'Közös tudás titokszava: zebra.' }],
    })
    assert.equal(write.isError, false, JSON.stringify(write))
    assert.equal(write.status, 'awaiting_approval')
    assert.match(write.approvalUrl, /\/control-plane\/operations#/)
    assert.equal(write.waitingForApprover.userId, APPROVER)
    approvalOp = write.operationId
    approvalCs = write.changeSetId
    assert.equal((await wikis.findChangeSet(approvalCs))!.gatewayOperationId, approvalOp)
    const hidden = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_SHARED, path: 'concepts/kozos.md' })
    assert.equal(hidden.found, false)
    const hiddenSearch = await call(OWNER, DEF_A, 'kb_search', { wikiId: WIKI_SHARED, query: 'zebra' })
    assert.equal(hiddenSearch.hits.length, 0)
    assert.equal(documents.get(src.documentId)!.wikiStatus, 'processed')

    const preview = await wikiService.previewChangeSet(TENANT, approvalCs)
    assert.equal(preview?.pages[0].before, null)
    assert.match(preview!.pages[0].after.body, /zebra/)
    assert.deepEqual(preview!.changeSet.sourceDocumentIds, [src.documentId])

    // D4: az író (nem jóváhagyó) nem dönthet.
    const self = await approveGatewayOperation(gatewayDeps, { tenantId: TENANT, operationId: approvalOp, actor: principal(OWNER) })
    assert.equal(self.ok, false)
    const approved = await approveGatewayOperation(gatewayDeps, { tenantId: TENANT, operationId: approvalOp, actor: principal(APPROVER) })
    assert.equal(approved.ok && approved.view.status, 'succeeded', JSON.stringify(approved))
    const visible = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_SHARED, path: 'concepts/kozos.md' })
    assert.equal(visible.found, true)
    const search = await call(OWNER, DEF_A, 'kb_search', { wikiId: WIKI_SHARED, query: 'zebra' })
    assert.equal(search.hits.length, 1)
  })

  await check('3b. approval mód: elutasítás után nem látszik, a tálca-tétel visszakerül', async () => {
    const src = await call(OWNER, DEF_A, 'kb_ingest', { filename: 'elutasitott.md', content: 'Elutasítandó.', processingMode: 'wiki', wikiId: WIKI_SHARED })
    const write = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_SHARED,
      inboxItemId: src.documentId,
      sourceDocumentIds: [src.documentId],
      pages: [{ path: 'concepts/elutasitott.md', action: 'upsert', type: 'concept', title: 'E', summary: 'e', body: 'Elutasítandó.' }],
    })
    const rejected = await rejectGatewayOperation(gatewayDeps, { tenantId: TENANT, operationId: write.operationId, actor: principal(APPROVER) })
    assert.equal(rejected.ok, true)
    assert.equal((await wikis.findChangeSet(write.changeSetId))!.status, 'rejected')
    const page = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_SHARED, path: 'concepts/elutasitott.md' })
    assert.equal(page.found, false)
    assert.equal(documents.get(src.documentId)!.wikiStatus, 'pending')
  })

  await check('3c. jóváhagyás agent_stale: change-set rejected, tálca visszanyílik', async () => {
    const src = await call(OWNER, DEF_A, 'kb_ingest', {
      filename: 'stale.md',
      content: 'Stale.',
      processingMode: 'wiki',
      wikiId: WIKI_SHARED,
    })
    const write = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_SHARED,
      inboxItemId: src.documentId,
      sourceDocumentIds: [src.documentId],
      pages: [{ path: 'concepts/stale.md', action: 'upsert', type: 'concept', title: 'S', summary: 's', body: 'Stale.' }],
    })
    assert.equal(documents.get(src.documentId)!.wikiStatus, 'processed')
    const published = randomUUID()
    define(published, AGENT_A, definitions.get(DEF_A)!.snapshot.connectors)
    currentDefinition[AGENT_A] = published
    try {
      const failed = await approveGatewayOperation(gatewayDeps, {
        tenantId: TENANT,
        operationId: write.operationId,
        actor: principal(APPROVER),
      })
      assert.equal(failed.ok && failed.view.status, 'failed', JSON.stringify(failed))
      assert.equal(failed.ok ? failed.view.errorCode : null, 'agent_stale')
      assert.equal((await wikis.findChangeSet(write.changeSetId))!.status, 'rejected')
      assert.equal(documents.get(src.documentId)!.wikiStatus, 'pending')
    } finally {
      currentDefinition[AGENT_A] = DEF_A
    }
  })

  await check('4. D5: más által létrehozott oldal archiválása direct módban is jóváhagyásra megy', async () => {
    const src = await call(OWNER, DEF_C, 'kb_ingest', { filename: 'cili.md', content: 'Cili forrása.', processingMode: 'wiki' })
    const created = await call(OWNER, DEF_C, 'kb_wiki_write', {
      inboxItemId: src.documentId,
      sourceDocumentIds: [src.documentId],
      pages: [{ path: 'concepts/cili.md', action: 'upsert', type: 'concept', title: 'Cili', summary: 'c', body: 'Cili oldala.' }],
    })
    assert.equal(created.status, 'applied', JSON.stringify(created))
    const archive = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_A,
      sourceDocumentIds: [sourceDoc],
      pages: [
        { path: 'concepts/cili.md', action: 'archive' },
        { path: 'concepts/sajat.md', action: 'upsert', type: 'concept', title: 'Saját', summary: 's', body: 'saját' },
      ],
    })
    assert.equal(archive.isError, false, JSON.stringify(archive))
    assert.equal(archive.status, 'awaiting_approval')
    assert.deepEqual(archive.pendingPages, [{ path: 'concepts/cili.md', action: 'archive' }])
    assert.equal(archive.applied.pages[0].path, 'concepts/sajat.md')
    assert.equal((await wikis.findPage(KB_A, 'concepts/cili.md'))!.status, 'published')
    // #946 jóváhagyó kártya: a D5-ös tétel kiemelve, a mostani állapothoz képest, írás nélkül.
    const preview = await wikiService.previewChangeSet(TENANT, archive.changeSetId)
    assert.ok(preview && !preview.blocking, JSON.stringify(preview?.blocking))
    assert.equal(preview.pages.length, 1)
    assert.equal(preview.pages[0].action, 'archive')
    assert.equal(preview.pages[0].othersPage, true)
    assert.equal(preview.pages[0].before?.body, 'Cili oldala.')
    assert.equal((await wikis.findPage(KB_A, 'concepts/cili.md'))!.status, 'published')
    const approved = await approveGatewayOperation(gatewayDeps, { tenantId: TENANT, operationId: archive.operationId, actor: principal(APPROVER) })
    assert.equal(approved.ok && approved.view.status, 'succeeded', JSON.stringify(approved))
    assert.equal((await wikis.findPage(KB_A, 'concepts/cili.md'))!.status, 'archived')
    const index = await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_A, path: 'index.md' })
    assert.doesNotMatch(index.text, /concepts\/cili/)
  })

  await check('7. tálca: defer → pending; submit-only → pending és wiki_write_not_allowed; already_claimed; lejárt foglalás újra foglalható', async () => {
    const deferred = await call(OWNER, DEF_A, 'kb_ingest', { filename: 'kesobb.md', content: 'Később.', processingMode: 'wiki', wikiId: WIKI_A, defer: true })
    assert.equal(deferred.status, 'pending')
    assert.equal(documents.get(deferred.documentId)!.wikiClaimedByAgentId, null)

    const submitted = await call(OWNER, DEF_B, 'kb_ingest', { filename: 'bela.md', content: 'Béla anyaga.', processingMode: 'wiki' })
    assert.equal(submitted.status, 'pending', JSON.stringify(submitted))
    assert.match(submitted.nextStep, /only submit/)
    const denied = await call(OWNER, DEF_B, 'kb_wiki_write', {
      pages: [{ path: 'concepts/b.md', action: 'upsert', type: 'concept', title: 'B', summary: 'b', body: 'b' }],
      sourceDocumentIds: [submitted.documentId],
    })
    assert.equal(denied.code, 'wiki_write_not_allowed')

    const first = await call(OWNER, DEF_A, 'kb_get_document', { documentId: submitted.documentId, claimForWiki: true })
    assert.equal(first.isError, false, JSON.stringify(first))
    assert.equal(first.status, 'in_progress')
    assert.equal(first.text, 'Béla anyaga.')
    const second = await call(OWNER, DEF_C, 'kb_get_document', { documentId: submitted.documentId, claimForWiki: true })
    assert.equal(second.code, 'already_claimed')
    assert.equal(second.claimedBy.name, 'Anna')
    const stolen = await call(OWNER, DEF_C, 'kb_wiki_write', {
      inboxItemId: submitted.documentId,
      sourceDocumentIds: [submitted.documentId],
      pages: [{ path: 'concepts/bela.md', action: 'upsert', type: 'concept', title: 'B', summary: 'b', body: 'b' }],
    })
    assert.equal(stolen.code, 'already_claimed')
    const listed = await call(OWNER, DEF_A, 'kb_list_index', { wikiId: WIKI_A, inbox: true })
    const item = listed.items.find((row: any) => row.documentId === submitted.documentId)
    assert.equal(item.status, 'in_progress')
    assert.equal(item.claimedBy.name, 'Anna')
    assert.equal(item.submittedBy.name, 'Béla')

    advance(2 * 60 * 60 * 1000 + 1)
    const relisted = await call(OWNER, DEF_A, 'kb_list_index', { wikiId: WIKI_A, inbox: true })
    assert.equal(relisted.items.find((row: any) => row.documentId === submitted.documentId).status, 'pending')
    const retaken = await call(OWNER, DEF_C, 'kb_get_document', { documentId: submitted.documentId, claimForWiki: true })
    assert.equal(retaken.isError, false, JSON.stringify(retaken))
    const notInbox = await call(OWNER, DEF_A, 'kb_get_document', { documentId: sourceDoc, claimForWiki: true })
    assert.equal(notInbox.code, 'not_in_inbox')
    const noWriteClaim = await call(OWNER, DEF_B, 'kb_get_document', { documentId: deferred.documentId, claimForWiki: true })
    assert.equal(noWriteClaim.code, 'wiki_write_not_allowed')
  })

  await check('8. köteg-összesítő 3 munkamenetnyi szimulált feldolgozás után', async () => {
    const batchId = randomUUID()
    const items: string[] = []
    for (let i = 0; i < 5; i++) {
      const doc = await kbService.ingest({ tenantId: TENANT, agentId: AGENT_A, uploadedById: OWNER, filename: `lelet-${i}.md`, buffer: Buffer.from(`Lelet ${i}`), processingMode: 'raw_text_only', connectorId: KB_A })
      await wikis.submitToInbox({ documentId: doc.documentId, status: 'pending', batchId, batchSeq: i + 1 })
      items.push(doc.documentId)
    }
    const processItem = async (definitionId: string, documentId: string, final = true) => {
      const claim = await call(OWNER, definitionId, 'kb_get_document', { documentId, claimForWiki: true })
      assert.equal(claim.isError, false, JSON.stringify(claim))
      const write = await call(OWNER, definitionId, 'kb_wiki_write', {
        inboxItemId: documentId,
        final,
        sourceDocumentIds: [documentId],
        wikiId: WIKI_A,
        pages: [{ path: `sources/lelet-${items.indexOf(documentId)}.md`, action: 'upsert', type: 'source', title: 'Lelet', summary: 'l', body: 'lelet', frontmatter: { source_date: '2024-03-12' } }],
      })
      assert.equal(write.isError, false, JSON.stringify(write))
    }
    // 1. munkamenet: 2 kész
    await processItem(DEF_A, items[0])
    await processItem(DEF_A, items[1])
    // 2. munkamenet: 1 kész, egy félbehagyva (final:false → foglalva marad)
    await processItem(DEF_C, items[2])
    await processItem(DEF_C, items[3], false)
    // 3. munkamenet: összesítő
    const listed = await call(OWNER, DEF_A, 'kb_list_index', { wikiId: WIKI_A, inbox: true, batchId })
    assert.deepEqual(
      listed.summary.batches.map((row: any) => ({ pending: row.pending, inProgress: row.inProgress, processed: row.processed, skipped: row.skipped })),
      [{ pending: 1, inProgress: 1, processed: 3, skipped: 0 }],
    )
    assert.deepEqual(listed.items.map((row: any) => row.batchSeq), [4, 5])
    const briefingWikis = await wikiService.listWikis({ tenantId: TENANT, userId: OWNER, agentId: AGENT_A, snapshot: definitions.get(DEF_A)!.snapshot })
    const batch = briefingWikis.find(row => row.wikiId === WIKI_A)?.batches.find(row => row.batchId === batchId)
    assert.deepEqual(batch, { batchId, pending: 1, inProgress: 1, processed: 3, skipped: 0 })
    const otherBriefing = await wikiService.listWikis({ tenantId: TENANT, userId: OTHER_USER, agentId: AGENT_A, snapshot: definitions.get(DEF_A)!.snapshot })
    assert.ok(!otherBriefing.some(row => row.connectorId === KB_PRIV))
  })

  await check('kind: note — a szerver bélyegzi a felhasználót és az időt (D9)', async () => {
    const note = await call(OWNER, DEF_A, 'kb_ingest', { processingMode: 'wiki', wikiId: WIKI_A, kind: 'note', content: 'A Teya kapcsolattartó Kiss Péter.' })
    assert.equal(note.isError, false, JSON.stringify(note))
    assert.equal(note.kind, 'note')
    const doc = documents.get(note.documentId)!
    assert.match(doc.extractedText ?? '', /Note recorded 2026-10-23T.* by Olga Owner \(user 1111/)
    assert.equal((doc.metadata as any).kind, 'note')
  })

  await check('tool_not_configured: wiki mód beküldési jog nélkül; okf/raw út változatlan', async () => {
    define('d0000000-0000-4000-8000-00000000000d', AGENT_B, [{ connectorId: KB_A, type: 'knowledge_base', accessMode: 'write' }])
    currentDefinition[AGENT_B] = 'd0000000-0000-4000-8000-00000000000d'
    const res = await call(OWNER, 'd0000000-0000-4000-8000-00000000000d', 'kb_ingest', { filename: 'x.md', content: 'x', processingMode: 'wiki' })
    assert.equal(res.code, 'tool_not_configured')
    const raw = await call(OWNER, 'd0000000-0000-4000-8000-00000000000d', 'kb_ingest', { filename: 'x.md', content: 'x', processingMode: 'raw_text_only' })
    assert.equal(raw.isError, false, JSON.stringify(raw))
    assert.equal(documents.get(raw.documentId)!.wikiStatus, null)
    currentDefinition[AGENT_B] = DEF_B
  })

  await check('10. privát wiki: a tulajdonosnál minden működik, másik felhasználónál egyik tool sem látja', async () => {
    const src = await call(OWNER, DEF_A, 'kb_ingest', { filename: 'lelet.md', content: 'Vércukor 5,4.', processingMode: 'wiki', wikiId: WIKI_PRIV })
    assert.equal(src.status, 'in_progress')
    const write = await call(OWNER, DEF_A, 'kb_wiki_write', {
      wikiId: WIKI_PRIV,
      inboxItemId: src.documentId,
      sourceDocumentIds: [src.documentId],
      pages: [{ path: 'conditions/vercukor.md', action: 'upsert', type: 'concept', title: 'Vércukor', summary: 'v', body: 'Vércukor 5,4.' }],
    })
    assert.equal(write.status, 'applied', JSON.stringify(write))
    assert.equal((await call(OWNER, DEF_A, 'kb_get_page', { wikiId: WIKI_PRIV, path: 'conditions/vercukor.md' })).found, true)
    const overview = await call(OWNER, DEF_A, 'kb_list_index', {})
    assert.ok(overview.wikis.some((w: any) => w.wikiId === WIKI_PRIV && w.name === 'Leleteim'))

    for (const [tool, args] of [
      ['kb_get_page', { wikiId: WIKI_PRIV, path: 'conditions/vercukor.md' }],
      ['kb_search', { wikiId: WIKI_PRIV, query: 'Vércukor' }],
      ['kb_list_index', { wikiId: WIKI_PRIV }],
      ['kb_list_index', { wikiId: WIKI_PRIV, inbox: true }],
      ['kb_get_document', { documentId: src.documentId }],
      ['kb_get_document', { documentId: src.documentId, claimForWiki: true }],
      ['kb_ingest', { filename: 'x.md', content: 'x', processingMode: 'wiki', wikiId: WIKI_PRIV }],
      ['kb_wiki_write', { wikiId: WIKI_PRIV, pages: [{ path: 'a.md', action: 'archive' }] }],
    ] as const) {
      const res = await call(OTHER_USER, DEF_A, tool, args)
      assert.equal(res.code, 'not_found', `${tool} ${JSON.stringify(args)} → ${JSON.stringify(res)}`)
    }
    const otherOverview = await call(OTHER_USER, DEF_A, 'kb_list_index', {})
    assert.ok(!JSON.stringify(otherOverview).includes(WIKI_PRIV))
    const otherInbox = await call(OTHER_USER, DEF_A, 'kb_list_index', { inbox: true })
    assert.ok(!JSON.stringify(otherInbox).includes(src.documentId))
    // A privát wiki audit-sorai tartalommentesek (path nem kerül bele).
    assert.ok(!JSON.stringify(auditLog).includes('conditions/vercukor'))
  })

  await check('10b. privát wiki jóváhagyás: resultJson nem tartalmaz path-ot', async () => {
    const prev = definitions.get(DEF_A)!
    define(
      DEF_A,
      AGENT_A,
      prev.snapshot.connectors.map((conn) =>
        conn.connectorId === KB_PRIV ? { ...conn, wikiWriteMode: 'approval' as const } : conn,
      ),
    )
    try {
      const src = await call(OWNER, DEF_A, 'kb_ingest', {
        filename: 'vercukor2.md',
        content: 'Vércukor 6,1.',
        processingMode: 'wiki',
        wikiId: WIKI_PRIV,
      })
      const write = await call(OWNER, DEF_A, 'kb_wiki_write', {
        wikiId: WIKI_PRIV,
        inboxItemId: src.documentId,
        sourceDocumentIds: [src.documentId],
        pages: [
          {
            path: 'conditions/vercukor-uj.md',
            action: 'upsert',
            type: 'concept',
            title: 'Vércukor',
            summary: 'v',
            body: 'Vércukor 6,1.',
          },
        ],
      })
      assert.equal(write.status, 'awaiting_approval', JSON.stringify(write))
      const approved = await approveGatewayOperation(gatewayDeps, {
        tenantId: TENANT,
        operationId: write.operationId,
        actor: principal(OWNER),
      })
      assert.equal(approved.ok && approved.view.status, 'succeeded', JSON.stringify(approved))
      const result = JSON.stringify(approved.ok ? approved.view.result : {})
      assert.equal(result.includes('conditions/vercukor'), false, result)
      assert.equal(result.includes('vercukor-uj'), false, result)
    } finally {
      define(DEF_A, AGENT_A, prev.snapshot.connectors)
    }
  })

  await check('9. D3: a teljes út nem hívott hálózatot / Model Gatewayt', () => {
    assert.equal(fetchCalls, 0)
  })

  globalThis.fetch = originalFetch
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
