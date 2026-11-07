/**
 * #1126: a flag-döntés tiszta logikája. Ugyanez számol élesben, a mentés előtti összegzésben és a
 * felület élő előnézetében, ezért az összegzés nem térhet el a tényleges működéstől.
 */
export type FeatureFlagModeValue = 'off' | 'selected' | 'all'
export type FeatureFlagTenantAccessValue = 'included' | 'excluded'

export type FeatureFlagState = {
  mode: FeatureFlagModeValue
  tenants: ReadonlyMap<string, FeatureFlagTenantAccessValue>
}

export const FEATURE_FLAG_STATE_OFF: FeatureFlagState = { mode: 'off', tenants: new Map() }

export type FeatureFlagDecisionReason =
  | 'off'
  | 'selected_included'
  | 'selected_other'
  | 'all'
  | 'all_excluded'

export type FeatureFlagDecision = { active: boolean; reason: FeatureFlagDecisionReason }

export function decideFeatureFlag(state: FeatureFlagState, tenantId: string): FeatureFlagDecision {
  if (state.mode === 'off') return { active: false, reason: 'off' }
  const access = state.tenants.get(tenantId)
  if (state.mode === 'selected') {
    return access === 'included'
      ? { active: true, reason: 'selected_included' }
      : { active: false, reason: 'selected_other' }
  }
  return access === 'excluded' ? { active: false, reason: 'all_excluded' } : { active: true, reason: 'all' }
}

/** Egy cég jelölésének módosítása; `null` törli a jelölést. */
export type FeatureFlagTenantAccessChange = {
  tenantId: string
  access: FeatureFlagTenantAccessValue | null
}

export function applyFeatureFlagChange(
  current: FeatureFlagState,
  change: { mode?: FeatureFlagModeValue; tenantAccess?: readonly FeatureFlagTenantAccessChange[] },
): FeatureFlagState {
  const tenants = new Map(current.tenants)
  for (const { tenantId, access } of change.tenantAccess ?? []) {
    if (access === null) tenants.delete(tenantId)
    else tenants.set(tenantId, access)
  }
  return { mode: change.mode ?? current.mode, tenants }
}

/** Mely cégeknél változik ténylegesen a működés a két állapot között. */
export function diffFeatureFlagEffect(
  current: FeatureFlagState,
  next: FeatureFlagState,
  tenantIds: readonly string[],
): { gains: string[]; loses: string[] } {
  const gains: string[] = []
  const loses: string[] = []
  for (const tenantId of tenantIds) {
    const before = decideFeatureFlag(current, tenantId).active
    const after = decideFeatureFlag(next, tenantId).active
    if (!before && after) gains.push(tenantId)
    if (before && !after) loses.push(tenantId)
  }
  return { gains, loses }
}
