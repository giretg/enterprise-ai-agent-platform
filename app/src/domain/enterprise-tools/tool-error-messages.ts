export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function asUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined
}

export const ENTERPRISE_TOOL_ERROR_MESSAGES: Record<string, string> = {
  definition_not_found: 'Agent definition not found',
  definition_mismatch: 'agentId does not match the loaded definition',
  agent_stale:
    'The agent was republished — call platform.agent.get_definition to load the new version, then retry with currentDefinitionId (with a local checkout, also re-run platform.agent.checkout)',
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
  wiki_id_required: 'Several wikis match — pass wikiId (see wikis in the error payload)',
  // #943
  invalid_wiki_change: 'The wiki change is invalid — nothing was written; fix the listed errors and retry',
  conflict: 'The page changed since you read it — nothing was written; merge with the current content and retry with its baseVersion',
  already_claimed: 'Another agent is processing this inbox item (see claimedBy and claimExpiresAt)',
  not_in_inbox: 'This document is not waiting in the wiki inbox',
  changeset_not_pending: 'This wiki change-set is no longer waiting for approval',
  missing_code_sandbox_connector_read: 'Published definition has no code sandbox connector',
  missing_code_sandbox_connector_write:
    'Published definition has no code sandbox connector — grant sandbox_run and publish after the sandbox connection is bound',
  skill_not_pinned: 'This skill version is not pinned on the published agent definition',
  // #967 mini appok
  // #984 AI-adattárház
  warehouse_not_ready: 'The company data warehouse is not activated yet — an admin can turn it on at activateUrl',
  warehouse_agent_disabled: 'This agent has no access to the company data warehouse — an admin can enable it at settingsUrl',
  warehouse_agent_read_only: 'This agent may only read the data warehouse, not load data — an admin can change it at settingsUrl',
  warehouse_permission_denied: 'Your role does not allow this data warehouse action (see needed)',
  import_not_found: 'Import not found — check importId with warehouse.get_import_status',
  import_invalid_state: 'The import is not in the right state for this step (see state and next)',
  invalid_plan: 'The import plan is invalid — nothing was changed; fix the listed issues and submit again',
  plan_check_failed: 'The import plan does not fit the file or the warehouse (see errors) — submit a corrected plan',
  plan_missing: 'Submit an import plan first (warehouse.submit_import_plan)',
  preview_stale: 'The data or plan changed since the preview — call warehouse.preview_import again and use the new previewHash',
  dataset_not_found: 'Dataset not found — check the key with warehouse.list_datasets',
  field_not_found: 'Unknown field (see detail) — check field names with warehouse.describe_dataset',
  invalid_filters: 'filters must be a JSON array of {field, op, value} (see detail)',
  invalid_filter_value: 'A filter value is missing or has the wrong form (see detail)',
  invalid_aggregate: 'Aggregates are fn:field pairs, e.g. sum:netto,count:* — sum/avg only on numbers',
  invalid_order: 'orderBy is "field" or "field desc"',
  nothing_selected: 'Nothing to select — pass fields or aggregates',
  unsafe_archive: 'The Excel file is damaged or its unpacked content is too large — nothing was stored',
  unsupported_format: 'Only .xlsx Excel files are supported for now',
  unreadable_file: 'The Excel file could not be read — save it again as .xlsx and retry',
  sheet_not_found: 'The sheet named in the plan is not in the file',
  no_data_rows: 'No data rows were found under the header',
  source_file_missing: 'The original file of this import is missing',
  load_failed: 'Loading failed; nothing was changed — preview again and retry, or ask an admin',
  rollback_not_latest: 'Only the latest import of a dataset can be undone',
  rollback_blocked_by_references: 'Other data refers to records created by this import — undo those first',
  exception_not_found: 'Exception not found',
  exception_not_pending: 'This exception was already handled',
  exception_not_linkable: 'This exception cannot be resolved by linking',
  link_target_not_found: 'The chosen record does not exist',
  mini_app_not_found: 'Mini app not found — check the appId with platform.mini_app.list',
  mini_app_not_owner: 'Only the agent that owns this mini app can change it — make your own copy with platform.mini_app.create copyFromAppId',
  mini_app_archived: 'This mini app is archived — an admin can restore it in the Control Plane',
  mini_app_version_not_found: 'This version does not exist — omit version for the current one',
  mini_app_conflict: 'Another version was uploaded meanwhile — call platform.mini_app.get, merge, and retry with a new idempotencyKey',
  mini_app_too_large: 'The HTML is larger than this organization allows (see byteSize / maxBytes) — embed less data or compress it, then retry',
  mini_app_validation_failed: 'The HTML was rejected (see errors): remove <iframe>, <object>, <embed> and <form>, then retry — nothing was stored',
  share_target_required: 'Pass toAgentIds (comma-separated) and/or organization=true',
  share_target_not_visible: 'This recipient is not an active agent of this organization that the user can see (see agentId) — check platform.agents.list',
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
    'Multiple connectors match (HTTP APIs or mailboxes); pass connectorName (from connectors[].name in the published definition), connectorId, or a path that appears on only one connector\'s endpoint list (see connectors in the error payload)',
  acting_user_required: 'This tool requires a delegated user grant',
  tenant_mailbox_disconnected:
    'The shared mailbox connection is broken. Tell the user to ask an admin to reconnect it — do not send them to connect their own account',
  tenant_mailbox_read_only: 'This shared mailbox is connected read-only; sending is not allowed',
  google_drive_scope_not_granted: 'Google Drive scopes are insufficient',
  gmail_scope_not_granted: 'Gmail scopes are insufficient',
  invalid_args: 'Invalid tool arguments — fix the fields listed in issues and retry',
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
  mcp_domain_not_allowed: 'This MCP call is not allowed to leave the connector’s own address',
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
