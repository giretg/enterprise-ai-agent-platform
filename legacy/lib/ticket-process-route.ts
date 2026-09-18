/**
 * A /process végpont routingja a ticket `payload.source` mezője alapján.
 *
 * - hiányzó / üres / `wiki`  → WikiAgentRuntime (visszafelé kompatibilis: a
 *   wiki ticketek nem írnak source mezőt)
 * - minden más forrás (`agent_chat`, `agent_tool`, `agent_ask`/delegálás, …)
 *   → GeneralTaskRuntime, az egységes tool loop
 */
export type TicketProcessRoute = 'wiki' | 'general'

export function resolveTicketProcessRoute(payload: unknown): TicketProcessRoute {
  const source =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).source
      : undefined
  if (typeof source !== 'string' || source.trim() === '' || source === 'wiki') {
    return 'wiki'
  }
  return 'general'
}
