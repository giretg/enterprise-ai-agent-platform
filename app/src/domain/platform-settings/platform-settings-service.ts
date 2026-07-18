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
import { Prisma } from '@prisma/client'
import type { TicketType } from '@prisma/client'
import {
  isWebSearchScopeEnabled,
  WEB_SEARCH_CONTROLS_KEY,
  WEB_SEARCH_TENANT_CONTROLS_KEY,
} from '@/domain/web-search/web-search-types'
import { WEB_FETCH_CONTROLS_KEY } from '@/domain/web-fetch/web-fetch-types'
import { matchForbiddenHost } from '@/domain/net/egress-guard'
import { errorPolicySchema, type ErrorPolicy } from '@/lib/playbook-v2/spec'

export const DISPATCHER_CONTROLS_KEY = 'dispatcher.controls'
export const DISPATCHER_LAST_CYCLE_KEY = 'dispatcher.last_cycle'
export const TICKET_TYPE_CONFIGS_KEY = 'ticket.type_configs'
export const MONITOR_CONTROLS_KEY = 'monitor.controls'
export const AUTOMATION_IDLE_SNAPSHOT_KEY = 'automation.idle_snapshot'

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

/**
 * A söprés ütemét NEM itt szabályozzuk: minden monitor a saját `intervalSeconds`/`nextSweepAt`
 * mezője szerint válik esedékessé (`MonitorRepository.findDue`). A korábbi globális
 * `sweepIntervalSec` throttle csak késleltette az esedékes monitorokat, ráadásul in-memory
 * számlálón ült, ami minden hidegindításnál nullázódott — ezért megszűnt.
 */
export type MonitorControls = {
  killSwitch: boolean
  /** Hány esedékes monitort dolgozunk fel egy körben (sorosan). */
  maxConcurrent: number
  updatedById: string | null
  updatedAt: string | null
}

const DEFAULT_MONITOR_CONTROLS: MonitorControls = {
  killSwitch: false,
  maxConcurrent: 5,
  updatedById: null,
  updatedAt: null,
}

/** Üresjárat mód előtti állapot — visszaállításhoz. */
export type AutomationIdleSnapshot = {
  dispatcherEnabled: boolean
  monitorKillSwitch: boolean
  /** null = Scheduler állapota nem volt lekérdezhető bekapcsoláskor. */
  schedulerState: 'ENABLED' | 'PAUSED' | null
  savedAt: string
}

export type WebSearchControls = {
  killSwitch: boolean
  updatedById: string | null
  updatedAt: string | null
}

/** Ugyanaz a kapcsoló-alak, de tenantonként tárolva (`WEB_SEARCH_TENANT_CONTROLS_KEY`). */
export type WebSearchTenantControls = WebSearchControls

type WebSearchTenantControlsStore = Record<string, Partial<WebSearchTenantControls>>

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

/**
 * Hibapolicy spec §4.2/WP-4 — tenant-szintű alapértelmezett hibaág-policy tárolókulcsa.
 * Egyetlen `PlatformSetting` sor, tenantId → `ErrorPolicy` bucket (ugyanaz a minta, mint az
 * egress-allowlistnél). Élő, NEM pin-elt beállítás — a `PlaybookV2Service.publishPlaybookVersion`
 * olvassa ki publish-időben, és a FELOLDOTT eredmény kerül a `compiled_spec`-be (TE-2).
 */
export const PLAYBOOK_TENANT_DEFAULT_ERROR_POLICY_KEY = 'playbook.tenant_default_error_policy'

/**
 * Chat "thinking-trace" spec §D7/WP-6 — tenant-szintű kapcsoló a modell
 * gondolkodási (reasoning) szövegének chat-megjelenítéséhez. ALAPBÓL KIKAPCSOLVA:
 * amíg a D5 tartalom-őr-lefedettség nincs éles-verifikálva, ne menjen ki
 * alapból nyers reasoning-szöveg. Egyetlen `PlatformSetting` sor, tenantId → bucket.
 */
export const CHAT_THINKING_TRACE_TENANT_KEY = 'chat.thinking_trace_tenant_controls'
type ChatThinkingTraceControls = {
  enabled: boolean
  updatedById: string | null
  updatedAt: string | null
}
type ChatThinkingTraceStore = Record<string, Partial<ChatThinkingTraceControls>>
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
    // Az üres lista érvényes állapot ("egyetlen futtató-környezet sem indíthat agentet"),
    // nem hiányzó érték — csak a nem-tömb alakra esünk vissza az alapértelmezésre.
    const allowedModes = Array.isArray(rawModes)
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
    input: { killSwitch?: boolean; maxConcurrent?: number },
    actorId: string,
  ): Promise<MonitorControls> {
    const current = await this.getMonitorControls()
    const next: MonitorControls = {
      killSwitch: input.killSwitch ?? current.killSwitch,
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
        maxConcurrent: next.maxConcurrent,
      },
    })

    return next
  }

  async getAutomationIdleSnapshot(): Promise<AutomationIdleSnapshot | null> {
    const raw = (await this.settings.get(AUTOMATION_IDLE_SNAPSHOT_KEY)) as Partial<AutomationIdleSnapshot> | null
    if (!raw || typeof raw !== 'object' || typeof raw.savedAt !== 'string') return null
    if (typeof raw.dispatcherEnabled !== 'boolean' || typeof raw.monitorKillSwitch !== 'boolean') return null
    const schedulerState =
      raw.schedulerState === 'ENABLED' || raw.schedulerState === 'PAUSED' ? raw.schedulerState : null
    return {
      dispatcherEnabled: raw.dispatcherEnabled,
      monitorKillSwitch: raw.monitorKillSwitch,
      schedulerState,
      savedAt: raw.savedAt,
    }
  }

  async saveAutomationIdleSnapshot(snapshot: AutomationIdleSnapshot, actorId: string): Promise<void> {
    await this.settings.set(
      AUTOMATION_IDLE_SNAPSHOT_KEY,
      snapshot as unknown as Prisma.InputJsonObject,
      actorId,
    )
  }

  async clearAutomationIdleSnapshot(actorId: string): Promise<void> {
    await this.settings.set(AUTOMATION_IDLE_SNAPSHOT_KEY, Prisma.JsonNull, actorId)
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

  async getTenantWebSearchControls(tenantId: string): Promise<WebSearchTenantControls> {
    const raw = (await this.settings.get(WEB_SEARCH_TENANT_CONTROLS_KEY)) as WebSearchTenantControlsStore | null
    const bucket = raw?.[tenantId]
    if (!bucket || typeof bucket !== 'object') {
      return { killSwitch: false, updatedById: null, updatedAt: null }
    }
    return {
      killSwitch: bucket.killSwitch === true,
      updatedById: typeof bucket.updatedById === 'string' ? bucket.updatedById : null,
      updatedAt: typeof bucket.updatedAt === 'string' ? bucket.updatedAt : null,
    }
  }

  /** Scope szerinti kill-switch: system agent → platform, tenant agent → tenant. */
  async isWebSearchEnabledForTenant(tenantId: string | null): Promise<boolean> {
    const platformKillSwitch = tenantId ? false : !(await this.isWebSearchEnabled())
    const tenantKillSwitch = tenantId
      ? (await this.getTenantWebSearchControls(tenantId)).killSwitch
      : undefined
    return isWebSearchScopeEnabled({ tenantId, platformKillSwitch, tenantKillSwitch })
  }

  async setTenantWebSearchControls(
    tenantId: string,
    input: { killSwitch: boolean },
    actorId: string,
  ): Promise<WebSearchTenantControls> {
    const raw = (await this.settings.get(WEB_SEARCH_TENANT_CONTROLS_KEY)) as WebSearchTenantControlsStore | null
    const store: WebSearchTenantControlsStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const current = await this.getTenantWebSearchControls(tenantId)
    const next: WebSearchTenantControls = {
      killSwitch: input.killSwitch,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    store[tenantId] = next
    await this.settings.set(WEB_SEARCH_TENANT_CONTROLS_KEY, store as unknown as Prisma.InputJsonObject, actorId)

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action:
        current.killSwitch !== next.killSwitch
          ? next.killSwitch
            ? 'web_search.tenant.paused'
            : 'web_search.tenant.resumed'
          : 'web_search.tenant.config_changed',
      targetType: 'platform_setting',
      targetId: tenantId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: next.killSwitch ? 'paused' : 'enabled',
      metadata: { tenantId, killSwitch: next.killSwitch },
      tenantId,
    })

    return next
  }

  // ── Chat thinking-trace (§D7/WP-6) ─────────────────────────────────────────

  async getTenantThinkingTraceControls(tenantId: string): Promise<ChatThinkingTraceControls> {
    const raw = (await this.settings.get(CHAT_THINKING_TRACE_TENANT_KEY)) as ChatThinkingTraceStore | null
    const bucket = raw?.[tenantId]
    if (!bucket || typeof bucket !== 'object') {
      return { enabled: false, updatedById: null, updatedAt: null }
    }
    return {
      enabled: bucket.enabled === true,
      updatedById: typeof bucket.updatedById === 'string' ? bucket.updatedById : null,
      updatedAt: typeof bucket.updatedAt === 'string' ? bucket.updatedAt : null,
    }
  }

  /**
   * Fail-closed: alapból KIKAPCSOLVA. A tenant nélküli (system) agenteknél is
   * kikapcsolt — a reasoning-megjelenítés kifejezetten tenant-admin opt-in.
   */
  async isChatThinkingTraceEnabledForTenant(tenantId: string | null): Promise<boolean> {
    if (!tenantId) return false
    return (await this.getTenantThinkingTraceControls(tenantId)).enabled
  }

  async setTenantThinkingTraceControls(
    tenantId: string,
    input: { enabled: boolean },
    actorId: string,
  ): Promise<ChatThinkingTraceControls> {
    const raw = (await this.settings.get(CHAT_THINKING_TRACE_TENANT_KEY)) as ChatThinkingTraceStore | null
    const store: ChatThinkingTraceStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const current = await this.getTenantThinkingTraceControls(tenantId)
    const next: ChatThinkingTraceControls = {
      enabled: input.enabled,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    store[tenantId] = next
    await this.settings.set(CHAT_THINKING_TRACE_TENANT_KEY, store as unknown as Prisma.InputJsonObject, actorId)

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action:
        current.enabled !== next.enabled
          ? next.enabled
            ? 'chat.thinking_trace.enabled'
            : 'chat.thinking_trace.disabled'
          : 'chat.thinking_trace.config_changed',
      targetType: 'platform_setting',
      targetId: tenantId,
      modelUsed: null,
      inputRef: null,
      outputRef: null,
      policyDecision: next.enabled ? 'enabled' : 'disabled',
      metadata: { tenantId, enabled: next.enabled },
      tenantId,
    })

    return next
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

  /**
   * Hibapolicy spec §4.2/WP-4 — a tenant alapértelmezett hibaág-policyja. `null`, ha nincs
   * tenant (`tenantId === null`, pl. platform-szintű Playbook) vagy a tenant nem állított be
   * semmit. Olcsó, nem auditál (a publish-útvonal olvassa).
   */
  async getTenantDefaultErrorPolicy(tenantId: string | null): Promise<ErrorPolicy | null> {
    if (!tenantId) return null
    const raw = (await this.settings.get(PLAYBOOK_TENANT_DEFAULT_ERROR_POLICY_KEY)) as Record<
      string,
      unknown
    > | null
    if (!raw || typeof raw !== 'object') return null
    const parsed = errorPolicySchema.safeParse(raw[tenantId])
    return parsed.success ? parsed.data : null
  }

  /**
   * A tenant alapértelmezett hibaág-policyjának auditált admin-beállítása (§4.2). A cél
   * (step/gate) létezését ITT nem ellenőrizzük — az Playbook-specifikus (egy tenant több
   * Playbookot futtathat), ezt a `PlaybookValidator` jelzi publish-időben, ha a policy egy
   * adott Playbookra nem illeszkedik (`TENANT_DEFAULT_ERROR_TARGET_MISSING`).
   */
  async setTenantDefaultErrorPolicy(
    tenantId: string,
    policy: ErrorPolicy,
    actorId: string,
  ): Promise<ErrorPolicy> {
    const validated = errorPolicySchema.parse(policy)
    const raw = (await this.settings.get(PLAYBOOK_TENANT_DEFAULT_ERROR_POLICY_KEY)) as Record<
      string,
      unknown
    > | null
    const store: Record<string, unknown> = raw && typeof raw === 'object' ? { ...raw } : {}
    store[tenantId] = validated
    await this.settings.set(
      PLAYBOOK_TENANT_DEFAULT_ERROR_POLICY_KEY,
      store as Prisma.InputJsonObject,
      actorId,
    )

    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'playbook.tenant_default_error_policy.set',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: tenantId,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { tenantId, policy: validated },
    })

    return validated
  }

  // ── Model Gateway: tartalék-lánc + tarifa (#34) ───────────────────────────

  async getFallbackChain(): Promise<import('@/domain/gateway/fallback-chain').FallbackCandidate[]> {
    const {
      parseFallbackChainSetting,
      FALLBACK_CHAIN_SETTING_KEY,
    } = await import('@/domain/gateway/fallback-chain')
    return parseFallbackChainSetting(await this.settings.get(FALLBACK_CHAIN_SETTING_KEY))
  }

  async setFallbackChain(
    chain: Array<{ provider: string; model: string }>,
    actorId: string,
    knownProviders: ReadonlySet<string>,
  ): Promise<import('@/domain/gateway/fallback-chain').FallbackCandidate[]> {
    const {
      fallbackCandidateSchema,
      FALLBACK_CHAIN_SETTING_KEY,
    } = await import('@/domain/gateway/fallback-chain')
    const { z } = await import('zod')
    const parsed = z.array(fallbackCandidateSchema).parse(chain)
    for (const c of parsed) {
      if (!knownProviders.has(c.provider)) {
        throw new Error(`Ismeretlen szolgáltató a tartalék-láncban: ${c.provider}`)
      }
    }
    await this.settings.set(FALLBACK_CHAIN_SETTING_KEY, parsed, actorId)
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'model.fallback_chain.set',
      targetType: 'platform_setting',
      targetId: FALLBACK_CHAIN_SETTING_KEY,
      modelUsed: null,
      inputRef: null,
      outputRef: `len:${parsed.length}`,
      policyDecision: 'allowed',
      metadata: { chain: parsed },
    })
    return parsed
  }

  async getModelPricingView(): Promise<{
    effective: import('@/lib/model-pricing').ModelPricingTable
    manual: import('@/lib/model-pricing').ModelPricingTable
    synced: import('@/lib/model-pricing').ModelPricingTable
    syncMeta: import('@/lib/model-pricing').ModelPricingSyncMeta | null
    rows: Array<{
      model: string
      price: import('@/lib/model-pricing').ModelPrice
      source: import('@/lib/model-pricing').PricingLayerSource
    }>
  }> {
    const {
      DEFAULT_MODEL_PRICING,
      MODEL_PRICING_SETTING_KEY,
      MODEL_PRICING_SYNCED_SETTING_KEY,
      MODEL_PRICING_SYNC_META_KEY,
      mergePricingLayers,
      parsePricingTableOrNull,
      parseModelPricingSyncMeta,
      pricingLayerForKey,
    } = await import('@/lib/model-pricing')

    const [manualRaw, syncedRaw, metaRaw] = await Promise.all([
      this.settings.get(MODEL_PRICING_SETTING_KEY),
      this.settings.get(MODEL_PRICING_SYNCED_SETTING_KEY),
      this.settings.get(MODEL_PRICING_SYNC_META_KEY),
    ])
    const manual = parsePricingTableOrNull(manualRaw) ?? {}
    const synced = parsePricingTableOrNull(syncedRaw) ?? {}
    const effective = mergePricingLayers({
      builtin: DEFAULT_MODEL_PRICING,
      synced,
      manual,
    })
    const layers = { builtin: DEFAULT_MODEL_PRICING, synced, manual }
    const rows = Object.keys(effective)
      .sort()
      .map((model) => ({
        model,
        price: effective[model]!,
        source: pricingLayerForKey(model, layers),
      }))

    return {
      effective,
      manual,
      synced,
      syncMeta: parseModelPricingSyncMeta(metaRaw),
      rows,
    }
  }

  async setManualModelPrice(
    model: string,
    price: { inputPerMTokens: number; outputPerMTokens: number },
    actorId: string,
  ): Promise<void> {
    const {
      MODEL_PRICING_SETTING_KEY,
      modelPriceSchema,
      parsePricingTableOrNull,
    } = await import('@/lib/model-pricing')
    const parsedPrice = modelPriceSchema.parse(price)
    const current = parsePricingTableOrNull(await this.settings.get(MODEL_PRICING_SETTING_KEY)) ?? {}
    const next = { ...current, [model]: parsedPrice }
    await this.settings.set(MODEL_PRICING_SETTING_KEY, next, actorId)
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'model.pricing.manual_set',
      targetType: 'platform_setting',
      targetId: MODEL_PRICING_SETTING_KEY,
      modelUsed: model,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { model, price: parsedPrice },
    })
  }

  async clearManualModelPrice(model: string, actorId: string): Promise<void> {
    const {
      MODEL_PRICING_SETTING_KEY,
      parsePricingTableOrNull,
    } = await import('@/lib/model-pricing')
    const current = parsePricingTableOrNull(await this.settings.get(MODEL_PRICING_SETTING_KEY)) ?? {}
    if (!Object.prototype.hasOwnProperty.call(current, model)) return
    const next = { ...current }
    delete next[model]
    await this.settings.set(MODEL_PRICING_SETTING_KEY, next, actorId)
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'model.pricing.manual_clear',
      targetType: 'platform_setting',
      targetId: MODEL_PRICING_SETTING_KEY,
      modelUsed: model,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { model },
    })
  }
}
