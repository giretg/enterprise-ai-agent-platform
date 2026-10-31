/**
 * „Harness-pótló” MCP-eszközök (#1020): egy AI-kliens saját képességének céges változata
 * (webes keresés, később oldalolvasás, dokumentum-előállítás).
 *
 * Két külön döntés:
 * - meghívhatóság (biztonság): csak a policy — a user effektív policyja (tenant → user ∩ agent-plafon),
 *   és a tool-szabály (a tenant `deny` = kill-switch). A kliensfajta NEM számít.
 * - láthatóság (rend): meghívható ÉS a kliensnek nincs saját megfelelője. A kliensfajta hamisítása így
 *   legfeljebb annyit ér el, hogy valaki olyan eszközt lát, amit a policy amúgy is enged neki.
 */
import type { Prisma } from '@prisma/client'
import type { BaseCapabilityKey } from '@/domain/client-policy/capabilities'
import { decideToolRule, type ToolRule } from '@/domain/client-policy/resolve-effective-policy'
import type { McpClientName } from '@/lib/mcp-session'
import { settingsRecord } from '@/lib/tenant-settings'

export type HarnessSubstitute = {
  tool: string
  capability: BaseCapabilityKey
  /** Policy-szintek, amelyeken az eszköz meghívható (céges úton). */
  callableAt: readonly string[]
  /** Policy-szintek, amelyeken a (menedzselt) kliens a saját eszközét használja: ilyenkor nem listázzuk. */
  clientBuiltinAt: readonly string[]
}

export const HARNESS_SUBSTITUTES: readonly HarnessSubstitute[] = [
  { tool: 'web_search', capability: 'web_search', callableAt: ['company_egress', 'builtin'], clientBuiltinAt: ['builtin'] },
]

export function harnessSubstituteFor(tool: string): HarnessSubstitute | undefined {
  return HARNESS_SUBSTITUTES.find((row) => row.tool === tool)
}

/** `platform_chat`: nincs saját eszköze · `hermes`: menedzselt, a policy szerint · `external`: Claude, Codex, Cursor… */
export type HarnessClientKind = 'platform_chat' | 'hermes' | 'external'

export function harnessClientKind(client: McpClientName): HarnessClientKind {
  return client === 'platform_chat' || client === 'hermes' ? client : 'external'
}

/** Az `EffectivePolicy` vagy a policy-snapshot (`getPolicySnapshot`) elég ehhez. */
export type SubstitutePolicy = { capabilities: Readonly<Record<string, string>>; toolRules: readonly ToolRule[]; tenantDeniedTools?: readonly string[] }

export type SubstituteCallability =
  | { callable: true; level: string }
  | { callable: false; level: string; reason: 'policy_level' | 'tool_rule' }

export function substituteCallability(sub: HarnessSubstitute, policy: SubstitutePolicy): SubstituteCallability {
  const level = policy.capabilities[sub.capability] ?? ''
  const tenantDenials: ToolRule[] = (policy.tenantDeniedTools ?? []).map((pattern) => ({ pattern, action: 'deny', source: 'tenant' }))
  const rule = decideToolRule(policy.toolRules, sub.tool)
  // Szerveroldali jóváhagyás nélkül az approve nem adhat kimenő hozzáférést.
  if (decideToolRule(tenantDenials, sub.tool) === 'deny' || rule === 'deny' || rule === 'approve') return { callable: false, level, reason: 'tool_rule' }
  if (!sub.callableAt.includes(level)) return { callable: false, level, reason: 'policy_level' }
  return { callable: true, level }
}

export function isSubstituteVisible(
  sub: HarnessSubstitute,
  input: { policy: SubstitutePolicy; client: HarnessClientKind; externalClientsEnabled: boolean },
): boolean {
  const decision = substituteCallability(sub, input.policy)
  if (!decision.callable) return false
  if (input.client === 'platform_chat') return true
  if (input.client === 'hermes') return !sub.clientBuiltinAt.includes(decision.level)
  return input.externalClientsEnabled
}

/** Tenant-kapcsoló: „Céges webes eszközök külső AI-klienseknek is” (`Tenant.settings.harnessSubstitutes`). */
export const HARNESS_SUBSTITUTE_SETTINGS_KEY = 'harnessSubstitutes'

export function readExternalClientsEnabled(settings: unknown): boolean {
  return settingsRecord(settingsRecord(settings)[HARNESS_SUBSTITUTE_SETTINGS_KEY]).externalClients === true
}

export function withExternalClientsEnabled(settings: unknown, externalClients: boolean): Prisma.InputJsonValue {
  const record = settingsRecord(settings)
  return { ...record, [HARNESS_SUBSTITUTE_SETTINGS_KEY]: { ...settingsRecord(record[HARNESS_SUBSTITUTE_SETTINGS_KEY]), externalClients } }
}
