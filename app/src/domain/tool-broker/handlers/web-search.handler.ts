import { parseWebSearchConfig } from '@/domain/web-search/web-search-types'
import type { ToolHandler, ToolHandlerArgs } from './tool-handler'

/**
 * web_search — a kill-switch + kvóta-policy döntés a KERETBEN dől el (invoke),
 * ide már az effektív, normalizált lekérdezés (`webSearchEffective`) érkezik.
 * A handler a connector-configból oldja fel a kulcs-aliast: agent_owned módban a
 * per-agent secretAlias, egyébként a connector szintű megosztott kulcs
 * (http_api-minta).
 */
export const webSearchHandler: ToolHandler = {
  id: 'web_search',
  handles(tool) {
    return tool === 'web_search'
  },
  async execute({ ctx, authorization, webSearchEffective }: ToolHandlerArgs) {
    const connector = authorization.connector
    if (!connector) throw new Error('web_search requires connector authorization')
    const config = parseWebSearchConfig(connector.config)
    const effectiveAlias =
      connector.authMode === 'agent_owned' && authorization.agentSecretAlias
        ? authorization.agentSecretAlias
        : connector.secretAlias
    const { result } = await ctx.webSearch.search(webSearchEffective!, config, effectiveAlias)
    return result
  },
}
