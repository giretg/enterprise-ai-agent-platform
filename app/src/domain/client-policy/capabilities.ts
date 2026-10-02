/**
 * Hermes Managed Client — képesség-katalógus és presetek (#746 V1-1, spec §5.2–5.3).
 *
 * Minden képesség egy rendezett szintlista, a SZIGORÚTÓL a SZABADIG: az index kisebb = szigorúbb.
 * A feloldás (`resolve-effective-policy.ts`) erre az indexre épül (agent-plafon = min).
 * Az audit-mélységnél a „szigorú" a mélyebb audit, ezért ott a lista fordított.
 */
import { PRIVACY_POLICY_CATEGORIES } from '@/domain/privacy/privacy-category-policy'

/** Tartalomszűrés kategóriánként: blokkol · kitakar/tokenizál · figyelmeztet · ki. */
export const CONTENT_FILTER_LEVELS = ['block', 'tokenize', 'warn', 'off'] as const

const BASE_CAPABILITY_LEVELS = {
  code_execution: ['denied', 'sandbox_only', 'local_with_approval', 'local_free'],
  local_files: ['none', 'read_only', 'project_write', 'free'],
  browser: ['denied', 'company_cloud', 'domain_allowlist', 'free'],
  web_search: ['denied', 'company_egress', 'builtin'],
  mcp_servers: ['company_only', 'plus_approved', 'free'],
  skills: ['approved_only', 'plus_own_audited', 'free'],
  local_memory: ['denied', 'excellence', 'local'],
  autonomous_run: ['denied', 'audited'],
  human_approval: ['always', 'risky', 'none'],
  audit_depth: ['plus_tool_results', 'prompt_and_response', 'metadata'],
} as const

export type BaseCapabilityKey = keyof typeof BASE_CAPABILITY_LEVELS
export type ContentFilterKey = `content_filter.${(typeof PRIVACY_POLICY_CATEGORIES)[number]}`
export type CapabilityKey = BaseCapabilityKey | ContentFilterKey

export const CONTENT_FILTER_KEYS = PRIVACY_POLICY_CATEGORIES.map((c) => `content_filter.${c}` as ContentFilterKey)

export const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  ...(Object.keys(BASE_CAPABILITY_LEVELS) as BaseCapabilityKey[]),
  ...CONTENT_FILTER_KEYS,
]

export function capabilityLevels(key: CapabilityKey): readonly string[] {
  return key.startsWith('content_filter.')
    ? CONTENT_FILTER_LEVELS
    : BASE_CAPABILITY_LEVELS[key as BaseCapabilityKey]
}

/** Szigorúsági index (0 = legszigorúbb); ismeretlen szintre -1. */
export function strictnessOf(key: CapabilityKey, level: string): number {
  return capabilityLevels(key).indexOf(level)
}

export type CapabilityMap = Record<CapabilityKey, string>

/** Audit-mélység alapréteg (§5.4, D6): a legszabadabb szint, ami még megengedett. */
export const AUDIT_DEPTH_FLOOR = 'metadata'

export const PRESET_IDS = ['bound', 'standard', 'free'] as const
export type PresetId = (typeof PRESET_IDS)[number]

export const PRESET_LABELS: Record<PresetId, string> = {
  bound: 'Kötött pálya',
  standard: 'Standard',
  free: 'Szabad (fejlesztő)',
}

function contentFilter(overrides: Partial<Record<(typeof PRIVACY_POLICY_CATEGORIES)[number], string>>, base: string) {
  return Object.fromEntries(PRIVACY_POLICY_CATEGORIES.map((c) => [`content_filter.${c}`, overrides[c] ?? base]))
}

const SECRETS_BLOCK = { pan: 'block', iban: 'block', secret_key: 'block' } as const

export const PRESETS: Record<PresetId, CapabilityMap> = {
  bound: {
    code_execution: 'denied',
    local_files: 'none',
    browser: 'denied',
    web_search: 'denied',
    mcp_servers: 'company_only',
    skills: 'approved_only',
    local_memory: 'excellence',
    autonomous_run: 'denied',
    human_approval: 'risky',
    audit_depth: 'plus_tool_results',
    ...contentFilter({ ...SECRETS_BLOCK, taj: 'block', adoszam: 'block' }, 'tokenize'),
  } as CapabilityMap,
  standard: {
    code_execution: 'sandbox_only',
    local_files: 'read_only',
    browser: 'domain_allowlist',
    web_search: 'company_egress',
    mcp_servers: 'plus_approved',
    skills: 'approved_only',
    local_memory: 'excellence',
    autonomous_run: 'audited',
    human_approval: 'risky',
    audit_depth: 'prompt_and_response',
    ...contentFilter(SECRETS_BLOCK, 'tokenize'),
  } as CapabilityMap,
  free: {
    code_execution: 'local_free',
    local_files: 'project_write',
    browser: 'free',
    web_search: 'builtin',
    mcp_servers: 'plus_approved',
    skills: 'plus_own_audited',
    local_memory: 'local',
    autonomous_run: 'audited',
    human_approval: 'none',
    audit_depth: 'prompt_and_response',
    ...contentFilter({ secret_key: 'block' }, 'off'),
  } as CapabilityMap,
}

/** Tenant-sor nélkül (fail-safe, D4): Kötött pálya. */
export const DEFAULT_TENANT_PRESET: PresetId = 'bound'
