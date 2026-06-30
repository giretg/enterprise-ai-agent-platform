import { getAgentWebSearchCalls } from '@/app/actions/web-search'
import { parseWebSearchConfig } from '@/domain/web-search/web-search-types'
import { Badge, Card } from '@/components/ui/shell'

type GovernanceConnectorItem = {
  connector: { id: string; type: string; name: string; config: unknown }
}

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral'> = {
  ok: 'success',
  denied: 'danger',
  error: 'warning',
  rate_limited: 'warning',
}

/** Feature-spec — WebSearchTool §7.1: web_search capability + policy + utolsó 10 hívás. */
export async function WebSearchPolicyCard({
  agentId,
  connectors,
}: {
  agentId: string
  connectors: GovernanceConnectorItem[]
}) {
  const webSearchConnector = connectors.find((item) => item.connector.type === 'web_search')
  if (!webSearchConnector) return null

  const config = parseWebSearchConfig(webSearchConnector.connector.config)
  const callsRes = await getAgentWebSearchCalls({ agentId })
  const calls = callsRes.success ? callsRes.data : []

  return (
    <Card title="Web Search policy">
      <div className="space-y-4 text-sm">
        <div>
          <p className="text-ink-soft">
            Connector: <span className="font-medium text-ink">{webSearchConnector.connector.name}</span>
          </p>
          <p className="mt-1 text-xs text-ink-faint">
            {config.allowGeneralWeb
              ? 'Általános web engedélyezve (tiltólista + query-safety aktív)'
              : 'Csak explicit domain allowlist (banki/PSP preset)'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="atelier-soft p-2">
            <p className="text-ink-faint">Max találat / kérés</p>
            <p className="font-medium text-ink">
              {config.defaultMaxResults} (hard cap {config.hardMaxResults})
            </p>
          </div>
          <div className="atelier-soft p-2">
            <p className="text-ink-faint">Limit</p>
            <p className="font-medium text-ink">
              {config.maxQueriesPerTicket}/ticket · {config.maxQueriesPerAgentDay}/nap
            </p>
          </div>
        </div>

        {config.allowedDomains.length > 0 && (
          <div>
            <p className="text-xs text-ink-faint">Engedélyezett domainek</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {config.allowedDomains.map((domain) => (
                <Badge key={domain} tone="neutral">
                  {domain}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div>
          <p className="text-xs text-ink-faint">Utolsó hívások</p>
          {calls.length === 0 ? (
            <p className="mt-1 text-xs italic text-ink-faint">Még nem volt web_search hívás.</p>
          ) : (
            <ul className="mt-2 space-y-1.5">
              {calls.map((call) => (
                <li key={call.id} className="flex items-center justify-between gap-2 atelier-soft p-2 text-xs">
                  <Badge tone={STATUS_TONE[call.status] ?? 'neutral'}>
                    {call.status === 'denied' ? (call.policyDecision ?? 'denied') : call.status}
                  </Badge>
                  <span className="text-ink-faint">
                    {call.resultCount != null ? `${call.resultCount} találat · ` : ''}
                    {call.latencyMs} ms
                  </span>
                  <span className="text-ink-faint">{new Date(call.createdAt).toLocaleString('hu-HU')}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}
