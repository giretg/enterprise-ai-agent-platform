import type { KnowledgeBaseService } from '@/domain/knowledge-base/knowledge-base-service'
import type {
  WikiCaller,
  WikiOutcome,
  WikiService,
  WikiWriteInput,
  WikiWriteOutcome,
} from '@/domain/knowledge-base/wiki-service'
import type { WikiSnapshotConnector } from '@/lib/wiki-access'
import {
  KB_GET_DOCUMENT_TOOL,
  KB_GET_PAGE_TOOL,
  KB_INGEST_TOOL,
  KB_LIST_INDEX_TOOL,
  KB_WIKI_WRITE_TOOL,
  type EnterpriseKbTool,
} from '../tool-definitions'

export const KB_MCP_MAX_BYTES = 2 * 1024 * 1024

export type KbToolContext = {
  connectorId: string
  tenantId: string
  agentId: string
  userId: string
  /** #943: a hívóra szűkített snapshot-kötések (wiki-jog feloldásához). */
  snapshot?: { connectors: WikiSnapshotConnector[] }
}

/** Hibakód + javítható részletek a modellnek (pl. `already_claimed`). */
export class KbToolError extends Error {
  constructor(
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(code)
    this.name = 'KbToolError'
  }
}

export type WikiToolOutcome = WikiOutcome | WikiWriteOutcome

function decodeIngestBuffer(args: Record<string, unknown>): Buffer {
  const b64 = typeof args.contentBase64 === 'string' ? args.contentBase64 : ''
  if (b64) {
    const buffer = Buffer.from(b64, 'base64')
    if (buffer.byteLength === 0) throw new Error('invalid_args')
    if (buffer.byteLength > KB_MCP_MAX_BYTES) throw new Error('file_too_large')
    return buffer
  }
  const content = typeof args.content === 'string' ? args.content : ''
  if (!content) throw new Error('invalid_args')
  const buffer = Buffer.from(content, 'utf8')
  if (buffer.byteLength > KB_MCP_MAX_BYTES) throw new Error('file_too_large')
  return buffer
}

function wikiCaller(ctx: KbToolContext): WikiCaller | null {
  if (!ctx.snapshot) return null
  return { tenantId: ctx.tenantId, userId: ctx.userId, agentId: ctx.agentId, snapshot: ctx.snapshot }
}

/** A wiki-útvonalak (beküldés, írás, tálca), amelyek nem egyetlen kiválasztott KB-kötésen futnak. */
export function isWikiToolCall(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === KB_WIKI_WRITE_TOOL) return true
  if (toolName === KB_INGEST_TOOL) return args.processingMode === 'wiki'
  if (toolName === KB_LIST_INDEX_TOOL) return args.inbox === true
  return false
}

export async function executeWikiTool(
  wiki: WikiService,
  toolName: EnterpriseKbTool,
  args: Record<string, unknown>,
  caller: WikiCaller,
): Promise<WikiToolOutcome> {
  const wikiId = typeof args.wikiId === 'string' ? args.wikiId : undefined
  if (toolName === KB_INGEST_TOOL) {
    return wiki.ingest(caller, {
      wikiId,
      filename: typeof args.filename === 'string' ? args.filename : undefined,
      mimeType: typeof args.mimeType === 'string' ? args.mimeType : null,
      buffer: decodeIngestBuffer(args),
      purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
      defer: args.defer === true,
      kind: args.kind === 'note' ? 'note' : 'file',
    })
  }
  if (toolName === KB_WIKI_WRITE_TOOL) {
    return wiki.write(caller, args as unknown as WikiWriteInput)
  }
  if (toolName === KB_LIST_INDEX_TOOL && args.inbox === true) {
    return wiki.listInbox(caller, {
      wikiId,
      batchId: typeof args.batchId === 'string' ? args.batchId : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    })
  }
  // Több tudásbázis, connector megadása nélkül: a wikik áttekintése.
  return {
    ok: true,
    result: {
      wikis: await wiki.listWikis(caller),
      hint: 'Several knowledge bases are bound. Pass wikiId to kb_list_index to see one wiki index and its raw sources.',
    },
  }
}

export async function executeKnowledgeBaseTool(
  service: KnowledgeBaseService,
  toolName: EnterpriseKbTool,
  args: Record<string, unknown>,
  ctx: KbToolContext,
  wiki?: WikiService,
): Promise<unknown> {
  if (toolName === KB_INGEST_TOOL) {
    return service.ingest({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      uploadedById: ctx.userId,
      filename: String(args.filename),
      mimeType: typeof args.mimeType === 'string' ? args.mimeType : null,
      buffer: decodeIngestBuffer(args),
      processingMode: args.processingMode === 'wiki' ? 'wiki' : args.processingMode === 'okf' ? 'okf' : 'raw_text_only',
      purpose: typeof args.purpose === 'string' ? args.purpose : undefined,
      actor: 'agent',
      connectorId: ctx.connectorId,
    })
  }
  const caller = wikiCaller(ctx)
  if (toolName === KB_LIST_INDEX_TOOL) {
    const pathPrefix = typeof args.pathPrefix === 'string' ? args.pathPrefix : undefined
    const artifactId = typeof args.artifactId === 'string' ? args.artifactId : undefined
    const listing = await service.listIndex({
      connectorId: ctx.connectorId,
      pathPrefix,
      maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
      artifactId,
    })
    if (!wiki || !caller || pathPrefix || artifactId) return listing
    // A wiki tartalomjegyzéke elsőként (#941 §3), ha van mit mutatni vagy írható.
    const index = await wiki.indexFor(ctx.tenantId, ctx.connectorId, caller)
    if (!index || (index.pageCount === 0 && index.access === 'read' && !args.wikiId)) return listing
    return { wiki: index, ...listing }
  }
  if (toolName === KB_GET_DOCUMENT_TOOL) {
    const documentId = String(args.documentId)
    if (args.claimForWiki === true) {
      if (!wiki || !caller) throw new KbToolError('tool_not_configured')
      const claim = await wiki.claim(caller, { connectorId: ctx.connectorId, documentId })
      if (!claim.ok) throw new KbToolError(claim.code, claim.details)
      const document = await service.getDocument({
        connectorId: ctx.connectorId,
        documentId,
        section: typeof args.section === 'string' ? args.section : undefined,
      })
      return {
        ...document,
        inboxItemId: documentId,
        wikiId: claim.result.wikiId,
        status: 'in_progress',
        claimExpiresAt: claim.result.claimExpiresAt,
        nextStep: 'Write the pages, then call kb_wiki_write with this wikiId and inboxItemId.',
      }
    }
    return service.getDocument({
      connectorId: ctx.connectorId,
      documentId,
      pageImages: args.pageImages === true,
      pages: typeof args.pages === 'string' ? args.pages : undefined,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      section: typeof args.section === 'string' ? args.section : undefined,
    })
  }
  if (toolName === KB_GET_PAGE_TOOL) {
    const artifactId = typeof args.artifactId === 'string' ? args.artifactId : undefined
    if (wiki && !artifactId) {
      const page = await wiki.readPage({
        tenantId: ctx.tenantId,
        connectorId: ctx.connectorId,
        path: String(args.path),
        explicitWiki: typeof args.wikiId === 'string',
      })
      if (page) return page
    }
    return service.getPage({ connectorId: ctx.connectorId, path: String(args.path), artifactId })
  }
  return {
    hits: await service.search({
      connectorId: ctx.connectorId,
      query: String(args.query),
      k: typeof args.k === 'number' ? args.k : undefined,
    }),
  }
}
