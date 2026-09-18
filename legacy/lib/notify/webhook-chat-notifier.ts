import {
  type MonitorNotificationInput,
  type MonitorNotificationResult,
  type MonitorNotifier,
  targetFromChannel,
} from './monitor-notifier'

/**
 * Valós chat-értesítő adapter (Feature-spec — Proactive Monitor §7) Slack / Microsoft
 * Teams / Google Chat incoming-webhook formátumhoz (egyszerű `{ text }` JSON POST,
 * extra függőség nélkül).
 *
 * Governance (§8): a webhook URL-t SOHA nem a felhasználó által megadott
 * `notifyChannel` string adja, hanem egy **allowlistolt környezeti változó**. A
 * csatorna `chat:<kulcs>` alakú; a `<kulcs>` egy szerveroldalon konfigurált,
 * megbízható webhook env-re mutat (`MONITOR_NOTIFY_WEBHOOK_<KULCS>`). Így nincs
 * SSRF a channel-stringből, a deny-by-default egress elv megmarad.
 *
 * Az értesítés best-effort és figyelemfelhívás a board-ticketre — a hiba nem
 * bukatja a söprést (a MonitorService `monitor.notify.failed` audittal kezeli).
 */
export class WebhookChatNotifier implements MonitorNotifier {
  constructor(
    private readonly deps: {
      env?: Record<string, string | undefined>
      fetchFn?: typeof fetch
      timeoutMs?: number
    } = {},
  ) {}

  private resolveWebhookUrl(channelKey: string): string {
    const key = channelKey.trim()
    if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) {
      throw new Error(`webhook chat: invalid channel key "${channelKey}"`)
    }
    const env = this.deps.env ?? process.env
    const envName = `MONITOR_NOTIFY_WEBHOOK_${key.toUpperCase().replace(/-/g, '_')}`
    const url = env[envName]?.trim()
    if (!url) {
      throw new Error(`webhook chat: ${envName} not configured (channel "${channelKey}")`)
    }
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`webhook chat: ${envName} is not a valid URL`)
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`webhook chat: ${envName} must use https`)
    }
    return parsed.toString()
  }

  private boardLink(): string | null {
    const base = (this.deps.env ?? process.env).NEXT_PUBLIC_APP_URL?.replace(/\/$/, '')
    return base ? `${base}/control-plane/board` : null
  }

  private buildText(input: MonitorNotificationInput): string {
    const lines = [
      `🔔 Monitor: ${input.monitorTitle} (${input.monitorKind})`,
      `Jel: ${input.signalTitle} — súlyosság ${input.severity}`,
    ]
    if (input.dueBy) lines.push(`Határidő: ${input.dueBy.toISOString()}`)
    const link = this.boardLink()
    lines.push(link ? `Board ticket: ${link} (#${input.ticketId})` : `Board ticket: #${input.ticketId}`)
    return lines.join('\n')
  }

  async send(input: MonitorNotificationInput): Promise<MonitorNotificationResult> {
    const url = this.resolveWebhookUrl(targetFromChannel(input.channel))
    const fetchFn = this.deps.fetchFn ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 5000)
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: this.buildText(input) }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`webhook chat: POST failed with status ${res.status}`)
      }
      return {
        provider: 'chat',
        messageId: `chat:${input.monitorRunId}:${input.ticketId}`,
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
