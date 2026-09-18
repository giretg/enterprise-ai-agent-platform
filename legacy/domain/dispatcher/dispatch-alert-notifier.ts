import type { MonitorNotifier, MonitorNotificationInput } from '@/lib/notify/monitor-notifier'
import { AuditOnlyMonitorNotifier } from '@/lib/notify/monitor-notifier'
import type { PlatformSettingsService } from '@/domain/platform-settings/platform-settings-service'

export type DispatchBlockedNotificationInput = {
  tenantId: string | null
  ticketId: string
  ticketTitle: string
  category: 'permanent' | 'transient'
  failureCount: number
  maxRetries: number
  error: string | null
  createdAt?: Date
}

export type DispatchBlockedNotificationResult = {
  provider: string
  messageId?: string | null
  channel: string
}

export interface DispatchAlertNotifier {
  dispatchBlocked(
    input: DispatchBlockedNotificationInput,
  ): Promise<DispatchBlockedNotificationResult>
}

/**
 * Best-effort dispatcher alert adapter. It reuses the existing monitor notifier
 * routing, so `chat:<key>` still resolves through the server-side webhook
 * allowlist (`MONITOR_NOTIFY_WEBHOOK_<KEY>`), while unconfigured channels fall
 * back to audit-only.
 */
export class MonitorDispatchAlertNotifier implements DispatchAlertNotifier {
  constructor(
    private readonly notifier: MonitorNotifier = new AuditOnlyMonitorNotifier(),
    private readonly opts: {
      channel?: string
      platformSettings?: PlatformSettingsService
    } = {},
  ) {}

  private async resolveChannel(): Promise<string> {
    if (this.opts.platformSettings) {
      const controls = await this.opts.platformSettings.getDispatcherControls()
      return controls.blockedNotifyChannel
    }
    return this.opts.channel?.trim() ||
      process.env.DISPATCH_BLOCKED_NOTIFY_CHANNEL?.trim() ||
      'audit-only:dispatch-blocked'
  }

  async dispatchBlocked(
    input: DispatchBlockedNotificationInput,
  ): Promise<DispatchBlockedNotificationResult> {
    const now = input.createdAt ?? new Date()
    const channel = await this.resolveChannel()
    const notification: MonitorNotificationInput = {
      channel,
      tenantId: input.tenantId ?? 'system',
      monitorId: `dispatch:${input.ticketId}`,
      monitorTitle: 'Elakadt ticket dispatch',
      monitorKind: 'composite',
      monitorRunId: input.ticketId,
      dedupKey: `dispatch-blocked:${input.ticketId}`,
      ticketId: input.ticketId,
      signalTitle: `${input.ticketTitle} (${input.category}, ${input.failureCount}/${input.maxRetries})`,
      severity: 100,
      dueBy: null,
      payload: {
        ticketId: input.ticketId,
        category: input.category,
        failureCount: input.failureCount,
        maxRetries: input.maxRetries,
        error: input.error,
      },
      createdAt: now,
    }
    const result = await this.notifier.send(notification)
    return { ...result, channel }
  }
}
