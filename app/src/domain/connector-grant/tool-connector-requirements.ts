/**
 * Melyik eszköz milyen típusú connectort igényel (issue #194, WP-5).
 *
 * Külön modul, hogy a connector-oldali fogyasztók (pl. a delegált OAuth
 * provider-regiszter) körkörös import nélkül számolhassanak belőle: az
 * authorizer ezt a mátrixot használja ÉS a regisztert is hívja, tehát a mátrix
 * nem élhet az authorizerben.
 *
 * EXTRACT from the former tool-broker matrix so connector-grant KEEP can
 * decide which tools need a connector without importing the legacy broker.
 */
import type { ConnectorAccessMode } from '@prisma/client'

/** Historical tool→connector map. Prisma `ConnectorType` is google_drive | http_api. */
export const TOOL_REQUIREMENTS: Partial<Record<
  string,
  { connectorType: string; accessMode: ConnectorAccessMode }
>> = {
  kb_search: { connectorType: 'knowledge_base', accessMode: 'read' },
  kb_list_index: { connectorType: 'knowledge_base', accessMode: 'read' },
  kb_get_page: { connectorType: 'knowledge_base', accessMode: 'read' },
  board_write: { connectorType: 'board', accessMode: 'write' },
  ticket_create: { connectorType: 'board', accessMode: 'write' },
  agent_ask: { connectorType: 'board', accessMode: 'write' },
  agent_resolve: { connectorType: 'board', accessMode: 'read' },
  agent_catalog: { connectorType: 'board', accessMode: 'read' },
  user_directory: { connectorType: 'board', accessMode: 'read' },
  gmail_search: { connectorType: 'gmail', accessMode: 'read' },
  gmail_get_message: { connectorType: 'gmail', accessMode: 'read' },
  mailbox_count: { connectorType: 'gmail', accessMode: 'read' },
  gmail_create_draft: { connectorType: 'gmail', accessMode: 'write' },
  gmail_send: { connectorType: 'gmail', accessMode: 'write' },
  google_drive_search: { connectorType: 'google_drive', accessMode: 'read' },
  google_drive_get_file: { connectorType: 'google_drive', accessMode: 'read' },
  google_drive_read_file: { connectorType: 'google_drive', accessMode: 'read' },
  google_drive_list_drives: { connectorType: 'google_drive', accessMode: 'read' },
  google_drive_create_folder: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_upload_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_update_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_rename_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_move_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_copy_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_trash_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_restore_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_drive_share_file: { connectorType: 'google_drive', accessMode: 'write' },
  google_docs_apply_edits: { connectorType: 'google_drive', accessMode: 'write' },
  google_sheets_write_range: { connectorType: 'google_drive', accessMode: 'write' },
  google_slides_apply_edits: { connectorType: 'google_drive', accessMode: 'write' },
  http_api_get: { connectorType: 'http_api', accessMode: 'read' },
  http_api_get_all: { connectorType: 'http_api', accessMode: 'read' },
  http_api_request: { connectorType: 'http_api', accessMode: 'write' },
  repo_prepare: { connectorType: 'workspace', accessMode: 'write' },
  repo_open_pull_request: { connectorType: 'workspace', accessMode: 'write' },
  file_read: { connectorType: 'workspace', accessMode: 'read' },
  file_write: { connectorType: 'workspace', accessMode: 'write' },
  create_html: { connectorType: 'workspace', accessMode: 'write' },
  file_edit: { connectorType: 'workspace', accessMode: 'write' },
  file_list: { connectorType: 'workspace', accessMode: 'read' },
  file_glob: { connectorType: 'workspace', accessMode: 'read' },
  file_search: { connectorType: 'workspace', accessMode: 'read' },
  file_delete: { connectorType: 'workspace', accessMode: 'write' },
  sandbox_exec: { connectorType: 'code_sandbox', accessMode: 'write' },
  xlsx_read_sheet: { connectorType: 'workspace', accessMode: 'read' },
  xlsx_write_cells: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_format_range: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_layout: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_create: { connectorType: 'workspace', accessMode: 'write' },
  xlsx_append_rows: { connectorType: 'workspace', accessMode: 'write' },
  docx_read: { connectorType: 'workspace', accessMode: 'read' },
  docx_create: { connectorType: 'workspace', accessMode: 'write' },
  pdf_read: { connectorType: 'workspace', accessMode: 'read' },
  pdf_create: { connectorType: 'workspace', accessMode: 'write' },
  /** Csak workspace-path ágon (documentId UUID esetén az authorizer korán kilép). */
  tulajdoni_lap_parse: { connectorType: 'workspace', accessMode: 'read' },
  tulajdoni_lap_egyeztetes: { connectorType: 'workspace', accessMode: 'write' },
  reconcile_records: { connectorType: 'workspace', accessMode: 'write' },
  pptx_create: { connectorType: 'workspace', accessMode: 'write' },
  'sandbox_app.create': { connectorType: 'board', accessMode: 'write' },
  'sandbox_app.update_artifact': { connectorType: 'board', accessMode: 'write' },
  'sandbox_app.preview': { connectorType: 'board', accessMode: 'read' },
  'sandbox_app.export': { connectorType: 'board', accessMode: 'read' },
  'sandbox_app.list': { connectorType: 'board', accessMode: 'read' },
  'sandbox_app.get': { connectorType: 'board', accessMode: 'read' },
  'sandbox.commit': { connectorType: 'board', accessMode: 'write' },
  'sandbox.request_promotion': { connectorType: 'board', accessMode: 'write' },
  'sandbox.snapshot': { connectorType: 'board', accessMode: 'write' },
  web_search: { connectorType: 'web_search', accessMode: 'read' },
}

/**
 * Azok az eszközök, amelyek egy adott típusú connectort igényelnek — a
 * `TOOL_REQUIREMENTS` mátrixból SZÁMOLVA (issue #194, WP-5).
 *
 * ÜZLETI JELENTŐSÉG: az eszközjog-mentés ebből dönti el, kell-e automatikusan
 * connectort linkelni. Korábban ehhez külön, kézzel írt tool-listák éltek a
 * szerver-akcióban, amikből több workspace-es tool (tulajdoni_lap_egyeztetes,
 * reconcile_records, repo_open_pull_request) KIMARADT: az admin bepipálta a
 * jogot, connector viszont nem került az agenthez, és a tool néma
 * connector-hibára futott.
 */
export function toolsRequiringConnector(
  connectorType: string,
  accessMode?: ConnectorAccessMode,
): string[] {
  return (Object.entries(TOOL_REQUIREMENTS) as Array<
    [string, { connectorType: string; accessMode: ConnectorAccessMode }]
  >)
    .filter(
      ([, requirement]) =>
        requirement.connectorType === connectorType &&
        (accessMode === undefined || requirement.accessMode === accessMode),
    )
    .map(([toolName]) => toolName)
}
