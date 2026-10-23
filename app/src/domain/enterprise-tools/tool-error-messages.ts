export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function asUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined
}

export const ENTERPRISE_TOOL_ERROR_MESSAGES: Record<string, string> = {
  definition_not_found: 'Agent definition not found',
  definition_mismatch: 'agentId does not match the loaded definition',
  agent_stale:
    'Published agent changed since checkout — call platform.agent.checkout, overwrite generated paths, then retry',
  agent_access_denied: 'Operate grant required to invoke this agent',
  tool_not_configured: 'Tool is not configured',
  capability_not_allowed: 'Tool is not allowed by the published agent definition',
  agent_inactive: 'Agent is not available on MCP until it is turned on',
  missing_google_drive_connector_read: 'Published definition has no Google Drive read connector',
  missing_google_drive_connector_write: 'Published definition has no Google Drive write connector',
  missing_gmail_connector_read: 'Published definition has no Gmail read connector',
  missing_gmail_connector_write:
    'Published definition has no Gmail connector in write mode — set the Gmail connector to write on the agent and publish',
  missing_http_api_connector_read: 'Published definition has no HTTP API read connector',
  missing_http_api_connector_write: 'Published definition has no HTTP API write connector',
  missing_knowledge_base_connector_read: 'Published definition has no knowledge base read connector',
  missing_knowledge_base_connector_write: 'Published definition has no knowledge base write connector',
  // #942: privát / nem látható tudásbázis — szándékosan nem árulja el, hogy létezik.
  not_found: 'Not found',
  wiki_write_not_allowed: 'This agent may not write this wiki — submit the source to its inbox or ask an admin for write access',
  wiki_submit_not_allowed: 'This agent may only read this wiki',
  wiki_id_required: 'Several wikis match — pass wikiId',
  missing_code_sandbox_connector_read: 'Published definition has no code sandbox connector',
  missing_code_sandbox_connector_write:
    'Published definition has no code sandbox connector — grant sandbox_run and publish after the sandbox connection is bound',
  skill_not_pinned: 'This skill version is not pinned on the published agent definition',
  skill_not_found: 'Skill version not found',
  skill_not_active: 'Skill version is not active',
  skill_entry_not_found: 'The skill version has no attachment at this entry path',
  skill_entry_not_runnable: 'Only a pinned .py skill script can run in the sandbox',
  code_sandbox_disabled: 'Code sandbox is disabled',
  code_sandbox_base_url_missing: 'Code sandbox connector has no provider URL',
  tenant_isolation: 'Connector does not belong to this tenant',
  connector_not_active: 'Connector is not active',
  connector_grant_missing: 'This account has not been connected yet',
  account_required:
    'Several linked accounts match; pass account (nickname or email from platform.whoami linkedAccounts, see accounts in the error payload)',
  unknown_account:
    'No linked account matches that account nickname or email; pass one from platform.whoami linkedAccounts (see accounts in the error payload)',
  connector_id_required:
    'Multiple HTTP API connectors match; pass connectorName (from connectors[].name in the published definition), connectorId, or a path that appears on only one connector\'s endpoint list (see connectors in the error payload)',
  acting_user_required: 'This tool requires a delegated user grant',
  google_drive_scope_not_granted: 'Google Drive scopes are insufficient',
  gmail_scope_not_granted: 'Gmail scopes are insufficient',
  invalid_args: 'Invalid tool arguments',
  idempotency_key_required: 'idempotencyKey is required',
  idempotency_key_conflict:
    'idempotencyKey is already used by a different principal, tool, or arguments',
  google_drive_auth_failed: 'Google Drive authentication failed',
  google_drive_api_error: 'Google Drive request failed',
  drive_file_modified: 'The Drive file changed since it was read; read it again and retry',
  gmail_auth_failed: 'Gmail authentication failed',
  gmail_api_error: 'Gmail request failed',
  http_api_error: 'HTTP API request failed',
  missing_api_key: 'HTTP API connector has no credential',
  file_too_large: 'File is too large',
  too_many_pages: 'Request at most 5 pages per call; continue with the next range.',
  invalid_pages: 'Use pages:"1-3,7" with positive page numbers.',
  original_pdf_unavailable: 'Original PDF unavailable. Upload the original PDF to a new source.',
  invalid_pdf_page: 'Invalid PDF page dimensions.',
  page_images_too_large: 'Request fewer pages per call (PNG limit: 5 MiB).',
  file_not_found: 'Work file not found',
  unknown_project: 'Unknown projectKey — call platform.projects.create first, or use __general__',
  invalid_project_key: 'Invalid projectKey',
  quota_exceeded: 'Work-file quota exceeded',
  invalid_path: 'Invalid work-file path',
  sandbox_file_count_limit_exceeded: 'Too many input files for the sandbox — pass fewer inputs',
  sandbox_input_total_size_exceeded: 'Input files are too large in total for the sandbox',
  sandbox_input_file_too_large: 'An input file is too large for the sandbox',
  tool_execution_failed: 'Tool execution failed',
  missing_mcp_connector_read: 'Published definition has no MCP server connector',
  missing_mcp_connector_write:
    'This MCP tool changes data, but the MCP connector is bound read-only on this agent — set it to write and publish',
  mcp_tool_not_approved:
    'This tool is not approved on the MCP connector — call mcp_list_tools for the approved tools; an admin must approve new ones',
  mcp_domain_not_allowed: 'The platform administrator has not allowed this MCP server domain',
  mcp_auth_failed: 'The MCP server rejected the credentials',
  mcp_server_error: 'The MCP server request failed',
  mcp_tool_error: 'The MCP tool returned an error',
  mcp_outcome_uncertain:
    'The MCP server did not answer in time; the change may or may not have happened — check before retrying',
}

export function enterpriseToolErrorMessage(code: string, fallback = 'Tool call denied'): string {
  return ENTERPRISE_TOOL_ERROR_MESSAGES[code] ?? fallback
}

export function enterpriseToolErrorPayload(
  code: string,
  extra?: Record<string, unknown>,
  fallback?: string,
): Record<string, unknown> {
  const authorizationUrl =
    typeof extra?.authorizationUrl === 'string' ? extra.authorizationUrl : undefined
  const base = enterpriseToolErrorMessage(code, fallback)
  return {
    code,
    message: authorizationUrl
      ? `${base}. Open this URL in a browser to connect, then retry: ${authorizationUrl}`
      : base,
    ...extra,
  }
}
