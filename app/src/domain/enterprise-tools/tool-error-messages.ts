export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function asUuid(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value : undefined
}

export const ENTERPRISE_TOOL_ERROR_MESSAGES: Record<string, string> = {
  definition_not_found: 'Agent definition not found',
  definition_mismatch: 'agentId does not match the loaded definition',
  agent_access_denied: 'Operate grant required to invoke this agent',
  tool_not_configured: 'Tool is not configured',
  capability_not_allowed: 'Tool is not allowed by the published agent definition',
  missing_google_drive_connector_read: 'Published definition has no Google Drive read connector',
  missing_google_drive_connector_write: 'Published definition has no Google Drive write connector',
  missing_knowledge_base_connector_read: 'Published definition has no knowledge base read connector',
  missing_knowledge_base_connector_write: 'Published definition has no knowledge base write connector',
  tenant_isolation: 'Connector does not belong to this tenant',
  connector_not_active: 'Connector is not active',
  connector_grant_missing: 'Google Drive access has not been granted',
  acting_user_required: 'This tool requires a delegated user grant',
  google_drive_scope_not_granted: 'Google Drive scopes are insufficient',
  invalid_args: 'Invalid tool arguments',
  idempotency_key_required: 'idempotencyKey is required',
  google_drive_auth_failed: 'Google Drive authentication failed',
  google_drive_api_error: 'Google Drive request failed',
  file_too_large: 'File is too large',
  tool_execution_failed: 'Tool execution failed',
}

export function enterpriseToolErrorMessage(code: string, fallback = 'Tool call denied'): string {
  return ENTERPRISE_TOOL_ERROR_MESSAGES[code] ?? fallback
}
