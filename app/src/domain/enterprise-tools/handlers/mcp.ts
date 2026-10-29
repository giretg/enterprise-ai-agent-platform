import { loadConnectorApiKeyByRef } from '@/domain/connector/connector-secret-store'
import {
  mcpCallTool,
  McpClientError,
  type McpCallResult,
  type McpClientDeps,
} from '@/domain/connector/mcp-client'
import {
  mcpServerHost,
  parseMcpConnectorConfig,
  resolveMcpToolRisk,
  type McpCapabilitySet,
  type McpToolRisk,
} from '@/domain/connector/mcp-tools'
import type { LiveConnectorRow } from '../authorize-tool-call'

export type ExecuteMcpToolInput = {
  connector: LiveConnectorRow
  /** user_delegated: a hívó saját grantjének tokenje. service: üres → secretAlias. */
  accessToken?: string
  tool: string
  arguments: Record<string, unknown>
  /** A hívás csak a connector saját hostjára mehet. */
  allowedHosts: string[]
  onServerRequest?: (method: string) => void
}

/** `mcp_call` végrehajtása a külső szerveren (#395 §3.4). A kapukat a hívó már lefuttatta. */
export async function executeMcpTool(
  input: ExecuteMcpToolInput,
  deps: McpClientDeps & { loadSecret?: (ref: string) => Promise<string> } = {},
): Promise<McpCallResult> {
  const config = parseMcpConnectorConfig(input.connector.config)
  if (!config) throw new McpClientError('server_error', 'invalid_mcp_config')
  const host = mcpServerHost(config)
  if (!input.allowedHosts.includes(host)) throw new McpClientError('egress_blocked', 'mcp_domain_not_allowed')
  let accessToken = input.accessToken
  if (!accessToken && input.connector.authMode !== 'user_delegated' && input.connector.secretAlias) {
    accessToken = await (deps.loadSecret ?? loadConnectorApiKeyByRef)(input.connector.secretAlias)
  }
  return mcpCallTool(
    {
      serverUrl: config.serverUrl,
      allowedHosts: [host],
      accessToken,
      tool: input.tool,
      arguments: input.arguments,
      onServerRequest: input.onServerRequest,
    },
    deps,
  )
}

export type McpGateDeps = {
  /** Az MCP-connector aktív (jóváhagyott) eszközlistája; null = nincs aktív verzió. */
  loadMcpActiveTools?: (input: { connectorId: string; tenantId: string }) => Promise<McpCapabilitySet | null>
}

export type McpGateResult =
  | { ok: true; risk: McpToolRisk; allowedHosts: string[] }
  | { ok: false; code: string }

/**
 * §3.3–3.4 kapu egy `mcp_call`-ra: a connector hostjára pinelve (a tenant-admin
 * a létrehozással engedélyezte), aktív verzió, jóváhagyott eszköz. Az MCP-hívás
 * és a jóváhagyás utáni végrehajtás is ezen megy át.
 */
export async function checkMcpCallGate(
  deps: McpGateDeps,
  input: { connector: LiveConnectorRow; tool: string },
): Promise<McpGateResult> {
  if (!deps.loadMcpActiveTools) return { ok: false, code: 'tool_not_configured' }
  const config = parseMcpConnectorConfig(input.connector.config)
  if (!config) return { ok: false, code: 'connector_not_active' }
  const host = mcpServerHost(config)
  const active = await deps.loadMcpActiveTools({
    connectorId: input.connector.id,
    tenantId: input.connector.tenantId,
  })
  const decision = resolveMcpToolRisk(active, input.tool)
  if (!decision.ok) return { ok: false, code: decision.reason }
  return { ok: true, risk: decision.risk, allowedHosts: [host] }
}

/** D11: csak olvasó hívás ismételhető, egyszer; egress- és auth-hibát sosem ismétlünk. */
export async function executeMcpWithRetryPolicy(
  execute: (input: ExecuteMcpToolInput) => Promise<McpCallResult>,
  input: ExecuteMcpToolInput,
  risk: McpToolRisk,
): Promise<McpCallResult> {
  try {
    return await execute(input)
  } catch (error) {
    const retriable =
      risk === 'read' && error instanceof McpClientError && (error.code === 'timeout' || error.code === 'server_error')
    if (!retriable) throw error
    return execute(input)
  }
}

export function mcpErrorCode(error: unknown, risk: McpToolRisk): string {
  if (error instanceof McpClientError) {
    if (error.code === 'unauthorized') return 'mcp_auth_failed'
    if (error.detail === 'mcp_domain_not_allowed') return 'mcp_domain_not_allowed'
    // D11: mellékhatásos hívás timeoutja bizonytalan kimenetel, nem sima hiba.
    if (error.code === 'timeout' && risk !== 'read') return 'mcp_outcome_uncertain'
  }
  return 'mcp_server_error'
}
