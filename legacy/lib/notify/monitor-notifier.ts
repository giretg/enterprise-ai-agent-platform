import type { MonitorKind } from '@prisma/client'

export type MonitorNotificationInput = {
  channel: string
  tenantId: string
  monitorId: string
  monitorTitle: string
  monitorKind: MonitorKind
  monitorRunId: string
  dedupKey: string
  ticketId: string
  signalTitle: string
  severity: number
  dueBy: Date | null
  payload: Record<string, unknown>
  createdAt: Date
}

export type MonitorNotificationResult = {
  provider: string
  messageId?: string | null
}

export interface MonitorNotifier {
  send(input: MonitorNotificationInput): Promise<MonitorNotificationResult>
}

/** A csatorna-string provider előtagja (pl. `chat:ops` → `chat`). */
export function providerFromChannel(channel: string): string {
  const separator = channel.indexOf(':')
  if (separator <= 0) return 'audit-only'
  return channel.slice(0, separator).trim().toLowerCase() || 'audit-only'
}

/** A provider utáni cél-rész (pl. `chat:ops` → `ops`). */
export function targetFromChannel(channel: string): string {
  const separator = channel.indexOf(':')
  if (separator < 0) return ''
  return channel.slice(separator + 1).trim()
}

/**
 * Safe default notification adapter: records an auditable send result without
 * contacting an external e-mail/chat provider. A real provider can implement the
 * same interface and be injected into MonitorService.
 */
export class AuditOnlyMonitorNotifier implements MonitorNotifier {
  async send(input: MonitorNotificationInput): Promise<MonitorNotificationResult> {
    return {
      provider: providerFromChannel(input.channel),
      messageId: `monitor:${input.monitorId}:${input.ticketId}`,
    }
  }
}

/**
 * Csatorna-provider szerint útválasztó notifier. A `notifyChannel` előtagja (pl.
 * `chat:` / `email:`) választja ki a konkrét adaptert; ismeretlen vagy be nem
 * kötött provider esetén a biztonságos `fallback`-re esik vissza (alapból
 * audit-only). Így egy valós provider hozzáadása nem töri meg a meglévő
 * csatornákat, és az értesítés best-effort marad (§7).
 */
export class RoutingMonitorNotifier implements MonitorNotifier {
  constructor(
    private routes: Record<string, MonitorNotifier>,
    private fallback: MonitorNotifier = new AuditOnlyMonitorNotifier(),
  ) {}

  async send(input: MonitorNotificationInput): Promise<MonitorNotificationResult> {
    const provider = providerFromChannel(input.channel)
    const notifier = this.routes[provider] ?? this.fallback
    return notifier.send(input)
  }
}
