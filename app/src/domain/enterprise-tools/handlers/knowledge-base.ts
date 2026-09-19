import type { KnowledgeBaseService } from '@/domain/knowledge-base/knowledge-base-service'
import {
  KB_GET_PAGE_TOOL,
  KB_INGEST_TOOL,
  KB_LIST_INDEX_TOOL,
  type EnterpriseKbTool,
} from '../tool-definitions'

export const KB_MCP_MAX_BYTES = 2 * 1024 * 1024

export type KbToolContext = {
  connectorId: string
  tenantId: string
  agentId: string
  userId: string
}

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

export async function executeKnowledgeBaseTool(
  service: KnowledgeBaseService,
  toolName: EnterpriseKbTool,
  args: Record<string, unknown>,
  ctx: KbToolContext,
): Promise<unknown> {
  if (toolName === KB_INGEST_TOOL) {
    return service.ingest({
      tenantId: ctx.tenantId,
      agentId: ctx.agentId,
      uploadedById: ctx.userId,
      filename: String(args.filename),
      mimeType: typeof args.mimeType === 'string' ? args.mimeType : null,
      buffer: decodeIngestBuffer(args),
      processingMode: args.processingMode === 'okf' ? 'okf' : 'raw_text_only',
    })
  }
  if (toolName === KB_LIST_INDEX_TOOL) {
    return service.listIndex({
      connectorId: ctx.connectorId,
      pathPrefix: typeof args.pathPrefix === 'string' ? args.pathPrefix : undefined,
      maxDepth: typeof args.maxDepth === 'number' ? args.maxDepth : undefined,
    })
  }
  if (toolName === KB_GET_PAGE_TOOL) {
    return service.getPage({
      connectorId: ctx.connectorId,
      path: String(args.path),
      artifactId: typeof args.artifactId === 'string' ? args.artifactId : undefined,
    })
  }
  return {
    hits: await service.search({
      connectorId: ctx.connectorId,
      query: String(args.query),
      k: typeof args.k === 'number' ? args.k : undefined,
    }),
  }
}
