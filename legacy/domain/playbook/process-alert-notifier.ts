import type { ProcessAlertNotifier } from '@/domain/playbook/process-service'
import {
  AuditOnlyMonitorNotifier,
  type MonitorNotifier,
  type MonitorNotificationInput,
} from '@/lib/notify/monitor-notifier'

/**
 * Best-effort riasztó adapter elakadt Futásokhoz (feature-spec §4.5, §4.11).
 * A meglévő monitor-notifier útvonalat használja, így a `chat:<kulcs>` csatornák
 * továbbra is szerveroldali, allowlistolt webhook env-ekre mutatnak.
 */
export class MonitorProcessAlertNotifier implements ProcessAlertNotifier {
  constructor(
    private readonly notifier: MonitorNotifier = new AuditOnlyMonitorNotifier(),
    private readonly channel = process.env.PROCESS_BLOCKED_NOTIFY_CHANNEL?.trim() || 'audit-only:process-blocked',
  ) {}

  async processBlocked(input: {
    tenantId: string | null
    processInstanceId: string
    stepId: string
    reason: string
  }): Promise<void> {
    const now = new Date()
    const notification: MonitorNotificationInput = {
      channel: this.channel,
      tenantId: input.tenantId ?? 'system',
      monitorId: `process:${input.processInstanceId}`,
      monitorTitle: 'Elakadt Futás',
      monitorKind: 'composite',
      monitorRunId: input.processInstanceId,
      dedupKey: `process-blocked:${input.processInstanceId}:${input.stepId}`,
      ticketId: input.stepId,
      signalTitle: input.reason,
      severity: 100,
      dueBy: null,
      payload: {
        processInstanceId: input.processInstanceId,
        stepId: input.stepId,
        reason: input.reason,
      },
      createdAt: now,
    }
    await this.notifier.send(notification)
  }
}
