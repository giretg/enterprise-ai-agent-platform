/**
 * Bejövő levél feldolgozása (`forceWriteApproval`): a feladó hamisítható, ezért a levélből
 * indított futás csak olvasni és jóváhagyásra váró írást kezdeményezni tud. Engedélylista:
 * ami nincs itt (köztük minden később felvett eszköz), az ilyen futásban tiltott.
 */
const INBOUND_MAIL_ALLOWED_TOOLS = new Set<string>([
  // Olvasás
  'platform.whoami',
  'platform.agents.list',
  'platform.agent.get_definition',
  'platform.agent.get_working_set',
  'platform.agent.checkout',
  'platform.skills.list',
  'platform.skills.read',
  'platform.projects.list',
  'platform.work_file.list',
  'platform.work_file.read',
  'platform.project_memory.read',
  'platform.promise.get',
  'platform.promise.list',
  'platform.scheduled_task.list',
  'platform.scheduled_task.get',
  'platform.mini_app.list',
  'platform.mini_app.get',
  'platform.mini_app.guide',
  'warehouse.list_datasets',
  'warehouse.describe_dataset',
  'warehouse.get_import_status',
  'warehouse.query_dataset',
  'warehouse.export_dataset',
  'platform.gateway_operation.get',
  'google_drive_search',
  'google_drive_read_file',
  'mail_list_accounts',
  'mail_search',
  'mail_get_message',
  'mail_get_thread',
  'mail_get_attachment',
  'gmail_search',
  'gmail_get_message',
  'gmail_get_thread',
  'gmail_list_labels',
  'gmail_list_drafts',
  'http_api_get',
  'http_api_get_all',
  'kb_search',
  'kb_list_index',
  'kb_get_page',
  'kb_get_document',
  'kb_wiki_changes',
  'kb_wiki_config_get',
  'mcp_list_tools',
  'web_search',
  // Kimenet csak a beszélgetésbe / hálózat nélküli sandboxba
  'document_export',
  'sandbox_run',
  // Írás, amely ilyen futásban mindig jóváhagyásra vár (javaslat / jóváhagyási sor)
  'platform.skills.submit',
  'platform.project_memory.write',
  'google_drive_create_folder',
  'google_drive_upload_file',
  'google_drive_update_file',
  'google_sheets_write_range',
  'mail_send',
  'mail_create_draft',
  'mail_mark',
  'gmail_send',
  'gmail_create_draft',
  'gmail_modify_labels',
  'gmail_trash',
  'http_api_request',
  'kb_wiki_write',
  'kb_wiki_revert',
  'mcp_call',
])

export const INBOUND_MAIL_TOOL_BLOCKED_MESSAGE =
  'Ezt a műveletet bejövő levél feldolgozása közben nem végezheted el (a levél feladója hamisítható). ' +
  'Írd le az összefoglalóban, mit javasolsz, és a felelős kolléga elvégzi vagy megkér rá.'

export function inboundMailBlocksTool(principal: { forceWriteApproval?: true }, toolName: string): boolean {
  return principal.forceWriteApproval === true && !INBOUND_MAIL_ALLOWED_TOOLS.has(toolName)
}

export function inboundMailAllowedTools(): readonly string[] {
  return [...INBOUND_MAIL_ALLOWED_TOOLS]
}
