import { loadConnectorApiKeyByRef } from '@/domain/connector/connector-secret-store'
import { braveSearchProvider } from '@/domain/web-search/brave-provider'
import { runWebSearch, type WebSearchConfig, type WebSearchEffectiveQuery, type WebSearchResult } from '@/domain/web-search/web-search'
import type { LiveConnectorRow } from '../authorize-tool-call'

/** A kulcs a connector secret-refje mögött (Secret Manager); a DB csak a referenciát tartja. */
export async function executeWebSearch(
  effective: WebSearchEffectiveQuery,
  config: WebSearchConfig,
  connector: LiveConnectorRow,
): Promise<WebSearchResult> {
  if (!connector.secretAlias) throw new Error('web_search_key_missing')
  const apiKey = await loadConnectorApiKeyByRef(connector.secretAlias)
  return runWebSearch(braveSearchProvider(apiKey), effective, config)
}
