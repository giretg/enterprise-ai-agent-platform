import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

const HTTP_TOOLS = new Set(['http_api_get', 'http_api_request'])

/**
 * Generikus HTTP API connector (http_api_get / http_api_request). user_delegated
 * (auto-consent oauth2) módban a per-user grant access-tokenjét injektáljuk
 * Bearerként — SOHA nem a connector secretAlias-át (az a client_secret). A tényleges
 * hívás a keret `executeHttpApiTool` metódusában él.
 */
export const httpApiHandler: ToolHandler = {
  id: 'http_api',
  handles(tool) {
    return HTTP_TOOLS.has(tool)
  },
  async execute({ ctx, input, authorization, actingTenantId, actingUserId }: ToolHandlerArgs) {
    if (input.tool !== 'http_api_get' && input.tool !== 'http_api_request') {
      throw new Error(`http_api handler received ${input.tool}`)
    }
    if (!authorization.connector) throw new Error(`${input.tool} requires connector authorization`)
    const delegatedAccessToken =
      authorization.connector.authMode === 'user_delegated'
        ? await ctx.resolveDelegatedAccessToken(input, authorization)
        : undefined
    return ctx.executeHttpApiTool(
      input,
      authorization.connector,
      actingTenantId,
      actingUserId,
      authorization.agentSecretAlias,
      delegatedAccessToken,
    )
  },
}
