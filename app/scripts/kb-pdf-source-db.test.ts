/** #944: run against a disposable, migrated local PostgreSQL database. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prisma } from '../src/lib/db'
import { KnowledgeBaseService } from '../src/domain/knowledge-base/knowledge-base-service'
import { PostgresDocumentRepository, PostgresKnowledgeArtifactRepository, PostgresKnowledgeChunkRepository } from '../src/repositories/postgres/knowledge-repository'
import { PostgresAgentRepository } from '../src/repositories/postgres/agent-repository'
import { PostgresConnectorRepository } from '../src/repositories/postgres/connector-repository'
import { PostgresPrivateKnowledgeBaseStore } from '../src/repositories/postgres/wiki-repository'
import { executeKnowledgeBaseTool } from '../src/domain/enterprise-tools/handlers/knowledge-base'
import { invokeEnterpriseTool, type EnterpriseToolDeps } from '../src/domain/enterprise-tools'
import type { AgentDefinition } from '../src/domain/agent-definition'
import { kbDocumentImageResult } from '../src/auth/mcp-server'
import { pdfPageQuality } from '../src/lib/kb-extraction'
import { kbPdfFixtures } from './fixtures/kb-pdf'

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid').hostname
  assert.ok(['localhost', '127.0.0.1'].includes(host), 'Use a disposable local/CI database')
  // Any attempted external AI/OCR/network call makes this test fail.
  globalThis.fetch = async () => { throw new Error('Unexpected external network call') }
  const tenant = await prisma.tenant.create({ data: { slug: `pdf944-${randomUUID()}`, displayName: 'PDF test' } })
  const owner = await prisma.user.create({ data: { name: 'Test', externalAuthId: randomUUID(), email: `${randomUUID()}@example.test` } })
  const agent = await prisma.agent.create({ data: { tenantId: tenant.id, name: 'Test', roleInstruction: 'x', status: 'active' } })
  const connector = await prisma.connector.create({ data: {
    tenantId: tenant.id, name: `kb:private:${randomUUID()}`, type: 'knowledge_base',
    visibility: 'private_to_user', ownerUserId: owner.id, authMode: 'agent_owned', scope: 'single',
  } })
  const audits: unknown[] = []
  const documents = new PostgresDocumentRepository()
  const service = new KnowledgeBaseService({
    documents, artifacts: new PostgresKnowledgeArtifactRepository(), chunks: new PostgresKnowledgeChunkRepository(),
    agents: new PostgresAgentRepository(), connectors: new PostgresConnectorRepository(),
    audit: { append: async (entry) => { audits.push(entry); return entry as never } },
  })
  const fixtures = await kbPdfFixtures()
  const context = { connectorId: connector.id, tenantId: tenant.id, agentId: agent.id, userId: owner.id }
  const args = { filename: 'sensitive-laboratory.pdf', processingMode: 'wiki', contentBase64: fixtures.mixed.toString('base64') }
  const ingest = () => executeKnowledgeBaseTool(service, 'kb_ingest', args, context) as ReturnType<KnowledgeBaseService['ingest']>
  const [first, second] = await Promise.all([ingest(), ingest()])
  assert.equal(first.documentId, second.documentId)
  assert.equal([first, second].filter((r) => 'duplicateOf' in r).length, 1)
  const duplicate = [first, second].find((r) => 'duplicateOf' in r)!
  assert.deepEqual(duplicate.duplicateOf, { documentId: first.documentId, filename: args.filename, wikiStatus: 'pending' })
  assert.equal(await prisma.document.count({ where: { connectorId: connector.id } }), 1)
  assert.equal(await prisma.document.count({ where: { connectorId: connector.id, wikiStatus: 'pending' } }), 1)
  assert.equal((await documents.findById(first.documentId))?.wikiSubmittedByAgentId, agent.id)
  assert.deepEqual(await documents.readSource(first.documentId), fixtures.mixed)
  assert.deepEqual(first.pages.map((p) => p.textQuality), ['ok', 'no_text', 'low_text'])
  assert.match(first.nextStep!, /pageImages/)
  const text = await service.getDocument({ connectorId: connector.id, documentId: first.documentId })
  assert.ok('pages' in text && text.pages.length === 3)
  const definitionId = randomUUID()
  const definition: AgentDefinition = {
    definitionId, agentId: agent.id, version: 1, tenantId: tenant.id, status: 'active', publishedAt: new Date().toISOString(),
    snapshot: { name: 'Test', roleInstruction: 'x', skills: [],
      connectors: [{ connectorId: connector.id, type: 'knowledge_base', accessMode: 'write', visibility: 'private_to_user', ownerUserId: owner.id, wikiAccess: 'write' }],
      capabilities: [{ toolName: 'kb_get_document', allowed: true }],
    },
  }
  const deps: EnterpriseToolDeps = {
    loadDefinition: async () => definition,
    findCurrentDefinitionId: async () => definitionId,
    findAgentGrant: async () => ({ accessLevel: 'operate' }),
    findConnector: async () => connector,
    findActiveGrant: async () => null,
    resolveAccessToken: async () => { throw new Error('No external token required') },
    executeKbTool: (tool, input, ctx) => executeKnowledgeBaseTool(service, tool, input, ctx),
    audit: { append: async (entry) => { audits.push(entry) } },
  }
  const request = { principal: { userId: owner.id, tenantId: tenant.id, role: 'operator', assumed: false },
    toolName: 'kb_get_document', args: { definitionId, documentId: first.documentId, pageImages: true, pages: '1-2' } }
  const result = await invokeEnterpriseTool(deps, request)
  assert.ok('content' in result)
  const mcp = kbDocumentImageResult(result)
  assert.equal(mcp.content.filter((block) => block.type === 'image').length, 2)
  assert.equal(mcp.content.filter((block) => block.type === 'text' && /^PDF page/.test(block.text)).length, 2)
  const metadata = mcp.content[0]
  assert.ok(metadata.type === 'text' && !metadata.text.includes('iVBOR'), 'Base64 is only in image blocks')
  for (const block of mcp.content) {
    if (block.type === 'image') assert.equal(Buffer.from(block.data, 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  }
  const invalid = await invokeEnterpriseTool(deps, { ...request, args: { ...request.args, pages: '1-6' } })
  assert.ok('content' in invalid && invalid.isError)
  assert.equal(JSON.parse(invalid.content[0].text).code, 'too_many_pages')
  assert.match(JSON.parse(invalid.content[0].text).message, /5 pages/)
  assert.match(JSON.parse(invalid.content[0].text).nextStep, /5 pages/)
  // Other user of the same agent and even an admin cannot read the private original.
  const denied = await invokeEnterpriseTool(deps, { ...request, principal: { ...request.principal, userId: randomUUID(), role: 'admin' } })
  assert.ok('content' in denied && denied.isError)
  assert.equal(JSON.parse(denied.content[0].text).code, 'not_found')
  await assert.rejects(service.getDocument({ ...context, userId: randomUUID(), documentId: first.documentId, pageImages: true }), /not_found/)
  const otherKb = await prisma.connector.create({ data: { tenantId: tenant.id, type: 'knowledge_base', name: randomUUID(), authMode: 'agent_owned', scope: 'single' } })
  await assert.rejects(service.getDocument({ ...context, connectorId: otherKb.id, documentId: first.documentId, pageImages: true }), /not_found/)
  // Deduplication is local to a KB, not global to a tenant or user.
  const elsewhere = await service.ingest({ tenantId: tenant.id, agentId: agent.id, uploadedById: owner.id, connectorId: otherKb.id,
    filename: args.filename, buffer: fixtures.mixed, processingMode: 'raw_text_only' })
  assert.notEqual(elsewhere.documentId, first.documentId)
  const batch = await service.ingestBatch({ tenantId: tenant.id, agentId: agent.id, uploadedById: owner.id,
    connectorId: connector.id, processingMode: 'wiki', files: [
      { filename: 'same-again.pdf', buffer: fixtures.mixed },
      { filename: 'new-scan.pdf', buffer: fixtures.scanned },
      { filename: 'same-scan.pdf', buffer: fixtures.scanned },
    ],
  })
  assert.equal(batch.documents.length, 1)
  assert.deepEqual(batch.duplicates.map((d) => d.filename), ['same-again.pdf', 'same-scan.pdf'])
  assert.equal(batch.duplicates[0].duplicateOf.documentId, first.documentId)
  assert.equal(await prisma.document.count({ where: { connectorId: connector.id } }), 2)
  // Copying a scanned catalog source must preserve its PDF, even with no extracted text.
  const catalog = await service.ingestCatalog({ tenantId: tenant.id, uploadedById: owner.id,
    filename: 'catalog-scan.pdf', buffer: fixtures.scanned, processingMode: 'raw_text_only' })
  const attached = await service.attachCatalogDocumentToAgent({ tenantId: tenant.id, agentId: agent.id,
    documentId: catalog.documentId, actorId: owner.id })
  assert.deepEqual(await documents.readSource(attached.documentId), fixtures.scanned)
  assert.equal((await documents.findById(attached.documentId))?.contentHash, (await documents.findById(catalog.documentId))?.contentHash)
  await service.deleteCatalogDocument({ tenantId: tenant.id, documentId: catalog.documentId, actorId: owner.id })
  assert.equal(await documents.readSource(catalog.documentId), null)
  assert.deepEqual(await documents.readSource(attached.documentId), fixtures.scanned)
  // Legacy duplicates can acquire missing original bytes, without a new source/inbox item.
  await prisma.documentSourceFile.delete({ where: { documentId: first.documentId } })
  assert.equal(await documents.readSource(first.documentId), null)
  const legacy = await documents.findById(first.documentId)
  const extraction = (legacy?.metadata as { extraction?: { format?: string; blocks?: Array<Record<string, unknown>> } })?.extraction
  await documents.update(first.documentId, {
    metadata: {
      extraction: {
        format: extraction?.format ?? 'pdf',
        blocks: (extraction?.blocks ?? []).map(({ textQuality: _textQuality, ...block }) => block),
      },
    },
  })
  assert.equal(pdfPageQuality((await documents.findById(first.documentId))!.metadata).length, 0)
  const backfilled = await ingest()
  assert.deepEqual(await documents.readSource(first.documentId), fixtures.mixed)
  assert.deepEqual(backfilled.pages.map((page) => page.textQuality), ['ok', 'no_text', 'low_text'])
  assert.match(backfilled.nextStep!, /pageImages/)
  // Ordinary document deletion and full private KB purge both cascade to original bytes.
  await documents.delete(elsewhere.documentId)
  assert.equal(await documents.readSource(elsewhere.documentId), null)
  await new PostgresPrivateKnowledgeBaseStore().purge(connector.id)
  assert.equal(await documents.findById(first.documentId), null)
  assert.equal(await documents.readSource(first.documentId), null)
  const auditJson = JSON.stringify(audits.filter((entry) => {
    const row = entry as { action: string; metadata?: { privateKb?: boolean } }
    return row.metadata?.privateKb || row.action.startsWith('enterprise.tool.')
  }))
  assert.ok(!auditJson.includes(args.filename) && !auditJson.includes('iVBOR') && !auditJson.includes('glucose'))
  assert.ok(audits.some((entry) => (entry as { action: string }).action === 'enterprise.tool.ok'))
  console.log('OK: concurrent dedup, inbox, raw retention, MCP PNG blocks, page limits, privacy, cascade purge, content-free audit; no network/AI calls')
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => prisma.$disconnect())
