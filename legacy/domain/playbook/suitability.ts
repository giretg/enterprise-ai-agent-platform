/**
 * Agent-alkalmasság egy Playbook-szerephez (Folyamat-feature-spec §4.8, WP-6).
 *
 * Egy agent akkor köthető egy `agent_role`-hoz, ha:
 *  - AKTÍV (nem retired/suspended/draft),
 *  - AZONOS tenant a Folyamattal (a null-tenant "platform" scope önmagával egyezik),
 *  - képességei (engedélyezett tool-nevek) LEFEDIK a szerep requiredCapabilities-ét.
 *
 * Tiszta függvény, hogy determinisztikusan tesztelhető legyen (DB nélkül); a
 * ProcessDefinitionService a DB-ből betöltött agent+capability adatokkal hívja.
 */

export type SuitabilityAgent = {
  status: string
  tenantId: string | null
  /** Az agenthez tartozó capability-sorok (toolName + allowed). */
  capabilities: { toolName: string; allowed: boolean }[]
}

export type SuitabilityRole = {
  requiredCapabilities?: string[]
}

export type SuitabilityResult =
  | { ok: true }
  | { ok: false; reason: string; missing: string[] }

/** Az alkalmasnak számító agent-státusz (Agent Registry életciklus). */
const SUITABLE_STATUS = 'active'

export function isAgentSuitable(
  agent: SuitabilityAgent,
  role: SuitabilityRole,
  defTenantId: string | null,
): SuitabilityResult {
  if (agent.status !== SUITABLE_STATUS) {
    return {
      ok: false,
      reason: `Az agent nem aktív (státusz: ${agent.status}).`,
      missing: [],
    }
  }

  if ((agent.tenantId ?? null) !== (defTenantId ?? null)) {
    return {
      ok: false,
      reason: 'Az agent másik tenanthez tartozik, mint a Folyamat.',
      missing: [],
    }
  }

  const allowed = new Set(
    agent.capabilities.filter((c) => c.allowed).map((c) => c.toolName),
  )
  const missing = (role.requiredCapabilities ?? []).filter((cap) => !allowed.has(cap))
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `Az agent nem fedi a szerep összes capability-jét: ${missing.join(', ')}.`,
      missing,
    }
  }

  return { ok: true }
}
