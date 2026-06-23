import {
  buildDatabaseModeInfo,
  DATABASE_MODE_KEY,
  DATABASE_SYNC_KEY,
  isTestDatabaseConfigured,
  serializeDatabaseModeState,
  setActiveDatabaseMode,
  type DatabaseMode,
  type DatabaseModeInfo,
  type DatabaseModeState,
  type DatabaseSyncStatus,
  parseDatabaseModeState,
} from '@/lib/database-mode'
import {
  describeSyncMethod,
  syncProductionDatabaseToTest,
  type DatabaseSyncResult,
} from '@/lib/database-sync'
import type { AuditRepository, PlatformSettingsRepository } from '@/repositories/interfaces'
import {
  defaultTicketTypeConfig,
  normalizeTicketTypeConfigs,
  type TicketTransitionConfigRule,
  type TicketTypeConfig,
} from '@/domain/ticket/ticket-type-config'
import {
  MODEL_POLICY_KEY,
  assertModelAllowed,
  normalizeModelPolicy,
  serializeModelPolicy,
  upsertModelPolicyEntry,
  type ModelPolicy,
  type ModelPolicyInput,
} from '@/lib/model-policy'
import type { Prisma, TicketType } from '@prisma/client'

export const DISPATCHER_CONTROLS_KEY = 'dispatcher.controls'
export const TICKET_TYPE_CONFIGS_KEY = 'ticket.type_configs'
export const MONITOR_CONTROLS_KEY = 'monitor.controls'

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

export type MonitorControls = {
  killSwitch: boolean
  sweepIntervalSec: number
  maxConcurrent: number
  updatedById: string | null
  updatedAt: string | null
}

const DEFAULT_MONITOR_CONTROLS: MonitorControls = {
  killSwitch: false,
  sweepIntervalSec: 60,
  maxConcurrent: 5,
  updatedById: null,
  updatedAt: null,
}

const DEFAULT_SYNC_STATUS: DatabaseSyncStatus = {
  status: 'idle',
  method: null,
  startedAt: null,
  completedAt: null,
  startedById: null,
  error: null,
  tableCount: null,
  rowCount: null,
  durationMs: null,
}

const SYNC_STALE_MS = 30 * 60 * 1000

function parseSyncStatus(raw: unknown): DatabaseSyncStatus {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_SYNC_STATUS }
  const value = raw as Partial<DatabaseSyncStatus>
  return {
    status:
      value.status === 'running' ||
      value.status === 'succeeded' ||
      value.status === 'failed' ||
      value.status === 'idle'
        ? value.status
        : 'idle',
    method: value.method === 'neon_restore' || value.method === 'pg_copy' ? value.method : null,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : null,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : null,
    startedById: typeof value.startedById === 'string' ? value.startedById : null,
    error: typeof value.error === 'string' ? value.error : null,
    tableCount: typeof value.tableCount === 'number' ? value.tableCount : null,
    rowCount: typeof value.rowCount === 'number' ? value.rowCount : null,
    durationMs: typeof value.durationMs === 'number' ? value.durationMs : null,
  }
}

function isSyncRunning(status: DatabaseSyncStatus): boolean {
  if (status.status !== 'running' || !status.startedAt) return false
  const started = Date.parse(status.startedAt)
  if (!Number.isFinite(started)) return false
  return Date.now() - started < SYNC_STALE_MS
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

  async getTicketTypeConfigs(): Promise<TicketTypeConfig[]> {
    const raw = await this.settings.get(TICKET_TYPE_CONFIGS_KEY)
    return normalizeTicketTypeConfigs(raw)
  }

  async getTicketTypeConfig(type: TicketType): Promise<TicketTypeConfig> {
    const configs = await this.getTicketTypeConfigs()
    return configs.find((config) => config.type === type) ?? defaultTicketTypeConfig(type)
  }

  async upsertTicketTypeConfig(
    input: { type: TicketType; allowedTransitions: TicketTransitionConfigRule[] },
    actorId: string,
  ): Promise<TicketTypeConfig[]> {
    const current = await this.getTicketTypeConfigs()
    const updatedAt = new Date().toISOString()
    const next = current.map((config) =>
      config.type === input.type
        ? {
            type: input.type,
            allowedTransitions: input.allowedTransitions,
            updatedById: actorId,
            updatedAt,
          }
        : config,
    )

    await this.settings.set(
      TICKET_TYPE_CONFIGS_KEY,
      Object.fromEntries(
        next.map((config) => [
          config.type,
          {
            allowedTransitions: config.allowedTransitions,
            updatedById: config.updatedById,
            updatedAt: config.updatedAt,
          },
        ]),
      ),
      actorId,
    )

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'ticket_type.upsert',
      targetType: 'ticket_type',
      targetId: null,
      modelUsed: null,
      inputRef: input.type,
      outputRef: String(input.allowedTransitions.length),
      policyDecision: 'allowed',
      metadata: { type: input.type, allowedTransitions: input.allowedTransitions },
    })

    return next
  }

  async getModelPolicy(): Promise<ModelPolicy> {
    const raw = await this.settings.get(MODEL_POLICY_KEY)
    return normalizeModelPolicy(raw)
  }

  async assertModelAllowed(provider: string, model: string): Promise<void> {
    const policy = await this.getModelPolicy()
    assertModelAllowed(policy, provider, model)
  }

  async upsertModelPolicyEntry(input: ModelPolicyInput, actorId: string): Promise<ModelPolicy> {
    const current = await this.getModelPolicy()
    const next = upsertModelPolicyEntry(current, input, actorId)

    await this.settings.set(MODEL_POLICY_KEY, serializeModelPolicy(next), actorId)

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'model_policy.upsert',
      targetType: 'model_policy',
      targetId: null,
      modelUsed: `${input.provider}/${input.model}`,
      inputRef: input.provider,
      outputRef: input.enabled ? 'enabled' : 'disabled',
      policyDecision: 'allowed',
      metadata: {
        provider: input.provider,
        model: input.model,
        enabled: input.enabled,
        ...(input.label ? { label: input.label } : {}),
        ...(input.description ? { description: input.description } : {}),
      },
    })

    return next
  }

  async getMonitorControls(): Promise<MonitorControls> {
    const raw = (await this.settings.get(MONITOR_CONTROLS_KEY)) as Partial<MonitorControls> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_MONITOR_CONTROLS }
    return {
      killSwitch: typeof raw.killSwitch === 'boolean' ? raw.killSwitch : DEFAULT_MONITOR_CONTROLS.killSwitch,
      sweepIntervalSec:
        typeof raw.sweepIntervalSec === 'number' && raw.sweepIntervalSec >= 10
          ? raw.sweepIntervalSec
          : DEFAULT_MONITOR_CONTROLS.sweepIntervalSec,
      maxConcurrent:
        typeof raw.maxConcurrent === 'number' && raw.maxConcurrent >= 1
          ? raw.maxConcurrent
          : DEFAULT_MONITOR_CONTROLS.maxConcurrent,
      updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  async isMonitorEnabled(): Promise<boolean> {
    const controls = await this.getMonitorControls()
    return !controls.killSwitch
  }

  async setMonitorControls(
    input: { killSwitch?: boolean; sweepIntervalSec?: number; maxConcurrent?: number },
    actorId: string,
  ): Promise<MonitorControls> {
    const current = await this.getMonitorControls()
    const next: MonitorControls = {
      killSwitch: input.killSwitch ?? current.killSwitch,
      sweepIntervalSec:
        input.sweepIntervalSec !== undefined
          ? Math.max(10, Math.min(3600, input.sweepIntervalSec))
          : current.sweepIntervalSec,
      maxConcurrent:
        input.maxConcurrent !== undefined
          ? Math.max(1, Math.min(20, input.maxConcurrent))
          : current.maxConcurrent,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }

    await this.settings.set(MONITOR_CONTROLS_KEY, next as unknown as Prisma.InputJsonObject, actorId)

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: current.killSwitch !== next.killSwitch
        ? next.killSwitch ? 'monitor.paused' : 'monitor.resumed'
        : 'monitor.config_changed',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: next.killSwitch ? 'paused' : 'enabled',
      metadata: {
        killSwitch: next.killSwitch,
        sweepIntervalSec: next.sweepIntervalSec,
        maxConcurrent: next.maxConcurrent,
      },
    })

    return next
  }

  async getDatabaseMode(): Promise<DatabaseModeInfo> {
    const raw = await this.settings.get(DATABASE_MODE_KEY)
    return buildDatabaseModeInfo(parseDatabaseModeState(raw))
  }

  async setDatabaseMode(mode: DatabaseMode, actorId: string): Promise<DatabaseModeInfo> {
    if (mode === 'test' && !isTestDatabaseConfigured()) {
      throw new Error('A teszt adatbázis nincs konfigurálva (DATABASE_URL_TEST hiányzik)')
    }

    const current = parseDatabaseModeState(await this.settings.get(DATABASE_MODE_KEY))
    const next: DatabaseModeState = serializeDatabaseModeState({
      mode,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    })

    await this.settings.set(
      DATABASE_MODE_KEY,
      {
        mode: next.mode,
        updatedById: next.updatedById,
        updatedAt: next.updatedAt,
      },
      actorId,
    )

    setActiveDatabaseMode(next.mode)

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'database.mode_changed',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: next.mode,
      metadata: { previousMode: current.mode, mode: next.mode },
    })

    return buildDatabaseModeInfo(next)
  }

  async getDatabaseSyncStatus(): Promise<DatabaseSyncStatus> {
    const raw = await this.settings.get(DATABASE_SYNC_KEY)
    const status = parseSyncStatus(raw)
    if (status.status === 'running' && !isSyncRunning(status)) {
      return { ...status, status: 'failed', error: status.error ?? 'A szinkron időtúllépés miatt megszakadt' }
    }
    return status
  }

  private async writeSyncStatus(status: DatabaseSyncStatus): Promise<void> {
    await this.settings.set(DATABASE_SYNC_KEY, status)
  }

  async syncTestDatabaseFromProduction(actorId: string): Promise<DatabaseSyncResult> {
    if (!isTestDatabaseConfigured()) {
      throw new Error('A teszt adatbázis nincs konfigurálva (DATABASE_URL_TEST hiányzik)')
    }

    const current = await this.getDatabaseSyncStatus()
    if (isSyncRunning(current)) {
      throw new Error('Már fut egy szinkron — várj a befejezésre')
    }

    const runningStatus: DatabaseSyncStatus = {
      status: 'running',
      method: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      startedById: actorId,
      error: null,
      tableCount: null,
      rowCount: null,
      durationMs: null,
    }
    await this.writeSyncStatus(runningStatus)

    try {
      const result = await syncProductionDatabaseToTest()
      const completed: DatabaseSyncStatus = {
        status: 'succeeded',
        method: result.method,
        startedAt: runningStatus.startedAt,
        completedAt: new Date().toISOString(),
        startedById: actorId,
        error: null,
        tableCount: result.tableCount,
        rowCount: result.rowCount,
        durationMs: result.durationMs,
      }
      await this.writeSyncStatus(completed)

      await this.audit.append({
        actorType: 'human',
        actorId,
        agentVersion: null,
        action: 'database.test_synced_from_production',
        targetType: 'platform_setting',
        targetId: null,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: result.method,
        metadata: {
          method: result.method,
          methodLabel: describeSyncMethod(result.method),
          tableCount: result.tableCount,
          rowCount: result.rowCount,
          durationMs: result.durationMs,
          operationId: result.operationId ?? null,
        },
      })

      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Ismeretlen hiba'
      await this.writeSyncStatus({
        status: 'failed',
        method: null,
        startedAt: runningStatus.startedAt,
        completedAt: new Date().toISOString(),
        startedById: actorId,
        error: message,
        tableCount: null,
        rowCount: null,
        durationMs: null,
      })
      throw error
    }
  }
}
