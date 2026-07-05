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
import { WEB_SEARCH_CONTROLS_KEY } from '@/domain/web-search/web-search-types'
import { WEB_FETCH_CONTROLS_KEY } from '@/domain/web-fetch/web-fetch-types'
import { matchForbiddenHost } from '@/domain/net/egress-guard'

export const DISPATCHER_CONTROLS_KEY = 'dispatcher.controls'
export const DISPATCHER_LAST_CYCLE_KEY = 'dispatcher.last_cycle'
export const TICKET_TYPE_CONFIGS_KEY = 'ticket.type_configs'
export const MONITOR_CONTROLS_KEY = 'monitor.controls'

export const POLL_INTERVAL_MIN_MS = 5_000
export const POLL_INTERVAL_MAX_MS = 600_000
export const DEFAULT_POLL_INTERVAL_MS = 30_000

export const ALL_LAUNCHER_MODES = ['local-wiki', 'docker-local', 'cloud-run-job'] as const
export type LauncherMode = (typeof ALL_LAUNCHER_MODES)[number]

export type DispatcherControls = {
  enabled: boolean
  allowedModes: string[]
  pollIntervalMs: number
  blockedNotifyChannel: string
  updatedById: string | null
  updatedAt: string | null
}

const DEFAULT_CONTROLS: DispatcherControls = {
  enabled: true,
  allowedModes: [...ALL_LAUNCHER_MODES],
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
  blockedNotifyChannel: 'audit-only:dispatch-blocked',
  updatedById: null,
  updatedAt: null,
}

/**
 * Egyetlen dispatch-ciklus (§5.7 kiegészítés — stateless/időzített út) legutóbbi
 * lefutásának lenyomata. Bármelyik hívó írja: a lokális worker (LISTEN/cron),
 * a Cloud Scheduler-hívta stateless endpoint, vagy egy admin-vezérelt kézi
 * futtatás — így az admin UI-n mindig látszik, futott-e egyáltalán a
 * biztonsági háló, függetlenül attól, hogy melyik mechanizmus indította.
 */
export type DispatchCycleRunRecord = {
  ranAt: string
  triggeredBy: 'worker' | 'scheduler' | 'manual'
  ok: boolean
  error: string | null
  reclaimedDispatches: number
  reclaimedScheduledTasks: number
  materializedScheduledTasks: number
  monitorSweepRan: boolean
  monitorEscalated: number
  workspacePurgedTickets: number
  dispatchScanned: number
  dispatchStarted: number
  dispatchBudgetBlocked: number
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

export type WebSearchControls = {
  killSwitch: boolean
  updatedById: string | null
  updatedAt: string | null
}

const DEFAULT_WEB_SEARCH_CONTROLS: WebSearchControls = {
  killSwitch: false,
  updatedById: null,
  updatedAt: null,
}

/**
 * Web Fetch (WS-D) platform-tool vezérlés (Feature-spec — WebFetch-Egress §14).
 * KÉT, egymástól független, ALAPBÓL KIKAPCSOLT flag: a `web_fetch` globális kill-switch
 * és a felfedezés funkció. Bekapcsolatlanul a mai viselkedés bit-azonos (§1.3).
 */
export type WebFetchControls = {
  /** `web_fetch.enabled` — a platform-tool globális kill-switch, default false. */
  enabled: boolean
  /** `provisioning.web_discovery.enabled` — a felfedezés funkció, default false. */
  discoveryEnabled: boolean
  updatedById: string | null
  updatedAt: string | null
}

const DEFAULT_WEB_FETCH_CONTROLS: WebFetchControls = {
  enabled: false,
  discoveryEnabled: false,
  updatedById: null,
  updatedAt: null,
}

/**
 * Futásidőben bővíthető egress-allowlist (Feature-spec — WebFetch-Egress §9, §11.1, §12.2).
 * A determinisztikus validátor `warned`/`failed`-je egy vadonatúj API-hostra a NORMÁL
 * eset a felfedezésnél; az admin explicit, auditált aktussal (`connector.egress_allowlist.extend`)
 * adja hozzá a hostot — nem az asszisztens. A tár tenant-bucketelt; a `__global__` bucket a
 * tenant-független (env feletti) hostoké. Az env `PROVISIONING_EGRESS_ALLOWLIST` ehhez MERGE-elődik.
 */
export const PROVISIONING_EGRESS_ALLOWLIST_KEY = 'provisioning.egress_allowlist'
const EGRESS_GLOBAL_BUCKET = '__global__'
type EgressAllowlistStore = Record<string, string[]>

/**
 * Host-normalizálás az allowlist-bővítéshez: URL → hostname; port/path levágva; kisbetűs.
 * A determinisztikus validátor a `ConnectorConfig.egressHosts` HOSTNAME-jeivel hasonlít, ezért
 * itt is hostname-t tárolunk. Érvénytelen/üres → null.
 */
function normalizeEgressHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  let host = trimmed
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(host)) {
    try {
      host = new URL(host).hostname.toLowerCase()
    } catch {
      return null
    }
  } else {
    host = host.split('/')[0]!.split('@').pop()!.split(':')[0]!
  }
  // Valódi hostname-struktúra: 1..253 karakter, pont-tagolt labelek, minden label
  // alfanumerikussal kezdődik/végződik (nincs üres label, vezető/záró pont, szóköz).
  const HOSTNAME_RE =
    /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/
  if (!host || !HOSTNAME_RE.test(host)) return null
  return host
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
    const rawModes = (raw as Record<string, unknown>).allowedModes
    const allowedModes =
      Array.isArray(rawModes) && rawModes.length > 0
        ? (rawModes as string[]).filter((m) => ALL_LAUNCHER_MODES.includes(m as LauncherMode))
        : [...DEFAULT_CONTROLS.allowedModes]
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CONTROLS.enabled,
      allowedModes,
      pollIntervalMs:
        typeof raw.pollIntervalMs === 'number'
          ? clampInterval(raw.pollIntervalMs)
          : DEFAULT_CONTROLS.pollIntervalMs,
      blockedNotifyChannel:
        typeof raw.blockedNotifyChannel === 'string' && raw.blockedNotifyChannel.trim()
          ? raw.blockedNotifyChannel.trim()
          : DEFAULT_CONTROLS.blockedNotifyChannel,
      updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  /** Csak a dispatch-betartatáshoz kell — olcsó, nem auditál. */
  async isDispatchEnabled(): Promise<boolean> {
    const controls = await this.getDispatcherControls()
    return controls.enabled
  }

  /** Mode-specifikus engedélyezettség: a globális kill-switch ÉS az allowedModes listán van-e. */
  async isDispatchEnabledForMode(mode: string): Promise<boolean> {
    const controls = await this.getDispatcherControls()
    return controls.enabled && controls.allowedModes.includes(mode)
  }

  async setDispatcherControls(
    input: { enabled?: boolean; allowedModes?: string[]; pollIntervalMs?: number; blockedNotifyChannel?: string },
    actorId: string,
  ): Promise<DispatcherControls> {
    const current = await this.getDispatcherControls()
    const nextAllowedModes =
      input.allowedModes !== undefined
        ? input.allowedModes.filter((m) => ALL_LAUNCHER_MODES.includes(m as LauncherMode))
        : current.allowedModes
    const next: DispatcherControls = {
      enabled: input.enabled ?? current.enabled,
      allowedModes: nextAllowedModes,
      pollIntervalMs:
        input.pollIntervalMs !== undefined ? clampInterval(input.pollIntervalMs) : current.pollIntervalMs,
      blockedNotifyChannel: input.blockedNotifyChannel ?? current.blockedNotifyChannel,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }

    await this.settings.set(
      DISPATCHER_CONTROLS_KEY,
      {
        enabled: next.enabled,
        allowedModes: next.allowedModes,
        pollIntervalMs: next.pollIntervalMs,
        blockedNotifyChannel: next.blockedNotifyChannel,
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
      metadata: {
        enabled: next.enabled,
        allowedModes: next.allowedModes,
        pollIntervalMs: next.pollIntervalMs,
        blockedNotifyChannel: next.blockedNotifyChannel,
      },
    })

    return next
  }

  /** Nem auditál (rendszer-belső könyvelés) — csak az admin UI státusz-kijelzéséhez kell. */
  async recordDispatchCycleRun(record: Omit<DispatchCycleRunRecord, 'ranAt'>): Promise<void> {
    await this.settings.set(DISPATCHER_LAST_CYCLE_KEY, {
      ranAt: new Date().toISOString(),
      ...record,
    })
  }

  async getLastDispatchCycleRun(): Promise<DispatchCycleRunRecord | null> {
    const raw = (await this.settings.get(DISPATCHER_LAST_CYCLE_KEY)) as Partial<DispatchCycleRunRecord> | null
    if (!raw || typeof raw !== 'object' || typeof raw.ranAt !== 'string') return null
    return {
      ranAt: raw.ranAt,
      triggeredBy:
        raw.triggeredBy === 'worker' || raw.triggeredBy === 'scheduler' || raw.triggeredBy === 'manual'
          ? raw.triggeredBy
          : 'worker',
      ok: typeof raw.ok === 'boolean' ? raw.ok : false,
      error: typeof raw.error === 'string' ? raw.error : null,
      reclaimedDispatches: typeof raw.reclaimedDispatches === 'number' ? raw.reclaimedDispatches : 0,
      reclaimedScheduledTasks:
        typeof raw.reclaimedScheduledTasks === 'number' ? raw.reclaimedScheduledTasks : 0,
      materializedScheduledTasks:
        typeof raw.materializedScheduledTasks === 'number' ? raw.materializedScheduledTasks : 0,
      monitorSweepRan: typeof raw.monitorSweepRan === 'boolean' ? raw.monitorSweepRan : false,
      monitorEscalated: typeof raw.monitorEscalated === 'number' ? raw.monitorEscalated : 0,
      workspacePurgedTickets: typeof raw.workspacePurgedTickets === 'number' ? raw.workspacePurgedTickets : 0,
      dispatchScanned: typeof raw.dispatchScanned === 'number' ? raw.dispatchScanned : 0,
      dispatchStarted: typeof raw.dispatchStarted === 'number' ? raw.dispatchStarted : 0,
      dispatchBudgetBlocked: typeof raw.dispatchBudgetBlocked === 'number' ? raw.dispatchBudgetBlocked : 0,
    }
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

  async auditMonitorSweepSkipped(reason: string, metadata: Record<string, unknown> = {}): Promise<void> {
    await this.audit.append({
      actorType: 'system',
      actorId: null,
      agentVersion: null,
      action: 'monitor.sweep.skipped',
      targetType: 'monitor',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: reason,
      metadata: metadata as Prisma.JsonValue,
    })
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

  async getWebSearchControls(): Promise<WebSearchControls> {
    const raw = (await this.settings.get(WEB_SEARCH_CONTROLS_KEY)) as Partial<WebSearchControls> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_WEB_SEARCH_CONTROLS }
    return {
      killSwitch: typeof raw.killSwitch === 'boolean' ? raw.killSwitch : DEFAULT_WEB_SEARCH_CONTROLS.killSwitch,
      updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  /** Csak a Tool Broker enforcementhoz kell — olcsó, nem auditál (WS13). */
  async isWebSearchEnabled(): Promise<boolean> {
    const controls = await this.getWebSearchControls()
    return !controls.killSwitch
  }

  async setWebSearchControls(input: { killSwitch: boolean }, actorId: string): Promise<WebSearchControls> {
    const current = await this.getWebSearchControls()
    const next: WebSearchControls = {
      killSwitch: input.killSwitch,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }

    await this.settings.set(WEB_SEARCH_CONTROLS_KEY, next as unknown as Prisma.InputJsonObject, actorId)

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action:
        current.killSwitch !== next.killSwitch
          ? next.killSwitch
            ? 'web_search.paused'
            : 'web_search.resumed'
          : 'web_search.config_changed',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: next.killSwitch ? 'paused' : 'enabled',
      metadata: { killSwitch: next.killSwitch },
    })

    return next
  }

  async getWebFetchControls(): Promise<WebFetchControls> {
    const raw = (await this.settings.get(WEB_FETCH_CONTROLS_KEY)) as Partial<WebFetchControls> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_WEB_FETCH_CONTROLS }
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_WEB_FETCH_CONTROLS.enabled,
      discoveryEnabled:
        typeof raw.discoveryEnabled === 'boolean'
          ? raw.discoveryEnabled
          : DEFAULT_WEB_FETCH_CONTROLS.discoveryEnabled,
      updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  /** Csak a web_fetch enforcementhoz kell — olcsó, nem auditál (§7.2/1). */
  async isWebFetchEnabled(): Promise<boolean> {
    const controls = await this.getWebFetchControls()
    return controls.enabled
  }

  /** A felfedezés feature-flag (§14, `provisioning.web_discovery.enabled`). */
  async isWebDiscoveryEnabled(): Promise<boolean> {
    const controls = await this.getWebFetchControls()
    return controls.discoveryEnabled
  }

  /**
   * A tenant futásidőben bővített egress-allowlistje (§9). A `__global__` bucket + a tenant
   * saját hostjai; kisbetűsítve, deduplikálva. Az env-listával a wiring MERGE-eli (domain/index).
   * Olcsó, nem auditál (a validátor / a fetch-őr olvassa).
   */
  async getEgressAllowlist(tenantId: string | null): Promise<string[]> {
    const raw = (await this.settings.get(PROVISIONING_EGRESS_ALLOWLIST_KEY)) as EgressAllowlistStore | null
    if (!raw || typeof raw !== 'object') return []
    const pick = (k: string): string[] => (Array.isArray(raw[k]) ? raw[k] : [])
    return [
      ...new Set(
        [...pick(EGRESS_GLOBAL_BUCKET), ...(tenantId ? pick(tenantId) : [])]
          .filter((h): h is string => typeof h === 'string')
          .map((h) => h.toLowerCase()),
      ),
    ]
  }

  /**
   * Új egress-host hozzáadása a tenant allowlistjéhez (§9, §12.2) — KÜLÖN, auditált admin-aktus
   * (`connector.egress_allowlist.extend`, §11.1), sosem az asszisztens teszi. SSRF-tiltott hostot
   * (nyers IP, localhost, metadata, exfil-sink) NEM enged hozzáadni (defense-in-depth az egress-guard
   * host-mintáival). Idempotens: már meglévő host `added:false`.
   */
  async extendEgressAllowlist(
    tenantId: string | null,
    host: string,
    actorId: string,
    provenance?: { sourceType?: 'official' | 'vendor_doc'; draftId?: string },
  ): Promise<
    | { ok: false; reason: 'invalid_host' | 'forbidden_host' }
    | { ok: true; added: boolean; host: string; hosts: string[] }
  > {
    const normalized = normalizeEgressHost(host)
    if (!normalized) return { ok: false, reason: 'invalid_host' }
    if (matchForbiddenHost(normalized)) return { ok: false, reason: 'forbidden_host' }

    const bucket = tenantId ?? EGRESS_GLOBAL_BUCKET
    const raw = (await this.settings.get(PROVISIONING_EGRESS_ALLOWLIST_KEY)) as EgressAllowlistStore | null
    const store: EgressAllowlistStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const current = (Array.isArray(store[bucket]) ? store[bucket] : [])
      .filter((h): h is string => typeof h === 'string')
      .map((h) => h.toLowerCase())
    if (current.includes(normalized)) {
      return { ok: true, added: false, host: normalized, hosts: current }
    }
    const next = [...current, normalized].sort()
    store[bucket] = next
    await this.settings.set(
      PROVISIONING_EGRESS_ALLOWLIST_KEY,
      store as unknown as Prisma.InputJsonObject,
      actorId,
    )

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'connector.egress_allowlist.extend',
      targetType: 'connector',
      targetId: provenance?.draftId ?? null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: {
        host: normalized,
        tenantId: tenantId ?? null,
        sourceType: provenance?.sourceType ?? null,
        draftId: provenance?.draftId ?? null,
      },
    })

    return { ok: true, added: true, host: normalized, hosts: next }
  }

  async setWebFetchControls(
    input: { enabled?: boolean; discoveryEnabled?: boolean },
    actorId: string,
  ): Promise<WebFetchControls> {
    const current = await this.getWebFetchControls()
    const next: WebFetchControls = {
      enabled: input.enabled ?? current.enabled,
      discoveryEnabled: input.discoveryEnabled ?? current.discoveryEnabled,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }

    await this.settings.set(WEB_FETCH_CONTROLS_KEY, next as unknown as Prisma.InputJsonObject, actorId)

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action:
        current.enabled !== next.enabled
          ? next.enabled
            ? 'web_fetch.resumed'
            : 'web_fetch.paused'
          : 'web_fetch.config_changed',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: next.enabled ? 'enabled' : 'paused',
      metadata: { enabled: next.enabled, discoveryEnabled: next.discoveryEnabled },
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
