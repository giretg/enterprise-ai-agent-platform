/**
 * Skill-katalógus tenant-határ (spec §D8). Kétrétegű, fail-closed katalógus:
 *   - PLATFORM-GLOBÁLIS skill (tenantId === null): minden tenant számára OLVASHATÓ,
 *     de kizárólag read-only (nem szerkeszthető/rollbackelhető tenant-adminként).
 *   - TENANT-LOKÁLIS skill (tenantId === valós): SOSEM látható más tenantnak.
 *
 * Ugyanaz a szemantika, mint az agent-elérhetőség ({@link isAgentReachableFromTenant}),
 * de a skillnél a WRITE külön, szigorúbb szabály: global skillt tenant-admin nem ír.
 * Sosem fail-open: ismeretlen/hiányzó scope → megtagadás a hívó oldalán.
 */

/** Olvasható-e a skill az adott actor-tenant kontextusból? (global VAGY saját tenant) */
export function isSkillReadableFromTenant(
  skillTenantId: string | null,
  actorTenantId: string | null,
): boolean {
  if (skillTenantId === null) return true // global: mindenkinek read-only
  return skillTenantId === actorTenantId
}

/**
 * Írható-e (szerkeszthető/rollbackelhető/assignlható-forrás) a skill az adott
 * actor-tenant kontextusból? Global skillt CSAK platform-admin ír (a hívónak
 * kell platform-jogot igazolnia), tenant-admin sosem — ezért tenant-actorra a
 * global skill NEM írható. Tenant-lokális skill csak a saját tenantnak írható.
 */
export function isSkillWritableFromTenant(
  skillTenantId: string | null,
  actorTenantId: string | null,
  actorIsPlatformAdmin: boolean,
): boolean {
  if (skillTenantId === null) return actorIsPlatformAdmin
  return skillTenantId === actorTenantId
}

/** Katalógus-lista tenant-szűrése olvasáshoz (global + saját tenant). */
export function filterSkillsByReadableTenant<T extends { tenantId: string | null }>(
  skills: T[],
  actorTenantId: string | null,
): T[] {
  return skills.filter((s) => isSkillReadableFromTenant(s.tenantId, actorTenantId))
}
