import { cache } from 'react'
import { repositories } from '@/repositories/postgres'
import {
  emptyNavVisibilityPolicy,
  readNavVisibilityPolicy,
  type NavVisibilityPolicy,
} from '@/lib/nav-visibility'

/**
 * A tenant menü-láthatósági policy-je a szerver oldalról.
 *
 * A `cache()` a React request-scope-ja: a Control Plane layout MINDEN oldalnál
 * meghívja, de kérésenként egyetlen tenant-olvasás lesz belőle.
 *
 * Fail-open, szándékosan: ha a tenant nem oldható fel, ÜRES policy-t adunk, tehát a
 * menü a teljes (szerep szerinti) tartalmat mutatja. Ez a policy kurálás, nem
 * jogosultság — egy DB-hiba nem zárhatja ki a felhasználót a saját menüjéből, és
 * nem is nyit meg semmit, amit a `requireTenantRole` guardok ne fognának meg.
 */
export const loadTenantNavVisibility = cache(
  async (tenantId: string | null | undefined): Promise<NavVisibilityPolicy> => {
    if (!tenantId) return emptyNavVisibilityPolicy()
    try {
      const tenant = await repositories.tenants.findById(tenantId)
      return readNavVisibilityPolicy(tenant?.settings)
    } catch {
      return emptyNavVisibilityPolicy()
    }
  },
)
