import type { Prisma, UserRole } from '@prisma/client'
import { settingsRecord } from '@/lib/tenant-settings'

/**
 * Menü-láthatósági policy — szerepkörönként elrejthető fejléc-menüpontok.
 *
 * ÜZLETI JELENTÉS: a tenant admin itt kurálja, hogy egy adott szerepkör MIT LÁT a
 * fejléc-navigációban. Ez NEM jogosultság: a menüpont elrejtése nem nyit és nem zár
 * kaput — az oldalak `requireTenantRole` guardjai változatlanul az egyetlen
 * authorizációs határ. A policy csak a zajt veszi ki a menüből ott, ahol egy
 * szerepkörnek az adott funkció nem a napi munkája.
 *
 * TÁROLÁS: `tenants.settings.navVisibility` — szerepkör → elrejtett nav-kulcsok.
 * Alapérték az ÜRES policy, tehát a meglévő tenantok menüje VÁLTOZATLAN.
 */

export const NAV_VISIBILITY_SETTING = 'navVisibility'

/** A négy tenant-szerepkör, a rangsor sorrendjében (viewer → admin). */
export const NAV_VISIBILITY_ROLES: readonly UserRole[] = ['viewer', 'operator', 'approver', 'admin']

export const NAV_VISIBILITY_ROLE_LABELS: Record<UserRole, string> = {
  viewer: 'Megfigyelő',
  operator: 'Operátor',
  approver: 'Jóváhagyó',
  admin: 'Adminisztrátor',
}

/** Szerepkör → az adott szerepkör elől ELREJTETT nav-kulcsok. */
export type NavVisibilityPolicy = Record<UserRole, string[]>

/**
 * Kizárási invariáns (az IAM `LAST_ADMIN_LOCK` mintájára): az adminisztrátor elől
 * nem rejthető el sem az Adminisztráció csoport, sem maga a menü-hozzáférés
 * szerkesztő. Enélkül egyetlen mentéssel ki lehetne zárni a tenantot ebből a
 * beállításból — a policy visszavonhatatlanná válna.
 */
export const NAV_KEYS_LOCKED_FOR_ADMIN: readonly string[] = ['admin', 'admin.menu-access']

export function emptyNavVisibilityPolicy(): NavVisibilityPolicy {
  return { viewer: [], operator: [], approver: [], admin: [] }
}

function toKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const key = item.trim()
    if (key) seen.add(key)
  }
  return [...seen].sort()
}

/**
 * Normalizálás + a kizárási invariáns kikényszerítése. Minden írási és olvasási út
 * ezen megy át, így egy kézzel szerkesztett (vagy régi) settings-JSON sem tud
 * lockoutot okozó policy-t becsempészni.
 */
export function sanitizeNavVisibilityPolicy(raw: unknown): NavVisibilityPolicy {
  const record = settingsRecord(raw)
  const policy = emptyNavVisibilityPolicy()
  for (const role of NAV_VISIBILITY_ROLES) {
    const keys = toKeyList(record[role])
    policy[role] =
      role === 'admin' ? keys.filter((key) => !NAV_KEYS_LOCKED_FOR_ADMIN.includes(key)) : keys
  }
  return policy
}

export function readNavVisibilityPolicy(settings: unknown): NavVisibilityPolicy {
  return sanitizeNavVisibilityPolicy(settingsRecord(settings)[NAV_VISIBILITY_SETTING])
}

export function withNavVisibilityPolicy(
  settings: unknown,
  policy: NavVisibilityPolicy,
): Prisma.InputJsonValue {
  return {
    ...settingsRecord(settings),
    [NAV_VISIBILITY_SETTING]: sanitizeNavVisibilityPolicy(policy),
  }
}

/**
 * Szerep nélküli hívó (pl. tisztán platform-szerepű superadmin) elől SOHA nem rejtünk:
 * a policy tenant-szerepkörökre szól, és a hiányzó szerep nem „nulladik szerepkör".
 */
const NAV_KEY_LEGACY_HIDDEN: Record<string, readonly string[]> = {
  'admin.agent-access': ['admin.agent-access', 'staff.access'],
  // Fiókom / Fiókok / Adminisztráció.account → Kapcsolt fiókok (főmenü).
  account: ['account', 'admin.account', 'admin.connectors'],
}

export function isNavKeyHiddenFor(
  policy: NavVisibilityPolicy,
  role: UserRole | null | undefined,
  key: string,
): boolean {
  if (!role) return false
  const keys = NAV_KEY_LEGACY_HIDDEN[key] ?? [key]
  return keys.some((k) => policy[role].includes(k))
}

/** Igaz, ha a policy egyetlen szerepkörnél sem rejt el semmit. */
export function isNavVisibilityPolicyEmpty(policy: NavVisibilityPolicy): boolean {
  return NAV_VISIBILITY_ROLES.every((role) => policy[role].length === 0)
}

/** A kulcs zárolt-e az adott szerepkörnél (a UI ezért tiltja le a jelölőnégyzetet). */
export function isNavKeyLockedFor(role: UserRole, key: string): boolean {
  return role === 'admin' && NAV_KEYS_LOCKED_FOR_ADMIN.includes(key)
}
