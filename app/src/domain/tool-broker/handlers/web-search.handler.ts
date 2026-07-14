import { ConnectorApiKeyMissingError } from '@/domain/connector/connector-secret-store'
import {
  isWebSearchProviderAllowedForScope,
  parseWebSearchConfig,
} from '@/domain/web-search/web-search-types'
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
    if (!isWebSearchProviderAllowedForScope(connector.tenantId, config.provider)) {
      throw new Error(
        'A tenant web-kereső connector csak saját custom_search_api providert használhat. Nyisd meg a tenant Web Search beállításait, és adj meg tenant-specifikus API URL-t és kulcsot.',
      )
    }
    const effectiveAlias =
      connector.authMode === 'agent_owned' && authorization.agentSecretAlias
        ? authorization.agentSecretAlias
        : connector.secretAlias
    try {
      const { result } = await ctx.webSearch.search(webSearchEffective!, config, effectiveAlias)
      return result
    } catch (e) {
      // Hiányzó web-kereső API-kulcs → FELHASZNÁLÓBARÁT, magyar, cselekvésre okító üzenet a
      // nyers „Secret Manager access failed: 404" helyett. A helyszín a connector jellegétől
      // függ: platform system-agent kulcs vs. tenant-saját kulcs.
      if (e instanceof ConnectorApiKeyMissingError) {
        const platformKey = config.provider === 'platform_hosted_search' || connector.tenantId === null
        throw new Error(
          platformKey
            ? 'A web-kereséshez tartozó API-kulcs nincs beállítva a platform web-kereső connectoron, ezért a keresés (és a connector-felfedezés) nem indítható. Megoldás: superadminként nyisd meg a Control Plane → Platform → Beállítások oldalt, és add meg a platform web-kereső (Brave Search) API-kulcsát. Ezután indítsd újra a műveletet.'
            : `A web-kereséshez tartozó API-kulcs nincs beállítva a(z) „${connector.name}" web-kereső connectoron, ezért a keresés nem indítható. Megoldás: a tenant Web-kereső beállításainál add meg a keresőszolgáltató (Brave Search) API-kulcsát ehhez a connectorhoz, majd indítsd újra a műveletet.`,
        )
      }
      throw e
    }
  },
}
