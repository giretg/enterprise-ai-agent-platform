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
import {
  CHANNEL_AUDIT_ACTIONS,
  CHANNEL_TENANT_CONTROLS_KEY,
  type ChannelTenantControls,
} from '@/domain/channel/channel-types'
import { matchForbiddenHost } from '@/domain/net/egress-guard'
import { errorPolicySchema, type ErrorPolicy } from '@/lib/playbook-v2/spec'
import {
  GOOGLE_OAUTH_PLATFORM_KEY,
  GOOGLE_OAUTH_SERVICE_KEYS,
  loadGoogleOAuthConfig,
  loadGoogleDrivePickerConfig,
  type GoogleDrivePickerConfig,
  type GoogleOAuthConfig,
  type GoogleOAuthResolved,
} from '@/lib/platform-google-oauth-config'
import {
  DEFAULT_PRIVACY_GATEWAY_MODE,
  parsePrivacyGatewayMode,
  PRIVACY_GATEWAY_AGENT_CONTROLS_KEY,
  PRIVACY_GATEWAY_CONTROLS_KEY,
  PRIVACY_GATEWAY_TENANT_CONTROLS_KEY,
  resolvePrivacyGatewayMode,
  type PrivacyGatewayMode,
} from '@/domain/privacy/privacy-mode'
import { PRIVACY_CATEGORY_POLICY_SET_ACTION, PRIVACY_GATEWAY_MODE_SET_ACTION } from '@/domain/privacy/privacy-audit'
import {
  DEFAULT_SENSITIVITY_LAYER_MODE,
  parseSensitivityLayerMode,
  SENSITIVITY_LAYER_AGENT_CONTROLS_KEY,
  SENSITIVITY_LAYER_CONTROLS_KEY,
  SENSITIVITY_LAYER_MODE_SET_ACTION,
  SENSITIVITY_LAYER_TENANT_CONTROLS_KEY,
  resolveSensitivityLayerMode,
  type SensitivityLayerMode,
} from '@/domain/gateway/sensitivity-mode'
import {
  actionForPrivacyCategory,
  applyCategoryMapPatch,
  applyCustomCategoryMapPatch,
  assertPrivacyCategoryPolicyPatch,
  defaultPrivacyCategoryPolicyDocument,
  emptyPrivacyCategoryPolicyLayer,
  INITIAL_PRIVACY_PATTERN_SET_VERSION,
  layerHasOverlay,
  parsePrivacyCategoryPolicyDocument,
  parsePrivacyCategoryPolicyLayer,
  PRIVACY_CATEGORY_POLICY_AGENT_KEY,
  PRIVACY_CATEGORY_POLICY_KEY,
  PRIVACY_CATEGORY_POLICY_TENANT_KEY,
  resolvePrivacyCategoryPolicy,
  type PrivacyCategoryAction,
  type PrivacyCategoryPolicyActor,
  type PrivacyCategoryPolicyDocument,
  type PrivacyCategoryPolicyLayer,
  type PrivacyCategoryPolicyPatch,
  type ResolvedPrivacyCategoryPolicy,
} from '@/domain/privacy/privacy-category-policy'
import {
  parsePrivacyEgressMatrixLayer,
  PRIVACY_EGRESS_MATRIX_TENANT_KEY,
  resolvePrivacyEgressMatrix,
  type PrivacyEgressMatrixLayer,
  type ResolvedPrivacyEgressMatrix,
} from '@/domain/privacy/privacy-egress-matrix'
import {
  clampTicketCallCapLimit,
  DEFAULT_MAX_CALLS_PER_TICKET,
  GATEWAY_TICKET_CALL_CAP_KEY,
  parseGatewayTicketCallCapStored,
  resolveMaxCallsPerTicket,
  type GatewayTicketCallCapStored,
} from '@/lib/gateway-ticket-call-cap'
export const DISPATCHER_CONTROLS_KEY = 'dispatcher.controls'
export const DISPATCHER_LAST_CYCLE_KEY = 'dispatcher.last_cycle'
export const TICKET_TYPE_CONFIGS_KEY = 'ticket.type_configs'
export const MONITOR_CONTROLS_KEY = 'monitor.controls'
export const AUTOMATION_IDLE_SNAPSHOT_KEY = 'automation.idle_snapshot'

export type GatewayTicketCallCapView = {
  /** Érvényes plafon (platform → env → alapértelmezés). */
  maxCallsPerTicket: number
  /** Van-e platform_settings-ben mentett érték (nem csak env/alap). */
  configuredInPlatform: boolean
  platformValue: number | null
  envFallback: number
  defaultLimit: number
  updatedById: string | null
  updatedAt: string | null
}

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
  /** Watchdog: elavult heartbeatű chat-fordulók (issue #64). Hiányzó régi lenyomat → 0. */
  reclaimedAgentTurns: number
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

/** Tenantonként tárolt Telegram-csatorna kapcsoló (`CHANNEL_TENANT_CONTROLS_KEY`, D54/#75). */
type ChannelTenantControlsStore = Record<string, Partial<ChannelTenantControls>>

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

export type PrivacyGatewayControls = {
  mode: PrivacyGatewayMode
  updatedById: string | null
  updatedAt: string | null
}

/** Tenant/agent override: `mode: null` = öröklés a szülő szintről. */
export type PrivacyGatewayLayerControls = {
  mode: PrivacyGatewayMode | null
  updatedById: string | null
  updatedAt: string | null
}

type PrivacyGatewayLayerStore = Record<string, Partial<PrivacyGatewayLayerControls>>

const DEFAULT_PRIVACY_GATEWAY_CONTROLS: PrivacyGatewayControls = {
  mode: DEFAULT_PRIVACY_GATEWAY_MODE,
  updatedById: null,
  updatedAt: null,
}

export type SensitivityLayerControls = {
  mode: SensitivityLayerMode
  updatedById: string | null
  updatedAt: string | null
}

export type SensitivityLayerOverride = {
  mode: SensitivityLayerMode | null
  updatedById: string | null
  updatedAt: string | null
}

type SensitivityLayerStore = Record<string, Partial<SensitivityLayerOverride>>

const DEFAULT_SENSITIVITY_LAYER_CONTROLS: SensitivityLayerControls = {
  mode: DEFAULT_SENSITIVITY_LAYER_MODE,
  updatedById: null,
  updatedAt: null,
}

type PrivacyCategoryPolicyLayerStore = Record<string, PrivacyCategoryPolicyLayer>

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

  async getGatewayTicketCallCapStored(): Promise<GatewayTicketCallCapStored | null> {
    const raw = await this.settings.get(GATEWAY_TICKET_CALL_CAP_KEY)
    return parseGatewayTicketCallCapStored(raw)
  }

  async getGatewayTicketCallCapView(): Promise<GatewayTicketCallCapView> {
    const stored = await this.getGatewayTicketCallCapStored()
    const envFallback = resolveMaxCallsPerTicket({ platformMax: null })
    const maxCallsPerTicket = resolveMaxCallsPerTicket({
      platformMax: stored?.maxCallsPerTicket ?? null,
    })
    return {
      maxCallsPerTicket,
      configuredInPlatform: stored != null,
      platformValue: stored?.maxCallsPerTicket ?? null,
      envFallback,
      defaultLimit: DEFAULT_MAX_CALLS_PER_TICKET,
      updatedById: stored?.updatedById ?? null,
      updatedAt: stored?.updatedAt ?? null,
    }
  }

  async resolveGatewayTicketCallCapLimit(): Promise<number> {
    const stored = await this.getGatewayTicketCallCapStored()
    return resolveMaxCallsPerTicket({ platformMax: stored?.maxCallsPerTicket ?? null })
  }

  async setGatewayTicketCallCap(maxCallsPerTicket: number, actorId: string): Promise<GatewayTicketCallCapView> {
    const nextValue = clampTicketCallCapLimit(maxCallsPerTicket)
    const payload: GatewayTicketCallCapStored = {
      maxCallsPerTicket: nextValue,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    await this.settings.set(GATEWAY_TICKET_CALL_CAP_KEY, payload as unknown as Prisma.InputJsonObject, actorId)
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'gateway.ticket_call_cap.set',
      targetType: 'platform_settings',
      targetId: null,
      modelUsed: null,
      inputRef: String(nextValue),
      outputRef: GATEWAY_TICKET_CALL_CAP_KEY,
      policyDecision: 'allowed',
      metadata: { maxCallsPerTicket: nextValue },
    })
    return this.getGatewayTicketCallCapView()
  }

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
      reclaimedAgentTurns:
        typeof raw.reclaimedAgentTurns === 'number' ? raw.reclaimedAgentTurns : 0,
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

  // ── Telegram-csatorna szervezeti kill-switch (D54, #75) ────────────────────

  /**
   * Egy szervezet Telegram-csatorna kapcsolójának állapota. Alapból BE (killSwitch=false) —
   * a csatorna a metszet és az admin-engedélyek mentén szűkít, a kill-switch az azonnali
   * elzárás incidens esetén.
   */
  async getTenantChannelControls(tenantId: string): Promise<ChannelTenantControls> {
    const raw = (await this.settings.get(CHANNEL_TENANT_CONTROLS_KEY)) as ChannelTenantControlsStore | null
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

  /**
   * Fail-closed csatorna-kapu: a csatorna CSAK akkor él egy fordulóhoz, ha van szervezet ÉS a
   * szervezeti kapcsoló nincs elzárva. Szervezet nélküli (rögzítetlen) identitásnál a csatorna
   * zárva — a teljes kormányzási modell szervezeti identitásra épül (D2). Olcsó, nem auditál.
   */
  async isChannelEnabledForTenant(tenantId: string | null): Promise<boolean> {
    if (!tenantId) return false
    return !(await this.getTenantChannelControls(tenantId)).killSwitch
  }

  async setTenantChannelControls(
    tenantId: string,
    input: { killSwitch: boolean },
    actorId: string,
  ): Promise<ChannelTenantControls> {
    const raw = (await this.settings.get(CHANNEL_TENANT_CONTROLS_KEY)) as ChannelTenantControlsStore | null
    const store: ChannelTenantControlsStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const current = await this.getTenantChannelControls(tenantId)
    const next: ChannelTenantControls = {
      killSwitch: input.killSwitch,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    store[tenantId] = next
    await this.settings.set(CHANNEL_TENANT_CONTROLS_KEY, store as unknown as Prisma.InputJsonObject, actorId)

    // Csak a tényleges váltást auditáljuk „elzárás"/„bekapcsolás" néven; a nem-változó mentés
    // (idempotens) nem kap külön eseményt.
    if (current.killSwitch !== next.killSwitch) {
      await this.audit.append({
        actorType: 'human',
        actorId,
        agentVersion: null,
        action: next.killSwitch ? CHANNEL_AUDIT_ACTIONS.tenantDisabled : CHANNEL_AUDIT_ACTIONS.tenantEnabled,
        targetType: 'platform_setting',
        targetId: tenantId,
        modelUsed: null,
        inputRef: null,
        outputRef: null,
        policyDecision: next.killSwitch ? 'disabled' : 'enabled',
        metadata: { tenantId, killSwitch: next.killSwitch },
        tenantId,
      })
    }

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

  // ── AI Privacy Gateway üzemmód (APG-09, spec §13) ──────────────────────────

  async getPrivacyGatewayControls(): Promise<PrivacyGatewayControls> {
    const raw = (await this.settings.get(PRIVACY_GATEWAY_CONTROLS_KEY)) as Partial<PrivacyGatewayControls> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PRIVACY_GATEWAY_CONTROLS }
    return {
      mode: parsePrivacyGatewayMode(raw.mode) ?? DEFAULT_PRIVACY_GATEWAY_MODE,
      updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  async setPrivacyGatewayControls(
    input: { mode: PrivacyGatewayMode },
    actorId: string,
  ): Promise<PrivacyGatewayControls> {
    const next: PrivacyGatewayControls = {
      mode: input.mode,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    await this.settings.set(PRIVACY_GATEWAY_CONTROLS_KEY, next as unknown as Prisma.InputJsonObject, actorId)
    await this.recordPrivacyGatewayModeSet('platform', null, next.mode, actorId)
    return next
  }

  async getTenantPrivacyGatewayControls(tenantId: string): Promise<PrivacyGatewayLayerControls> {
    return this.readPrivacyLayer(PRIVACY_GATEWAY_TENANT_CONTROLS_KEY, tenantId)
  }

  async setTenantPrivacyGatewayControls(
    tenantId: string,
    input: { mode: PrivacyGatewayMode | null },
    actorId: string,
  ): Promise<PrivacyGatewayLayerControls> {
    const next = await this.writePrivacyLayer(PRIVACY_GATEWAY_TENANT_CONTROLS_KEY, tenantId, input.mode, actorId)
    await this.recordPrivacyGatewayModeSet('tenant', tenantId, next.mode, actorId)
    return next
  }

  async getAgentPrivacyGatewayControls(agentId: string): Promise<PrivacyGatewayLayerControls> {
    return this.readPrivacyLayer(PRIVACY_GATEWAY_AGENT_CONTROLS_KEY, agentId)
  }

  async setAgentPrivacyGatewayControls(
    agentId: string,
    input: { mode: PrivacyGatewayMode | null },
    actorId: string,
  ): Promise<PrivacyGatewayLayerControls> {
    const next = await this.writePrivacyLayer(PRIVACY_GATEWAY_AGENT_CONTROLS_KEY, agentId, input.mode, actorId)
    await this.recordPrivacyGatewayModeSet('agent', agentId, next.mode, actorId)
    return next
  }

  async resolvePrivacyGatewayMode(input: {
    tenantId: string | null
    agentId?: string | null
  }): Promise<PrivacyGatewayMode> {
    const tenant = input.tenantId
      ? (await this.getTenantPrivacyGatewayControls(input.tenantId)).mode
      : null
    const agent = input.agentId
      ? (await this.getAgentPrivacyGatewayControls(input.agentId)).mode
      : null
    return resolvePrivacyGatewayMode({ tenant, agent })
  }

  // ── Sensitivity-router réteg (TAJ / adószám / kártya) — külön a tokenizálástól ──

  async getSensitivityLayerControls(): Promise<SensitivityLayerControls> {
    const raw = (await this.settings.get(SENSITIVITY_LAYER_CONTROLS_KEY)) as Partial<SensitivityLayerControls> | null
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SENSITIVITY_LAYER_CONTROLS }
    return {
      mode: parseSensitivityLayerMode(raw.mode) ?? DEFAULT_SENSITIVITY_LAYER_MODE,
      updatedById: typeof raw.updatedById === 'string' ? raw.updatedById : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    }
  }

  async setSensitivityLayerControls(
    input: { mode: SensitivityLayerMode },
    actorId: string,
  ): Promise<SensitivityLayerControls> {
    const next: SensitivityLayerControls = {
      mode: input.mode,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    await this.settings.set(SENSITIVITY_LAYER_CONTROLS_KEY, next as unknown as Prisma.InputJsonObject, actorId)
    await this.recordSensitivityLayerModeSet('platform', null, next.mode, actorId)
    return next
  }

  async getTenantSensitivityLayerControls(tenantId: string): Promise<SensitivityLayerOverride> {
    return this.readSensitivityLayer(SENSITIVITY_LAYER_TENANT_CONTROLS_KEY, tenantId)
  }

  async setTenantSensitivityLayerControls(
    tenantId: string,
    input: { mode: SensitivityLayerMode | null },
    actorId: string,
  ): Promise<SensitivityLayerOverride> {
    const next = await this.writeSensitivityLayer(
      SENSITIVITY_LAYER_TENANT_CONTROLS_KEY,
      tenantId,
      input.mode,
      actorId,
    )
    await this.recordSensitivityLayerModeSet('tenant', tenantId, next.mode, actorId)
    return next
  }

  async getAgentSensitivityLayerControls(agentId: string): Promise<SensitivityLayerOverride> {
    return this.readSensitivityLayer(SENSITIVITY_LAYER_AGENT_CONTROLS_KEY, agentId)
  }

  async setAgentSensitivityLayerControls(
    agentId: string,
    input: { mode: SensitivityLayerMode | null },
    actorId: string,
  ): Promise<SensitivityLayerOverride> {
    const next = await this.writeSensitivityLayer(
      SENSITIVITY_LAYER_AGENT_CONTROLS_KEY,
      agentId,
      input.mode,
      actorId,
    )
    await this.recordSensitivityLayerModeSet('agent', agentId, next.mode, actorId)
    return next
  }

  async resolveSensitivityLayerMode(input: {
    tenantId: string | null
    agentId?: string | null
  }): Promise<SensitivityLayerMode> {
    const tenant = input.tenantId
      ? (await this.getTenantSensitivityLayerControls(input.tenantId)).mode
      : null
    const agent = input.agentId
      ? (await this.getAgentSensitivityLayerControls(input.agentId)).mode
      : null
    return resolveSensitivityLayerMode({ tenant, agent })
  }

  // ── AI Privacy Gateway kategória-policy (APG-11, spec §2) ─────────────────

  async getPrivacyCategoryPolicy(): Promise<PrivacyCategoryPolicyDocument> {
    const raw = await this.settings.get(PRIVACY_CATEGORY_POLICY_KEY)
    if (!raw || typeof raw !== 'object') return defaultPrivacyCategoryPolicyDocument()
    return parsePrivacyCategoryPolicyDocument(raw)
  }

  async setPrivacyCategoryPolicy(
    patch: PrivacyCategoryPolicyPatch,
    actor: PrivacyCategoryPolicyActor,
  ): Promise<PrivacyCategoryPolicyDocument> {
    assertPrivacyCategoryPolicyPatch(patch, actor)
    const current = await this.getPrivacyCategoryPolicy()
    const next = this.mergeCategoryPolicyDocument(current, patch, actor.actorId)
    await this.settings.set(PRIVACY_CATEGORY_POLICY_KEY, next as unknown as Prisma.InputJsonObject, actor.actorId)
    await this.recordPrivacyCategoryPolicySet('platform', null, next, patch, actor.actorId)
    return next
  }

  async getTenantPrivacyCategoryPolicy(tenantId: string): Promise<PrivacyCategoryPolicyLayer> {
    return this.readCategoryPolicyLayer(PRIVACY_CATEGORY_POLICY_TENANT_KEY, tenantId)
  }

  async setTenantPrivacyCategoryPolicy(
    tenantId: string,
    patch: PrivacyCategoryPolicyPatch,
    actor: PrivacyCategoryPolicyActor,
  ): Promise<PrivacyCategoryPolicyLayer> {
    assertPrivacyCategoryPolicyPatch(patch, actor)
    const next = await this.writeCategoryPolicyLayer(
      PRIVACY_CATEGORY_POLICY_TENANT_KEY,
      tenantId,
      patch,
      actor.actorId,
    )
    await this.recordPrivacyCategoryPolicySet('tenant', tenantId, next, patch, actor.actorId)
    return next
  }

  async getAgentPrivacyCategoryPolicy(agentId: string): Promise<PrivacyCategoryPolicyLayer> {
    return this.readCategoryPolicyLayer(PRIVACY_CATEGORY_POLICY_AGENT_KEY, agentId)
  }

  async setAgentPrivacyCategoryPolicy(
    agentId: string,
    patch: PrivacyCategoryPolicyPatch,
    actor: PrivacyCategoryPolicyActor,
  ): Promise<PrivacyCategoryPolicyLayer> {
    assertPrivacyCategoryPolicyPatch(patch, actor)
    const next = await this.writeCategoryPolicyLayer(
      PRIVACY_CATEGORY_POLICY_AGENT_KEY,
      agentId,
      patch,
      actor.actorId,
    )
    await this.recordPrivacyCategoryPolicySet('agent', agentId, next, patch, actor.actorId)
    return next
  }

  async resolvePrivacyCategoryPolicy(input: {
    tenantId?: string | null
    agentId?: string | null
    legacyAllowSensitiveExternalModel?: boolean
  }): Promise<ResolvedPrivacyCategoryPolicy> {
    const platform = await this.getPrivacyCategoryPolicy()
    const tenant = input.tenantId ? await this.getTenantPrivacyCategoryPolicy(input.tenantId) : null
    const agent = input.agentId ? await this.getAgentPrivacyCategoryPolicy(input.agentId) : null
    return resolvePrivacyCategoryPolicy({
      platform,
      tenant,
      agent,
      legacyAllowSensitiveExternalModel: input.legacyAllowSensitiveExternalModel,
    })
  }

  async resolvePrivacyCategoryAction(input: {
    tenantId?: string | null
    agentId?: string | null
    category: string
    legacyAllowSensitiveExternalModel?: boolean
  }): Promise<PrivacyCategoryAction> {
    const resolved = await this.resolvePrivacyCategoryPolicy(input)
    return actionForPrivacyCategory(resolved, input.category)
  }

  // ── AI Privacy Gateway egress-mátrix (APG-19, spec §10.2) ───────────────────

  async getTenantPrivacyEgressMatrix(tenantId: string): Promise<PrivacyEgressMatrixLayer> {
    const raw = (await this.settings.get(PRIVACY_EGRESS_MATRIX_TENANT_KEY)) as Record<
      string,
      unknown
    > | null
    const bucket = raw?.[tenantId]
    return parsePrivacyEgressMatrixLayer(bucket)
  }

  async resolvePrivacyEgressMatrix(
    tenantId?: string | null,
  ): Promise<ResolvedPrivacyEgressMatrix> {
    const tenant = tenantId ? await this.getTenantPrivacyEgressMatrix(tenantId) : null
    return resolvePrivacyEgressMatrix({ tenant })
  }

  private mergeCategoryPolicyDocument(
    current: PrivacyCategoryPolicyDocument,
    patch: PrivacyCategoryPolicyPatch,
    actorId: string,
  ): PrivacyCategoryPolicyDocument {
    const categories = applyCategoryMapPatch(current.categories, patch.categories)
    const custom = applyCustomCategoryMapPatch(current.custom, patch.custom)
    const bumped =
      JSON.stringify(categories) !== JSON.stringify(current.categories) ||
      JSON.stringify(custom) !== JSON.stringify(current.custom)
    return {
      categories,
      custom,
      patternSetVersion: bumped
        ? Math.max(current.patternSetVersion, INITIAL_PRIVACY_PATTERN_SET_VERSION) + 1
        : current.patternSetVersion,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
  }

  private async readCategoryPolicyLayer(
    key: string,
    id: string,
  ): Promise<PrivacyCategoryPolicyLayer> {
    const raw = (await this.settings.get(key)) as PrivacyCategoryPolicyLayerStore | null
    const bucket = raw?.[id]
    if (!bucket || typeof bucket !== 'object') return emptyPrivacyCategoryPolicyLayer()
    return parsePrivacyCategoryPolicyLayer(bucket)
  }

  private async writeCategoryPolicyLayer(
    key: string,
    id: string,
    patch: PrivacyCategoryPolicyPatch,
    actorId: string,
  ): Promise<PrivacyCategoryPolicyLayer> {
    const raw = (await this.settings.get(key)) as PrivacyCategoryPolicyLayerStore | null
    const store: PrivacyCategoryPolicyLayerStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const current = parsePrivacyCategoryPolicyLayer(store[id])
    const categories = applyCategoryMapPatch(current.categories, patch.categories)
    const custom = applyCustomCategoryMapPatch(current.custom, patch.custom)
    const next: PrivacyCategoryPolicyLayer = {
      categories,
      custom,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    if (!layerHasOverlay(next)) delete store[id]
    else store[id] = next
    await this.settings.set(key, store as unknown as Prisma.InputJsonObject, actorId)
    return next
  }

  private async recordPrivacyCategoryPolicySet(
    layer: 'platform' | 'tenant' | 'agent',
    targetId: string | null,
    stored: PrivacyCategoryPolicyDocument | PrivacyCategoryPolicyLayer,
    patch: PrivacyCategoryPolicyPatch,
    actorId: string,
  ): Promise<void> {
    const patternSetVersion =
      'patternSetVersion' in stored ? stored.patternSetVersion : null
    // `categories`: csak a nevek — visszafelé-kompatibilis marad a régebbi
    // audit-fogyasztókkal (az `actions` az új, érték-hordozó mező; a nevek annak
    // kulcs-részhalmaza, ezért látszólag redundáns, de a séma-stabilitásért marad).
    const categories = [
      ...Object.keys(patch.categories ?? stored.categories),
      ...Object.keys(patch.custom ?? stored.custom),
    ]
    // A patch a tényleges változás — az auditba a MEGVÁLASZTOTT akció is bekerül,
    // nem csak az érintett kategória neve. `null` = az overlay törlése (öröklés).
    // A `rawEgressEnabled` külön kiemeli, mely kategóriákra kapcsoltak be NYERS
    // (`allow`) külső-modell-átadást — ez az a magas kockázatú lépés (pl. PAN/IBAN),
    // amelynél #320 D9 a visszatartó kontrollként épp az audit-eseményre támaszkodik.
    // Így a SIEM/megfelelőségi lekérdezés meg tudja különböztetni a szigorítást a
    // nyers adat kiengedésétől.
    const patchEntries: Array<[string, PrivacyCategoryAction | null]> = [
      ...Object.entries(patch.categories ?? {}),
      ...Object.entries(patch.custom ?? {}),
    ]
    const actions: Record<string, PrivacyCategoryAction | 'inherit'> = {}
    for (const [key, action] of patchEntries) {
      actions[key] = action ?? 'inherit'
    }
    const rawEgressEnabled = patchEntries
      .filter(([, action]) => action === 'allow')
      .map(([key]) => key)
      .sort()
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: PRIVACY_CATEGORY_POLICY_SET_ACTION,
      targetType: 'platform_setting',
      targetId,
      modelUsed: null,
      inputRef: layer,
      outputRef: patternSetVersion != null ? `v${patternSetVersion}` : layer,
      policyDecision: rawEgressEnabled.length > 0 ? 'category_policy_raw_egress' : 'category_policy',
      metadata: {
        layer,
        patternSetVersion,
        categories,
        actions,
        rawEgressEnabled,
      },
      tenantId: layer === 'tenant' ? targetId : null,
    })
  }

  private async readPrivacyLayer(
    key: string,
    id: string,
  ): Promise<PrivacyGatewayLayerControls> {
    const raw = (await this.settings.get(key)) as PrivacyGatewayLayerStore | null
    const bucket = raw?.[id]
    if (!bucket || typeof bucket !== 'object') {
      return { mode: null, updatedById: null, updatedAt: null }
    }
    return {
      mode: parsePrivacyGatewayMode(bucket.mode),
      updatedById: typeof bucket.updatedById === 'string' ? bucket.updatedById : null,
      updatedAt: typeof bucket.updatedAt === 'string' ? bucket.updatedAt : null,
    }
  }

  private async writePrivacyLayer(
    key: string,
    id: string,
    mode: PrivacyGatewayMode | null,
    actorId: string,
  ): Promise<PrivacyGatewayLayerControls> {
    const raw = (await this.settings.get(key)) as PrivacyGatewayLayerStore | null
    const store: PrivacyGatewayLayerStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const next: PrivacyGatewayLayerControls = {
      mode,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    if (mode == null) delete store[id]
    else store[id] = next
    await this.settings.set(key, store as unknown as Prisma.InputJsonObject, actorId)
    return next
  }

  private async recordPrivacyGatewayModeSet(
    layer: 'platform' | 'tenant' | 'agent',
    targetId: string | null,
    mode: PrivacyGatewayMode | null,
    actorId: string,
  ): Promise<void> {
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: PRIVACY_GATEWAY_MODE_SET_ACTION,
      targetType: 'platform_setting',
      targetId,
      modelUsed: null,
      inputRef: layer,
      outputRef: mode,
      policyDecision: mode ?? 'inherit',
      metadata: { layer, mode },
      tenantId: layer === 'tenant' ? targetId : null,
    })
  }

  private async readSensitivityLayer(key: string, id: string): Promise<SensitivityLayerOverride> {
    const raw = (await this.settings.get(key)) as SensitivityLayerStore | null
    const bucket = raw?.[id]
    if (!bucket || typeof bucket !== 'object') {
      return { mode: null, updatedById: null, updatedAt: null }
    }
    return {
      mode: parseSensitivityLayerMode(bucket.mode),
      updatedById: typeof bucket.updatedById === 'string' ? bucket.updatedById : null,
      updatedAt: typeof bucket.updatedAt === 'string' ? bucket.updatedAt : null,
    }
  }

  private async writeSensitivityLayer(
    key: string,
    id: string,
    mode: SensitivityLayerMode | null,
    actorId: string,
  ): Promise<SensitivityLayerOverride> {
    const raw = (await this.settings.get(key)) as SensitivityLayerStore | null
    const store: SensitivityLayerStore = raw && typeof raw === 'object' ? { ...raw } : {}
    const next: SensitivityLayerOverride = {
      mode,
      updatedById: actorId,
      updatedAt: new Date().toISOString(),
    }
    if (mode == null) delete store[id]
    else store[id] = next
    await this.settings.set(key, store as unknown as Prisma.InputJsonObject, actorId)
    return next
  }

  private async recordSensitivityLayerModeSet(
    layer: 'platform' | 'tenant' | 'agent',
    targetId: string | null,
    mode: SensitivityLayerMode | null,
    actorId: string,
  ): Promise<void> {
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: SENSITIVITY_LAYER_MODE_SET_ACTION,
      targetType: 'platform_setting',
      targetId,
      modelUsed: null,
      inputRef: layer,
      outputRef: mode,
      policyDecision: mode ?? 'inherit',
      metadata: { layer, mode },
      tenantId: layer === 'tenant' ? targetId : null,
    })
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

  /** #33 — platform-szintű olcsó strukturáló modell a contract-javításhoz. */
  async getStructuringModel(): Promise<
    import('@/domain/contract-runtime').StructuringModelSetting | null
  > {
    const {
      parseStructuringModelSetting,
      structuringModelFromEnv,
      STRUCTURING_MODEL_SETTING_KEY,
    } = await import('@/domain/contract-runtime')
    return (
      parseStructuringModelSetting(await this.settings.get(STRUCTURING_MODEL_SETTING_KEY)) ??
      structuringModelFromEnv()
    )
  }

  async setStructuringModel(
    model: { provider: string; model: string },
    actorId: string,
    knownProviders: ReadonlySet<string>,
  ): Promise<import('@/domain/contract-runtime').StructuringModelSetting> {
    const {
      structuringModelSchema,
      STRUCTURING_MODEL_SETTING_KEY,
    } = await import('@/domain/contract-runtime')
    const parsed = structuringModelSchema.parse(model)
    if (!knownProviders.has(parsed.provider)) {
      throw new Error(`Ismeretlen szolgáltató a strukturáló modellhez: ${parsed.provider}`)
    }
    await this.settings.set(STRUCTURING_MODEL_SETTING_KEY, parsed, actorId)
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'model.structuring.set',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: `${parsed.provider}/${parsed.model}`,
      policyDecision: 'allowed',
      metadata: { settingKey: STRUCTURING_MODEL_SETTING_KEY, structuringModel: parsed },
    })
    return parsed
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
      targetId: null,
      modelUsed: null,
      inputRef: null,
      outputRef: `len:${parsed.length}`,
      policyDecision: 'allowed',
      metadata: { settingKey: FALLBACK_CHAIN_SETTING_KEY, chain: parsed },
    })
    return parsed
  }

  async getModelPricingView(): Promise<{
    effective: import('@/lib/model-pricing').ModelPricingTable
    manual: import('@/lib/model-pricing').ModelPricingTable
    synced: import('@/lib/model-pricing').ModelPricingTable
    syncMeta: import('@/lib/model-pricing').ModelPricingSyncMeta | null
    rows: import('@/lib/model-pricing').ModelPricingViewRow[]
  }> {
    const {
      DEFAULT_MODEL_PRICING,
      MODEL_PRICING_SETTING_KEY,
      MODEL_PRICING_SYNCED_SETTING_KEY,
      MODEL_PRICING_SYNC_META_KEY,
      mergePricingLayers,
      parsePricingTableOrNull,
      parseModelPricingSyncMeta,
      buildModelPricingViewRows,
    } = await import('@/lib/model-pricing')

    const [manualRaw, syncedRaw, metaRaw, policy] = await Promise.all([
      this.settings.get(MODEL_PRICING_SETTING_KEY),
      this.settings.get(MODEL_PRICING_SYNCED_SETTING_KEY),
      this.settings.get(MODEL_PRICING_SYNC_META_KEY),
      this.getModelPolicy(),
    ])
    const manual = parsePricingTableOrNull(manualRaw) ?? {}
    const synced = parsePricingTableOrNull(syncedRaw) ?? {}
    const syncMeta = parseModelPricingSyncMeta(metaRaw)
    const effective = mergePricingLayers({
      builtin: DEFAULT_MODEL_PRICING,
      synced,
      manual,
    })
    const configuredModels = policy.entries
      .filter((entry) => entry.enabled)
      .map((entry) => entry.model)
    const rows = buildModelPricingViewRows({
      effective,
      layers: { builtin: DEFAULT_MODEL_PRICING, synced, manual },
      syncMeta,
      configuredModels,
    })

    return {
      effective,
      manual,
      synced,
      syncMeta,
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
    const parsedPrice = modelPriceSchema.parse({
      ...price,
      updatedAt: new Date().toISOString(),
    })
    const current = parsePricingTableOrNull(await this.settings.get(MODEL_PRICING_SETTING_KEY)) ?? {}
    const next = { ...current, [model]: parsedPrice }
    await this.settings.set(MODEL_PRICING_SETTING_KEY, next, actorId)
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'model.pricing.manual_set',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: model,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { settingKey: MODEL_PRICING_SETTING_KEY, model, price: parsedPrice },
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
      targetId: null,
      modelUsed: model,
      inputRef: null,
      outputRef: null,
      policyDecision: 'allowed',
      metadata: { settingKey: MODEL_PRICING_SETTING_KEY, model },
    })
  }

  /**
   * OpenRouter `/api/v1/models` → szinkronizált tarifa-réteg (írás).
   * A modell-id-k megmaradnak (pl. `deepseek/deepseek-v4-flash-0731`).
   */
  async syncModelPricingFromOpenRouter(actorId: string): Promise<{
    written: number
    changed: number
    fingerprint: string
    eurPerUsd: number
    rateAsOf: string
    sourceLabel: string
  }> {
    const {
      fetchOpenRouterPriceSnapshot,
      OPENROUTER_PRICE_SOURCE_LABEL,
      syncModelPricing,
    } = await import('@/domain/gateway/price-sync')

    let snapshot
    try {
      snapshot = await fetchOpenRouterPriceSnapshot()
    } catch (e) {
      throw new Error(e instanceof Error ? e.message : 'openrouter_fetch_failed')
    }

    const result = await syncModelPricing({
      snapshot,
      settings: this.settings,
      audit: this.audit,
      dryRun: false,
      keepSourceIds: true,
      sourceLabel: OPENROUTER_PRICE_SOURCE_LABEL,
      actorId,
    })

    if (!result.ok) {
      throw new Error(result.error ?? 'model_pricing_sync_failed')
    }

    return {
      written: result.written,
      changed: result.diffs.filter((d) => d.changed).length,
      fingerprint: result.fingerprint,
      eurPerUsd: result.eurPerUsd,
      rateAsOf: result.rateAsOf,
      sourceLabel: OPENROUTER_PRICE_SOURCE_LABEL,
    }
  }

  async getGoogleOAuthConfig(): Promise<GoogleOAuthResolved | null> {
    return loadGoogleOAuthConfig({
      service: 'gmail',
      getPlatformValue: () => this.settings.get(GOOGLE_OAUTH_SERVICE_KEYS.gmail),
      getLegacyPlatformValue: () => this.settings.get(GOOGLE_OAUTH_PLATFORM_KEY),
    })
  }

  async getGoogleDriveOAuthConfig(): Promise<GoogleOAuthResolved | null> {
    return loadGoogleOAuthConfig({
      service: 'drive',
      getPlatformValue: () => this.settings.get(GOOGLE_OAUTH_SERVICE_KEYS.drive),
    })
  }

  async getGoogleDrivePickerConfig(): Promise<{
    config: GoogleDrivePickerConfig
    source: GoogleOAuthResolved['source']
  } | null> {
    return loadGoogleDrivePickerConfig({
      getPlatformValue: () => this.settings.get('oauth.google.drive.picker'),
    })
  }

  async upsertGoogleDriveOAuthConfig(
    input: { clientId: string; clientSecret?: string; redirectUri?: string },
    actorId: string,
  ): Promise<GoogleOAuthResolved> {
    const existing = await this.getGoogleDriveOAuthConfig()
    const clientSecret = input.clientSecret?.trim() || existing?.config.clientSecret
    if (!clientSecret) {
      throw new Error('Client Secret szükséges az első beállításhoz.')
    }
    const redirectUri =
      input.redirectUri === undefined
        ? existing?.config.redirectUri
        : input.redirectUri.trim() || undefined
    const config: GoogleOAuthConfig = {
      clientId: input.clientId.trim(),
      clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    }
    await this.settings.set(
      GOOGLE_OAUTH_SERVICE_KEYS.drive,
      config as unknown as Prisma.InputJsonObject,
      actorId,
    )
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'platform.oauth.google_drive.update',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: 'google_drive',
      outputRef: config.clientId,
      policyDecision: existing?.source === 'platform' ? 'updated' : 'configured',
      metadata: {
        settingKey: GOOGLE_OAUTH_SERVICE_KEYS.drive,
        redirectUri: config.redirectUri ?? null,
        secretRotated: Boolean(input.clientSecret?.trim()),
        previousSource: existing?.source ?? null,
      },
    })
    return { config, source: 'platform' }
  }

  async upsertGoogleDrivePickerConfig(
    input: { apiKey: string; appId: string },
    actorId: string,
  ): Promise<{ config: GoogleDrivePickerConfig; source: GoogleOAuthResolved['source'] }> {
    const config: GoogleDrivePickerConfig = {
      apiKey: input.apiKey.trim(),
      appId: input.appId.trim(),
    }
    await this.settings.set(
      'oauth.google.drive.picker',
      config as unknown as Prisma.InputJsonObject,
      actorId,
    )
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'platform.oauth.google_drive_picker.update',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: 'google_drive_picker',
      outputRef: config.appId,
      policyDecision: 'configured',
      metadata: { settingKey: 'oauth.google.drive.picker', appId: config.appId },
    })
    return { config, source: 'platform' }
  }

  async upsertGoogleOAuthConfig(
    input: { clientId: string; clientSecret?: string; redirectUri?: string },
    actorId: string,
  ): Promise<GoogleOAuthResolved> {
    const existing = await this.getGoogleOAuthConfig()
    const clientSecret = input.clientSecret?.trim() || existing?.config.clientSecret
    if (!clientSecret) {
      throw new Error('Client Secret szükséges az első beállításhoz.')
    }
    const redirectUri =
      input.redirectUri === undefined
        ? existing?.config.redirectUri
        : input.redirectUri.trim() || undefined
    const config: GoogleOAuthConfig = {
      clientId: input.clientId.trim(),
      clientSecret,
      ...(redirectUri ? { redirectUri } : {}),
    }
    await this.settings.set(
      GOOGLE_OAUTH_PLATFORM_KEY,
      config as unknown as Prisma.InputJsonObject,
      actorId,
    )
    await this.audit.append({
      actorType: 'human',
      actorId,
      agentVersion: null,
      action: 'platform.oauth.google.update',
      targetType: 'platform_setting',
      targetId: null,
      modelUsed: null,
      inputRef: 'google',
      outputRef: config.clientId,
      policyDecision: existing?.source === 'platform' ? 'updated' : 'configured',
      metadata: {
        settingKey: GOOGLE_OAUTH_PLATFORM_KEY,
        redirectUri: config.redirectUri ?? null,
        secretRotated: Boolean(input.clientSecret?.trim()),
        previousSource: existing?.source ?? null,
      },
    })
    return { config, source: 'platform' }
  }
}
