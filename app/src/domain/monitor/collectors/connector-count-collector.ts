import type { CollectorContext, MonitorCollector, MonitorSignalDraft } from './types'

/**
 * Connector-count collector (Feature-spec — Proactive Monitor §5.2, `connector_count` kind).
 *
 * Egy connector-forrás (pl. postafiók) feldolgozatlan elem-számát figyeli a Tool Broker
 * `mailbox_count` capability-n át (§4.11.7 kötelező kontroll — nincs közvetlen elérés).
 *
 * Az MVP-ben stub implementáció: ha nincs élő connector, nulla jelet bocsát ki. A tényleges
 * Tool Broker capability (`mailbox_count`) bevezetésekor cseréljük ki (D-PM-3 döntés).
 */
export class ConnectorCountCollector implements MonitorCollector {
  readonly kind = 'connector_count' as const

  async collect(ctx: CollectorContext): Promise<MonitorSignalDraft[]> {
    const threshold = Number(ctx.config.threshold ?? 0)
    const connectorId = ctx.config.connectorId as string | undefined
    const label = (ctx.config.label as string | undefined) ?? 'connector'

    // TODO (PM-B follow-up, D-PM-3): Tool Broker `mailbox_count` capability hívás.
    // Jelenleg stub: ha nincs élő capability, csendes alapállapotot adunk vissza.
    void threshold
    void connectorId
    void label
    void ctx

    return []
  }
}
