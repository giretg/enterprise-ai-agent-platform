import { FileEditorError } from '@/domain/file-editor/file-editor-service'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const FILE_TOOLS = new Set([
  'create_html',
  'docx_read',
  'pdf_read',
  'pdf_create',
  'pptx_create',
])

/**
 * Fájl-munkaterület eszközök (file_*, xlsx_*, pdf_*, docx_read, pptx_create,
 * create_html). A munkaterület tenant-kulcsa a cselekvő felhasználó tenantja —
 * ez egyezik a feltöltési úttal (route + chat-bridge); fallback a connector
 * tenantra, majd 'global'-ra. A `FileEditorError` domain-hiba felszíni
 * `code: message` alakra normalizálva bukik (változatlan a korábbi brokerrel).
 */
export const fileToolHandler: ToolHandler = {
  id: 'file',
  handles(tool) {
    return (
      tool.startsWith('file_') ||
      tool.startsWith('xlsx_') ||
      tool.startsWith('pdf_') ||
      FILE_TOOLS.has(tool)
    )
  },
  async execute({ ctx, input, authorization, actingTenantId }: ToolHandlerArgs) {
    const connector = authorization.connector
    if (!connector) throw new Error(`${input.tool} requires connector authorization`)

    const workspaceId = input.ticketId ?? input.conversationId
    if (!workspaceId) throw new Error('file tools require a ticketId or conversationId')
    const tenantId = actingTenantId ?? connector.tenantId ?? 'global'
    const fe = ctx.fileEditor

    try {
      switch (input.tool) {
        case 'file_read':
          return fe.readFile(tenantId, workspaceId, input.args)
        case 'file_write':
          return fe.writeFile(tenantId, workspaceId, input.args)
        case 'create_html':
          return fe.createHtml(tenantId, workspaceId, input.args)
        case 'file_edit':
          return fe.editFile(tenantId, workspaceId, input.args)
        case 'file_list':
          return fe.listFiles(tenantId, workspaceId, input.args)
        case 'file_glob':
          return fe.globFiles(tenantId, workspaceId, input.args)
        case 'file_search':
          return fe.searchFiles(tenantId, workspaceId, input.args)
        case 'file_delete':
          return fe.deleteFile(tenantId, workspaceId, input.args)
        case 'xlsx_read_sheet':
          return fe.xlsxReadSheet(tenantId, workspaceId, input.args)
        case 'xlsx_write_cells':
          return fe.xlsxWriteCells(tenantId, workspaceId, input.args)
        case 'xlsx_format_range':
          return fe.xlsxFormatRange(tenantId, workspaceId, input.args)
        case 'xlsx_layout':
          return fe.xlsxLayout(tenantId, workspaceId, input.args)
        case 'xlsx_create':
          return fe.xlsxCreate(tenantId, workspaceId, input.args)
        case 'xlsx_append_rows':
          return fe.xlsxAppendRows(tenantId, workspaceId, input.args)
        case 'docx_read':
          return fe.docxRead(tenantId, workspaceId, input.args)
        case 'pdf_read':
          return fe.pdfRead(tenantId, workspaceId, input.args)
        case 'pdf_create':
          return fe.pdfCreate(tenantId, workspaceId, input.args)
        case 'pptx_create':
          return fe.pptxCreate(tenantId, workspaceId, input.args)
      }
    } catch (e) {
      if (e instanceof FileEditorError) {
        throw new Error(`${e.code}: ${e.message}`)
      }
      throw e
    }
    throw new Error(`Unknown file tool: ${input.tool}`)
  },
}
