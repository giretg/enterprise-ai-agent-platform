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
  agent_inactive: 'Agent is not available on MCP until it is turned on',
  missing_google_drive_connector_read: 'Published definition has no Google Drive read connector',
  missing_google_drive_connector_write: 'Published definition has no Google Drive write connector',
  missing_gmail_connector_read: 'Published definition has no Gmail read connector',
  missing_http_api_connector_read: 'Published definition has no HTTP API read connector',
  missing_http_api_connector_write: 'Published definition has no HTTP API write connector',
  missing_knowledge_base_connector_read: 'Published definition has no knowledge base read connector',
  missing_knowledge_base_connector_write: 'Published definition has no knowledge base write connector',
  tenant_isolation: 'Connector does not belong to this tenant',
  connector_not_active: 'Connector is not active',
  connector_grant_missing: 'This account has not been connected yet',
  connector_id_required: 'Multiple connectors match; pass connectorId from the agent definition',
  acting_user_required: 'This tool requires a delegated user grant',
  google_drive_scope_not_granted: 'Google Drive scopes are insufficient',
  gmail_scope_not_granted: 'Gmail scopes are insufficient',
  invalid_args: 'Invalid tool arguments',
  idempotency_key_required: 'idempotencyKey is required',
  idempotency_key_conflict:
    'idempotencyKey is already used by a different principal, tool, or arguments',
  google_drive_auth_failed: 'Google Drive authentication failed',
  google_drive_api_error: 'Google Drive request failed',
  gmail_auth_failed: 'Gmail authentication failed',
  gmail_api_error: 'Gmail request failed',
  http_api_error: 'HTTP API request failed',
  missing_api_key: 'HTTP API connector has no credential',
  file_too_large: 'File is too large',
  tool_execution_failed: 'Tool execution failed',
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
