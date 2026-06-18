import type { AuditRepository, PlatformSettingsRepository } from '@/repositories/interfaces'

export const DISPATCHER_CONTROLS_KEY = 'dispatcher.controls'

export const POLL_INTERVAL_MIN_MS = 5_000
export const POLL_INTERVAL_MAX_MS = 600_000
export const DEFAULT_POLL_INTERVAL_MS = 30_000

export type DispatcherControls = {
  enabled: boolean
  pollIntervalMs: number
  updatedById: string | null
  updatedAt: string | null
}

const DEFAULT_CONTROLS: DispatcherControls = {
  enabled: true,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  updatedById: null,
  updatedAt: null,
}

function clampInterval(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_POLL_INTERVAL_MS
  return Math.min(POLL_INTERVAL_MAX_MS, Math.max(POLL_INTERVAL_MIN_MS, Math.round(ms)))
}

/**
 * Globális, runtime-állítható platform-beállítások (§5.7 dispatcher vezérlés).
 * A dispatcher kill-switch + poll-intervallum a `platform_settings` táblában él, így a
 * felhős worker újra-deploy nélkül, minden ciklusban friss értéket olvas.
 */
export class PlatformSettingsService {
  constructor(
    private settings: PlatformSettingsRepository,
    private audit: AuditRepository,
  ) {}

  async getDispatcherControls(): Promise<DispatcherControls> {
    const raw = (await this.settings.get(DISPATCHER_CONTROLS_KEY)) as Partial<DispatcherControls> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CONTROLS }
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONTROLS.enabled,
      pollIntervalMs:
        typeof raw.pollIntervalMs === 'number'
          ? clampInterval(raw.pollIntervalMs)
          : DEFAULT_CONTROLS.pollIntervalMs,
      updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  /** Csak a dispatch-betartatáshoz kell — olcsó, nem auditál. */
  async isDispatchEnabled(): Promise<boolean> {
    const controls = await this.getDispatcherControls()
    return controls.enabled
  }

  async setDispatcherControls(
    input: { enabled?: boolean; pollIntervalMs?: number },
    actorId: string,
  ): Promise<DispatcherControls> {
    const current = await this.getDispatcherControls()
    const next: DispatcherControls = {
      enabled: input.enabled ?? current.enabled,
      pollIntervalMs:
        input.pollIntervalMs !== undefined ? clampInterval(input.pollIntervalMs) : current.pollIntervalMs,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }

    await this.settings.set(
      DISPATCHER_CONTROLS_KEY,
      {
        enabled: next.enabled,
        pollIntervalMs: next.pollIntervalMs,
        updatedById: next.updatedById,
        updatedAt: next.updatedAt,
      },
      actorId,
    )

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: current.enabled !== next.enabled
        ? next.enabled
          ? 'dispatcher.resumed'
          : 'dispatcher.paused'
        : 'dispatcher.config_changed',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: next.enabled ? 'enabled' : 'paused',
      metadata: { enabled: next.enabled, pollIntervalMs: next.pollIntervalMs },
    })

    return next
  }
}
