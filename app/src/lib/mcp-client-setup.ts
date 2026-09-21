export const MCP_SETUP_SEEN_COOKIE = 'mcp_setup_seen'
export const CONTROL_PLANE_GET_STARTED_PATH = '/control-plane/get-started'

export type McpClientSetup = {
  tenantSlug: string
  serverName: string
  mcpUrl: string
  codexCommand: string
  claudeCommand: string
  cursorInstallHref: string
}

export function mcpClientName(tenantSlug: string): string {
  return `ea-${tenantSlug}`
}

export function mcpUrlForTenant(origin: string, tenantSlug: string): string {
  return `${origin.replace(/\/+$/, '')}/api/mcp/${tenantSlug}`
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
}

/** Cursor one-click install (browser → Cursor). Config = mcp.json transport object. */
export function cursorMcpInstallHref(serverName: string, mcpUrl: string): string {
  const config = encodeURIComponent(base64Json({ type: 'http', url: mcpUrl }))
  return `https://cursor.com/en/install-mcp?name=${encodeURIComponent(serverName)}&config=${config}`
}

export function codexMcpSetupCommand(serverName: string, mcpUrl: string): string {
  return `codex mcp add ${serverName} --url ${mcpUrl} && codex mcp login ${serverName}`
}

export function claudeMcpAddCommand(serverName: string, mcpUrl: string): string {
  return `claude mcp add --transport http ${serverName} ${mcpUrl}`
}

export function buildMcpClientSetup(input: { origin: string; tenantSlug: string }): McpClientSetup {
  const mcpUrl = mcpUrlForTenant(input.origin, input.tenantSlug)
  const serverName = mcpClientName(input.tenantSlug)
  return {
    tenantSlug: input.tenantSlug,
    serverName,
    mcpUrl,
    codexCommand: codexMcpSetupCommand(serverName, mcpUrl),
    claudeCommand: claudeMcpAddCommand(serverName, mcpUrl),
    cursorInstallHref: cursorMcpInstallHref(serverName, mcpUrl),
  }
}

/** Tenant-home: nincs setup-cookie → landing; különben a hívó oldja a workspace-t. */
export function firstRunGetStartedPath(setupSeenCookie: string | undefined): string | null {
  return setupSeenCookie ? null : CONTROL_PLANE_GET_STARTED_PATH
}
