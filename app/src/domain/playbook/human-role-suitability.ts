/**
 * Emberi (`human_role`) szereplő alkalmassága egy Folyamat-szerephez
 * (Folyamat-feature-spec §4.3, §4.8) — a #153 agent-oldali cross-tenant
 * alkalmassági-kapu EMBERI párja.
 *
 * Egy user akkor köthető egy `human_role`-hoz, ha:
 *  - AKTÍV (status === 'active') és van platform-szerepe (role),
 *  - TAGJA a Folyamat tenantjának. A tagságot a MEMBERSHIP-modell dönti el,
 *    NEM a `user.tenantId` oszlop — az csak a user *alapértelmezett* tenantját
 *    tükrözi (l. `tool-broker-service.ts` kommentjét), ezért egy más alap-tenantú,
 *    de a Folyamat tenantjához aktív tagsággal kötött user LEGITIM. A null-tenantú
 *    (platform) Folyamatnál nincs tenant-tagság fogalom → csak a status/role kapu él,
 *    ugyanúgy, ahogy az agent-oldali `isAgentSuitable` a null scope-ot önmagával egyezteti.
 *
 * Tiszta függvény (DB nélkül determinisztikusan tesztelhető); a membership-sort a
 * hívó (ProcessService / ProcessDefinitionService) tölti be és adja át.
 */

export type SuitabilityHumanUser = {
  status: string
  role: string | null
}

/** A user tenant-tagsága a Folyamat tenantjában — `null`, ha nincs ilyen tagsága. */
export type HumanMembershipView = { status: string } | null

export type HumanSuitabilityResult = { ok: true } | { ok: false; reason: string }

/** Az alkalmasnak számító user-státusz. */
const SUITABLE_USER_STATUS = 'active'
/** Az alkalmasnak számító tenant-tagsági státusz. */
const SUITABLE_MEMBERSHIP_STATUS = 'active'

export function isHumanUserSuitable(
  user: SuitabilityHumanUser,
  membership: HumanMembershipView,
  defTenantId: string | null,
): HumanSuitabilityResult {
  if (user.status !== SUITABLE_USER_STATUS || !user.role) {
    return { ok: false, reason: 'user nem aktív vagy nincs platform szerepe.' }
  }

  // A tenant-tagságot CSAK valós (nem-null) Folyamat-tenantnál mérjük — a platform
  // (null) scope-nál nincs membership-fogalom, így ott a status/role kapu a teljes határ.
  if (defTenantId !== null) {
    if (!membership) {
      return { ok: false, reason: 'user nem tagja a Folyamat tenantjának.' }
    }
    if (membership.status !== SUITABLE_MEMBERSHIP_STATUS) {
      return {
        ok: false,
        reason: `user tenant-tagsága nem aktív (státusz: ${membership.status}).`,
      }
    }
  }

  return { ok: true }
}
