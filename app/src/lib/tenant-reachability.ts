/**
 * Multi-tenant agent-elérhetőségi szabály (DB-mentes, determinisztikusan
 * tesztelhető). Egy agent akkor érhető el egy adott tenant-kontextusból, ha
 * MEGOSZTOTT (tenantId === null, platform-szintű agent), vagy pontosan az adott
 * tenanthoz tartozik. Cross-tenant agent SOHA nem oldódik fel — se felderítésre,
 * se delegálásra, se tudásbázis-műveletre. Ez a platform egységes tenant-határa
 * a Tool Broker és a Knowledge Base számára (defense-in-depth, sosem fail-open).
 */
export function isAgentReachableFromTenant(
  agentTenantId: string | null,
  effectiveTenantId: string | null,
): boolean {
  if (agentTenantId === null) return true
  return agentTenantId === effectiveTenantId
}

/** Cél-agent lista tenant-szűrése (l. {@link isAgentReachableFromTenant}). */
export function filterAgentsByTenant<T extends { tenantId: string | null }>(
  agents: T[],
  effectiveTenantId: string | null,
): T[] {
  return agents.filter((agent) => isAgentReachableFromTenant(agent.tenantId, effectiveTenantId))
}
