import type { FeatureFlagReader } from './evaluator'
import type { FeatureFlagExternalClient, FeatureFlagRegistry, FeatureFlagStopBehavior } from './registry'

export type ExternalClientFlag = { key: string; onStop: FeatureFlagStopBehavior }

/**
 * #1126 WP-5: a chat-worker és a Hermes nem éri el a kiértékelőt, ezért a szerver adja át a döntést.
 * Csak a kliensnek szánt, a cégnél aktív flagek mennek ki, így a teljes lista és a kiadatlan funkciók nem
 * derülnek ki. Ha egy flag sincs a kliensnek szánva, a kiértékelőt sem kérdezi, tehát adatbázist sem.
 */
export function createExternalClientFlags(registry: FeatureFlagRegistry, reader: FeatureFlagReader<never>) {
  const entries = Object.entries(registry)
    .flatMap(([key, def]) => (def.externalClients ? [{ key, ...def.externalClients }] : []))
    .sort((a, b) => a.key.localeCompare(b.key))
  return async (client: FeatureFlagExternalClient, tenantId: string): Promise<ExternalClientFlag[]> => {
    const candidates = entries.filter((entry) => entry.clients.includes(client))
    const active = await Promise.all(candidates.map((entry) => reader.isEnabled(entry.key as never, { tenantId })))
    return candidates.filter((_, index) => active[index]).map(({ key, onStop }) => ({ key, onStop }))
  }
}
