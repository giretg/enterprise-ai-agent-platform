import type { CollectorContext, MonitorCollector, MonitorSignalDraft } from './types'
import type { AgentRepository } from '@/repositories/interfaces'
import type { ToolBrokerInvokeResult, ToolBrokerService } from '@/domain/tool-broker/tool-broker-service'
import { createHash } from 'node:crypto'

type ToolBrokerInvoker = Pick<ToolBrokerService, 'invoke'>

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function numberValue(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
  return items.length > 0 ? items.map((item) => item.trim()) : undefined
}

function queryKey(query: string, labelIds: string[] | undefined): string {
  const raw = JSON.stringify({ query, labelIds: labelIds ?? [] })
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

function countFromResult(result: ToolBrokerInvokeResult): number {
  if (result.denied) throw new Error(`mailbox_count denied: ${result.reason}`)
  const payload = result.result
  if (typeof payload === 'object' && payload !== null && 'count' in payload) {
    const count = Number((payload as { count: unknown }).count)
    if (Number.isFinite(count)) return count
  }
  throw new Error('mailbox_count invalid result')
}

/**
 * Connector-count collector (Feature-spec — Proactive Monitor §5.2, `connector_count` kind).
 *
 * Egy connector-forrás (pl. postafiók) feldolgozatlan elem-számát figyeli a Tool Broker
 * `mailbox_count` capability-n át (§4.11.7 kötelező kontroll — nincs közvetlen elérés).
 *
 * Ha nincs konfigurált agent, megőrzi a korábbi csendes stub viselkedést. Ha van agent,
 * minden olvasás a Tool Broker `mailbox_count` capability-jén megy át.
 */
export class ConnectorCountCollector implements MonitorCollector {
  readonly kind = 'connector_count' as const

  constructor(
    private broker?: ToolBrokerInvoker,
    private agents?: AgentRepository,
  ) {}

  async collect(ctx: CollectorContext): Promise<MonitorSignalDraft[]> {
    const threshold = Math.max(0, numberValue(ctx.config.threshold, 0))
    const connectorId = stringValue(ctx.config.connectorId)
    const configuredAgentId = stringValue(ctx.config.agentId)
    const agentId = configuredAgentId ?? ctx.monitor?.escalateAgentId ?? undefined
    const actingUserId = stringValue(ctx.config.actingUserId)
    const query = stringValue(ctx.config.query) ?? ''
    const labelIds = stringArray(ctx.config.labelIds)
    const includeSpamTrash = booleanValue(ctx.config.includeSpamTrash)
    const label = stringValue(ctx.config.label) ?? 'Postafiók'

    if (!this.broker || !this.agents || !agentId) return []

    const agent = await this.agents.findById(agentId)
    if (!agent) throw new Error(`connector_count agent not found: ${agentId}`)

    const count = countFromResult(
      await this.broker.invoke({
        agentId,
        agentVersion: agent.currentVersion,
        actingUserId,
        tool: 'mailbox_count',
        args: {
          connectorId,
          query,
          labelIds,
          includeSpamTrash,
        },
      }),
    )

    if (count <= threshold) return []

    const overBy = count - threshold
    const severity = Math.min(100, Math.max(1, Math.round((overBy / Math.max(threshold, 1)) * 100)))
    const qKey = queryKey(query, labelIds)

    return [
      {
        dedupKeyParts: {
          connectorId: connectorId ?? 'gmail-default',
          agentId,
          queryKey: qKey,
        },
        severity,
        title: `${label}: ${count} elem a küszöb felett`,
        payload: {
          connectorId: connectorId ?? null,
          agentId,
          actingUserId: actingUserId ?? null,
          query,
          queryKey: qKey,
          labelIds: labelIds ?? [],
          includeSpamTrash: includeSpamTrash ?? false,
          count,
          threshold,
          overBy,
          source: 'mailbox_count',
        },
      },
    ]
  }
}
