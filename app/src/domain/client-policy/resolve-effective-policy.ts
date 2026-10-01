/**
 * Hermes Managed Client — effektív policy feloldása (#746 V1-1, spec §5.1, D3, D6, D10).
 *
 * TISZTA függvény: nincs DB-hívás, nincs óra. A betöltést a `policy-service.ts` végzi.
 *
 *   tenant alap (preset + felülírás)
 *     → user (preset + felülírás; explicit kivétellel tágíthat a tenant-tiltáson, D3)
 *       ∩ agent-plafon (képességenként min; semmi nem lépi túl)
 *   tool-szabályok: azonos mintán a tiltás nyer; keresésnél az összes találat közül a legszigorúbb.
 *
 * Hibás sor-tartalom (ismert kulcs, ismeretlen szint / tool-akció) → a LEGSZIGORÚBB érték (fail-closed);
 * ismeretlen képesség-kulcs figyelmen kívül marad. Az alapréteg (§5.4) nem paraméterezhető: a `floor`
 * konstans, az audit-mélység pedig soha nem mehet `metadata` alá.
 */
import { createHash } from 'node:crypto'
import {
  AUDIT_DEPTH_FLOOR,
  CAPABILITY_KEYS,
  DEFAULT_TENANT_PRESET,
  PRESETS,
  capabilityLevels,
  strictnessOf,
  type CapabilityKey,
  type CapabilityMap,
  type PresetId,
} from '@/domain/client-policy/capabilities'

export const TOOL_ACTIONS = ['allow', 'approve', 'deny'] as const // szigorúság szerint növekvő
export type ToolAction = (typeof TOOL_ACTIONS)[number]

export type PolicyRow = {
  scope: 'tenant' | 'user' | 'agent'
  scopeId: string
  preset: string | null
  /** Nyers JSON a DB-ből: `{ "<képesség>": "<szint>", "models"?: string[] }` */
  capabilities: unknown
  /** Nyers JSON a DB-ből: `{ "<toolnév vagy minta>": "allow" | "approve" | "deny" }` */
  toolOverrides: unknown
  version: number
}

export type PolicySource =
  | 'tenant_default'
  | 'tenant_preset'
  | 'tenant_override'
  | 'user_preset'
  | 'user_override'
  | 'agent_ceiling'

export type ToolRule = { pattern: string; action: ToolAction; source: 'tenant' | 'user' | 'agent' }

export type EffectivePolicy = {
  capabilities: CapabilityMap
  /** Engedett modell-lista; null = nincs szűkítés (a tenant `model.policy` továbbra is érvényes). */
  models: string[] | null
  toolRules: ToolRule[]
  floor: { modelGatewayRequired: true; guardRequired: true; auditMinimum: typeof AUDIT_DEPTH_FLOOR; enterpriseToolsServerAuthorized: true }
  policyVersion: string
  /** Döntés-indoklás: melyik szint miatt lett az érték (a hétköznapi nyelvű elutasításhoz). */
  reasons: Record<CapabilityKey | 'models', { source: PolicySource; widenedBeyondTenant: boolean }>
}

type Overrides = { levels: Partial<CapabilityMap>; models: string[] | null }

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function parseOverrides(raw: unknown): Overrides {
  const levels: Partial<CapabilityMap> = {}
  let models: string[] | null = null
  for (const [key, value] of Object.entries(asRecord(raw))) {
    if (key === 'models') {
      if (Array.isArray(value)) models = value.filter((m): m is string => typeof m === 'string' && m !== '')
    } else if ((CAPABILITY_KEYS as readonly string[]).includes(key)) {
      const k = key as CapabilityKey
      levels[k] = typeof value === 'string' && strictnessOf(k, value) >= 0 ? value : capabilityLevels(k)[0]
    }
  }
  return { levels, models }
}

function presetOf(row: PolicyRow | null): CapabilityMap | null {
  return row?.preset && row.preset in PRESETS ? PRESETS[row.preset as PresetId] : null
}

function parseToolOverrides(raw: unknown): Map<string, ToolAction> {
  const out = new Map<string, ToolAction>()
  for (const [pattern, action] of Object.entries(asRecord(raw))) {
    if (pattern) out.set(pattern, (TOOL_ACTIONS as readonly unknown[]).includes(action) ? (action as ToolAction) : 'deny')
  }
  return out
}

const strictestAction = (a: ToolAction, b: ToolAction): ToolAction =>
  TOOL_ACTIONS.indexOf(a) >= TOOL_ACTIONS.indexOf(b) ? a : b

function toolPatternRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
}

/**
 * Egy tool döntése: az összes illeszkedő szabály közül a legszigorúbb; null = nincs szabály
 * (ilyenkor a képesség-szint dönt).
 * ponytail: nincs specifikusság-sorrend — a user `allow mcp__crm__*` a tenant `deny mcp__crm__*`-t
 * azonos mintán írja felül, de egy szűkebb minta nem tágít egy szélesebb tiltáson. Specifikusság, ha kell.
 */
export function decideToolRule(rules: readonly ToolRule[], toolName: string): ToolAction | null {
  let result: ToolAction | null = null
  for (const rule of rules) {
    if (toolPatternRegExp(rule.pattern).test(toolName)) result = result ? strictestAction(result, rule.action) : rule.action
  }
  return result
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Determinisztikus hash a bemeneti sorokból: bármelyik sor változása új verziót ad. */
export function computePolicyVersion(rows: Array<PolicyRow | null>): string {
  const canonical = rows.map((r) =>
    r && { scope: r.scope, scopeId: r.scopeId, preset: r.preset, capabilities: r.capabilities, toolOverrides: r.toolOverrides, version: r.version },
  )
  return createHash('sha256').update(stableStringify(canonical)).digest('hex').slice(0, 16)
}

export function resolveEffectivePolicy(input: {
  tenant: PolicyRow | null
  user: PolicyRow | null
  agent: PolicyRow | null
}): EffectivePolicy {
  const { tenant, user, agent } = input
  const tenantOv = parseOverrides(tenant?.capabilities)
  const userOv = parseOverrides(user?.capabilities)
  const agentOv = parseOverrides(agent?.capabilities)

  const capabilities = {} as CapabilityMap
  const reasons = {} as EffectivePolicy['reasons']
  const tenantPreset = presetOf(tenant)
  const userPreset = presetOf(user)
  const agentPreset = presetOf(agent)

  for (const key of CAPABILITY_KEYS) {
    // 1. tenant alap
    const tenantBase = (tenantPreset ?? PRESETS[DEFAULT_TENANT_PRESET])[key]
    const tenantValue = tenantOv.levels[key] ?? tenantBase
    let value = tenantValue
    let source: PolicySource = tenantOv.levels[key] ? 'tenant_override' : tenantPreset ? 'tenant_preset' : 'tenant_default'

    // 2. user: saját preset lecseréli az alapot, a felülírás (explicit kivétel) arra kerül
    if (userPreset) {
      value = userPreset[key]
      source = 'user_preset'
    }
    if (userOv.levels[key]) {
      value = userOv.levels[key]!
      source = 'user_override'
    }
    const widenedBeyondTenant = strictnessOf(key, value) > strictnessOf(key, tenantValue)

    // 3. agent-plafon: képességenként min (a nem megadott plafon = nincs plafon)
    const ceiling = agentOv.levels[key] ?? agentPreset?.[key]
    if (ceiling !== undefined && strictnessOf(key, ceiling) < strictnessOf(key, value)) {
      value = ceiling
      source = 'agent_ceiling'
    }

    // 4. alapréteg: az audit-mélység nem mehet metaadat alá (a szintlista legszabadabb eleme)
    if (key === 'audit_depth' && strictnessOf(key, value) < 0) value = AUDIT_DEPTH_FLOOR

    capabilities[key] = value
    reasons[key] = { source, widenedBeyondTenant: widenedBeyondTenant && source !== 'agent_ceiling' }
  }

  // Modell-lista: tenant → user (felülír) ∩ agent
  const tenantModels = tenantOv.models
  let models = userOv.models ?? tenantModels
  let modelsSource: PolicySource = userOv.models ? 'user_override' : tenantModels ? 'tenant_override' : 'tenant_default'
  const modelsWidened = !!tenantModels && !!userOv.models && userOv.models.some((m) => !tenantModels.includes(m))
  if (agentOv.models) {
    const narrowed = models ? models.filter((m) => agentOv.models!.includes(m)) : agentOv.models
    if (!models || narrowed.length < models.length) modelsSource = 'agent_ceiling'
    models = narrowed
  }
  reasons.models = { source: modelsSource, widenedBeyondTenant: modelsWidened && modelsSource !== 'agent_ceiling' }

  // Tool-szabályok: tenant < user (azonos mintán a user felülír, D3); agent azonos mintán: legszigorúbb
  const merged = new Map<string, ToolRule>()
  const apply = (raw: unknown, source: ToolRule['source'], strictest: boolean) => {
    for (const [pattern, action] of parseToolOverrides(raw)) {
      const prev = merged.get(pattern)
      merged.set(pattern, { pattern, action: strictest && prev ? strictestAction(prev.action, action) : action, source })
    }
  }
  apply(tenant?.toolOverrides, 'tenant', false)
  apply(user?.toolOverrides, 'user', false)
  apply(agent?.toolOverrides, 'agent', true)

  return {
    capabilities,
    models,
    toolRules: [...merged.values()].sort((a, b) => a.pattern.localeCompare(b.pattern)),
    floor: { modelGatewayRequired: true, guardRequired: true, auditMinimum: AUDIT_DEPTH_FLOOR, enterpriseToolsServerAuthorized: true },
    policyVersion: computePolicyVersion([tenant, user, agent]),
    reasons,
  }
}
