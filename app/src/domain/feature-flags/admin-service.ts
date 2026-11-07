import type { PlatformRole } from '@prisma/client'
import type { AuditAppendInput } from '@/lib/audit/types'
import { hasMinimumPlatformRole } from '@/lib/tenant-policy'
import {
  applyFeatureFlagChange,
  decideFeatureFlag,
  diffFeatureFlagEffect,
  FEATURE_FLAG_STATE_OFF,
  type FeatureFlagDecision,
  type FeatureFlagModeValue,
  type FeatureFlagState,
  type FeatureFlagTenantAccessChange,
  type FeatureFlagTenantAccessValue,
} from './evaluate'
import type { FeatureFlagSnapshot } from './evaluator'
import type { FeatureFlagDefinition, FeatureFlagRegistry } from './registry'

const REMOVE_AFTER_FULL_ROLLOUT_MS = 60 * 24 * 60 * 60 * 1000
const MIN_JUSTIFICATION_LENGTH = 3
const MAX_JUSTIFICATION_LENGTH = 500

export const FEATURE_FLAG_AUDIT_ACTIONS = [
  'platform.feature_flag.mode_set',
  'platform.feature_flag.tenant_access_set',
  'platform.feature_flag.deadline_extended',
] as const
export const FEATURE_FLAG_AUDIT_TARGET = 'feature_flag'

export type FeatureFlagRow = {
  key: string
  mode: FeatureFlagModeValue
  version: number
  fullRolloutAt: Date | null
  removeBy: Date | null
  stoppedAt: Date | null
  updatedAt: Date
  tenants: ReadonlyArray<{ tenantId: string; access: FeatureFlagTenantAccessValue }>
}

export type FeatureFlagCommit = {
  key: string
  /** `0` = még nincs sora. */
  expectedVersion: number
  mode: FeatureFlagModeValue
  fullRolloutAt: Date | null
  removeBy: Date | null
  stoppedAt: Date | null
  actorId: string
  tenantAccess: readonly FeatureFlagTenantAccessChange[]
  audit: readonly AuditAppendInput[]
}

/** Az állapot és az audit közös tranzakcióban íródik; audit-hiba esetén ez a hiba jön, és nem íródik semmi. */
export class FeatureFlagAuditWriteError extends Error {
  constructor(cause: unknown) {
    super('Feature flag audit write failed', { cause })
    this.name = 'FeatureFlagAuditWriteError'
  }
}

export type FeatureFlagHistoryEntry = {
  id: string
  action: string
  actorId: string | null
  createdAt: Date
  metadata: unknown
}

export type FeatureFlagStore = {
  loadAll(): Promise<FeatureFlagRow[]>
  find(key: string): Promise<FeatureFlagRow | null>
  commit(input: FeatureFlagCommit): Promise<'committed' | 'conflict'>
  listHistory(key: string, limit: number): Promise<FeatureFlagHistoryEntry[]>
}

export type FeatureFlagTenantRef = { id: string; displayName: string }

export type FeatureFlagActor = { id: string; platformRoles: readonly PlatformRole[] }

export type FeatureFlagChangeInput = {
  key: string
  expectedVersion: number
  mode?: FeatureFlagModeValue
  tenantAccess?: readonly FeatureFlagTenantAccessChange[]
  actor: FeatureFlagActor
}

type RefusedOutcome = { status: 'unknown_flag' | 'forbidden' | 'conflict' | 'invalid_tenant' }

export type FeatureFlagPreview =
  | RefusedOutcome
  | { status: 'no_change' }
  | { status: 'ok'; gains: FeatureFlagTenantRef[]; loses: FeatureFlagTenantRef[] }

export type FeatureFlagApplyResult =
  | RefusedOutcome
  | { status: 'no_change' | 'invalid_justification' | 'audit_failed' }
  | { status: 'applied'; auditFailed: boolean; gains: FeatureFlagTenantRef[]; loses: FeatureFlagTenantRef[] }

export type FeatureFlagExtendResult =
  | { status: 'unknown_flag' | 'forbidden' | 'conflict' | 'invalid_justification' | 'invalid_date' | 'audit_failed' }
  | { status: 'extended' }

export type FeatureFlagDeadline = { kind: 'remove' | 'review'; date: Date; expired: boolean }

export type FeatureFlagListItem = {
  key: string
  definition: FeatureFlagDefinition
  mode: FeatureFlagModeValue
  includedCount: number
  excludedCount: number
  deadline: FeatureFlagDeadline
}

export type FeatureFlagDetail = FeatureFlagListItem & {
  version: number
  fullRolloutAt: Date | null
  removeBy: Date | null
  stoppedAt: Date | null
  tenants: Array<FeatureFlagTenantRef & { access: FeatureFlagTenantAccessValue | null; decision: FeatureFlagDecision }>
  history: FeatureFlagHistoryEntry[]
}

export type FeatureFlagTenantViewItem = {
  key: string
  definition: FeatureFlagDefinition
  decision: FeatureFlagDecision
}

function stateOf(row: FeatureFlagRow | null): FeatureFlagState {
  if (!row) return FEATURE_FLAG_STATE_OFF
  return { mode: row.mode, tenants: new Map(row.tenants.map((t) => [t.tenantId, t.access])) }
}

export function featureFlagSnapshotOf(rows: readonly FeatureFlagRow[]): FeatureFlagSnapshot {
  return new Map(rows.map((row) => [row.key, stateOf(row)]))
}

function normalizeJustification(raw: string): string | null {
  const value = raw.trim()
  return value.length >= MIN_JUSTIFICATION_LENGTH && value.length <= MAX_JUSTIFICATION_LENGTH ? value : null
}

/** Csak a tényleg módosuló sorok, hogy a napló és a mentés ne tartalmazzon üres változást. */
function effectiveTenantAccess(
  current: FeatureFlagState,
  changes: readonly FeatureFlagTenantAccessChange[],
): FeatureFlagTenantAccessChange[] {
  const byTenant = new Map(changes.map((c) => [c.tenantId, c.access]))
  return [...byTenant.entries()]
    .filter(([tenantId, access]) => (current.tenants.get(tenantId) ?? null) !== access)
    .map(([tenantId, access]) => ({ tenantId, access }))
}

export function canSetFeatureFlagChange(
  roles: readonly PlatformRole[],
  current: FeatureFlagModeValue,
  next: FeatureFlagModeValue,
): boolean {
  const required = next === 'all' && current !== 'all' ? 'superadmin' : 'platform_operator'
  return hasMinimumPlatformRole([...roles], required)
}

export class FeatureFlagAdminService {
  constructor(
    private readonly deps: {
      registry: FeatureFlagRegistry
      store: FeatureFlagStore
      /** Az archivált cégek nem számítanak: náluk nincs működés, ami változna. */
      listTenants: () => Promise<FeatureFlagTenantRef[]>
      /** A módosító példány azonnal üríti a saját cache-ét. */
      onChanged: () => void
      now?: () => Date
      logAuditFailure?: (key: string, error: unknown) => void
    },
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date()
  }

  private deadlineOf(definition: FeatureFlagDefinition, row: FeatureFlagRow | null): FeatureFlagDeadline {
    const date = row?.removeBy ?? new Date(`${definition.reviewBy}T23:59:59Z`)
    return { kind: row?.removeBy ? 'remove' : 'review', date, expired: date.getTime() < this.now().getTime() }
  }

  private listItem(key: string, definition: FeatureFlagDefinition, row: FeatureFlagRow | null): FeatureFlagListItem {
    const tenants = row?.tenants ?? []
    return {
      key,
      definition,
      mode: row?.mode ?? 'off',
      includedCount: tenants.filter((t) => t.access === 'included').length,
      excludedCount: tenants.filter((t) => t.access === 'excluded').length,
      deadline: this.deadlineOf(definition, row),
    }
  }

  /** Az oldal a kódbeli listából indul: a kódból törölt flag sora nem jelenik meg. */
  async list(): Promise<FeatureFlagListItem[]> {
    const rows = new Map((await this.deps.store.loadAll()).map((row) => [row.key, row]))
    return Object.entries(this.deps.registry).map(([key, definition]) =>
      this.listItem(key, definition, rows.get(key) ?? null),
    )
  }

  async detail(key: string, historyLimit = 50): Promise<FeatureFlagDetail | null> {
    const definition = this.definition(key)
    if (!definition) return null
    const [row, tenants, history] = await Promise.all([
      this.deps.store.find(key),
      this.deps.listTenants(),
      this.deps.store.listHistory(key, historyLimit),
    ])
    const state = stateOf(row)
    return {
      ...this.listItem(key, definition, row),
      version: row?.version ?? 0,
      fullRolloutAt: row?.fullRolloutAt ?? null,
      removeBy: row?.removeBy ?? null,
      stoppedAt: row?.stoppedAt ?? null,
      tenants: tenants.map((tenant) => ({
        ...tenant,
        access: state.tenants.get(tenant.id) ?? null,
        decision: decideFeatureFlag(state, tenant.id),
      })),
      history,
    }
  }

  /** Egy cégnél minden flag látszik az eredménnyel és az okkal. */
  async tenantView(tenantId: string): Promise<FeatureFlagTenantViewItem[]> {
    const rows = new Map((await this.deps.store.loadAll()).map((row) => [row.key, row]))
    return Object.entries(this.deps.registry).map(([key, definition]) => ({
      key,
      definition,
      decision: decideFeatureFlag(stateOf(rows.get(key) ?? null), tenantId),
    }))
  }

  tenants(): Promise<FeatureFlagTenantRef[]> {
    return this.deps.listTenants()
  }

  private definition(key: string): FeatureFlagDefinition | null {
    return Object.hasOwn(this.deps.registry, key) ? this.deps.registry[key] : null
  }

  /** Az összegzés és a mentés közös számítása; a `version` garantálja, hogy közben nem változott. */
  private async plan(input: FeatureFlagChangeInput) {
    const definition = this.definition(input.key)
    if (!definition) return { outcome: { status: 'unknown_flag' } as const }
    const [row, tenants] = await Promise.all([this.deps.store.find(input.key), this.deps.listTenants()])
    if ((row?.version ?? 0) !== input.expectedVersion) return { outcome: { status: 'conflict' } as const }
    const current = stateOf(row)
    const nextMode = input.mode ?? current.mode
    if (!canSetFeatureFlagChange(input.actor.platformRoles, current.mode, nextMode)) {
      return { outcome: { status: 'forbidden' } as const }
    }
    const tenantsById = new Map(tenants.map((t) => [t.id, t]))
    const tenantAccess = effectiveTenantAccess(current, input.tenantAccess ?? [])
    if (tenantAccess.some((c) => !tenantsById.has(c.tenantId))) return { outcome: { status: 'invalid_tenant' } as const }
    if (nextMode === current.mode && tenantAccess.length === 0) return { outcome: { status: 'no_change' } as const }
    const next = applyFeatureFlagChange(current, { mode: nextMode, tenantAccess })
    const effect = diffFeatureFlagEffect(current, next, [...tenantsById.keys()])
    const ref = (id: string) => tenantsById.get(id) as FeatureFlagTenantRef
    return {
      plan: {
        definition,
        row,
        current,
        next,
        tenantAccess,
        tenantsById,
        gains: effect.gains.map(ref),
        loses: effect.loses.map(ref),
      },
    }
  }

  async preview(input: FeatureFlagChangeInput): Promise<FeatureFlagPreview> {
    const { outcome, plan } = await this.plan(input)
    if (outcome) return outcome
    return { status: 'ok', gains: plan.gains, loses: plan.loses }
  }

  async apply(input: FeatureFlagChangeInput & { justification: string }): Promise<FeatureFlagApplyResult> {
    const justification = normalizeJustification(input.justification)
    const { outcome, plan } = await this.plan(input)
    if (outcome) return outcome
    if (!justification) return { status: 'invalid_justification' }

    const now = this.now()
    const { row, current, next } = plan
    const firstFullRollout = next.mode === 'all' && !row?.fullRolloutAt
    const stoppedAt = next.mode !== 'off' ? null : current.mode !== 'off' ? now : (row?.stoppedAt ?? null)
    const commit: FeatureFlagCommit = {
      key: input.key,
      expectedVersion: input.expectedVersion,
      mode: next.mode,
      fullRolloutAt: firstFullRollout ? now : (row?.fullRolloutAt ?? null),
      removeBy: firstFullRollout ? new Date(now.getTime() + REMOVE_AFTER_FULL_ROLLOUT_MS) : (row?.removeBy ?? null),
      stoppedAt,
      actorId: input.actor.id,
      tenantAccess: plan.tenantAccess,
      audit: this.auditRows(input.key, input.actor.id, justification, plan),
    }
    try {
      const result = await this.deps.store.commit(commit)
      if (result === 'conflict') return { status: 'conflict' }
      this.deps.onChanged()
      return { status: 'applied', auditFailed: false, gains: plan.gains, loses: plan.loses }
    } catch (error) {
      if (!(error instanceof FeatureFlagAuditWriteError)) throw error
      this.deps.logAuditFailure?.(input.key, error)
      // Bővítés nem történhet audit nélkül. A leállítás és a szűkítés igen: a védelem nem állhat meg az audit miatt.
      const stopping = current.mode !== 'off' && next.mode === 'off'
      const expandsToFutureTenants = current.mode !== 'all' && next.mode === 'all'
      const narrowing = !expandsToFutureTenants && plan.gains.length === 0 && (stopping || plan.loses.length > 0)
      if (!narrowing) return { status: 'audit_failed' }
      const result = await this.deps.store.commit({ ...commit, audit: [] })
      if (result === 'conflict') return { status: 'conflict' }
      this.deps.onChanged()
      return { status: 'applied', auditFailed: true, gains: plan.gains, loses: plan.loses }
    }
  }

  private auditRows(
    key: string,
    actorId: string,
    justification: string,
    plan: {
      definition: FeatureFlagDefinition
      current: FeatureFlagState
      next: FeatureFlagState
      tenantAccess: readonly FeatureFlagTenantAccessChange[]
      tenantsById: ReadonlyMap<string, FeatureFlagTenantRef>
      gains: readonly FeatureFlagTenantRef[]
      loses: readonly FeatureFlagTenantRef[]
    },
  ): AuditAppendInput[] {
    const modeChanged = plan.current.mode !== plan.next.mode
    // A `reason` kulcs az audit-metaadatban tiltott (payload-guard), ezért `justification`.
    // A cégek listája beágyazva van: felső szintű `tenantId` a sort az adott céghez kötné.
    const shared = {
      flagKey: key,
      justification,
      gained: plan.gains.map(({ id, displayName }) => ({ id, displayName })),
      lost: plan.loses.map(({ id, displayName }) => ({ id, displayName })),
    }
    const platformRow = (action: string, metadata: Record<string, unknown>): AuditAppendInput => ({
      actorType: 'human',
      actorId,
      action,
      targetType: FEATURE_FLAG_AUDIT_TARGET,
      targetId: null,
      policyDecision: 'allowed',
      metadata: { ...shared, ...metadata },
      tenantId: null,
    })
    const rows: AuditAppendInput[] = []
    if (modeChanged) {
      rows.push(platformRow('platform.feature_flag.mode_set', { from: plan.current.mode, to: plan.next.mode }))
    }
    if (plan.tenantAccess.length > 0) {
      rows.push(
        platformRow('platform.feature_flag.tenant_access_set', {
          changes: plan.tenantAccess.map((change) => ({
            id: change.tenantId,
            displayName: plan.tenantsById.get(change.tenantId)?.displayName ?? null,
            from: plan.current.tenants.get(change.tenantId) ?? null,
            to: change.access,
          })),
        }),
      )
    }
    // A cég naplójába csak a flag neve és az új állapot kerül: az indoklás, más cégek és a platform
    // munkatársa idegen adat lenne, ezért a sor rendszer-szereplős.
    const tenantRow = (tenant: FeatureFlagTenantRef, active: boolean): AuditAppendInput => ({
      actorType: 'system',
      actorId: null,
      action: modeChanged ? 'platform.feature_flag.mode_set' : 'platform.feature_flag.tenant_access_set',
      targetType: FEATURE_FLAG_AUDIT_TARGET,
      targetId: null,
      policyDecision: 'allowed',
      metadata: { flagKey: key, flagTitle: plan.definition.title, active },
      tenantId: tenant.id,
    })
    rows.push(...plan.gains.map((tenant) => tenantRow(tenant, true)))
    rows.push(...plan.loses.map((tenant) => tenantRow(tenant, false)))
    return rows
  }

  async extendDeadline(input: {
    key: string
    expectedVersion: number
    removeBy: Date
    justification: string
    actor: FeatureFlagActor
  }): Promise<FeatureFlagExtendResult> {
    if (!hasMinimumPlatformRole([...input.actor.platformRoles], 'platform_operator')) return { status: 'forbidden' }
    if (!this.definition(input.key)) return { status: 'unknown_flag' }
    const justification = normalizeJustification(input.justification)
    if (!justification) return { status: 'invalid_justification' }
    const row = await this.deps.store.find(input.key)
    if (!row || row.version !== input.expectedVersion) return { status: 'conflict' }
    // Törlési határidő csak teljes bevezetés után van; addig a kódbeli felülvizsgálati dátum él.
    if (!row.removeBy || input.removeBy.getTime() <= row.removeBy.getTime()) return { status: 'invalid_date' }
    try {
      const result = await this.deps.store.commit({
        key: input.key,
        expectedVersion: input.expectedVersion,
        mode: row.mode,
        fullRolloutAt: row.fullRolloutAt,
        removeBy: input.removeBy,
        stoppedAt: row.stoppedAt,
        actorId: input.actor.id,
        tenantAccess: [],
        audit: [
          {
            actorType: 'human',
            actorId: input.actor.id,
            action: 'platform.feature_flag.deadline_extended',
            targetType: FEATURE_FLAG_AUDIT_TARGET,
            targetId: null,
            policyDecision: 'allowed',
            metadata: {
              flagKey: input.key,
              justification,
              from: row.removeBy.toISOString(),
              to: input.removeBy.toISOString(),
            },
            tenantId: null,
          },
        ],
      })
      if (result === 'conflict') return { status: 'conflict' }
      this.deps.onChanged()
      return { status: 'extended' }
    } catch (error) {
      if (!(error instanceof FeatureFlagAuditWriteError)) throw error
      this.deps.logAuditFailure?.(input.key, error)
      return { status: 'audit_failed' }
    }
  }
}
